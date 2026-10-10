// activity / stats / export / verify
//
// `verify` is the one command here with no equivalent on a gateway: it asks the
// engine to re-check a decision against the signed, hash-chained ledger, so the
// record can be shown to be the one that was written at the time.
import { writeFileSync, appendFileSync, rmSync } from 'node:fs';
import * as cfgs from '../config.mjs';
import { brain, v1, rows, needEngine } from '../api.mjs';
import { c, ok, fail, warn, hint, info, head, die, table, verdict, verdictName, verdictColor } from '../ui.mjs';

// One CSV cell, safe to open in a spreadsheet. Two hazards: (1) formula injection
// -- a value beginning with = + - @ (or a tab / CR that shifts it into the next
// cell) is executed as a formula by Excel / Sheets when the file is opened, and
// agent_name / tool / action / reason are attacker-influenced, so `=HYPERLINK(...)`
// in an agent's name would run on the auditor's machine; prefix those with a quote
// so the cell stays text. (2) quoting -- values carry commas, quotes and newlines,
// so wrap per RFC 4180 (double the internal quotes), not JSON.stringify, whose \"
// escaping Excel mis-parses.
export function csvCell (v) {
  let s = v == null ? '' : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
  if (/[",\r\n]/.test(s)) s = '"' + s.replace(/"/g, '""') + '"';
  return s;
}

async function read (path) {
  const cfg = cfgs.load();
  if (cfg.key) {
    const r = await v1(cfg, path);
    if (r.ok) return r.body;
    if (r.status && r.status !== 401 && r.status !== 403) die('Engine said ' + r.status + ': ' + (r.error || ''));
  }
  if (cfg.session) {
    const r = await brain(cfg, path);
    if (r.ok) return r.body;
  }
  die('Not connected. Run: clevr login');
}

const EFFECT_ALIAS = { hold: 'escalate,step_up', masked: 'redact', logged: 'log' };

export async function activity (args) {
  const limit = Number(args.limit || 20);
  const q = new URLSearchParams({ limit: String(limit) });
  if (args.effect) q.set('effect', EFFECT_ALIAS[args.effect] || args.effect);
  if (args.agent) q.set('agent_id', args.agent);
  const list = rows(await read('/decisions?' + q), 'decisions');

  head('Recent decisions  ' + c.dim(list.length + ' shown'));
  if (!list.length) { hint('Nothing yet. Run one tool call in a wired tool.'); return; }
  table(list, [
    { label: 'when', get: (d) => String(d.created_at || '').slice(11, 19), max: 8, color: c.dim },
    { label: 'verdict', get: (d) => verdictName(d.effect), max: 9, color: (s) => verdictColor(s)(s) },
    { label: 'agent', get: (d) => d.agent_name || d.agent_id || '', max: 20, color: c.dim },
    { label: 'tool', get: (d) => d.tool || d.action_type || '', max: 26 },
    { label: 'why', get: (d) => d.reason || d.matched_policy_name || '', max: 58, color: c.dim },
  ]);
  console.log('');
  const held = list.filter((d) => ['escalate', 'step_up'].includes(String(d.effect)));
  if (held.length) hint(held.length + ' waiting for a person. Approve them in the console under Activity > Approvals.');
  hint('One decision in full:  clevr verify <id>');
  console.log('');
}

export async function stats (args) {
  const s = await read('/decisions/stats' + (args.days ? '?days=' + Number(args.days) : ''));
  head('Traffic');
  const flat = Object.entries(s || {}).filter(([, v]) => typeof v === 'number' || typeof v === 'string');
  if (flat.length) table(flat.map(([k, v]) => ({ k, v })), [
    { label: 'measure', get: (r) => r.k.replace(/_/g, ' '), max: 30 },
    { label: 'value', get: (r) => r.v, max: 20 },
  ]);
  else console.log(JSON.stringify(s, null, 2));
  console.log('');
}

export async function verify (args, rest) {
  const id = rest[0];
  if (!id) die('Usage: clevr verify <decision-id>');
  const d = await read('/decisions/' + encodeURIComponent(id));
  head('Decision ' + id);
  info(c.dim('verdict  ') + verdict(d.effect));
  info(c.dim('agent    ') + (d.agent_name || d.agent_id || ''));
  info(c.dim('tool     ') + (d.tool || d.action_type || ''));
  info(c.dim('when     ') + (d.created_at || ''));
  if (d.reason) info(c.dim('why      ') + d.reason);
  console.log('');

  const r = await read('/decisions/' + encodeURIComponent(id) + '/verify');
  if (!r) return;
  if (args.json) { console.log(JSON.stringify(r, null, 2)); return; }

  // Four independent checks, reported separately: a single "valid" would hide
  // which one failed, and which one failed is the whole point.
  const checks = [
    ['signature', r.signature_valid, 'Ed25519 over the decision content'],
    ['content', r.columns_valid, r.mismatched_columns?.length ? 'changed since it was signed: ' + r.mismatched_columns.join(', ') : 'every signed column still matches'],
    ['chain', r.linkage_valid, r.chain_origin ? 'first entry in this workspace\u2019s chain' : r.missing_predecessor ? 'the entry before it is missing' : 'follows ' + String(r.prev_hash || '').slice(0, 16)],
    ['tamper-evident', r.tamper_evident, 'position ' + r.seq + ' in the append-only ledger'],
  ];
  for (const [name, good, detail] of checks) {
    console.log('      ' + (good ? c.green('\u2713') : c.red('\u2717')) + ' ' + name.padEnd(15) + c.dim(detail));
  }
  console.log('');
  const allGood = checks.every(([, g]) => g);
  if (allGood) ok('This is the record as written. Anyone with the workspace public key can re-check it offline.');
  else fail('This receipt does not hold up. ' + (r.error || 'Treat the ledger as tampered and raise it.'));
  if (r.redacted) warn('Content was redacted on ' + String(r.redacted_at).slice(0, 10) + (r.redacted_by ? ' by ' + r.redacted_by : '') + '. The signature covers the redaction, not the original text.');
  console.log('');
  hint('Full receipt:  clevr verify ' + id + ' --json');
  console.log('');
}

// Pages through the decision list and writes it locally. There is no server-side
// export job, so this is the honest shape: your data, on your disk, now.
export async function exportCmd (args, rest) {
  needEngine(cfgs.load());
  const kind = rest[0] || 'decisions';
  if (kind !== 'decisions') die('Exportable: decisions');
  const out = args.out || 'clevr-decisions.' + (args.csv ? 'csv' : 'jsonl');
  const want = Number(args.limit || 5000);
  const page = 500;

  rmSync(out, { force: true });
  let written = 0;
  let before = null;
  const cols = ['id', 'created_at', 'agent_id', 'agent_name', 'tool', 'action_type', 'effect', 'reason', 'matched_policy_name', 'enforced'];
  if (args.csv) writeFileSync(out, cols.join(',') + '\n');

  while (written < want) {
    const q = new URLSearchParams({ limit: String(Math.min(page, want - written)) });
    if (args.effect) q.set('effect', EFFECT_ALIAS[args.effect] || args.effect);
    if (before) q.set('before', before);
    const list = rows(await read('/decisions?' + q), 'decisions');
    if (!list.length) break;
    const body = args.csv
      ? list.map((d) => cols.map((k) => csvCell(d[k])).join(',')).join('\n') + '\n'
      : list.map((d) => JSON.stringify(d)).join('\n') + '\n';
    appendFileSync(out, body);
    written += list.length;
    const last = list[list.length - 1];
    if (!last?.created_at || last.created_at === before) break;
    before = last.created_at;
    if (list.length < page) break;
    process.stdout.write('\r      ' + written + ' rows...');
  }
  process.stdout.write('\r');
  ok(written + ' decisions written to ' + out);
  hint('Each row carries its own signature. `clevr verify <id>` re-checks one against the chain.');
}
