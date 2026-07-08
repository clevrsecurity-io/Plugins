#!/usr/bin/env node
// clevr-stop.mjs — Claude Code Stop hook.
//
// Fires when the model FINISHES a turn. It reads the assistant's final reply
// from the transcript and POSTs it to Clevr (POST /v1/evaluate) so the model's
// OUTPUT is recorded under the session and scanned for content leaks (PII /
// secrets the model may have echoed back). This is what the PreToolUse gate and
// the UserPromptSubmit scanner cannot give: visibility on the model's own text.
//
// POST-RESPONSE and RECORD-ONLY: the reply has already been shown to the user, so
// this hook NEVER blocks (you cannot un-show a reply). It makes the model's
// output visible in the Clevr conversation + audit and flags a leak for review.
// Blocking the output BEFORE it is shown is the gateway's job (PROXY mode).
//
// Why the reply rides in `conversation`: same trick as clevr-prompt.mjs — the
// content detectors scan the conversation (the assistant_text segment), while the
// verb safety-floor classifies only `action`, so the reply is fully scanned
// without misfiring the verb banks on ordinary words.

import { readFileSync } from 'node:fs';
import { trunc, loadConfig, readConversation, postEvaluate } from './clevr-common.mjs';

// Record-only: always let the turn finish. We never emit a `decision`, so the
// model is never forced to continue.
function done () { process.exit(0); }

async function main () {
  let hook = {};
  try { hook = JSON.parse(readFileSync(0, 'utf8')); } catch { done(); }

  const cfg = loadConfig();
  if (!cfg.apiKey) done();

  const { session_id, transcript_path } = hook;
  if (!transcript_path) done();

  // Pull the recent window and isolate the just-finished assistant reply plus the
  // user prompt that triggered it (for context). Scanning only this exchange
  // avoids re-flagging earlier turns on every Stop.
  const window = readConversation(transcript_path, cfg.contextTurns);
  let replyIdx = -1;
  for (let i = window.length - 1; i >= 0; i--) {
    if (window[i].role === 'assistant') { replyIdx = i; break; }
  }
  if (replyIdx === -1) done();             // no assistant reply to record
  const reply = window[replyIdx];
  let prompt = null;
  for (let i = replyIdx - 1; i >= 0; i--) {
    if (window[i].role === 'user') { prompt = window[i]; break; }
  }
  const conversation = [prompt, reply].filter(Boolean);

  const body = {
    agent: cfg.agent,
    action_type: 'completion',       // the model's output, not a verb-classified action
    action: 'assistant reply',       // neutral: keeps the verb safety-floor off the prose
    target: null,
    environment: cfg.env,
    session_id: session_id || null,
    session_goal: prompt ? trunc(prompt.content, 300) : null,
    conversation,                    // the assistant_text is scanned by the content floor
    metadata: { source: 'claude-code', event: 'assistant-reply' },
  };

  // Record + scan. We never block (the reply is already shown); the verdict lives
  // in the Clevr audit, where a flagged reply (e.g. a leaked secret) surfaces for
  // review. Failures are swallowed so a hiccup never disrupts the chat.
  try { await postEvaluate(cfg, body); } catch { /* non-fatal */ }
  done();
}

main().catch(() => process.exit(0));
