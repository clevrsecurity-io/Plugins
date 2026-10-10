# Clevr for GitHub Copilot

Two surfaces, and they are not equivalent. Wire the one you actually use.

## Copilot CLI — three hooks (`clevr setup copilot-cli`)

| Moment | Hook | What Clevr does | Can it stop it? |
|---|---|---|---|
| The prompt you send | `userPromptSubmitted` | Scans it for personal data, secrets and injection | **No**, see below |
| A tool about to run | `preToolUse` | Evaluates the call against the mandate and the floor | **Yes** — allow / ask / deny |
| What the tool returned | `postToolUse` | Scans the payload the model is about to read | **Yes** — the result is replaced |

`preToolUse` is where a coding agent's blast radius actually is: not in MCP, in
`bash` and in file edits.

`postToolUse` is the other half, and Copilot is generous here. It lets a hook
REPLACE what the model is given (`modifiedResult`), so a poisoned page or ticket
is substituted with a quarantine notice rather than merely annotated: the text
never enters the context at all. Most harnesses only let you append a warning.

**The prompt hook cannot stop a prompt, and that is Copilot's rule rather than
ours.** `userPromptSubmitted` honours a returned decision only for hooks written
against Copilot's SDK, not for a config-file command hook like this one. So the
prompt is scanned and recorded, the finding is signed and in the console, and any
tool call it leads to is still gated. A hook that cannot block must not be sold
as one that can.

The gate shares its config, its evaluate call and its fail-open/fail-closed
behaviour with the Claude Code gate, so the two cannot drift apart. Only two
things differ, because only two things differ in the contract: Copilot sends
`{timestamp, cwd, toolName, toolArgs}` and expects the decision at the top level
rather than nested under `hookSpecificOutput`.

Registered in `~/.copilot/hooks/clevr.json` (`COPILOT_HOME` overrides the
directory), on its own so your other hooks are untouched.

### Install

```
git clone https://github.com/clevrsecurity-io/Plugins
cd Plugins/clevr-github-copilot && ./install.sh
```

Then export `CLEVR_URL`, `CLEVR_API_KEY` and `CLEVR_AGENT` where Copilot runs.
Or with the Clevr command line, which also writes the environment for you:

```
npm install -g github:clevrsecurity-io/Plugins#cli
clevr login --url https://your-clevr-host --key clevr_sk_...
clevr setup copilot-cli
```

## Agent mode in the IDE — MCP only (`clevr setup copilot`)

Agent mode inside the editor calls tools over **MCP** and exposes no per-tool
hook, so Clevr governs it at the connector layer with the
[Clevr MCP guard](https://github.com/clevrsecurity-io/Plugins/tree/main/clevr-mcp-guard): wrap each MCP server so every call is
evaluated by `POST /v1/evaluate` before it runs, and a blocked call never reaches
the tool. Same signed receipt as a hook, but **MCP tools only** — Copilot's own
edits in the editor are not gated by this path.

### Install

`clevr setup copilot` wraps the servers already in VS Code's user MCP
configuration for you. By hand, for a workspace: get `clevr-mcp-guard.mjs`
from [clevr-mcp-guard](https://github.com/clevrsecurity-io/Plugins/tree/main/clevr-mcp-guard), then in your workspace
`.vscode/mcp.json`:

```json
{
  "servers": {
    "github": {
      "command": "node",
      "args": [
        "/path/to/clevr-mcp-guard.mjs", "--",
        "npx", "-y", "@modelcontextprotocol/server-github"
      ],
      "env": {
        "CLEVR_URL": "https://your-clevr-host",
        "CLEVR_API_KEY": "clevr_sk_...",
        "CLEVR_AGENT": "github-copilot"
      }
    }
  }
}
```

Reload VS Code. Copilot agent-mode tool calls now show in the console with a
signed receipt; a blocked one returns an `isError` result. `CLEVR_MODE=shadow`
records only.

## Coverage note

This is **MCP/connector-layer** coverage — the tools Copilot invokes. Copilot's
model completions run on GitHub's backend and are outside this path. For Claude
Code or Cursor running inside VS Code, use their own hooks instead, which gate
every tool call: [clevr-claude-code](https://github.com/clevrsecurity-io/Plugins/tree/main/clevr-claude-code),
[clevr-cursor](https://github.com/clevrsecurity-io/Plugins/tree/main/clevr-cursor).
