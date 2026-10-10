// clevr-common.mjs — shared helpers for the Clevr Claude Code hooks.
import { createRequire } from 'node:module'
const require_ = createRequire(import.meta.url)
//
// Two hooks gate Claude Code through one engine:
//   clevr-gate.mjs    PreToolUse      — every tool call (Bash / Edit / WebFetch / MCP ...)
//   clevr-prompt.mjs  UserPromptSubmit — every user prompt, including tool-less turns
//
// They share one configuration, one transcript reader, and one evaluate call so
// the two never drift. No dependencies — Node is already present wherever Claude
// Code runs.

import { readFileSync, writeFileSync, openSync, readSync, fstatSync, closeSync, readdirSync, lstatSync, existsSync, mkdirSync, rmSync, renameSync } from 'node:fs';
import { execFileSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { tmpdir, userInfo, hostname, homedir } from 'node:os';
import { join, dirname, basename, relative, resolve, isAbsolute, sep } from 'node:path';
import http from 'node:http';
import { createHash, randomBytes, generateKeyPairSync, createPrivateKey, sign as edSign } from 'node:crypto';
import { TextDecoder } from 'node:util';
import https from 'node:https';

// Disk cache of the workspace/per-agent fail policy. These hooks are SHORT-LIVED
// (a fresh node process per tool call), so they cannot hold an in-memory cache —
// they persist the last verdict's `failsafe` here and read it when the brain is
// unreachable, so an offline hook still follows the WORKSPACE choice instead of a
// hand-set CLEVR_FAILSAFE. Absent (never yet reached the brain) → cfg.failsafe.
function failsafeCacheFile (agent) {
  return join(tmpdir(), `clevr-failsafe-${String(agent || 'default').replace(/[^a-zA-Z0-9_-]/g, '')}.json`);
}
function readFailsafeCache (agent) {
  try { const v = JSON.parse(readFileSync(failsafeCacheFile(agent), 'utf8')); return (v.failsafe === 'open' || v.failsafe === 'closed') ? v.failsafe : null; } catch { return null; }
}
// Whether the workspace gates prompts, as the engine last said (true / false),
// or null when it never said. A prompt is recorded and never refused while this
// is false, so the prompt hook must not refuse one for an unreachable engine
// either: measured on the ChatGPT desktop app, a fail-closed timeout held a
// prompt the workspace would have let through.
export function readGatePromptsCache (agent) {
  try { const v = JSON.parse(readFileSync(failsafeCacheFile(agent), 'utf8')); return typeof v.gate_prompts === 'boolean' ? v.gate_prompts : null; } catch { return null; }
}
// Whether this workspace said RECENTLY that it does not gate prompts. The
// offline reader above trusts any answer, however old, because offline a stale
// answer beats none. Skipping the wait is a different question: the posture can
// be turned on in the console, and the prompt path would be the last to hear
// about it, so the answer is only trusted for a while. In practice the tool
// gate rewrites this file on every call, so the entry is nearly always seconds
// old and no prompt ever waits.
const POSTURE_TRUSTED_MS = 10 * 60 * 1000;
export function promptsUngatedRecently (agent) {
  try {
    const v = JSON.parse(readFileSync(failsafeCacheFile(agent), 'utf8'));
    return v.gate_prompts === false && typeof v.at === 'number' && (Date.now() - v.at) < POSTURE_TRUSTED_MS;
  } catch { return false; }
}
// The effective fail policy for THIS agent when the hook cannot get a verdict:
// the last workspace/agent policy the tool gate cached, else the CLEVR_FAILSAFE
// bootstrap. Exported so a hook's own error path fails the SAME way an engine-
// unreachable does, instead of unconditionally allowing (a post-verdict crash
// must not turn a block/escalate into an ungoverned run under a fail-closed org).
export function effectiveFailsafe (cfg) {
  try { return readFailsafeCache(cfg && cfg.agent) || (cfg && cfg.failsafe) || 'open'; }
  catch { return (cfg && cfg.failsafe) || 'open'; }
}

function writeFailsafeCache (agent, failsafe, gatePrompts) {
  if (failsafe !== 'open' && failsafe !== 'closed') return;
  const entry = { failsafe, at: Date.now() };
  if (typeof gatePrompts === 'boolean') entry.gate_prompts = gatePrompts;
  try { writeFileSync(failsafeCacheFile(agent), JSON.stringify(entry), 'utf8'); } catch { /* non-fatal */ }
}

// ── The held decision this machine was last refused on, per action ──────────
// Only the SDK can wait for a person. Every other door refuses and the agent
// retries, and that retry used to produce a NEW hold: approving changed nothing
// the agent could use. So the gate remembers which decision this exact action
// was held on, and presents it on the next identical attempt. The engine spends
// the approval once, on the same agent, the same tool and the same arguments,
// inside its own window; a remembered id that does not match all of that simply
// buys nothing.
//
// Local, disposable, and never authority: the file holds an id the engine
// issued, not a permission. Deleting it costs one extra hold.
function heldFile (agent) {
  return join(tmpdir(), `clevr-held-${String(agent || 'default').replace(/[^a-zA-Z0-9_-]/g, '')}.json`);
}
function actionKey (tool, input) {
  let args = '';
  try { args = JSON.stringify(input ?? null); } catch { args = String(input ?? ''); }
  return createHash('sha256').update(`${tool || ''}::${args}`).digest('hex').slice(0, 32);
}
/** The decision id this exact action was held on, if it still looks fresh. */
export function rememberedHold (agent, tool, input) {
  try {
    const v = JSON.parse(readFileSync(heldFile(agent), 'utf8'));
    const e = v[actionKey(tool, input)];
    if (!e || !e.id) return null;
    // The engine's own window is thirty minutes; anything older cannot be spent,
    // so there is no point sending it.
    if (Date.now() - Number(e.at || 0) > 30 * 60_000) return null;
    return e.id;
  } catch { return null; }
}
/** Remember (or forget, with a null id) the hold on this action. */
export function rememberHold (agent, tool, input, decisionId) {
  try {
    const f = heldFile(agent);
    let v = {};
    try { v = JSON.parse(readFileSync(f, 'utf8')) || {}; } catch { v = {}; }
    const k = actionKey(tool, input);
    if (decisionId) v[k] = { id: decisionId, at: Date.now() };
    else delete v[k];
    // Keep the file small: the twenty most recent entries are plenty for a
    // session, and an unbounded map on a long-running machine is a leak.
    const keys = Object.keys(v).sort((a, b) => (v[b].at || 0) - (v[a].at || 0)).slice(0, 20);
    writeFileSync(f, JSON.stringify(Object.fromEntries(keys.map((x) => [x, v[x]]))), 'utf8');
  } catch { /* non-fatal: the worst case is one more hold */ }
}

export function trunc (s, n = 300) {
  s = String(s ?? '');
  return s.length <= n ? s : s.slice(0, n - 1) + '...';
}

// Resolve every CLEVR_* knob once. Both hooks read the SAME config, so a single
// environment set governs the whole plugin.
//
//   CLEVR_API_KEY          required. Org key (clevr_sk_...). If unset, the hooks
//                          are INACTIVE (allow) so an unconfigured install never
//                          bricks Claude Code.
//   CLEVR_URL              engine base URL. Default http://localhost:8787.
//   CLEVR_AGENT            identity recorded in the audit log. Default 'claude-code'.
//   CLEVR_MODE             REMOVED / ignored. The console is the single source of
//                          truth for enforcement (workspace toggle + per-agent
//                          Observe / Enforce). The hook obeys the engine's
//                          resolved verdict; a machine can no longer self-exempt
//                          to shadow (that desynchronised the console from reality
//                          — "blocked" shown for an action that actually ran).
//   CLEVR_FORWARD_CONTEXT  '1' (default) forward recent transcript turns; '0' off.
//   CLEVR_CONTEXT_TURNS    how many recent turns to forward. Default 6. Raise it to
//                          widen the window the engine scans (catches an injection
//                          planted earlier in the session), at a larger payload.
//   CLEVR_AUTO_APPROVE     '1' to also emit allow on a Clevr 'allow' (skips Claude
//                          Code's own prompt). Default off: Clevr only blocks/asks.
//   CLEVR_FAILSAFE         'open' (default) allow on engine error/timeout, or
//                          'closed' to deny. Unset key always allows.
//   CLEVR_TIMEOUT_MS       evaluate timeout. Default 15000.
//   CLEVR_PROMPT_TIMEOUT_MS  evaluate timeout on the prompt channel. Default 15000.
//   CLEVR_ENV              environment label sent to the engine (prod/staging/dev).

// WHO this run is acting for.
//
// A harness sends the name of a piece of software, never a person, which is why
// 8 decisions in 40 000 carry a verified one. The key that the plugin holds
// answers it best, and the engine reads the key's owner on its side. This is the
// client half: what the machine itself already knows about who is sitting at it.
//
// Order: an explicit setting, then the email the developer configured in git
// (the identity they already maintain, and the one that resolves against a
// directory), then the OS account and host as a last resort so the field is
// never empty on a shared workstation.
//
// It is an ASSERTION and the engine treats it as one: an unverified person can
// narrow what a rule grants, never widen it (business_rules.js). So this makes
// actions attributable without making them authorised.
let _actsFor;
export function actsFor (cwd) {
  if (_actsFor !== undefined) return _actsFor;
  const explicit = String(process.env.CLEVR_ON_BEHALF_OF || process.env.CLEVR_USER || '').trim();
  if (explicit) { _actsFor = explicit; return _actsFor; }
  try {
    const email = execFileSync('git', ['config', '--get', 'user.email'], {
      cwd: cwd || process.cwd(), encoding: 'utf8', timeout: 800, stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    if (email && email.includes('@')) { _actsFor = email; return _actsFor; }
  } catch { /* no git, no repo, no config — fall through */ }
  try {
    const u = userInfo().username;
    if (u) { _actsFor = `${u}@${hostname()}`; return _actsFor; }
  } catch { /* nothing to say */ }
  _actsFor = null;
  return _actsFor;
}

// The engine and key come from the environment, and a GUI app (the ChatGPT
// desktop app, Claude Desktop, an IDE opened from the Dock) is launched with
// none of it. Measured: hooks installed and trusted, and every one of them
// silent under the app because CLEVR_API_KEY was empty there. So the file
// `clevr setup` writes is the second source. The environment still wins when
// it is set, and a hook with neither stays silent as before.
function fileConfig () {
  try {
    const c = JSON.parse(readFileSync(join(homedir(), '.clevr', 'config.json'), 'utf8'));
    return { url: typeof c.url === 'string' ? c.url : '', key: typeof c.key === 'string' ? c.key : '' };
  } catch { return { url: '', key: '' }; }
}

export function loadConfig (defaultAgent = 'claude-code') {
  const file = process.env.CLEVR_API_KEY ? { url: '', key: '' } : fileConfig();
  return {
    apiKey: process.env.CLEVR_API_KEY || file.key || '',
    base: (process.env.CLEVR_URL || file.url || 'http://localhost:8787').replace(/\/$/, ''),
    // The caller names its own harness. Cursor used to get this from a second,
    // divergent copy of this whole file; one parameter was all that copy was
    // actually for.
    agent: process.env.CLEVR_AGENT || defaultAgent,
    // The harness these hooks run inside, as recorded on every decision
    // (metadata.source). Claude Code by default; Codex runs the same hook
    // contract and sets CLEVR_SOURCE=codex through its shims, so the console
    // names the right harness instead of filing Codex traffic under Claude Code.
    source: process.env.CLEVR_SOURCE || (defaultAgent === 'claude-code' ? 'claude-code' : defaultAgent),
    // Read by the Cursor gate: 'shadow' forces THIS machine to record-only even
    // when the engine returns a blocking verdict. Everything else obeys the
    // engine, which is where the tenant's mode already lives.
    mode: (process.env.CLEVR_MODE || 'enforce').toLowerCase(),
    failsafe: (process.env.CLEVR_FAILSAFE || 'open').toLowerCase(),
    autoApprove: process.env.CLEVR_AUTO_APPROVE === '1',
    // What a HOLD does on the tool gate, and it is the same answer in every
    // harness. 'deny' (default): the action does not run and the person is told
    // to approve it in Clevr, or from Slack or Teams, and run it again. These
    // gates answer in seconds and cannot wait for an approval that arrives
    // minutes later, so where the wait is impossible the action is refused.
    // 'allow' is the one documented way out.
    //
    // There is deliberately NO option to ask the developer sitting here.
    // Approving your own hold empties the control, and it used to exist in three
    // gates under two different names.
    escalate: (process.env.CLEVR_ESCALATE || 'deny').toLowerCase(),
    forwardCtx: process.env.CLEVR_FORWARD_CONTEXT !== '0',
    contextTurns: Math.max(1, Number(process.env.CLEVR_CONTEXT_TURNS) || 6),
    timeoutMs: Number(process.env.CLEVR_TIMEOUT_MS || 15000),
    // One budget for both channels, and it is set by what the ENGINE can take,
    // not by what feels quick. Measured over 47 928 decisions in 7 days: half
    // answer in 91ms, 99% in 3.7s, and 296 took longer than the 4000ms this
    // waited. A gate that fails closed turns each of those into a refusal no
    // policy chose, on ordinary work. 15s clears the reasoning tier (2.5s) with
    // room for the writes around it and still covers 76% of that tail; past it
    // the engine is not slow, it is stuck, and a stuck engine must be reported
    // rather than waited on.
    promptTimeoutMs: Number(process.env.CLEVR_PROMPT_TIMEOUT_MS || 15000),
    env: process.env.CLEVR_ENV || null,
    // CLEVR_SENSITIVE=1 → per-session "minimal" mode: the gate sends ONLY the
    // action SHAPE (agent/tool/action_type/action/target). The conversation, the
    // tool arguments (target_attr) and the raw tool_input are NOT transmitted, so a
    // confidential payload never leaves this machine, while the engine still governs
    // the action by nature + portée + authority. For a sensitive task, flip this
    // instead of disabling the plugin entirely.
    sensitive: process.env.CLEVR_SENSITIVE === '1',
  };
}

// Best-effort read of the Claude Code transcript (JSONL). Never throws: a bad
// transcript must not break a hook. Returns the last `max` REAL user/assistant
// turns, each truncated.
//
// Claude Code writes many INTERNAL entries alongside the conversation: `system`
// "informational" notes (including our own hook block-echoes), auto-recaps,
// `ai-title`, `queue-operation`, `last-prompt`, `attachment`, and meta/sidechain
// records. Those are UI chrome, not conversation — forwarding them polluted the
// Clevr transcript (Claude Code's English recap turned up as a SYSTEM turn, and
// our block message got echoed back into the next scan). A genuine chat turn is
// the only kind that carries `message.role` = 'user' | 'assistant'; everything
// else is skipped.
// Only the TAIL of the transcript is read. A session's transcript grows without
// bound (357 MB after a day of work, measured 2026-09-20) and this runs on every
// tool call: reading and parsing the whole file took longer than the gate's own
// budget, so the gate refused ordinary edits as "engine unreachable" while the
// engine answered in 30 ms. The last messages sit at the end of the file.
const TRANSCRIPT_TAIL_BYTES = 1024 * 1024;
function readTail (path, bytes) {
  const fd = openSync(path, 'r');
  try {
    const size = fstatSync(fd).size;
    const start = Math.max(0, size - bytes);
    const buf = Buffer.alloc(size - start);
    readSync(fd, buf, 0, buf.length, start);
    let s = buf.toString('utf8');
    if (start > 0) { const nl = s.indexOf('\n'); s = nl >= 0 ? s.slice(nl + 1) : ''; }
    return s;
  } finally { closeSync(fd); }
}
// The model that answered last, read from the transcript's tail: Claude Code's
// hook input never names it, so every agent read "model unknown" in the
// console (a tester, 2026-10-08). An assistant line carries message.model.
export function transcriptModel (path) {
  if (!path) return null;
  try {
    const lines = readTail(path, 256 * 1024).trim().split('\n');
    for (let i = lines.length - 1; i >= 0; i--) {
      let e; try { e = JSON.parse(lines[i]); } catch { continue; }
      const m = e && e.message;
      if (m && m.role === 'assistant' && typeof m.model === 'string' && m.model.trim()) return m.model.trim();
    }
  } catch { /* no transcript, no model: the console says so */ }
  return null;
}
// Who serves the model, by harness: the hook knows the harness, the harness
// knows its provider. A harness that can route to several says nothing.
export function providerOf (source) {
  const s = String(source || '').toLowerCase();
  if (s === 'claude-code' || s === 'claude-desktop') return 'anthropic';
  if (s === 'codex') return 'openai';
  return null;
}
// The two fields, once, for every body a hook sends.
export function modelFields (cfg, transcriptPath) {
  const model = transcriptModel(transcriptPath);
  const provider = providerOf(cfg && cfg.source);
  return { ...(model ? { model } : {}), ...(provider ? { provider } : {}) };
}
export function readConversation (path, max = 6) {
  try {
    const lines = readTail(path, TRANSCRIPT_TAIL_BYTES).trim().split('\n');
    const msgs = [];
    for (const line of lines) {
      let e;
      try { e = JSON.parse(line); } catch { continue; }
      if (e.isMeta === true || e.isSidechain === true) continue;
      const m = e.message;
      const role = m && m.role;
      if (role !== 'user' && role !== 'assistant') continue;
      const content = typeof m.content === 'string' ? m.content
        : Array.isArray(m.content)
          ? m.content.filter((c) => typeof c === 'string' || c.type === 'text')
              .map((c) => (typeof c === 'string' ? c : c.text || '')).join('\n')
          : '';
      // Preserve the STRUCTURED tool_use blocks (not just the prose). Claude Code's
      // transcript carries them; forwarding them lets the engine render real
      // tool-call cards in the conversation and feed the behavioural fingerprint's
      // tool set, instead of the assistant text alone. args are truncated so a
      // huge input can't bloat the payload. The id travels with them: it is what
      // binds a tool RESULT back to the call that produced it, so the result scan
      // knows the class of thing that returned the text.
      const toolCalls = Array.isArray(m.content)
        ? m.content.filter((c) => c && c.type === 'tool_use')
            .map((c) => ({ id: c.id, name: c.name, args: c.input || {} }))
        : [];
      if (content.trim() || toolCalls.length) {
        const msg = { role, content: trunc(content, 1000) };
        if (toolCalls.length) msg.tool_calls = toolCalls;
        msgs.push(msg);
      }
    }
    return msgs.slice(-max);
  } catch { return []; }
}

// POST JSON to the engine using the built-in http/https module with
// `agent: false` (a one-shot socket, no keep-alive pool) rather than global
// fetch — ON PURPOSE. A hook is a one-shot process that calls process.exit()
// the instant it has its answer. fetch (undici) leaves a pooled keep-alive
// socket open; exiting while that socket is mid-close trips a libuv assertion on
// Windows (!(handle->flags & UV_HANDLE_CLOSING), src\win\async.c line 76) and
// aborts the process with a fatal exit code, so Claude Code reports a "hook
// error" even though the gate answered fine. agent:false closes the socket as
// soon as the response ends, leaving no handle for process.exit to race with.
function httpPostJson (urlStr, { headers = {}, body = '', timeoutMs = 15000 } = {}) {
  return new Promise((resolve, reject) => {
    let url;
    try { url = new URL(urlStr); } catch (e) { reject(e); return; }
    const mod = url.protocol === 'https:' ? https : http;
    const payload = Buffer.from(body);
    const req = mod.request(url, {
      method: 'POST',
      agent: false,                 // one-shot socket: no pool, no lingering handle
      headers: { ...headers, 'Content-Length': payload.length },
    }, (res) => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { data += c; });
      res.on('end', () => resolve({ status: res.statusCode || 0, body: data, headers: res.headers || {} }));
    });
    req.on('error', reject);
    req.setTimeout(timeoutMs, () => req.destroy(new Error(`timeout after ${timeoutMs}ms`)));
    req.end(payload);
  });
}

// ── A session opened with its own key ───────────────────────────────────────
// The engine can bind a session to a key this machine holds (brain
// lib/session_identity.js, docs/api/sessions.mdx): the session is opened once
// with POST /v1/sessions, and every call of it then carries the token and the
// key's signature. Stopping the session in Clevr revokes the token, so it cannot
// be continued under another session id.
//
// Signed when the workspace asks (its session_proof, observe or require, read
// back from the last verdict) or when this machine does (CLEVR_SESSION_PROOF=1;
// =0 never). A workspace with it off sees no change at all: a proof that failed
// would be refused, so nothing is signed that nobody asked for.
//
// The key is written once to a file only this user can read and never sent.
// The model runs commands as the same user, so it could read the file too:
// keeping the key out of its reach is the endpoint agent's job (phase 4).
const b64url = (buf) => Buffer.from(buf).toString('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
// MUST match brain lib/session_identity.js callDigest and sessionSigningString
// byte for byte (brain/test_session_identity.mjs checks it).
export function sessionCallDigest ({ tool = '', action = '', target = '', args = null } = {}) {
  const canon = JSON.stringify([String(tool || ''), String(action || ''), String(target || ''), args == null ? null : args]);
  return b64url(createHash('sha256').update(canon).digest());
}
export function sessionSigningString ({ sid, agent, digest, ts, nonce }) {
  return ['clevr-session-v1', sid || '', agent || '', digest || '', String(ts || ''), nonce || ''].join('\n');
}
const safeName = (s) => String(s || 'default').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 60) || 'default';
function sessionsDir (home = homedir()) { return join(home, '.clevr', 'sessions'); }
function sessionFile (agent, sid, home = homedir()) {
  return join(sessionsDir(home), `${safeName(agent)}--${createHash('sha256').update(String(sid)).digest('hex').slice(0, 32)}.json`);
}
function sessionPolicyFile (agent) {
  return join(tmpdir(), `clevr-session-proof-${safeName(agent)}.json`);
}
// Remember what the workspace asks, from a verdict.
export function writeSessionPolicy (agent, policy) {
  if (!['off', 'observe', 'require'].includes(policy)) return;
  try { writeFileSync(sessionPolicyFile(agent), JSON.stringify({ policy, at: Date.now() }), 'utf8'); } catch { /* non-fatal */ }
}
export function wantsSessionProof (cfg) {
  if (process.env.CLEVR_SESSION_PROOF === '1') return true;
  if (process.env.CLEVR_SESSION_PROOF === '0') return false;
  try { return ['observe', 'require'].includes(JSON.parse(readFileSync(sessionPolicyFile(cfg && cfg.agent), 'utf8')).policy); } catch { return false; }
}
// This session's key and token, if it was opened here and is not about to expire.
export function loadSession (cfg, sid, home = homedir()) {
  if (!sid) return null;
  try {
    const s = JSON.parse(readFileSync(sessionFile(cfg.agent, sid, home), 'utf8'));
    return s && s.token && s.key && s.exp > Date.now() + 60_000 ? s : null;
  } catch { return null; }
}
// Open the session: a fresh key pair, the public half to Clevr, the token and
// the private half kept here. Returns the session, { held, message } when the
// agent's new sessions are held after a stop, or null when it could not open
// (an older engine, no network): calls then go unsigned, as before.
export async function openSession (cfg, sid, { goal = null, home = homedir() } = {}) {
  if (!cfg.apiKey || !sid) return null;
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const pub = publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('base64');
  const r = await httpPostJson(`${cfg.base}/v1/sessions`, {
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.apiKey}` },
    body: JSON.stringify({ agent: cfg.agent, public_key: pub, session_id: String(sid), runtime: cfg.source, ...(goal ? { goal: trunc(goal, 500) } : {}) }),
    timeoutMs: Math.min(cfg.timeoutMs || 15000, 5000),
  });
  const j = (() => { try { return JSON.parse(r.body); } catch { return null; } })();
  if (r.status === 403 && j && j.error === 'sessions_held') return { held: true, message: j.message || 'This agent\'s new sessions are held.' };
  if (r.status !== 200 || !j || !j.session_token) return null;
  // The engine's clock, from its answer, so a laptop a few minutes off still
  // signs proofs the engine accepts (they are good for 5 minutes).
  const server = Date.parse(r.headers && r.headers.date);
  const s = { sid: j.session_id, agent: cfg.agent, token: j.session_token, exp: Date.parse(j.expires_at),
    offset: Number.isFinite(server) ? server - Date.now() : 0,
    key: privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64') };
  try {
    mkdirSync(sessionsDir(home), { recursive: true, mode: 0o700 });
    writeFileSync(sessionFile(cfg.agent, sid, home), JSON.stringify(s), { mode: 0o600 });
    pruneSessions(home);
  } catch { /* unsigned from the next call on, as before */ }
  return s;
}
// Sessions older than two days are over: their tokens expired.
function pruneSessions (home) {
  try {
    const dir = sessionsDir(home);
    for (const f of readdirSync(dir)) {
      const p = join(dir, f);
      try { if (Date.now() - lstatSync(p).mtimeMs > 2 * 86_400_000) rmSync(p, { force: true }); } catch { /* next */ }
    }
  } catch { /* nothing to prune */ }
}
// The body with its session proof, signed over the call exactly as it is sent.
export function signedBody (session, body) {
  const ts = Math.floor((Date.now() + (Number(session.offset) || 0)) / 1000);
  const nonce = randomBytes(12).toString('hex');
  const digest = sessionCallDigest({ tool: body.tool, action: body.action, target: body.target, args: body.target_attr ?? null });
  const key = createPrivateKey({ key: Buffer.from(session.key, 'base64'), format: 'der', type: 'pkcs8' });
  const sig = 'ed25519:' + edSign(null, Buffer.from(sessionSigningString({ sid: session.sid, agent: session.agent, digest, ts, nonce })), key).toString('base64');
  return { ...body, session_proof: { token: session.token, ts, nonce, sig } };
}
// Sign when asked to, opening the session first when this machine has not yet.
export async function withSessionProof (cfg, body, { open = true } = {}) {
  if (!body || !body.session_id || !wantsSessionProof(cfg)) return body;
  let s = loadSession(cfg, body.session_id);
  if (!s && open) {
    const o = await openSession(cfg, body.session_id, { goal: body.session_goal || null }).catch(() => null);
    if (o && !o.held) s = o;
  }
  return s ? signedBody(s, body) : body;
}
// The same, for the paths that cannot wait for an opening (a record sent and
// not waited on): signed when the session is already open here.
function withSessionProofNow (cfg, body) {
  if (!body || !body.session_id || !wantsSessionProof(cfg)) return body;
  const s = loadSession(cfg, body.session_id);
  return s ? signedBody(s, body) : body;
}

// One-shot GET, same socket discipline as the POST above, for the status
// command: it reads the engine, the workspace posture and the agent record and
// exits, so a pooled socket would be one more thing for process.exit to race.
export function httpGetJson (urlStr, { headers = {}, timeoutMs = 3000 } = {}) {
  return new Promise((resolve, reject) => {
    let url;
    try { url = new URL(urlStr); } catch (e) { reject(e); return; }
    const mod = url.protocol === 'https:' ? https : http;
    const req = mod.request(url, { method: 'GET', agent: false, headers }, (res) => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { data += c; });
      res.on('end', () => {
        let body = null; try { body = JSON.parse(data); } catch { body = null; }
        resolve({ status: res.statusCode || 0, body });
      });
    });
    req.on('error', reject);
    req.setTimeout(timeoutMs, () => req.destroy(new Error(`timeout after ${timeoutMs}ms`)));
    req.end();
  });
}

// The machine this hook runs on, named as the endpoint agent names it, so Clevr
// can say which agent runs on which machine (founder, 2026-10-09: "comment tu
// classe par machine ou par agent ?"). The name is CLEVR_ENDPOINT_HOST, else
// the system's, as in the endpoint agent. A network name can change (a laptop
// on another network), so the public half of the endpoint agent's device key
// goes with it when that agent is installed here: it names the machine the
// same way across networks. Only the public half: the file also holds the
// private seed, which is never read into what is sent.
const DEVICE_PUB = /^[A-Za-z0-9+/]{43}=$/;
let _machine;
export function machineOf (home = homedir()) {
  if (_machine !== undefined) return _machine;
  // A workspace that does not want machine names to leave the laptop.
  if (process.env.CLEVR_SEND_MACHINE === '0') { _machine = null; return _machine; }
  let name = '';
  try { name = String(process.env.CLEVR_ENDPOINT_HOST || hostname() || '').trim().slice(0, 200); } catch { /* no name */ }
  let key = null;
  try {
    const pub = JSON.parse(readFileSync(join(home, '.clevr', 'endpoint-key.json'), 'utf8')).pub;
    if (typeof pub === 'string' && DEVICE_PUB.test(pub)) key = pub;
  } catch { /* no endpoint agent here */ }
  _machine = (name || key) ? { ...(name ? { name } : {}), ...(key ? { device_key: key } : {}) } : null;
  return _machine;
}
// Every record carries it, whichever hook and harness sent it.
export function withMachine (body) {
  const m = machineOf();
  if (!m || !body || typeof body !== 'object') return body;
  return { ...body, metadata: { ...(body.metadata && typeof body.metadata === 'object' ? body.metadata : {}), machine: m } };
}

// POST an action to the engine and return how it resolved. Never throws; the
// caller applies the failsafe. Shapes:
//   { inactive: true }            no API key — the hook is off
//   { verdict }                   engine answered
//   { failopen: true, reason }    engine unreachable, failsafe=open
//   { failclosed: true, reason }  engine unreachable, failsafe=closed
export async function postEvaluate (cfg, body) {
  if (!cfg.apiKey) return { inactive: true };
  try {
    const r = await httpPostJson(`${cfg.base}/v1/evaluate`, {
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.apiKey}` },
      body: JSON.stringify(withMachine(await withSessionProof(cfg, body))),
      timeoutMs: cfg.timeoutMs,
    });
    if (r.status < 200 || r.status >= 300) throw new Error(`HTTP ${r.status}`);
    const verdict = JSON.parse(r.body);
    // A 200 is not automatically a verdict. A proxy or a misconfigured endpoint on
    // the configured URL can answer 200 with valid JSON that carries no effect (an
    // empty object, an error envelope, a captive-portal / auth body). Trusting it
    // let the gate read verdict.effect === undefined and fall through to allow --
    // ungoverned even under a fail-closed workspace. An answer with no string
    // effect is the engine not answering, so apply the SAME failsafe as unreachable.
    if (!verdict || typeof verdict !== 'object' || typeof verdict.effect !== 'string' || !verdict.effect) {
      throw new Error('engine returned no verdict effect');
    }
    writeFailsafeCache(cfg.agent, verdict.failsafe, verdict.gate_prompts);   // remember the policy for offline calls
    writeSessionPolicy(cfg.agent, verdict.session_proof);                     // and whether calls are to be signed
    return { verdict };
  } catch (e) {
    // Brain unreachable → last-known workspace/agent policy (disk cache), else the
    // CLEVR_FAILSAFE bootstrap.
    const eff = readFailsafeCache(cfg.agent) || cfg.failsafe;
    if (eff === 'closed') return { failclosed: true, reason: `Clevr engine unreachable (${e.message}); fail-closed.` };
    return { failopen: true, reason: e.message };
  }
}

