#!/usr/bin/env bash
# Clevr Gate for Claude Code — one-line installer.
#
#   curl -fsSL https://raw.githubusercontent.com/clevrsecurity/clevr-claude-code/main/install.sh | bash
#
# Adds the Clevr marketplace and installs the clevr-gate plugin via the Claude
# Code CLI, then prints the environment you need to set to enforce.
set -euo pipefail

REPO="${CLEVR_PLUGIN_REPO:-clevrsecurity/clevr-claude-code}"
MARKETPLACE="${CLEVR_PLUGIN_MARKETPLACE:-clevr}"
PLUGIN="${CLEVR_PLUGIN_NAME:-clevr-gate}"

if ! command -v claude >/dev/null 2>&1; then
  echo "Claude Code CLI ('claude') not found on PATH. Install Claude Code first: https://claude.com/claude-code" >&2
  exit 1
fi

echo "Adding the Clevr marketplace ($REPO)..."
claude plugin marketplace add "$REPO"

echo "Installing $PLUGIN@$MARKETPLACE..."
claude plugin install "${PLUGIN}@${MARKETPLACE}"

cat <<'EOF'

Clevr Gate installed.

Before it enforces, set your engine key and URL in the environment Claude Code
runs in (the gate is inactive until CLEVR_API_KEY is set, so it will not block
anything yet):

  export CLEVR_API_KEY=clevr_sk_...
  export CLEVR_URL=https://your-clevr-host    # default http://localhost:8787

Then start Claude Code. Every tool call is evaluated by Clevr before it runs:
allow proceeds, escalate asks you, block is refused, all with a signed receipt.
EOF
