#!/usr/bin/env node
// clevr-gemini-gate.mjs — Gemini CLI BeforeTool hook.
//
// Gemini CLI gained hooks in January 2026, so it no longer has to be governed
// at the gateway, where only the conversation is visible and the local tool call
// is not. This gate runs before any tool does.
//
// Three names differ from every other harness we gate, and only three:
//   • the event is `BeforeTool`, not `PreToolUse`
//   • the decision is `decision: allow|deny|block`, at the TOP level
//   • the explanation is `reason`, not `permissionDecisionReason`
// Everything else is the shared code, so the gates cannot drift apart.
//
// Gemini has no inline `ask`, like Augment. A Hold is therefore returned as a
// deny whose reason SAYS it is held and how to clear it, rather than being
// silently dropped or presented as a refusal. CLEVR_ESCALATE=allow inverts
// that for a team that wants holds recorded and not enforced here.
import { readFileSync } from 'node:fs';
import { trunc, loadConfig, readConversation, postEvaluate, confirmEnforcement, actsFor, rememberedHold, rememberHold, effectiveFailsafe, describeSkill, skillLoadsIn, gateSkillLoads } from './clevr-common.mjs';

function out (decision, reason) {
  if (decision) process.stdout.write(JSON.stringify({ decision, reason: reason || '' }));
  process.exit(0);
}

// Gemini's built-ins: run_shell_command, write_file, replace, read_file,
// read_many_files, glob, search_file_content, web_fetch, google_web_search.
function classify (tool, input = {}) {
  const t = String(tool || '').toLowerCase();
  if (/shell|run_command|execute/.test(t)) {
    // An MCP code runner (ctx_execute) matches too, and carries `code`, not `command`.
    const run = input.command || (typeof input.code === 'string' ? input.code : '');
    return { action_type: 'exec', action: trunc(run || `${tool}(${JSON.stringify(input)})`), target: null };
  }
  if (/write_file|replace|edit|create/.test(t)) {
    const path = input.file_path || input.path || input.absolute_path || '';
    return { action_type: 'write', action: `${tool} ${path}`.trim(), target: path || null };
  }
  if (/read|glob|search_file|list/.test(t)) {
    const path = input.absolute_path || input.file_path || input.path || input.pattern || '';
    return { action_type: 'read', action: `${tool} ${path}`.trim(), target: input.file_path || input.absolute_path || null };
  }
  if (/web_fetch|fetch|web_search|google/.test(t)) {
    const url = input.url || input.prompt || input.query || '';
    return { action_type: 'network', action: `fetch ${trunc(url, 120)}`.trim(), target: input.url || null };
  }
  return { action_type: 'tool_call', action: `${tool}(${trunc(JSON.stringify(input))})`, target: null };
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

  const { tool_name = 'unknown', tool_input = {}, session_id, transcript_path, cwd, mcp_context } = hook;
  const { action_type, action, target } = classify(tool_name, tool_input);

  const body = {
    agent: cfg.agent, tool: tool_name, action_type, action, target,
    // The person this run is acting for, asserted by the machine. Unverified by
    // construction: the engine lets an asserted identity narrow what a rule
    // grants, never widen it. The key's owner outranks it server side.
    on_behalf_of: actsFor(cwd),
    environment: cfg.env,
    session_id: session_id || null,
    actor_chain: [{ type: 'agent', id: cfg.agent, display: cfg.agent }],
    target_attr: cfg.sensitive ? null : ((tool_input && typeof tool_input === 'object' && !Array.isArray(tool_input)) ? tool_input : null),
    metadata: cfg.sensitive
      ? { cwd, source: 'gemini-cli', mcp: !!mcp_context, sensitive: true }
      : { input: tool_input, cwd, source: 'gemini-cli', mcp: mcp_context || null },
    ...(cfg.sensitive ? { sensitive: true } : {}),
  };
  // Gemini CLI loads a skill through its activate_skill tool ({"name":"pdf"}):
  // the brain governs that call as skill:<name>, with the version this machine
  // holds (geminicli.com/docs/cli/skills).
  if (tool_name === 'activate_skill' && tool_input && typeof tool_input.name === 'string') {
    body.skill = describeSkill(tool_input.name, cwd, { sensitive: cfg.sensitive, harness: 'gemini-cli' });
  }
  // A skill's SKILL.md the agent opens with another tool: the load is asked
  // first, as its own action, and the call runs only if it may.
  const loads = skillLoadsIn(tool_name, tool_input, cwd);
  if (loads.length) {
    const stop = await gateSkillLoads(cfg, loads, { sessionId: session_id || null, cwd, byTool: tool_name });
    if (stop) out('deny', stop.message);
  }
  if (!cfg.sensitive && cfg.forwardCtx && transcript_path) {
    const convo = readConversation(transcript_path, cfg.contextTurns);
    if (convo.length) {
      body.conversation = convo;
      const firstUser = convo.find((m) => m.role === 'user');
      if (firstUser) body.session_goal = trunc(firstUser.content, 300);
    }
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

  // Tell the engine what this gate DID, in the words the enforcement route
  // accepts ('denied' | 'asked' | 'allowed'). A boolean here was answered with
  // 400 and every Gemini refusal read as "not confirmed" in the console.
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
    // A hold let through is an allow this machine chose; say so rather than
    // leaving the decision unconfirmed. One name for the escape in every harness.
    if (String(process.env.CLEVR_ESCALATE || 'deny').toLowerCase() === 'allow') return decide(null, 'allowed', null);
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
