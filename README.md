# Clevr Plugins

Runtime governance for AI agents, packaged for the coding assistants your team
already uses. Each plugin gates the agent's tool calls in its own runtime loop,
before they run (allow, escalate, or block), with a signed audit receipt. No
model reroute, no code change to the agent.

## clevr-claude-code

Govern Claude Code through Clevr's policy engine: every tool call and every
prompt is evaluated **before it runs** (allow, escalate, or block), with a
signed audit receipt. No code change to the agent, and no Anthropic API key
required, so it works the same on a subscription seat or on API billing.

Install it from inside Claude Code (CLI or desktop app):

```
/plugin marketplace add clevrsecurity-io/Plugins
/plugin install clevr-gate@clevr
```

Then point it at your engine and roll out in shadow mode first. Full setup,
configuration, and rollout are in [clevr-claude-code/README.md](clevr-claude-code/README.md).

## clevr-cursor (beta)

Govern the Cursor Agent (Composer) through the same engine, with four hooks
inside the agent loop: the prompt you send (`beforeSubmitPrompt`), every tool
about to run (`preToolUse`), what it returned (`postToolUse`) and the reply
(`afterAgentResponse`). A prompt or a tool call is stopped before it happens;
a result and a reply are scanned and reported. Each decision is sealed in a
signed receipt. It gates what the agent does without rerouting the model.

Install it:

```
git clone https://github.com/clevrsecurity-io/Plugins
cd Plugins/clevr-cursor && ./install.sh
```

Then export `CLEVR_URL` and `CLEVR_API_KEY`, and keep `CLEVR_MODE=shadow` to
start. Full setup and all settings are in [clevr-cursor/README.md](clevr-cursor/README.md).

## License

MIT.
