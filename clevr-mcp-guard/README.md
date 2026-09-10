# Clevr MCP guard (stdio proxy)

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
