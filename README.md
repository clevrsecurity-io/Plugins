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

## License

MIT.
