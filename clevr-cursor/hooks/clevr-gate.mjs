#!/usr/bin/env node
// clevr-gate.mjs — Clevr hook for Cursor.
//
// Registered on `preToolUse` (the generic hook that fires before every Cursor
// Agent tool: Shell, file read/write, MCP, ...). Before the tool runs, this gate
// POSTs the proposed action to Clevr (POST /v1/evaluate) and maps the verdict
// onto Cursor's hook permission model:
//
//   allow    -> proceed  (additive: Cursor's own confirmations still apply,
//                          unless CLEVR_AUTO_APPROVE=1 makes Clevr the sole gate)
//   escalate -> deny/hold (a synchronous hook cannot wait for an async console
//                          approval; CLEVR_ESCALATE=allow lets it through, recorded)
//   block    -> deny     (the tool never runs; the model sees the reason)
//
// This gates the Cursor Agent's ACTIONS even though its model is locked to
// Cursor's backend: the hook fires in the agent loop, not on the network.
// Shadow mode (default) records every verdict server-side but never blocks, so a
// fresh install observes without changing Cursor's behavior. Config is entirely
// via environment — see clevr-common.mjs.
//
// Contract: Cursor spawns this process, sends the hook JSON on stdin, and reads
// a JSON decision on stdout. Exit 0 with no JSON is an additive no-op.

import { readFileSync } from 'node:fs';
import { trunc, loadConfig, postEvaluate, confirmEnforcement, actsFor } from './clevr-common.mjs';

// permission ∈ 'allow' | 'deny' | 'ask'. null => print nothing (additive no-op),
// so Cursor's normal flow proceeds unchanged (used for allow + shadow).
function out (permission, reason) {
  if (permission) {
    const msg = reason || '';
    process.stdout.write(JSON.stringify({ permission, agent_message: msg, user_message: msg }));
  }
  process.exit(0);
}

// Map a Cursor tool + input onto the engine's action shape. The `action` text
// carries the command / path / args so the deterministic content floor can scan
// it (a shell command that exfiltrates a secret blocks on the text alone).
function classify (toolName, input = {}) {
  const t = String(toolName || '');
  if (/^(shell|terminal|run_?terminal|bash|command)/i.test(t) || input.command != null)
    return { action_type: 'exec', action: trunc(input.command || t), target: null };
  if (/(write|edit|create|apply|delete|move|rename)/i.test(t)) {
    const p = input.file_path || input.path || input.target_file || '';
    return { action_type: 'write', action: `${t} ${p}`.trim(), target: p || null };
  }
  if (/(read|search|grep|glob|list|view|fetch|url)/i.test(t)) {
    const p = input.file_path || input.path || input.query || input.pattern || input.url || '';
    const net = /fetch|url/i.test(t) || input.url != null;
    return { action_type: net ? 'network' : 'read', action: `${t} ${trunc(p, 120)}`.trim(), target: input.file_path || input.path || input.url || null };
  }
  // MCP tool or anything else: a generic gated tool call.
  return { action_type: 'tool_call', action: `${t}(${trunc(JSON.stringify(input))})`, target: input.url || null };
}