// Post a decision the caller cannot act on, and do not wait for the answer.
//
// A workspace that records prompts without gating them cannot refuse one, so
// waiting for that verdict spends the person's turn on a decision with no
// effect: measured on this instance, a prompt answers in 1.3s at the median
// against 96ms for a tool call. This resolves as soon as the request is on the
// wire, which is all the record needs; the engine answers into a socket nobody
// is reading, which is fine, and the failsafe cache stays fresh from the tool
// gate, which runs far more often.
export function postUnwatched (cfg, body) {
  if (!cfg.apiKey) return Promise.resolve(false);
  return new Promise((resolve) => {
    let done = false;
    const finish = (sent) => { if (!done) { done = true; resolve(sent === true); } };
    let url;
    try { url = new URL(`${cfg.base}/v1/evaluate`); } catch { finish(); return; }
    const mod = url.protocol === 'https:' ? https : http;
    const payload = Buffer.from(JSON.stringify(withMachine(withSessionProofNow(cfg, body))));
    const req = mod.request(url, {
      method: 'POST',
      agent: false,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.apiKey}`, 'Content-Length': payload.length },
    }, (res) => { res.resume(); });
    req.on('error', finish);
    // A send that cannot complete must not hold the turn either.
    req.setTimeout(2000, () => { req.destroy(); finish(); });
    req.end(payload, () => finish(true));   // flushed, not answered
  });
}

// A record that must land after the hook has exited. postUnwatched resolved when
// the bytes were flushed, and the hook then exited: over TLS the write had not
// finished its handshake, and one prompt in ten reached the engine (a tester's
// instance kept 4 prompts of three sessions, 2026-10-08). A detached child
// process sends the record and waits for the answer; the hook does not wait
// for the child. The body rides in a file only this user can read, which the
// child deletes on reading.
// How many records a background sender could not deliver since the last hook
// asked, and clear the count. The sender writes one line per lost record.
export function lostRecords () {
  const f = join(tmpdir(), 'clevr-records-lost.log');
  try {
    if (!existsSync(f)) return 0;
    const n = readFileSync(f, 'utf8').split('\n').filter(Boolean).length;
    rmSync(f, { force: true });
    return n;
  } catch { return 0; }
}

export function postDetached (cfg, body) {
  if (!cfg.apiKey) return false;
  try {
    const file = join(tmpdir(), `clevr-send-${process.pid}-${randomBytes(6).toString('hex')}.json`);
    writeFileSync(file, JSON.stringify({ url: `${cfg.base}/v1/evaluate`, apiKey: cfg.apiKey, body: withMachine(withSessionProofNow(cfg, body)) }), { mode: 0o600 });
    const sender = join(dirname(fileURLToPath(import.meta.url)), 'clevr-send.mjs');
    // An install that did not ship the sender (an older installer copied the
    // shared helpers alone) sends the record the older way instead of spawning
    // a script that is not there and calling the record sent.
    if (!existsSync(sender)) return false;
    const child = spawn(process.execPath, [sender, file], { detached: true, stdio: 'ignore', windowsHide: true });
    child.unref();
    return true;
  } catch {
    return false;
  }
}

// The prompt path, once, for every harness.
//
// Three of the five gates refused a prompt on an unreachable engine even where
// the workspace records prompts without gating them, because that rule lived in
// one hook instead of here. Both cases now answer the same way: `ungated` means
// the prompt proceeds, and `sent` says whether the record left this machine.
export async function postPrompt (cfg, body) {
  if (promptsUngatedRecently(cfg.agent)) {
    const lost = lostRecords();
    return { ungated: true, sent: postDetached(cfg, body) || await postUnwatched(cfg, body), ...(lost ? { lost } : {}) };
  }
  const res = await postEvaluate({ ...cfg, timeoutMs: cfg.promptTimeoutMs }, body);
  if (res.failclosed && readGatePromptsCache(cfg.agent) === false) return { ungated: true, sent: false };
  return res;
}

// Confirm to the engine what the gate ACTUALLY did with a verdict — 'denied' (it
// refused the tool), 'asked' (it prompted a human), 'allowed' (it let it run).
// The engine records this on the decision so the console shows "refused / did not
// run" ONLY when the gate reports 'denied', never inferred from the verdict alone
// (a log-only / old / passive gate lets a 'block' verdict run while the server
// still recorded 'block'). Best-effort and never throws: a failed confirmation
// leaves the decision unconfirmed (NULL), which the console reads honestly as
// "verdict returned, enforcement not confirmed". Only sent on the ENFORCING path
// (deny / ask) so the common allow path keeps its single round-trip.
export async function confirmEnforcement (cfg, decisionId, enforced) {
  if (!cfg.apiKey || !decisionId) return;
  try {
    await httpPostJson(`${cfg.base}/v1/decisions/${encodeURIComponent(decisionId)}/enforcement`, {
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.apiKey}` },
      body: JSON.stringify({ enforced }),
      timeoutMs: Math.min(cfg.timeoutMs || 4000, 2000),
    });
  } catch { /* leave the decision unconfirmed — the console won't overclaim */ }
}

