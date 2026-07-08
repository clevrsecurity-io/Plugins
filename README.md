# Clevr Plugins

Runtime governance for AI agents, packaged for the tools your team already uses. This repository is a Claude Code plugin marketplace.

## clevr-claude-code

Govern Claude Code through Clevr's policy engine: every tool call and every prompt is evaluated **before it runs** (allow, escalate, or block), with a signed audit receipt. No code change to the agent, and no Anthropic API key required, so it works the same on a subscription seat or on API billing.

Install it from inside Claude Code (CLI or desktop app):

```
/plugin marketplace add clevrsecurity-io/Plugins
/plugin install clevr-gate@clevr
```

Then point it at your engine and roll out in shadow mode first. Full setup, configuration, and rollout are in [clevr-claude-code/README.md](clevr-claude-code/README.md).

## License

MIT.
