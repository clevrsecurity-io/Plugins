#!/usr/bin/env node
// clevr-expand.mjs: the Claude Code UserPromptExpansion hook.
//
// A person typing /name at the start of a message runs a skill or a command
// without the Skill tool, so the PreToolUse gate never sees it: Claude Code
// fires UserPromptExpansion on that path instead (code.claude.com/docs/en/hooks).
// This hook asks Clevr about that load exactly as the gate asks about one Claude
// decides on: governed as skill:<name>, with the version this machine holds, so
// a mandate, the workspace's posture and an approved version answer it the same
// way. A refusal or a hold stops the expansion and the person reads why. A
// prompt from an MCP server is not a skill and passes.
//
// Fails like the gate: an engine that cannot answer follows the workspace's
// fail policy, and an unconfigured install never blocks.

import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { loadConfig, describeSkill, gateSkillLoads, pluginProviding, effectiveFailsafe } from './clevr-common.mjs';

function pass () { process.exit(0); }
// UserPromptExpansion reads a top-level `decision: "block"`; the reason is shown
// to the person and the command does not expand.
function block (reason) {
  process.stdout.write(JSON.stringify({ decision: 'block', reason: reason || 'Blocked by Clevr.' }));
  process.exit(0);
}

// The name Clevr knows the skill by. A plugin's skill is plugin:name, as the
// Skill tool names it; a typed command from a plugin may arrive bare, so the
// plugin is found when exactly one installed plugin ships that name.
function skillName (hook) {
  const raw = String(hook.command_name || '').trim().replace(/^\//, '');
  if (!raw) return null;
  if (raw.includes(':') || !/plugin/i.test(String(hook.command_source || ''))) return raw;
  const plugin = pluginProviding(raw, homedir());
  return plugin ? `${plugin}:${raw}` : raw;
}

let cfg = null;   // module-scoped so the top-level catch can read the fail policy
async function main () {
  let hook = {};
  try { hook = JSON.parse(readFileSync(0, 'utf8')); } catch { pass(); }
  if (hook.expansion_type && hook.expansion_type !== 'slash_command') pass();

  cfg = loadConfig();
  if (!cfg.apiKey) pass();

  const name = skillName(hook);
  if (!name) pass();
  const load = { name, desc: describeSkill(name, hook.cwd, { sensitive: cfg.sensitive }) };
  const stop = await gateSkillLoads(cfg, [load], { sessionId: hook.session_id || null, cwd: hook.cwd || null, via: 'typed' });
  if (stop) block(stop.message);
  pass();
}

main().catch((e) => {
  const closed = effectiveFailsafe(cfg) === 'closed';
  process.stderr.write(`[clevr] command hook error: ${e.message}; ${closed ? 'blocking (fail-closed per policy)' : 'allowing (fail-open per policy)'}.\n`);
  if (closed) block(`Clevr could not check this command, and this workspace fails closed: ${e.message}`);
  pass();
});
