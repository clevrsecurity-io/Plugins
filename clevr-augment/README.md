# Clevr for Augment CLI

Three hooks, and one honest gap.

| Moment | Hook | What Clevr does | Can it stop it? |
|---|---|---|---|
| The prompt you send | none | Read at the end of the turn instead, see below | **No** |
| A tool about to run | `PreToolUse` | Evaluates the call against the mandate and the floor | **Yes** |
| What the tool returned | `PostToolUse` | Scans the payload the model is about to read | **Yes** — `decision: block` |
| The turn, once finished | `Stop` | Scans the conversation it carries | No, records |

## The gap, and what is done about it

Augment exposes no prompt event. There is nowhere to stand between the user
typing and the model reading, so a secret pasted into a prompt cannot be stopped
here.

What exists instead is `Stop`, which fires at the end of a turn and carries the
`conversation`. So the chat is governed **one turn late**: the finding is real,
signed and in the console, and any tool call the turn produced was gated on its
way through. That is worth having and it is not the same thing as prevention,
which is why it is written down rather than glossed.

## Deny only

Augment implements `deny` and has no inline `ask`, so a Hold has no inline
equivalent. It is returned as a deny whose reason says it is **held, not
refused**: the developer reads who it is waiting on, the reviewer answers in
Slack, Teams or the console, and the developer runs it again.

`CLEVR_ESCALATE=allow` inverts it: a Hold proceeds and is only recorded.

## Install

```
git clone https://github.com/clevrsecurity-io/Plugins
cd Plugins/clevr-augment && ./install.sh
```

Or with the Clevr command line, which also writes the environment for you:

```
npm install -g github:clevrsecurity-io/Plugins#cli
clevr login --url https://your-clevr-host --key clevr_sk_...
clevr setup augment
```

Writes the hooks to `~/.clevr/tools` and registers them in
`~/.augment/settings.json`, leaving your own hooks alone. Then export
`CLEVR_URL`, `CLEVR_API_KEY` and `CLEVR_AGENT` where Augment runs.
