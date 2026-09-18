#!/usr/bin/env node
// clevr-prompt.mjs — Cursor beforeSubmitPrompt hook.
//
// Every message the user sends the Composer agent, before it goes. The gate next
// door only ever sees prompts at tool-call moments, so the conversation itself —
// where a pasted secret or an injection aimed at the agent arrives — was going
// past ungoverned.
//
// beforeSubmitPrompt honours `continue: false`, so unlike Copilot's prompt event
// this one can genuinely stop the message, and `user_message` says why.
import { readFileSync } from 'node:fs';
import { loadConfig, postEvaluate, promptBody } from './clevr-common.mjs';

const allow = () => process.exit(0);
function stop (message) {
  process.stdout.write(JSON.stringify({ continue: false, user_message: message }));
  process.exit(0);
}

async function main () {
  let hook = {};
  try { hook = JSON.parse(readFileSync(0, 'utf8')); } catch { allow(); }

  const cfg = loadConfig('cursor');
  if (!cfg.apiKey || cfg.sensitive) allow();

  const prompt = hook.prompt ?? '';
  if (!String(prompt).trim()) allow();

  const res = await postEvaluate(cfg, promptBody(cfg, {
    prompt,
    sessionId: hook.conversation_id || hook.generation_id || null,
    cwd: hook.workspace_roots?.[0] || hook.cwd || null,
    source: 'cursor',
  }));
  if (res.inactive) allow();
  if (res.failclosed) stop(res.reason);
  if (res.failopen) {
    process.stderr.write(`[clevr] engine error (${res.reason}); allowing (fail-open).\n`);
    allow();
  }

  const v = res.verdict;
  if (cfg.mode === 'shadow') allow();          // this machine records only
  const tag = v.decision_id ? ` [${v.decision_id}]` : '';
  const tenantMsg = (v.effect === 'block' ? v.block_message : v.stepup_message) || null;
  if (v.effect === 'block') stop(tenantMsg ? tenantMsg + tag : `Clevr blocked this prompt: ${v.reason}${tag}`);
  if (v.effect === 'escalate' || v.effect === 'step_up') {
    stop(tenantMsg ? tenantMsg + tag : `Clevr did not send this prompt. It needs a human decision first: ${v.reason}${tag}`);
  }
  allow();
}

main().catch((e) => { process.stderr.write(`[clevr] prompt hook error: ${e.message}; allowing.\n`); process.exit(0); });
