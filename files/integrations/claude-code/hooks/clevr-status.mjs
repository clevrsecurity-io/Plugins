#!/usr/bin/env node
// clevr-status.mjs — what /clevr-gate:status shows.
//
// One screen that answers the question a person has before they trust a
// session: is this governed, by which engine, in which mode, and what did it
// last decide. Four reads, all one-shot, none of them changing anything:
// the engine's health, the workspace posture, this agent's record, and its
// latest decision. Anything unreachable is said as such on its own line rather
// than turning the whole screen into an error.
//
// The output is plain text the model is told to repeat verbatim, so it has to
// read well in a code block: aligned labels, one fact per line, no colour.

import { loadConfig, httpGetJson } from './clevr-common.mjs';

const cfg = loadConfig();
const line = (k, v) => `  ${k.padEnd(10)} ${v}`;
const out = [];
const H = { Authorization: `Bearer ${cfg.apiKey}` };
const get = async (path) => {
  try { return await httpGetJson(`${cfg.base}${path}`, { headers: H, timeoutMs: cfg.timeoutMs || 3000 }); } catch (e) { return { status: 0, error: e.message }; }
};
const MODE = { enforce: 'Enforce', observe: 'Observe', strict: 'Strict', inherit: 'Inherit' };
const when = (iso) => { try { return new Date(iso).toISOString().replace('T', ' ').slice(0, 16) + ' UTC'; } catch { return String(iso || ''); } };
const short = (s, n = 60) => { s = String(s || ''); return s.length > n ? s.slice(0, n - 1) + '…' : s; };

out.push('Clevr Gate · status');
if (!cfg.apiKey) {
  out.push(line('gate', 'installed, not connected'));
  out.push(line('to fix', 'export CLEVR_API_KEY=clevr_sk_...  and  CLEVR_URL=https://your-engine'));
  out.push(line('until then', 'every action is allowed and nothing is recorded'));
  console.log(out.join('\n'));
  process.exit(0);
}

const [health, posture, agent] = await Promise.all([get('/v1/health'), get('/v1/failsafe'), get(`/v1/agents/${encodeURIComponent(cfg.agent)}`)]);

if (health.status >= 200 && health.status < 300) out.push(line('engine', `${cfg.base}   reachable${health.body?.version ? ', v' + health.body.version : ''}`));
else out.push(line('engine', `${cfg.base}   unreachable (${health.error || (health.status ? 'HTTP ' + health.status : 'no response')})`));

if (posture.status === 401 || posture.status === 403) out.push(line('key', 'rejected: revoked or from another engine'));
else if (posture.status >= 200 && posture.status < 300) out.push(line('key', 'accepted'));
else out.push(line('key', 'not checked (engine unreachable)'));

if (agent.status >= 200 && agent.status < 300 && agent.body) {
  const a = agent.body;
  const eff = a.effective_enforcement || {};
  const mode = MODE[eff.mode || a.enforcement_mode] || eff.mode || a.enforcement_mode || 'Observe';
  const from = eff.source === 'agent' ? 'set on the agent' : eff.source === 'unit' ? 'inherited from its unit' : eff.source === 'tenant' ? 'workspace default' : null;
  const bits = [`${mode}${from ? ' (' + from + ')' : ''}`];
  if (a.lifecycle_state && a.lifecycle_state !== 'active') bits.push(a.lifecycle_state);
  if (a.trust_tier) bits.push('trust ' + a.trust_tier);
  if (a.role_name || a.role) bits.push('mandate ' + (a.role_name || a.role)); else if (a.role_id) bits.push('mandate ' + a.role_id); else bits.push('no mandate: the floor alone decides');
  out.push(line('agent', `${cfg.agent}   ${bits.join(' · ')}`));
} else if (agent.status === 404) {
  out.push(line('agent', `${cfg.agent}   not seen by this engine yet: it appears after its first action, in Observe`));
} else {
  out.push(line('agent', `${cfg.agent}   record unavailable`));
}

if (posture.status >= 200 && posture.status < 300 && posture.body) {
  const p = posture.body;
  const fs = p.failsafe_action === 'closed' ? 'fail-closed: refuse when the engine is unreachable' : 'fail-open: allow when the engine is unreachable';
  out.push(line('offline', `${fs} (workspace)`));
  if (p.gate_prompts === false) out.push(line('prompts', 'recorded, not gated (workspace)'));
}

// The latest decision for this agent, by its id when the record gave one.
const agentId = agent.body?.id || cfg.agent;
const last = await get(`/v1/decisions?limit=1&agent_id=${encodeURIComponent(agentId)}`);
const rows = Array.isArray(last.body) ? last.body : (last.body?.decisions || last.body?.items || []);
if (rows.length) {
  const d = rows[0];
  const eff = { allow: 'Allow', escalate: 'Hold', step_up: 'Hold', block: 'Block' }[d.effect] || d.effect;
  // A decision with no tool (an expiry, a prompt) carries its story in the
  // action text; showing the reason again would print it twice.
  const what = [d.tool, d.action].filter(Boolean).join(' ');
  const reason = d.reason && !String(d.reason).startsWith(String(d.action || '').slice(0, 24)) && !String(d.action || '').startsWith(String(d.reason).slice(0, 24)) ? d.reason : '';
  out.push(line('last', `${when(d.created_at)}  ${eff}  ${short(what, 50)}${reason ? '  ' + short(reason, 70) : ''}`));
} else if (last.status >= 200 && last.status < 300) {
  out.push(line('last', 'no decision recorded for this agent yet'));
}

out.push(line('session', [
  cfg.sensitive ? 'sensitive mode on: shapes only, no content leaves this machine' : (cfg.forwardCtx ? `context forwarded (${cfg.contextTurns} turns)` : 'context not forwarded'),
  `hold = ${cfg.escalate === 'allow' ? 'let through, recorded' : 'deny'}`,
].join(' · ')));
console.log(out.join('\n'));
