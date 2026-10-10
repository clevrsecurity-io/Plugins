// policy / mandate / agents / people / keys / floor / packs / tools
//
// Reads take whichever door is open: /v1 with the agent key, /brain/api with a
// console session. Writes only ever go through /brain/api, because the runtime
// allowlist forbids config writes on /v1 by design.
import * as cfgs from '../config.mjs';
import { brain, v1, rows, needConsole } from '../api.mjs';
import { c, ok, fail, warn, hint, info, head, die, confirm, table, verdictName, verdictColor } from '../ui.mjs';

async function read (path, { v1path } = {}) {
  const cfg = cfgs.load();
  if (cfg.session) {
    const r = await brain(cfg, path);
    if (r.ok) return r.body;
    if (r.status !== 401) die('Engine said ' + r.status + ': ' + (r.error || ''));
  }
  if (cfg.key && v1path) {
    const r = await v1(cfg, v1path);
    if (r.ok) return r.body;
  }
  die('This needs an account. Run: clevr login --url ' + (cfg.url || '<engine>') + ' --email you@company.com');
}

const scopeOf = (p) => (p.scope_agent_name || p.scope_agent_id ? 'agent ' + (p.scope_agent_name || p.scope_agent_id) : p.scope_unit_id ? 'unit' : 'everywhere');

export async function policy (args, rest) {
  const [op = 'list', id] = rest;

  // "Which rules actually reach this agent" is the question before every change,
  // and the list alone cannot answer it: scoping is invisible until a decision
  // proves it. The engine answers with the same scope clause it decides with.
  if (op === 'effective') {
    const who = args.agent || id;
    if (!who) die('Usage: clevr policy effective --agent <name>');
    const d = await read('/policies/effective?agent=' + encodeURIComponent(who), { v1path: null });
    head('Policies reaching ' + d.agent);
    if (!d.applies.length) warn('No policy reaches this agent. Only the mandate and the safety floor decide.');
    else table(d.applies, [
      { label: 'name', get: (p) => p.name, max: 46 },
      { label: 'source', get: (p) => (p.source_type === 'pack' ? 'library' : p.source_type || 'yours'), max: 10, color: c.dim },
      { label: 'priority', get: (p) => String(p.priority ?? ''), max: 8, color: c.dim },
    ]);
    console.log('');
    // The excluded ones are the more useful half: a rule an operator believes is
    // protecting this agent and is not, is worse than no rule.
    if (d.excluded.length) {
      const by = {};
      for (const e of d.excluded) (by[e.excluded_because] ||= []).push(e.name);
      info(c.dim(d.counts.excluded + ' of ' + d.counts.total + ' do NOT reach it:'));
      for (const [reason, names] of Object.entries(by)) {
        console.log('      ' + String(names.length).padStart(4) + '  ' + reason);
        if (args.verbose) for (const n of names.slice(0, 20)) console.log('            ' + c.dim(n));
      }
      console.log('');
      hint('Add --verbose to name them.');
    }
    return;
  }

  if (op === 'list') {
    const body = await read('/policies', { v1path: '/policies' });
    const list = rows(body, 'policies');
    head('Policies  ' + c.dim(list.length + ' total'));
    table(list, [
      { label: 'name', get: (p) => p.name, max: 40 },
      { label: 'verdict', get: (p) => verdictName(p.effect_kind || p.effect), max: 9, color: (s) => verdictColor(s)(s) },
      { label: 'scope', get: scopeOf, max: 22, color: c.dim },
      { label: 'status', get: (p) => p.status || '', max: 9 },
      { label: 'source', get: (p) => (p.source_type === 'pack' ? 'library' : p.source_type || 'yours'), max: 10, color: c.dim },
      { label: 'id', get: (p) => p.id, max: 24, color: c.dim },
    ]);
    console.log('');
    return;
  }
  if (op === 'get') {
    if (!id) die('Usage: clevr policy get <id>');
    const p = await read('/policies/' + encodeURIComponent(id), { v1path: '/policies/' + encodeURIComponent(id) });
    console.log(JSON.stringify(p, null, 2));
    return;
  }
  if (op === 'delete') {
    if (!id) die('Usage: clevr policy delete <id>');
    const cfg = await needConsole(cfgs.load());
    if (!args.yes && !(await confirm('Delete policy ' + id + '? This is recorded in the signed change log.'))) return;
    const r = await brain(cfg, '/policies/' + encodeURIComponent(id), { method: 'DELETE' });
    r.ok ? ok('Deleted. The change log keeps the history.') : fail('Refused: ' + (r.error || r.status));
    return;
  }
  if (op === 'impact') {
    const q = new URLSearchParams(Object.entries(args).filter(([k]) => ['tool', 'agent', 'effect'].includes(k)).map(([k, v]) => [k, String(v)]));
    const body = await read('/policies/impact?' + q, { v1path: '/policies/impact?' + q });
    console.log(JSON.stringify(body, null, 2));
    return;
  }
  die('Usage: clevr policy list | get <id> | delete <id> | impact --tool <name>');
}