async function main () {
  let hook = {};
  try { hook = JSON.parse(readFileSync(0, 'utf8')); } catch { out(null); }

  const cfg = loadConfig('cursor');
  if (!cfg.apiKey) {
    process.stderr.write('[clevr] CLEVR_API_KEY not set; hook inactive (allowing). Set it to enforce.\n');
    out(null);
  }

  // Tolerate all three Cursor input shapes: preToolUse {tool_name, tool_input},
  // beforeShellExecution {command, cwd}, beforeMCPExecution {tool_name, tool_input, url}.
  const toolName = hook.tool_name || (hook.command != null ? 'Shell' : (hook.url ? 'mcp' : 'unknown'));
  const toolInput = hook.tool_input || (hook.command != null ? { command: hook.command } : (hook.url ? { url: hook.url } : {}));
  const { action_type, action, target } = classify(toolName, toolInput);

  const body = {
    agent: cfg.agent, tool: toolName, action_type, action, target,
    environment: cfg.env,
    session_id: hook.conversation_id || null,
    // The person this run is acting for, asserted by the machine. Unverified by
    // construction: the engine lets an asserted identity narrow what a rule
    // grants, never widen it. The key's owner outranks it server side.
    on_behalf_of: actsFor(hook.cwd),
    // Surface the tool's arguments as target_attr so deterministic argument rules
    // (target.<name>, e.g. target.amount > 10000) can gate on them — mirrors the SDK.
    // Sensitive mode: send ONLY the shape — omit the tool arguments and raw input.
    target_attr: cfg.sensitive ? null : ((toolInput && typeof toolInput === 'object' && !Array.isArray(toolInput)) ? toolInput : null),
    metadata: cfg.sensitive
      ? { cwd: hook.cwd || null, source: 'cursor', cursor_version: hook.cursor_version || null, sensitive: true }
      : { input: toolInput, cwd: hook.cwd || null, source: 'cursor', cursor_version: hook.cursor_version || null },
    ...(cfg.sensitive ? { sensitive: true } : {}),
  };
  // Minimal context: Cursor hands preToolUse the assistant's current message.
  if (!cfg.sensitive && cfg.forwardCtx && hook.agent_message) {
    body.conversation = [{ role: 'assistant', content: trunc(hook.agent_message, 1000) }];
  }

  const res = await postEvaluate(cfg, body);
  if (res.inactive) out(null);
  if (res.failclosed) out('deny', res.reason);
  if (res.failopen) {
    process.stderr.write(`[clevr] engine error (${res.reason}); allowing (fail-open).\n`);
    out(null);
  }

  const v = res.verdict;
  const effect = v.effect;
  const reason = v.reason || '';
  const decisionId = v.decision_id || null;
  const tag = decisionId ? ` [${decisionId}]` : '';

  // Answer Cursor, but FIRST confirm to the engine what the gate actually did — so
  // the console shows "did not run" only when the gate truly refused it, never
  // inferred from the verdict. Best-effort; only the ENFORCING outcomes are
  // confirmed. In shadow mode below the gate returns null (no enforcement) and so
  // never confirms — the console then honestly reads the block as "not confirmed".
  const decide = async (permission, enforcedOutcome, msg) => {
    if (decisionId && enforcedOutcome) {
      try { await confirmEnforcement(cfg, decisionId, enforcedOutcome); } catch { /* stays unconfirmed */ }
    }
    out(permission, msg);
  };

  // Local override: CLEVR_MODE=shadow forces THIS machine to record-only, never
  // blocking, whatever the engine returned (the decision is already sealed
  // server-side by the POST above). Default (unset) obeys the engine — the
  // console's per-agent / workspace mode decides shadow vs enforce, and a new
  // agent observes first, so an install still can't brick Cursor out of the box.
  if (cfg.mode === 'shadow') out(null);

  // A workspace can write its own refusal copy; when it has, that is what its
  // people are meant to read, so it replaces ours (same rule as the other gates).
  const tenantMsg = (effect === 'block' ? v.block_message : v.stepup_message) || null;
  const authority = v.matched_policy === 'role-boundary';
  if (effect === 'block') return decide('deny', 'denied', tenantMsg ? `${tenantMsg}${tag}` : `Clevr blocked this action: ${reason}${tag}`);
  if (effect === 'escalate' || effect === 'step_up') {
    // A hold means a PERSON decides, in the console or from Slack or Teams.
    // It never means asking the developer sitting here: approving your own hold
    // empties the control. This gate answers in seconds and cannot wait for an
    // asynchronous approval, so where the wait is impossible the action is
    // refused and the person is told how to unblock it. CLEVR_ESCALATE=allow is
    // the one documented way out, named the same in every harness.
    if (cfg.escalate === 'allow') return decide(null, 'allowed', null);
    if (tenantMsg) return decide('deny', 'denied', `${tenantMsg}${tag}`);
    // An action outside the mandate is an authority outcome, not an approval
    // nobody answered; saying "step-up not approved" misread the commonest refusal.
    if (authority) return decide('deny', 'denied', `Clevr did not run this: ${reason} Authorize the tool in the mandate, or have someone approve this action in the console.${tag}`);
    return decide('deny', 'denied', `Clevr did not run this. It needs a human decision, and this gate answers in seconds so it cannot wait for one: ${reason}${tag}`);
  }
  if (cfg.autoApprove) out('allow', `Clevr allowed this action${tag}`);  // allow: no enforcement claim to confirm
  out(null);  // additive: let Cursor's normal permission flow proceed
}

main().catch((e) => {
  process.stderr.write(`[clevr] gate error: ${e.message}; allowing.\n`);
  out(null);
});
