# Clevr Plugins

Runtime governance for AI agents, packaged for the tools your team already uses. This repository is a Claude Code plugin marketplace and hosts Clevr's other editor integrations.

## clevr-claude-code

Govern Claude Code through Clevr's policy engine: every tool call and every prompt is evaluated **before it runs** (allow, escalate, or block), with a signed audit receipt. No code change to the agent, and no Anthropic API key required, so it works the same on a subscription seat or on API billing.

Install it from inside Claude Code (CLI or desktop app):

```
/plugin marketplace add clevrsecurity-io/Plugins
/plugin install clevr-gate@clevr
```

Then point it at your engine and roll out in shadow mode first. Full setup, configuration, and rollout are in [clevr-claude-code/README.md](clevr-claude-code/README.md).

## clevr-cursor

Govern the **Cursor Agent (Composer)** through the same engine, using Cursor's [hooks API](https://cursor.com/docs/hooks). A `preToolUse` hook evaluates every Agent tool call (a shell command, a file edit, an MCP tool) **before it runs** and applies the verdict, with a signed receipt. It gates the agent's actions even though Cursor's model stays on Cursor's backend, and it needs no model reroute.

```
cd clevr-cursor && ./install.sh
```

The installer registers the hook in `~/.cursor/hooks.json`. Point it at your engine, start in shadow mode, and flip to enforce when ready. Full setup is in [clevr-cursor/README.md](clevr-cursor/README.md). Beta: validate in your Cursor version before enforcing on client machines.

## clevr-mcp-guard

Govern **any MCP host that has no per-tool hook** (Claude Desktop, GitHub Copilot agent mode, Windsurf, and other MCP clients). It's a small stdio proxy that sits between the host and a real MCP server: before a `tools/call` reaches the tool, it is evaluated by Clevr and a blocked call never runs, with a signed receipt. This is the MCP-connector-layer door for hosts that don't expose a hook, and it works on **local stdio** servers a network gateway can't see. Full setup and host config are in [clevr-mcp-guard/README.md](clevr-mcp-guard/README.md).

## Cowork and VS Code

No separate plugin needed. **Cowork** runs on Claude Code's runtime, so `clevr-claude-code` governs it verbatim. The **official Claude Code extension for VS Code** bundles the CLI and shares the same `~/.claude/settings.json` (hooks, MCP, plugins), so `clevr-claude-code` governs the agent inside VS Code too. **Cursor** is a separate app with its own hooks API — use `clevr-cursor`. Third-party agents (Cline, Roo Code, GitHub Copilot) are **not** governed by Claude Code hooks; where they speak MCP, use `clevr-mcp-guard`.

## Delegation lineage

`clevr-claude-code` reconstructs the **sub-agent delegation chain** from Claude Code's hooks: `agent_id` / `agent_type` on each sub-agent tool call, plus the `SubagentStart` spawn event, are recorded as an `on_behalf_of` chain so the audit lineage branches per sub-agent. The sub-agent handle is the harness's internal identifier, recorded as **asserted**, never presented as an IdP-issued identity.

## License

MIT.
