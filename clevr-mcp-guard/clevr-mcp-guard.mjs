#!/usr/bin/env node
// clevr-mcp-guard — a stdio MCP proxy that governs ANY MCP host that has no
// per-tool hook (Claude Desktop, GitHub Copilot agent mode, Windsurf, ...).
//
// It sits transparently between the MCP host and a real MCP server: the host
// launches THIS as its "server"; this spawns the real upstream server and
// relays JSON-RPC both ways. Before a `tools/call` reaches the upstream, it is
// POSTed to Clevr `POST /v1/evaluate`; the engine's verdict decides:
//
//   allow / log      -> forward to the upstream tool (runs normally)
//   block            -> the call NEVER reaches the tool; the host gets an
//                       isError result carrying the Clevr reason
//   escalate/step_up -> held: not forwarded, worded as held; once a person
//                       approves it, the identical retry presents the hold and
//                       runs. CLEVR_MODE=shadow records only.
//
// Every verdict is sealed server-side into Clevr's signed, hash-chained audit
// log, exactly like a Claude Code hook or an MCP gateway call. This is the
// MCP-connector-layer door for harnesses that expose no preToolUse hook — we do
// not fake a hook where the harness has none.
//
// Usage (what the host config runs):
//   node clevr-mcp-guard.mjs -- <upstream-server-cmd> [args...]
// e.g.  node clevr-mcp-guard.mjs -- npx -y @modelcontextprotocol/server-filesystem /data
//
// Config via env: CLEVR_URL (required), CLEVR_API_KEY (required),
//   CLEVR_AGENT (default "mcp-host"), CLEVR_MODE (shadow = record-only),
//   CLEVR_FAILSAFE (closed = block when the engine is unreachable; default open).

import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import http from 'node:http'
import https from 'node:https'

const argv = process.argv.slice(2)
const dash = argv.indexOf('--')
const upstreamCmd = dash >= 0 ? argv.slice(dash + 1) : argv
if (!upstreamCmd.length) {
  process.stderr.write('[clevr-mcp-guard] no upstream server command. Usage: node clevr-mcp-guard.mjs -- <cmd> [args...]\n')
  process.exit(2)
}

const CFG = {
  url: (process.env.CLEVR_URL || '').replace(/\/+$/, ''),
  key: process.env.CLEVR_API_KEY || '',
  agent: process.env.CLEVR_AGENT || 'mcp-host',
  shadow: process.env.CLEVR_MODE === 'shadow',
  failClosed: process.env.CLEVR_FAILSAFE === 'closed',
  timeoutMs: Number(process.env.CLEVR_TIMEOUT_MS || 15000),
}

// One fail policy the whole guard obeys. Learned from the brain's verdicts
// (verdict.failsafe = the workspace default or this agent's override) and applied
// the moment the brain is unreachable. Before the first verdict, fall back to the
// CLEVR_FAILSAFE bootstrap. This is what makes every surface behave identically.
let cachedFailsafe = null
// Seeded once at startup from the workspace (below), so even before the first
// verdict the guard follows the workspace choice rather than the CLEVR_FAILSAFE env.
let workspaceFailsafe = null
const effectiveFailsafe = () => cachedFailsafe || workspaceFailsafe || (CFG.failClosed ? 'closed' : 'open')
const active = !!(CFG.url && CFG.key)
if (!active) process.stderr.write('[clevr-mcp-guard] CLEVR_URL/CLEVR_API_KEY not set; passing through UNGOVERNED.\n')

// Spawn the real upstream MCP server. Its stdout is the host's tool output;
// its stderr is passed through so the host still sees server logs.
const up = spawn(upstreamCmd[0], upstreamCmd.slice(1), { stdio: ['pipe', 'pipe', 'inherit'] })
up.on('exit', (code) => process.exit(code == null ? 0 : code))
up.on('error', (e) => { process.stderr.write(`[clevr-mcp-guard] upstream spawn failed: ${e.message}\n`); process.exit(2) })

// Upstream -> host: straight passthrough (tool results, notifications, etc.).
up.stdout.pipe(process.stdout)

