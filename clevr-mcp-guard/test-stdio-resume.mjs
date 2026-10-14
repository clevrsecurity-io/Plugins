// The stdio MCP guard, from the upstream's side: a tool call cannot ride a
// JSON-RPC batch past the gate, a hold says it is held, and an approval runs the
// identical retry, even when the agent retried before the person answered.
// Spawns the real guard between a stand-in engine and a stand-in upstream that
// records every method it receives.
//
//   node integrations/mcp-guard/test-stdio-resume.mjs
import { spawn } from 'node:child_process'
import http from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'clevr-stdio-resume-'))
const REC = path.join(TMP, 'upstream.log')
const MOCK = path.join(TMP, 'mock-upstream.mjs')
fs.writeFileSync(REC, '')
fs.writeFileSync(MOCK, `
import fs from 'node:fs'; import rl from 'node:readline'
const REC = process.argv[2]
const one = (m) => {
  try { fs.appendFileSync(REC, (m.method || '') + ' ' + (m.params?.name || '') + '\\n') } catch {}
  return m.id == null ? null : { jsonrpc: '2.0', id: m.id, result: { content: [{ type: 'text', text: 'ran ' + (m.params?.name || '') }] } }
}
rl.createInterface({ input: process.stdin }).on('line', (line) => {
  let m; try { m = JSON.parse(line) } catch { return }
  const out = Array.isArray(m) ? m.map(one).filter(Boolean) : one(m)
  if (out && (!Array.isArray(out) || out.length)) process.stdout.write(JSON.stringify(out) + '\\n')
})
`)

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let pass = 0, fail = 0
const ok = (c, n, d = '') => { if (c) { pass++; console.log('  ok  ', n) } else { fail++; console.log('  FAIL', n, d) } }

let holds = 0, approved = null, presented = null, joins = 0, savedLine = null
const engine = http.createServer((req, res) => {
  let b = ''; req.on('data', (c) => (b += c))
  req.on('end', () => {
    const body = JSON.parse(b || '{}')
    const tool = String(body.tool || '')
    let v = { effect: 'allow', decision_id: 'dec_allow', failsafe: 'open' }
    if (/delete/.test(tool)) v = { effect: 'block', reason: 'destructive', decision_id: 'dec_block' }
    if (/publish/.test(tool)) {
      presented = [...(body.resume_candidates || []), ...(body.resume ? [body.resume] : [])]
      v = approved && presented.includes(approved) ? { effect: 'allow', decision_id: 'dec_run' } : { effect: 'escalate', reason: 'a person decides.', decision_id: `dec_hold_${++holds}` }
    }
    // The engine joins a retry made while the same action waits (held_as).
    if (/invoice/.test(tool)) {
      presented = [...(body.resume_candidates || []), ...(body.resume ? [body.resume] : [])]
      v = approved && presented.includes(approved) ? { effect: 'allow', decision_id: 'dec_run' }
        : ++joins === 1 ? { effect: 'escalate', reason: 'a person decides.', decision_id: 'dec_join_1' }
          : { effect: 'escalate', reason: 'a person decides.', decision_id: `dec_joined_${joins}`, held_as: 'dec_join_1' }
    }
    // The engine compares the action line as text (routes/evaluate.js SAME_HELD_ACTION).
    if (/save/.test(tool)) {
      presented = [...(body.resume_candidates || []), ...(body.resume ? [body.resume] : [])]
      v = approved && presented.includes(approved) && body.action === savedLine ? { effect: 'allow', decision_id: 'dec_run' }
        : { effect: 'escalate', reason: 'a person decides.', decision_id: `dec_save_${++holds}` }
      savedLine ??= body.action
    }
    res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(v))
  })
})
await new Promise((r) => engine.listen(0, '127.0.0.1', r))

const guard = spawn(process.execPath,
  [path.join(HERE, 'clevr-mcp-guard.mjs'), '--', process.execPath, MOCK, REC],
  { env: { ...process.env, CLEVR_URL: `http://127.0.0.1:${engine.address().port}`, CLEVR_API_KEY: 'test-key', CLEVR_AGENT: 'test' },
    stdio: ['pipe', 'pipe', 'inherit'] })
let buf = ''
guard.stdout.on('data', (d) => { buf += d.toString() })
const msgs = () => buf.split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l) } catch { return null } }).filter(Boolean)
const send = (o) => guard.stdin.write(JSON.stringify(o) + '\n')
const reply = async (id) => {
  for (let i = 0; i < 60; i++) {
    for (const m of msgs()) {
      if (Array.isArray(m)) { const x = m.find((y) => y.id === id); if (x) return x } else if (m.id === id) return m
    }
    await sleep(50)
  }
  return null
}
const text = (m) => m?.result?.content?.[0]?.text || ''
const seen = () => fs.readFileSync(REC, 'utf8').split('\n').filter(Boolean)
const call = (id, name, args) => send({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } })

