# Instructions for AI agents

You are an AI coding agent (Claude Code, Codex, Cursor...) and your user asked you to install or use **chatgpt-hermes-a2a**. This file tells you how. Keep the safety rules at the end: they matter more than the rest.

## What it does

It lets **ChatGPT** (web) drive the user's **local Hermes Agent** on their Mac. A small MCP server (`src/hermes-mcp.mjs`, stdio) is launched by OpenAI's `tunnel-client`, which keeps an outbound OpenAI Secure MCP Tunnel open. ChatGPT calls 12 tools; the server forwards the work to Hermes' bearer-authenticated Runs API on loopback and to the Hermes session CLI. Nothing is exposed publicly.

The repository name is historical: the bridge is native-only and no longer uses Hermes A2A (no A2A port, no A2A tools). The LaunchAgent, Keychain and tunnel-profile identifiers still contain `chatgpt-hermes-a2a` for backward compatibility.

The 12 tools: `delegate_to_hermes`, `list_hermes_sessions`, `get_hermes_session`, `continue_hermes_session`, `start_hermes_run`, `get_hermes_run`, `steer_hermes_run`, `stop_hermes_run`, `hermes_status`, `list_hermes_profiles`, `hermes_activity`, `hermes_tool_timeline`.

## Install

Run, then read the output: every line starts with `✓`, `!` (optional piece missing) or `✗` (blocking).

```sh
curl -fsSL https://raw.githubusercontent.com/pyxl-dev/chatgpt-hermes-a2a/main/install.sh | sh
```

It clones into `~/.local/share/chatgpt-hermes-a2a` (or uses the clone it is run from), checks Node.js 22.13+, and runs `npm install`. It does **not** change the Hermes configuration and starts nothing. Then, from that folder:

1. `bash scripts/setup-hermes-control.sh` enables Hermes' authenticated Runs API on loopback and restarts the Hermes gateway. Tell the user before running it. Add `--profile NAME` (repeatable) to open a named Hermes profile to ChatGPT.
2. `npm test && npm run check`, then `npm run smoke:control` and `npm run smoke`. `smoke` delegates a harmless real task to Hermes.
3. `bash scripts/connect-openai.sh` is the guided first connection. It needs two values only the user can provide: an OpenAI tunnel ID (`tunnel_...`) and a restricted runtime API key. Never ask for the key in chat: the script reads it silently from the user's terminal.
4. `bash scripts/install-background.sh` keeps the tunnel running at login (LaunchAgent, key kept in the macOS Keychain). `status.sh`, `restart.sh`, `stop.sh` and `uninstall-background.sh` manage it.

Failures:

- `✗ Node.js ... too old` or missing: tell the user, give the printed command. Do not install system tools without asking.
- `! hermes not found`: Hermes Agent must be installed and working first (https://github.com/NousResearch/hermes-agent).
- `! tunnel-client not found`: `brew install openai/tools/tunnel-client`, or `bash scripts/install-tunnel-client.sh` (checks the SHA-256 of the official release).

Uninstall: `./install.sh --uninstall` from the clone, or the same `curl ... | sh -s -- --uninstall`. It removes the LaunchAgent and the managed clone. The Keychain key, the Hermes API key and the tunnel profile stay.

## Use

- ChatGPT side: create a custom MCP app with **Connection: Tunnel** on the same tunnel, then start with `hermes_status` (read-only). After a tool-list change, refresh the app.
- Ordinary work: `delegate_to_hermes` waits up to 90 s, then returns `pending: true` with a `runId`; poll with `get_hermes_run`. Long or steerable work: `start_hermes_run`, then `get_hermes_run`, `steer_hermes_run`, `stop_hermes_run`.
- One ChatGPT conversation has up to 3 slots (`slot` 1-3), each its own durable Hermes session with one active Run. `get_hermes_run` with no argument waits on all busy slots.
- Profiles: `list_hermes_profiles`, then pass `profile`. A profile is usable only after `setup-hermes-control.sh --profile NAME`.
- Logs and state live in `.runtime/` (gitignored): `hermes-activity.jsonl` (redacted traces, rotated) and `chatgpt-session-coordinator.json`.
- Tests: `npm test` (unit, no Hermes needed), `npm run check` (syntax). Docs: `docs/getting-started.md`, `docs/architecture.md`, `docs/security.md`.

## Safety rules

- This is privileged local automation: Hermes can use every tool and permission the user granted it. Do not widen those permissions.
- Never print, log or commit `API_SERVER_KEY`, the OpenAI runtime key, a tunnel secret or the Discord webhook URL. Never ask the user to paste them in chat.
- Keep Hermes' API server bound to `127.0.0.1` and bearer-authenticated. Never expose it or the MCP wrapper over HTTP.
- Run one `tunnel-client` per tunnel ID.
- Do not delete `.runtime/` while a Run is active: it holds the active `runId` and the idempotency state.
- If a Run seems to have timed out in ChatGPT, do not resubmit different work: the coordinator reconciles the persisted `runId` first.
- Do not frame the bridge as bypassing ChatGPT product controls.