// ── What we send, defined once ───────────────────────────────────────────────
//
// Five harnesses now feed the same three channels, and each one parses its own
// hook payload because no two contracts agree. What they must NOT each decide is
// what the engine is told: an `action_type` that differs by one word between two
// plugins produces two different verdicts for the same event, and nobody would
// find that for months. So the parsing stays per-harness and the body is built
// here.

/**
 * A user's prompt, on its way to the model.
 * `action` stays neutral so the verb floor never classifies the prose; the text
 * rides in `conversation`, which is the channel the content floor reads.
 */
export function promptBody (cfg, { prompt, sessionId, cwd, source, history = [] }) {
  // The prompt is the thing this channel exists to scan, so it goes WHOLE: a
  // secret or an injection past character 1000 of a long paste would otherwise
  // be invisible. Prior turns stay capped, they are context not subject.
  const turn = { role: 'user', content: trunc(prompt, 32000) };
  const last = history[history.length - 1];
  const conversation = (!last || last.role !== 'user' || last.content !== turn.content)
    ? [...history, turn] : history;
  const firstUser = conversation.find((m) => m.role === 'user');
  return {
    agent: cfg.agent,
    action_type: 'message',
    action: 'user prompt',
    target: null,
    environment: cfg.env,
    session_id: sessionId || null,
    // The person, as the tool gate sends it: the prompt is theirs, and without
    // it every turn but the tool calls read as nobody's.
    on_behalf_of: actsFor(cwd),
    session_goal: firstUser ? trunc(firstUser.content, 300) : null,
    conversation,
    metadata: { cwd: cwd || null, source, event: 'user-prompt' },
  };
}

