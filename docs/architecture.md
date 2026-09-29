# Architecture

Target path:

~~~text
ChatGPT Web
  |
  | OpenAI Secure MCP Tunnel
  v
openai/tunnel-client (local macOS process)
  |
  | MCP stdio
  v
src/hermes-mcp.mjs
  |\
  | \ native Hermes CLI session API
  |  \--> sessions list / sessions export --session-id / chat --resume
  |  \--> authenticated Runs API :8642 (start/status/steer/stop)
  |
  | private MCP stdio
  v
@cognicellai/a2a-mcp (backend)
  |
  | A2A JSON-RPC / HTTP+JSON on loopback
  v
Hermes Agent A2A adapter :9900
  |
  v
Hermes gateway / agent loop / tools / memory
  |
  v
macOS
~~~

## Why this split

- ChatGPT sees exactly thirteen task-oriented bridge tools rather than the generic A2A backend surface.
- `src/hermes-mcp.mjs` translates A2A task calls into the generic backend's real MCP request shapes and routes durable-session calls through Hermes' documented CLI session surface.
- The generic backend remains a private child MCP server; its agent-list, stream, and push-notification tools are not forwarded.
- Hermes stays an agent rather than becoming a bag of low-level shell/file tools.
- Hermes owns its internal loop, sessions, memory, tools, and local permissions.
- The A2A listener stays on loopback; only the OpenAI tunnel client talks outward.

The public thirteen-tool surface consists of:

- five A2A task/context operations: `delegate_to_hermes`, `continue_with_hermes`, `get_hermes_task`, `cancel_hermes_task`, `hermes_status`;
- one local observability tool: `hermes_activity`;
- three durable Hermes-session operations: `list_hermes_sessions`, `get_hermes_session`, `continue_hermes_session`;
- four controllable-run operations: `start_hermes_run`, `get_hermes_run`, `steer_hermes_run`, `stop_hermes_run`.

## Trust boundaries

There are three deliberately separate control surfaces:

1. **OpenAI ↔ local MCP wrapper** — OpenAI Secure MCP Tunnel terminates into a local stdio child. The MCP wrapper is not exposed on a public HTTP port.
2. **MCP wrapper ↔ Hermes A2A** — generic A2A traffic stays on `127.0.0.1:9900` through the private `@cognicellai/a2a-mcp` child process.
3. **MCP wrapper ↔ Hermes native control/session APIs** — durable session operations use Hermes' CLI and controllable runs use the authenticated loopback Runs API.

This means the tunnel gives ChatGPT access to the wrapper, not arbitrary direct network access to the Hermes gateway or the Mac.

## Bridge observability, session coordination and idempotence

`src/hermes-mcp.mjs` creates a trace for every public tool call and appends it to `.runtime/hermes-activity.jsonl`. The trace records timing, tool/purpose, a safe instruction fingerprint/preview, input/output task and context IDs, state, error status, background mode, deduplication metadata, and the SHA-256 hash of the ChatGPT conversation scope when `_meta["openai/session"]` is present. The raw OpenAI session value is never written to the activity log.

`hermes_activity` is implemented entirely in the wrapper. It reads the local JSONL file and never initializes or calls the private A2A backend.

`src/hermes-session-coordinator.mjs` is the server-side concurrency boundary for ChatGPT calls. It persists only hashed ChatGPT session keys plus canonical Hermes identifiers under `.runtime/chatgpt-session-coordinator.json`.

For each ChatGPT conversation it enforces these invariants:

1. one canonical execution route: either A2A or native Hermes sessions/runs;
2. one mutating Hermes operation active at a time;
3. one canonical A2A `contextId` or durable Hermes `sessionId`;
4. later `delegate_to_hermes` calls automatically continue the canonical A2A context instead of creating another one;
5. a different `contextId`, `sessionId`, execution route, or concurrent operation is rejected before a model call reaches Hermes.

Controllable runs remain marked active until a terminal Runs API state is observed. Nonterminal A2A task envelopes are similarly retained when they occur. Before rejecting a new operation, the coordinator can reconcile a persisted run/task with Hermes so a bridge restart does not leave a completed operation permanently locked.

For scoped ChatGPT traffic, background A2A delegation is disabled in favor of `start_hermes_run`, because A2A cancellation only cancels the task envelope and cannot guarantee interruption of the underlying agent loop.

Exact-instruction deduplication remains a separate 60-second defense. `delegate_to_hermes` now keys that cache by ChatGPT session hash plus normalized instruction, preventing identical instructions from unrelated conversations from sharing a cached A2A context. `continue_hermes_session` keeps its existing key of durable `sessionId` plus normalized instruction. Failed backend attempts are removed from the caches so a real retry can run.

Calls from clients that do not provide `openai/session` keep the prior unscoped behavior for compatibility.

## Dependencies

- Hermes Agent with its `hermes` CLI on PATH; inbound A2A enabled on `127.0.0.1:9900` for the A2A tools.
- Node.js `>=20`.
- `src/hermes-mcp.mjs` and the installed MCP SDK `1.30.0`.
- `@cognicellai/a2a-mcp` `0.1.1`.
- `@modelcontextprotocol/sdk` `1.30.0`.
- OpenAI `tunnel-client`.

The wrapper uses the installed MCP SDK `Client`/`StdioClientTransport` APIs to connect to the existing `a2a-mcp` child process, then maps `delegate_to_hermes` and `continue_with_hermes` to `a2a_send_message`, task reads to `a2a_get_task`, cancellation to `a2a_cancel_task`, and status to `a2a_get_agent_card`.

For controllable work, `src/hermes-control.mjs` calls the Hermes gateway's loopback Runs API. `start_hermes_run` submits an asynchronous run (optionally loading a durable `sessionId`), `get_hermes_run` polls it, `steer_hermes_run` queues guidance at a live tool boundary, and `stop_hermes_run` requests Hermes' cooperative hard-interrupt path. The API remains bound to loopback and bearer-authenticated.

Separately, `list_hermes_sessions` invokes Hermes' native `sessions list` command and parses its compact table into structured discovery metadata. `get_hermes_session` shells no user text: it invokes `hermes sessions export` via Node `execFile`, parses the redacted JSONL export, and removes it; `continue_hermes_session` invokes `hermes chat -q ... -Q --resume <sessionId>` via `execFile`.

## POC success criterion

The local POC is considered valid only if the thirteen-tool UX MCP surface reaches Hermes through the private backend and A2A, and Hermes uses one of its own local tools to create the expected temporary proof file. A text-only response is not sufficient.

For the full operator path from a fresh Mac through OpenAI Platform and ChatGPT configuration, see [`getting-started.md`](getting-started.md).
