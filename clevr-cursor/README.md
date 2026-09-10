# Clevr gate for Cursor (hooks)

Governs the **Cursor Agent (Composer)** through Clevr's decision engine, using
Cursor's own [hooks API](https://cursor.com/docs/hooks). Before any Agent tool
runs (a shell command, a file edit, an MCP tool), the hook POSTs the action to
`POST /v1/evaluate` and Cursor obeys the verdict: allow, hold, or block, each
sealed in a signed receipt.

## Why a hook, not the gateway

Cursor's Composer, inline edit, and autocomplete are **locked to Cursor's own
backend**: pointing "Override OpenAI Base URL" at a gateway only reroutes the
chat panel, not the agent. A hook sidesteps that entirely. It fires **in the
agent loop**, between the model's decision to use a tool and the tool actually
running, so it gates the agent's real actions with no model reroute and no added
network hop. This is the deepest door for Cursor.

## Install

```bash
./install.sh
```

This copies the hook scripts to `~/.cursor/clevr-hooks/` and registers the
`preToolUse` hook in `~/.cursor/hooks.json` (if you already have a `hooks.json`,
it prints the one line to add instead of overwriting yours).

Then make the configuration visible to the environment Cursor runs in (set it in
`~/.zprofile`, or launch Cursor from a terminal that exported it):

```bash
export CLEVR_URL=https://your-clevr-host
export CLEVR_API_KEY=clevr_sk_...
export CLEVR_AGENT=cursor
# Mode is set in the console (a new agent observes first). Optionally set
# CLEVR_MODE=shadow to force record-only on this machine.
```

Restart Cursor.

## Modes

By default the hook **obeys the engine verdict**. The engine decides whether an
action is shadowed or blocked from the workspace and per-agent mode you set in the
console, and a **new agent observes first** (watched and signed, but only the
safety floor blocks) until you promote it to enforce. So a fresh install can't
brick Cursor, and you flip the whole fleet from one place, not per machine.

When the engine enforces: `block` denies the tool, `escalate` holds it (a
synchronous hook cannot wait for an async console approval, so an un-approved
step-up does not run; set `CLEVR_ESCALATE=ask` to prompt the local operator).

Set **`CLEVR_MODE=shadow`** to override locally: this machine records every verdict
but never blocks, whatever the engine returned. A per-developer escape hatch, not
the fleet control.

## All settings

| Variable | Default | Meaning |
| --- | --- | --- |
| `CLEVR_API_KEY` | (none) | Org key. **Unset = hook inactive** (never bricks Cursor). |
| `CLEVR_URL` | `http://localhost:8787` | Engine base URL. |
| `CLEVR_AGENT` | `cursor` | Identity in the audit log. |
| `CLEVR_MODE` | (unset) | Unset obeys the engine (the console decides). `shadow` forces record-only on this machine. |
| `CLEVR_ESCALATE` | `deny` | Step-up: `deny` holds, `ask` prompts the local operator. |
| `CLEVR_AUTO_APPROVE` | off | `1` makes Clevr the sole gate (emit allow past Cursor's own prompt). |
| `CLEVR_FAILSAFE` | `open` | On engine error: `open` allows, `closed` denies. |
| `CLEVR_FORWARD_CONTEXT` | on | `0` to stop forwarding the agent's current message. |
| `CLEVR_TIMEOUT_MS` | `4000` | Evaluate timeout. |
| `CLEVR_ENV` | (none) | Environment label (prod/staging/dev). |

## Status

**Beta.** Built against Cursor's documented hooks contract (`preToolUse`,
stdin JSON in, `{ "permission": "allow" | "deny" | "ask" }` out). Cursor's hook
surface is young and version-dependent: validate in your Cursor version in
shadow mode before enforcing on client machines. Note that `ask` is not enforced
for `preToolUse` in some versions, so `CLEVR_ESCALATE=deny` (hold) is the safe
default.

It gates the agent's **tool executions**; it does not reroute the model, and it
does not read the model's tokens. That is the point: govern what the agent does,
not how it thinks.

## Troubleshooting

**A "hook error" that quotes your version manager (mise, asdf, nvm, direnv).** The
hooks run `node`. If your `node` is provided by a version manager, that tool runs
on every invocation and can print its own warnings to stderr, and Cursor surfaces
those as a hook error even though the gate ran fine and the action still proceeds.
This is your environment, not Clevr: the same message appears on any hook that runs
a command. For example, `mise WARN deprecated [...]` means a setting in your mise
config is deprecated. Fix it at the source (update the deprecated setting, e.g. in
`~/.config/mise/config.toml`) or silence the manager for hooks (e.g. `MISE_QUIET=1`).
