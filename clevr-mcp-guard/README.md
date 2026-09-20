# Clevr MCP guard

**If your agent reaches its tools through the Clevr gateway, you do not need
this.** Point the client at the gateway's `/mcp` URL and stop reading: every
tool call is judged there before it runs, the client only sees the tools its
mandate allows, and the credentials stay in the gateway, so there is nothing
for the agent to call directly.

The guard exists for the servers a gateway cannot stand in front of: the ones
that run **on the machine**, as the user, over stdio. A filesystem server, a
git server, a local database, a browser driver. There is no network hop to put
a gateway on and no credential to withhold: the process already runs with the
person's own rights. For those, the guard is the same gate, placed locally.

## Three ways an MCP client meets Clevr

| | Where it stands | What the client sees | Can it stop a call? |
|---|---|---|---|
| **The gateway** (`/mcp`) | one URL in front of every server you install there | only the tools the mandate allows; the credentials never leave the gateway | **Yes.** A refused `tools/call` never reaches the server, and the agent has no way to reach the server on its own. |
| **This guard** | on the machine, in front of one local stdio server | the server's own tools | **Yes**, for that server. A refused call never reaches it. |
| **The Clevr MCP server** added to the settings | beside the other servers | two extra tools, `clevr_evaluate` and `clevr_check_resource` | **No.** It lets the client *ask* for a verdict. Nothing obliges it to ask, and nothing stops it when it does not. |

The third row is the one people reach for first, because it is the simplest
thing to type into a settings file. It is not a control: a model that decides
to call `files.delete` on another server never consults it, and a line planted
in a ticket that says "do not call Clevr" is enough to route around it. That is
why a machine carrying only that server is reported as ungoverned by the
endpoint agent, with the server named on its line.

Use the gateway for everything remote. Use the guard for what is local. Add the
Clevr MCP server only to an agent you write yourself and that wants to ask.

## How the guard works

The host launches `clevr-mcp-guard` as if it were the server. The guard spawns
the **real** server behind it and relays JSON-RPC both ways. Handshake,
`tools/list`, prompts, resources and notifications pass through untouched, so a
server the guard has never heard of still works. Every `tools/call` is posted
to `POST /v1/evaluate` first:

| Verdict | What happens |
|---|---|
| Allow | forwarded, and the receipt is already signed |
| Block | the call never reaches the server; the host gets an `isError` result carrying the reason and the decision id, so the model reads it in its own loop |
| Hold | the same, worded as held: the person approves it in the console and runs it again |

The guard then confirms to the engine what it did, so the console says "did not
run" on the guard's word rather than on the verdict alone.

`CLEVR_MODE=shadow` forwards everything and records the verdict, for a first
week of watching. The fail policy comes from the workspace (`GET /v1/failsafe`)
and outranks a hand-set `CLEVR_FAILSAFE`, so every surface fails the same way
when the engine is unreachable.

## Install

The CLI writes it for you, for every stdio server in the host's config, and
takes it back out byte for byte:

```bash
clevr setup claude-desktop     # Claude Desktop connectors
clevr setup copilot            # GitHub Copilot agent mode in VS Code
clevr setup mcp                # any other host: it prints the line to paste
```

By hand, in Claude Desktop (Settings > Developer > Edit Config), the server
command becomes the guard and the original command moves after `--`:

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

Restart the host so it relaunches its servers.

## Configuration

| Variable | Default | Meaning |
|---|---|---|
| `CLEVR_URL` | none | the engine (required) |
| `CLEVR_API_KEY` | none | the agent key; unset, the guard passes everything through and says so on stderr |
| `CLEVR_AGENT` | `mcp-host` | the agent the calls are recorded under |
| `CLEVR_MODE` | enforce | `shadow` forwards and records only |
| `CLEVR_FAILSAFE` | open | the bootstrap before the workspace policy is known; `closed` refuses when the engine is unreachable |
| `CLEVR_TIMEOUT_MS` | `8000` | per-call evaluate timeout |

## What it does not cover

The guard governs the server it wraps and nothing else. A host's built-in
tools, its model traffic and its conversation are out of its reach; the hooks
cover those where a host offers them (Claude Code, Cursor, Gemini CLI, Copilot
CLI, Augment), the gateway covers the model hop. A server reached over HTTP
rather than stdio belongs behind the gateway, not the guard.

## The Streamable HTTP variant

`clevr-mcp-guard-http.mjs` is the same gate on the transport a hosted agent
platform speaks, for a platform that must be pointed at exactly one MCP URL and
cannot use the gateway. It is a server, not a pipe: the platform connects to
it, it connects to your MCP server, and every `tools/call` is judged before it
is relayed. `MCP_GUARD_KEY` is required and the guard refuses to start without
it: anyone who found the URL would otherwise reach your tools through it.

```bash
MCP_UPSTREAM_URL=https://your-mcp-server.example/mcp \
CLEVR_URL=https://clevr.internal.example CLEVR_API_KEY=clevr_sk_... \
CLEVR_AGENT=copilot-studio MCP_GUARD_KEY=<a secret you invent> PORT=8093 \
node clevr-mcp-guard-http.mjs
```

Or as a service: `docker compose --profile mcp-guard up -d mcp-guard`, behind a
profile because it needs your own MCP server to stand in front of.

`test-http-guard.mjs` measures it with a stand-in server and a stand-in engine:
twelve assertions, and the one that matters reads the upstream's own log to
show which tools it actually ran.
