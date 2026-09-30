# chatgpt-hermes-a2a

Connect **ChatGPT Web to a local Hermes Agent on your Mac** through OpenAI Secure MCP Tunnel, without exposing Hermes or a local MCP server to the public internet.

```text
ChatGPT Web
  ↓
OpenAI Secure MCP Tunnel
  ↓
openai/tunnel-client on your Mac
  ↓ MCP stdio
Hermes UX MCP wrapper (13 tools)
  ├─ native Runs API on 127.0.0.1:8642  ← default for ChatGPT-scoped work
  └─ private @cognicellai/a2a-mcp → A2A on 127.0.0.1:9900  ← legacy/explicit A2A
  ↓
Hermes Agent
  ↓
your local tools / files / browser / workflows
```

This repository does **not** fork Hermes Agent or OpenAI `tunnel-client`. `src/hermes-mcp.mjs` is a small task-oriented MCP wrapper in front of the generic `@cognicellai/a2a-mcp` backend, so ChatGPT sees a clean Hermes-specific tool surface instead of low-level A2A plumbing.

## Start here

If you want to reproduce the complete setup from a fresh Mac, including:

- Hermes installation and A2A enablement;
- local MCP → A2A → Hermes validation;
- OpenAI tunnel creation;
- Tunnels permissions and restricted runtime API key;
- ChatGPT Developer mode / custom app configuration;
- foreground testing;
- persistent macOS LaunchAgent installation;
- troubleshooting;

read **[docs/getting-started.md](docs/getting-started.md)**.

That is the canonical operator guide. This README is the short version plus the bridge reference.

## Requirements

Local bridge requirements:

- macOS for the automated tunnel/background scripts in this repository;
- Node.js `>=20`;
- Git, curl and Python 3;
- Hermes Agent installed and working locally;
- Hermes inbound A2A reachable on `127.0.0.1:9900`.

OpenAI-side requirements:

- access to Secure MCP Tunnel in an OpenAI Platform organization;
- a tunnel scoped to the ChatGPT workspace that will use it;
- a restricted runtime API key whose principal has Tunnels **Read + Use**;
- a ChatGPT account/workspace that currently supports the required custom MCP app actions.

OpenAI product availability and menus evolve independently of this repository. See the current ChatGPT MCP documentation before assuming every plan exposes the same capabilities:

- https://help.openai.com/en/articles/12584461-developer-mode-and-mcp-apps-in-chatgpt
- https://developers.openai.com/api/docs/guides/secure-mcp-tunnels

A known-working reference setup was validated on Apple Silicon macOS with Hermes Agent `0.21.0` and Node `26.8.1`. Those are reference versions, not hard pins; Node `>=20` is the bridge requirement.

## Quick local validation

From Terminal on the Mac where Hermes is installed:

```bash
mkdir -p ~/Projects
cd ~/Projects
(test -d chatgpt-hermes-a2a/.git \
  && git -C chatgpt-hermes-a2a pull --ff-only \
  || git clone https://github.com/pyxl-dev/chatgpt-hermes-a2a.git)
cd chatgpt-hermes-a2a
bash scripts/run-all.sh
```

The diagnostic:

- checks local prerequisites;
- enables Hermes inbound A2A when necessary;
- configures the A2A adapter on localhost port `9900`;
- starts/restarts/installs the Hermes gateway when required;
- validates the Hermes Agent Card;
- installs the pinned MCP bridge dependencies;
- runs a real MCP → private A2A backend → Hermes task;
- requires Hermes to create `/tmp/chatgpt-hermes-ux-proof.txt` with `HERMES_UX_OK`;
- installs/checks OpenAI `tunnel-client`;
- checks tunnel readiness when OpenAI tunnel credentials are already present;
- saves a redacted diagnostic report under `reports/`.

If the OpenAI values are not present yet, the local Hermes path is still fully tested. Fix any local failure before configuring ChatGPT.

Focused checks:

```bash
npm run check
npm run smoke
```

## OpenAI Secure MCP Tunnel in four steps

The detailed screenshots/menu guidance is in [docs/getting-started.md](docs/getting-started.md). The essential flow is:

1. **Create a tunnel** at https://platform.openai.com/settings/organization/tunnels and scope it to the ChatGPT workspace that will use it.
2. **Create a Restricted runtime API key** at https://platform.openai.com/settings/organization/api-keys with Tunnels **Read + Use**. Do not use an admin key for the long-lived daemon.
3. **Start the local runtime** with `bash scripts/connect-openai.sh`; it asks for the `tunnel_...` ID and runtime key, starts the tunnel, waits for `/readyz`, then opens ChatGPT settings.
4. **In ChatGPT**, create a custom MCP app/connector, choose **Connection: Tunnel**, select/paste the same tunnel ID, scan the tools, then test it from a normal conversation.

