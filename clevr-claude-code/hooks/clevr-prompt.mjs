#!/usr/bin/env node
// clevr-prompt.mjs — Claude Code UserPromptSubmit hook.
//
// Fires on EVERY user prompt, before the model sees it — including turns that
// never call a tool. It POSTs the prompt to Clevr's engine (POST /v1/evaluate)
// so the prompt is scanned (PII / secrets / injection) and recorded under the
// session, even when no tool follows. This closes the gap left by the PreToolUse
// gate, which only sees prompts at tool-call moments.
//
//   allow    -> the prompt proceeds.
//   block    -> (enforce) the prompt is refused; the user sees the reason.
//   escalate -> (enforce) held with a "needs human approval" reason. A prompt has
//               no inline approval affordance, so a non-allow holds it.
//
// shadow mode (default) NEVER blocks: it records the verdict and, if Clevr would
// have stopped the prompt, surfaces that as additional context the model sees —
// the prompt still proceeds. Same CLEVR_* environment as the gate.
//
// Why the prompt rides in `conversation` (not `action`): the engine's content
// detectors (PII / secrets / injection) scan the conversation, but the verb
// safety-floor classifies only the `action`/`tool` fields. Putting natural
// language in `action` would misfire the verb floor on words like "delete" or
// "send". So we keep `action` neutral and let the content floor read the prompt
// from the conversation — it gets fully scanned without spurious verb blocks.

import { readFileSync } from 'node:fs';
import { trunc, loadConfig, readConversation, postEvaluate } from './clevr-common.mjs';

// UserPromptSubmit: empty output (exit 0) = the prompt proceeds.
function allow () { process.exit(0); }

// Block the prompt. UserPromptSubmit reads a top-level `decision: "block"`; the
// reason is shown to the user and the prompt is not sent to the model.
function block (reason) {
  process.stdout.write(JSON.stringify({ decision: 'block', reason: reason || 'Blocked by Clevr.' }));
  process.exit(0);
}

// Proceed, but inject context the model will see. Used in shadow mode to surface
// a would-have-stopped verdict without actually holding the prompt.
function context (text) {
  process.stdout.write(JSON.stringify({ hookSpecificOutput: {
    hookEventName: 'UserPromptSubmit', additionalContext: text } }));
  process.exit(0);
}

async function main () {
  let hook = {};
  try { hook = JSON.parse(readFileSync(0, 'utf8')); } catch { allow(); }

  const cfg = loadConfig();
  if (!cfg.apiKey) {
    process.stderr.write('[clevr] CLEVR_API_KEY not set; prompt capture inactive (allowing).\n');
    allow();
  }

  const { prompt = '', session_id, transcript_path, cwd } = hook;
  if (!String(prompt).trim()) allow();   // nothing to scan

  // Build the recent window and make sure THIS prompt is its last user turn (the
  // transcript may not include it yet at submit time).
  let conversation = [];
  if (cfg.forwardCtx && transcript_path) conversation = readConversation(transcript_path, cfg.contextTurns);
  const thisTurn = { role: 'user', content: trunc(prompt, 1000) };
  const last = conversation[conversation.length - 1];
  if (!last || last.role !== 'user' || last.content !== thisTurn.content) {
    conversation = [...conversation, thisTurn];
  }
  const firstUser = conversation.find((m) => m.role === 'user');

  const body = {
    agent: cfg.agent,
    action_type: 'message',          // a prompt is content, not a verb-classified action
    action: 'user prompt',           // neutral: keeps the verb safety-floor off the prose
    target: null,
    environment: cfg.env,
    session_id: session_id || null,
    session_goal: firstUser ? trunc(firstUser.content, 300) : null,
    conversation,                    // the prompt itself — scanned by the content floor
    metadata: { cwd, source: 'claude-code', event: 'user-prompt' },
  };

  const res = await postEvaluate(cfg, body);
  if (res.inactive) allow();
  if (res.failclosed) block(res.reason);
  if (res.failopen) {
    process.stderr.write(`[clevr] engine error (${res.reason}); allowing (fail-open).\n`);
    allow();
  }
  const verdict = res.verdict;

  const effect = verdict.effect;
  const reason = verdict.reason || '';
  const tag = verdict.decision_id ? ` [${verdict.decision_id}]` : '';
  const stop = effect === 'block' || effect === 'escalate' || effect === 'step_up';

  // shadow: never block. Surface a would-have-stopped verdict as context.
  if (cfg.mode === 'shadow') {
    if (stop) context(`Clevr (shadow) would have ${effect === 'block' ? 'BLOCKED' : 'HELD'} this prompt: ${reason}${tag}`);
    allow();
  }

  // enforce: a non-allow verdict holds the prompt (no inline approval for a prompt).
  if (effect === 'block') block(`Clevr blocked this prompt: ${reason}${tag}`);
  if (effect === 'escalate' || effect === 'step_up') block(`Clevr held this prompt for human approval: ${reason}${tag}`);
  allow();
}

main().catch((e) => {
  process.stderr.write(`[clevr] prompt hook error: ${e.message}; allowing.\n`);
  process.exit(0);
});
