#!/usr/bin/env node
// clevr-augment-gate.mjs — Augment CLI PreToolUse hook.
//
// Before ANY Augment tool runs (launch-process, str-replace-editor, an MCP
// tool, ...), this gate POSTs the proposed action to Clevr (POST /v1/evaluate)
// and maps the verdict onto Augment's permission model.
//
// THE ONE THING THAT IS DIFFERENT, and it is a product decision rather than a
// detail: Augment implements only `deny`. There is no `ask`, so a HOLD has no
// inline equivalent — the agent cannot pause and wait for a person the way it
// can in Claude Code or Copilot.
//
// So a Hold is returned as a deny whose REASON says it is held, not refused.
// The developer reads "waiting for <reviewer>", the reviewer answers in Slack,
// Teams or the console, and the developer re-runs. That is honest in both
// directions: nothing runs that a person has not cleared, and nobody is told
// their action was forbidden when it was merely queued.
//
// Set CLEVR_ESCALATE=allow to invert it: a Hold then proceeds and is only
// recorded. That is a real posture some teams want, and it is a choice they make
// rather than a default we make for them.
import { readFileSync } from 'node:fs';
import { trunc, loadConfig, postEvaluate, confirmEnforcement, actsFor, rememberedHold, rememberHold, effectiveFailsafe, skillLoadsIn, gateSkillLoads } from './clevr-common.mjs';

function out (decision, reason) {
  if (decision) {
    process.stdout.write(JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: decision,          // Augment implements 'deny' only
        permissionDecisionReason: reason || '',
      },
    }));
  }
  process.exit(0);                              // structured decisions use exit 0
}

// Augment's tool names are its own (`launch-process`, `str-replace-editor`), so
// the mapping is its own. Guessing a shared one is how a destructive verb ends
// up classified as a read.
function classify (tool, input = {}, isMcp = false) {
  const t = String(tool || '').toLowerCase();
  if (/launch.?process|run.?process|bash|shell|terminal/.test(t)) {
    return { action_type: 'exec', action: trunc(input.command || input.cmd || 'shell'), target: null };
  }
  if (/editor|edit|write|create|save|patch/.test(t)) {
    const path = input.path || input.file_path || input.instruction_reminder_path || input.file || '';
    return { action_type: 'write', action: `${tool} ${path}`.trim(), target: path || null };
  }
  if (/view|read|open|codebase.?retrieval|grep|search|list/.test(t)) {
    const path = input.path || input.file_path || input.query || input.pattern || '';
    return { action_type: 'read', action: `${tool} ${path}`.trim(), target: input.path || input.file_path || null };
  }
  if (/web.?fetch|web.?search|fetch|open.?browser/.test(t)) {
    const url = input.url || input.query || '';
    return { action_type: 'network', action: `fetch ${url}`.trim(), target: input.url || null };
  }
  return { action_type: isMcp ? 'tool_call' : 'tool_call', action: `${tool}(${trunc(JSON.stringify(input))})`, target: null };
}

