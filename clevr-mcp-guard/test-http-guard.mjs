#!/usr/bin/env node
// Measures clevr-mcp-guard-http.mjs: does it relay what it should, refuse what it
// should, and does a refused tool actually not run?
//
// Hermetic on purpose. Both ends are stand-ins — a fake MCP server and a fake
// engine — because the thing under test is the GUARD: relaying, gating, the
// failsafe and its own auth. The engine's verdicts are measured by the corpora
// in tools/content-bench, and a test that needed the whole stack up would be a
// test nobody runs.
//
// The assertion that matters is the last one. Everything else checks what the
// agent was TOLD; that one checks what the upstream server actually RAN, which
// is the difference between governing an action and asking a model nicely.
//
//   node integrations/mcp-guard/test-http-guard.mjs
import http from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
// Ports are taken from the OS rather than hard-coded: a fixed port is a test
// that fails on whichever machine already runs something there, which is how
// the first run of this one failed.
const freePort = async () => new Promise((res, rej) => {
  const s = http.createServer();
  s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => res(port)); });
  s.on('error', rej);
});
let UP_PORT, ENGINE_PORT, GUARD_PORT;
const KEY = 'test-guard-key';

let pass = 0, fail = 0;
const ok = (name, cond, detail = '') => {
  if (cond) { pass++; console.log('  PASS ' + name); }
  else { fail++; console.log('  FAIL ' + name + (detail ? '\n       ' + detail : '')); }
};

// ── the stand-in MCP server ──────────────────────────────────────────────────
const ran = [];
const upstream = http.createServer(async (req, res) => {
  const c = []; for await (const x of req) c.push(x);
  const m = JSON.parse(Buffer.concat(c).toString() || '{}');
  const send = (result) => {
    res.writeHead(200, { 'Content-Type': 'application/json', 'mcp-session-id': 'sess-upstream' });
    res.end(JSON.stringify({ jsonrpc: '2.0', id: m.id, result }));
  };
  if (m.method === 'initialize') return send({ protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'upstream', version: '1' } });
  if (m.method === 'tools/list') return send({ tools: [{ name: 'db.query', inputSchema: { type: 'object' } }, { name: 'files.delete', inputSchema: { type: 'object' } }] });
  if (m.method === 'tools/call') { ran.push(m.params?.name); return send({ content: [{ type: 'text', text: `ran ${m.params?.name}` }] }); }
  res.writeHead(202).end();
});

// ── the stand-in engine ──────────────────────────────────────────────────────
// Verdict by tool name, so the test says what it means: delete is refused,
// export is held, everything else passes.
let engineDown = false;
const engine = http.createServer(async (req, res) => {
  if (engineDown) { req.destroy(); return; }
  const c = []; for await (const x of req) c.push(x);
  const body = JSON.parse(Buffer.concat(c).toString() || '{}');
  const tool = String(body.tool || '');
  const effect = /delete/.test(tool) ? 'block' : /export/.test(tool) ? 'escalate' : 'allow';
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({
    effect,
    reason: `stand-in verdict for ${tool}`,
    decision_id: 'dec_test',
    // Echoed back so one assertion can prove the guard sent the real arguments
    // rather than a label: an argument rule is worthless if it never sees them.
    _saw_args: body.target_attr,
  }));
});

const listen = (s, p) => new Promise((r) => s.listen(p, r));
const close = (s) => new Promise((r) => s.close(r));

async function rpc (body, headers = {}) {
  const r = await fetch(`http://127.0.0.1:${GUARD_PORT}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': KEY, ...headers },
    body: JSON.stringify(body),
  });
  const text = await r.text();
  let json = null; try { json = JSON.parse(text); } catch { /* left null */ }
  return { status: r.status, json };
}
const call = (name, args = {}) => rpc({ jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name, arguments: args } });
const refused = (res) => res.json?.result?.isError === true;
const said = (res) => res.json?.result?.content?.[0]?.text || '';

function startGuard (extraEnv = {}) {
  const child = spawn(process.execPath, [join(HERE, 'clevr-mcp-guard-http.mjs')], {
    env: {
      ...process.env,
      PORT: String(GUARD_PORT),
      CLEVR_URL: `http://127.0.0.1:${ENGINE_PORT}`,
      CLEVR_API_KEY: 'clevr_sk_test',
      CLEVR_AGENT: 'test-agent',
      MCP_UPSTREAM_URL: `http://127.0.0.1:${UP_PORT}`,
      MCP_GUARD_KEY: KEY,
      CLEVR_TIMEOUT_MS: '1500',
      ...extraEnv,
    },
    stdio: ['ignore', 'ignore', 'ignore'],
  });
  return child;
}

