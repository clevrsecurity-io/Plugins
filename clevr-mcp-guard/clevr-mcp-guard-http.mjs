#!/usr/bin/env node
// Clevr MCP guard (Streamable HTTP).
//
// The same gate as the stdio guard next door, on the transport a hosted agent
// platform speaks. It sits in front of an MCP server, relays JSON-RPC both ways,
// and POSTs every `tools/call` to Clevr `POST /v1/evaluate` before it reaches
// the upstream:
//
//   allow             forwarded, and the engine has already signed the receipt
//   block             the upstream never sees it; an isError result carries why
//   escalate/step_up  same, worded as HELD rather than refused
//
// WHY A SECOND FILE AND NOT A FLAG. The stdio guard is a pipe between two
// processes on one machine: it owns both ends and ordering is its own problem.
// This one is a server that several callers hit at once over a network, with
// sessions, headers and its own auth. Bolting a transport switch onto the pipe
// would have made one file answer to two very different failure modes.
//
// WHY IT EXISTS. Copilot Studio agents can use MCP tools (GA 2026-07-15), and
// that is the only door into a Copilot Studio agent that sees what it DOES. The
// alternative on offer there — a guardrail topic pasted into the agent — sees
// the user's message and the model's reply and never an action.
//
// WHAT IT DOES NOT COVER, said here because the distinction sells the product
// and misunderstanding it loses a customer: an agent's OTHER tools. A Power
// Automate flow, a Dataverse action or a first-party connector does not come
// through here. This governs the MCP tools, completely, and nothing else.
import http from 'node:http';

const PORT      = +(process.env.PORT || 8093);
const CLEVR_URL = (process.env.CLEVR_URL || 'http://localhost:8787').replace(/\/+$/, '');
const CLEVR_KEY = process.env.CLEVR_API_KEY || '';
const AGENT     = process.env.CLEVR_AGENT || 'copilot-studio';
const UPSTREAM  = (process.env.MCP_UPSTREAM_URL || '').replace(/\/+$/, '');
const TIMEOUT   = +(process.env.CLEVR_TIMEOUT_MS || 6000);
const FAILSAFE  = (process.env.CLEVR_FAILSAFE || 'open').toLowerCase();
// A shared secret the caller must present. Copilot Studio sends an API key
// header on an MCP connection; without this anyone who finds the URL reaches
// the customer's tools through us, which would make us the hole.
const GUARD_KEY = process.env.MCP_GUARD_KEY || '';
let UPSTREAM_HEADERS = {};
try { UPSTREAM_HEADERS = JSON.parse(process.env.MCP_UPSTREAM_HEADERS || '{}'); } catch { UPSTREAM_HEADERS = {}; }

if (!UPSTREAM) {
  console.error('Set MCP_UPSTREAM_URL to the MCP server to put behind the guard.');
  process.exit(1);
}
// Refuse to start without one, rather than printing a warning nobody reads and
// then serving the customer's tools to whoever finds the URL. Set
// MCP_GUARD_ALLOW_ANONYMOUS=1 only behind something else that authenticates.
if (!GUARD_KEY && process.env.MCP_GUARD_ALLOW_ANONYMOUS !== '1') {
  console.error('Set MCP_GUARD_KEY. Without it anyone who finds this URL reaches the tools behind it.');
  console.error('If something in front already authenticates, set MCP_GUARD_ALLOW_ANONYMOUS=1 and say so in your runbook.');
  process.exit(1);
}

const trunc = (s, n = 2000) => (String(s ?? '').length > n ? String(s).slice(0, n - 1) + '…' : String(s ?? ''));

async function withTimeout (p, ms) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), ms);
  try { return await p(ctl.signal); } finally { clearTimeout(t); }
}

// One tools/call, judged. Never throws: the caller applies the failsafe.
async function evaluate (name, args, sessionId) {
  try {
    const r = await withTimeout((signal) => fetch(`${CLEVR_URL}/v1/evaluate`, {
      method: 'POST', signal,
      headers: { 'Content-Type': 'application/json', ...(CLEVR_KEY ? { Authorization: `Bearer ${CLEVR_KEY}` } : {}) },
      body: JSON.stringify({
        agent: AGENT,
        tool: name,
        action_type: 'tool_call',
        action: `${name}(${trunc(JSON.stringify(args ?? {}))})`,
        // The real arguments, so argument rules and the content floor read the
        // values rather than a label. Same shape as every other Clevr gate.
        target_attr: (args && typeof args === 'object' && !Array.isArray(args)) ? args : null,
        session_id: sessionId || null,
        metadata: { source: 'mcp-guard-http', upstream: UPSTREAM },
      }),
    }), TIMEOUT);
    if (!r.ok) return { error: `http_${r.status}` };
    return await r.json();
  } catch (e) {
    return { error: e.name === 'AbortError' ? 'timeout' : e.message };
  }
}

