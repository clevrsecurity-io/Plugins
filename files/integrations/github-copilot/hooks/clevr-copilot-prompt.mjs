#!/usr/bin/env node
// clevr-copilot-prompt.mjs — GitHub Copilot CLI userPromptSubmitted hook.
//
// Every user message, including the turns that never call a tool. Until this
// existed the Copilot integration saw tool calls only, and the conversation
// itself — where a pasted secret or an injection aimed at the agent actually
// arrives — went past ungoverned.
//
// THE LIMIT, and it is Copilot's rather than ours: this event's only honoured
// output is `modifiedPrompt`, and only for SDK hooks, not for a config-file
// command hook like this one. So a prompt cannot be stopped here. What this does
// is scan and record it, which means the finding exists, is signed, and is in the
// console — and the tool call it leads to is still gated by clevr-copilot-gate.
// Saying that plainly is the point: a hook that cannot block must not be sold as
// one that can.
import { readFileSync } from 'node:fs';
import { loadConfig, postPrompt, promptBody, typedSkillsIn, gateSkillLoads } from './clevr-common.mjs';

const done = () => process.exit(0);

async function main () {
  let hook = {};
  try { hook = JSON.parse(readFileSync(0, 'utf8')); } catch { done(); }

  const cfg = loadConfig();
  if (!cfg.apiKey) done();

  const { prompt = '', sessionId, cwd } = hook;
  // A skill typed as /name is handed to the model with the prompt. This hook
  // cannot stop a prompt, so the load is recorded (the inventory, the version)
  // and the person is told when Clevr would have stopped it.
  const typed = typedSkillsIn(prompt, cwd, { harness: 'github-copilot' });
  if (typed.length) {
    const flagged = await gateSkillLoads(cfg, typed, { sessionId: sessionId || null, cwd: cwd || null, via: 'typed', recordOnly: true });
    if (flagged) process.stderr.write(`[clevr] ${flagged.message}\n[clevr] Copilot CLI gives a command hook no way to stop a prompt, so the skill was recorded, not blocked.\n`);
  }
  if (cfg.sensitive) done();
  if (!String(prompt).trim()) done();

  const res = await postPrompt(cfg, promptBody(cfg, {
    prompt, sessionId: sessionId || null, cwd: cwd || null, source: 'github-copilot',
  }));
  // This workspace records prompts without gating them: the verdict could not
  // have refused anything, so the turn goes back without waiting for it.
  if (res.ungated) {
    if (!res.sent) process.stderr.write('[clevr] engine unreachable; this workspace records prompts without gating them, so the prompt proceeds unrecorded.\n');
    done();
  }
  if (res.inactive || res.failopen || res.failclosed) done();

  const v = res.verdict || {};
  if (!['block', 'escalate', 'step_up'].includes(v.effect)) done();
  const tag = v.decision_id ? ` [${v.decision_id}]` : '';
  // stderr is the only channel back to the operator here, and it does not stop
  // the turn. Word it as what it is: a recorded finding, not a refusal.
  process.stderr.write(
    `[clevr] This prompt was flagged: ${v.reason || 'content policy'}${tag}\n` +
    '[clevr] Copilot CLI gives a command hook no way to stop a prompt, so it was recorded, not blocked. ' +
    'Any tool call it leads to is still gated.\n'
  );
  done();
}

main().catch(() => process.exit(0));
