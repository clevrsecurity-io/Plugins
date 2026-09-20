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
import { trunc, loadConfig, readConversation, postEvaluate, confirmEnforcement, machineContext, evidenceRefs, actsFor } from './clevr-common.mjs';

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
    // Machine context for the brain's environment classifier (branch, kube
    // context, cloud profile). Corroboration only; the brain derives the class.
    context: machineContext(cwd),
    // Ticket references found on the branch or in the command (see
    // evidenceRefs): the brain verifies them, they prove nothing on their own.
    evidence: evidenceRefs(machineContext(cwd), cfg.sensitive ? null : tool_input),
    session_id: session_id || null,
    // The person this run is acting for, asserted by the machine. Unverified by
    // construction, which the engine already handles: an asserted identity may
    // narrow what a rule grants, never widen it.
    on_behalf_of: actsFor(cwd),
    // Who acted, on whose behalf — the delegation chain the lineage branches on.
    actor_chain: actorChain,
    // Surface the tool's arguments as target_attr so deterministic argument
    // rules (target.<name>, e.g. target.amount > 10000) can gate on them —
    // mirrors the SDK adapters.
    // Sensitive mode: send ONLY the shape — omit the tool arguments and the raw
    // tool_input so a confidential payload never leaves this machine.
    target_attr: cfg.sensitive ? null : ((tool_input && typeof tool_input === 'object' && !Array.isArray(tool_input)) ? tool_input : null),
    metadata: cfg.sensitive
      ? { cwd, source: cfg.source, agent_id: agent_id || null, agent_type: agent_type || null, sensitive: true }
      : { input: tool_input, cwd, source: cfg.source, agent_id: agent_id || null, agent_type: agent_type || null },
    ...(cfg.sensitive ? { sensitive: true } : {}),
  };
  if (!cfg.sensitive && cfg.forwardCtx && transcript_path) {
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
  const decisionId = verdict.decision_id || null;
  const tag = decisionId ? ` [${decisionId}]` : '';
  // A workspace can write its own refusal copy. When it has, that is what its
  // people are meant to read, so it replaces ours rather than sitting unused
  // behind it.
  const tenantMsg = (effect === 'block' ? verdict.block_message : verdict.stepup_message) || null;
  // An action outside the mandate is an authority outcome, not a pending
  // approval that nobody got to. Saying "step-up not approved" made the most
  // common refusal in the product read like a timeout on a request that was
  // never made.
  const authority = verdict.matched_policy === 'role-boundary';

  // Answer Claude Code, but FIRST confirm to the engine what the gate actually
  // did — so the console can show "did not run" only when the gate truly refused
  // it, never inferred from the verdict. Best-effort (short timeout, swallowed):
  // it must never delay or weaken the gate decision. Only the ENFORCING outcomes
  // (deny / ask) are confirmed; an allow makes no enforcement claim to confirm,
  // so the common path keeps its single round-trip.
  const decide = async (permission, enforcedOutcome, msg) => {
    if (decisionId && enforcedOutcome) {
      try { await confirmEnforcement(cfg, decisionId, enforcedOutcome); } catch { /* stays unconfirmed */ }
    }
    out(permission, msg);
  };

  // The CONSOLE is the single source of truth for enforcement — there is no
  // local mode that can loosen or tighten the verdict. The engine has ALREADY
  // applied the effective mode it resolved (workspace + per-agent Observe /
  // Enforce): in Observe it returns `allow` for discretionary verdicts
  // (shadowed, with what-it-would-have-done recorded and signed server-side) and
  // only the hard safety floor comes back as `block`; in Enforce every verdict
  // stands. So the hook simply OBEYS the returned effect. A machine must not be
  // able to self-exempt (that would let the console show "blocked" for an action
  // that actually ran) — set the mode in the console, per agent or workspace.
  if (effect === 'block') {
    return decide('deny', 'denied', tenantMsg
      ? `${tenantMsg}${tag}`
      : `Clevr blocked this action: ${reason}${tag}`);
  }
  if (effect === 'escalate' || effect === 'step_up') {
    // A hold means a PERSON decides, in the console or from Slack or Teams.
    // It never means asking the developer sitting here: approving your own hold
    // empties the control. This gate answers in seconds and cannot wait for an
    // asynchronous approval, so where the wait is impossible the action is
    // refused and the person is told how to unblock it. CLEVR_ESCALATE=allow is
    // the one documented way out, named the same in every harness.
    if (cfg.escalate === 'allow') return decide(null, 'allowed', null);
    if (tenantMsg) return decide('deny', 'denied', `${tenantMsg}${tag}`);
    if (authority) {
      return decide('deny', 'denied',
        `Clevr did not run this: ${reason} Authorize the tool in the mandate, or have someone approve this action in the console.${tag}`);
    }
    return decide('deny', 'denied',
      `Clevr did not run this. It needs a human decision, and this gate answers in seconds so it cannot wait for one: ${reason}${tag}`);
  }
  if (cfg.autoApprove) out('allow', `Clevr allowed this action${tag}`);  // allow: no enforcement claim to confirm
  out(null);  // additive: let Claude Code's normal permission flow proceed
}

main().catch((e) => {
  process.stderr.write(`[clevr] gate error: ${e.message}; allowing.\n`);
  out(null);
});
