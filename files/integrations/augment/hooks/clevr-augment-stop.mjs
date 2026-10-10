#!/usr/bin/env node
// clevr-augment-stop.mjs — Augment CLI Stop hook.
//
// Augment has no prompt event: there is nowhere to stand between the user typing
// and the model reading. What it does have is Stop, which fires at the end of a
// turn and carries the `conversation`. So the chat is governed one turn late.
//
// That is a real difference from Claude Code and it is stated rather than
// papered over: a secret pasted into an Augment prompt is RECORDED, not stopped.
// What it still buys is the finding, signed and in the console, and the fact that
// any tool call the turn produced was gated on its way through.
import { readFileSync } from 'node:fs';
import { trunc, loadConfig, postEvaluate, promptBody } from './clevr-common.mjs';

const done = () => process.exit(0);

// Normalise Augment's turns into the role/content shape the engine reads.
function turnsOf (conv) {
  if (!Array.isArray(conv)) return [];
  return conv.map((m) => {
    const role = String(m?.role || '').toLowerCase();
    const content = typeof m?.content === 'string' ? m.content
      : Array.isArray(m?.content) ? m.content.map((c) => c?.text || '').join('\n') : '';
    return { role: role === 'model' ? 'assistant' : role, content: trunc(content, 4000) };
  }).filter((m) => m.role && m.content);
}

async function main () {
  let hook = {};
  try { hook = JSON.parse(readFileSync(0, 'utf8')); } catch { done(); }

  const cfg = loadConfig();
  if (!cfg.apiKey || cfg.sensitive) done();

  const turns = turnsOf(hook.conversation);
  // Only the latest user turn is the subject. Earlier ones were governed when
  // their own turn ended; re-sending them would resurface old findings as new.
  let lastUser = null;
  for (const t of turns) if (t.role === 'user') lastUser = t;
  if (!lastUser) done();

  const history = turns.slice(0, turns.lastIndexOf(lastUser));
  const res = await postEvaluate(cfg, promptBody(cfg, {
    prompt: lastUser.content,
    history,
    sessionId: hook.conversation_id || null,
    cwd: Array.isArray(hook.workspace_roots) ? hook.workspace_roots[0] : null,
    source: 'augment',
  }));
  if (res.inactive || res.failopen || res.failclosed) done();

  const v = res.verdict || {};
  if (!['block', 'escalate', 'step_up'].includes(v.effect)) done();
  const tag = v.decision_id ? ` [${v.decision_id}]` : '';
  // Stop's `decision: "block"` makes the agent keep going with a reason, which
  // is not what we want for a turn that already finished. Report instead.
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: { hookEventName: 'Stop' },
    systemMessage: `Clevr flagged this turn: ${v.reason || 'content policy'}${tag}`,
  }));
  process.exit(0);
}

main().catch(() => process.exit(0));
