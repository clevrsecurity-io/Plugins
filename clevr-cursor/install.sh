#!/usr/bin/env bash
# Install the Clevr hooks for Cursor (user level, ~/.cursor).
#
# Four hooks, the same four `clevr setup cursor` registers: the prompt, every
# tool call, every tool result, and the reply. Safe: never clobbers an existing
# hooks.json. It prints the entries to merge instead.
#
# The shared helpers live in the Claude Code plugin; the copy here is a one-line
# re-export that only resolves inside the monorepo. Installing that stub used to
# leave every hook failing at import time, which Cursor reported as a hook error
# on every tool call. The real file is copied, and the install is checked by
# actually loading a hook before it is declared done.
set -euo pipefail

DEST="$HOME/.cursor/clevr-hooks"
HOOKS_JSON="$HOME/.cursor/hooks.json"
SRC="$(cd "$(dirname "$0")/hooks" && pwd)"
COMMON="$SRC/clevr-common.mjs"
# In the monorepo the sibling is a re-export; ship the real helpers.
if grep -q '^export \* from' "$COMMON" 2>/dev/null; then
  COMMON="$(cd "$SRC/../../claude-code/hooks" && pwd)/clevr-common.mjs"
fi

command -v node >/dev/null 2>&1 || { echo "Node 18+ is required (the hooks run under node)." >&2; exit 1; }

mkdir -p "$DEST"
cp "$SRC/clevr-gate.mjs" "$SRC/clevr-prompt.mjs" "$SRC/clevr-result.mjs" "$SRC/clevr-answer.mjs" "$DEST/"
cp "$COMMON" "$DEST/clevr-common.mjs"
chmod +x "$DEST"/clevr-*.mjs
echo "Installed hook scripts to $DEST"

# Prove the install can run: an unconfigured hook must load and stay silent.
if ! echo '{}' | CLEVR_API_KEY= node "$DEST/clevr-gate.mjs" >/dev/null 2>&1; then
  echo "The installed gate does not load. Nothing was registered in $HOOKS_JSON." >&2
  exit 1
fi

if [ ! -f "$HOOKS_JSON" ]; then
  cat > "$HOOKS_JSON" <<JSON
{
  "version": 1,
  "hooks": {
    "beforeSubmitPrompt": [
      { "command": "node \"$DEST/clevr-prompt.mjs\"" }
    ],
    "preToolUse": [
      { "command": "node \"$DEST/clevr-gate.mjs\"" }
    ],
    "postToolUse": [
      { "command": "node \"$DEST/clevr-result.mjs\"" }
    ],
    "afterAgentResponse": [
      { "command": "node \"$DEST/clevr-answer.mjs\"" }
    ]
  }
}
JSON
  echo "Wrote $HOOKS_JSON"
else
  echo
  echo "A ~/.cursor/hooks.json already exists. Add these entries, keeping your existing hooks:"
  echo
  echo "  hooks.beforeSubmitPrompt:   { \"command\": \"node \\\"$DEST/clevr-prompt.mjs\\\"\" }"
  echo "  hooks.preToolUse:           { \"command\": \"node \\\"$DEST/clevr-gate.mjs\\\"\" }"
  echo "  hooks.postToolUse:          { \"command\": \"node \\\"$DEST/clevr-result.mjs\\\"\" }"
  echo "  hooks.afterAgentResponse:   { \"command\": \"node \\\"$DEST/clevr-answer.mjs\\\"\" }"
  echo
  echo "Or let the CLI merge them for you:  npx clevr-cli setup cursor"
fi

cat <<'ENV'

Next, make these visible to the environment Cursor runs in (e.g. ~/.zprofile,
or launch Cursor from a terminal that has them exported):

  export CLEVR_URL=https://your-clevr-host
  export CLEVR_API_KEY=clevr_sk_...
  export CLEVR_AGENT=cursor

Restart Cursor. Every prompt, tool call, tool result and reply is evaluated,
recorded, and signed. The console decides Observe vs Enforce per agent (a new
agent observes first, the safety floor still blocks); promote it from the
console when you trust it.
ENV