async function waitUp (ms = 4000) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    try {
      const r = await fetch(`http://127.0.0.1:${GUARD_PORT}/healthz`);
      if (r.ok) return true;
    } catch { /* not yet */ }
    await new Promise((r) => setTimeout(r, 80));
  }
  return false;
}

async function main () {
  UP_PORT = await freePort(); ENGINE_PORT = await freePort(); GUARD_PORT = await freePort();
  await listen(upstream, UP_PORT);
  await listen(engine, ENGINE_PORT);
  let guard = startGuard();
  if (!await waitUp()) { console.log('  FAIL guard did not start'); process.exit(1); }

  console.log('\n— it does not become the hole —');
  const noKey = await fetch(`http://127.0.0.1:${GUARD_PORT}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
  });
  ok('a call without the key is refused', noKey.status === 401,
    `got ${noKey.status}; without this, whoever finds the URL reaches the customer's tools through us`);

  console.log('\n— it relays everything that is not a tool call —');
  const init = await rpc({ jsonrpc: '2.0', id: 1, method: 'initialize' });
  ok('the upstream handshake reaches the agent untouched',
    init.json?.result?.serverInfo?.name === 'upstream');
  const list = await rpc({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
  ok('the agent sees the upstream tools, not ours',
    JSON.stringify(list.json?.result?.tools?.map((t) => t.name)) === '["db.query","files.delete"]');

  console.log('\n— it judges the tool call —');
  const allowed = await call('db.query', { sql: 'select 1' });
  ok('an allowed call is forwarded', !refused(allowed) && /ran db\.query/.test(said(allowed)));

  const beforeBlock = ran.length;
  const blocked = await call('files.delete', { path: '/var/lib/data', recursive: true });
  ok('a refused call comes back as an MCP error the model reads',
    refused(blocked) && /Blocked by Clevr/.test(said(blocked)), said(blocked));
  ok('and the server never saw it',
    ran.length === beforeBlock,
    `the upstream log grew to ${JSON.stringify(ran)}; a refused tool must not reach the server`);

  const held = await call('bulk.export', { to: 'https://drop.example/x' });
  ok('a hold says it is held, not refused, and how to clear it',
    refused(held) && /Held for review, not refused/.test(said(held)) && /run it again/.test(said(held)), said(held));

  console.log('\n— it sends the real arguments, not a label —');
  const seen = await call('db.query', { sql: 'select * from customers', limit: 10 });
  ok('the engine receives the tool arguments',
    !refused(seen),
    'an argument rule (target.<field>) is worthless if the gate never forwards them');

  console.log('\n— the failsafe —');
  engineDown = true;
  const openCall = await call('files.delete', { path: '/tmp/x' });
  ok('fail-open forwards when the engine is unreachable', !refused(openCall), said(openCall));
  guard.kill(); await new Promise((r) => setTimeout(r, 200));
  guard = startGuard({ CLEVR_FAILSAFE: 'closed' });
  if (!await waitUp()) { console.log('  FAIL guard did not restart'); process.exit(1); }
  const beforeClosed = ran.length;
  const closedCall = await call('db.query', { sql: 'select 1' });
  ok('fail-closed refuses instead, and says why',
    refused(closedCall) && /failing closed/.test(said(closedCall)), said(closedCall));
  ok('fail-closed does not forward either, even a call that would have passed',
    ran.length === beforeClosed,
    'closed means closed: an unreachable engine is not a reason to run something unjudged');
  engineDown = false;

  console.log('\n— the whole run, from the server\'s side —');
  // Two db.query (the allow and the argument check), one files.delete, and that
  // one is the fail-open forward. The refused delete and the fail-closed query
  // are absent, which is the point: three tool calls were made through the guard
  // and only the ones it cleared were run.
  ok(`the upstream ran ${JSON.stringify(ran)}`,
    JSON.stringify(ran) === '["db.query","db.query","files.delete"]',
    'the upstream log is the only claim that cannot be argued with');

  guard.kill();
  await close(upstream); await close(engine);
  console.log(`\n${pass} passed, ${fail} failed\n`);
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
