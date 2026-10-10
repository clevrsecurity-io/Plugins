# Clevr for Gemini CLI

Four hooks, and it is the widest coverage of any harness we support.

| Moment | Hook | What Clevr does | Can it stop it? |
|---|---|---|---|
| The prompt you send | `BeforeAgent` | Scans it for personal data, secrets and injection | **Yes** — `decision: deny` |
| A tool about to run | `BeforeTool` | Evaluates the call against the mandate and the floor | **Yes** |
| What the tool returned | `AfterTool` | Scans the payload the model is about to read | **Yes** — `decision: deny` hides it |
| The model's reply | `AfterModel` | Scans it on the way out | Block yes, hold reports |

## Why AfterModel matters more than it looks

`AfterModel` receives the request **and** the response in the same event. That is
the only hook in any harness that does, and it is what lets the reply-side checks
run here with nothing in front of Gemini.

It includes the one question that needs both texts: did the answer give the
system prompt away? The instructions are in `llm_request`, the reply is in
`llm_response`, so the comparison is against this call's own prompt. Nothing is
stored, nothing to configure per agent, and it cannot go stale.

Everywhere else that check needs the gateway on the path.

## The limits, stated

Gemini has **no inline ask**. A Hold is returned as a refusal whose reason says
it is held and how to clear it, so nothing runs uncleared and nobody is told a
queued action was forbidden. `CLEVR_ESCALATE=allow` inverts it: a Hold then
proceeds and is only recorded.

A held **reply** is reported rather than discarded. Dropping an answer someone is
waiting for, in order to tell them a reviewer will look at it later, trades one
problem for a worse one.

## Install

```
git clone https://github.com/clevrsecurity-io/Plugins
cd Plugins/clevr-gemini-cli && ./install.sh
```

Writes the hooks to `~/.clevr/tools` and registers them in
`~/.gemini/settings.json`, leaving your own hooks alone. It checks that the gate
loads before it registers anything. Then export `CLEVR_URL`, `CLEVR_API_KEY` and
`CLEVR_AGENT` where Gemini runs. Run it again to update.

`CLEVR_SENSITIVE=1` turns off everything that carries content (prompt, result and
reply) and keeps the tool gate, which judges the action's shape alone.