const send = (obj) => process.stdout.write(JSON.stringify(obj) + '\n')
// Guard against a late write: an async handler can resolve AFTER the host closed
// stdin (which ends the upstream's stdin), so never write to an ended stream.
const forward = (line) => { if (up.stdin.writable) up.stdin.write(line + '\n') }

function trunc (s, n = 400) { s = String(s ?? ''); return s.length > n ? s.slice(0, n) + '…' : s }

// POST JSON with the built-in http/https module on a one-shot socket
// (agent:false), NOT global fetch. This proxy calls process.exit() when its
// upstream MCP server dies; a pooled undici keep-alive socket mid-close at that
// moment trips a libuv assertion on Windows (!(handle->flags & UV_HANDLE_CLOSING),
// src\win\async.c). A one-shot socket closes on response end, so nothing is
// mid-close when the process exits.
function httpPostJson (urlStr, { headers = {}, body = '', timeoutMs = 8000 } = {}) {
  return new Promise((resolve, reject) => {
    let url
    try { url = new URL(urlStr) } catch (e) { reject(e); return }
    const mod = url.protocol === 'https:' ? https : http
    const payload = Buffer.from(body)
    const req = mod.request(url, {
      method: 'POST',
      agent: false,
      headers: { ...headers, 'Content-Length': payload.length },
    }, (res) => {
      let data = ''
      res.setEncoding('utf8')
      res.on('data', (c) => { data += c })
      res.on('end', () => resolve({ status: res.statusCode || 0, body: data }))
    })
    req.on('error', reject)
    req.setTimeout(timeoutMs, () => req.destroy(new Error(`timeout after ${timeoutMs}ms`)))
    req.end(payload)
  })
}

// One-shot GET (same one-shot-socket pattern as httpPostJson) for the startup
// seed of the workspace fail policy.
function httpGetJson (urlStr, { headers = {}, timeoutMs = 5000 } = {}) {
  return new Promise((resolve, reject) => {
    let url
    try { url = new URL(urlStr) } catch (e) { reject(e); return }
    const mod = url.protocol === 'https:' ? https : http
    const req = mod.request(url, { method: 'GET', agent: false, headers }, (res) => {
      let data = ''
      res.setEncoding('utf8')
      res.on('data', (c) => { data += c })
      res.on('end', () => resolve({ status: res.statusCode || 0, body: data }))
    })
    req.on('error', reject)
    req.setTimeout(timeoutMs, () => req.destroy(new Error('timeout')))
    req.end()
  })
}

// Seed the offline default from the workspace at startup (best-effort). If the
// brain is unreachable now, the CLEVR_FAILSAFE bootstrap stands until the first
// verdict corrects the cache.
;(async () => {
  try {
    const r = await httpGetJson(`${CFG.url}/v1/failsafe`, { headers: { Authorization: `Bearer ${CFG.key}` } })
    if (r.status >= 200 && r.status < 300) {
      const j = JSON.parse(r.body)
      if (j && (j.failsafe_action === 'open' || j.failsafe_action === 'closed')) workspaceFailsafe = j.failsafe_action
    }
  } catch { /* brain unreachable at boot; bootstrap stands */ }
})()

// The holds a tools/call was refused on, per exact call, newest last: the same
// memory as the gateway and the hook plugins. The host's model cannot wait for
// a person, so the identical retry presents the holds and the engine spends one
// approval, the first given, on the same agent, tool and arguments, inside its
// window. A retry made before the answer is held again under a new id; the
// person may approve either. Kept 25 hours; lost with this process, it costs
// one more hold.
const HELD_TTL_MS = 25 * 3600_000
const HELD_MAX = 2000
const held = new Map()
const SHELL_TOOL = /(bash|shell|terminal|exec|command|powershell|run|launch-process)/i
// The same arguments in another key order are the same call, for this memory
// and for the action line the engine compares as text. Arrays keep their order.
function canonicalArgs (v) {
  if (v === null || typeof v !== 'object') return JSON.stringify(v === undefined ? null : v)
  if (Array.isArray(v)) return '[' + v.map(canonicalArgs).join(',') + ']'
  return '{' + Object.keys(v).sort().filter((k) => v[k] !== undefined).map((k) => JSON.stringify(k) + ':' + canonicalArgs(v[k])).join(',') + '}'
}
const heldKey = (name, args) => `${name}::${canonicalArgs(SHELL_TOOL.test(name) && args && typeof args === 'object' && 'command' in args ? { command: args.command } : (args ?? null))}`
function rememberedHolds (key) {
  const e = held.get(key)
  if (!e) return []
  if (Date.now() - e.at > HELD_TTL_MS) { held.delete(key); return [] }
  return e.ids
}
function rememberHold (key, id) {
  const prev = id ? rememberedHolds(key) : []
  held.delete(key)
  if (!id) return
  held.set(key, { ids: [...prev.filter((x) => x !== id), id].slice(-8), at: Date.now() })
  if (held.size > HELD_MAX) held.delete(held.keys().next().value)
}

