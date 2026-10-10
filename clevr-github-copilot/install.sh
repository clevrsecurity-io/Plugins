#!/usr/bin/env bash
# Install the Clevr hooks for the GitHub Copilot CLI (user level).
#
# Three hooks, the same three `clevr setup github-copilot` registers: the prompt,
# every tool call, and every tool result. Copilot reads its hooks from its own
# file (~/.copilot/hooks/clevr.json), so this writes that file rather than
# merging into a shared settings file.
set -euo pipefail

command -v node >/dev/null 2>&1 || { echo "Node 18+ is required (the hooks run under node)." >&2; exit 1; }

HERE="$(cd "$(dirname "$0")" && pwd)"
TOOLS="$HOME/.clevr/tools"
HOOKS_FILE="${COPILOT_HOME:-$HOME/.copilot}/hooks/clevr.json"

CC=""
for c in "$HERE/../claude-code/hooks" "$HERE/../clevr-claude-code/hooks" "$HERE/hooks"; do
  [ -f "$c/clevr-common.mjs" ] && CC="$(cd "$c" && pwd)" && break
done
[ -n "$CC" ] || { echo "clevr-common.mjs was not found beside this installer." >&2; exit 1; }

mkdir -p "$TOOLS" "$(dirname "$HOOKS_FILE")"
cp "$HERE"/hooks/clevr-copilot-*.mjs "$TOOLS/"
cp "$CC/clevr-common.mjs" "$TOOLS/"
# The sender the shared helpers start to deliver a record after the hook exits.
[ -f "$CC/clevr-send.mjs" ] && cp "$CC/clevr-send.mjs" "$TOOLS/"
chmod +x "$TOOLS"/clevr-copilot-*.mjs
echo "Installed hook scripts to $TOOLS"

if ! echo '{}' | CLEVR_API_KEY= node "$TOOLS/clevr-copilot-gate.mjs" >/dev/null 2>&1; then
  echo "The installed gate does not load. Nothing was registered in $HOOKS_FILE." >&2
  exit 1
fi

TOOLS_DIR="$TOOLS" HOOKS_FILE="$HOOKS_FILE" node - <<'JS'
const fs = require('node:fs');
const path = require('node:path');
const file = process.env.HOOKS_FILE, dir = process.env.TOOLS_DIR;
// One command, given for both shells: Copilot picks the one its host runs.
const cmd = (f) => {
  const line = 'node ' + JSON.stringify(path.join(dir, f));
  return [{ type: 'command', bash: line, powershell: line, cwd: '.', timeoutSec: 10 }];
};
fs.mkdirSync(path.dirname(file), { recursive: true });
fs.writeFileSync(file, JSON.stringify({
  version: 1,
  hooks: {
    userPromptSubmitted: cmd('clevr-copilot-prompt.mjs'),
    preToolUse: cmd('clevr-copilot-gate.mjs'),
    postToolUse: cmd('clevr-copilot-result.mjs'),
  },
}, null, 2) + '\n', 'utf8');
console.log('Registered userPromptSubmitted, preToolUse and postToolUse in ' + file);
JS

cat <<'TXT'

Next, where Copilot runs:

  export CLEVR_URL=https://your-instance
  export CLEVR_API_KEY=clevr_sk_...
  export CLEVR_AGENT=the-name-this-machine-reports

Copilot reads the environment it was launched from, so open a new terminal (or
source ~/.clevr/env.sh) before starting it.

A hold is returned as a refusal that says so. Approve it in Clevr, then run the
same call again: the gate presents the approved decision and the engine spends it
once, on that same action.
TXT