// isError:true is the MCP convention for a tool-level failure the model sees,
// which is what we want: the agent is told, in its own loop, why nothing ran.
const refuse = (id, text) => ({
  jsonrpc: '2.0', id,
  result: { isError: true, content: [{ type: 'text', text }] },
});

// Tell the engine the guard refused the call ('denied'), so the console shows
// "did not run" on the guard's word and not on the verdict alone. Fire and
// forget, bounded, never in the caller's path.
function confirmDenied (decisionId) {
  if (!decisionId || !CLEVR_KEY) return;
  withTimeout((signal) => fetch(`${CLEVR_URL}/v1/decisions/${encodeURIComponent(decisionId)}/enforcement`, {
    method: 'POST', signal,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${CLEVR_KEY}` },
    body: JSON.stringify({ enforced: 'denied' }),
  }), 2000).catch(() => { /* stays unconfirmed */ });
}

async function relay (body, headers) {
  const r = await withTimeout((signal) => fetch(UPSTREAM, {
    method: 'POST', signal,
    headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', ...UPSTREAM_HEADERS, ...headers },
    body: JSON.stringify(body),
  }), TIMEOUT);
  const text = await r.text();
  return { status: r.status, text, sessionId: r.headers.get('mcp-session-id') };
}

const server = http.createServer(async (req, res) => {
  if (req.method === 'GET' && req.url === '/healthz') { res.writeHead(200).end('ok'); return; }
  if (req.method !== 'POST') { res.writeHead(405).end(); return; }

  if (GUARD_KEY) {
    const given = req.headers['x-api-key']
      || String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    if (given !== GUARD_KEY) { res.writeHead(401, { 'Content-Type': 'application/json' }).end('{"error":"unauthorized"}'); return; }
  }

  const chunks = [];
  for await (const c of req) chunks.push(c);
  let msg;
  try { msg = JSON.parse(Buffer.concat(chunks).toString() || '{}'); }
  catch { res.writeHead(400).end(); return; }

  // The session id travels both ways or the upstream loses the conversation.
  const sessionId = req.headers['mcp-session-id'] || '';
  const passHeaders = sessionId ? { 'mcp-session-id': sessionId } : {};
  const send = (obj, status = 200, extra = {}) => {
    res.writeHead(status, { 'Content-Type': 'application/json', ...extra });
    res.end(typeof obj === 'string' ? obj : JSON.stringify(obj));
  };

  try {
    // Everything that is not a tool call is relayed untouched: initialize,
    // tools/list, prompts, resources, notifications. A guard that reshaped the
    // handshake would break servers it does not know about.
    if (msg.method !== 'tools/call' || msg.id == null) {
      const up = await relay(msg, passHeaders);
      return send(up.text, up.status, up.sessionId ? { 'mcp-session-id': up.sessionId } : {});
    }

    const name = msg.params?.name || 'unknown_tool';
    const args = msg.params?.arguments ?? {};
    const v = await evaluate(name, args, sessionId);

    if (v.error) {
      if (FAILSAFE === 'closed') {
        return send(refuse(msg.id, `Clevr unreachable (${v.error}); failing closed on "${name}".`));
      }
      process.stderr.write(`[clevr] engine error (${v.error}); forwarding (fail-open).\n`);
      const up = await relay(msg, passHeaders);
      return send(up.text, up.status, up.sessionId ? { 'mcp-session-id': up.sessionId } : {});
    }

    const tag = v.decision_id ? ` [${v.decision_id}]` : '';
    const reason = (v.effect === 'block' ? v.block_message : v.stepup_message) || v.reason || 'policy';
    if (v.effect === 'block') { confirmDenied(v.decision_id); return send(refuse(msg.id, `Blocked by Clevr: ${reason}${tag}`)); }
    if (v.effect === 'escalate' || v.effect === 'step_up') {
      // A tool call cannot wait for an approval that arrives minutes later, so
      // a Hold stops it and says what clears it. Nothing runs uncleared, and
      // nobody is told a queued action was forbidden.
      confirmDenied(v.decision_id);
      return send(refuse(msg.id,
        `Held for review, not refused: ${reason} Approve it in Clevr (or from Slack or Teams) and run it again.${tag}`));
    }

    const up = await relay(msg, passHeaders);
    return send(up.text, up.status, up.sessionId ? { 'mcp-session-id': up.sessionId } : {});
  } catch (e) {
    return send({ jsonrpc: '2.0', id: msg.id ?? null, error: { code: -32603, message: e.message } });
  }
});

server.listen(PORT, () => {
  console.log(`Clevr MCP guard (http) on :${PORT} → ${UPSTREAM}`);
  console.log(`  engine ${CLEVR_URL} · agent ${AGENT} · failsafe ${FAILSAFE}${GUARD_KEY ? ' · key required' : ' · ANONYMOUS (explicitly allowed)'}`);
});
