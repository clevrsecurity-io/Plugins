# `clevr` — the command line

Wire an AI coding tool to a Clevr engine, then govern and audit what it does, without opening the console.

```bash
npm install -g github:clevrsecurity-io/Plugins#cli   # once per machine; needs git and Node 20+
clevr login --url https://clevr.your-company.com --email you@company.com
clevr onboard
clevr doctor
```

From a checkout of the source tree, `npm install -g ./cli` does the same.

`onboard` scans the machine, wires every tool it finds, writes `~/.clevr/env.sh`, and offers to source it from your shell profile. `doctor` then tells you, per tool, whether the config, the hook script, the key and the traffic are all real.

## What each surface can actually stop

The CLI never claims a gate a tool does not expose. `clevr setup` with no argument prints this same table.

| Tool | Gate | What it can stop |
| --- | --- | --- |
| `claude-code` | hook | Full enforcement: a Block returns before the tool runs. |
| `claude-code-gateway` | gateway | Sees the conversation, not the local tool call. Pair it with `setup claude-code` for both. |
| `cursor` | hook | The prompt and tool calls can be stopped. A reply is recorded only: Cursor gives afterAgentResponse no output, and hands it no system prompt, so the prompt-leak check cannot run there. |
| `codex` | hook | Local tools only (shell, apply_patch, MCP): hosted tools do not pass through a Codex hook. Full enforcement on those: a Block returns before the tool runs. |
| `codex-gateway` | gateway | Sees the conversation, not the local command. Pair it with `setup codex`. |
| `copilot-cli` | hook | The CLI, not the IDE extension. A tool call can be stopped and a poisoned result withheld; a prompt is recorded only, because Copilot honours a decision from userPromptSubmitted for SDK hooks and not for a command hook. |
| `copilot` | mcp | MCP tools only, for agent mode in the IDE. Its built-in edits are not gated here; for the terminal use `copilot-cli`, which hooks every tool. |
| `augment` | hook | Augment implements deny only, with no inline ask, so a Hold is returned as a refusal that says it is held and how to clear it. It has no prompt event either: the chat is read at Stop, one turn late, so a prompt is recorded and never stopped. |
| `gemini-cli` | hook | Gemini has no inline ask, so a Hold is returned as a refusal that says it is held and how to clear it. The widest coverage of any harness: AfterModel hands a hook the request AND the response, so the reply-side checks that elsewhere need the gateway run here too. |
| `claude-desktop` | mcp | The Chat tab reaches its tools over MCP and has no hook: this wraps those connectors. Cowork sessions in Claude Desktop run the Claude Code plugin hooks (`setup claude-code` covers them). |
| `mcp` | mcp | MCP tools only, and you point each server at the guard yourself. |
| `openai-compatible` | gateway | Sees the conversation, not the tool call. Nothing is written on this machine. |

A hook gate denies before the call runs. An MCP guard denies a call that travels over MCP. A gateway sees the conversation. An exec gate records. Anything a surface cannot do, the CLI says so at setup and again in `doctor`.

## Commands

```
Connect
  login      --url <engine> [--email <you> | --key <clevr_sk_...>]
  logout
  status                          engine, account, key, what is wired, recent traffic
  config     show | set <engine|gateway> <url>

Wire a tool
  onboard    [--yes]              find the AI tools on this machine and wire them
  setup      <tool>... | --all    wire one tool (no argument lists them)
  doctor                          check every wiring, the key and whether traffic arrives
  uninstall  <tool>... | --all    take the wiring back out
  discover   [--report] [--json] [--schedule 09:00] [--unschedule] [--status]

Govern
  agents     list | get <name>
  mandate    list | get <id> | packs | install <pack>
  policy     list | get <id> | delete <id> | impact --tool <name>
  floor                           the safety floor that runs before every rule
  tools                           what the agents have actually called
  people     list
  keys       list | create --name <n> [--agent <id>] [--days N] [--use] | revoke <id>

Read the record
  activity   [--limit N] [--effect hold|block] [--agent <id>]
  stats      [--days N]
  verify     <decision-id> [--json]
  export     decisions [--csv] [--out <file>] [--limit N]
```

`nuke` is an alias for `uninstall --all`.

## Two doors, and why login asks for both

- **`/v1/*`** is the runtime door, authenticated by an agent key. It evaluates actions and reads decisions. The runtime allowlist forbids config writes there by design, so a key alone can never change governance.
- **`/brain/api/*`** is the management door, authenticated by a console session. Policies, mandates, people and keys live behind it.

`clevr login --email` gets you the session and, if you are an admin and have no key stored, offers to mint one. `clevr login --key` alone is enough to wire tools and read the record, and that is the right shape for a build machine.

## What it writes, and how to take it back

| Path | Written by |
| --- | --- |
| `~/.clevr/config.json` | `login` (mode 600) |
| `~/.clevr/env.sh` | `setup` (mode 600) |
| `~/.clevr/tools/*` | `setup` (hook and guard scripts) |
| `~/.claude/settings.json` | `setup claude-code` (hooks and env merged; your own entries kept) |
| `~/.cursor/hooks.json`, `~/.cursor/clevr-hooks/` | `setup cursor` (your own hooks kept) |
| `~/.codex/config.toml` | `setup codex-gateway`, between two markers |
| `claude_desktop_config.json`, VS Code `mcp.json` | `setup claude-desktop`, `setup copilot`; each wrapped server keeps its original command under `_clevr` |
| `~/Library/LaunchAgents/com.clevr.discover.plist` or your crontab | `discover --schedule` |

`clevr uninstall --all` removes every one of them and restores the wrapped MCP servers to exactly the command they had. Nothing is revoked on the engine: use `clevr keys revoke` for that.

## `verify`

```
clevr verify dec_flvey0VEdZCBjH

      ✓ signature      Ed25519 over the decision content
      ✓ content        every signed column still matches
      ✓ chain          follows 60c487e2c9d37440
      ✓ tamper-evident position 443 in the append-only ledger
```

Four independent checks, reported separately, because which one failed is the point. `--json` prints the full receipt, including the hash of the entry before it.

## Notes

- A newly wired agent starts in **Observe**: every action is evaluated, recorded and signed, and only the safety floor blocks, until you promote it in the console.
- Cursor reads the environment it was launched from, so it must be restarted from a shell that has sourced `~/.clevr/env.sh`. `doctor` says so when it is not.
- `discover` reads running processes. A tool that is not running does not appear.
- Scheduling uses launchd on macOS and cron on Linux. Windows is not covered: point Task Scheduler at `node <endpoint-agent> --report`.
