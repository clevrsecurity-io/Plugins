# Clevr for Cursor

Four hooks, inside the agent loop.

| Moment | Hook | What Clevr does | Can it stop it? |
|---|---|---|---|
| The prompt you send | `beforeSubmitPrompt` | Scans it for personal data, secrets and injection | **Yes** — `continue: false` |
| A tool about to run | `preToolUse` | Evaluates the call against the mandate and the floor | **Yes** |
| What the tool returned | `postToolUse` | Scans the payload the model is about to read | No, warns with `additional_context` |
| The agent's reply | `afterAgentResponse` | Scans it on the way out | No, records |

## What this replaces

Cursor used to be listed as a gateway door with a note that hooks were "on the
roadmap". That was wrong twice over: the hooks exist, and Composer being locked
to Cursor's backend stopped mattering the moment they did. The hooks sit inside
the agent loop, so the model being Cursor's is irrelevant to whether its actions
are governed.

## The two limits, stated

`postToolUse` has no way to withhold a result. A blocked one is reported with the
strongest wording available and the model is told to treat the content as data,
but the text has already been handed over. Copilot CLI and Gemini CLI can
actually withhold it; Cursor cannot.

`afterAgentResponse` receives the reply text **and nothing else**. No system
prompt, so the one check that needs both texts — did the answer give the
instructions away? — cannot run here. It runs where the harness provides both:
the gateway, and Gemini CLI's `AfterModel`. The event also has no output fields,
so this records and never stops.

## Install

```
npx clevr-cli setup cursor
```

Writes the hooks to `~/.cursor/clevr-hooks` and registers them in
`~/.cursor/hooks.json`, leaving your own hooks alone.

Cursor takes its configuration from the environment it was **launched** with, not
from a config file, so restart it from a shell that has sourced `~/.clevr/env.sh`.
