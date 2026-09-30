# chatgpt-hermes-a2a

> The repository name is historical. The current bridge is **native-only** and no longer uses Hermes A2A.

This project connects ChatGPT to a local Hermes Agent through OpenAI Secure MCP Tunnel and Hermes' authenticated native Runs API.

## Architecture

```text
ChatGPT
  |
  | OpenAI Secure MCP Tunnel
  v
openai/tunnel-client
  |
  | MCP stdio
  v
src/hermes-mcp.mjs
  |\
  | \ Hermes native session CLI
  |  \-> sessions list / sessions export
  |
  \---- Hermes authenticated Runs API on loopback
       \-> start / status / steer / stop
             |
             v
        Hermes Agent
             |
             v
            macOS
```

There is no A2A backend in the runtime path. The wrapper does not depend on
`@cognicellai/a2a-mcp`, does not require port `9900`, and exposes no A2A task/context tools.

## Public MCP tools

The wrapper exposes exactly 10 tools:

| Tool | Purpose |
| --- | --- |
| `delegate_to_hermes` | Ordinary synchronous work in the ChatGPT conversation's durable Hermes session |
| `list_hermes_sessions` | Discover persisted Hermes sessions |
| `get_hermes_session` | Read a persisted Hermes session |
| `continue_hermes_session` | Continue a specific durable Hermes session through the Runs API |
| `start_hermes_run` | Start controllable asynchronous work |
| `get_hermes_run` | Poll a Run |
| `steer_hermes_run` | Queue guidance into the active Run |
| `stop_hermes_run` | Stop the active Run |
| `hermes_status` | Check native Runs API capabilities |
| `hermes_activity` | Read local redacted activity traces |

## Session model

For ChatGPT-scoped calls, the bridge uses `_meta["openai/session"]` only as a correlation key. The raw value is immediately SHA-256 hashed and is never persisted.

The coordinator maintains one simple model per ChatGPT conversation:

```text
ChatGPT session hash
    -> canonical Hermes sessionId (once known)
    -> zero or one active runId
    -> bounded exact-retry replay
```

Important invariants:

- only one mutating Hermes Run can be active per ChatGPT conversation;
- the first `delegate_to_hermes` call may start without a `sessionId`;
- once Hermes returns a durable `sessionId`, later work reuses it automatically;
- a different explicit `sessionId` is rejected;
- ambiguous POST delivery keeps the conversation locked for an exact idempotent retry;
- a known active `runId` remains locked until a terminal Run state is observed;
- successful terminal results can be replayed for the bounded deduplication window, including across a bridge restart;
- failed/rejected/cancelled/interrupted results are never replayed as success;
- persisted replay payloads expire and are globally pruned.

The persisted coordinator state is stored under:

```text
.runtime/chatgpt-session-coordinator.json
```

Legacy version-1 state is migrated on load. Native session/run state is preserved; old A2A context/task state is discarded because the current runtime no longer supports that execution path.

## Requirements

- macOS for the provided background LaunchAgent workflow;
- Node.js 20 or newer;
- Hermes Agent installed and working locally;
- Hermes authenticated API server enabled on loopback;
- OpenAI `tunnel-client`;
- an OpenAI/ChatGPT workspace that supports the required MCP actions.

The only Node runtime dependency is:

- `@modelcontextprotocol/sdk` `1.30.0`

## Install

```bash
cd ~/Projects
git clone https://github.com/pyxl-dev/chatgpt-hermes-a2a.git
cd chatgpt-hermes-a2a

npm install --no-package-lock --no-audit --no-fund
bash scripts/setup-hermes-control.sh
```

Then validate the local path:

```bash
npm test
npm run check
npm run smoke:control
npm run smoke
```

Or run the combined diagnostic:

```bash
bash scripts/run-all.sh
```

## Native Hermes control API

The bridge requires Hermes' authenticated Runs API. Configure it with:

```bash
bash scripts/setup-hermes-control.sh
```

The helper configures the API server on loopback and resolves/creates the bearer key through Hermes' own configuration surface.

The bridge launcher reads only the values it needs from the active Hermes profile:

- `API_SERVER_KEY`
- `API_SERVER_PORT`

It does not source the complete Hermes environment file.

## Secure MCP Tunnel

The tunnel profile points OpenAI `tunnel-client` at:

```text
/bin/bash /absolute/path/to/chatgpt-hermes-a2a/scripts/start-bridge.sh
```

For a guided foreground setup:

```bash
bash scripts/connect-openai.sh
```

For persistent macOS operation:

```bash
bash scripts/install-background.sh
bash scripts/status.sh
```

Maintenance:

```bash
bash scripts/status.sh
bash scripts/restart.sh
bash scripts/stop.sh
bash scripts/uninstall-background.sh
```

The LaunchAgent/profile/keychain identifiers still contain `chatgpt-hermes-a2a` for backward compatibility with existing installations. They are names only; the runtime no longer uses A2A.

## Testing

`npm test` covers the native coordinator, control idempotency and observability.

`npm run smoke:control` verifies:

- native Run start;
- polling;
- steering;
- cooperative stop;
- terminal cancellation.

`npm run smoke` starts the MCP wrapper over stdio, verifies the exact 10-tool native-only surface, checks native Hermes status/session discovery, delegates a harmless real task, and verifies Hermes used a local tool.

## Observability

Every public tool call appends a redacted trace to:

```text
.runtime/hermes-activity.jsonl
```

The trace stores a hash and truncated/redacted preview of instructions rather than the full prompt. Use `hermes_activity` to inspect it from ChatGPT.

## Security

The relevant trust boundaries are now simpler:

1. ChatGPT ↔ OpenAI Secure MCP Tunnel;
2. tunnel-client ↔ local MCP stdio wrapper;
3. wrapper ↔ Hermes loopback Runs API / native session CLI.

No Hermes port is exposed publicly. The Runs API remains loopback-only and bearer-authenticated.

This is still privileged local automation: Hermes can use whatever local tools and permissions you have granted it.

See:

- [docs/getting-started.md](docs/getting-started.md)
- [docs/architecture.md](docs/architecture.md)
- [docs/security.md](docs/security.md)
- https://github.com/openai/tunnel-client
- https://github.com/NousResearch/hermes-agent
