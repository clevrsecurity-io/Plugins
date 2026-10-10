// Where the CLI keeps its state: ~/.clevr/
//
//   config.json   engine URL, agent key, console session  (mode 600)
//   env.sh        the exports a tool needs, sourced from the shell rc
//   <tool files>  hook and guard scripts copied out of integrations/
import { readFileSync, writeFileSync, mkdirSync, existsSync, rmSync, chmodSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// Linear by construction: the regex form (/\/+$/) backtracks on a long run of
// slashes, which a pasted URL can carry.
export function trimSlash (u) {
  let o = String(u || '');
  while (o.endsWith('/')) o = o.slice(0, -1);
  return o;
}

export const HOME = homedir();
export const DIR = join(HOME, '.clevr');
export const FILE = join(DIR, 'config.json');
export const ENV_SH = join(DIR, 'env.sh');

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

export function load () {
  try { return JSON.parse(readFileSync(FILE, 'utf8')); } catch { return {}; }
}

export function save (next) {
  mkdirSync(DIR, { recursive: true });
  writeFileSync(FILE, JSON.stringify(next, null, 2) + '\n', { mode: 0o600 });
  return next;
}

export function patch (fields) { return save({ ...load(), ...fields }); }

export function clear () { rmSync(FILE, { force: true }); }

export function readJson (p) { try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return null; } }

// Some tool-config files we write carry the agent key (a hook/env block or an
// MCP server env). The CLI keeps its own copy of the key at 0600 (config.json,
// env.sh via `save`/`writeEnvFile`), so a file we write the SAME key into must
// not be looser — on a shared host a 0644 file leaks a bearer credential for
// /v1. When the serialized content carries a Clevr secret we tighten the file to
// 0600 BEFORE writing (so an already-loose file never briefly holds the secret
// world-readable) and create a new one at 0600. Files with no key keep the
// default mode, so plain hook wiring is untouched.
const SECRET_RX = /clevr_sk_|ANTHROPIC_AUTH_TOKEN/;
export function writeJson (p, o) {
  mkdirSync(dirname(p), { recursive: true });
  const data = JSON.stringify(o, null, 2) + '\n';
  const secret = SECRET_RX.test(data);
  if (secret) { try { chmodSync(p, 0o600); } catch { /* no existing file; created 0600 below */ } }
  writeFileSync(p, data, secret ? { mode: 0o600 } : undefined);
}

// Integration payloads live in the monorepo when the CLI runs from a checkout,
// and under cli/files/ when it ships as a package. Resolve whichever is there.
export function asset (rel) {
  for (const base of [join(ROOT, '..', 'integrations'), join(ROOT, 'files', 'integrations')]) {
    const p = join(base, rel);
    if (existsSync(p)) return p;
  }
  return null;
}

export function endpointAgent () {
  for (const p of [join(ROOT, '..', 'endpoint-agent', 'clevr-endpoint.mjs'), join(ROOT, 'files', 'endpoint', 'clevr-endpoint.mjs')]) {
    if (existsSync(p)) return p;
  }
  return null;
}

// The exports every wired tool reads. Written as one file the shell rc sources,
// so `clevr uninstall` can take the wiring back out with a single line removed.
export function writeEnvFile (cfg, extra = {}) {
  mkdirSync(DIR, { recursive: true });
  const vars = { CLEVR_URL: cfg.url, CLEVR_API_KEY: cfg.key, ...extra };
  const body = ['# Written by `clevr setup`. Edit through the CLI, not by hand.',
    ...Object.entries(vars).filter(([, v]) => v).map(([k, v]) => 'export ' + k + '=' + JSON.stringify(v))].join('\n');
  writeFileSync(ENV_SH, body + '\n', { mode: 0o600 });
  return ENV_SH;
}

export const rcFiles = () => [join(HOME, '.zshrc'), join(HOME, '.bashrc'), join(HOME, '.bash_profile')].filter((p) => existsSync(p));

export const RC_LINE = '[ -f "$HOME/.clevr/env.sh" ] && . "$HOME/.clevr/env.sh"';

export function rcHasLine () {
  return rcFiles().some((p) => { try { return readFileSync(p, 'utf8').includes('.clevr/env.sh'); } catch { return false; } });
}
