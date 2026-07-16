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
//   escalate/step_up -> held (same as block here; a stdio proxy cannot await an
//                       async console approval). CLEVR_MODE=shadow records only.
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
  timeoutMs: Number(process.env.CLEVR_TIMEOUT_MS || 8000),
}
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

// Ask the engine about one tools/call. Returns {effect, reason, decision_id}.
async function evaluate (name, args) {
  const ctrl = new AbortController()
  const t = setTimeout(() => ctrl.abort(), CFG.timeoutMs)
  try {
    const res = await fetch(`${CFG.url}/v1/evaluate`, {
      method: 'POST', signal: ctrl.signal,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${CFG.key}` },
      body: JSON.stringify({
        agent: CFG.agent,
        tool: name,
        action_type: 'tool_call',
        action: `${name}(${trunc(JSON.stringify(args ?? {}))})`,
        // Surface the tool arguments so deterministic argument rules
        // (target.<field>) can gate on them, mirroring the hook + SDK adapters.
        target_attr: (args && typeof args === 'object' && !Array.isArray(args)) ? args : null,
        metadata: { source: 'mcp-guard', host: CFG.agent, upstream: upstreamCmd[0] },
      }),
    })
    if (!res.ok) return { error: `http_${res.status}` }
    return await res.json()
  } catch (e) {
    return { error: e.name === 'AbortError' ? 'timeout' : e.message }
  } finally { clearTimeout(t) }
}

// A JSON-RPC result that tells the host the tool was denied, WITHOUT running it.
// isError:true is the MCP convention for a tool-level failure the model sees.
function denyResult (id, reason, decisionId) {
  const tag = decisionId ? ` [${decisionId}]` : ''
  send({
    jsonrpc: '2.0', id,
    result: { isError: true, content: [{ type: 'text', text: `Blocked by Clevr: ${reason || 'policy'}${tag}` }] },
  })
}

// Host -> upstream: intercept tools/call, pass everything else through. We pump
// the host stream through a serial queue so ordering is preserved across the
// async evaluate (an out-of-order forward could race a dependent request).
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
  if (!active || msg.method !== 'tools/call' || msg.id == null) return forward(line)

  const name = msg.params?.name || 'tool'
  const args = msg.params?.arguments
  const v = await evaluate(name, args)

  if (v.error) {
    // Engine unreachable: fail-open (forward) unless CLEVR_FAILSAFE=closed.
    if (CFG.failClosed) return denyResult(msg.id, `engine unreachable (${v.error})`, null)
    process.stderr.write(`[clevr-mcp-guard] engine error (${v.error}); forwarding (fail-open).\n`)
    return forward(line)
  }
  const effect = v.effect
  const blocked = effect === 'block' || effect === 'escalate' || effect === 'step_up'
  if (blocked && !CFG.shadow) return denyResult(msg.id, v.reason, v.decision_id)
  // allow, log, or shadow (record-only): the decision is already sealed; run it.
  return forward(line)
}
