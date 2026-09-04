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
@cognicellai/a2a-mcp
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

- ChatGPT sees an MCP server, which is the interface it knows how to call.
- The MCP server translates high-level calls into A2A requests.
- Hermes stays an agent rather than becoming a bag of low-level shell/file tools.
- Hermes owns its internal loop, sessions, memory, tools, and local permissions.
- The A2A listener stays on loopback; only the OpenAI tunnel client talks outward.

## Dependencies

- Hermes Agent with inbound A2A enabled on 127.0.0.1:9900.
- Node.js >=20.
- @cognicellai/a2a-mcp 0.1.1.
- @modelcontextprotocol/sdk 1.30.0.
- OpenAI tunnel-client.

The first compatibility question is empirical: whether Hermes current A2A implementation and the A2A v1 client used by @cognicellai/a2a-mcp interoperate cleanly. scripts/run-all.sh is designed to answer that before any custom bridge is written.

## POC success criterion

The local POC is considered valid only if an MCP tool call reaches Hermes through A2A and Hermes uses one of its own local tools to create the expected temporary proof file. A text-only response is not sufficient.
