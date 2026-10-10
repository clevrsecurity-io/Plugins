#!/usr/bin/env node
// clevr — wire an AI coding tool to a Clevr engine, and govern what it does.
import { c, head, die } from '../lib/ui.mjs';
import * as account from '../lib/commands/account.mjs';
import * as setupCmd from '../lib/commands/setup.mjs';
import * as discoverCmd from '../lib/commands/discover.mjs';
import * as govern from '../lib/commands/govern.mjs';
import * as activityCmd from '../lib/commands/activity.mjs';
import * as postureCmd from '../lib/commands/posture.mjs';

function parse (argv) {
  const args = {};
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) { rest.push(a); continue; }
    const eq = a.indexOf('=');
    if (eq > 0) { args[a.slice(2, eq)] = a.slice(eq + 1); continue; }
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next && !next.startsWith('--')) { args[key] = next; i++; } else args[key] = true;
  }
  return { args, rest };
}

const COMMANDS = {
  login: account.login,
  logout: account.logout,
  status: account.status,
  config: account.config,

  setup: setupCmd.setup,
  uninstall: setupCmd.uninstall,
  nuke: (a, r) => setupCmd.uninstall({ ...a, all: true }, r),
  doctor: setupCmd.doctor,
  onboard: setupCmd.onboard,

  discover: discoverCmd.discover,

  policy: govern.policy,
  mandate: govern.mandate,
  agents: govern.agents,
  people: govern.people,
  keys: govern.keys,
  floor: govern.floor,
  tools: govern.tools,

  activity: activityCmd.activity,
  stats: activityCmd.stats,
  posture: postureCmd.posture,
  why: postureCmd.why,
  verify: activityCmd.verify,
  export: activityCmd.exportCmd,
};

const HELP = [
  ['Connect', [
    ['login', '--url <engine> [--email <you> | --key <clevr_sk_...>]', 'connect this machine'],
    ['logout', '', 'clear the session and key'],
    ['status', '', 'engine, account, key, what is wired, recent traffic'],
    ['config', 'show | set <engine|gateway> <url>', 'read or change the stored settings'],
  ]],
  ['Wire a tool', [
    ['onboard', '[--yes]', 'find the AI tools on this machine and wire them'],
    ['setup', '<tool>... | --all', 'wire one tool (no argument lists them)'],
    ['doctor', '[--fix]', 'check every wiring, the key and whether traffic arrives'],
    ['uninstall', '<tool>... | --all', 'take the wiring back out'],
    ['discover', '[--report] [--json] [--schedule 09:00]', 'scan this machine for AI tooling'],
  ]],
  ['Govern', [
    ['agents', 'list | get <name>', 'the agents, their posture and their drift'],
    ['mandate', 'list | get <id> | packs | install <pack>', 'the allowlist bound to an agent'],
    ['policy', 'list | get <id> | effective --agent <n> | impact', 'the rules on top of the mandate'],
    ['posture', 'show | list | diff --to <tier> | apply <tier> [--dry-run]', 'one word instead of seven settings'],
    ['floor', '', 'the safety floor that runs before every rule'],
    ['tools', '', 'what the agents have actually called'],
    ['people', 'list', 'who is in the workspace'],
    ['keys', 'list | create --name <n> [--use] | revoke <id>', 'agent keys'],
  ]],
  ['Read the record', [
    ['activity', '[--limit N] [--effect hold|block] [--agent <id>]', 'recent decisions'],
    ['stats', '[--days N]', 'the totals behind them'],
    ['why', '<decision-id>', 'explain one stop, and what to do about it'],
    ['verify', '<decision-id>', 're-check one receipt against the signed chain'],
    ['export', 'decisions [--csv] [--out <file>] [--limit N]', 'write the ledger to disk'],
  ]],
];

function help () {
  head('clevr' + c.dim('  ·  wire an AI coding tool to a Clevr engine, and govern what it does'));
  const w = Math.max(...HELP.flatMap(([, cmds]) => cmds.map(([, u]) => u.length)));
  for (const [section, cmds] of HELP) {
    console.log(c.dim(section));
    for (const [name, usage, what] of cmds) {
      console.log('  ' + c.bold(name.padEnd(10)) + ' ' + usage.padEnd(w + 2) + c.dim(what));
    }
    console.log('');
  }
  console.log(c.dim('  Start:  clevr login --url https://clevr.your-company.com --email you@company.com'));
  console.log(c.dim('          clevr onboard\n'));
}

const [cmd, ...argv] = process.argv.slice(2);
if (!cmd || cmd === 'help' || cmd === '--help' || cmd === '-h') { help(); process.exit(0); }

const run = COMMANDS[cmd];
if (!run) { console.log(c.red('Unknown command: ') + cmd); help(); process.exit(1); }

const { args, rest } = parse(argv);
try {
  await run(args, rest);
} catch (e) {
  die(e?.message || String(e));
}
