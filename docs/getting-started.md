# Getting started: ChatGPT → Secure MCP Tunnel → Hermes Agent

This guide reproduces the full setup from a fresh Mac to a working ChatGPT custom MCP app that can delegate work to a local Hermes Agent.

The end state is:

```text
ChatGPT Web
  |
  | OpenAI Secure MCP Tunnel
  v
openai/tunnel-client on your Mac
  |
  | MCP stdio
  v
chatgpt-hermes-a2a UX wrapper (13 tools)
  |
  | private MCP stdio
  v
@cognicellai/a2a-mcp
  |
  | A2A on 127.0.0.1:9900
  v
Hermes Agent gateway / agent loop / local tools
  |
  v
your Mac
```

Nothing in this setup requires exposing Hermes, port `9900`, or a local MCP HTTP server to the public internet. `tunnel-client` makes an outbound connection to OpenAI and starts this project's MCP wrapper locally over stdio.

## 0. Before you start

You need:

- macOS. The bridge itself is Node-based, but the automated tunnel install and persistent LaunchAgent flow in this repository currently target macOS.
- Git, curl, Python 3 and Node.js 20 or newer.
- Hermes Agent installed and already able to complete a normal local task.
- an OpenAI Platform organization with access to Secure MCP Tunnel;
- a ChatGPT account/workspace that exposes custom MCP apps/connectors and Developer mode where required.

OpenAI product availability changes independently of this repository. As of September 2026, OpenAI's public ChatGPT documentation says full MCP actions are available for Business and Enterprise/Edu workspaces, while Pro custom MCP access is limited to read/fetch actions. Check the current OpenAI documentation for your plan before assuming that every account exposes the same UI or action permissions:

- https://help.openai.com/en/articles/12584461-developer-mode-and-mcp-apps-in-chatgpt
- https://developers.openai.com/api/docs/guides/secure-mcp-tunnels

A known-working reference setup for this project was validated on Apple Silicon macOS with Hermes Agent `0.21.0` and Node `26.8.1`. Those are reference versions, not hard pins; Node `>=20` is the actual bridge requirement.

## 1. Install and configure Hermes Agent

If Hermes is not installed yet, use the official installer:

```bash
curl -fsSL https://hermes-agent.nousresearch.com/install.sh | bash
```

Reload your shell, then finish Hermes setup and make sure the agent works normally before adding ChatGPT to the path:

```bash
source ~/.zshrc 2>/dev/null || true
hermes --version
hermes setup
hermes
```

Official Hermes project and docs:

- https://github.com/NousResearch/hermes-agent
- https://hermes-agent.nousresearch.com/docs/

The bridge does not choose your model provider for you. Configure Hermes with whichever supported provider/model you want and verify that Hermes can use the local tools you intend to delegate to.

## 2. Clone the bridge

```bash
mkdir -p ~/Projects
cd ~/Projects
git clone https://github.com/pyxl-dev/chatgpt-hermes-a2a.git
cd chatgpt-hermes-a2a
```

If you already cloned it:

```bash
cd ~/Projects/chatgpt-hermes-a2a
git pull --ff-only
```

Install the pinned Node dependencies:

```bash
npm install --no-package-lock --no-audit --no-fund
```

The important pinned bridge dependencies are:

- `@cognicellai/a2a-mcp` `0.1.1`
- `@modelcontextprotocol/sdk` `1.30.0`

## 3. Validate the local Hermes path first

Do not debug ChatGPT and Hermes at the same time. First prove that MCP → A2A → Hermes works entirely on the Mac:

```bash
bash scripts/run-all.sh
```

The diagnostic will:

1. check Git, curl, Python, Node, npm and Hermes;
2. enable Hermes inbound A2A if needed;
3. configure the A2A adapter on `127.0.0.1:9900`;
4. start/restart/install the Hermes gateway when needed;
5. validate the Hermes Agent Card;
6. install the pinned bridge dependencies;
7. run the real MCP smoke test through the UX wrapper → private `a2a-mcp` backend → Hermes;
8. ask Hermes to create a harmless local proof file;
9. install/check OpenAI `tunnel-client` and report whether tunnel credentials are present.

The local smoke test is successful only when Hermes actually uses a local tool and creates:

```text
/tmp/chatgpt-hermes-ux-proof.txt
```

with exactly:

```text
HERMES_UX_OK
```

You can rerun the focused checks at any time:

```bash
npm run check
npm run smoke
```

If these fail, fix the local path before creating an OpenAI tunnel.

### What `run-all.sh` changes in Hermes

When necessary, it uses Hermes' own configuration commands to enable the gateway A2A adapter and set its port to `9900`, then restarts the gateway. The endpoint remains loopback-only.

You can inspect it yourself:

