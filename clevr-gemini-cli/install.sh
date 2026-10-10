#!/usr/bin/env bash
# Install the Clevr hooks for the Gemini CLI (user level).
#
# Four hooks, the same four `clevr setup gemini-cli` registers: the prompt, every
# tool call, every tool result, and the model's reply. Safe: your own entries in
# ~/.gemini/settings.json are kept, only Clevr's are replaced.
set -euo pipefail

command -v node >/dev/null 2>&1 || { echo "Node 18+ is required (the hooks run under node)." >&2; exit 1; }

HERE="$(cd "$(dirname "$0")" && pwd)"
TOOLS="$HOME/.clevr/tools"
SETTINGS="$HOME/.gemini/settings.json"

CC=""
for c in "$HERE/../claude-code/hooks" "$HERE/../clevr-claude-code/hooks" "$HERE/hooks"; do
  [ -f "$c/clevr-common.mjs" ] && CC="$(cd "$c" && pwd)" && break
done
[ -n "$CC" ] || { echo "clevr-common.mjs was not found beside this installer." >&2; exit 1; }

mkdir -p "$TOOLS" "$(dirname "$SETTINGS")"
cp "$HERE"/hooks/clevr-gemini-*.mjs "$TOOLS/"
cp "$CC/clevr-common.mjs" "$TOOLS/"
# The sender the shared helpers start to deliver a record after the hook exits.
[ -f "$CC/clevr-send.mjs" ] && cp "$CC/clevr-send.mjs" "$TOOLS/"
chmod +x "$TOOLS"/clevr-gemini-*.mjs
echo "Installed hook scripts to $TOOLS"

if ! echo '{}' | CLEVR_API_KEY= node "$TOOLS/clevr-gemini-gate.mjs" >/dev/null 2>&1; then
  echo "The installed gate does not load. Nothing was registered in $SETTINGS." >&2
  exit 1
fi

TOOLS_DIR="$TOOLS" SETTINGS="$SETTINGS" node - <<'JS'
const fs = require('node:fs');
const path = require('node:path');
const file = process.env.SETTINGS, dir = process.env.TOOLS_DIR;
let h = {}; try { h = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { h = {}; }
h.hooks = h.hooks || {};
// Only the tool events take a matcher; BeforeAgent and AfterModel fire once per
// turn and are entered without one.
for (const [event, f, matcher] of [
  ['BeforeAgent', 'clevr-gemini-prompt.mjs', null],
  ['BeforeTool', 'clevr-gemini-gate.mjs', '.*'],
  ['AfterTool', 'clevr-gemini-result.mjs', '.*'],
  ['AfterModel', 'clevr-gemini-answer.mjs', null],
]) {
  const entry = { ...(matcher ? { matcher } : {}), hooks: [{ type: 'command', name: 'clevr', command: 'node ' + JSON.stringify(path.join(dir, f)), timeout: 10000 }] };
  h.hooks[event] = (h.hooks[event] || []).filter((x) => !/clevr-gemini-/.test(JSON.stringify(x)));
  h.hooks[event].push(entry);
}
fs.mkdirSync(path.dirname(file), { recursive: true });
fs.writeFileSync(file, JSON.stringify(h, null, 2) + '\n', 'utf8');
console.log('Registered BeforeAgent, BeforeTool, AfterTool and AfterModel in ' + file + ' (your own hooks kept)');
JS

cat <<'TXT'

Next, where Gemini runs:

  export CLEVR_URL=https://your-instance
  export CLEVR_API_KEY=clevr_sk_...
  export CLEVR_AGENT=the-name-this-machine-reports

CLEVR_SENSITIVE=1 turns off everything that carries content (prompt, result and
reply) and keeps the tool gate, which judges the action's shape alone.

A hold is returned as a refusal that says so, because Gemini has no inline ask.
Approve it in Clevr, then run the same call again: the gate presents the approved
decision and the engine spends it once, on that same action.
TXT
