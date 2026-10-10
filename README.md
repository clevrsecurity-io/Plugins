# Clevr Plugins

Runtime governance for AI agents, packaged for the coding assistants your team
already uses. Each plugin gates the agent's tool calls in its own runtime loop,
before they run (allow, hold, or block), with a signed audit receipt. No model
reroute, no code change to the agent.

## clevr-claude-code

Govern Claude Code and Claude Desktop through Clevr's policy engine. Seven
hooks: every prompt, every skill or command typed as `/name`, every tool call
before it runs, every tool result, every reply, sub-agents, and the ground
rules at session start. Each skill the agent loads is checked as that skill,
with the version found on the machine, and the skills your workspace
distributes are installed at the start of each session. Each record names the
machine it comes from, so Clevr says which agent runs on which machine
(`CLEVR_SEND_MACHINE=0` turns it off). `/clevr-gate:status`
says which engine governs the session, in which mode, and what it last decided.

Install it in one command:

```
curl -fsSL https://clevrsecurity.com/install.sh | bash
```

Or from inside Claude Code:

```
/plugin marketplace add clevrsecurity-io/Plugins
/plugin install clevr-gate@clevr
```

Then point it at your engine. A new agent starts in Observe: everything is
evaluated, recorded and signed, and only the safety floor blocks, until you
promote it from the console. Full setup, configuration and rollout are in
[clevr-claude-code/README.md](clevr-claude-code/README.md).

## clevr-cursor

Govern the Cursor Agent (Composer) through the same engine, with four hooks
inside the agent loop: the prompt you send, every tool about to run, what it
returned, and the reply. A prompt or a tool call is stopped before it happens;
a result and a reply are scanned and reported. A skill the agent opens, or one
you type as `/name`, is checked as that skill.

```
git clone https://github.com/clevrsecurity-io/Plugins
cd Plugins/clevr-cursor && ./install.sh
```

Then export `CLEVR_URL` and `CLEVR_API_KEY` where Cursor is launched. Full
setup in [clevr-cursor/README.md](clevr-cursor/README.md).

## clevr-codex

Govern Codex, and the ChatGPT desktop app, which runs the same Codex locally.
Six hooks, the ones Claude Code shares with Codex: the prompt, every tool call
before it runs, every tool result, sub-agents, the reply, and the ground rules
at session start. A skill Codex opens, or one you type as `$name`, is checked
as that skill, and the skills your workspace distributes are installed at the
start of each session. The hooks are shims over the Claude Code ones, so there is one
implementation.

```
git clone https://github.com/clevrsecurity-io/Plugins
cd Plugins/clevr-codex && ./install.sh
```

Then export `CLEVR_URL` and `CLEVR_API_KEY` where Codex runs. Full setup in
[clevr-codex/README.md](clevr-codex/README.md).

## clevr-gemini-cli

Govern the Gemini CLI with four hooks: the prompt you send, every tool call
before it runs, every tool result before the model reads it, and the model's
reply. `AfterModel` hands a hook the request and the response together, so the
reply-side checks, the system prompt given away included, run here with nothing
in front of Gemini. Gemini has no inline ask: a hold is returned as a refusal
that says it is held, and the same call goes through once it is approved.

```
git clone https://github.com/clevrsecurity-io/Plugins
cd Plugins/clevr-gemini-cli && ./install.sh
```

Then export `CLEVR_URL` and `CLEVR_API_KEY` where Gemini runs. Full setup in
[clevr-gemini-cli/README.md](clevr-gemini-cli/README.md).

## clevr-augment

Govern the Augment CLI with three hooks: every tool call before it runs, every
tool result, and the conversation at the end of each turn. Augment implements
deny only, with no inline ask, so a hold comes back as a refusal that says it is
held. It has no prompt event either, so a prompt is read one turn late and
recorded, never stopped; the tool call it leads to is still gated.

```
git clone https://github.com/clevrsecurity-io/Plugins
cd Plugins/clevr-augment && ./install.sh
```

Then export `CLEVR_URL` and `CLEVR_API_KEY` where Augment runs. Full setup in
[clevr-augment/README.md](clevr-augment/README.md).

## clevr-github-copilot

Govern the GitHub Copilot CLI with three hooks: the prompt, every tool call
before it runs, and every tool result, which Copilot lets a hook replace before
the model reads it. A prompt is recorded, not stopped: Copilot honours a decision
there only for hooks written against its SDK. Agent mode in the IDE has no
per-tool hook; wrap its MCP servers with [clevr-mcp-guard](clevr-mcp-guard/README.md).

```
git clone https://github.com/clevrsecurity-io/Plugins
cd Plugins/clevr-github-copilot && ./install.sh
```

Then export `CLEVR_URL` and `CLEVR_API_KEY` where Copilot runs. Full setup in
[clevr-github-copilot/README.md](clevr-github-copilot/README.md).

## clevr-mcp-guard

For any MCP host with no per-tool hook (Claude Desktop connectors, GitHub
Copilot agent mode, Windsurf, hosted agent platforms): a proxy that sits in
front of an MCP server and judges every `tools/call` before relaying it. A
refused call never reaches the tool. Stdio and Streamable HTTP. See
[clevr-mcp-guard/README.md](clevr-mcp-guard/README.md).

## License

MIT.
