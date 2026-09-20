#!/usr/bin/env bash
# Clevr Gate for Claude Code.
#
#   curl -fsSL https://clevrsecurity.com/install.sh | bash
#
# If you would rather read a script before running it, which is the habit we
# would recommend for any vendor, including us:
#
#   curl -fsSL https://clevrsecurity.com/install.sh -o clevr-install.sh
#   less clevr-install.sh
#   bash clevr-install.sh
#
# It registers the Clevr plugin marketplace with your Claude Code CLI and
# installs the gate for your user. It changes nothing else, and it sends
# nothing anywhere.
set -euo pipefail

MARKETPLACE="${CLEVR_PLUGIN_MARKETPLACE:-clevrsecurity-io/Plugins}"
MARKET_NAME="${CLEVR_MARKET_NAME:-clevr}"
PLUGIN="${CLEVR_PLUGIN_NAME:-clevr-gate}"

# ── the screen ───────────────────────────────────────────────────────────────
# Colour only on a terminal, and never when NO_COLOR is set: this script is
# also read by people, by CI logs and by pipes.
if [ -t 1 ] && [ -z "${NO_COLOR:-}" ]; then
  V=$'\033[38;5;99m'; B=$'\033[1m'; D=$'\033[2m'; G=$'\033[32m'; R=$'\033[31m'; Y=$'\033[33m'; N=$'\033[0m'
else
  V=''; B=''; D=''; G=''; R=''; Y=''; N=''
fi
step()  { printf '\n%s│ %s%s\n' "$V" "$1" "$N"; }
ok()    { printf '%s✔%s %s\n' "$G" "$N" "$1"; }
note()  { printf '%s·%s %s\n' "$D" "$N" "$1"; }
warn()  { printf '%s!%s %s\n' "$Y" "$N" "$1"; }
fail()  { printf '%s✘%s %s\n' "$R" "$N" "$1" >&2; }

printf '\n%s' "$V"
cat <<'WORDMARK'
   ██████╗ ██╗     ███████╗ ██╗   ██╗ ██████╗
  ██╔════╝ ██║     ██╔════╝ ██║   ██║ ██╔══██╗
  ██║      ██║     █████╗   ██║   ██║ ██████╔╝
  ██║      ██║     ██╔══╝   ╚██╗ ██╔╝ ██╔══██╗
  ╚██████╗ ███████╗███████╗  ╚████╔╝  ██║  ██║
   ╚═════╝ ╚══════╝╚══════╝   ╚═══╝   ╚═╝  ╚═╝
WORDMARK
printf '%s' "$N"
printf '%s  Runtime governance for Claude Code\n' "$D"
printf '  Every tool call checked before it runs · every decision signed%s\n' "$N"

# ── prerequisites ────────────────────────────────────────────────────────────
step "Checking prerequisites"
if ! command -v claude >/dev/null 2>&1; then
  fail "The Claude Code CLI ('claude') is not on your PATH."
  printf '  Install Claude Code first: https://claude.com/claude-code\n' >&2
  exit 1
fi
CC_VERSION="$(claude --version 2>/dev/null | head -1 || true)"
ok "Claude Code ${CC_VERSION:-found}"
if command -v node >/dev/null 2>&1; then ok "Node $(node --version 2>/dev/null) (the hooks run under it)"; else warn "Node is not on your PATH; Claude Code ships its own, so the hooks will still run"; fi

# ── install ──────────────────────────────────────────────────────────────────
step "Installing the gate"
# Re-running this should be harmless, so a previous registration is replaced
# rather than treated as an error.
claude plugin marketplace remove "$MARKET_NAME" >/dev/null 2>&1 || true
note "adding marketplace ${B}${MARKETPLACE}${N}"
claude plugin marketplace add "$MARKETPLACE" >/dev/null
ok "marketplace ready"
note "installing plugin ${B}${PLUGIN}@${MARKET_NAME}${N}"
claude plugin install "${PLUGIN}@${MARKET_NAME}" >/dev/null
ok "plugin installed"

# ── verify ───────────────────────────────────────────────────────────────────
step "Verifying"
if claude plugin list 2>/dev/null | grep -q "${PLUGIN}@${MARKET_NAME}"; then
  ok "${PLUGIN} is enabled for your user (Claude Code and Claude Desktop)"
else
  warn "could not confirm the plugin from 'claude plugin list'; open Claude Code and run /plugin"
fi

# ── connect ──────────────────────────────────────────────────────────────────
step "Connect to your engine"
if [ -n "${CLEVR_API_KEY:-}" ]; then
  ok "CLEVR_API_KEY is set in this shell${CLEVR_URL:+; engine ${CLEVR_URL}}"
  note "Claude Code inherits it when launched from here"
else
  printf '  The gate stays inactive until it has an engine key, so nothing changes\n'
  printf '  in your sessions until you decide. In the shell you launch Claude Code from:\n\n'
  printf '    %sexport CLEVR_API_KEY=clevr_sk_...%s\n' "$B" "$N"
  printf '    %sexport CLEVR_URL=https://your-clevr-host%s\n' "$B" "$N"
fi

# ── quick start ──────────────────────────────────────────────────────────────
step "Quick start"
printf '  Start a session in any project:\n\n'
printf '    %sclaude%s\n\n' "$G" "$N"
printf '  Then ask it whether it is governed, by which engine, and in which mode:\n\n'
printf '    %s/clevr-gate:status%s\n\n' "$G" "$N"
printf '  A new agent starts in Observe: every action is evaluated, recorded and\n'
printf '  signed, and only the safety floor blocks. Promote it to Enforce from the\n'
printf '  console when you are ready.\n'

# ── manage ───────────────────────────────────────────────────────────────────
step "Manage anytime"
printf '%s  claude plugin list\n' "$D"
printf '  claude plugin disable %s\n' "$PLUGIN"
printf '  claude plugin enable  %s\n' "$PLUGIN"
printf '  claude plugin update  %s\n' "$PLUGIN"
printf '  claude plugin uninstall %s@%s%s\n\n' "$PLUGIN" "$MARKET_NAME" "$N"
printf '  Docs: %shttps://docs.clevrsecurity.com%s\n\n' "$V" "$N"
