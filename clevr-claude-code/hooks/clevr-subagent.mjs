#!/usr/bin/env node
// clevr-subagent.mjs — Claude Code SubagentStart hook.
//
// Records a sub-agent SPAWN as a signed decision, so the audit lineage shows the
// delegation EDGE (main agent -> sub-agent) with the sub-agent's task — matching
// the per-sub-agent attribution the PreToolUse gate adds via agent_id. Together
// they reconstruct the full delegation tree from the hook alone.
//
// The sub-agent identity is the harness's INTERNAL handle (agent_id), tagged
// identity:'asserted' — it is NOT an identity issued by an IdP and is never
// presented as verified. Record-only: a spawn is not gated here (the sub-agent's
// actual tool calls are gated by clevr-gate.mjs when they run).
//
// If Claude Code doesn't emit SubagentStart in your version, this hook simply
// never fires — the PreToolUse agent_id path still branches the lineage.

import { readFileSync } from 'node:fs';
import { trunc, loadConfig, postEvaluate } from './clevr-common.mjs';

async function main () {
  let hook = {};
  try { hook = JSON.parse(readFileSync(0, 'utf8')); } catch { process.exit(0); }

  const cfg = loadConfig();
  if (!cfg.apiKey) process.exit(0);

  const { agent_id, agent_type, task, session_id } = hook;
  const subName = agent_type || 'subagent';

  const body = {
    agent: cfg.agent,
    tool: 'subagent_spawn',
    action_type: 'delegate',
    action: `spawn ${subName}`,
    target: subName,
    environment: cfg.env,
    session_id: session_id || null,
    actor_chain: [
      { type: 'agent', id: cfg.agent, display: cfg.agent },
      { type: 'agent', id: subName, display: subName, on_behalf_of: cfg.agent, harness_agent_id: agent_id || null, identity: 'asserted' },
    ],
    metadata: { source: 'claude-code', event: 'subagent_start', agent_id: agent_id || null, agent_type: agent_type || null, task: trunc(task || '', 300) },
  };
  // The sub-agent's instruction becomes the session goal for the lineage.
  if (task) body.session_goal = trunc(task, 300);

  await postEvaluate(cfg, body).catch(() => {});
  process.exit(0);
}

main().catch(() => process.exit(0));
