# Security notes

This project gives a remote ChatGPT session a path to an agent that can act on the local Mac. Treat the bridge as privileged automation.

## Invariants

1. Keep Hermes A2A bound to 127.0.0.1. Do not expose port 9900 directly to the public internet.
2. Use OpenAI Secure MCP Tunnel for the ChatGPT-facing transport.
3. Never commit .env, OpenAI API keys, A2A bearer tokens, or tunnel credentials.
4. The runtime config references A2A_BEARER_TOKEN by environment-variable name; it does not write the token into the repo.
5. The diagnostic script reads at most the single A2A_BEARER_TOKEN value from ~/.hermes/.env; it does not source the entire Hermes secret file.
6. The diagnostic writes only /tmp/chatgpt-hermes-a2a-proof.txt when testing Hermes tool execution.
7. Reports and runtime logs are gitignored.

## OpenAI tunnel credentials

Keep the long-lived runtime key separate from any admin key. The runtime principal should have only the tunnel permissions required to read/use the target tunnel.

Expected environment variables for the launcher:

~~~bash
CONTROL_PLANE_TUNNEL_ID=...
CONTROL_PLANE_API_KEY=...
~~~

The scripts never print the API key value.

## Before making the repo public

- Review all files and Git history for secrets.
- Remove generated reports/logs (they are already ignored).
- Re-run secret scanning.
- Document exactly what local actions Hermes is allowed to perform.
- Keep the project framed as an explicit user-authorized local automation bridge, not a mechanism for bypassing ChatGPT product controls.
