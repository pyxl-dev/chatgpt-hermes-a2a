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
- calls Hermes through the five-tool UX MCP surface → the private generic MCP backend → A2A and asks Hermes to create a harmless proof file under /tmp;
- downloads the latest official OpenAI tunnel-client for macOS when it is not already installed and verifies it against the release SHA256SUMS;
- if CONTROL_PLANE_TUNNEL_ID and CONTROL_PLANE_API_KEY are already exported, creates/checks the stdio tunnel profile and verifies that the tunnel runtime reaches ready state;
- prints a compact report between REPORT TO SEND BACK markers and saves it under reports/.

If the OpenAI tunnel credentials are not present, the local MCP → A2A → Hermes path is still tested and the report will identify the missing tunnel prerequisites.

## Runtime entrypoints

- src/hermes-mcp.mjs — public UX MCP server; it exposes exactly the five tools listed below and connects to the generic backend as a child process.
- scripts/start-bridge.sh — stdio command used by tunnel-client; it preserves runtime config/token generation and starts the UX wrapper.
- scripts/start-tunnel.sh — foreground Secure MCP Tunnel launcher after the two OpenAI tunnel environment variables are available.
- scripts/run-all.sh — setup, diagnostics, smoke test, and report generation.

Hermes A2A remains bound to loopback. The project does not expose port 9900 to the public internet.

See docs/architecture.md and docs/security.md.

## UX MCP surface

The tunnel-facing server exposes exactly these five tools. The generic `a2a_*` tools remain private behind the wrapper.

| Tool | Use it when | Inputs |
| --- | --- | --- |
| `delegate_to_hermes` | Starting a new, independent local Hermes mission | `instruction`, optional `background` |
| `continue_with_hermes` | Following up in an existing Hermes conversation | `contextId`, `instruction`, optional `taskId`, optional `background` |
| `get_hermes_task` | Polling a background task or retrieving its result | `taskId`, optional `historyLength` |
| `cancel_hermes_task` | Stopping an in-flight task | `taskId` |
| `hermes_status` | Checking whether the local `hermes` alias is reachable | no inputs |

Delegation and continuation return a compact normalized response with `text` when available, `taskId`, `contextId`, `state`/`stateName`, and a safe raw fallback. Normal calls wait for Hermes to finish; set `background: true` only for intentionally long-running work and then poll with `get_hermes_task`. `continue_with_hermes` sends the exact supplied `contextId` in the A2A `Message.contextId` field; use `delegate_to_hermes` for a new mission.

## Local verification

After Hermes A2A is available on `127.0.0.1:9900`, run:

~~~bash
npm run smoke
~~~

The smoke test initializes MCP, asserts that `tools/list` contains exactly the five names above, checks `hermes_status`, delegates a benign task that creates `/tmp/chatgpt-hermes-ux-proof.txt` with exactly `HERMES_UX_OK`, polls it, and continues the same `contextId` without changing repository files.


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
