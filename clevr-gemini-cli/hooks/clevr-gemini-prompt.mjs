#!/usr/bin/env node
// clevr-gemini-prompt.mjs — Gemini CLI BeforeAgent hook.
//
// Fires on every user message before the planner runs, including turns that
// never call a tool. The gate next door only sees prompts at tool-call moments,
// so without this the conversation itself is ungoverned: a secret pasted into a
// prompt, or an injection aimed at the agent, never reaches a detector.
//
// BeforeAgent takes `decision: "deny"` to discard the message, which is a real
// stop rather than a warning.
import { readFileSync } from 'node:fs';
import { loadConfig, postPrompt, promptBody } from './clevr-common.mjs';

const allow = () => process.exit(0);
function deny (reason) {
  process.stdout.write(JSON.stringify({ decision: 'deny', reason: reason || 'Blocked by Clevr.' }));
  process.exit(0);
}

async function main () {
  let hook = {};
  try { hook = JSON.parse(readFileSync(0, 'utf8')); } catch { allow(); }

  const cfg = loadConfig();
  if (!cfg.apiKey || cfg.sensitive) allow();

  const prompt = hook.prompt ?? hook.user_prompt ?? '';
  if (!String(prompt).trim()) allow();

  const res = await postPrompt(cfg, promptBody(cfg, {
    prompt, sessionId: hook.session_id || hook.sessionId || null,
    cwd: hook.cwd || null, source: 'gemini-cli',
  }));
  if (res.inactive) allow();
  // This workspace records prompts without gating them: the verdict could not
  // have refused anything, so the turn goes back without waiting for it.
  if (res.ungated) {
    if (!res.sent) process.stderr.write('[clevr] engine unreachable; this workspace records prompts without gating them, so the prompt proceeds unrecorded.\n');
    allow();
  }
  if (res.failclosed) deny(res.reason);
  if (res.failopen) {
    process.stderr.write(`[clevr] engine error (${res.reason}); allowing (fail-open).\n`);
    allow();
  }

  const v = res.verdict;
  const tag = v.decision_id ? ` [${v.decision_id}]` : '';
  const tenantMsg = (v.effect === 'block' ? v.block_message : v.stepup_message) || null;
  // A prompt has no inline approval: there is nobody to ask mid-keystroke, so a
  // hold stops it and says what unblocks it.
  if (v.effect === 'block') deny(tenantMsg ? tenantMsg + tag : `Clevr blocked this prompt: ${v.reason}${tag}`);
  if (v.effect === 'escalate' || v.effect === 'step_up') {
    deny(tenantMsg ? tenantMsg + tag : `Clevr did not send this prompt. It needs a human decision first: ${v.reason}${tag}`);
  }
  allow();
}

main().catch((e) => { process.stderr.write(`[clevr] prompt hook error: ${e.message}; allowing.\n`); process.exit(0); });
