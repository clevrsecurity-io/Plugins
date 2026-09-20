# Clevr Gate for Claude Code

Govern Claude Code through Clevr's runtime policy engine. No code change to the agent, and no Anthropic API key required — it works the same whether Claude Code runs on a subscription seat or on API billing. Install the plugin, point it at your engine, and Clevr governs the agent on three fronts:

- **Every tool call** (Bash, file edit, web fetch, MCP tool) is evaluated **before it runs** (`PreToolUse`).
- **Every user prompt** is scanned **before the model sees it** (`UserPromptSubmit`), including turns that never call a tool.
- **Everything a tool hands back** is scanned **after it runs** (`PostToolUse`): a ticket, a fetched page, a file, a database row, an MCP answer. None of that was written by your user, all of it lands in the model's context, and it is where an indirect prompt injection arrives.
- **Every model reply** is recorded and scanned **after the turn finishes** (`Stop`), so the model's own output lands in the audit too (record-only — see the gateway for blocking output on the wire).

Each action is mapped onto Claude Code's own permission model:

| Clevr verdict | Claude Code behavior |
|---|---|
| `allow` | proceeds (Clevr is additive; Claude Code's own prompts still apply) |
| `escalate` | held: the tool does not run and the reason says why (a hook answers in seconds and cannot wait for a console approval). Approve it in the console and run it again. A prompt is held. |
| `block` | the tool never runs / the prompt is refused; the model is told why |

Every decision is sealed into Clevr's signed, offline-verifiable audit chain, and the tool call is situated in its session with the surrounding conversation, so a block reads as "this agent, in this session, on this conversation, tried X, and here is why it was stopped."

The plugin **obeys the engine verdict**: the workspace and per-agent mode you set in the Clevr console decide whether an action is observed or blocked, and a new agent observes first (watched and signed, but only the safety floor blocks), so installing it cannot brick Claude Code. You promote an agent to Enforce from the console. There is no per-machine override: a machine that could set itself to record-only would show "blocked" in the console for an action that actually ran.

## Install

```bash
curl -fsSL https://clevrsecurity.com/install.sh | bash
```

To read the script before running it, which is the habit we would recommend for
any vendor including us:

```bash
curl -fsSL https://clevrsecurity.com/install.sh -o clevr-install.sh
less clevr-install.sh
bash clevr-install.sh
```

Or do the same two steps yourself, from inside Claude Code:

```bash
/plugin marketplace add clevrsecurity-io/Plugins
/plugin install clevr-gate@clevr
```

Or non-interactively:

```bash
claude plugin marketplace add clevrsecurity-io/Plugins
claude plugin install clevr-gate@clevr
```

For local testing without installing:

```bash
claude --plugin-dir ./integrations/claude-code
```

The installer shows each step as it goes (prerequisites, install, verification, how to connect) and ends with the two commands to try. It sends nothing anywhere.

## Where do I stand?

Inside any session:

```
/clevr-gate:status
```

One screen: the engine and whether it answers, whether the key is accepted, this agent's effective mode and where it comes from (the agent, its unit or the workspace), the workspace's fail policy, the last decision recorded for this agent, and this session's own settings (context forwarding, sensitive mode, what a hold does). Read-only: it changes nothing and records nothing.

## Configure

Set at least your engine key and URL in the environment Claude Code runs in:

```bash
export CLEVR_API_KEY=clevr_sk_...
export CLEVR_URL=https://your-clevr-host      # default http://localhost:8787
```

| Variable | Default | Meaning |
|---|---|---|
| `CLEVR_API_KEY` | (required) | Org key. If unset, the gate is inactive (allows everything) so it never bricks Claude Code. |
| `CLEVR_URL` | `http://localhost:8787` | Engine base URL. The gate calls `<url>/v1/evaluate`. |
| `CLEVR_AGENT` | `claude-code` | Identity recorded in the audit log. |
| `CLEVR_ESCALATE` | `deny` | What a Hold does on the tool gate: `deny` refuses the action (nothing runs that nobody approved); `allow` lets it through and records that this machine did. There is no option to ask the person at the keyboard: approving your own hold empties the control. |
| `CLEVR_SENSITIVE` | `0` | `1` sends only the action shape to the engine: no prompt, no tool arguments, no tool result, no reply. The tool gate still governs by nature, reach and authority. Use it for a confidential task instead of disabling the plugin. |
| `CLEVR_FORWARD_CONTEXT` | `1` | Forward the last few transcript turns so the engine scans the prompt and situates the tool call in its session. Set `0` to send only the tool call. |
| `CLEVR_CONTEXT_TURNS` | `6` | How many recent transcript turns to forward as context. Raise it to widen the window the engine scans (catches an injection planted earlier in the session), at the cost of a larger payload. |
| `CLEVR_AUTO_APPROVE` | `0` | `1` makes Clevr the sole gate: a Clevr `allow` skips Claude Code's own prompt. Default keeps Clevr additive (it only blocks or escalates). |
| `CLEVR_FAILSAFE` | `open` | On engine error or timeout: `open` allows, `closed` denies. An unset key always allows. |
| `CLEVR_TIMEOUT_MS` | `4000` | Per-call evaluate timeout. |
| `CLEVR_ENV` | (none) | Environment label (`prod` / `staging` / `dev`) sent to the engine. |
| `CLEVR_RESULT_MAX_CHARS` | `8000` | How much of a tool's result to forward for scanning. The detectors work on the text, not the volume. |
| `CLEVR_SESSION_CONTEXT` | `1` | `0` stops the plugin telling the model at session start that it is governed. |

## Rollout

1. **Install.** A new agent starts in Observe: every tool call is evaluated, recorded, and signed; only the safety floor blocks. Watch the decisions in the Clevr console to see what would have been stopped.
2. **Authorize the agent.** With no mandate, the safety floor still blocks what is dangerous by nature (an irreversible shell command, a secret on its way out, a money movement, an unauthorized financial or destructive operation) and holds what needs a human (a credential file, personal data). Ordinary work passes. Give the `claude-code` agent a mandate that names the tools it legitimately uses, and everything outside it is held as an authority outcome.
3. **Promote to Enforce** from the console (on the agent, its unit, or the whole workspace). Blocks and escalations then take effect. No per-machine change needed.

## How it works

The plugin registers six hooks and one command (Node, no dependencies; shared helpers in `hooks/clevr-common.mjs`):

**`PreToolUse` — the action gate (`hooks/clevr-gate.mjs`), matches every tool (`"matcher": "*"`):**

1. Reads the tool call from stdin and maps it to an engine action (`Bash` to `exec`, `Write`/`Edit` to `write`, `Read` to `read`, `mcp__*` to `tool_call`, and so on). The command, path, or arguments are sent as the action text so the deterministic content floor can scan them.
2. Optionally reads the recent conversation from the transcript and the session id, so the same gate that governs the action also gives it meaning in the session.
3. Calls `POST /v1/evaluate` and translates the verdict to `allow` / `ask` / `deny`.

**`UserPromptSubmit` — the prompt scanner (`hooks/clevr-prompt.mjs`), fires on every prompt:**

1. Sends the prompt to `POST /v1/evaluate` so it is scanned for PII, secrets, and prompt injection, and recorded under the session — even on turns that never call a tool. This is the conversation visibility the action gate alone cannot give, since it only sees prompts at tool-call moments.
2. In Enforce, a prompt that trips the content floor is refused before the model sees it; in Observe it is recorded, signed with what would have happened, and proceeds. Skipped under `CLEVR_SENSITIVE=1`.

The prompt rides in the conversation field (which the content detectors scan), not the action field (which the verb safety-floor classifies), so ordinary words like "delete" or "send" in a prompt never misfire as destructive actions.

**`Stop` — the reply recorder (`hooks/clevr-stop.mjs`), fires when the model finishes a turn:**

1. Reads the model's final reply from the transcript and sends it to `POST /v1/evaluate` on the egress channel (the same one the gateway and the Gemini and Cursor answer hooks use), so the model's **own output** is recorded under the session and scanned for content leaks (a secret or personal data the model echoed back).
2. **Record-only.** The reply has already been shown to the user, so this hook never blocks. It makes the output visible in the Clevr conversation and flags a leak for review. Blocking output **before** it is shown is the gateway's job (PROXY mode). Claude Code hands a Stop hook no system prompt, so the prompt-leak check cannot run here. Skipped under `CLEVR_SENSITIVE=1`.

**`PostToolUse` — the result scanner (`hooks/clevr-result.mjs`), matches every tool (`"matcher": "*"`):**

1. Sends what the tool returned to `POST /v1/evaluate` on the tool-result channel, so the engine scans it for credentials handed back and for instructions aimed at the model. The gate judges the request; the payload arrives in the response, which is why this needs its own hook.
2. **The tool has already run, so nothing here un-runs it.** What it does is stop the content from driving the next step: a finding is recorded and signed, you get a message, and the model is told to treat what it just read as data rather than instructions. A hard block ends the turn.
3. Skipped entirely under `CLEVR_SENSITIVE=1`, since a tool result is the most content-heavy payload in the plugin.

**`SessionStart` — the ground rules (`hooks/clevr-session.mjs`), fires once per session:**

Tells the model its actions are governed, that a refusal is a decision and not a tool failure, and that it should report a block rather than look for another route to the same effect. Without it, a model meets its first block as an unexplained failure, and the ordinary response to a failure is to try another way. No network call, so a session never waits on the engine to start. `CLEVR_SESSION_CONTEXT=0` turns it off.

Together the hooks give the GUARD path a full picture of a turn: the prompt that came in, the actions it drove, what those actions brought back, and the reply that went out.

This is the GUARD path of Clevr applied to an agent you did not write — no LLM API key involved, so a subscription Claude Code seat is governed exactly like an API-billed one. For agents whose code you own, use the [SDK](../../sdk); to govern the model call itself on the wire, use PROXY mode (which does require an API key to route through the gateway).

## Requirements

Node is already present wherever Claude Code runs, so the gate has no extra dependencies. The engine must be reachable from that machine at `CLEVR_URL`.