OpenAI's official macOS install path for `tunnel-client` is currently Homebrew:

```bash
brew install openai/tools/tunnel-client
tunnel-client --version
tunnel-client help quickstart
```

The repository also has a SHA256-verifying fallback downloader, but Homebrew is preferred because current directly downloaded release ZIPs may be blocked by macOS Gatekeeper.

## Persistent macOS runtime

After the foreground ChatGPT test works:

```bash
cd ~/Projects/chatgpt-hermes-a2a
bash scripts/install-background.sh
bash scripts/status.sh
```

The installer:

- reuses the existing tunnel ID when possible;
- stores the restricted runtime API key in macOS Keychain under `chatgpt-hermes-a2a.runtime-api-key`;
- writes and validates the stdio tunnel profile;
- retires the foreground POC tunnel;
- installs `~/Library/LaunchAgents/com.pyxl.chatgpt-hermes-a2a.plist`;
- starts the tunnel immediately and verifies `/readyz`;
- starts it again at login;
- restarts it automatically if `tunnel-client` exits.

Normal use no longer requires an open Terminal window.

Maintenance:

```bash
bash scripts/status.sh
bash scripts/restart.sh
bash scripts/stop.sh
bash scripts/uninstall-background.sh
```

## Runtime entrypoints

- `src/hermes-mcp.mjs` — public MCP wrapper exposed through the tunnel.
- `scripts/start-bridge.sh` — stdio command started by `tunnel-client`.
- `scripts/start-tunnel.sh` — foreground Secure MCP Tunnel launcher.
- `scripts/connect-openai.sh` — guided OpenAI + ChatGPT first connection.
- `scripts/run-all.sh` — setup, diagnostics, local smoke test and report generation.
- `scripts/install-background.sh` — persistent macOS LaunchAgent installer.
- `scripts/setup-hermes-control.sh` — enables the authenticated Hermes Runs API used by normal ChatGPT-scoped delegation and by steer/stop.

Hermes A2A remains bound to loopback. The project does not expose port `9900` to the public internet.

## UX MCP surface

The tunnel-facing server exposes exactly 13 tools. Generic `a2a_*` backend tools remain private behind the wrapper.

| Tool | Use it when | Inputs |
| --- | --- | --- |
| `delegate_to_hermes` | Run ordinary Hermes work; ChatGPT-scoped calls create/reuse one durable native Hermes session through the Runs API | `instruction`, optional `background` |
| `continue_with_hermes` | Continue an existing A2A conversation | `contextId`, `instruction`, optional `taskId`, optional `background` |
| `list_hermes_sessions` | Discover recent durable Hermes conversations | optional `limit`, `source`, `workspace` |
| `get_hermes_session` | Read a durable Hermes conversation | `sessionId`, optional `limit`, optional `includeTools` |
| `continue_hermes_session` | Resume a durable Hermes conversation synchronously | `sessionId`, `instruction` |
| `start_hermes_run` | Start a controllable Hermes run | `instruction`, optional `sessionId` |
| `get_hermes_run` | Poll a controllable run | `runId` |
| `steer_hermes_run` | Inject guidance into a running Hermes run | `runId`, `instruction` |
| `stop_hermes_run` | Request a cooperative Hermes interrupt | `runId` |
| `get_hermes_task` | Poll a background A2A task / get its result | `taskId`, optional `historyLength` |
| `cancel_hermes_task` | Cancel an A2A task envelope | `taskId` |
| `hermes_status` | Check whether the local Hermes alias is reachable | no inputs |
| `hermes_activity` | Read recent local bridge traces without contacting Hermes | optional filters |

For ChatGPT-scoped traffic, `delegate_to_hermes` is synchronous but uses Hermes' native Runs API underneath. The first successful run establishes a durable `sessionId`; later calls automatically submit new Runs into that same session. This avoids the A2A adapter's five-turn anti-loop limit.

Explicit A2A continuation remains available through `continue_with_hermes` for compatibility/debugging. Unscoped local clients also retain the legacy A2A behavior. ChatGPT-scoped A2A background delegation remains disabled.

For durable Hermes conversations, use `list_hermes_sessions` → `get_hermes_session` → `continue_hermes_session`. For work that may need intervention while running, use `start_hermes_run`; retain its `runId`, then call `get_hermes_run`, `steer_hermes_run` or `stop_hermes_run`.

