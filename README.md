# chatgpt-hermes-a2a

POC: ChatGPT Web → OpenAI Secure MCP Tunnel → Hermes MCP UX wrapper → private MCP-to-A2A backend → Hermes Agent A2A → local Mac.

This repository deliberately does not fork Hermes Agent or OpenAI tunnel-client. The public MCP connection is handled by `src/hermes-mcp.mjs`; it delegates to the proven `@cognicellai/a2a-mcp` process over a private stdio connection and keeps that backend's generic tools out of ChatGPT's tool list.

## One-command run

From Terminal on the Mac where Hermes is installed:

~~~bash
mkdir -p ~/Projects && cd ~/Projects && (test -d chatgpt-hermes-a2a/.git && git -C chatgpt-hermes-a2a pull --ff-only || git clone https://github.com/pyxl-dev/chatgpt-hermes-a2a.git) && cd chatgpt-hermes-a2a && bash scripts/run-all.sh
~~~

The runner:

- checks the local prerequisites;
- enables Hermes inbound A2A on localhost:9900 if necessary;
- restarts, starts, or installs the Hermes gateway service when required;
- validates the Hermes Agent Card;
- installs the pinned MCP-to-A2A bridge dependencies;
- calls Hermes through the thirteen-tool UX MCP surface → the private generic MCP backend → A2A and asks Hermes to create a harmless proof file under /tmp;
- downloads the latest official OpenAI tunnel-client for macOS when it is not already installed and verifies it against the release SHA256SUMS;
- if CONTROL_PLANE_TUNNEL_ID and CONTROL_PLANE_API_KEY are already exported, creates/checks the stdio tunnel profile and verifies that the tunnel runtime reaches ready state;
- prints a compact report between REPORT TO SEND BACK markers and saves it under reports/.

If the OpenAI tunnel credentials are not present, the local MCP → A2A → Hermes path is still tested and the report will identify the missing tunnel prerequisites.

## Runtime entrypoints

- src/hermes-mcp.mjs — public UX MCP server; it exposes exactly the thirteen tools listed below, adds bridge-level tracing/idempotence, and connects to the generic backend as a child process.
- scripts/start-bridge.sh — stdio command used by tunnel-client; it preserves runtime config/token generation and starts the UX wrapper.
- scripts/start-tunnel.sh — foreground Secure MCP Tunnel launcher after the two OpenAI tunnel environment variables are available.
- scripts/run-all.sh — setup, diagnostics, smoke test, and report generation.

Hermes A2A remains bound to loopback. The project does not expose port 9900 to the public internet.

See docs/architecture.md and docs/security.md.

## UX MCP surface

The tunnel-facing server exposes exactly these thirteen tools. The generic `a2a_*` tools remain private behind the wrapper.

| Tool | Use it when | Inputs |
| --- | --- | --- |
| `delegate_to_hermes` | Starting a new, independent local Hermes mission | `instruction`, optional `background` |
| `continue_with_hermes` | Following up in an existing A2A conversation | `contextId`, `instruction`, optional `taskId`, optional `background` |
| `list_hermes_sessions` | Discovering recent durable Hermes conversations and their IDs | optional `limit`, `source`, `workspace` |
| `get_hermes_session` | Reading a durable Hermes conversation by native session ID | `sessionId`, optional `limit`, optional `includeTools` |
| `continue_hermes_session` | Resuming a durable Hermes conversation synchronously | `sessionId`, `instruction` |
| `start_hermes_run` | Starting a controllable Hermes run, optionally inside an existing session | `instruction`, optional `sessionId` |
| `get_hermes_run` | Polling a controllable Hermes run | `runId` |
| `steer_hermes_run` | Injecting course-correction guidance into a running Hermes run | `runId`, `instruction` |
| `stop_hermes_run` | Requesting a safe stop of a running Hermes run | `runId` |
| `get_hermes_task` | Polling a background A2A task or retrieving its result | `taskId`, optional `historyLength` |
| `cancel_hermes_task` | Cancelling an A2A task envelope (not a guaranteed agent interrupt) | `taskId` |
| `hermes_status` | Checking whether the local `hermes` alias is reachable | no inputs |
| `hermes_activity` | Reading recent local bridge traces without contacting Hermes | optional `limit`, `tool`, `since`, `deduplicatedOnly`, `errorsOnly` |

Delegation and A2A continuation return a compact normalized response with `text` when available, `taskId`, `contextId`, `state`/`stateName`, and a safe raw fallback. Normal A2A calls wait for Hermes to finish; set `background: true` only for intentionally long-running work and then poll with `get_hermes_task`. `continue_with_hermes` sends the exact supplied `contextId` in the A2A `Message.contextId` field; use `delegate_to_hermes` for a new mission.

For durable Hermes conversations, use `list_hermes_sessions` to discover likely sessions first, then `get_hermes_session` and `continue_hermes_session` with the Hermes `sessionId` (for example `20260905_053252_4248284e`). These tools bypass A2A conversation creation. Session discovery uses Hermes' documented `sessions list` surface and returns compact structured metadata (title/preview, workspace, last activity, source when available, and session ID) without asking the model. It accepts Hermes-native `source` and `workspace` filters. Session reads use Hermes' documented `sessions export --session-id ... --format jsonl --redact` surface, filter out system messages and tool results by default, and delete the temporary export after parsing. Session continuation uses Hermes' documented one-shot resume path (`hermes chat ... --resume <sessionId>`) so Hermes reloads its persisted transcript directly.

For work that may need intervention while it is running, use `start_hermes_run` instead. It uses Hermes' native Runs API and returns a `runId` immediately. The bridge can then poll with `get_hermes_run`, inject guidance with `steer_hermes_run`, or request a cooperative interrupt with `stop_hermes_run`. Steering is queued into the live agent at its next tool boundary; stopping asks Hermes itself to interrupt the active run rather than merely marking an A2A task cancelled.

## Observability and idempotence

Every public MCP call writes one local JSONL trace to `.runtime/hermes-activity.jsonl` by default. The record includes `traceId`, start/end timestamps, `durationMs`, tool name, a `purpose`, SHA-256 `instructionHash`, redacted/truncated `instructionPreview`, input/output `contextId`, `taskId`, and durable `sessionId`, state, success/error, `deduplicated`, `duplicateOfTraceId`, and `background`.

The full instruction is not written to the activity log. The preview is normalized, passed through the bridge redaction rules, and truncated to 240 characters. `.runtime/` remains gitignored; the launcher uses `umask 077` and the wrapper attempts to keep the activity file at mode `0600`.

`hermes_activity` reads that JSONL file directly. It does not call `a2a-mcp` or Hermes. It supports `limit`, `tool`, `since`, `deduplicatedOnly`, and `errorsOnly` filters.

`delegate_to_hermes` now deduplicates an identical normalized mission before `a2a_send_message`. Mission identity is SHA-256 of the instruction after Unicode NFKC normalization, trim, and whitespace collapse. Different normalized instructions therefore produce different keys. `background` is traced but excluded from mission identity because it changes waiting behavior, not the work requested.

The default completed-result window is 60 seconds (`HERMES_DEDUP_WINDOW_MS=60000`). An identical mission that is still in flight remains deduplicable until it settles, even if it runs longer than 60 seconds. Successful duplicates reuse the original result/task/context and return `deduplicated: true` plus `duplicateOfTraceId`. Backend failures remove the cache entry so a later real retry can execute.

`continue_hermes_session` uses the same 60-second completed-result window, keyed by durable `sessionId` plus normalized instruction, so an identical retry does not execute twice in the same Hermes conversation.

The deduplication caches are process-local and clear on bridge restart; JSONL activity history remains on disk. The log path can be overridden with `HERMES_ACTIVITY_LOG=/absolute/path/hermes-activity.jsonl`.

## Enable controllable runs

The steer/stop tools use Hermes' authenticated loopback Runs API. Configure it once:

~~~bash
bash scripts/setup-hermes-control.sh
~~~

The setup resolves the active Hermes profile through `hermes config env-path`, reuses an existing `API_SERVER_KEY` when present or generates one through `hermes config set`, and stores the secret in that profile's env file. It forces the API bind to `127.0.0.1`, restarts the Hermes gateway, and verifies Runs API capabilities. `scripts/start-bridge.sh` resolves the same env path and reads only the exact API key/port values it needs; it never sources the full Hermes environment file.

## Local verification

After Hermes A2A is available on `127.0.0.1:9900`, run:

~~~bash
npm run check
npm run smoke
npm run smoke:control
~~~

`npm run smoke:control` is a separate opt-in functional test: it starts a harmless controllable run, waits for `running`, injects steer guidance, requests stop, and requires the run to settle as `cancelled`. The ordinary smoke does not start a control run.

The smoke test initializes MCP, asserts that `tools/list` contains exactly the thirteen names above, checks `hermes_status`, exercises the read-only `list_hermes_sessions` path, delegates a benign task that creates `/tmp/chatgpt-hermes-ux-proof.txt` with exactly `HERMES_UX_OK`, immediately repeats the exact delegation and verifies reuse of the same `taskId`/`contextId` with `deduplicated: true`, polls it, continues the same `contextId`, and verifies the trace records through `hermes_activity`. To non-destructively exercise native session reading against a known session, run `HERMES_UX_SMOKE_SESSION_ID=<sessionId> npm run smoke`; the smoke reads at most five visible messages and never resumes/modifies that session.


## After the local diagnostic passes

Run the guided OpenAI connection step:

~~~bash
cd ~/Projects/chatgpt-hermes-a2a && git pull --ff-only && bash scripts/connect-openai.sh
~~~

It opens the official Tunnels and Runtime API Keys pages, prompts for the tunnel ID and runtime key (hidden input), starts tunnel-client, waits for readiness, then opens ChatGPT connector settings. Keep that terminal open while testing the plugin.

## Switch the existing LaunchAgent after local tests pass

This is the single recommended cutover command. It rewrites/validates the tunnel profile with `scripts/start-bridge.sh`, reloads the existing LaunchAgent, and then prints its status:

~~~bash
cd ~/Projects/chatgpt-hermes-a2a && bash scripts/install-background.sh && bash scripts/status.sh
~~~

The installer reuses the existing tunnel ID and Keychain runtime key when available. It does not print the key. Do not run this cutover until `npm run smoke` is green.


## Persistent macOS background runtime

After the end-to-end POC succeeds, install the tunnel as a macOS LaunchAgent:

~~~bash
cd ~/Projects/chatgpt-hermes-a2a && git config core.fileMode false && git pull --ff-only && bash scripts/install-background.sh
~~~

The installer:

- reuses the existing tunnel ID when it can discover it from the tunnel-client profile;
- asks once for the Restricted runtime API key if it is not already stored;
- stores that key in macOS Keychain under the service name `chatgpt-hermes-a2a.runtime-api-key`;
- writes/validates the local stdio tunnel profile;
- retires the foreground POC tunnel process;
- installs `~/Library/LaunchAgents/com.pyxl.chatgpt-hermes-a2a.plist`;
- starts the tunnel immediately and verifies `/readyz`;
- automatically starts again at login and restarts if tunnel-client exits.

Once installed, Terminal is not required for normal use.

Maintenance:

~~~bash
bash scripts/status.sh
bash scripts/restart.sh
bash scripts/stop.sh
bash scripts/uninstall-background.sh
~~~

`stop.sh` stops it for the current login session. The LaunchAgent remains installed and starts again next login. `uninstall-background.sh` removes the persistent LaunchAgent; set `DELETE_RUNTIME_KEY=1` if the Keychain item should also be removed.
