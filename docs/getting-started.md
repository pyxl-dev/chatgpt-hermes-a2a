# Getting started: ChatGPT → Secure MCP Tunnel → Hermes native Runs

The repository name is historical. The current bridge is native-only and no longer requires Hermes A2A.

## End state

```text
ChatGPT
  |
  | OpenAI Secure MCP Tunnel
  v
openai/tunnel-client on your Mac
  |
  | MCP stdio
  v
chatgpt-hermes wrapper (10 tools)
  |\
  | \ Hermes native session CLI
  |  \-> sessions list / sessions export
  |
  \---- Hermes authenticated Runs API
       \-> start / status / steer / stop
             |
             v
        Hermes Agent
             |
             v
            macOS
```

Nothing requires exposing Hermes publicly. `tunnel-client` creates the outbound connection to OpenAI and launches the MCP wrapper locally over stdio.

## 0. Requirements

You need:

- macOS for the provided persistent LaunchAgent workflow;
- Git, curl, Node.js 20+ and npm;
- Hermes Agent installed and able to complete a normal local task;
- OpenAI `tunnel-client`;
- an OpenAI Platform/ChatGPT workspace that supports the needed MCP actions.

Reference project:

- https://github.com/NousResearch/hermes-agent
- https://github.com/openai/tunnel-client

## 1. Install Hermes

Use Hermes' official installer/setup and make sure normal local use works before involving ChatGPT.

Typical verification:

```bash
hermes --version
hermes
```

## 2. Clone the bridge

```bash
mkdir -p ~/Projects
cd ~/Projects

git clone https://github.com/pyxl-dev/chatgpt-hermes-a2a.git
cd chatgpt-hermes-a2a

npm install --no-package-lock --no-audit --no-fund
```

The repository name still contains `a2a`, but the runtime dependency set no longer includes an A2A backend.

## 3. Enable Hermes' native Runs API

Configure the authenticated loopback API:

```bash
bash scripts/setup-hermes-control.sh
```

Then verify the control surface:

```bash
npm run smoke:control
```

This validates:

- Run submission;
- Run status;
- steering;
- cooperative stop.

## 4. Validate the MCP wrapper locally

Run:

```bash
npm test
npm run check
npm run smoke
```

The native MCP smoke verifies the exact 10-tool public surface and delegates a harmless task to Hermes.

You can run the combined local diagnostic instead:

```bash
bash scripts/run-all.sh
```

The expected runtime path is:

```text
MCP wrapper -> Hermes native Runs API -> Hermes Agent -> local tools
```

There is no A2A Agent Card, A2A port, A2A bearer token or A2A MCP backend to configure.

## 5. Install OpenAI tunnel-client

Preferred macOS install:

```bash
brew install openai/tools/tunnel-client
```

Verify:

```bash
tunnel-client --version
tunnel-client help quickstart
```

The repository also includes `scripts/install-tunnel-client.sh`.

## 6. Create an OpenAI Secure MCP Tunnel

Create a tunnel in OpenAI Platform and associate it with the ChatGPT workspace that will use it.

The runtime principal/key should have the permissions required to read/use the target tunnel. Keep administrative tunnel credentials separate from the long-lived runtime key.

The normal runtime values are:

```bash
CONTROL_PLANE_TUNNEL_ID="tunnel_..."
CONTROL_PLANE_API_KEY="sk-..."
```

## 7. Test the foreground connection

Use the guided helper:

```bash
cd ~/Projects/chatgpt-hermes-a2a
bash scripts/connect-openai.sh
```

Or run manually after exporting the tunnel values:

```bash
bash scripts/start-tunnel.sh
```

The tunnel profile launches:

```text
/bin/bash /absolute/path/to/chatgpt-hermes-a2a/scripts/start-bridge.sh
```

The bridge launcher resolves Hermes' native API key/port and starts `src/hermes-mcp.mjs` over stdio.

Use one active `tunnel-client` instance per tunnel ID for this stdio setup.

## 8. Configure ChatGPT

Create or refresh the custom MCP app/connector using **Connection: Tunnel** and select the same tunnel used by the local runtime.

After tool discovery, the app should expose exactly:

```text
delegate_to_hermes
list_hermes_sessions
get_hermes_session
continue_hermes_session
start_hermes_run
get_hermes_run
steer_hermes_run
stop_hermes_run
hermes_status
hermes_activity
```

If old A2A tools such as `continue_with_hermes`, `get_hermes_task` or `cancel_hermes_task` still appear, refresh/rescan the MCP app after restarting the bridge on the native-only build.