## Observability and duplicate-call protection

Every public MCP call writes one local JSONL trace to:

```text
.runtime/hermes-activity.jsonl
```

A trace includes timing, tool/purpose, a SHA-256 instruction fingerprint, a redacted/truncated instruction preview, task/context/session identifiers, state, success/error and deduplication metadata.

The full instruction is not written to the activity log. `.runtime/` is gitignored; the launcher uses restrictive file permissions.

`hermes_activity` reads this log directly and does not contact Hermes.

For ChatGPT calls, the wrapper now uses `_meta["openai/session"]` as a conversation scope. The raw OpenAI session value is SHA-256 hashed immediately; only the hash is stored in local coordination state and activity traces.

The first mutating Hermes call in a ChatGPT conversation binds that conversation to one canonical route:

- **Native-session route (default)** — `delegate_to_hermes`, `continue_hermes_session`, or `start_hermes_run` uses Hermes' durable native session model. A first `delegate_to_hermes` call may initially have no `sessionId`; once the Run completes, the returned durable `sessionId` is persisted and reused automatically.
- **A2A route (explicit/legacy)** — `continue_with_hermes` can bind a fresh ChatGPT conversation to an existing A2A `contextId`. Existing conversations already bound to A2A stay on that route rather than silently forking into a second native conversation.

After either route is established, ordinary `delegate_to_hermes` calls follow that canonical route. New ChatGPT conversations default to native Runs rather than A2A.

A ChatGPT conversation may have only one mutating Hermes operation active at a time. A second instruction is rejected before it reaches Hermes instead of being queued or launched in parallel. Switching between A2A and native-session routes is also rejected because it would create a second Hermes conversation.

ChatGPT-scoped A2A background delegation is disabled; intentionally asynchronous work should use `start_hermes_run`, whose `runId` can be polled, steered and stopped. Active run/task state and canonical routing are persisted under `.runtime/chatgpt-session-coordinator.json`, so the bridge can reconcile work after a restart.

Exact-instruction deduplication remains as a second line of defense for 60 seconds by default and is scoped by ChatGPT session. Successful replay records are persisted alongside coordinator state for that bounded window, so a bridge restart after Hermes completed work but before ChatGPT received the response cannot cause an exact retry to execute the work again. Native ChatGPT submissions additionally use a persisted operation-scoped idempotency key. Active `runId` state is persisted before synchronous polling begins. If native or A2A delivery is ambiguous, the lock is retained and only an exact retry may reuse the same operation identity, including across a wrapper restart; unrelated work remains blocked. Failed requests known not to have been delivered are released so a genuine retry can execute. ChatGPT-scoped `continue_hermes_session` also uses the authenticated Runs API so it has the same recoverable semantics; unscoped legacy clients retain the CLI continuation path.

Clients that do not send `openai/session` keep the legacy behavior and are not forced into ChatGPT session coordination.

## Enable native Hermes runs

Normal ChatGPT-scoped `delegate_to_hermes` calls and the steer/stop tools use Hermes' authenticated loopback Runs API. Configure it once:

```bash
bash scripts/setup-hermes-control.sh
npm run smoke:control
```

The setup resolves the active Hermes profile, reuses or creates `API_SERVER_KEY` through Hermes configuration, forces the API bind to `127.0.0.1`, restarts the gateway and verifies the Runs API.

This Runs API is required for normal ChatGPT-scoped delegation. Explicit/legacy A2A tools remain available independently, but they are not the default ChatGPT path because Hermes' A2A adapter enforces a five-turn anti-loop limit.

## Security notes

The bridge is intentionally layered so that:

- Hermes A2A stays on loopback;
- the Hermes Runs API used for ChatGPT-scoped delegation stays on loopback and bearer-authenticated;
- the MCP wrapper is local stdio;
- only OpenAI `tunnel-client` makes an outbound connection;
- the generic A2A MCP backend is private to the wrapper;
- the persistent OpenAI runtime key is stored in macOS Keychain;
- local activity logs redact/truncate prompt previews.

This integration is still privileged automation: ChatGPT can cause Hermes to use whatever local permissions and tools you have granted Hermes. Review those permissions accordingly.

See:

- [docs/getting-started.md](docs/getting-started.md) — complete operator setup
- [docs/architecture.md](docs/architecture.md) — implementation and trust boundaries
- [docs/security.md](docs/security.md) — repository-specific security notes
- https://github.com/openai/tunnel-client — official Secure MCP Tunnel client
- https://github.com/NousResearch/hermes-agent — Hermes Agent