```bash
curl -fsS http://127.0.0.1:9900/.well-known/agent-card.json
```

## 4. Optional: enable controllable Hermes runs

The ordinary A2A tools are enough to delegate and continue work. If you also want ChatGPT to start a long-running Hermes run and later poll, steer or stop it, enable Hermes' authenticated loopback Runs API:

```bash
bash scripts/setup-hermes-control.sh
npm run smoke:control
```

This configures the Hermes API server on loopback, resolves or creates its bearer key through Hermes' own config surface, restarts the gateway, then checks the Runs API.

It powers these four bridge tools:

- `start_hermes_run`
- `get_hermes_run`
- `steer_hermes_run`
- `stop_hermes_run`

If you do not need steer/stop, you can leave this step for later.

## 5. Install OpenAI `tunnel-client`

OpenAI currently recommends Homebrew on macOS:

```bash
brew install openai/tools/tunnel-client
```

Then verify it:

```bash
tunnel-client --version
tunnel-client help quickstart
```

This repository also contains `scripts/install-tunnel-client.sh`, which downloads the latest official OpenAI release and checks it against OpenAI's published `SHA256SUMS.txt`. Homebrew is still the preferred manual install path because current OpenAI releases downloaded directly as ZIP files may be blocked by macOS Gatekeeper.

Do not bypass Gatekeeper with `xattr`, `spctl`, or “Open Anyway” just to make a downloaded binary run. Install the official Homebrew formula instead.

Official client:

- https://github.com/openai/tunnel-client

## 6. Create the OpenAI tunnel

Open:

- Tunnels: https://platform.openai.com/settings/organization/tunnels
- Organization roles: https://platform.openai.com/settings/organization/people/roles
- Organization groups: https://platform.openai.com/settings/organization/people/groups

The tunnel is the shared object used by both ChatGPT and the local `tunnel-client` daemon.

### Permissions

Keep the permission split explicit:

- the runtime user/key needs Tunnels **Read** + **Use**;
- a user who creates or edits tunnels needs Tunnels **Read** + **Manage**;
- if the same person manages the tunnel and uses it from ChatGPT, give that role **Read + Manage + Use**.

Prefer roles/groups rather than broad organization-wide permissions.

### Workspace scope matters

When creating the tunnel in the Platform UI, associate it with the ChatGPT workspace that will use it. A tunnel can exist and be healthy in OpenAI Platform yet still be absent from ChatGPT if it was created with the wrong workspace scope.

If you create tunnels through the admin CLI, the equivalent concept is the workspace ID, for example:

```bash
tunnel-client admin tunnels create \
  --name "Hermes on my Mac" \
  --description "ChatGPT to local Hermes Agent" \
  --organization-id <ORG_ID> \
  --workspace-id <WORKSPACE_ID>
```

For the simplest first setup, use the Platform Tunnels UI instead of the admin CLI.

Copy the resulting ID. It looks like:

```text
tunnel_0123456789abcdef0123456789abcdef
```

This becomes `CONTROL_PLANE_TUNNEL_ID`.

## 7. Create the restricted runtime API key

Open:

https://platform.openai.com/settings/organization/api-keys

Create a **Restricted** runtime API key whose principal has, for the target tunnel:

- Tunnels **Read**
- Tunnels **Use**

This key becomes `CONTROL_PLANE_API_KEY`.

Do not use an OpenAI admin key as the long-lived tunnel daemon credential. `OPENAI_ADMIN_KEY` is only needed for tunnel CRUD through commands such as `tunnel-client admin tunnels create|update|delete`.

Keep these values distinct:

| Value | Purpose | Needed by normal daemon? |
| --- | --- | --- |
| `CONTROL_PLANE_TUNNEL_ID` | Identifies the OpenAI tunnel | Yes |
| `CONTROL_PLANE_API_KEY` | Authenticates `doctor` / `run` | Yes |
| `OPENAI_ADMIN_KEY` | Tunnel administration via CLI | No |

## 8. Run the tunnel in the foreground first

The repository has a guided connection script:

```bash
cd ~/Projects/chatgpt-hermes-a2a
bash scripts/connect-openai.sh
```

It will:

- open the OpenAI Tunnels page;
- open the Runtime API Keys page;
- ask for the `tunnel_...` ID;
- read the runtime key with hidden terminal input;
- create/check the local stdio tunnel profile;
- run `tunnel-client`;
- wait until its local `/readyz` endpoint succeeds;
- open ChatGPT connector settings.

Keep that terminal open for the first ChatGPT test. ChatGPT needs the tunnel daemon to be running both for tool discovery and for every later MCP call.

If you prefer to run it manually:

