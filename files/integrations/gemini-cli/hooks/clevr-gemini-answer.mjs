#!/usr/bin/env node
// clevr-gemini-answer.mjs — Gemini CLI AfterModel hook.
//
// The model's own reply, before it reaches the user. This is the channel that
// existed only on the gateway until now, and Gemini CLI is the one harness that
// hands a hook BOTH the request and the response, so the whole response-side
// floor works here with no proxy in front.
//
// That includes the one question that needs both texts: did the answer give the
// system prompt away? The instructions are in `llm_request`, the reply is in
// `llm_response`, same event, so the comparison is against this call's own
// prompt and can never go stale.
//
// AfterModel takes `decision: "deny"` to discard the chunk. We use it only for a
// hard block: an answer held for review is reported, not deleted, because
// silently dropping a reply mid-stream looks like a crash to the person waiting.
import { readFileSync } from 'node:fs';
import { loadConfig, postEvaluate, answerBody } from './clevr-common.mjs';

const quiet = () => process.exit(0);

// Pull plain text out of whichever response shape arrives. Gemini nests parts
// under candidates/content; the OpenAI-compatible path uses choices.
function answerText (resp) {
  if (!resp) return '';
  if (typeof resp === 'string') return resp;
  const parts = [];
  for (const c of resp.candidates || []) {
    for (const p of c?.content?.parts || []) if (typeof p?.text === 'string') parts.push(p.text);
  }
  for (const c of resp.choices || []) {
    const m = c?.message?.content ?? c?.delta?.content;
    if (typeof m === 'string') parts.push(m);
  }
  if (!parts.length && typeof resp.text === 'string') parts.push(resp.text);
  return parts.join('');
}

// The instructions of this same call. Gemini puts them on systemInstruction;
// an OpenAI-shaped request carries a role:'system' message instead.
function systemText (req) {
  if (!req) return '';
  const si = req.systemInstruction ?? req.system_instruction ?? req.system;
  if (typeof si === 'string' && si.trim()) return si;
  if (si && Array.isArray(si.parts)) return si.parts.map((p) => p?.text || '').join('\n');
  const msgs = Array.isArray(req.messages) ? req.messages : [];
  return msgs.filter((m) => String(m?.role || '').toLowerCase() === 'system')
    .map((m) => (typeof m.content === 'string' ? m.content
      : Array.isArray(m.content) ? m.content.map((c) => c?.text || '').join('\n') : ''))
    .join('\n');
}

async function main () {
  let hook = {};
  try { hook = JSON.parse(readFileSync(0, 'utf8')); } catch { quiet(); }

  const cfg = loadConfig();
  if (!cfg.apiKey || cfg.sensitive) quiet();

  const answer = answerText(hook.llm_response);
  if (!answer.trim()) quiet();

  const res = await postEvaluate(cfg, answerBody(cfg, {
    answer,
    systemPrompt: systemText(hook.llm_request),
    sessionId: hook.session_id || hook.sessionId || null,
    cwd: hook.cwd || null, source: 'gemini-cli',
  }));
  if (res.inactive || res.failopen || res.failclosed) quiet();

  const v = res.verdict || {};
  if (!['block', 'escalate', 'step_up'].includes(v.effect)) quiet();
  const tag = v.decision_id ? ` [${v.decision_id}]` : '';
  const reason = String(v.reason || 'Content policy.').replace(/\s*in prompt\b/gi, ' in the reply').trim();

  if (v.effect === 'block') {
    process.stdout.write(JSON.stringify({
      decision: 'deny',
      reason: `Clevr stopped this reply: ${reason}${tag}`,
      systemMessage: `Clevr stopped a reply: ${reason}`,
    }));
    process.exit(0);
  }
  // Held: recorded and surfaced, not deleted. Dropping a reply the person is
  // waiting for, to tell them a reviewer will look at it later, trades one
  // problem for a worse one.
  process.stdout.write(JSON.stringify({
    systemMessage: `Clevr flagged this reply for review: ${reason}${tag}`,
  }));
  process.exit(0);
}

main().catch(() => process.exit(0));