/**
 * What a tool handed back. The indirect-injection surface: nobody in the
 * conversation wrote it, and it lands straight in the model's context.
 *
 * The assistant/tool pair is rebuilt because the engine's trajectory extractor
 * binds a result to its call by id, and that binding is how the scan knows what
 * class of thing produced the text.
 */
export function resultBody (cfg, { tool, input, output, callId, sessionId, cwd, source, maxChars = 8000 }) {
  const id = callId || 'tc_result';
  return {
    agent: cfg.agent,
    tool,
    action_type: 'completion',     // keeps the verb floor off: the call was already judged
    action: `result of ${tool}`,
    target: null,
    environment: cfg.env,
    session_id: sessionId || null,
    on_behalf_of: actsFor(cwd),
    actor_chain: [{ type: 'agent', id: cfg.agent, display: cfg.agent }],
    conversation: [
      { role: 'assistant', content: '', tool_calls: [{ id, name: tool, args: (input && typeof input === 'object' && !Array.isArray(input)) ? input : {} }] },
      { role: 'tool', tool_call_id: id, content: trunc(String(output ?? ''), maxChars) },
    ],
    metadata: { cwd: cwd || null, source, event: 'tool-result', tool_use_id: id },
  };
}

/**
 * The model's own answer, on its way out.
 *
 * `system_prompt` is what lets the response channel ask whether the answer gave
 * the instructions away. A harness that does not hand us the system prompt still
 * gets the rest of the egress scan; it simply cannot be asked that one question,
 * and sending an empty field says so honestly rather than comparing against
 * nothing and reporting a clean result.
 */