```bash
export CONTROL_PLANE_TUNNEL_ID="tunnel_0123456789abcdef0123456789abcdef"
export CONTROL_PLANE_API_KEY="sk-..."
bash scripts/start-tunnel.sh
```

The profile points OpenAI `tunnel-client` at:

```text
/bin/bash /absolute/path/to/chatgpt-hermes-a2a/scripts/start-bridge.sh
```

`tunnel-client` then starts the MCP wrapper locally over stdio. Hermes itself is not exposed to OpenAI directly.

### Important stdio rule

Run only one active `tunnel-client` instance per tunnel ID for this stdio setup. Two overlapping instances can each start their own MCP child, making initialization and later requests land on different processes.

## 9. Configure ChatGPT

Open:

https://chatgpt.com/#settings/Connectors

OpenAI's naming and menu placement have changed over time between “connectors”, “apps” and “custom MCP apps”. The important settings are the same.

### 9.1 Enable Developer mode if your workspace requires it

Current ChatGPT documentation places Developer mode under the Apps settings. Depending on plan/workspace policy, an admin may need to enable custom MCP apps first.

Typical current path:

```text
ChatGPT
→ Settings
→ Apps
→ Advanced settings
→ Developer mode
```

Business / Enterprise / Edu workspaces can also have admin controls under Workspace settings → Permissions & Roles / Apps.

### 9.2 Create the custom app/connector

While `tunnel-client` is still running and ready:

1. create a new custom MCP app/connector;
2. choose **Connection: Tunnel**;
3. select the tunnel you created, or paste its `tunnel_...` ID;
4. let ChatGPT scan/discover the MCP tools;
5. review the discovered actions;
6. save/create the app.

The same tunnel ID must be used by ChatGPT and by your local `tunnel-client` runtime.

### 9.3 Verify tool discovery

This repository intentionally exposes exactly 13 task-oriented tools to ChatGPT:

```text
delegate_to_hermes
continue_with_hermes
list_hermes_sessions
get_hermes_session
continue_hermes_session
start_hermes_run
get_hermes_run
steer_hermes_run
stop_hermes_run
get_hermes_task
cancel_hermes_task
hermes_status
hermes_activity
```

The generic `a2a_*` backend tools should **not** appear in ChatGPT.

If ChatGPT shows an older set after you update the bridge, use the app/connector refresh or rescan action. ChatGPT does not necessarily enable newly discovered actions automatically after an MCP schema change.

### 9.4 Test from a normal ChatGPT conversation

Start with a read-only status call, for example:

```text
Use my Hermes app and check hermes_status.
```

Then try a harmless delegated task:

```text
Use my Hermes app to delegate a task to Hermes: create /tmp/chatgpt-hermes-chat-test.txt containing CHATGPT_HERMES_OK, then report the result.
```

For a durable Hermes conversation, use `list_hermes_sessions` first, then read or resume a specific session by its native Hermes `sessionId`.

For work that may need intervention while it is running, use `start_hermes_run`, retain the returned `runId`, then use `get_hermes_run`, `steer_hermes_run` or `stop_hermes_run`.

## 10. Make it persistent on macOS

Only do this after the foreground path works from ChatGPT.

```bash
cd ~/Projects/chatgpt-hermes-a2a
bash scripts/install-background.sh
bash scripts/status.sh
```

The installer:

- reuses your existing tunnel ID when possible;
- asks for the restricted runtime key if it is not already stored;
- stores that key in macOS Keychain as `chatgpt-hermes-a2a.runtime-api-key`;
- writes and validates the stdio tunnel profile;
- stops the foreground POC tunnel if it is still running;
- installs `~/Library/LaunchAgents/com.pyxl.chatgpt-hermes-a2a.plist`;
- starts it immediately;
- enables start-at-login and automatic restart.

After that, a Terminal window is not required for normal use.

Maintenance:

```bash
bash scripts/status.sh
bash scripts/restart.sh
bash scripts/stop.sh
bash scripts/uninstall-background.sh
```

`stop.sh` stops the service for the current login session but leaves the LaunchAgent installed. `uninstall-background.sh` removes it. Set `DELETE_RUNTIME_KEY=1` when uninstalling if you also want the Keychain item removed.

## 11. Understand the 13-tool interface

### New A2A missions

Use `delegate_to_hermes` for a new independent mission.

Use `continue_with_hermes` only when you already have the A2A `contextId` from a previous mission and intentionally want to continue that same A2A conversation.

Long-running A2A tasks can be started with `background: true`, then polled with `get_hermes_task`.

### Durable Hermes sessions

Hermes' own persisted sessions are separate from A2A task contexts.

Use:

1. `list_hermes_sessions`
2. `get_hermes_session`
3. `continue_hermes_session`

The bridge uses Hermes' documented native session surfaces rather than asking the model to guess which session exists.

