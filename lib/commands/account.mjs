// login / logout / status / config
import { existsSync } from 'node:fs';
import * as cfgs from '../config.mjs';
import { health, signIn, whoAmI, signOut, brain, v1, rows } from '../api.mjs';
import { TARGETS } from '../targets.mjs';
import { c, ok, fail, warn, hint, info, head, die, ask, confirm, table, banner } from '../ui.mjs';

export async function login (args) {
  const stored = cfgs.load();
  const url = cfgs.trimSlash(args.url || process.env.CLEVR_URL || stored.url);
  if (!url) die('Which engine? clevr login --url https://clevr.your-company.com');

  const h = await health(url);
  if (!h.ok) die('Engine unreachable at ' + url + (h.error ? ' (' + h.error + ')' : ''));
  ok('Engine reachable at ' + url);

  const next = { ...stored, url };
  if (args.gateway) next.gateway = cfgs.trimSlash(args.gateway);

  // An account gives the governance commands; a key gives the runtime wiring.
  // Most people want both, so offer to mint the key once signed in.
  if (args.email || (!args.key && !stored.key)) await signInto(next, url, args);
  if (args.key) next.key = args.key;
  if (!next.key && next.session && next.role === 'admin') await offerKey(next);

  if (next.key) {
    const probe = await v1(next, '/decisions?limit=1');
    if (probe.status === 401 || probe.status === 403) fail('The stored agent key is rejected by the engine.');
    else ok('Agent key accepted');
  } else {
    warn('No agent key. `clevr setup` needs one: rerun login as an admin, or pass --key clevr_sk_...');
  }

  cfgs.save(next);
  ok('Saved to ' + cfgs.FILE);
  hint('Next:  clevr onboard        find your AI tools and wire them');
}

async function signInto (next, url, args) {
  const email = args.email || await ask('Email: ');
  const password = await ask('Password: ', { silent: true });
  const r = await signIn(url, email, password);
  if (!r.ok) die('Sign-in refused: ' + (r.error || r.status));
  next.session = r.body.session_token;
  next.email = r.body.user.email;
  next.role = r.body.user.role;
  next.org = r.body.org?.name;
  ok('Signed in as ' + r.body.user.email + ' (' + r.body.user.role + ') in ' + (r.body.org?.name || 'your workspace'));
  if (r.body.user.must_change_password) warn('This account must change its password in the console before it can do much.');
}

async function offerKey (next) {
  if (!(await confirm('No agent key stored. Mint one for this machine?'))) return;
  const label = (await ask('Name it [this laptop]: ')) || 'this laptop';
  const r = await brain(next, '/keys', { method: 'POST', json: { label } });
  if (r.ok && r.body?.key) { next.key = r.body.key; ok('Key created and stored (shown once, here only).'); }
  else fail('Could not create a key: ' + (r.error || r.status));
}

export async function logout () {
  const cfg = cfgs.load();
  if (cfg.session) await signOut(cfg);
  cfgs.save({ url: cfg.url, gateway: cfg.gateway });
  ok('Signed out. The engine URL is kept; the session and key are gone.');
  hint('The tools you wired still hold their own copy of the key. `clevr uninstall --all` removes those.');
}

export async function status () {
  const cfg = cfgs.load();
  banner();
  if (!cfg.url) { warn('Not connected. Run: clevr login --url <engine>'); return; }

  info(c.dim('engine   ') + cfg.url);
  if (cfg.gateway) info(c.dim('gateway  ') + cfg.gateway);
  const h = await health(cfg.url);
  info(c.dim('reach    ') + (h.ok ? c.green('up') : c.red('unreachable')));

  if (cfg.session) {
    const me = await whoAmI(cfg);
    info(c.dim('account  ') + (me.ok ? cfg.email + ' (' + me.body.user.role + ') in ' + me.body.org.name : c.red('session expired')));
  } else info(c.dim('account  ') + c.dim('none, governance commands unavailable'));

  if (cfg.key) {
    const probe = await v1(cfg, '/decisions?limit=1');
    info(c.dim('key      ') + (probe.status === 401 || probe.status === 403 ? c.red('rejected') : c.green('accepted')));
  } else info(c.dim('key      ') + c.dim('none, setup unavailable'));

  const wired = TARGETS.filter((t) => t.check(cfg)[0]?.state === 'ok');
  info(c.dim('wired    ') + (wired.length ? wired.map((t) => t.id).join(', ') : c.dim('nothing yet')));

  if (cfg.key) {
    const d = await v1(cfg, '/decisions?limit=200');
    const list = rows(d.body, 'decisions');
    const n = (e) => list.filter((r) => String(r.effect) === e).length;
    info(c.dim('traffic  ') + (list.length
      ? list.length + ' recent decisions: ' + c.green(n('allow') + ' allow') + ', ' + c.yellow((n('escalate') + n('step_up')) + ' hold') + ', ' + c.red(n('block') + ' block')
      : c.dim('none yet')));
  }
  console.log('');
}

export async function config (args, rest) {
  const cfg = cfgs.load();
  const [op, field, value] = rest;
  if (!op || op === 'show') {
    head('Configuration  ' + c.dim(cfgs.FILE));
    table(Object.entries({ engine: cfg.url, gateway: cfg.gateway, account: cfg.email, role: cfg.role, workspace: cfg.org, key: cfg.key ? cfg.key.slice(0, 16) + '…' : null, session: cfg.session ? 'stored' : null })
      .map(([k, v]) => ({ k, v: v || '(unset)' })), [
      { label: 'setting', get: (r) => r.k, max: 12 },
      { label: 'value', get: (r) => r.v, max: 60, color: (s) => (s.trim() === '(unset)' ? c.dim(s) : s) },
    ]);
    hint('env.sh    ' + (existsSync(cfgs.ENV_SH) ? cfgs.ENV_SH : 'not written yet'));
    hint('shell rc  ' + (cfgs.rcHasLine() ? 'sources it' : 'does not source it'));
    console.log('');
    return;
  }
  if (op !== 'set' || !field) die('Usage: clevr config show  |  clevr config set <engine|gateway> <url>');
  const key = { engine: 'url', url: 'url', gateway: 'gateway' }[field];
  if (!key) die('Settable: engine, gateway');
  cfgs.patch({ [key]: cfgs.trimSlash(value) });
  ok(field + ' set to ' + value);
}