export function answerBody (cfg, { answer, systemPrompt, sessionId, cwd, source, maxChars = 12000 }) {
  return {
    agent: cfg.agent,
    action_type: 'output',
    direction: 'egress',
    action: trunc(String(answer ?? ''), maxChars),
    target: null,
    environment: cfg.env,
    session_id: sessionId || null,
    on_behalf_of: actsFor(cwd),
    ...(systemPrompt ? { system_prompt: trunc(String(systemPrompt), maxChars) } : {}),
    metadata: { cwd: cwd || null, source, event: 'model-answer' },
  };
}

/** Flatten whatever shape a harness calls a tool result into scannable text. */
export function flattenResult (raw) {
  if (raw == null) return '';
  if (typeof raw === 'string') return raw;
  if (typeof raw !== 'object') return String(raw);
  for (const k of ['textResultForLlm', 'stdout', 'output', 'content', 'text', 'result']) {
    if (typeof raw[k] === 'string' && raw[k]) return raw[k];
  }
  try { return JSON.stringify(raw); } catch { return ''; }
}


// Where this machine is working, for the brain's environment classifier
// (lib/environment.js): current branch and remote, kube context, cloud profile.
// Read cheaply and never blocking: git with a short timeout, the kube config
// file's current-context line, environment variables. Everything is best-effort
// and the brain treats it as corroboration, never as the agent's word.
export function machineContext (cwd) {
  const ctx = {}
  try {
    const { execFileSync } = require_('node:child_process')
    const opts = { cwd: cwd || process.cwd(), timeout: 700, stdio: ['ignore', 'pipe', 'ignore'], encoding: 'utf8', windowsHide: true }
    try { ctx.git_branch = execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], opts).trim() || undefined } catch {}
    try { ctx.git_remote = execFileSync('git', ['remote', 'get-url', 'origin'], opts).trim() || undefined } catch {}
  } catch {}
  try {
    const fs = require_('node:fs'); const os = require_('node:os'); const path = require_('node:path')
    const kube = process.env.KUBECONFIG ? process.env.KUBECONFIG.split(path.delimiter)[0] : path.join(os.homedir(), '.kube', 'config')
    const m = fs.readFileSync(kube, 'utf8').match(/^current-context:\s*["']?([^"'\n]+)/m)
    if (m) ctx.kube_context = m[1].trim()
  } catch {}
  const cloud = process.env.AWS_PROFILE || process.env.CLOUDSDK_CORE_PROJECT || process.env.GOOGLE_CLOUD_PROJECT || process.env.AZURE_SUBSCRIPTION_ID || null
  if (cloud) ctx.cloud_profile = cloud
  if (process.env.AWS_ACCOUNT_ID) ctx.cloud_account = process.env.AWS_ACCOUNT_ID
  if (cwd) ctx.cwd = cwd
  return Object.keys(ctx).length ? ctx : null
}


// Ticket references the work is carrying, for rules that need proof (approval
// by evidence): the current branch name (OPS-4471-fix-login) and, for a shell
// command, the command text (git commit -m "OPS-4471 ..."). The brain verifies
// them against the source; naming one grants nothing by itself.
export function evidenceRefs (context, toolInput) {
  const texts = [context?.git_branch || '']
  if (toolInput && typeof toolInput === 'object') {
    for (const k of ['command', 'message', 'title', 'body', 'branch']) if (typeof toolInput[k] === 'string') texts.push(toolInput[k].slice(0, 2000))
  }
  const out = new Set()
  for (const t of texts) for (const m of String(t).matchAll(/\b([A-Z][A-Z0-9_]{1,15}-\d{1,8})\b/g)) out.add(m[1])
  return [...out].slice(0, 5).map((ref) => ({ kind: 'ticket', ref }))
}

// ── Skills ───────────────────────────────────────────────────────────────────
// A skill is a folder holding a SKILL.md, sometimes with scripts beside it: the
// instructions an agent loads to do a task its way. Clevr governs every load as
// skill:<name> (brain lib/skills.js), against the mandate and the version an
// administrator approved, and keeps the workspace's inventory. Each harness
// loads one its own way, and each way is read here:
//   - a tool made for it: Claude Code's Skill {"skill":"pdf"} and Gemini CLI's
//     activate_skill {"name":"pdf"}. The brain names that call by the skill.
//   - the agent opening the SKILL.md itself: Codex runs `cat .../SKILL.md` (its
//     own session logs, 2026-10-01), and any agent can Read the file. The load
//     is asked first, as its own action (gateSkillLoads).
//   - a person typing it: Claude Code's /name reaches UserPromptExpansion, never
//     PreToolUse (clevr-expand.mjs); Codex's $name and Cursor's /name sit in the
//     prompt (typedSkillsIn).
// The content is fingerprinted where it lies: sha256 over every file's path and
// content, so a changed script is a new version as surely as a changed SKILL.md.
// These helpers live in this file because it is the one every installer ships:
// a helper in a file of its own crashed the gate wherever an installer did not
// copy it, and a crashed hook lets the call through.

const SKILL_MAX_FILES = 200;
const SKILL_MAX_BYTES = 5 * 1024 * 1024;
const SKILL_TEXT_MAX = 64 * 1024;
// The marker the plugin writes into a skill Clevr distributed is not part of
// the skill: left out, the folder's fingerprint is the one Clevr published.
const SKILL_MARKER = '.clevr-skill.json';
const SKILL_SKIP = new Set(['.git', 'node_modules', '.DS_Store', SKILL_MARKER]);
// The brain's own rule (lib/skills.js): letters, digits, dash, underscore, dot
// and the namespace colon; nothing that reads as a path.
const SKILL_NAME = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,199}$/;
const skillNameOk = (n) => typeof n === 'string' && SKILL_NAME.test(n) && !n.includes('..');
// Byte order, not the machine's locale: the same skill has the same fingerprint
// on every machine that loads it.
const byCode = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const slashed = (p) => String(p).split('\\').join('/');