### Controllable runs

Use:

1. `start_hermes_run`
2. `get_hermes_run`
3. `steer_hermes_run`
4. `stop_hermes_run`

These call Hermes' authenticated loopback Runs API and are the preferred surface when you may want to redirect or interrupt the agent during a long task.

### Local observability

Every public bridge call writes a redacted JSONL trace to:

```text
.runtime/hermes-activity.jsonl
```

Use `hermes_activity` from ChatGPT to inspect recent calls without asking Hermes to do anything.

The bridge stores an instruction hash and a redacted/truncated preview, not the full instruction.

## 12. Troubleshooting

### The local smoke test fails

Do not continue to OpenAI yet.

Check:

```bash
hermes --version
hermes gateway status
curl -fsS http://127.0.0.1:9900/.well-known/agent-card.json
npm run check
npm run smoke
```

The A2A Agent Card must be reachable locally before the MCP wrapper can delegate.

### `tunnel-client` is blocked by macOS

Install the supported Homebrew package:

```bash
brew install openai/tools/tunnel-client
```

Do not bypass Gatekeeper for a downloaded ZIP.

### `doctor` says the runtime key cannot use the tunnel

The `CONTROL_PLANE_API_KEY` principal needs Tunnels **Read + Use** on the target tunnel. Re-check the role/group attached to the key's principal.

### The tunnel exists in Platform but is missing in ChatGPT

Check, in this order:

1. the tunnel was created with the correct ChatGPT workspace scope;
2. the ChatGPT connector operator has Tunnels **Read + Use**;
3. the local tunnel daemon is still running;
4. `/readyz` reports ready;
5. the tunnel is not still propagating through the control plane.

This is not automatically a Hermes problem.

### ChatGPT sees the app but not all 13 tools

First verify the local MCP surface:

```bash
npm run smoke
```

Then refresh/rescan the custom app in ChatGPT. MCP tool definitions are not necessarily refreshed automatically after the server changes.

### ChatGPT discovers tools, but calls fail later

The tunnel daemon must remain online for every call, not only initial discovery.

For the foreground test, keep `scripts/connect-openai.sh` running. For daily use, install the LaunchAgent and check:

```bash
bash scripts/status.sh
```

### Calls behave inconsistently after a restart

Make sure there is only one `tunnel-client` process using this tunnel ID. Overlapping stdio runtimes are unsupported.

### `start_hermes_run` / `steer_hermes_run` / `stop_hermes_run` fail

Enable the Hermes control API and validate it:

```bash
bash scripts/setup-hermes-control.sh
npm run smoke:control
```

The ordinary A2A delegation tools can still work even if the optional control API is not configured.

### The same mission did not execute twice

That can be intentional. `delegate_to_hermes` deduplicates identical normalized missions while in flight and for 60 seconds after a successful result by default. This protects against accidental duplicate tool calls from ChatGPT. The cache is process-local and resets when the bridge restarts.

## 13. Security model

The useful property of this architecture is that inbound access to the Mac is not required:

- Hermes A2A stays on `127.0.0.1:9900`;
- the optional Hermes Runs API stays on loopback and uses bearer auth;
- the MCP wrapper is a local stdio child;
- only `tunnel-client` establishes an outbound connection to OpenAI;
- the long-lived OpenAI runtime key is stored in macOS Keychain by the background installer;
- bridge activity logs are local and redact/truncate instruction previews.

But this is still a powerful integration. A ChatGPT custom app can cause Hermes to use the tools and permissions you have given Hermes on your machine. Treat the custom MCP app, its prompts and the data passed into it as privileged automation input. Review Hermes tool permissions accordingly and do not connect an untrusted MCP server.

Read [`security.md`](security.md) for the repository-specific threat model.

## 14. Update the project

```bash
cd ~/Projects/chatgpt-hermes-a2a
git pull --ff-only
npm install --no-package-lock --no-audit --no-fund
npm run check
npm run smoke
bash scripts/restart.sh
bash scripts/status.sh
```

If the public tool list changed, refresh/rescan the custom app in ChatGPT after the local checks are green.

## Useful references

- This project's architecture: [`architecture.md`](architecture.md)
- This project's security notes: [`security.md`](security.md)
- OpenAI Secure MCP Tunnel client: https://github.com/openai/tunnel-client
- OpenAI Secure MCP Tunnel guide: https://developers.openai.com/api/docs/guides/secure-mcp-tunnels
- ChatGPT Developer mode / MCP apps: https://help.openai.com/en/articles/12584461-developer-mode-and-mcp-apps-in-chatgpt
- Hermes Agent: https://github.com/NousResearch/hermes-agent
- Hermes Agent docs: https://hermes-agent.nousresearch.com/docs/
