#!/usr/bin/env node
// clevr-gate.mjs — Claude Code PreToolUse hook.
//
// Before ANY Claude Code tool runs (Bash, Edit, Write, Read, WebFetch, an MCP
// tool, ...), this gate POSTs the proposed action to Clevr's policy engine
// (POST /v1/evaluate) and maps the verdict onto Claude Code's permission model:
//
//   allow    -> proceed  (additive: Claude Code's own prompts still apply,
//                          unless CLEVR_AUTO_APPROVE=1 makes Clevr the sole gate)
//   escalate -> ask      (Claude Code shows the user the approval dialog)
//   block    -> deny     (the tool never runs; the model sees the reason)
//
// It also forwards the recent conversation from the transcript and the Claude
// Code session id, so the engine scans the PROMPT (PII / secrets / injection)
// and situates the gated tool call inside its session, with a signed receipt.
//
// A companion hook (clevr-prompt.mjs, UserPromptSubmit) scans every user prompt,
// including turns that never call a tool. This gate covers the ACTION moment.
//
// No code change to the agent. Configured entirely via environment — see
// clevr-common.mjs for the full CLEVR_* list.

import { readFileSync } from 'node:fs';
import { trunc, loadConfig, readConversation, postEvaluate } from './clevr-common.mjs';

function out (decision, reason) {
  if (decision) {
    process.stdout.write(JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: decision,          // 'allow' | 'deny' | 'ask'
        permissionDecisionReason: reason || '',
      },
    }));
  }
  process.exit(0);                              // structured decisions use exit 0
}

// Map a Claude Code tool + input onto the engine's action shape. The `action`
// text carries the command / path / args so the deterministic content floor can
// scan it (a shell command that exfiltrates a secret blocks on the text alone).
function classify (tool, input = {}) {
  const t = String(tool);
  if (t === 'Bash')
    return { action_type: 'exec', action: trunc(input.command || 'bash'), target: null };
  if (/^(Write|Edit|MultiEdit|NotebookEdit)$/.test(t)) {
    const path = input.file_path || input.notebook_path || '';
    return { action_type: 'write', action: `${t} ${path}`.trim(), target: path || null };
  }
  if (/^(Read|Glob|Grep)$/.test(t)) {
    const path = input.file_path || input.path || input.pattern || '';
    return { action_type: 'read', action: `${t} ${path}`.trim(), target: input.file_path || input.path || null };
  }
  if (t === 'WebFetch')
    return { action_type: 'network', action: `fetch ${input.url || ''}`.trim(), target: input.url || null };
  if (t === 'WebSearch')
    return { action_type: 'read', action: `search ${trunc(input.query || '', 120)}`.trim(), target: null };
  // mcp__server__tool and everything else: a generic gated tool call.
  return { action_type: 'tool_call', action: `${t}(${trunc(JSON.stringify(input))})`, target: null };
}

async function main () {
  let hook = {};
  try { hook = JSON.parse(readFileSync(0, 'utf8')); } catch { out(null); }

  const cfg = loadConfig();
  if (!cfg.apiKey) {
    process.stderr.write('[clevr] CLEVR_API_KEY not set; gate inactive (allowing). Set it to enforce.\n');
    out(null);
  }

  const { tool_name = 'unknown', tool_input = {}, session_id, transcript_path, cwd, agent_id, agent_type } = hook;
  const { action_type, action, target } = classify(tool_name, tool_input);

  // Delegation lineage (ASSERTED, not IdP-verified). Claude Code populates
  // agent_id + agent_type when a tool runs INSIDE a spawned sub-agent. We model
  // it as the sub-agent acting on behalf of the main agent, so the signed audit
  // lineage branches per sub-agent (main -> sub-agent -> tool call). agent_id is
  // the harness's INTERNAL handle, NOT an identity issued by an IdP, so the hop
  // is tagged identity:'asserted' and must never be presented as verified.
  const actorChain = [{ type: 'agent', id: cfg.agent, display: cfg.agent }];
  if (agent_id) {
    const subName = agent_type || 'subagent';
    actorChain.push({ type: 'agent', id: subName, display: subName, on_behalf_of: cfg.agent, harness_agent_id: agent_id, identity: 'asserted' });
  }

  const body = {
    agent: cfg.agent, tool: tool_name, action_type, action, target,
    environment: cfg.env,
    session_id: session_id || null,
    // Who acted, on whose behalf — the delegation chain the lineage branches on.
    actor_chain: actorChain,
    // Surface the tool's arguments as target_attr so deterministic argument
    // rules (target.<name>, e.g. target.amount > 10000) can gate on them —
    // mirrors the SDK adapters.
    target_attr: (tool_input && typeof tool_input === 'object' && !Array.isArray(tool_input)) ? tool_input : null,
    metadata: { input: tool_input, cwd, source: 'claude-code', agent_id: agent_id || null, agent_type: agent_type || null },
  };
  if (cfg.forwardCtx && transcript_path) {
    const convo = readConversation(transcript_path, cfg.contextTurns);
    if (convo.length) {
      body.conversation = convo;
      const firstUser = convo.find((m) => m.role === 'user');
      if (firstUser) body.session_goal = trunc(firstUser.content, 300);
    }
  }

  const res = await postEvaluate(cfg, body);
  if (res.inactive) out(null);
  if (res.failclosed) out('deny', res.reason);
  if (res.failopen) {
    process.stderr.write(`[clevr] engine error (${res.reason}); allowing (fail-open).\n`);
    out(null);
  }
  const verdict = res.verdict;

  const effect = verdict.effect;
  const reason = verdict.reason || '';
  const tag = verdict.decision_id ? ` [${verdict.decision_id}]` : '';

  // Shadow mode: the decision is already sealed server-side; surface what WOULD
  // have happened to the model, but let the action proceed. Never blocks, so a
  // first install observes without bricking Claude Code. Flip to enforce when
  // the agent is profiled and you trust the policies.
  if (cfg.mode === 'shadow') {
    if (effect === 'block' || effect === 'escalate' || effect === 'step_up') {
      process.stdout.write(JSON.stringify({ hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        additionalContext: `Clevr (shadow) would have ${effect === 'block' ? 'BLOCKED' : 'ESCALATED'} this action: ${reason}${tag}`,
      } }));
    }
    process.exit(0);
  }

  if (effect === 'block') out('deny', `Clevr blocked this action: ${reason}${tag}`);
  if (effect === 'escalate' || effect === 'step_up') {
    // A step-up HOLDS the action by default: the hook is synchronous and cannot
    // wait for an async console approval, so an un-approved step-up must not run
    // (consistent with the prompt hook). CLEVR_ESCALATE=ask opts into a LOCAL
    // operator prompt instead. Approve-in-console-then-resume is the gateway path.
    if (cfg.escalate === 'ask') out('ask', `Clevr requires human approval: ${reason}${tag}`);
    out('deny', `Clevr held this action (step-up not approved): ${reason}${tag}`);
  }
  if (cfg.autoApprove) out('allow', `Clevr allowed this action${tag}`);
  out(null);  // additive: let Claude Code's normal permission flow proceed
}

main().catch((e) => {
  process.stderr.write(`[clevr] gate error: ${e.message}; allowing.\n`);
  out(null);
});
