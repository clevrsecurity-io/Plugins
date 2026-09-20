# Clevr Plugins

Runtime governance for AI agents, packaged for the coding assistants your team
already uses. Each plugin gates the agent's tool calls in its own runtime loop,
before they run (allow, hold, or block), with a signed audit receipt. No model
reroute, no code change to the agent.

## clevr-claude-code

Govern Claude Code and Claude Desktop through Clevr's policy engine. Six hooks:
every prompt, every tool call before it runs, every tool result, every reply,
sub-agents, and the ground rules at session start. `/clevr-gate:status` says
which engine governs the session, in which mode, and what it last decided.

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
a result and a reply are scanned and reported.

```
git clone https://github.com/clevrsecurity-io/Plugins
cd Plugins/clevr-cursor && ./install.sh
```

Then export `CLEVR_URL` and `CLEVR_API_KEY` where Cursor is launched. Full
setup in [clevr-cursor/README.md](clevr-cursor/README.md).

## clevr-mcp-guard

For any MCP host with no per-tool hook (Claude Desktop connectors, GitHub
Copilot agent mode, Windsurf, hosted agent platforms): a proxy that sits in
front of an MCP server and judges every `tools/call` before relaying it. A
refused call never reaches the tool. Stdio and Streamable HTTP. See
[clevr-mcp-guard/README.md](clevr-mcp-guard/README.md).

## License

MIT.
