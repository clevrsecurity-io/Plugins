#!/usr/bin/env node
// clevr-copilot-gate.mjs — GitHub Copilot CLI preToolUse hook.
//
// Before ANY Copilot tool runs (bash, edit, view, an MCP tool, ...), this gate
// POSTs the proposed action to Clevr (POST /v1/evaluate) and maps the verdict
// onto Copilot's permission model:
//
//   allow    -> allow   (Copilot's own confirmations still apply)
//   escalate -> deny    (a hold is decided in the console, never by asking the
//                        developer here; CLEVR_ESCALATE=allow lets it through)
//   block    -> deny    (the tool never runs; the reason is shown to the user)
//
// WHY THIS EXISTS. Until Copilot CLI shipped hooks, the only way to govern
// Copilot was to wrap its MCP servers, which covers MCP tools and nothing else.
// A coding agent's blast radius is not in MCP: it is `bash`, and writing files.
// This closes that, and it is the same coverage the Claude Code gate has.
//
// Copilot's contract differs from Claude Code's in two ways and only two:
// the input is {timestamp, cwd, toolName, toolArgs} rather than
// {tool_name, tool_input, ...}, and the decision is returned at the TOP level
// rather than nested under hookSpecificOutput. Everything else — the config,
// the evaluate call, fail-open/fail-closed, the enforcement confirmation — is
// the shared code, so the two gates cannot drift apart.
import { readFileSync } from 'node:fs';
// Beside this file, not up the tree: the installer copies the gate and the
// shared helpers into ~/.clevr/tools together, where a repo-relative path does
// not exist. In the repo the sibling is a one-line re-export, so there is still
// exactly one copy of the logic.
import { trunc, loadConfig, postEvaluate, confirmEnforcement, actsFor, rememberedHold, rememberHold, effectiveFailsafe, skillLoadsIn, gateSkillLoads } from './clevr-common.mjs';

function out (decision, reason) {
  if (decision) {
    process.stdout.write(JSON.stringify({
      permissionDecision: decision,              // 'allow' | 'deny' | 'ask'
      permissionDecisionReason: reason || '',
    }));
  }
  process.exit(0);                               // structured decisions use exit 0
}