export async function mandate (args, rest) {
  const [op = 'list', id] = rest;
  if (op === 'list') {
    const list = rows(await read('/roles'), 'roles');
    head('Mandates  ' + c.dim(list.length + ' total'));
    table(list, [
      { label: 'name', get: (r) => r.name, max: 30 },
      { label: 'agents', get: (r) => r.agent_count ?? 0, max: 7 },
      { label: 'allows', get: (r) => (r.allowed_tools || []).length, max: 7 },
      { label: 'refuses', get: (r) => (r.forbidden_tools || []).length, max: 8, color: (s) => (s.trim() === '0' ? c.dim(s) : c.red(s)) },
      { label: 'source', get: (r) => (r.source === 'pack' ? (r.pack_edited ? 'pack, edited' : 'pack') : 'yours'), max: 14, color: c.dim },
      { label: 'id', get: (r) => r.id, max: 24, color: c.dim },
    ]);
    console.log('');
    return;
  }
  if (op === 'get') {
    if (!id) die('Usage: clevr mandate get <id>');
    const m = rows(await read('/roles'), 'roles').find((r) => r.id === id || r.name === id);
    if (!m) die('No mandate ' + id);
    head(m.name);
    info(m.description || '');
    console.log('');
    console.log(c.bold('Can use'));
    for (const t of m.allowed_tools || []) console.log('  ' + c.green('+') + ' ' + t);
    if ((m.forbidden_tools || []).length) {
      console.log('\n' + c.bold('Never'));
      for (const t of m.forbidden_tools) console.log('  ' + c.red('-') + ' ' + t);
    }
    console.log('');
    hint('Everything it does not name falls to the safety floor.');
    return;
  }
  if (op === 'packs') {
    const list = rows(await read('/mandate-packs'), 'packs');
    head('Mandate packs');
    table(list, [
      { label: 'pack', get: (p) => p.id, max: 20 },
      { label: 'name', get: (p) => p.name, max: 22 },
      { label: 'state', get: (p) => (p.installed ? (p.edited ? 'installed, edited' : 'installed') : 'available'), max: 17, color: (s) => (s.trim().startsWith('installed') ? c.green(s) : c.dim(s)) },
      { label: 'allows', get: (p) => (p.allowed_tools || []).length, max: 7 },
      { label: 'what it is for', get: (p) => (p.description || '').split('.')[0], max: 62, color: c.dim },
    ]);
    console.log('');
    hint('Install one:  clevr mandate install <pack-id>');
    return;
  }
  if (op === 'install') {
    if (!id) die('Usage: clevr mandate install <pack-id>');
    const cfg = await needConsole(cfgs.load());
    const r = await brain(cfg, '/mandate-packs/' + encodeURIComponent(id) + '/activate', { method: 'POST' });
    r.ok ? ok('Installed as an editable mandate. It appears under Policies > Mandates.') : fail('Refused: ' + (r.error || r.status));
    return;
  }
  die('Usage: clevr mandate list | get <id> | packs | install <pack-id>');
}

export async function agents (args, rest) {
  const [op = 'list', id] = rest;
  if (op === 'list') {
    const list = rows(await read('/agents', { v1path: '/agents' }), 'agents');
    head('Agents  ' + c.dim(list.length + ' total'));
    table(list, [
      { label: 'name', get: (a) => a.name, max: 28 },
      { label: 'posture', get: (a) => a.enforcement_mode || 'inherit', max: 9, color: (s) => (s.trim() === 'observe' ? c.yellow(s) : s.trim() === 'enforce' || s.trim() === 'strict' ? c.green(s) : c.dim(s)) },
      { label: 'mandate', get: (a) => (a.role_id ? 'bound' : 'floor only'), max: 11, color: (s) => (s.trim() === 'bound' ? s : c.yellow(s)) },
      { label: '30d', get: (a) => a.total_requests ?? 0, max: 7 },
      { label: 'held', get: (a) => a.recent_escalations ?? 0, max: 6, color: (s) => (s.trim() === '0' ? c.dim(s) : c.yellow(s)) },
      { label: 'blocked', get: (a) => a.recent_blocks ?? 0, max: 8, color: (s) => (s.trim() === '0' ? c.dim(s) : c.red(s)) },
    ]);
    console.log('');
    const loose = list.filter((a) => !a.role_id);
    if (loose.length) hint(loose.length + ' agent(s) run on the safety floor alone. Bind a mandate in the console, or: clevr mandate packs');
    return;
  }
  if (op === 'get') {
    if (!id) die('Usage: clevr agents get <name|id>');
    const a = rows(await read('/agents', { v1path: '/agents' }), 'agents').find((x) => x.id === id || x.name === id);
    if (!a) die('No agent ' + id);
    console.log(JSON.stringify(a, null, 2));
    return;
  }
  die('Usage: clevr agents list | get <name>');
}

