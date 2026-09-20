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
// Why the reply rides as an egress `output` and not in `conversation`: the
// engine's response-side floor reads the model's own words from the egress
// channel (what the gateway and the Gemini and Cursor answer hooks send). The
// assistant turn of a conversation is context for the OTHER channels and is not
// itself scanned, so a reply that echoed a national id back went through here
// as allow while the same text on the egress channel is held. Measured, then
// changed: this hook now sends what the answer hooks send.

import { readFileSync } from 'node:fs';
import { trunc, loadConfig, readConversation, postEvaluate, answerBody } from './clevr-common.mjs';

// Record-only: always let the turn finish. We never emit a `decision`, so the
// model is never forced to continue.
function done () { process.exit(0); }

async function main () {
  let hook = {};
  try { hook = JSON.parse(readFileSync(0, 'utf8')); } catch { done(); }

  const cfg = loadConfig();
  if (!cfg.apiKey || cfg.sensitive) done();   // a reply is content; sensitive mode keeps it here

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
  // The reply is the subject and goes on the egress channel, whole (capped high).
  // The prompt that led to it rides along as context, so the record reads as an
  // exchange rather than a bare answer. No system prompt: Claude Code does not
  // hand a Stop hook one, so the prompt-leak check cannot run here and the body
  // says so by omission rather than comparing against nothing.
  const body = answerBody(cfg, {
    answer: reply.content,
    sessionId: session_id || null,
    cwd: hook.cwd || null,
    source: cfg.source,
  });
  body.metadata.event = 'assistant-reply';
  if (prompt) {
    body.session_goal = trunc(prompt.content, 300);
    body.conversation = [prompt, reply];
  }

  // Record + scan. We never block (the reply is already shown); the verdict lives
  // in the Clevr audit, where a flagged reply (e.g. a leaked secret) surfaces for
  // review. Failures are swallowed so a hiccup never disrupts the chat.
  try { await postEvaluate(cfg, body); } catch { /* non-fatal */ }
  done();
}

main().catch(() => process.exit(0));