// Ask the engine about one tools/call. Returns {effect, reason, decision_id}.
async function evaluate (name, args, holds = []) {
  try {
    const res = await httpPostJson(`${CFG.url}/v1/evaluate`, {
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${CFG.key}` },
      timeoutMs: CFG.timeoutMs,
      body: JSON.stringify({
        agent: CFG.agent,
        tool: name,
        action_type: 'tool_call',
        action: `${name}(${trunc(canonicalArgs(args ?? {}))})`,
        // Surface the tool arguments so deterministic argument rules
        // (target.<field>) can gate on them, mirroring the hook + SDK adapters.
        target_attr: (args && typeof args === 'object' && !Array.isArray(args)) ? args : null,
        ...(holds.length ? { resume: holds.at(-1), ...(holds.length > 1 ? { resume_candidates: holds.slice(0, -1) } : {}) } : {}),
        metadata: { source: 'mcp-guard', host: CFG.agent, upstream: upstreamCmd[0] },
      }),
    })
    if (res.status < 200 || res.status >= 300) return { error: `http_${res.status}` }
    try { return JSON.parse(res.body) } catch { return { error: 'bad_json' } }
  } catch (e) {
    return { error: /^timeout/.test(e.message) ? 'timeout' : e.message }
  }
}

// Tell the engine what this guard DID with a verdict ('denied' | 'allowed'), so
// the console reads "did not run" only when the guard truly refused the call,
// never inferred from the verdict alone. Best-effort, short timeout, never
// delays the answer to the host: the deny is sent first, this follows.
function confirmEnforcement (decisionId, enforced) {
  if (!active || !decisionId) return
  httpPostJson(`${CFG.url}/v1/decisions/${encodeURIComponent(decisionId)}/enforcement`, {
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${CFG.key}` },
    body: JSON.stringify({ enforced }),
    timeoutMs: Math.min(CFG.timeoutMs, 2000),
  }).catch(() => { /* stays unconfirmed; the console does not overclaim */ })
}

// A JSON-RPC result that tells the host the tool was denied, WITHOUT running it.
// isError:true is the MCP convention for a tool-level failure the model sees.
function denyResult (id, reason, decisionId, held = false, heldAs = null) {
  const shown = (held && heldAs) || decisionId
  const tag = shown ? ` [${shown}]` : ''
  // A hold is not a refusal: it says so, and what clears it.
  const text = held
    ? `Held for review, not refused: ${reason || 'policy'} Once it is approved in Clevr, make exactly the same call again.${tag}`
    : `Blocked by Clevr: ${reason || 'policy'}${tag}`
  send({
    jsonrpc: '2.0', id,
    result: { isError: true, content: [{ type: 'text', text }] },
  })
  confirmEnforcement(decisionId, 'denied')
}

