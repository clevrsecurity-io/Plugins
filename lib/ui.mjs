// Terminal output: colour, symbols, tables, prompts.
import { createInterface } from 'node:readline';

// Built at runtime rather than written as literals so no control character ever
// appears in this source file (some tooling refuses to handle files that do).
const ESC = String.fromCharCode(27) + '[';
const on = process.stdout.isTTY && !process.env.NO_COLOR;
const paint = (code) => (s) => (on ? ESC + code + 'm' + s + ESC + '0m' : String(s));

export const c = {
  bold: paint('1'), dim: paint('2'),
  green: paint('32'), red: paint('31'), yellow: paint('33'),
  blue: paint('34'), violet: paint('35'), cyan: paint('36'),
};

export const ok = (s) => console.log(c.green('  ok  ') + s);
export const fail = (s) => console.log(c.red(' fail ') + s);
export const warn = (s) => console.log(c.yellow(' note ') + s);
export const skip = (s) => console.log(c.dim('  --  ' + s));
export const info = (s) => console.log('      ' + s);
export const hint = (s) => console.log(c.dim('      ' + s));
export const head = (s) => console.log('\n' + c.bold(s) + '\n');

// The wordmark, for the two moments a person meets the CLI for the first time
// (login, onboard). Violet on a terminal, plain in a pipe. Never on every
// command: a banner that repeats stops being read.
const VIOLET = paint('38;5;99');
export function banner (tagline = 'Runtime governance for AI agents') {
  const mark = [
    '   ██████╗ ██╗     ███████╗ ██╗   ██╗ ██████╗',
    '  ██╔════╝ ██║     ██╔════╝ ██║   ██║ ██╔══██╗',
    '  ██║      ██║     █████╗   ██║   ██║ ██████╔╝',
    '  ██║      ██║     ██╔══╝   ╚██╗ ██╔╝ ██╔══██╗',
    '  ╚██████╗ ███████╗███████╗  ╚████╔╝  ██║  ██║',
    '   ╚═════╝ ╚══════╝╚══════╝   ╚═══╝   ╚═╝  ╚═╝',
  ];
  console.log('');
  for (const l of mark) console.log(VIOLET(l));
  console.log(c.dim('  ' + tagline) + '\n');
}

export function die (msg, code = 1) { fail(msg); process.exit(code); }

// One verdict vocabulary, the console's, with one colour each. The wire words a
// route happens to return (step_up, deny, observe) are folded into it here so the
// CLI never shows two names for the same outcome.
const VERDICT = {
  allow: ['Allow', c.green],
  log: ['Logged', c.dim], observe: ['Logged', c.dim], audit: ['Logged', c.dim],
  escalate: ['Hold', c.yellow], step_up: ['Hold', c.yellow], hold: ['Hold', c.yellow],
  block: ['Block', c.red], deny: ['Block', c.red],
  redact: ['Masked', c.violet], mask: ['Masked', c.violet],
  alert: ['Alert', c.yellow],
};
const entry = (e) => VERDICT[String(e || '').trim().toLowerCase()];
export const verdictName = (e) => entry(e)?.[0] || String(e || '').trim() || '-';
export const verdictColor = (e) => entry(e)?.[1] || ((s) => s);
export const verdict = (e) => verdictColor(e)(verdictName(e));

export function table (rows, cols) {
  if (!rows.length) { hint('Nothing to show.'); return; }
  const w = cols.map((col) => Math.max(col.label.length, ...rows.map((r) => String(col.get(r) ?? '').length)));
  const cap = (s, n) => (s.length > n ? s.slice(0, n - 1) + '…' : s.padEnd(n));
  console.log(c.dim(cols.map((col, i) => cap(col.label, Math.min(w[i], col.max || 40))).join('  ')));
  for (const r of rows) {
    console.log(cols.map((col, i) => {
      const raw = String(col.get(r) ?? '');
      const cell = cap(raw, Math.min(w[i], col.max || 40));
      return col.color ? col.color(cell) : cell;
    }).join('  '));
  }
}

export function ask (question, { silent = false } = {}) {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    if (!silent) return rl.question(question, (a) => { rl.close(); resolve(a.trim()); });
    // Hidden input: suppress the echo the readline interface would write.
    const write = rl._writeToOutput?.bind(rl);
    rl._writeToOutput = (s) => { if (s.includes(question)) write(s); };
    rl.question(question, (a) => { rl.close(); process.stdout.write('\n'); resolve(a); });
  });
}

export async function confirm (question) {
  const a = (await ask(question + ' [y/N] ')).toLowerCase();
  return a === 'y' || a === 'yes';
}
