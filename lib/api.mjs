// Two doors onto the engine, and they are not interchangeable.
//
//   /v1/*          runtime. Bearer <agent key>. Evaluate, decisions, health.
//   /brain/api/*   management. Bearer <console session>. Policies, mandates,
//                  agents, people, keys. The runtime allowlist forbids config
//                  writes on /v1, so anything governing needs `clevr login`
//                  with an account, not just a key.
import { die } from './ui.mjs';
import { trimSlash } from './config.mjs';

const base = trimSlash;

async function call (url, path, token, opts = {}) {
  let r;
  try {
    r = await fetch(base(url) + path, {
      ...opts,
      headers: {
        'content-type': 'application/json',
        ...(token ? { authorization: 'Bearer ' + token } : {}),
        ...(opts.headers || {}),
      },
      body: opts.json ? JSON.stringify(opts.json) : opts.body,
    });
  } catch (e) {
    return { ok: false, status: 0, body: null, error: e.message };
  }
  const text = await r.text();
  let body;
  try { body = text ? JSON.parse(text) : null; } catch { body = text; }
  return { ok: r.ok, status: r.status, body, error: r.ok ? null : (body?.message || body?.error || r.statusText) };
}

export const health = (url) => call(url, '/v1/health', null);

export const v1 = (cfg, path, opts) => call(cfg.url, '/v1' + path, cfg.key, opts);

export const brain = (cfg, path, opts) => call(cfg.url, '/brain/api' + path, cfg.session, opts);

// Sign-in lives on /v1/auth (public routes), not under the session-guarded
// /brain/api tree — the guard is what it hands you the token for.
export const signIn = (url, email, password) =>
  call(url, '/v1/auth/login', null, { method: 'POST', json: { email, password } });

export const whoAmI = (cfg) => call(cfg.url, '/v1/auth/me', cfg.session);

export const signOut = (cfg) => call(cfg.url, '/v1/auth/logout', cfg.session, { method: 'POST' });

// A list route returns a bare array or {<key>: [...]} depending on which client
// it grew up serving. Take either.
export function rows (body, key) {
  if (Array.isArray(body)) return body;
  if (body && Array.isArray(body[key])) return body[key];
  for (const v of Object.values(body || {})) if (Array.isArray(v)) return v;
  return [];
}

export function needEngine (cfg) {
  if (!cfg.url || !cfg.key) die('Not connected. Run: clevr login --url <engine> --key clevr_sk_...');
  return cfg;
}

export async function needConsole (cfg) {
  if (!cfg.url) die('Not connected. Run: clevr login --url <engine>');
  if (!cfg.session) die('This command manages governance, which needs an account.\n       Run: clevr login --url ' + cfg.url + ' --email you@company.com');
  const me = await whoAmI(cfg);
  if (!me.ok) die('Your session has expired. Run: clevr login --url ' + cfg.url + ' --email ' + (cfg.email || 'you@company.com'));
  return { ...cfg, me: me.body };
}