// Data / side-effect MCP methods this guard CANNOT govern are REFUSED, not
// forwarded: resources/read pulls a file:/// or db:// resource and prompts/get
// returns a prompt -- both sidestep the tools/call floor entirely if passed
// through ungoverned. Mirrors the gateway MCP door (UNGOVERNED_MCP). Discovery /
// lifecycle (initialize, tools/list, resources/list, prompts/list) and
// notifications still pass; a later change can evaluate these through the engine.
// completion/complete autocompletes from data (ids, names, one keystroke at a
// time), the same disclosure as resources/read.
const UNGOVERNED_MCP = new Set(['resources/read', 'resources/subscribe', 'prompts/get', 'completion/complete'])
function refuseMethod (id, method) {
  send({ jsonrpc: '2.0', id, error: { code: -32601, message: `Clevr governs tool calls on this guard; the MCP method "${method}" returns data outside that governance and is refused rather than forwarded ungoverned.` } })
}

// Host -> upstream: intercept tools/call AND the ungoverned data methods above,
// pass everything else through. We pump the host stream through a serial queue so
// ordering is preserved across the async evaluate (an out-of-order forward could
// race a dependent request).
let chain = Promise.resolve()
const rl = createInterface({ input: process.stdin, crlfDelay: Infinity })
rl.on('line', (line) => {
  if (!line.trim()) return
  chain = chain.then(() => handle(line)).catch((e) => {
    process.stderr.write(`[clevr-mcp-guard] handler error: ${e.message}\n`)
    forward(line) // never lose a message on our own bug
  })
})
// Drain any in-flight (async) handlers before ending the upstream's stdin, so a
// tools/call still being evaluated isn't dropped when the host disconnects.
rl.on('close', () => { chain.finally(() => { try { up.stdin.end() } catch {} }) })

async function handle (line) {
  let msg
  try { msg = JSON.parse(line) } catch { return forward(line) } // not JSON we understand -> pass through
  if (!active) return forward(line)                                     // inactive guard passes through
  // A JSON-RPC batch has no id of its own, so it was forwarded whole and a tool
  // call inside one reached the upstream unjudged. The calls a batch carries
  // are refused, each with its id; a batch of discovery passes.
  if (Array.isArray(msg)) {
    if (!msg.some((m) => m && (m.method === 'tools/call' || UNGOVERNED_MCP.has(m.method)))) return forward(line)
    const errs = msg.filter((m) => m && m.id != null).map((m) => ({ jsonrpc: '2.0', id: m.id,
      error: { code: -32600, message: 'Clevr governs tool calls one at a time; send each call on its own, not in a batch.' } }))
    if (errs.length) send(errs)
    return
  }
  if (msg.id == null) return forward(line)                               // notifications pass through
  if (UNGOVERNED_MCP.has(msg.method)) return refuseMethod(msg.id, msg.method)  // data pull we cannot govern -> refuse
  if (msg.method !== 'tools/call') return forward(line)

  const name = msg.params?.name || 'tool'
  const args = msg.params?.arguments
  const key = heldKey(name, args)
  const pending = rememberedHolds(key)
  const v = await evaluate(name, args, pending)
  if (!v.error) {
    // A retry joined to the request already waiting (held_as) presents it.
    if (v.effect === 'escalate' || v.effect === 'step_up') rememberHold(key, v.held_as || v.decision_id)
    else if (pending.length) rememberHold(key, null)
  }

  if (v.error) {
    // Engine unreachable → the agent's cached fail policy (workspace default or
    // per-agent override), else the CLEVR_FAILSAFE bootstrap. closed=deny, open=forward.
    if (effectiveFailsafe() === 'closed') return denyResult(msg.id, `engine unreachable (${v.error})`, null)
    process.stderr.write(`[clevr-mcp-guard] engine error (${v.error}); forwarding (fail-open per policy).\n`)
    return forward(line)
  }
  if (v.failsafe === 'open' || v.failsafe === 'closed') cachedFailsafe = v.failsafe
  const effect = v.effect
  const blocked = effect === 'block' || effect === 'escalate' || effect === 'step_up'
  if (blocked && !CFG.shadow) return denyResult(msg.id, v.reason, v.decision_id, effect !== 'block', v.held_as || null)
  // A blocking verdict this machine let through (shadow) is an allow it chose:
  // confirm it, so the console shows the call ran rather than "not confirmed".
  if (blocked) confirmEnforcement(v.decision_id, 'allowed')
  // allow, log, or shadow (record-only): the decision is already sealed; run it.
  return forward(line)
}