export async function people (args, rest) {
  const [op = 'list'] = rest;
  if (op !== 'list') die('Usage: clevr people list');
  const list = rows(await read('/users'), 'users');
  head('People  ' + c.dim(list.length + ' total'));
  table(list, [
    { label: 'email', get: (u) => u.email, max: 36 },
    { label: 'role', get: (u) => u.role, max: 10 },
    { label: 'unit', get: (u) => u.unit || '', max: 18, color: c.dim },
    { label: 'status', get: (u) => u.status, max: 10, color: (s) => (s.trim() === 'active' ? s : c.yellow(s)) },
    { label: 'source', get: (u) => u.source || 'local', max: 12, color: c.dim },
  ]);
  console.log('');
}

export async function keys (args, rest) {
  const [op = 'list', id] = rest;
  const cfg = await needConsole(cfgs.load());
  if (op === 'list') {
    const list = rows(await read('/keys'), 'keys');
    head('Agent keys  ' + c.dim(list.length + ' total'));
    table(list, [
      { label: 'name', get: (k) => k.label || '(unnamed)', max: 28 },
      { label: 'prefix', get: (k) => k.key_prefix, max: 20, color: c.dim },
      { label: 'agent', get: (k) => k.bound_agent_name || (k.bound_agent_id ? k.bound_agent_id : 'first to use it'), max: 24, color: c.dim },
      { label: 'state', get: (k) => (k.revoked ? 'revoked' : 'active'), max: 8, color: (s) => (s.trim() === 'revoked' ? c.red(s) : c.green(s)) },
      { label: 'last used', get: (k) => (k.last_used_at ? String(k.last_used_at).slice(0, 10) : 'never'), max: 11, color: c.dim },
      { label: 'id', get: (k) => k.id, max: 22, color: c.dim },
    ]);
    console.log('');
    return;
  }
  if (op === 'create') {
    const label = args.name || id || 'cli';
    const r = await brain(cfg, '/keys', { method: 'POST', json: { label, ...(args.agent ? { agent_id: args.agent } : {}), ...(args.days ? { ttl_days: Number(args.days) } : {}) } });
    if (!r.ok) return fail('Refused: ' + (r.error || r.status));
    ok('Created ' + label);
    console.log('\n  ' + c.bold(r.body.key) + '\n');
    warn('This is the only time the key is shown. Store it now.');
    if (args.use) { cfgs.patch({ key: r.body.key }); ok('Stored as this machine’s key.'); }
    return;
  }
  if (op === 'revoke') {
    if (!id) die('Usage: clevr keys revoke <key-id>');
    if (!args.yes && !(await confirm('Revoke ' + id + '? Anything using it stops being able to call the engine.'))) return;
    const r = await brain(cfg, '/keys/' + encodeURIComponent(id), { method: 'DELETE' });
    r.ok ? ok('Revoked. Its past decisions stay attributable.') : fail('Refused: ' + (r.error || r.status));
    return;
  }
  die('Usage: clevr keys list | create --name <name> [--agent <id>] [--days N] [--use] | revoke <id>');
}

export async function floor () {
  const f = await read('/safety-floor');
  const classes = f?.classes || f?.verb_classes || f;
  head('Safety floor');
  if (Array.isArray(classes)) {
    table(classes, [
      { label: 'class', get: (x) => x.id || x.name || x.class, max: 20 },
      { label: 'verdict', get: (x) => verdictName(x.effect || x.verdict), max: 10, color: (s) => verdictColor(s)(s) },
      { label: 'terms', get: (x) => (x.terms || x.verbs || []).slice(0, 6).join(', '), max: 64, color: c.dim },
    ]);
  } else console.log(JSON.stringify(f, null, 2));
  console.log('');
  hint('The floor runs before every rule you write and is edited in the console, never at runtime.');
}

export async function tools (args) {
  const body = await read('/observed-tools' + (args?.agent ? '?agent=' + encodeURIComponent(args.agent) : ''));
  // The route groups by connector; a flat list is what you build a mandate from.
  const list = rows(body, 'groups').flatMap((g) => (g.tools || []).map((t) => ({ ...t, connector: t.connector || g.connector })))
    .sort((a, b) => (b.count || 0) - (a.count || 0));
  head('Tools these agents have actually called  ' + c.dim(list.length + ' distinct'));
  table(list.slice(0, 60), [
    { label: 'tool', get: (t) => t.display || t.tool, max: 34 },
    { label: 'where', get: (t) => t.connector || '', max: 20, color: c.dim },
    { label: 'class', get: (t) => t.risk || '', max: 12, color: (s) => (s.trim() === 'destructive' ? c.red(s) : s.trim() === 'write' ? c.yellow(s) : c.dim(s)) },
    { label: 'calls', get: (t) => t.count ?? 0, max: 7 },
    { label: 'last seen', get: (t) => String(t.last_seen || '').slice(0, 10), max: 11, color: c.dim },
  ]);
  if (list.length > 60) hint((list.length - 60) + ' more.');
  console.log('');
  hint('This is what a mandate should be built from, not a guess at what the agent might need.');
}