// Claude Code's managed settings directory: an administrator's skills there
// outrank a person's own (code.claude.com/docs/en/managed-settings).
function claudeManagedDir () {
  if (process.platform === 'darwin') return '/Library/Application Support/ClaudeCode';
  if (process.platform === 'win32') return 'C:\\Program Files\\ClaudeCode';
  return '/etc/claude-code';
}

// The working directory and its parents up to the repository root, nearest
// first: project skills are read from each. Outside a repository, the working
// directory alone.
function projectDirs (cwd) {
  if (!cwd) return [];
  const out = [];
  let d = resolve(cwd);
  for (let i = 0; i < 12; i++) {
    out.push(d);
    if (existsSync(join(d, '.git'))) return out;
    const up = dirname(d);
    if (up === d) break;
    d = up;
  }
  return [resolve(cwd)];
}

// Where each harness looks for a skill by name, in the order a name resolves:
// the first folder holding it wins. From each harness's own documentation.
function skillRoots (harness, cwd, home) {
  const proj = (sub) => projectDirs(cwd).map((d) => ({ dir: join(d, sub), origin: 'project' }));
  const user = (sub) => ({ dir: join(home, sub), origin: 'user' });
  switch (harness) {
    case 'codex':
      return [...proj('.agents/skills'), user('.agents/skills'), user('.codex/skills'),
        { dir: '/etc/codex/skills', origin: 'managed' }, { dir: join(home, '.codex/skills/.system'), origin: 'built_in' }];
    case 'cursor':
      return [...proj('.agents/skills'), ...proj('.cursor/skills'), ...proj('.claude/skills'), ...proj('.codex/skills'),
        user('.agents/skills'), user('.cursor/skills'), user('.claude/skills'), user('.codex/skills')];
    case 'gemini-cli':
      // A workspace's skill outranks a person's own in Gemini CLI.
      return [...proj('.gemini/skills'), ...proj('.agents/skills'), user('.gemini/skills'), user('.agents/skills')];
    case 'github-copilot':
      return [...proj('.github/skills'), ...proj('.claude/skills'), ...proj('.agents/skills'), user('.copilot/skills'), user('.agents/skills')];
    default:
      // Claude Code: "Enterprise over personal, and personal over project".
      return [{ dir: join(claudeManagedDir(), '.claude', 'skills'), origin: 'managed' }, user('.claude/skills'), ...proj('.claude/skills')];
  }
}

// The installed copies of a plugin: Claude Code's own registry, then Codex's
// plugin cache, which has the same layout (cache/<marketplace>/<plugin>/<version>).
function pluginRoots (plugin, home) {
  const out = [];
  try {
    const reg = JSON.parse(readFileSync(join(home, '.claude', 'plugins', 'installed_plugins.json'), 'utf8'));
    for (const [key, entries] of Object.entries(reg.plugins || {})) {
      if (key.split('@')[0] !== plugin) continue;
      for (const e of (Array.isArray(entries) ? entries : [entries])) {
        if (e && typeof e.installPath === 'string') out.push({ root: e.installPath, id: key + (e.version ? ' ' + e.version : '') });
      }
    }
  } catch { /* no Claude Code registry */ }
  try {
    const cache = join(home, '.codex', 'plugins', 'cache');
    for (const market of readdirSync(cache).sort(byCode)) {
      const dir = join(cache, market, plugin);
      if (!existsSync(dir)) continue;
      for (const version of readdirSync(dir).sort(byCode).reverse()) out.push({ root: join(dir, version), id: `${plugin}@${market} ${version}` });
    }
  } catch { /* no Codex plugins */ }
  return out;
}

// The plugin that ships a skill or command of this bare name, when exactly one
// does: Claude Code names a typed plugin command without its plugin.
export function pluginProviding (name, home = homedir()) {
  try {
    const reg = JSON.parse(readFileSync(join(home, '.claude', 'plugins', 'installed_plugins.json'), 'utf8'));
    const hits = new Set();
    for (const key of Object.keys(reg.plugins || {})) {
      const plugin = key.split('@')[0];
      for (const p of pluginRoots(plugin, home)) {
        if (existsSync(join(p.root, 'skills', name, 'SKILL.md')) || existsSync(join(p.root, 'commands', name + '.md'))) hits.add(plugin);
      }
    }
    return hits.size === 1 ? [...hits][0] : null;
  } catch { return null; }
}

// Where a skill name points on this machine for this harness, or null.
export function locateSkill (name, cwd, home = homedir(), harness = 'claude-code') {
  const n = String(name || '').trim();
  if (!n || n.includes('..') || n.includes('/') || n.includes('\\') || n.includes('\0')) return null;
  const candidates = [];
  const colon = n.indexOf(':');
  if (colon > 0) {
    const plugin = n.slice(0, colon);
    const item = n.slice(colon + 1);
    if (!item) return null;
    // A namespaced command (plugin:group:item) lives at commands/group/item.md.
    const parts = item.split(':');
    for (const p of pluginRoots(plugin, home)) {
      candidates.push({ origin: 'plugin', plugin: p.id, dir: join(p.root, 'skills', parts.join('-')), file: join(p.root, 'commands', ...parts) + '.md' });
    }
  } else {
    for (const r of skillRoots(harness, cwd, home)) {
      // Claude Code's commands answer to /name too, a skill first in each scope.
      const commands = harness === 'claude-code' && r.origin !== 'managed' ? join(r.dir, '..', 'commands', n + '.md') : null;
      candidates.push({ origin: r.origin, dir: join(r.dir, n), file: commands });
    }
  }
  for (const c of candidates) {
    if (c.dir && existsSync(join(c.dir, 'SKILL.md'))) return { origin: c.origin, plugin: c.plugin || null, kind: 'folder', root: c.dir, main: join(c.dir, 'SKILL.md') };
    if (c.file && existsSync(c.file)) return { origin: c.origin, plugin: c.plugin || null, kind: 'file', root: c.file, main: c.file };
  }
  return colon < 0 ? skillByDeclaredName(n, harness, cwd, home) : null;
}

// A skill can answer to the name its SKILL.md declares rather than its
// folder's. Found by the folder alone, such a load went out with no content,
// which nothing could compare (founder, 2026-10-09: a renamed skill). Same
// roots, same order, the first lines of each SKILL.md, bounded.
function skillByDeclaredName (n, harness, cwd, home) {
  for (const r of skillRoots(harness, cwd, home)) {
    let entries;
    try { entries = readdirSync(r.dir, { withFileTypes: true }).filter((e) => e.isDirectory() && !e.name.startsWith('.')).slice(0, 300); } catch { continue; }
    for (const e of entries) {
      const main = join(r.dir, e.name, 'SKILL.md');
      if (declaredSkillName(main) === n) return { origin: r.origin, plugin: null, kind: 'folder', root: join(r.dir, e.name), main };
    }
  }
  return null;
}

