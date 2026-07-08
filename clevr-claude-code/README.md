# Clevr Gate for Claude Code

Govern Claude Code through Clevr's runtime policy engine. No code change to the agent, and no Anthropic API key required, so it works the same whether Claude Code runs on a subscription seat or on API billing. Install the plugin, point it at your engine, and Clevr governs the agent on three fronts:

- **Every tool call** (Bash, file edit, web fetch, MCP tool) is evaluated **before it runs** (`PreToolUse`).
- **Every user prompt** is scanned **before the model sees it** (`UserPromptSubmit`), including turns that never call a tool.
- **Every model reply** is recorded and scanned **after the turn finishes** (`Stop`), so the model's own output lands in the audit too (record-only; blocking output on the wire is the gateway's job).

Each action is mapped onto Claude Code's own permission model:

| Clevr verdict | Claude Code behavior |
|---|---|
| `allow` | proceeds (Clevr is additive; Claude Code's own prompts still apply) |
| `escalate` | the action is held for review (see `CLEVR_ESCALATE` below) |
| `block` | the tool never runs or the prompt is refused; the model is told why |

Every decision is sealed into Clevr's signed, offline-verifiable audit chain, and each action is situated in its session with the surrounding conversation, so a block reads as "this agent, in this session, on this conversation, tried X, and here is why it was stopped."

By default the plugin runs in **shadow mode**: it evaluates and records every verdict but never blocks, so installing it cannot brick Claude Code. Switch to `CLEVR_MODE=enforce` when you are ready to actually block.

## Install

In Claude Code (CLI or desktop app), add the marketplace, then install the plugin:

```
/plugin marketplace add clevrsecurity/clevr-claude-code
/plugin install clevr-gate@clevr
```

Non-interactively, from a shell:

```bash
claude plugin marketplace add clevrsecurity/clevr-claude-code
claude plugin install clevr-gate@clevr
```

To try it from a local clone without installing:

```bash
git clone https://github.com/clevrsecurity/clevr-claude-code
claude --plugin-dir ./clevr-claude-code
```

## Configure

Set at least your engine key and URL in the environment Claude Code runs in. Until `CLEVR_API_KEY` is set the gate is inactive (it allows everything), so it never bricks Claude Code:

```bash
export CLEVR_API_KEY=clevr_sk_...
export CLEVR_URL=https://your-clevr-host      # default http://localhost:8787
```

| Variable | Default | Meaning |
|---|---|---|
| `CLEVR_API_KEY` | (required) | Org key. If unset, the gate is inactive (allows everything) so it never bricks Claude Code. |
| `CLEVR_URL` | `http://localhost:8787` | Engine base URL. The gate calls `<url>/v1/evaluate`. |
| `CLEVR_MODE` | `shadow` | `shadow` observes and records every verdict but never blocks. `enforce` blocks and holds. |
| `CLEVR_AGENT` | `claude-code` | Identity recorded in the audit log. |
| `CLEVR_ESCALATE` | `deny` | What an escalate does under enforce. `deny` holds the action (a step-up no one approved does not run). `ask` prompts the local operator instead. |
| `CLEVR_FORWARD_CONTEXT` | `1` | Forward the last few transcript turns so the engine scans the prompt and situates the tool call in its session. Set `0` to send only the action. |
| `CLEVR_CONTEXT_TURNS` | `6` | How many recent transcript turns to forward as context. Raise it to widen the window the engine scans, at the cost of a larger payload. |
| `CLEVR_AUTO_APPROVE` | `0` | `1` makes Clevr the sole gate: a Clevr `allow` skips Claude Code's own prompt. Default keeps Clevr additive (it only blocks or escalates). |
| `CLEVR_FAILSAFE` | `open` | On engine error or timeout: `open` allows, `closed` denies. An unset key always allows. |
| `CLEVR_TIMEOUT_MS` | `4000` | Per-call evaluate timeout, in milliseconds. |
| `CLEVR_ENV` | (none) | Environment label (`prod` / `staging` / `dev`) sent to the engine. |

## What the plugin sends

On each hook the plugin POSTs to `<CLEVR_URL>/v1/evaluate`: the action (the tool and its command, path, or arguments), the session id, and, when `CLEVR_FORWARD_CONTEXT` is on, the last few user and assistant turns of the transcript (truncated). It never sends your Anthropic key, and it never sends the model call itself. The engine you point at is yours: self-host it, or use an EU-hosted Clevr, so the conversation stays under your control.

## Rollout

1. **Install in shadow** (the default). Every tool call is evaluated and recorded; nothing is blocked. Watch the decisions in the Clevr console to see what would have been stopped.
2. **Authorize the agent.** Clevr default-denies destructive verbs (exec, write, delete) for an agent with no authority profile, so give the `claude-code` agent a profile that permits the tools it legitimately uses. Benign work then passes; policy violations (secret exfiltration, out-of-scope actions) still stop.
3. **Switch to enforce** with `CLEVR_MODE=enforce`. Blocks and escalations take effect.

## How it works

The plugin registers three hooks (Node, no dependencies; shared helpers in `hooks/clevr-common.mjs`):

**`PreToolUse`, the action gate (`hooks/clevr-gate.mjs`), matches every tool (`"matcher": "*"`):**

1. Reads the tool call from stdin and maps it to an engine action (`Bash` to `exec`, `Write` / `Edit` to `write`, `Read` to `read`, `mcp__*` to `tool_call`, and so on). The command, path, or arguments are sent as the action text so the deterministic content floor can scan them.
2. Optionally reads the recent conversation from the transcript and the session id, so the same gate that governs the action also gives it meaning in the session.
3. Calls `POST /v1/evaluate` and translates the verdict to `allow` / `ask` / `deny`.

**`UserPromptSubmit`, the prompt scanner (`hooks/clevr-prompt.mjs`), fires on every prompt:**

1. Sends the prompt to `POST /v1/evaluate` so it is scanned for PII, secrets, and prompt injection, and recorded under the session, even on turns that never call a tool. This is the conversation visibility the action gate alone cannot give, since it only sees prompts at tool-call moments.
2. Under `enforce`, a prompt that trips the content floor is refused before the model sees it; under `shadow` it is recorded and surfaced as context, never blocked.

The prompt rides in the conversation field (which the content detectors scan), not the action field (which the verb safety-floor classifies), so ordinary words like "delete" or "send" in a prompt never misfire as destructive actions.

**`Stop`, the reply recorder (`hooks/clevr-stop.mjs`), fires when the model finishes a turn:**

1. Reads the model's final reply from the transcript and sends it to `POST /v1/evaluate`, so the model's **own output** is recorded under the session and scanned for content leaks (a secret or PII the model echoed back).
2. **Record-only.** The reply has already been shown to the user, so this hook never blocks; it makes the output visible in the Clevr conversation and flags a leak for review. Blocking output **before** it is shown is the gateway's job (PROXY mode). The reply rides in the conversation field, same as the prompt, so it is scanned without misfiring the verb floor.

Together the three hooks give the engine a full picture of a turn: the prompt that came in, the actions it drove, and the reply that went out.

This is the GUARD path of Clevr applied to an agent you did not write, with no LLM API key involved, so a subscription Claude Code seat is governed exactly like an API-billed one. For agents whose code you own, use the Clevr SDK; to govern the model call itself on the wire, use PROXY mode (which does require an API key to route through the gateway).

## Requirements

Claude Code (CLI or desktop app), with Node on the PATH (the hooks run `node`, which Claude Code already needs). The engine must be reachable from that machine at `CLEVR_URL`. Plugins do not run in Claude Code cloud sessions, so use a local or SSH session.

## License

MIT. See [plugin.json](.claude-plugin/plugin.json).
