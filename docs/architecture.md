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

- ChatGPT sees only nine task-oriented bridge tools, which is the interface it knows how to call.
- `src/hermes-mcp.mjs` translates A2A task calls into the generic backend's real MCP request shapes and routes durable-session calls through Hermes' documented CLI session surface.
- The generic backend remains a private child MCP server; its agent-list, stream, and push-notification tools are not forwarded.
- Hermes stays an agent rather than becoming a bag of low-level shell/file tools.
- Hermes owns its internal loop, sessions, memory, tools, and local permissions.
- The A2A listener stays on loopback; only the OpenAI tunnel client talks outward.

## Bridge observability and idempotence

`src/hermes-mcp.mjs` creates a trace for every public tool call and appends it to `.runtime/hermes-activity.jsonl`. The trace records timing, tool/purpose, a safe instruction fingerprint/preview, input/output task and context IDs, state, error status, background mode, and whether the call was deduplicated.

`hermes_activity` is implemented entirely in the wrapper. It reads the local JSONL file and never initializes or calls the private A2A backend.

`delegate_to_hermes` is guarded before `a2a_send_message`: the normalized instruction is SHA-256 hashed and checked against a process-local cache. An identical in-flight mission shares the existing promise; a recently completed successful mission reuses its result for 60 seconds by default. Different normalized instructions produce different keys. Failed backend attempts are removed from the cache so a real retry can run. `continue_hermes_session` applies the same short-window protection with a separate key composed of `sessionId` plus normalized instruction.

The public surface is therefore nine tools: five A2A task/context operations, the read-only `hermes_activity`, and three durable Hermes-session operations (`list_hermes_sessions`, `get_hermes_session`, `continue_hermes_session`).

## Dependencies

- Hermes Agent with its `hermes` CLI on PATH; inbound A2A enabled on 127.0.0.1:9900 for the A2A tools.
- Node.js >=20.
- `src/hermes-mcp.mjs` and the installed MCP SDK 1.30.0.
- @cognicellai/a2a-mcp 0.1.1.
- @modelcontextprotocol/sdk 1.30.0.
- OpenAI tunnel-client.

The wrapper uses the installed MCP SDK `Client`/`StdioClientTransport` APIs to connect to the existing `a2a-mcp` child process, then maps `delegate_to_hermes` and `continue_with_hermes` to `a2a_send_message`, task reads to `a2a_get_task`, cancellation to `a2a_cancel_task`, and status to `a2a_get_agent_card`. Separately, `list_hermes_sessions` invokes Hermes' native `sessions list` command and parses its compact table into structured discovery metadata. `get_hermes_session` shells no user text: it invokes `hermes sessions export` via Node `execFile`, parses the redacted JSONL export, and removes it; `continue_hermes_session` invokes `hermes chat -q ... -Q --resume <sessionId>` via `execFile`.

## POC success criterion

The local POC is considered valid only if the nine-tool UX MCP surface reaches Hermes through the private backend and A2A, and Hermes uses one of its own local tools to create the expected temporary proof file. A text-only response is not sufficient.
