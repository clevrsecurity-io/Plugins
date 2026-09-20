#!/usr/bin/env bash
# Install the Clevr hooks for Codex and the ChatGPT desktop app (user level).
#
# Six hooks, the same six `clevr setup codex` registers. The Codex hooks are
# shims over the Claude Code hooks, so both sets are copied side by side. Safe:
# your own entries in ~/.codex/hooks.json are kept; only Clevr's are replaced.
set -euo pipefail

command -v node >/dev/null 2>&1 || { echo "Node 18+ is required (the hooks run under node)." >&2; exit 1; }

HERE="$(cd "$(dirname "$0")" && pwd)"
TOOLS="$HOME/.clevr/tools"
HOOKS_JSON="$HOME/.codex/hooks.json"

# The Claude Code hooks: in the monorepo they are two directories up; in the
# published Plugins repository they are the clevr-claude-code plugin beside us.
CC=""
for c in "$HERE/../claude-code/hooks" "$HERE/../clevr-claude-code/hooks"; do
  [ -f "$c/clevr-gate.mjs" ] && CC="$(cd "$c" && pwd)" && break
done
[ -n "$CC" ] || { echo "The Claude Code hooks were not found beside this installer." >&2; exit 1; }

mkdir -p "$TOOLS/claude-code" "$TOOLS/codex" "$HOME/.codex"
cp "$CC"/clevr-*.mjs "$TOOLS/claude-code/"
cp "$HERE"/hooks/clevr-codex-*.mjs "$TOOLS/codex/"
chmod +x "$TOOLS"/claude-code/*.mjs "$TOOLS"/codex/*.mjs
echo "Installed hook scripts to $TOOLS/codex (over $TOOLS/claude-code)"

# Prove the install can run: an unconfigured hook must load and stay silent.
if ! echo '{}' | CLEVR_API_KEY= node "$TOOLS/codex/clevr-codex-gate.mjs" >/dev/null 2>&1; then
  echo "The installed gate does not load. Nothing was registered in $HOOKS_JSON." >&2
  exit 1
fi

# Merge into hooks.json: keep every entry that is not ours, add ours once.
TOOLS_DIR="$TOOLS/codex" HOOKS_JSON="$HOOKS_JSON" node - <<'JS'
const fs = require('node:fs');
const file = process.env.HOOKS_JSON, dir = process.env.TOOLS_DIR;
let h = {}; try { h = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { h = {}; }
h.hooks = h.hooks || {};
const ours = (x) => /clevr-codex-/.test(JSON.stringify(x || ''));
// The documented shape: an event maps to entries, each with an optional matcher
// and a `hooks` array of command handlers. A flat {command} is silently ignored.
for (const [event, f, timeout, matcher, statusMessage] of [
  ['SessionStart', 'clevr-codex-session.mjs', 5, 'startup|resume|clear', 'Clevr: session ground rules'],
  ['UserPromptSubmit', 'clevr-codex-prompt.mjs', 10, null, 'Clevr: scanning the prompt'],
  ['PreToolUse', 'clevr-codex-gate.mjs', 10, '.*', 'Clevr: checking the tool call'],
  ['PostToolUse', 'clevr-codex-result.mjs', 10, '.*', 'Clevr: scanning the result'],
  ['SubagentStart', 'clevr-codex-subagent.mjs', 10, null, 'Clevr: recording the sub-agent'],
  ['Stop', 'clevr-codex-stop.mjs', 10, null, 'Clevr: recording the reply'],
]) {
  h.hooks[event] = (h.hooks[event] || []).filter((x) => !ours(x));
  h.hooks[event].push({ ...(matcher ? { matcher } : {}), hooks: [{ type: 'command', command: 'node ' + JSON.stringify(dir + '/' + f), timeout, statusMessage }] });
}
fs.writeFileSync(file, JSON.stringify(h, null, 2) + '\n');
console.log('Registered 6 hooks in ' + file + ' (your own hooks kept)');
JS

cat <<'ENV'

Next, make these visible to the environment Codex runs in. The ChatGPT desktop
app inherits the environment it was launched with, so put them in your login
shell profile (~/.zprofile), or launch it from a shell that has them exported:

  export CLEVR_URL=https://your-clevr-host
  export CLEVR_API_KEY=clevr_sk_...

Then trust the hooks once. Codex skips a hook it has not reviewed, without
saying so: run `codex` in any folder and answer "Trust all and continue" at
the "Hooks need review" prompt. It records the six hashes in
~/.codex/config.toml and asks again only if a hook changes. The ChatGPT
desktop app has no review screen; that one answer covers it too, both read
the same file.

Restart Codex or the ChatGPT desktop app. Every prompt, tool call, tool result
and reply is evaluated, recorded and signed. A new agent observes first, the
safety floor still blocks; promote it to Enforce from the console.
ENV
