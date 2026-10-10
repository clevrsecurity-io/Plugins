// The tool matrix: one entry per surface the CLI can wire, and nothing the
// surface cannot actually do.
//
// Four mechanisms, in descending order of what they can stop:
//
//   hook     a synchronous pre-tool gate. The verdict returns before the tool
//            runs, so Block is a real Block.
//   mcp      the stdio MCP guard wraps a server. Blocks the call, but only for
//            tools reached over MCP.
//   gateway  the model conversation is routed through the Clevr gateway. Sees
//            prompts and completions, not the host's local tool calls.
//   exec     an exit-code gate you wrap a command with. Records and signals;
//            it cannot deny a tool the host decided to run on its own.
import { existsSync, copyFileSync, mkdirSync, chmodSync, readFileSync, writeFileSync, rmSync, appendFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { platform } from 'node:process';
import { execFileSync } from 'node:child_process';
import { HOME, DIR, asset, readJson, writeJson, trimSlash } from './config.mjs';

const TOOLS = join(DIR, 'tools');
const CC_SETTINGS = join(HOME, '.claude', 'settings.json');
const CURSOR_HOOKS = join(HOME, '.cursor', 'hooks.json');
// Copilot CLI reads user-level hooks from ~/.copilot/hooks/*.json (COPILOT_HOME
// overrides the directory). One file per hook set, so ours lives on its own and
// a customer's other hooks are untouched.
const COPILOT_HOOKS = join(process.env.COPILOT_HOME || join(HOME, '.copilot'), 'hooks', 'clevr.json');
const AUGMENT_SETTINGS = join(HOME, '.augment', 'settings.json');
const GEMINI_SETTINGS = join(HOME, '.gemini', 'settings.json');
const CODEX_CONFIG = join(HOME, '.codex', 'config.toml');

const DESKTOP_CONFIG = platform === 'darwin'
  ? join(HOME, 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json')
  : platform === 'win32'
    ? join(process.env.APPDATA || join(HOME, 'AppData', 'Roaming'), 'Claude', 'claude_desktop_config.json')
    : join(HOME, '.config', 'Claude', 'claude_desktop_config.json');

const COPILOT_CONFIG = platform === 'darwin'
  ? join(HOME, 'Library', 'Application Support', 'Code', 'User', 'mcp.json')
  : platform === 'win32'
    ? join(process.env.APPDATA || join(HOME, 'AppData', 'Roaming'), 'Code', 'User', 'mcp.json')
    : join(HOME, '.config', 'Code', 'User', 'mcp.json');

const R = {
  ok: (msg) => ({ level: 'ok', msg }),
  note: (msg) => ({ level: 'note', msg }),
  fail: (msg) => ({ level: 'fail', msg }),
  hint: (msg) => ({ level: 'hint', msg }),
};

const check = (name, state, detail) => ({ name, state, detail });

function copyDir (src, dest, files) {
  mkdirSync(dest, { recursive: true });
  const copied = [];
  for (const f of files) {
    const from = join(src, f);
    if (!existsSync(from)) continue;
    copyFileSync(from, join(dest, f));
    if (f.endsWith('.mjs')) { try { chmodSync(join(dest, f), 0o755); } catch { /* Windows */ } }
    copied.push(f);
  }
  return copied;
}

// A hook entry we own, so uninstall can find it again without touching the
// user's own hooks.
const isOurs = (x) => JSON.stringify(x || '').includes('.clevr') || JSON.stringify(x || '').includes('clevr-gate') || JSON.stringify(x || '').includes('clevr-hooks');

// ── Claude Code ──────────────────────────────────────────────────────────────
// Installed directly rather than through the plugin marketplace: same hook
// scripts, no network, and `clevr uninstall` can take them back out.
// The same seven the plugin's hooks.json declares. The CLI used to register four
// of them, so a CLI-installed Claude Code never scanned what a tool handed back
// (the indirect-injection channel) and never told the model it was governed.
// UserPromptExpansion is a skill or command a person types as /name: it never
// reaches PreToolUse, so without it a typed skill loaded unchecked.
const CC_HOOKS = [
  ['SessionStart', 'clevr-session.mjs', null],
  ['UserPromptSubmit', 'clevr-prompt.mjs', null],
  ['UserPromptExpansion', 'clevr-expand.mjs', null],
  ['PreToolUse', 'clevr-gate.mjs', '*'],
  ['PostToolUse', 'clevr-result.mjs', '*'],
  ['SubagentStart', 'clevr-subagent.mjs', null],
  ['Stop', 'clevr-stop.mjs', null],
];
// The shared helpers and the detached sender they start (clevr-send.mjs): a
// file the hooks reach that is not a hook of its own still has to be shipped.
const CC_FILES = [...CC_HOOKS.map(([, f]) => f), 'clevr-common.mjs', 'clevr-send.mjs'];

const claudeCode = {
  id: 'claude-code',
  label: 'Claude Code',
  mode: 'hook',
  mechanism: 'Synchronous PreToolUse hook, plus the prompt, every tool result, subagents and the reply.',
  limit: 'Full enforcement: a Block returns before the tool runs.',
  install (cfg) {
    const src = asset('claude-code/hooks');
    if (!src) return [R.fail('The Claude Code hooks are not in this install.')];
    const dest = join(TOOLS, 'claude-code');
    const copied = copyDir(src, dest, CC_FILES);
    const s = readJson(CC_SETTINGS) || {};
    s.env = { ...(s.env || {}), CLEVR_URL: cfg.url, CLEVR_API_KEY: cfg.key, CLEVR_AGENT: 'claude-code' };
    s.hooks = s.hooks || {};
    for (const [event, file, matcher] of CC_HOOKS) {
      if (!copied.includes(file)) continue;
      const entry = { ...(matcher ? { matcher } : {}), hooks: [{ type: 'command', command: 'node ' + JSON.stringify(join(dest, file)), timeout: 10 }] };
      const list = (s.hooks[event] || []).filter((x) => !isOurs(x));
      list.push(entry);
      s.hooks[event] = list;
    }
    writeJson(CC_SETTINGS, s);
    const registered = CC_HOOKS.filter(([, f]) => copied.includes(f)).length;
    return [
      R.ok('Hook scripts in ' + dest),
      R.ok('Registered ' + registered + ' hooks and the engine settings in ' + CC_SETTINGS),
      R.hint('Restart Claude Code so it re-reads its settings.'),
    ];
  },
  uninstall () {
    const out = [];
    const s = readJson(CC_SETTINGS);
    if (s) {
      let touched = false;
      for (const [event] of CC_HOOKS) {
        if (!s.hooks?.[event]) continue;
        const kept = s.hooks[event].filter((x) => !isOurs(x));
        if (kept.length !== s.hooks[event].length) touched = true;
        if (kept.length) s.hooks[event] = kept; else delete s.hooks[event];
      }
      for (const k of ['CLEVR_URL', 'CLEVR_API_KEY', 'CLEVR_AGENT']) {
        if (s.env && k in s.env) { delete s.env[k]; touched = true; }
      }
      if (touched) { writeJson(CC_SETTINGS, s); out.push(R.ok('Removed the Clevr hooks and settings from ' + CC_SETTINGS)); }
    }
    rmSync(join(TOOLS, 'claude-code'), { recursive: true, force: true });
    return out.length ? out : [R.hint('Nothing to remove for Claude Code.')];
  },
  check (cfg) {
    const s = readJson(CC_SETTINGS);
    const dest = join(TOOLS, 'claude-code');
    return [
      check('config', s?.hooks && Object.values(s.hooks).some((l) => (l || []).some(isOurs)) ? 'ok' : 'miss', CC_SETTINGS),
      check('hook script', existsSync(join(dest, 'clevr-gate.mjs')) ? 'ok' : 'miss', dest),
      check('key', s?.env?.CLEVR_API_KEY ? (s.env.CLEVR_API_KEY === cfg.key ? 'ok' : 'warn') : 'miss',
        s?.env?.CLEVR_API_KEY && s.env.CLEVR_API_KEY !== cfg.key ? 'a different key than the one you are logged in with' : 'in settings.json env'),
      check('mode', s?.env?.ANTHROPIC_BASE_URL ? 'ok' : 'info', s?.env?.ANTHROPIC_BASE_URL ? 'hook + gateway' : 'hook only'),
    ];
  },
};

// ── Claude Code, model traffic through the gateway ───────────────────────────
const claudeCodeGateway = {
  id: 'claude-code-gateway',
  label: 'Claude Code (model traffic)',
  mode: 'gateway',
  mechanism: 'ANTHROPIC_BASE_URL points at the Clevr gateway, which evaluates each turn.',
  limit: 'Sees the conversation, not the local tool call. Pair it with `setup claude-code` for both.',
  needsGateway: true,
  install (cfg) {
    if (!cfg.gateway) return [R.fail('No gateway URL. Set one: clevr config set gateway <url>')];
    const s = readJson(CC_SETTINGS) || {};
    s.env = { ...(s.env || {}), ANTHROPIC_BASE_URL: trimSlash(cfg.gateway) + '/anthropic', ANTHROPIC_AUTH_TOKEN: cfg.key };
    writeJson(CC_SETTINGS, s);
    return [R.ok('Model traffic routed through ' + cfg.gateway), R.hint('The gateway must be reachable from this machine or Claude Code cannot call a model at all.')];
  },
  uninstall () {
    const s = readJson(CC_SETTINGS);
    if (!s?.env) return [R.hint('Nothing to remove.')];
    delete s.env.ANTHROPIC_BASE_URL; delete s.env.ANTHROPIC_AUTH_TOKEN;
    writeJson(CC_SETTINGS, s);
    return [R.ok('Model traffic points back at the provider.')];
  },
  check () {
    const s = readJson(CC_SETTINGS);
    return [check('config', s?.env?.ANTHROPIC_BASE_URL ? 'ok' : 'miss', s?.env?.ANTHROPIC_BASE_URL || CC_SETTINGS)];
  },
};

// ── Cursor ───────────────────────────────────────────────────────────────────
const cursor = {
  id: 'cursor',
  label: 'Cursor',
  mode: 'hook',
  mechanism: 'Four hooks: the prompt, every tool call, every tool result, and the reply.',
  limit: 'The prompt and tool calls can be stopped. A reply is recorded only: Cursor gives afterAgentResponse no output, and hands it no system prompt, so the prompt-leak check cannot run there.',
  // Cursor takes its key from the environment it was launched with, not from a
  // config file, so there is nothing per-workspace to write here.
  install () {
    const src = asset('cursor/hooks');
    if (!src) return [R.fail('The Cursor hooks are not in this install.')];
    const dest = join(HOME, '.cursor', 'clevr-hooks');
    copyDir(src, dest, ['clevr-gate.mjs', 'clevr-prompt.mjs', 'clevr-result.mjs', 'clevr-answer.mjs']);
    // The hooks import a SIBLING; the repo copy is a re-export, so ship the real
    // shared file to the destination.
    const common = asset('claude-code/hooks');
    if (common) copyDir(common, dest, ['clevr-common.mjs', 'clevr-send.mjs']);
    const h = readJson(CURSOR_HOOKS) || { version: 1, hooks: {} };
    h.hooks = h.hooks || {};
    const node = (f) => ({ command: 'node ' + JSON.stringify(join(dest, f)) });
    for (const [event, file] of [
      ['beforeSubmitPrompt', 'clevr-prompt.mjs'],
      ['preToolUse', 'clevr-gate.mjs'],
      ['postToolUse', 'clevr-result.mjs'],
      ['afterAgentResponse', 'clevr-answer.mjs'],
    ]) {
      h.hooks[event] = (h.hooks[event] || []).filter((x) => !isOurs(x));
      h.hooks[event].push(node(file));
    }
    writeJson(CURSOR_HOOKS, h);
    return [
      R.ok('Hook scripts in ' + dest),
      R.ok('Registered beforeSubmitPrompt, preToolUse, postToolUse and afterAgentResponse in ' + CURSOR_HOOKS + ' (your own hooks kept)'),
      R.note('Cursor reads the environment it was launched from. Restart it from a shell that has sourced ~/.clevr/env.sh, or relaunch it after opening a new terminal.'),
    ];
  },
  uninstall () {
    const h = readJson(CURSOR_HOOKS);
    const out = [];
    let changed = false;
    for (const event of ['beforeSubmitPrompt', 'preToolUse', 'postToolUse', 'afterAgentResponse']) {
      if (!h?.hooks?.[event]) continue;
      const kept = h.hooks[event].filter((x) => !isOurs(x));
      if (kept.length !== h.hooks[event].length) { changed = true; if (kept.length) h.hooks[event] = kept; else delete h.hooks[event]; }
    }
    if (changed) { writeJson(CURSOR_HOOKS, h); out.push(R.ok('Removed the Clevr hooks from ' + CURSOR_HOOKS)); }
    rmSync(join(HOME, '.cursor', 'clevr-hooks'), { recursive: true, force: true });
    return out.length ? out : [R.hint('Nothing to remove for Cursor.')];
  },
  check () {
    const h = readJson(CURSOR_HOOKS);
    const dest = join(HOME, '.cursor', 'clevr-hooks');
    return [
    ...['beforeSubmitPrompt', 'preToolUse', 'postToolUse', 'afterAgentResponse'].map((e) =>
      check(e, (h?.hooks?.[e] || []).some(isOurs) ? 'ok' : 'miss', CURSOR_HOOKS)),
      check('hook scripts', ['clevr-gate.mjs', 'clevr-prompt.mjs', 'clevr-result.mjs', 'clevr-answer.mjs'].every((f) => existsSync(join(dest, f))) ? 'ok' : 'miss', dest),
      check('key', process.env.CLEVR_API_KEY ? 'ok' : 'warn', process.env.CLEVR_API_KEY ? 'exported in this shell' : 'not exported in this shell; Cursor inherits it at launch'),
    ];
  },
};

// ── GitHub Copilot CLI ───────────────────────────────────────────────────────
// Separate from the `copilot` target, which wraps MCP servers for agent mode in
// the IDE. This one is the CLI's own preToolUse hook, and it is a different
// class of coverage: MCP wrapping sees MCP tools, the hook sees `bash` and every
// file edit, which is where a coding agent's blast radius actually is.
const copilotCli = {
  id: 'copilot-cli',
  label: 'GitHub Copilot CLI',
  mode: 'hook',
  mechanism: 'Three hooks: the prompt, every tool call, every tool result.',
  limit: 'The CLI, not the IDE extension. A tool call can be stopped and a poisoned result withheld; a prompt is recorded only, because Copilot honours a decision from userPromptSubmitted for SDK hooks and not for a command hook.',
  agent: 'github-copilot',
  install () {
    const src = asset('github-copilot/hooks');
    if (!src) return [R.fail('The Copilot hooks are not in this install.')];
    const dest = join(HOME, '.clevr', 'tools');
    copyDir(src, dest, ['clevr-copilot-gate.mjs', 'clevr-copilot-prompt.mjs', 'clevr-copilot-result.mjs']);
    // The hooks import the shared helpers; ship them beside them so the tools dir
    // is self-contained and the import resolves without the repo.
    const common = asset('claude-code/hooks');
    if (common) copyDir(common, dest, ['clevr-common.mjs', 'clevr-send.mjs']);
    const gate = join(dest, 'clevr-copilot-gate.mjs');
    const cmd = (f) => {
      const line = 'node ' + JSON.stringify(join(dest, f));
      return [{ type: 'command', bash: line, powershell: line, cwd: '.', timeoutSec: 10 }];
    };
    mkdirSync(dirname(COPILOT_HOOKS), { recursive: true });
    writeJson(COPILOT_HOOKS, {
      version: 1,
      hooks: {
        userPromptSubmitted: cmd('clevr-copilot-prompt.mjs'),
        preToolUse: cmd('clevr-copilot-gate.mjs'),
        postToolUse: cmd('clevr-copilot-result.mjs'),
      },
    });
    return [
      R.ok('Hook scripts in ' + dest),
      R.ok('Registered userPromptSubmitted, preToolUse and postToolUse in ' + COPILOT_HOOKS),
      R.note('Copilot reads the environment it was launched from. Open a new terminal, or source ~/.clevr/env.sh first.'),
    ];
  },
  uninstall () {
    const out = [];
    if (existsSync(COPILOT_HOOKS)) { rmSync(COPILOT_HOOKS, { force: true }); out.push(R.ok('Removed ' + COPILOT_HOOKS)); }
    for (const f of ['clevr-copilot-gate.mjs', 'clevr-copilot-prompt.mjs', 'clevr-copilot-result.mjs']) {
      rmSync(join(HOME, '.clevr', 'tools', f), { force: true });
    }
    return out.length ? out : [R.hint('Nothing to remove for Copilot CLI.')];
  },
  check () {
    const h = readJson(COPILOT_HOOKS);
    const gate = join(HOME, '.clevr', 'tools', 'clevr-copilot-gate.mjs');
    const wired = (h?.hooks?.preToolUse || []).some((x) => /clevr-copilot-gate/.test(JSON.stringify(x)));
    return [
      check('config', wired ? 'ok' : 'miss', COPILOT_HOOKS),
      check('hook script', existsSync(gate) ? 'ok' : 'miss', gate),
      check('key', process.env.CLEVR_API_KEY ? 'ok' : 'warn', process.env.CLEVR_API_KEY ? 'exported in this shell' : 'not exported in this shell; Copilot inherits it at launch'),
    ];
  },
};

// ── Augment ──────────────────────────────────────────────────────────────────
const augment = {
  id: 'augment',
  label: 'Augment CLI',
  mode: 'hook',
  mechanism: 'Three hooks: every tool call, every tool result, and the conversation at the end of each turn.',
  limit: 'Augment implements deny only, with no inline ask, so a Hold is returned as a refusal that says it is held and how to clear it. It has no prompt event either: the chat is read at Stop, one turn late, so a prompt is recorded and never stopped.',
  agent: 'augment',
  install (cfg) {
    const src = asset('augment/hooks');
    if (!src) return [R.fail('The Augment hooks are not in this install.')];
    const dest = join(HOME, '.clevr', 'tools');
    copyDir(src, dest, ['clevr-augment-gate.mjs', 'clevr-augment-result.mjs', 'clevr-augment-stop.mjs']);
    const common = asset('claude-code/hooks');
    if (common) copyDir(common, dest, ['clevr-common.mjs', 'clevr-send.mjs']);
    const gate = join(dest, 'clevr-augment-gate.mjs');
    const h = readJson(AUGMENT_SETTINGS) || {};
    h.hooks = h.hooks || {};
    // `.*` is every tool: the shell and the editor are the point, not MCP alone.
    // Stop takes no matcher, which is why it is entered without one.
    for (const [event, file, matcher] of [
      ['PreToolUse', 'clevr-augment-gate.mjs', '.*'],
      ['PostToolUse', 'clevr-augment-result.mjs', '.*'],
      ['Stop', 'clevr-augment-stop.mjs', null],
    ]) {
      const entry = { ...(matcher ? { matcher } : {}), hooks: [{ type: 'command', command: 'node ' + JSON.stringify(join(dest, file)), timeout: 10000 }] };
      h.hooks[event] = (h.hooks[event] || []).filter((x) => !/clevr-augment-/.test(JSON.stringify(x)));
      h.hooks[event].push(entry);
    }
    mkdirSync(dirname(AUGMENT_SETTINGS), { recursive: true });
    writeJson(AUGMENT_SETTINGS, h);
    return [
      R.ok('Gate in ' + gate),
      R.ok('Registered PreToolUse, PostToolUse and Stop in ' + AUGMENT_SETTINGS + ' (your own hooks kept)'),
      R.note('A Hold is returned as a refusal that says so, because Augment has no inline ask. Set CLEVR_AUGMENT_HOLD=allow to let holds through and record them instead.'),
    ];
  },
  uninstall () {
    const h = readJson(AUGMENT_SETTINGS);
    const out = [];
    for (const event of ['PreToolUse', 'PostToolUse', 'Stop']) {
      if (!h?.hooks?.[event]) continue;
      const kept = h.hooks[event].filter((x) => !/clevr-augment-/.test(JSON.stringify(x)));
      if (kept.length !== h.hooks[event].length) {
        h.hooks[event] = kept;
        writeJson(AUGMENT_SETTINGS, h);
        out.push(R.ok('Removed the Clevr hook from ' + AUGMENT_SETTINGS));
      }
    }
    for (const f of ['clevr-augment-gate.mjs', 'clevr-augment-result.mjs', 'clevr-augment-stop.mjs']) {
      rmSync(join(HOME, '.clevr', 'tools', f), { force: true });
    }
    return out.length ? out : [R.hint('Nothing to remove for Augment.')];
  },
  check () {
    const h = readJson(AUGMENT_SETTINGS);
    const gate = join(HOME, '.clevr', 'tools', 'clevr-augment-gate.mjs');
    const wired = ['PreToolUse', 'PostToolUse', 'Stop']
      .every((e) => (h?.hooks?.[e] || []).some((x) => /clevr-augment-/.test(JSON.stringify(x))));
    return [
      check('config', wired ? 'ok' : 'miss', AUGMENT_SETTINGS),
      check('hook script', existsSync(gate) ? 'ok' : 'miss', gate),
      check('key', process.env.CLEVR_API_KEY ? 'ok' : 'warn', process.env.CLEVR_API_KEY ? 'exported in this shell' : 'not exported in this shell; Augment inherits it at launch'),
    ];
  },
};

// ── Gemini CLI ───────────────────────────────────────────────────────────────
// Gemini gained hooks in January 2026, so it no longer has to be governed at the
// gateway where only the conversation is visible.
const geminiCli = {
  id: 'gemini-cli',
  label: 'Gemini CLI',
  mode: 'hook',
  mechanism: 'Four hooks: the prompt, every tool call, every tool result, and the model\'s reply.',
  limit: 'Gemini has no inline ask, so a Hold is returned as a refusal that says it is held and how to clear it. The widest coverage of any harness: AfterModel hands a hook the request AND the response, so the reply-side checks that elsewhere need the gateway run here too.',
  agent: 'gemini-cli',
  install () {
    const src = asset('gemini-cli/hooks');
    if (!src) return [R.fail('The Gemini hooks are not in this install.')];
    const dest = join(HOME, '.clevr', 'tools');
    copyDir(src, dest, ['clevr-gemini-gate.mjs', 'clevr-gemini-prompt.mjs', 'clevr-gemini-result.mjs', 'clevr-gemini-answer.mjs']);
    const common = asset('claude-code/hooks');
    if (common) copyDir(common, dest, ['clevr-common.mjs', 'clevr-send.mjs']);
    const gate = join(dest, 'clevr-gemini-gate.mjs');
    const h = readJson(GEMINI_SETTINGS) || {};
    h.hooks = h.hooks || {};
    // Only the tool events take a matcher; BeforeAgent and AfterModel fire once
    // per turn and one is entered without.
    for (const [event, file, matcher] of [
      ['BeforeAgent', 'clevr-gemini-prompt.mjs', null],
      ['BeforeTool', 'clevr-gemini-gate.mjs', '.*'],
      ['AfterTool', 'clevr-gemini-result.mjs', '.*'],
      ['AfterModel', 'clevr-gemini-answer.mjs', null],
    ]) {
      const entry = { ...(matcher ? { matcher } : {}), hooks: [{ type: 'command', name: 'clevr', command: 'node ' + JSON.stringify(join(dest, file)), timeout: 10000 }] };
      h.hooks[event] = (h.hooks[event] || []).filter((x) => !/clevr-gemini-/.test(JSON.stringify(x)));
      h.hooks[event].push(entry);
    }
    mkdirSync(dirname(GEMINI_SETTINGS), { recursive: true });
    writeJson(GEMINI_SETTINGS, h);
    return [
      R.ok('Gate in ' + gate),
      R.ok('Registered BeforeAgent, BeforeTool, AfterTool and AfterModel in ' + GEMINI_SETTINGS + ' (your own hooks kept)'),
      R.note('A Hold is returned as a refusal that says so, because Gemini has no inline ask. Set CLEVR_GEMINI_HOLD=allow to let holds through and record them instead.'),
    ];
  },
  uninstall () {
    const h = readJson(GEMINI_SETTINGS);
    const out = [];
    let changed = false;
    for (const event of ['BeforeAgent', 'BeforeTool', 'AfterTool', 'AfterModel']) {
      if (!h?.hooks?.[event]) continue;
      const kept = h.hooks[event].filter((x) => !/clevr-gemini-/.test(JSON.stringify(x)));
      if (kept.length !== h.hooks[event].length) { h.hooks[event] = kept; changed = true; }
    }
    if (changed) { writeJson(GEMINI_SETTINGS, h); out.push(R.ok('Removed the Clevr hooks from ' + GEMINI_SETTINGS)); }
    for (const f of ['clevr-gemini-gate.mjs', 'clevr-gemini-prompt.mjs', 'clevr-gemini-result.mjs', 'clevr-gemini-answer.mjs']) {
      rmSync(join(HOME, '.clevr', 'tools', f), { force: true });
    }
    return out.length ? out : [R.hint('Nothing to remove for Gemini CLI.')];
  },
  check () {
    const h = readJson(GEMINI_SETTINGS);
    const gate = join(HOME, '.clevr', 'tools', 'clevr-gemini-gate.mjs');
    const wired = ['BeforeAgent', 'BeforeTool', 'AfterTool', 'AfterModel']
      .every((e) => (h?.hooks?.[e] || []).some((x) => /clevr-gemini-/.test(JSON.stringify(x))));
    return [
      check('config', wired ? 'ok' : 'miss', GEMINI_SETTINGS),
      check('hook script', existsSync(gate) ? 'ok' : 'miss', gate),
      check('key', process.env.CLEVR_API_KEY ? 'ok' : 'warn', process.env.CLEVR_API_KEY ? 'exported in this shell' : 'not exported in this shell; Gemini inherits it at launch'),
    ];
  },
};

// ── Codex ────────────────────────────────────────────────────────────────────
// Codex gained hooks in May 2026 (PreToolUse can deny a call before it runs),
// and the ChatGPT desktop app runs the same Codex, so one hook set governs
// both. The contract is Claude Code's: the shims installed here set the harness
// name and hand over to the Claude Code hooks installed beside them.
const CODEX_HOOKS_JSON = join(HOME, '.codex', 'hooks.json');
// Event, script, timeout, matcher, and the status line Codex shows while the
// hook runs. The file shape is the documented one: an event maps to entries,
// each entry carries an optional matcher and a `hooks` array of command
// handlers. A flat {command} entry is silently ignored by the app.
const CODEX_HOOKS = [
  ['SessionStart', 'clevr-codex-session.mjs', 5, 'startup|resume|clear', 'Clevr: session ground rules'],
  ['UserPromptSubmit', 'clevr-codex-prompt.mjs', 10, null, 'Clevr: scanning the prompt'],
  ['PreToolUse', 'clevr-codex-gate.mjs', 10, '.*', 'Clevr: checking the tool call'],
  ['PostToolUse', 'clevr-codex-result.mjs', 10, '.*', 'Clevr: scanning the result'],
  ['SubagentStart', 'clevr-codex-subagent.mjs', 10, null, 'Clevr: recording the sub-agent'],
  ['Stop', 'clevr-codex-stop.mjs', 10, null, 'Clevr: recording the reply'],
];
const isOurCodexHook = (x) => /clevr-codex-/.test(JSON.stringify(x || ''));
// Codex runs a hook only after the person has trusted it once. The TUI asks at
// startup ("Hooks need review"), and the answer is recorded per hook as a hash
// under [hooks.state."<file>:<event>:<entry>:<handler>"] in config.toml. Until
// then the hook is listed and skipped without a word: measured on the ChatGPT
// desktop app, the blocked command ran. The hash is Codex's own and could not
// be reproduced here, so this reads presence: an entry for our handler's slot
// means it was trusted at least once, and Codex re-asks by itself when the
// definition changes. The desktop app has no review screen in the build
// measured (26.915); the CLI's one-time answer covers it, both read the same file.
const codexEventKey = (event) => event.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase();
function codexUntrusted () {
  const h = readJson(CODEX_HOOKS_JSON);
  const toml = existsSync(CODEX_CONFIG) ? readFileSync(CODEX_CONFIG, 'utf8') : '';
  const missing = [];
  for (const [event] of CODEX_HOOKS) {
    const entries = h?.hooks?.[event] || [];
    const i = entries.findIndex(isOurCodexHook);
    if (i < 0) { missing.push(event); continue; }
    const key = '[hooks.state."' + CODEX_HOOKS_JSON + ':' + codexEventKey(event) + ':' + i + ':0"]';
    const at = toml.indexOf(key);
    if (at < 0 || !/^\s*trusted_hash\s*=\s*"/m.test(toml.slice(at + key.length, at + key.length + 200))) missing.push(event);
  }
  return missing;
}
const codex = {
  id: 'codex',
  label: 'Codex (CLI and ChatGPT desktop)',
  mode: 'hook',
  mechanism: 'Six hooks, the same six as Claude Code: the prompt, every tool call before it runs, every tool result, sub-agents, the reply, and the ground rules at session start.',
  limit: 'Local tools only (shell, apply_patch, MCP): hosted tools do not pass through a Codex hook. Full enforcement on those: a Block returns before the tool runs.',
  agent: 'codex',
  install () {
    const src = asset('codex/hooks');
    const common = asset('claude-code/hooks');
    if (!src || !common) return [R.fail('The Codex hooks are not in this install.')];
    // The shims need the Claude Code hooks beside them, so ship both.
    copyDir(common, join(TOOLS, 'claude-code'), CC_FILES);
    const dest = join(TOOLS, 'codex');
    copyDir(src, dest, CODEX_HOOKS.map(([, f]) => f));
    const h = readJson(CODEX_HOOKS_JSON) || {};
    h.hooks = h.hooks || {};
    for (const [event, file, timeout, matcher, statusMessage] of CODEX_HOOKS) {
      h.hooks[event] = (h.hooks[event] || []).filter((x) => !isOurCodexHook(x));
      h.hooks[event].push({ ...(matcher ? { matcher } : {}), hooks: [{ type: 'command', command: 'node ' + JSON.stringify(join(dest, file)), timeout, statusMessage }] });
    }
    writeJson(CODEX_HOOKS_JSON, h);
    return [
      R.ok('Hook scripts in ' + dest),
      R.ok('Registered ' + CODEX_HOOKS.length + ' hooks in ' + CODEX_HOOKS_JSON + ' (your own hooks kept)'),
      R.note('The hooks read the engine and key from the environment, and from ~/.clevr/config.json when the environment has none, which is what the ChatGPT desktop app launched from the Dock gets.'),
      R.note('Codex skips a hook until you have trusted it once: run `codex` in any folder and answer "Trust all and continue" at the "Hooks need review" prompt. It records the six hashes in ' + CODEX_CONFIG + '. The ChatGPT desktop app has no review screen; that one answer covers it too.'),
      R.note('Then quit and reopen the ChatGPT desktop app: it loads the hooks and their trust when it starts, and a running app keeps the set it started with, silently.'),
    ];
  },
  uninstall () {
    const h = readJson(CODEX_HOOKS_JSON);
    const out = [];
    let changed = false;
    for (const [event] of CODEX_HOOKS) {
      if (!h?.hooks?.[event]) continue;
      const kept = h.hooks[event].filter((x) => !isOurCodexHook(x));
      if (kept.length !== h.hooks[event].length) { changed = true; if (kept.length) h.hooks[event] = kept; else delete h.hooks[event]; }
    }
    if (changed) { writeJson(CODEX_HOOKS_JSON, h); out.push(R.ok('Removed the Clevr hooks from ' + CODEX_HOOKS_JSON)); }
    rmSync(join(TOOLS, 'codex'), { recursive: true, force: true });
    return out.length ? out : [R.hint('Nothing to remove for Codex.')];
  },
  check () {
    const h = readJson(CODEX_HOOKS_JSON);
    const dest = join(TOOLS, 'codex');
    const untrusted = codexUntrusted();
    return [
      check('config', CODEX_HOOKS.every(([e]) => (h?.hooks?.[e] || []).some(isOurCodexHook)) ? 'ok' : 'miss', CODEX_HOOKS_JSON),
      check('hook scripts', CODEX_HOOKS.every(([, f]) => existsSync(join(dest, f))) && existsSync(join(TOOLS, 'claude-code', 'clevr-gate.mjs')) ? 'ok' : 'miss', dest),
      check('trusted', untrusted.length ? 'warn' : 'ok', untrusted.length ? 'not yet trusted in Codex (' + untrusted.join(', ') + '); it skips them until you run `codex` once and choose "Trust all and continue"' : 'trusted once in ' + CODEX_CONFIG),
      check('key', process.env.CLEVR_API_KEY ? 'ok' : (readJson(join(DIR, 'config.json'))?.key ? 'ok' : 'warn'), process.env.CLEVR_API_KEY ? 'exported in this shell' : (readJson(join(DIR, 'config.json'))?.key ? 'from ~/.clevr/config.json (what a Dock-launched app gets)' : 'no key exported and none in ~/.clevr/config.json; run clevr login')),
    ];
  },
};

// ── Codex, model traffic through the gateway ─────────────────────────────────
const CODEX_BLOCK_START = '# --- clevr begin ---';
const CODEX_BLOCK_END = '# --- clevr end ---';

// Cut out everything between the markers, inclusive. A lazy `[\s\S]*?` between
// two long literals is the classic backtracking shape; indexOf is not.
function withoutBlock (body) {
  let out = String(body || '');
  for (;;) {
    const a = out.indexOf(CODEX_BLOCK_START);
    if (a < 0) return out;
    const b = out.indexOf(CODEX_BLOCK_END, a);
    if (b < 0) return out.slice(0, a);
    out = out.slice(0, a) + out.slice(b + CODEX_BLOCK_END.length).replace(/^\n/, '');
  }
}

const codexGateway = {
  id: 'codex-gateway',
  label: 'Codex (model traffic)',
  mode: 'gateway',
  mechanism: 'A model provider in ~/.codex/config.toml pointing at the Clevr gateway.',
  limit: 'Sees the conversation, not the local command. Pair it with `setup codex`.',
  needsGateway: true,
  install (cfg) {
    if (!cfg.gateway) return [R.fail('No gateway URL. Set one: clevr config set gateway <url>')];
    mkdirSync(join(HOME, '.codex'), { recursive: true });
    const existing = existsSync(CODEX_CONFIG) ? readFileSync(CODEX_CONFIG, 'utf8') : '';
    const stripped = withoutBlock(existing);
    const block = [CODEX_BLOCK_START,
      'model_provider = "clevr"',
      '',
      '[model_providers.clevr]',
      'name = "Clevr"',
      'base_url = ' + JSON.stringify(trimSlash(cfg.gateway) + '/v1'),
      'env_key = "CLEVR_API_KEY"',
      CODEX_BLOCK_END].join('\n');
    writeFileSync(CODEX_CONFIG, (stripped.trimEnd() + '\n\n' + block + '\n').trimStart());
    return [R.ok('Provider written to ' + CODEX_CONFIG), R.hint('Between the two markers, so `clevr uninstall codex-gateway` removes exactly that.')];
  },
  uninstall () {
    if (!existsSync(CODEX_CONFIG)) return [R.hint('Nothing to remove.')];
    const body = readFileSync(CODEX_CONFIG, 'utf8');
    const next = withoutBlock(body);
    if (next === body) return [R.hint('Nothing to remove.')];
    writeFileSync(CODEX_CONFIG, next);
    return [R.ok('Removed the Clevr provider from ' + CODEX_CONFIG)];
  },
  check () {
    const body = existsSync(CODEX_CONFIG) ? readFileSync(CODEX_CONFIG, 'utf8') : '';
    return [check('config', body.includes(CODEX_BLOCK_START) ? 'ok' : 'miss', CODEX_CONFIG)];
  },
};

// ── MCP hosts ────────────────────────────────────────────────────────────────
// One guard binary; the difference between these targets is only which host
// config it is written into.
function guardPath () { return join(TOOLS, 'mcp', 'clevr-mcp-guard.mjs'); }

function installGuard () {
  const src = asset('mcp-guard/clevr-mcp-guard.mjs');
  if (!src) return null;
  mkdirSync(join(TOOLS, 'mcp'), { recursive: true });
  copyFileSync(src, guardPath());
  try { chmodSync(guardPath(), 0o755); } catch { /* Windows */ }
  return guardPath();
}

// Wrapping rewrites a server's command and keeps the original under `_clevr`,
// so uninstall restores byte-for-byte what was there.
function wrapServers (file, cfg, key) {
  const conf = readJson(file);
  if (!conf) return { found: false };
  const servers = conf[key] || {};
  let wrapped = 0;
  for (const [name, def] of Object.entries(servers)) {
    if (!def || def._clevr || !def.command) continue;
    servers[name] = {
      command: 'node',
      args: [guardPath(), '--', def.command, ...(def.args || [])],
      env: { ...(def.env || {}), CLEVR_URL: cfg.url, CLEVR_API_KEY: cfg.key, CLEVR_AGENT: cfg.agent },
      _clevr: { command: def.command, args: def.args || [], env: def.env || {} },
    };
    wrapped++;
  }
  conf[key] = servers;
  if (wrapped) writeJson(file, conf);
  return { found: true, wrapped, total: Object.keys(servers).length };
}

function unwrapServers (file, key) {
  const conf = readJson(file);
  if (!conf) return 0;
  const servers = conf[key] || {};
  let n = 0;
  for (const [name, def] of Object.entries(servers)) {
    if (!def?._clevr) continue;
    servers[name] = { command: def._clevr.command, ...(def._clevr.args?.length ? { args: def._clevr.args } : {}), ...(Object.keys(def._clevr.env || {}).length ? { env: def._clevr.env } : {}) };
    n++;
  }
  if (n) { conf[key] = servers; writeJson(file, conf); }
  return n;
}

function mcpTarget ({ id, label, file, key, agent, hostNote }) {
  return {
    id, label, mode: 'mcp',
    mechanism: 'The stdio MCP guard wraps each server; a blocked call never reaches the tool.',
    limit: hostNote,
    install (cfg) {
      if (!installGuard()) return [R.fail('The MCP guard is not in this install.')];
      const out = [R.ok('Guard installed at ' + guardPath())];
      const res = wrapServers(file, { ...cfg, agent }, key);
      if (!res.found) {
        out.push(R.note('No config found at ' + file + '. Wrap each server by hand:'));
        out.push(R.hint('"command": "node", "args": ["' + guardPath() + '", "--", "<original command>", "<args>"]'));
        out.push(R.hint('env: CLEVR_URL=' + cfg.url + '  CLEVR_API_KEY=' + cfg.key + '  CLEVR_AGENT=' + agent));
        return out;
      }
      out.push(res.wrapped ? R.ok('Wrapped ' + res.wrapped + ' of ' + res.total + ' MCP servers in ' + file) : R.hint(res.total ? 'All ' + res.total + ' servers were already wrapped.' : 'No MCP servers configured in ' + file + ' yet. Run setup again after you add one.'));
      out.push(R.hint('Restart ' + label + ' so it relaunches its servers.'));
      return out;
    },
    uninstall () {
      const n = unwrapServers(file, key);
      return n ? [R.ok('Restored ' + n + ' MCP servers in ' + file)] : [R.hint('Nothing to restore in ' + file)];
    },
    check () {
      const conf = readJson(file);
      const servers = conf?.[key] || {};
      const n = Object.values(servers).filter((d) => d?._clevr).length;
      // Config first: the guard binary is shared between MCP hosts, so its
      // presence says nothing about whether THIS host is wired.
      return [
        check('config', !conf ? 'miss' : n ? 'ok' : 'miss', !conf ? file + ' not found' : n + ' of ' + Object.keys(servers).length + ' servers wrapped'),
        check('guard script', existsSync(guardPath()) ? 'ok' : 'miss', guardPath()),
      ];
    },
  };
}

const copilot = mcpTarget({
  id: 'copilot', label: 'GitHub Copilot (agent mode)', file: COPILOT_CONFIG, key: 'servers', agent: 'github-copilot',
  hostNote: 'MCP tools only, for agent mode in the IDE. Its built-in edits are not gated here; for the terminal use `copilot-cli`, which hooks every tool.',
});

const claudeDesktop = mcpTarget({
  id: 'claude-desktop', label: 'Claude Desktop', file: DESKTOP_CONFIG, key: 'mcpServers', agent: 'claude-desktop',
  hostNote: 'The Chat tab reaches its tools over MCP and has no hook: this wraps those connectors. Cowork sessions in Claude Desktop run the Claude Code plugin hooks (`setup claude-code` covers them).',
});

const mcpGeneric = {
  id: 'mcp',
  label: 'Any MCP client',
  mode: 'mcp',
  mechanism: 'The stdio MCP guard wraps a server; a blocked call never reaches the tool.',
  limit: 'MCP tools only, and you point each server at the guard yourself.',
  install (cfg) {
    if (!installGuard()) return [R.fail('The MCP guard is not in this install.')];
    return [
      R.ok('Guard installed at ' + guardPath()),
      R.hint('In your client config, replace each server command with:'),
      R.hint('  "command": "node", "args": ["' + guardPath() + '", "--", "<original command>", "<args>"]'),
      R.hint('  env: CLEVR_URL=' + cfg.url + '  CLEVR_API_KEY=' + cfg.key + '  CLEVR_AGENT=<name>'),
    ];
  },
  uninstall () {
    rmSync(join(TOOLS, 'mcp'), { recursive: true, force: true });
    return [R.ok('Removed the guard. Any client config you edited by hand still points at it.')];
  },
  check () { return [check('guard script', existsSync(guardPath()) ? 'ok' : 'miss', existsSync(guardPath()) ? 'installed; each server is pointed at it by hand' : guardPath())]; },
};

// ── Anything with a custom model endpoint ────────────────────────────────────
const openaiCompatible = {
  id: 'openai-compatible',
  label: 'Cline, Roo, Kilo, or any tool with a custom OpenAI endpoint',
  mode: 'gateway',
  mechanism: 'Point the tool at the Clevr gateway instead of the provider.',
  limit: 'Sees the conversation, not the tool call. Nothing is written on this machine.',
  needsGateway: true,
  install (cfg) {
    if (!cfg.gateway) return [R.fail('No gateway URL. Set one: clevr config set gateway <url>')];
    return [
      R.note('Paste these into the tool that offers a custom OpenAI-compatible endpoint:'),
      R.hint('  Base URL  ' + trimSlash(cfg.gateway) + '/v1'),
      R.hint('  API key   ' + cfg.key),
      R.hint('Nothing was written on this machine, so there is nothing to uninstall.'),
    ];
  },
  uninstall () { return [R.hint('Nothing was ever written for this target.')]; },
  check () { return [check('config', 'info', 'set by hand inside the tool')]; },
};

export const TARGETS = [claudeCode, claudeCodeGateway, cursor, codex, codexGateway, copilotCli, copilot, augment, geminiCli, claudeDesktop, mcpGeneric, openaiCompatible];

export const byId = (id) => TARGETS.find((t) => t.id === id);

// Discovery reports one id per detected client; map those onto what we can wire.
export const FOR_DETECTED = {
  'claude-code': ['claude-code'],
  cursor: ['cursor'],
  'claude-desktop': ['claude-desktop'],
  codex: ['codex'],
  chatgpt: ['codex'],
  chatgpt: [],
  windsurf: ['mcp'],
  ollama: [],
  lmstudio: [],
  'py-agent': [],
  'node-agent': [],
};

export function appendRc (rcPath, line) {
  const body = existsSync(rcPath) ? readFileSync(rcPath, 'utf8') : '';
  if (body.includes('.clevr/env.sh')) return false;
  appendFileSync(rcPath, '\n# Clevr\n' + line + '\n');
  return true;
}

export function stripRc (rcPath) {
  if (!existsSync(rcPath)) return false;
  const body = readFileSync(rcPath, 'utf8');
  const lines = body.split('\n');
  const keep = lines.filter((l, i) => !l.includes('.clevr/env.sh') && !(l.trim() === '# Clevr' && (lines[i + 1] || '').includes('.clevr/env.sh')));
  if (keep.length === lines.length) return false;
  writeFileSync(rcPath, keep.join('\n'));
  return true;
}

// Best-effort: is the tool even on this machine? Used by `onboard` to pick
// targets, never to refuse a setup the operator asked for.
export function looksInstalled (id) {
  const has = (cmd) => { try { execFileSync(platform === 'win32' ? 'where' : 'which', [cmd], { stdio: 'pipe' }); return true; } catch { return false; } };
  switch (id) {
    case 'claude-code': case 'claude-code-gateway': return has('claude');
    case 'cursor': return existsSync(join(HOME, '.cursor'));
    case 'codex': case 'codex-gateway': return has('codex') || existsSync(join(HOME, '.codex'));
    case 'claude-desktop': return existsSync(DESKTOP_CONFIG);
    case 'copilot': return existsSync(COPILOT_CONFIG);
    default: return false;
  }
}
