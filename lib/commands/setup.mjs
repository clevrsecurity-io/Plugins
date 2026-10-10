// setup / uninstall / doctor / onboard
import { existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import * as cfgs from '../config.mjs';
import { health, v1, whoAmI, rows, needEngine } from '../api.mjs';
import { TARGETS, byId, FOR_DETECTED, looksInstalled, appendRc, stripRc } from '../targets.mjs';
import { c, ok, fail, warn, hint, info, head, skip, die, confirm, table, banner } from '../ui.mjs';
import { scan } from './discover.mjs';

const SHOW = { ok, note: warn, fail, hint };

function listTargets () {
  head('clevr setup <tool> [<tool>...]');
  table(TARGETS, [
    { label: 'tool', get: (t) => t.id, max: 20 },
    { label: 'gate', get: (t) => t.mode, max: 8, color: (s) => (s.trim() === 'hook' ? c.green(s) : s.trim() === 'exec' ? c.yellow(s) : c.dim(s)) },
    { label: 'what it can stop', get: (t) => t.limit, max: 86, color: c.dim },
  ]);
  hint('\nhook = the verdict returns before the tool runs.  mcp = MCP tools only.');
  hint('gateway = the model conversation, not the local tool call.  exec = records, cannot deny inline.\n');
}

export async function setup (args, rest) {
  if (!rest.length && !args.all) return listTargets();
  const cfg = needEngine(cfgs.load());
  if (args.all) rest = TARGETS.filter((t) => looksInstalled(t.id) && !t.needsGateway).map((t) => t.id);
  if (!rest.length) return listTargets();

  const unknown = rest.filter((id) => !byId(id));
  if (unknown.length) die('Unknown tool: ' + unknown.join(', ') + '. Run `clevr setup` for the list.');

  head('Wiring ' + rest.join(', ') + ' to ' + cfg.url);
  for (const id of rest) {
    const t = byId(id);
    console.log(c.bold(t.label) + '  ' + c.dim(t.mechanism));
    for (const r of t.install(cfg)) (SHOW[r.level] || info)(r.msg);
    console.log('');
  }

  const envFile = cfgs.writeEnvFile(cfg);
  ok('Environment written to ' + envFile);
  if (!cfgs.rcHasLine()) {
    const rcs = cfgs.rcFiles();
    if (!rcs.length) hint('Add this to your shell profile:  ' + cfgs.RC_LINE);
    else if (args.yes || await confirm('Source it from ' + rcs[0] + '?')) {
      appendRc(rcs[0], cfgs.RC_LINE); ok('Added to ' + rcs[0] + '. Open a new terminal, or run: source ' + envFile);
    } else hint('Add it yourself when you are ready:  ' + cfgs.RC_LINE);
  }

  console.log('');
  info('A new agent starts in Observe: every action is evaluated, recorded and signed,');
  info('and only the safety floor blocks, until you promote it in the console.');
  hint('Check it:  clevr doctor');
}

export async function uninstall (args, rest) {
  const cfg = cfgs.load();
  const ids = args.all ? TARGETS.map((t) => t.id) : rest;
  if (!ids.length) die('Usage: clevr uninstall <tool>...  |  clevr uninstall --all');
  if (args.all && !args.yes && !(await confirm('Remove every Clevr hook, guard and provider this CLI installed?'))) return;

  head('Removing');
  for (const id of ids) {
    const t = byId(id);
    if (!t) { fail('Unknown tool: ' + id); continue; }
    console.log(c.bold(t.label));
    for (const r of t.uninstall()) (SHOW[r.level] || info)(r.msg);
    console.log('');
  }

  if (args.all) {
    for (const rc of cfgs.rcFiles()) if (stripRc(rc)) ok('Removed the Clevr line from ' + rc);
    rmSync(cfgs.ENV_SH, { force: true });
    rmSync(join(cfgs.DIR, 'tools'), { recursive: true, force: true });
    ok('Removed ' + cfgs.ENV_SH + ' and the installed scripts.');
    hint('Your config and session are kept. `clevr logout` clears those.');
  }
  if (cfg.key) hint('Nothing was revoked on the engine. Revoke the key too:  clevr keys list');
}

// One tool's report. Returns true when the wiring is incomplete, so doctor can
// exit non-zero on a half-installed gate rather than quietly looking fine.
function reportTarget (t, cfg, fix = false) {
  let res = t.check(cfg);
  // The first check is the decisive one; the rest qualify it.
  let wired = res[0]?.state === 'ok';
  // --fix repairs what this CLI itself installed: a hook whose script went
  // missing, a host config edited by hand, an env file that was never written.
  // It deliberately does NOT wire a tool that was never wired — turning on
  // enforcement for a tool nobody chose is not a repair, it is a surprise.
  if (fix && wired && res.some((x) => x.state === 'miss')) {
    for (const r of t.install(cfg)) (SHOW[r.level] || info)(r.msg);
    res = t.check(cfg);
    wired = res[0]?.state === 'ok';
  }
  const nudge = looksInstalled(t.id) && (!t.needsGateway || cfg.gateway);
  if (!wired) {
    if (nudge) warn(t.label + ' \u00b7 present on this machine, not wired  ' + c.dim('clevr setup ' + t.id));
    else skip(t.label + ' \u00b7 not wired');
    return false;
  }
  const partial = res.some((x) => x.state === 'miss');
  console.log((partial ? c.yellow(' part ') : c.green('  ok  ')) + c.bold(t.label) + '  ' + c.dim(t.mode));
  const MARKS = { ok: c.green('\u2713'), miss: c.red('\u2717'), warn: c.yellow('!'), info: c.dim('\u00b7') };
  for (const x of res) console.log('        ' + (MARKS[x.state] || ' ') + ' ' + x.name.padEnd(14) + c.dim(x.detail || ''));
  if (t.limit) console.log('        ' + c.dim(t.limit));
  return partial;
}

async function checkEngine (cfg) {
  let bad = 0;
  const h = await health(cfg.url);
  if (h.ok) ok('Engine reachable at ' + cfg.url);
  else { bad++; fail('Engine unreachable at ' + cfg.url + (h.error ? ' (' + h.error + ')' : '')); }

  if (!cfg.key) { bad++; fail('No agent key stored. `clevr setup` cannot wire anything: clevr login'); }
  else {
    const probe = await v1(cfg, '/decisions?limit=1');
    if (probe.status === 401 || probe.status === 403) { bad++; fail('Agent key rejected. It may have been revoked or expired: clevr login --key ...'); }
    else ok('Agent key accepted');
  }

  if (cfg.session) {
    const me = await whoAmI(cfg);
    if (me.ok) ok('Signed in as ' + cfg.email + ' (' + me.body.user.role + ')');
    else warn('Console session expired. Governance commands will ask you to sign in again.');
  }
  return bad;
}

export async function doctor (args = {}) {
  const cfg = cfgs.load();
  const fix = !!args.fix;
  head(fix ? 'Clevr doctor · repairing' : 'Clevr doctor');
  if (!cfg.url) { fail('Not connected. Run: clevr login --url <engine>'); process.exit(1); }

  let bad = await checkEngine(cfg);

  console.log('');
  for (const t of TARGETS) if (reportTarget(t, cfg, fix)) bad++;

  console.log('');
  if (fix && !existsSync(cfgs.ENV_SH) && cfg.key) ok('Environment rewritten to ' + cfgs.writeEnvFile(cfg));
  if (cfgs.rcHasLine()) ok('Your shell sources ~/.clevr/env.sh');
  else warn('Your shell does not source ~/.clevr/env.sh, so a tool launched from it has no key.');
  if (!existsSync(cfgs.ENV_SH)) warn('~/.clevr/env.sh not written yet. It appears on the first `clevr setup`.');

  if (cfg.key) {
    const d = await v1(cfg, '/decisions?limit=5');
    if (rows(d.body, 'decisions').length) ok('The engine has recent decisions from this workspace: the gates are reporting.');
    else { bad++; fail('No decisions recorded yet. Run one tool call in a wired tool, then check again.'); }
  }

  console.log('');
  if (bad && !fix) hint('Repair what this CLI installed:  clevr doctor --fix');
  process.exit(bad ? 1 : 0);
}

export async function onboard (args) {
  const cfg = needEngine(cfgs.load());
  banner();
  head('Onboarding this machine');

  const report = await scan();
  const found = (report?.clients || []).map((x) => x.id);
  if (!found.length) {
    warn('No known AI client is running right now.');
    hint('Discovery reads running processes, so start your tools first, or wire one by name: clevr setup claude-code');
  } else ok('Running: ' + found.join(', '));

  const targets = [...new Set(found.flatMap((id) => FOR_DETECTED[id] || []))].filter((id) => byId(id));
  const alsoInstalled = TARGETS.filter((t) => !t.needsGateway && looksInstalled(t.id)).map((t) => t.id);
  const wire = [...new Set([...targets, ...alsoInstalled])];

  if (!wire.length) { warn('Nothing on this machine that this CLI can wire.'); return; }
  info('Will wire: ' + wire.join(', '));
  if (!args.yes && !(await confirm('Go ahead?'))) return;

  await setup({ yes: args.yes }, wire);
  if (report && cfg.key) {
    const r = await v1(cfg, '/endpoints', { method: 'POST', json: report }).catch(() => null);
    if (r?.ok) ok('Posture reported to the console.');
  }
  console.log('');
  hint('Then:  clevr doctor');
}
