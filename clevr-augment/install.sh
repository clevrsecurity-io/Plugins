#!/usr/bin/env bash
# Install the Clevr hooks for the Augment CLI (user level).
#
# Three hooks, the same three `clevr setup augment` registers: every tool call,
# every tool result, and the conversation at the end of each turn. Safe: your own
# entries in ~/.augment/settings.json are kept, only Clevr's are replaced.
set -euo pipefail

command -v node >/dev/null 2>&1 || { echo "Node 18+ is required (the hooks run under node)." >&2; exit 1; }

HERE="$(cd "$(dirname "$0")" && pwd)"
TOOLS="$HOME/.clevr/tools"
SETTINGS="$HOME/.augment/settings.json"

# The shared helpers: two directories up in the monorepo, or the Claude Code
# plugin beside us in the published repository.
CC=""
for c in "$HERE/../claude-code/hooks" "$HERE/../clevr-claude-code/hooks" "$HERE/hooks"; do
  [ -f "$c/clevr-common.mjs" ] && CC="$(cd "$c" && pwd)" && break
done
[ -n "$CC" ] || { echo "clevr-common.mjs was not found beside this installer." >&2; exit 1; }

mkdir -p "$TOOLS" "$(dirname "$SETTINGS")"
cp "$HERE"/hooks/clevr-augment-*.mjs "$TOOLS/"
cp "$CC/clevr-common.mjs" "$TOOLS/"
# The sender the shared helpers start to deliver a record after the hook exits.
[ -f "$CC/clevr-send.mjs" ] && cp "$CC/clevr-send.mjs" "$TOOLS/"
chmod +x "$TOOLS"/clevr-augment-*.mjs
echo "Installed hook scripts to $TOOLS"

# Prove the install can run: an unconfigured hook must load and stay silent.
if ! echo '{}' | CLEVR_API_KEY= node "$TOOLS/clevr-augment-gate.mjs" >/dev/null 2>&1; then
  echo "The installed gate does not load. Nothing was registered in $SETTINGS." >&2
  exit 1
fi

TOOLS_DIR="$TOOLS" SETTINGS="$SETTINGS" node - <<'JS'
const fs = require('node:fs');
const file = process.env.SETTINGS, dir = process.env.TOOLS_DIR;
const path = require('node:path');
let h = {}; try { h = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { h = {}; }
h.hooks = h.hooks || {};
// `.*` is every tool: the shell and the editor are the point, not MCP alone.
// Stop takes no matcher, which is why it is entered without one.
for (const [event, f, matcher] of [
  ['PreToolUse', 'clevr-augment-gate.mjs', '.*'],
  ['PostToolUse', 'clevr-augment-result.mjs', '.*'],
  ['Stop', 'clevr-augment-stop.mjs', null],
]) {
  const entry = { ...(matcher ? { matcher } : {}), hooks: [{ type: 'command', command: 'node ' + JSON.stringify(path.join(dir, f)), timeout: 10000 }] };
  h.hooks[event] = (h.hooks[event] || []).filter((x) => !/clevr-augment-/.test(JSON.stringify(x)));
  h.hooks[event].push(entry);
}
fs.mkdirSync(path.dirname(file), { recursive: true });
fs.writeFileSync(file, JSON.stringify(h, null, 2) + '\n', 'utf8');
console.log('Registered PreToolUse, PostToolUse and Stop in ' + file + ' (your own hooks kept)');
JS

cat <<'TXT'

Next, where Augment runs:

  export CLEVR_URL=https://your-instance
  export CLEVR_API_KEY=clevr_sk_...
  export CLEVR_AGENT=the-name-this-machine-reports

A hold is returned as a refusal that says so, because Augment has no inline ask.
Approve it in Clevr, then run the same call again: the gate presents the approved
decision and the engine spends it once, on that same action.
TXT