let cfg = null;   // module-scoped so the top-level catch can read the fail policy
async function main () {
  let hook = {};
  try { hook = JSON.parse(readFileSync(0, 'utf8')); } catch { out(null); }

  cfg = loadConfig();
  if (!cfg.apiKey) {
    process.stderr.write('[clevr] CLEVR_API_KEY not set; gate inactive (allowing). Set it to enforce.\n');
    out(null);
  }

  const { tool_name = 'unknown', tool_input = {}, is_mcp_tool = false, conversation_id, workspace_roots } = hook;
  const { action_type, action, target } = classify(tool_name, tool_input, is_mcp_tool);
  const cwd = Array.isArray(workspace_roots) ? workspace_roots[0] : null;

  const body = {
    agent: cfg.agent, tool: tool_name, action_type, action, target,
    // The person this run is acting for, asserted by the machine. Unverified by
    // construction: the engine lets an asserted identity narrow what a rule
    // grants, never widen it. The key's owner outranks it server side.
    on_behalf_of: actsFor(cwd),
    environment: cfg.env,
    session_id: conversation_id || null,
    actor_chain: [{ type: 'agent', id: cfg.agent, display: cfg.agent }],
    target_attr: cfg.sensitive ? null : ((tool_input && typeof tool_input === 'object' && !Array.isArray(tool_input)) ? tool_input : null),
    metadata: cfg.sensitive
      ? { cwd, source: 'augment', is_mcp_tool, sensitive: true }
      : { input: tool_input, cwd, source: 'augment', is_mcp_tool },
    ...(cfg.sensitive ? { sensitive: true } : {}),
  };

  // A skill's SKILL.md the agent opens: the load is asked first, as its own
  // action, and the call runs only if it may.
  const loads = skillLoadsIn(tool_name, tool_input, cwd);
  if (loads.length) {
    const stop = await gateSkillLoads(cfg, loads, { sessionId: conversation_id || null, cwd, byTool: tool_name });
    if (stop) out('deny', stop.message);
  }

  // If this exact action was held before and someone has approved it since,
  // the engine spends that approval here and the retry runs. It checks the
  // agent, the tool, the arguments and its own window, so a remembered id
  // that no longer fits simply buys nothing.
  const pending = rememberedHold(cfg.agent, tool_name, tool_input);
  if (pending) body.resume = pending;

  const res = await postEvaluate(cfg, body);
  if (res.inactive) out(null);
  if (res.failclosed) out('deny', res.reason);
  if (res.failopen) {
    process.stderr.write(`[clevr] engine error (${res.reason}); allowing (fail-open).\n`);
    out(null);
  }

  const verdict = res.verdict;
  const effect = verdict.effect;
  const decisionId = verdict.decision_id || null;
  const tag = decisionId ? ` [${decisionId}]` : '';
  const tenantMsg = (effect === 'block' ? verdict.block_message : verdict.stepup_message) || null;
  const authority = verdict.matched_policy === 'role-boundary';
  const base = tenantMsg || verdict.reason || (authority ? 'Outside this agent’s mandate.' : 'Held by Clevr.');

  // In the words the enforcement route accepts ('denied' | 'asked' | 'allowed').
  // A boolean here was answered with 400, so every Augment refusal read as
  // "not confirmed" in the console.
  const decide = async (decision, enforced, msg) => {
    if (decisionId) { try { await confirmEnforcement(cfg, decisionId, enforced); } catch { /* stays unconfirmed */ } }
    out(decision, msg);
  };

  if (effect === 'block') return decide('deny', 'denied', base + tag);

  // Remember which decision this action was held on, so the retry can spend
  // the approval; forget it as soon as the action runs.
  if (effect === 'escalate' || effect === 'step_up') rememberHold(cfg.agent, tool_name, tool_input, decisionId);
  else if (pending) rememberHold(cfg.agent, tool_name, tool_input, null);

  if (effect === 'escalate' || effect === 'step_up') {
    // A hold let through is an allow this machine chose; say so. One name for
    // the escape in every harness: three different ones was three behaviours.
    if (String(process.env.CLEVR_ESCALATE || 'deny').toLowerCase() === 'allow') return decide(null, 'allowed', null);
    // Say WHY it stopped and what unblocks it. Augment has no ask, so without
    // this sentence a Hold reads to the developer as a flat refusal.
    // A workspace that wrote its own copy chose what its people read, so it is
    // used VERBATIM and Clevr adds nothing around it. Two gates already did that
    // and three wrapped it in a sentence of ours, which is the same divergence
    // one layer down: the same tenant message read differently depending on the
    // harness. Our sentence is the fallback, not a frame.
    if (tenantMsg) return decide('deny', 'denied', `${tenantMsg}${tag}`);
    return decide('deny', 'denied', `Held for review, not refused: ${base} Approve it in Clevr (or from Slack or Teams), then run it again exactly as it was.${tag}`);
  }

  out(null);
}

main().catch((e) => {
  // A hook-internal error is the gate failing to complete, like an unreachable
  // engine, so it obeys the SAME fail policy instead of unconditionally allowing:
  // under a fail-closed workspace a post-verdict crash denies rather than letting
  // the tool run ungoverned. Fail-open orgs (and cold-start hooks) still proceed.
  const closed = effectiveFailsafe(cfg) === 'closed';
  process.stderr.write(`[clevr] gate error: ${e.message}; ${closed ? 'denying (fail-closed per policy)' : 'allowing (fail-open per policy)'}.\n`);
  out(closed ? 'deny' : null, closed ? `Clevr gate error; failing closed per policy: ${e.message}` : undefined);
});