// The name a SKILL.md declares in its front matter, read from its first 4 KB.
function declaredSkillName (file) {
  let fd;
  try {
    fd = openSync(file, 'r');
    const buf = new Uint8Array(4096);
    const n = readSync(fd, buf, 0, 4096, 0);
    const lines = new TextDecoder().decode(buf.subarray(0, n)).split('\n').map((l) => l.replace(/\r$/, ''));
    if (lines[0] !== '---') return null;
    for (let i = 1; i < lines.length && lines[i] !== '---'; i++) {
      if (lines[i].startsWith('name:')) return lines[i].slice('name:'.length).trim().replace(/^["']|["']$/g, '') || null;
    }
    return null;
  } catch { return null; } finally { if (fd !== undefined) try { closeSync(fd); } catch { /* closed */ } }
}

// Every file of a skill, in a stable order, within the budget. Symbolic links
// are not followed: a link out of the folder is not the skill.
function collectSkillFiles (loc) {
  const files = [];
  let bytes = 0, partial = false;
  const add = (abs, rel) => {
    if (files.length >= SKILL_MAX_FILES) { partial = true; return; }
    const buf = readFileSync(abs);
    if (bytes + buf.length > SKILL_MAX_BYTES) { partial = true; return; }
    bytes += buf.length;
    files.push({ path: rel, bytes: buf.length, sha256: createHash('sha256').update(buf).digest('hex') });
  };
  if (loc.kind === 'file') { add(loc.main, basename(loc.main)); return { files, partial }; }
  const walk = (dir) => {
    for (const ent of readdirSync(dir, { withFileTypes: true }).sort((a, b) => byCode(a.name, b.name))) {
      if (SKILL_SKIP.has(ent.name)) continue;
      const abs = join(dir, ent.name);
      const st = lstatSync(abs);
      if (st.isSymbolicLink()) continue;
      if (st.isDirectory()) walk(abs);
      else if (st.isFile()) add(abs, slashed(relative(loc.root, abs)));
    }
  };
  walk(loc.root);
  files.sort((a, b) => byCode(a.path, b.path));
  return { files, partial };
}

// The description line of a SKILL.md or command file's front matter: the lines
// between a first line "---" and the next one. Read line by line, so a large
// file without a closing "---" costs one pass, not a backtracking search.
function skillDescriptionOf (text) {
  const lines = String(text).slice(0, SKILL_TEXT_MAX).split('\n').map((l) => l.replace(/\r$/, ''));
  if (lines[0] !== '---') return null;
  for (let i = 1; i < lines.length && lines[i] !== '---'; i++) {
    if (!lines[i].startsWith('description:')) continue;
    const v = lines[i].slice('description:'.length).trim().replace(/^["']|["']$/g, '');
    return v ? v.slice(0, 500) : null;
  }
  return null;
}

// What a located skill is: its fingerprint and files always, its description
// and text outside confidential mode.
function describeLocated (name, loc, { sensitive = false } = {}) {
  const out = { name: String(name || '').slice(0, 200) };
  const { files, partial } = collectSkillFiles(loc);
  if (!files.length) return { ...out, origin: loc.origin };
  const fingerprint = createHash('sha256').update(files.map((f) => `${f.path}\0${f.sha256}\n`).join('')).digest('hex');
  // A folder the plugin wrote as Clevr distributed it says so.
  const origin = loc.kind === 'folder' && existsSync(join(loc.root, SKILL_MARKER)) ? 'clevr' : loc.origin;
  const desc = { ...out, origin, ...(loc.plugin ? { plugin: loc.plugin } : {}), fingerprint, files, ...(partial ? { partial: true } : {}) };
  if (sensitive) return desc;
  const text = readFileSync(loc.main, 'utf8');
  return { ...desc, description: skillDescriptionOf(text), text: text.slice(0, SKILL_TEXT_MAX), ...(text.length > SKILL_TEXT_MAX ? { text_truncated: true } : {}) };
}

// What a skill load carries for the brain: always the name, and what this
// machine can say about its content. A skill it cannot find (one built in to
// the harness) goes by its name alone; nothing here may break a hook.
export function describeSkill (name, cwd, { sensitive = false, home = homedir(), harness = 'claude-code' } = {}) {
  const out = { name: String(name || '').slice(0, 200) };
  try {
    const loc = locateSkill(name, cwd, home, harness);
    if (!loc) return { ...out, origin: 'unknown' };
    return describeLocated(out.name, loc, { sensitive });
  } catch { return out; }
}

// The skill a path to a SKILL.md belongs to: the folder holding it. A plugin's
// skill (.../plugins/cache/<marketplace>/<plugin>/<version>/skills/<name>, the
// layout Claude Code and Codex share) is named plugin:name, as Claude Code
// names it, so a load read from the file and one through the Skill tool are
// the same skill in the inventory.
export function skillAtPath (p, cwd, home = homedir()) {
  let s = String(p || '').trim();
  if (!/(^|[\\/])SKILL\.md$/.test(s)) return null;
  s = s.replace(/^\$\{?HOME\}?(?=[\\/])/, home).replace(/^~(?=[\\/])/, home);
  const abs = isAbsolute(s) ? s : resolve(cwd || process.cwd(), s);
  const dir = dirname(abs);
  const folder = basename(dir);
  if (!skillNameOk(folder) || folder.includes(':')) return null;
  const norm = slashed(abs);
  const m = /\/plugins\/cache\/[^/]+\/([^/]+)\/[^/]+\/skills\/[^/]+\/SKILL\.md$/.exec(norm);
  const plugin = m && skillNameOk(m[1]) && !m[1].includes(':') ? m[1] : null;
  const top = projectDirs(cwd).slice(-1)[0];
  const under = (root) => !!root && norm.startsWith(slashed(root).replace(/\/$/, '') + '/');
  const origin = plugin ? 'plugin'
    : under(claudeManagedDir()) || under('/etc/codex/skills') ? 'managed'
      : norm.includes('/.codex/skills/.system/') ? 'built_in'
        : top && top !== home && under(top) ? 'project'
          : under(home) ? 'user' : 'unknown';
  return { name: plugin ? `${plugin}:${folder}` : folder, kind: 'folder', root: dir, main: abs, origin, plugin };
}

// The skills one SKILL.md mention reaches. A glob where the skill's folder
// sits (cat skills/*/SKILL.md) reads every skill it matches. A file that is not
// there loads nothing.
function skillsAtToken (token, cwd, home) {
  const t = slashed(token.replace(/^\$\{?HOME\}?(?=[\\/])/, home).replace(/^~(?=[\\/])/, home));
  const parts = t.split('/');
  const folder = parts.length >= 2 ? parts[parts.length - 2] : '';
  if (/[*?[\]]/.test(folder)) {
    const parent = parts.slice(0, -2).join('/') || '.';
    const base = isAbsolute(parent) ? parent : resolve(cwd || process.cwd(), parent);
    const re = new RegExp('^' + folder.replace(/[.+^${}()|\\]/g, '\\$&').replace(/\*/g, '[^/]*').replace(/\?/g, '[^/]') + '$');
    let names = [];
    try { names = readdirSync(base).filter((x) => re.test(x)).sort(byCode).slice(0, 20); } catch { return []; }
    return names.map((x) => skillAtPath(join(base, x, 'SKILL.md'), cwd, home)).filter((l) => l && existsSync(l.main));
  }
  const loc = skillAtPath(t, cwd, home);
  return loc && existsSync(loc.main) ? [loc] : [];
}

// The skills a tool call loads by opening their SKILL.md: a Read of the file,
// `cat` in a shell, a script that opens it. A tool made for loading a skill is
// the load itself and is named by the brain; writing a SKILL.md is editing a
// skill, not loading one, and is left to the call's own check.
// Listing files is not reading them: a Glob for **/SKILL.md, or `ls` and
// `find` in a shell, names skills without loading any.
const DIRECT_SKILL_TOOL = /^(skill|activate_skill)$/i;
const WRITE_TOOL = /(write|edit|create|apply|patch|replace|insert|delete|remove|move|rename|mkdir|touch)/i;
const SHELL_TOOL = /(bash|shell|terminal|exec|command|powershell|run)/i;
const LISTING_TOOL = /^(glob|ls|list_dir|list_directory|list_files|file_search|find_by_name|file_glob_search)$/i;
const LISTING_COMMAND = /^\s*(ls|find|fd|stat|test|\[|file|wc|du|tree|realpath|dirname|basename|echo)\b/;
const SKILL_FILE_TOKEN = /[^\s'"`=(),;|&<>{}[\]]*SKILL\.md(?![\w.-])/g;
export function skillLoadsIn (toolName, toolInput, cwd, { home = homedir() } = {}) {
  const t = String(toolName || '');
  if (DIRECT_SKILL_TOOL.test(t) || LISTING_TOOL.test(t)) return [];
  const shell = SHELL_TOOL.test(t);
  if (WRITE_TOOL.test(t) && !shell) return [];
  const texts = [];
  const walk = (v, depth) => {
    if (texts.length >= 50 || depth > 4 || v == null) return;
    if (typeof v === 'string') { if (v.includes('SKILL.md') && !(shell && LISTING_COMMAND.test(v))) texts.push(v.slice(0, 65536)); return; }
    if (Array.isArray(v)) {
      // A command given as an argv array reads as one line.
      if (v.length && v.every((x) => typeof x === 'string')) { const line = v.join(' '); if (line.includes('SKILL.md') && !(shell && LISTING_COMMAND.test(line))) texts.push(line.slice(0, 65536)); return; }
      for (const x of v) walk(x, depth + 1);
      return;
    }
    if (typeof v === 'object') for (const x of Object.values(v)) walk(x, depth + 1);
  };
  walk(toolInput, 0);
  const found = new Map();
  try {
    for (const text of texts) {
      for (const m of text.matchAll(SKILL_FILE_TOKEN)) {
        for (const loc of skillsAtToken(m[0], cwd, home)) if (!found.has(loc.name)) found.set(loc.name, loc);
        if (found.size >= 8) break;
      }
    }
  } catch { /* an unreadable path loads nothing we can name */ }
  return [...found.values()];
}

// The skills a person names in the prompt they type, the way their harness
// lets them: $name in Codex, /name in Cursor and Copilot. Only a name that is a
// skill on this machine counts, so $HOME or /tmp in a sentence is nothing.
export function typedSkillsIn (prompt, cwd, { harness, home = homedir() } = {}) {
  const sigil = harness === 'codex' ? '\\$' : (harness === 'cursor' || harness === 'github-copilot') ? '/' : null;
  if (!sigil) return [];
  // Followed by a slash it is a path (/review/notes.md), not a skill.
  const re = new RegExp(`(?:^|\\s)${sigil}([A-Za-z0-9][A-Za-z0-9_.:-]{0,99})(?=$|[^/\\w])`, 'g');
  const out = new Map();
  for (const m of String(prompt || '').slice(0, 32000).matchAll(re)) {
    const name = m[1].replace(/[.:]+$/, '');
    if (out.has(name) || !skillNameOk(name)) continue;
    try {
      const loc = locateSkill(name, cwd, home, harness);
      if (loc) out.set(name, { name, ...loc });
    } catch { /* not a skill here */ }
    if (out.size >= 5) break;
  }
  return [...out.values()];
}

// The evaluate body of one skill load, the same whichever way the skill was
// reached, so the brain records and checks it as it does a Skill tool call.
export function skillLoadBody (cfg, load, { sessionId = null, cwd = null, via = 'read', byTool = null, actorChain = null } = {}) {
  let desc = load.desc || null;
  if (!desc) {
    try { desc = load.main ? describeLocated(load.name, load, { sensitive: cfg.sensitive }) : { name: load.name, origin: 'unknown' }; }
    catch { desc = { name: load.name }; }
  }
  return {
    agent: cfg.agent, tool: 'Skill', action_type: 'tool_call',
    action: `Skill(${JSON.stringify({ skill: load.name })})`, target: null,
    environment: cfg.env, session_id: sessionId,
    on_behalf_of: actsFor(cwd),
    actor_chain: actorChain || [{ type: 'agent', id: cfg.agent, display: cfg.agent }],
    target_attr: cfg.sensitive ? null : { skill: load.name },
    skill: desc,
    metadata: { cwd, source: cfg.source, via, ...(byTool ? { tool: byTool } : {}), ...(cfg.sensitive ? { sensitive: true } : {}) },
    ...(cfg.sensitive ? { sensitive: true } : {}),
  };
}

// Ask Clevr about each skill a call or a prompt loads, before it goes on.
// Returns null when every load may proceed, or { message } when one may not:
// the caller refuses in its own harness's words. A hold is remembered like any
// other, so once a person approves it the same load goes through on the retry.
//   honorShadow  CLEVR_MODE=shadow on this machine records and never stops (the
//                one harness that reads it, Cursor)
//   recordOnly   the harness cannot stop what this hook sees (Copilot's
//                prompt): every load is recorded, none is refused, and what
//                Clevr would have stopped comes back as { message, recordedOnly }
export async function gateSkillLoads (cfg, loads, { honorShadow = false, recordOnly = false, ...ctx } = {}) {
  let flagged = null;
  for (const load of (loads || []).slice(0, 8)) {
    const body = skillLoadBody(cfg, load, ctx);
    const input = { skill: load.name };
    const pending = rememberedHold(cfg.agent, 'Skill', input);
    if (pending) body.resume = pending;
    const res = await postEvaluate(cfg, body);
    if (res.inactive) return null;
    if (res.failclosed) { if (recordOnly) continue; return { message: res.reason }; }
    if (res.failopen) { process.stderr.write(`[clevr] engine error (${res.reason}); the skill ${load.name} loads unchecked (fail-open).\n`); continue; }
    const v = res.verdict;
    const effect = v.effect;
    const id = v.decision_id || null;
    const tag = id ? ` [${id}]` : '';
    const held = effect === 'escalate' || effect === 'step_up';
    if (held) rememberHold(cfg.agent, 'Skill', input, id);
    else if (pending) rememberHold(cfg.agent, 'Skill', input, null);
    if (honorShadow && cfg.mode === 'shadow') continue;
    if (effect !== 'block' && !(held && cfg.escalate !== 'allow')) continue;
    const tenantMsg = (effect === 'block' ? v.block_message : v.stepup_message) || null;
    const message = tenantMsg ? `${tenantMsg}${tag}`
      : effect === 'block'
        ? `Clevr blocked loading the skill ${load.name}: ${v.reason || ''}${tag}`
        : `Clevr did not load the skill ${load.name}. It needs a person's decision first: ${v.reason || ''} Once someone has approved it in Clevr, try again and it will go through.${tag}`;
    if (recordOnly) { flagged = flagged || { message, recordedOnly: true }; continue; }
    if (id) { try { await confirmEnforcement(cfg, id, 'denied'); } catch { /* stays unconfirmed */ } }
    return { message };
  }
  return flagged;
}

// ── Skills Clevr distributes ────────────────────────────────────────────────
// An administrator publishes a skill in Clevr; every agent whose mandate names
// it receives that approved version. At the start of a session the plugin asks
// which skills those are (POST /v1/skills/sync) and writes their files where
// the harness reads a person's skills: ~/.claude/skills for Claude Code, and
// ~/.agents/skills, which Codex, Cursor, Copilot and Gemini CLI all read.
//   - A folder it writes carries a marker; it never touches one without it, so
//     a person's own skill of the same name stays theirs.
//   - What is on disk is fingerprinted and sent: a distributed skill edited on
//     the machine is a version of its own, and Clevr hands the approved files
//     back, which restores it.
//   - A skill Clevr no longer distributes to this agent leaves the machine.
// Bounded and best-effort: an engine that does not answer in time leaves the
// machine as it was, and the session starts anyway. CLEVR_SKILLS_SYNC=0 turns
// it off.
const DIST_FOLDER = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/;
export function distributedSkillsDir (harness, home = homedir()) {
  return harness === 'claude-code' ? join(home, '.claude', 'skills') : join(home, '.agents', 'skills');
}

// The skills this machine holds as Clevr distributed them, with the
// fingerprint of what is on disk now ('' when it cannot be read).
export function distributedSkillsHeld (dir) {
  const out = {};
  let names = [];
  try { names = readdirSync(dir); } catch { return out; }
  for (const n of names) {
    const d = join(dir, n);
    if (!DIST_FOLDER.test(n) || !existsSync(join(d, SKILL_MARKER))) continue;
    try { out[n] = describeLocated(n, { kind: 'folder', root: d, main: join(d, 'SKILL.md'), origin: 'clevr' }).fingerprint || ''; }
    catch { out[n] = ''; }
  }
  return out;
}

// Write one distributed skill: built beside the target, checked against the
// fingerprint Clevr sent, then swapped in. 'written' | 'conflict' | 'mismatch'.
function writeDistributedSkill (dir, skill) {
  const final = join(dir, skill.name);
  if (existsSync(final) && !existsSync(join(final, SKILL_MARKER))) return 'conflict';
  const tmp = join(dir, `.clevr-tmp-${skill.name}-${process.pid}`);
  rmSync(tmp, { recursive: true, force: true });
  mkdirSync(tmp, { recursive: true });
  try {
    for (const f of skill.files) {
      const parts = String(f && f.path || '').split('/');
      if (!parts.length || parts.some((x) => !x || x === '.' || x === '..' || x.includes('\\') || x.includes('\0'))) throw new Error('a path outside the skill');
      const abs = join(tmp, ...parts);
      if (!abs.startsWith(tmp + sep)) throw new Error('a path outside the skill');
      mkdirSync(dirname(abs), { recursive: true });
      writeFileSync(abs, Buffer.from(String(f.content || ''), 'base64'), { mode: 0o644 });
    }
    writeFileSync(join(tmp, SKILL_MARKER), JSON.stringify({ distributed_by: 'clevr', name: skill.name, fingerprint: skill.fingerprint, at: new Date().toISOString() }) + '\n', { mode: 0o644 });
    const got = describeLocated(skill.name, { kind: 'folder', root: tmp, main: join(tmp, 'SKILL.md'), origin: 'clevr' }).fingerprint;
    if (got !== skill.fingerprint) { rmSync(tmp, { recursive: true, force: true }); return 'mismatch'; }
    rmSync(final, { recursive: true, force: true });
    renameSync(tmp, final);
    return 'written';
  } catch (e) {
    rmSync(tmp, { recursive: true, force: true });
    throw e;
  }
}

export async function syncDistributedSkills (cfg, { harness = 'claude-code', home = homedir(), timeoutMs = 2500 } = {}) {
  const result = { changed: false, written: [], removed: [], conflicts: [] };
  if (!cfg || !cfg.apiKey || process.env.CLEVR_SKILLS_SYNC === '0') return result;
  const dir = distributedSkillsDir(harness, home);
  const have = distributedSkillsHeld(dir);
  let answer = null;
  try {
    const r = await httpPostJson(`${cfg.base}/v1/skills/sync`, {
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.apiKey}` },
      body: JSON.stringify({ agent: cfg.agent, runtime: cfg.source, have }),
      timeoutMs,
    });
    if (r.status < 200 || r.status >= 300) return result;
    answer = JSON.parse(r.body);
  } catch { return result; }
  if (!answer || !Array.isArray(answer.skills)) return result;
  const keep = new Set();
  for (const s of answer.skills.slice(0, 100)) {
    if (!s || typeof s.name !== 'string' || !DIST_FOLDER.test(s.name) || typeof s.fingerprint !== 'string') continue;
    keep.add(s.name);
    if (!Array.isArray(s.files)) continue;   // already held as distributed
    try {
      mkdirSync(dir, { recursive: true });
      const w = writeDistributedSkill(dir, s);
      if (w === 'written') { result.written.push(s.name); result.changed = true; }
      else if (w === 'conflict') result.conflicts.push(s.name);
    } catch { /* this one stays as it was */ }
  }
  for (const name of Object.keys(have)) {
    if (keep.has(name)) continue;
    try { rmSync(join(dir, name), { recursive: true, force: true }); result.removed.push(name); result.changed = true; } catch { /* stays */ }
  }
  return result;
}