await sleep(300)
try {
  console.log('— a tool call cannot ride a batch past the gate —')
  send([{ jsonrpc: '2.0', id: 1, method: 'tools/list' }, { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'files.delete', arguments: { path: '/' } } }])
  const b1 = await reply(1), b2 = await reply(2)
  ok(b1?.error && b2?.error, 'every member of a batch carrying a tool call is refused', JSON.stringify([b1, b2]))
  ok(!seen().some((l) => l.startsWith('tools/call')), 'and the upstream received none of it', JSON.stringify(seen()))
  send([{ jsonrpc: '2.0', id: 3, method: 'tools/list' }])
  ok(!(await reply(3))?.error && seen().includes('tools/list '), 'a batch of discovery still passes')
  send({ jsonrpc: '2.0', id: 4, method: 'completion/complete', params: { ref: { type: 'ref/resource', uri: 'db://customers/{id}' }, argument: { name: 'id', value: '1' } } })
  ok((await reply(4))?.error?.code === -32601, 'completion/complete is refused, not forwarded')

  console.log('— a refusal and a hold read differently —')
  call(5, 'files.delete', { path: '/data' })
  ok(/^Blocked by Clevr/.test(text(await reply(5))), 'a block says blocked')

  console.log('— an approval runs the retry, even when the agent retried before the answer —')
  call(6, 'report.publish', { id: 42 })
  const h1 = await reply(6)
  call(7, 'report.publish', { id: 42 })
  const h2 = await reply(7)
  ok(/^Held for review, not refused/.test(text(h1)) && /make exactly the same call again/.test(text(h1)), 'a hold says held, and what clears it', text(h1))
  ok(/dec_hold_1/.test(text(h1)) && /dec_hold_2/.test(text(h2)), 'held twice before anyone answered')
  approved = 'dec_hold_1'
  call(8, 'report.publish', { id: 42 })
  ok(/ran report\.publish/.test(text(await reply(8))), 'the first hold approved, the identical retry runs')
  ok(JSON.stringify(presented) === '["dec_hold_1","dec_hold_2"]', 'both holds were presented, the latest as resume', JSON.stringify(presented))
  ok(seen().filter((l) => l === 'tools/call report.publish').length === 1, 'the upstream ran it exactly once', JSON.stringify(seen()))
  call(9, 'report.publish', { id: 42 })
  await reply(9)
  ok(JSON.stringify(presented) === '[]', 'after it ran the holds are forgotten', JSON.stringify(presented))

  console.log('— a retry joined to the request already waiting names and presents that request —')
  approved = null
  call(10, 'invoice.send', { id: 7 })
  await reply(10)
  call(11, 'invoice.send', { id: 7 })
  const j = await reply(11)
  ok(/\[dec_join_1\]/.test(text(j)) && !/dec_joined_/.test(text(j)), 'the joined retry names the request', text(j))
  call(12, 'invoice.send', { id: 7 })
  await reply(12)
  ok(JSON.stringify(presented) === '["dec_join_1"]', 'only the request is presented, however often it was retried', JSON.stringify(presented))
  approved = 'dec_join_1'
  call(13, 'invoice.send', { id: 7 })
  ok(/ran invoice\.send/.test(text(await reply(13))), 'the request approved, the identical retry runs')

  console.log('— the same arguments in another key order are the same call —')
  approved = null
  call(14, 'notes.save', { path: '/data/a.txt', content: 'x', options: { mode: 'w', encoding: 'utf8' } })
  const s1 = await reply(14)
  approved = (text(s1).match(/dec_save_\d+/) || [])[0]
  call(15, 'notes.save', { options: { encoding: 'utf8', mode: 'w' }, content: 'x', path: '/data/a.txt' })
  ok(/ran notes\.save/.test(text(await reply(15))), 'approved, the retry with its keys in another order runs', JSON.stringify(presented))
  ok(seen().filter((l) => l === 'tools/call notes.save').length === 1, 'the upstream ran it exactly once', JSON.stringify(seen()))
} finally {
  guard.kill(); engine.close()
  try { fs.rmSync(TMP, { recursive: true, force: true }) } catch {}
}
console.log(`\nRESULT: ${fail === 0 ? 'all passed' : fail + ' FAILED'} (${pass}/${pass + fail})`)
process.exit(fail === 0 ? 0 : 1)
