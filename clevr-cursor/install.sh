#!/usr/bin/env bash
# Install the Clevr gate as a Cursor hook (user level, ~/.cursor).
# Safe: never clobbers an existing hooks.json — it prints the snippet to merge.
set -euo pipefail

DEST="$HOME/.cursor/clevr-hooks"
HOOKS_JSON="$HOME/.cursor/hooks.json"
SRC="$(cd "$(dirname "$0")/hooks" && pwd)"

mkdir -p "$DEST"
cp "$SRC/clevr-gate.mjs" "$SRC/clevr-common.mjs" "$DEST/"
chmod +x "$DEST/clevr-gate.mjs"
echo "Installed hook scripts to $DEST"

if [ ! -f "$HOOKS_JSON" ]; then
  cat > "$HOOKS_JSON" <<JSON
{
  "version": 1,
  "hooks": {
    "preToolUse": [
      { "command": "node $DEST/clevr-gate.mjs" }
    ]
  }
}
JSON
  echo "Wrote $HOOKS_JSON"
else
  echo
  echo "A ~/.cursor/hooks.json already exists. Add this entry under hooks.preToolUse,"
  echo "keeping your existing hooks:"
  echo
  echo "  { \"command\": \"node $DEST/clevr-gate.mjs\" }"
fi

cat <<'ENV'

Next, make these visible to the environment Cursor runs in (e.g. ~/.zprofile,
or launch Cursor from a terminal that has them exported):

  export CLEVR_URL=https://your-clevr-host
  export CLEVR_API_KEY=clevr_sk_...
  export CLEVR_AGENT=cursor
  export CLEVR_MODE=shadow      # records only; set to 'enforce' to block/hold

Restart Cursor. In shadow mode every Agent tool call is evaluated and recorded
with a signed receipt, and nothing is blocked. Flip CLEVR_MODE to enforce when
the agent is profiled and you trust the policies.
ENV
