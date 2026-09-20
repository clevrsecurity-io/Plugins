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

import { readFileSync, writeFileSync, openSync, readSync, fstatSync, closeSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir, userInfo, hostname, homedir } from 'node:os';
import { join } from 'node:path';
import http from 'node:http';
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
function writeFailsafeCache (agent, failsafe, gatePrompts) {
  if (failsafe !== 'open' && failsafe !== 'closed') return;
  const entry = { failsafe };
  if (typeof gatePrompts === 'boolean') entry.gate_prompts = gatePrompts;
  try { writeFileSync(failsafeCacheFile(agent), JSON.stringify(entry), 'utf8'); } catch { /* non-fatal */ }
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
//   CLEVR_TIMEOUT_MS       evaluate timeout. Default 4000.
//   CLEVR_PROMPT_TIMEOUT_MS  evaluate timeout on the prompt channel. Default 8000.
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
    timeoutMs: Number(process.env.CLEVR_TIMEOUT_MS || 4000),
    // The prompt channel waits longer than the tool gate: a prompt is scanned
    // whole (content detectors on the full text) and a refusal there costs the
    // person the turn, whereas the tool gate answers on a short command.
    promptTimeoutMs: Number(process.env.CLEVR_PROMPT_TIMEOUT_MS || 8000),
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
function httpPostJson (urlStr, { headers = {}, body = '', timeoutMs = 4000 } = {}) {
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
      res.on('end', () => resolve({ status: res.statusCode || 0, body: data }));
    });
    req.on('error', reject);
    req.setTimeout(timeoutMs, () => req.destroy(new Error(`timeout after ${timeoutMs}ms`)));
    req.end(payload);
  });
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
      body: JSON.stringify(body),
      timeoutMs: cfg.timeoutMs,
    });
    if (r.status < 200 || r.status >= 300) throw new Error(`HTTP ${r.status}`);
    const verdict = JSON.parse(r.body);
    writeFailsafeCache(cfg.agent, verdict.failsafe, verdict.gate_prompts);   // remember the policy for offline calls
    return { verdict };
  } catch (e) {
    // Brain unreachable → last-known workspace/agent policy (disk cache), else the
    // CLEVR_FAILSAFE bootstrap.
    const eff = readFailsafeCache(cfg.agent) || cfg.failsafe;
    if (eff === 'closed') return { failclosed: true, reason: `Clevr engine unreachable (${e.message}); fail-closed.` };
    return { failopen: true, reason: e.message };
  }
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
