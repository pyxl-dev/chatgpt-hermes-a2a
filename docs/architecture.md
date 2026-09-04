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

- ChatGPT sees only five task-oriented Hermes tools, which is the interface it knows how to call.
- `src/hermes-mcp.mjs` translates those high-level calls into the generic backend's real MCP request shapes.
- The generic backend remains a private child MCP server; its agent-list, stream, and push-notification tools are not forwarded.
- Hermes stays an agent rather than becoming a bag of low-level shell/file tools.
- Hermes owns its internal loop, sessions, memory, tools, and local permissions.
- The A2A listener stays on loopback; only the OpenAI tunnel client talks outward.

## Dependencies

- Hermes Agent with inbound A2A enabled on 127.0.0.1:9900.
- Node.js >=20.
- `src/hermes-mcp.mjs` and the installed MCP SDK 1.30.0.
- @cognicellai/a2a-mcp 0.1.1.
- @modelcontextprotocol/sdk 1.30.0.
- OpenAI tunnel-client.

The wrapper uses the installed MCP SDK `Client`/`StdioClientTransport` APIs to connect to the existing `a2a-mcp` child process, then maps `delegate_to_hermes` and `continue_with_hermes` to `a2a_send_message`, task reads to `a2a_get_task`, cancellation to `a2a_cancel_task`, and status to `a2a_get_agent_card`. `scripts/run-all.sh` and `npm run smoke` exercise that path before any production cutover.

## POC success criterion

The local POC is considered valid only if the five-tool UX MCP surface reaches Hermes through the private backend and A2A, and Hermes uses one of its own local tools to create the expected temporary proof file. A text-only response is not sufficient.