## 9. First ChatGPT tests

Start read-only:

```text
Use my Hermes app and call hermes_status.
```

Then delegate something harmless:

```text
Use delegate_to_hermes and ask Hermes to inspect the current project status without modifying files.
```

`delegate_to_hermes` waits up to 90 seconds. If Hermes is still working, the tool returns `pending: true` with the active `runId` instead of failing the MCP call; continue with `get_hermes_run`. If the same tool invocation is retried while that Run is active, the bridge reuses the same `runId` rather than submitting the work again.

For persisted-session discovery:

1. `list_hermes_sessions`
2. `get_hermes_session`
3. `continue_hermes_session`

For long-running controllable work:

1. `start_hermes_run`
2. `get_hermes_run`
3. optionally `steer_hermes_run`
4. optionally `stop_hermes_run`

## 10. Conversation/session behavior

For ChatGPT-scoped calls, the wrapper receives a ChatGPT session correlation value from MCP metadata and hashes it locally.

The first normal delegation may start a Hermes Run without an existing durable session ID. Once Hermes returns a `sessionId`, the wrapper binds that session to the ChatGPT conversation.

Later normal delegations automatically reuse the same durable Hermes session.

The coordinator enforces:

- one active mutating Run per ChatGPT conversation;
- one canonical durable Hermes session;
- exact idempotent recovery after ambiguous submission;
- persisted active Run recovery across bridge restart;
- bounded persisted replay for successful exact retries;
- no successful replay for failed/cancelled/rejected/interrupted outcomes.

## 11. Upgrade from the former A2A-enabled bridge

The coordinator state schema is migrated automatically on first load.

From old version-1 mixed-route state (and the intermediate version-2 native replay format):

- native durable session and native Run state are retained;
- A2A context/task state is discarded;
- A2A replay payloads are discarded;
- native single-slot replay entries are migrated into version 3's per-fingerprint replay map.

Before switching the persistent runtime to the native-only build, stop any old A2A job you intentionally left running. The new bridge has no A2A task-control surface because A2A is no longer part of the architecture.

The old configuration file `config/a2a-mcp.config.yaml` and Node dependency `@cognicellai/a2a-mcp` are removed.

## 12. Persistent macOS runtime

After foreground validation:

```bash
bash scripts/install-background.sh
bash scripts/status.sh
```

The installer uses the existing historical identifiers so current installations do not need to be recreated:

```text
LaunchAgent: com.pyxl.chatgpt-hermes-a2a
Keychain service: chatgpt-hermes-a2a.runtime-api-key
Tunnel profile: chatgpt-hermes-a2a
```

These names are compatibility identifiers only.

Maintenance:

```bash
bash scripts/status.sh
bash scripts/restart.sh
bash scripts/stop.sh
bash scripts/uninstall-background.sh
```

## 13. Local observability

Activity traces are stored at:

```text
.runtime/hermes-activity.jsonl
```

Use `hermes_activity` to read recent traces from ChatGPT.

The bridge stores instruction hashes and redacted/truncated previews rather than intentionally storing full prompts.

## 14. Troubleshooting

### Native tools fail

Run:

```bash
bash scripts/setup-hermes-control.sh
npm run smoke:control
```

### MCP wrapper fails to start

Run:

```bash
npm install --no-package-lock --no-audit --no-fund
npm run check
bash scripts/start-bridge.sh
```

### ChatGPT still shows removed A2A tools

Restart the bridge on the new code, then refresh/rescan the custom MCP app so ChatGPT fetches the new tool list.

### Calls behave inconsistently after restart

Verify there is only one `tunnel-client` process for the tunnel ID and run:

```bash
bash scripts/status.sh
```

### A Run timed out in ChatGPT but Hermes may still be working

Do not immediately resubmit different work. The coordinator persists the active `runId` when known and reconciles it before allowing another mutating operation.

### An ambiguous POST returned no runId

An exact retry is allowed with the same persisted idempotency scope. Different work remains blocked until delivery is resolved.

## 15. Update

```bash
cd ~/Projects/chatgpt-hermes-a2a
git pull --ff-only
npm install --no-package-lock --no-audit --no-fund
npm test
npm run check
npm run smoke
bash scripts/restart.sh
bash scripts/status.sh
```

If the public tool schema changed, refresh/rescan the ChatGPT MCP app.

## References

- [architecture.md](architecture.md)
- [security.md](security.md)
- https://github.com/openai/tunnel-client
- https://github.com/NousResearch/hermes-agent