// Map a Copilot tool + args onto the engine's action shape. The `action` text
// carries the command / path / args so the deterministic content floor can scan
// it: a shell command that exfiltrates a secret blocks on the text alone.
//
// Copilot's tool names are lowercase and differ from Claude Code's, so the
// mapping is its own rather than shared — guessing a shared one wrong is how a
// destructive verb ends up classified as a read.
function classify (tool, args = {}) {
  const t = String(tool || '').toLowerCase();
  if (/^(bash|shell|run|execute|terminal)/.test(t)) {
    return { action_type: 'exec', action: trunc(args.command || args.cmd || args.script || 'bash'), target: null };
  }
  if (/^(edit|write|create|str_replace|apply_patch|multi_edit)/.test(t)) {
    const path = args.path || args.file_path || args.filePath || args.file || '';
    return { action_type: 'write', action: `${tool} ${path}`.trim(), target: path || null };
  }
  if (/^(view|read|cat|glob|grep|search|list|ls)/.test(t)) {
    const path = args.path || args.file_path || args.filePath || args.pattern || args.query || '';
    return { action_type: 'read', action: `${tool} ${path}`.trim(), target: args.path || args.file_path || null };
  }
  if (/^(fetch|web|http|browse|url)/.test(t)) {
    const url = args.url || args.uri || '';
    return { action_type: 'network', action: `fetch ${url}`.trim(), target: url || null };
  }
  return { action_type: 'tool_call', action: `${tool}(${trunc(JSON.stringify(args))})`, target: null };
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

  const { toolName = 'unknown', toolArgs = {}, cwd, sessionId, session_id } = hook;
  const { action_type, action, target } = classify(toolName, toolArgs);

  const body = {
    agent: cfg.agent, tool: toolName, action_type, action, target,
    // The person this run is acting for, asserted by the machine. Unverified by
    // construction: the engine lets an asserted identity narrow what a rule
    // grants, never widen it. The key's owner outranks it server side.
    on_behalf_of: actsFor(cwd),
    environment: cfg.env,
    // Copilot does not always carry a session id; without one the engine simply
    // has no trajectory for the run, which is honest rather than invented.
    session_id: sessionId || session_id || null,
    actor_chain: [{ type: 'agent', id: cfg.agent, display: cfg.agent }],
    // Sensitive mode: send ONLY the shape, so a confidential payload never
    // leaves this machine. Same switch as the Claude Code gate.
    target_attr: cfg.sensitive ? null : ((toolArgs && typeof toolArgs === 'object' && !Array.isArray(toolArgs)) ? toolArgs : null),
    metadata: cfg.sensitive
      ? { cwd, source: 'github-copilot', sensitive: true }
      : { input: toolArgs, cwd, source: 'github-copilot' },
    ...(cfg.sensitive ? { sensitive: true } : {}),
  };

  // A skill's SKILL.md the agent opens: the load is asked first, as its own
  // action, and the call runs only if it may.
  const loads = skillLoadsIn(toolName, toolArgs, cwd);
  if (loads.length) {
    const stop = await gateSkillLoads(cfg, loads, { sessionId: sessionId || session_id || null, cwd, byTool: toolName });
    if (stop) out('deny', stop.message);
  }

  // If this exact action was held before and someone has approved it since,
  // the engine spends that approval here and the retry runs. It checks the
  // agent, the tool, the arguments and its own window, so a remembered id
  // that no longer fits simply buys nothing.
  const pending = rememberedHold(cfg.agent, toolName, toolArgs);
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
  const reason = tenantMsg || verdict.reason || (authority ? 'Outside this agent’s mandate.' : 'Held by Clevr.');

  // Confirm to the engine what the gate actually DID before answering Copilot,
  // so the console shows "did not run" only when the gate truly refused it,
  // never inferred from the verdict. Best-effort and never allowed to delay or
  // weaken the decision.
  // In the words the enforcement route accepts ('denied' | 'asked' | 'allowed').
  // A boolean here was answered with 400, so every Copilot refusal read as
  // "not confirmed" in the console.
  const decide = async (decision, enforced, msg) => {
    if (decisionId) { try { await confirmEnforcement(cfg, decisionId, enforced); } catch { /* stays unconfirmed */ } }
    out(decision, msg);
  };

  if (effect === 'block') return decide('deny', 'denied', reason + tag);
  // Remember which decision this action was held on, so the retry can spend
  // the approval; forget it as soon as the action runs.
  if (effect === 'escalate' || effect === 'step_up') rememberHold(cfg.agent, toolName, toolArgs, decisionId);
  else if (pending) rememberHold(cfg.agent, toolName, toolArgs, null);

  if (effect === 'escalate' || effect === 'step_up') {
    // A hold means a PERSON decides, in the console or from Slack or Teams.
    // It never means asking the developer sitting here: approving your own hold
    // empties the control. This gate answers in seconds and cannot wait for an
    // asynchronous approval, so where the wait is impossible the action is
    // refused and the person is told how to unblock it. CLEVR_ESCALATE=allow is
    // the one documented way out, named the same in every harness.
    if (String(process.env.CLEVR_ESCALATE || 'deny').toLowerCase() === 'allow') return decide(null, 'allowed', null);
    // A workspace that wrote its own copy chose what its people read, so it is
    // used VERBATIM and Clevr adds nothing around it. Two gates already did that
    // and three wrapped it in a sentence of ours, which is the same divergence
    // one layer down: the same tenant message read differently depending on the
    // harness. Our sentence is the fallback, not a frame.
    if (tenantMsg) return decide('deny', 'denied', `${tenantMsg}${tag}`);
    return decide('deny', 'denied', `Held for review, not refused: ${reason} Approve it in Clevr (or from Slack or Teams), then run it again exactly as it was.${tag}`);
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
