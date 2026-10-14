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
const seenMethods = [];              // every method the upstream actually received
const upstream = http.createServer(async (req, res) => {
  const c = []; for await (const x of req) c.push(x);
  const m = JSON.parse(Buffer.concat(c).toString() || '{}');
  // A batch is answered member by member, so a tool call that rides one runs.
  if (Array.isArray(m)) {
    for (const x of m) { seenMethods.push(x.method); if (x.method === 'tools/call') ran.push(x.params?.name); }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify(m.filter((x) => x.id != null).map((x) => ({ jsonrpc: '2.0', id: x.id, result: { content: [{ type: 'text', text: `ran ${x.params?.name}` }] } }))));
  }
  seenMethods.push(m.method);
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
// A hold the engine spends only when its approved id is among those presented.
let holds = 0, approved = null, presented = null, joins = 0, savedLine = null;
const engine = http.createServer(async (req, res) => {
  if (engineDown) { req.destroy(); return; }
  const c = []; for await (const x of req) c.push(x);
  const body = JSON.parse(Buffer.concat(c).toString() || '{}');
  const tool = String(body.tool || '');
  if (/publish/.test(tool)) {
    presented = [...(body.resume_candidates || []), ...(body.resume ? [body.resume] : [])];
    const run = approved && presented.includes(approved);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify(run ? { effect: 'allow', decision_id: 'dec_run' } : { effect: 'escalate', reason: 'a person decides', decision_id: `dec_hold_${++holds}` }));
  }
  // The engine joins a retry made while the same action waits (held_as).
  if (/invoice/.test(tool)) {
    presented = [...(body.resume_candidates || []), ...(body.resume ? [body.resume] : [])];
    const run = approved && presented.includes(approved);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify(run ? { effect: 'allow', decision_id: 'dec_run' }
      : ++joins === 1 ? { effect: 'escalate', reason: 'a person decides', decision_id: 'dec_join_1' }
        : { effect: 'escalate', reason: 'a person decides', decision_id: `dec_joined_${joins}`, held_as: 'dec_join_1' }));
  }
  // The engine compares the action line as text (routes/evaluate.js SAME_HELD_ACTION).
  if (/save/.test(tool)) {
    presented = [...(body.resume_candidates || []), ...(body.resume ? [body.resume] : [])];
    const run = approved && presented.includes(approved) && body.action === savedLine;
    savedLine ??= body.action;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify(run ? { effect: 'allow', decision_id: 'dec_run' } : { effect: 'escalate', reason: 'a person decides', decision_id: `dec_save_${++holds}` }));
  }
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

  console.log('\n— it refuses the data methods it cannot govern, not relay them —');
  const errCode = (r) => r.json?.error?.code;
  for (const method of ['resources/read', 'resources/subscribe', 'prompts/get', 'completion/complete']) {
    const before = seenMethods.length;
    const r = await rpc({ jsonrpc: '2.0', id: 9, method, params: { uri: 'file:///etc/passwd' } });
    ok(`${method} is refused with a JSON-RPC error (-32601)`, errCode(r) === -32601, JSON.stringify(r.json));
    ok(`${method} never reached the upstream`, !seenMethods.slice(before).includes(method),
      `upstream saw ${JSON.stringify(seenMethods)}; a data pull we cannot govern must not be relayed`);
  }
  const rlist = await rpc({ jsonrpc: '2.0', id: 10, method: 'resources/list' });
  ok('resources/list (discovery) is still relayed, not refused',
    errCode(rlist) !== -32601 && seenMethods.includes('resources/list'));

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
    refused(held) && /Held for review, not refused/.test(said(held)) && /make exactly the same call again/.test(said(held)), said(held));

  console.log('\n— it sends the real arguments, not a label —');
  const seen = await call('db.query', { sql: 'select * from customers', limit: 10 });
  ok('the engine receives the tool arguments',
    !refused(seen),
    'an argument rule (target.<field>) is worthless if the gate never forwards them');

  console.log('\n— a tool call cannot ride a batch past the gate —');
  const beforeBatch = ran.length;
  const batch = await rpc([{ jsonrpc: '2.0', id: 21, method: 'tools/list' }, { jsonrpc: '2.0', id: 22, method: 'tools/call', params: { name: 'files.delete', arguments: { path: '/' } } }]);
  ok('a batch carrying a tool call is refused', Array.isArray(batch.json) && batch.json.every((r) => r.error), JSON.stringify(batch.json));
  ok('and nothing in it reached the server', ran.length === beforeBatch, `the upstream ran ${JSON.stringify(ran.slice(beforeBatch))}`);
  const listBatch = await rpc([{ jsonrpc: '2.0', id: 23, method: 'tools/list' }]);
  ok('a batch of discovery only is still relayed', Array.isArray(listBatch.json) && !listBatch.json[0]?.error, JSON.stringify(listBatch.json));

  console.log('\n— an approval runs the retry, even when the agent retried before the answer —');
  const h1 = await call('report.publish', { id: 42 });
  const h2 = await call('report.publish', { id: 42 });
  ok('held twice before anyone answered', refused(h1) && refused(h2) && /dec_hold_1/.test(said(h1)) && /dec_hold_2/.test(said(h2)), said(h2));
  approved = 'dec_hold_1';
  const beforeRun = ran.length;
  const run = await call('report.publish', { id: 42 });
  ok('the first hold approved, the identical retry runs', !refused(run) && ran.length === beforeRun + 1, said(run));
  ok('both holds were presented, the latest as resume', JSON.stringify(presented) === '["dec_hold_1","dec_hold_2"]', JSON.stringify(presented));
  const changed = await call('report.publish', { id: 43 });
  ok('other arguments present nothing', refused(changed) && JSON.stringify(presented) === '[]', JSON.stringify(presented));
  const again = await call('report.publish', { id: 42 });
  ok('after it ran the holds are forgotten', refused(again) && JSON.stringify(presented) === '[]', JSON.stringify(presented));
  approved = null;

  console.log('\n— a retry joined to the request already waiting names and presents that request —');
  await call('invoice.send', { id: 7 });
  const joined = await call('invoice.send', { id: 7 });
  ok('the joined retry names the request', refused(joined) && /\[dec_join_1\]/.test(said(joined)) && !/dec_joined_/.test(said(joined)), said(joined));
  await call('invoice.send', { id: 7 });
  ok('only the request is presented, however often it was retried', JSON.stringify(presented) === '["dec_join_1"]', JSON.stringify(presented));
  approved = 'dec_join_1';
  const beforeJoinRun = ran.length;
  const joinRun = await call('invoice.send', { id: 7 });
  ok('the request approved, the identical retry runs', !refused(joinRun) && ran.length === beforeJoinRun + 1, said(joinRun));
  approved = null;

  console.log('\n— the same arguments in another key order are the same call —');
  const s1 = await call('notes.save', { path: '/data/a.txt', content: 'x', options: { mode: 'w', encoding: 'utf8' } });
  approved = (said(s1).match(/dec_save_\d+/) || [])[0];
  const beforeSave = ran.length;
  const s2 = await call('notes.save', { options: { encoding: 'utf8', mode: 'w' }, content: 'x', path: '/data/a.txt' });
  ok('approved, the retry with its keys in another order runs once', !refused(s2) && ran.length === beforeSave + 1, said(s2));
  approved = null;

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
  // Two db.query (the allow and the argument check), each approved retry once
  // (report.publish, invoice.send, notes.save), one files.delete, and that
  // one is the fail-open forward. The refused delete and the fail-closed query
  // are absent, which is the point: three tool calls were made through the guard
  // and only the ones it cleared were run.
  ok(`the upstream ran ${JSON.stringify(ran)}`,
    JSON.stringify(ran) === '["db.query","db.query","report.publish","invoice.send","notes.save","files.delete"]',
    'the upstream log is the only claim that cannot be argued with');

  guard.kill();
  await close(upstream); await close(engine);
  console.log(`\n${pass} passed, ${fail} failed\n`);
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
