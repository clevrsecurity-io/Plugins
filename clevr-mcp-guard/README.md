# Clevr MCP guard

Governs **any MCP host that has no per-tool hook** — Claude Desktop, GitHub
Copilot agent mode, Windsurf, and other MCP clients — by sitting transparently
between the host and a real MCP server.

## Why this exists

The deepest door for a coding agent is a **preToolUse hook** (Claude Code,
Cursor, Cowork). Some hosts don't expose one: they only speak **MCP** to their
connectors. This proxy is that door for them. It is **not** a fake hook — it
governs at the MCP connector layer, which is the only interception point those
hosts offer. Every path lands the same signed, hash-chained Clevr receipt.

## How it works

The host launches `clevr-mcp-guard` as its "MCP server". The guard spawns the
**real** upstream server and relays JSON-RPC both ways. Before a `tools/call`
reaches the upstream, it is POSTed to `POST /v1/evaluate`:

| Verdict | Effect |
|---|---|
| `allow` / `log` | forwarded to the upstream tool (runs normally) |
| `block` | the call never reaches the tool; the host gets an `isError` result carrying the Clevr reason + decision id |
| `escalate` / `step_up` | held (a stdio proxy can't await an async console approval) |
| any, with `CLEVR_MODE=shadow` | forwarded (record-only); the decision is still sealed |

`CLEVR_FAILSAFE=closed` blocks when the engine is unreachable (default is
fail-open so a brain blip doesn't break every tool).

## Install

```bash
git clone https://github.com/clevrsecurity-io/Plugins   # or use integrations/mcp-guard
```

Wrap each MCP server in the host's config. Claude Desktop
(`Settings > Developer > Edit Config`):

```json
{
  "mcpServers": {
    "filesystem": {
      "command": "node",
      "args": ["/path/to/clevr-mcp-guard.mjs", "--", "npx", "-y", "@modelcontextprotocol/server-filesystem", "/data"],
      "env": {
        "CLEVR_URL": "https://your-clevr-host",
        "CLEVR_API_KEY": "clevr_sk_...",
        "CLEVR_AGENT": "claude-desktop"
      }
    }
  }
}
```

Everything after `--` is the real upstream server command; the guard spawns it.

## Config (env)

| Var | Default | Meaning |
|---|---|---|
| `CLEVR_URL` | — | Clevr engine base URL (required) |
| `CLEVR_API_KEY` | — | `clevr_sk_...` (required; unset = pass through ungoverned, logged to stderr) |
| `CLEVR_AGENT` | `mcp-host` | agent label the calls attribute to |
| `CLEVR_MODE` | enforce | `shadow` = record-only, never blocks |
| `CLEVR_FAILSAFE` | open | `closed` = block when the engine is unreachable |
| `CLEVR_TIMEOUT_MS` | `8000` | per-call evaluate timeout |

## Verified

`node clevr-mcp-guard.mjs -- <upstream>` against the live engine:
a `read_file(~/.ssh/id_rsa)` tool call returns `isError: "Blocked by Clevr:
Content-risk pattern detected: Credential file path"` and **never reaches the
upstream**; under `CLEVR_MODE=shadow` the same call is forwarded (record-only)
and still sealed. See the mode a new agent runs in [in the console](../claude-code/README.md#modes).

---

# Streamable HTTP — for Copilot Studio and any hosted agent platform

`clevr-mcp-guard-http.mjs` is the same gate on the transport a hosted platform
speaks. It is a server, not a pipe: the platform connects to it, it connects to
your MCP server, and every `tools/call` is judged before it is relayed.

```
MCP_UPSTREAM_URL=https://your-mcp-server.example/mcp \
CLEVR_URL=https://clevr.internal.example \
CLEVR_API_KEY=clevr_sk_... \
CLEVR_AGENT=copilot-studio \
MCP_GUARD_KEY=<a secret you invent> \
PORT=8093 \
node clevr-mcp-guard-http.mjs
```

`MCP_GUARD_KEY` is not optional and the guard **refuses to start without it**:
anyone who found the URL would otherwise reach your tools through us, which would
make the guard the hole it exists to close. Behind something that already
authenticates, set `MCP_GUARD_ALLOW_ANONYMOUS=1` and write down why.

`CLEVR_FAILSAFE=closed` refuses instead of forwarding when the engine is
unreachable, and refuses a call that would have passed too: closed means closed.
`MCP_UPSTREAM_HEADERS` takes a JSON object if your MCP server needs its own auth.

### As a service

```bash
MCP_UPSTREAM_URL=https://their-server/mcp MCP_GUARD_KEY=... \
  docker compose --profile mcp-guard up -d mcp-guard
```

Behind a profile because it needs the customer's own MCP server to stand in front
of, so it must not start on its own. Published on host `:8094`.

### Tested

`node integrations/mcp-guard/test-http-guard.mjs` — hermetic, both ends are
stand-ins, twelve assertions and no stack required. The one that matters reads
the upstream server's own log: over a run of five tool calls it shows
`["db.query","db.query","files.delete"]`, so the refused delete and the
fail-closed query are absent. The tool does not run, which is a different claim
from the model being told not to run it.

## Wiring it into Copilot Studio

Copilot Studio agents can use MCP tools (generally available 15 July 2026).

1. Host the guard where Microsoft's cloud can reach it, over HTTPS.
2. In Copilot Studio, open your agent, **Tools** → **Add a tool** → **Model
   Context Protocol**, and point it at the guard's URL with the key as its API
   key credential.
3. The agent now sees exactly the tools your MCP server offers. Nothing changes
   for the agent author, and every call is evaluated first.

**What this covers, and what it does not.** It governs the agent's MCP tools,
completely: a refused call never reaches the server, and the agent is told why in
its own loop. It does **not** see a Power Automate flow, a Dataverse action, a
first-party connector, or the conversation. Microsoft gives no single
interception point in Copilot Studio, so anyone claiming full coverage there
through one install is describing something else.

Measured against a stand-in MCP server: `db.query` forwarded and executed,
`files.delete` refused with the mandate's reason, and the upstream's own log
shows it only ever ran `db.query`. The tool does not run, which is a different
claim from the model being told not to run it.
