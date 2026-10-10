#!/usr/bin/env node
// clevr-answer.mjs — Cursor afterAgentResponse hook.
//
// The agent's finished reply, scanned on its way out: personal data, credentials
// and confidential markers leaving in the model's own words rather than in a tool
// call.
//
// WHAT THIS CANNOT DO, said here so nobody assumes otherwise: Cursor hands this
// event the reply text and nothing else. No system prompt, so the one check that
// needs both — did the answer give the instructions away? — cannot run here. It
// runs where the harness provides both (the gateway, and Gemini CLI's AfterModel).
// And the event has no output fields at all, so this records, it never stops.
import { readFileSync } from 'node:fs';
import { loadConfig, postEvaluate, answerBody } from './clevr-common.mjs';

const done = () => process.exit(0);

async function main () {
  let hook = {};
  try { hook = JSON.parse(readFileSync(0, 'utf8')); } catch { done(); }

  const cfg = loadConfig('cursor');
  if (!cfg.apiKey || cfg.sensitive) done();

  const answer = hook.text ?? '';
  if (!String(answer).trim()) done();

  const res = await postEvaluate(cfg, answerBody(cfg, {
    answer,
    sessionId: hook.conversation_id || hook.generation_id || null,
    cwd: hook.workspace_roots?.[0] || hook.cwd || null,
    source: 'cursor',
  }));
  if (res.inactive || res.failopen || res.failclosed) done();

  const v = res.verdict || {};
  if (!['block', 'escalate', 'step_up'].includes(v.effect)) done();
  const tag = v.decision_id ? ` [${v.decision_id}]` : '';
  process.stderr.write(`[clevr] This reply was flagged: ${String(v.reason || 'content policy').replace(/\s*in prompt\b/gi, ' in the reply')}${tag}\n`);
  process.stderr.write('[clevr] Cursor gives this event no way to stop a reply, so it was recorded, not withheld.\n');
  done();
}

main().catch(() => process.exit(0));
