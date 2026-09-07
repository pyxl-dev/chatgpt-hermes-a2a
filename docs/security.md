# Security notes

This project gives a remote ChatGPT session a path to an agent that can act on the local Mac. Treat the bridge as privileged automation.

## Invariants

1. Keep Hermes A2A bound to 127.0.0.1. Do not expose port 9900 directly to the public internet.
2. Use OpenAI Secure MCP Tunnel for the ChatGPT-facing transport.
3. Never commit .env, OpenAI API keys, A2A bearer tokens, or tunnel credentials.
4. The runtime config references A2A_BEARER_TOKEN by environment-variable name; it does not write the token into the repo.
5. The diagnostic script reads at most the single A2A_BEARER_TOKEN value from ~/.hermes/.env; it does not source the entire Hermes secret file.
6. The diagnostic writes only /tmp/chatgpt-hermes-ux-proof.txt when testing Hermes tool execution.
7. Reports and runtime logs are gitignored.
8. `src/hermes-mcp.mjs` exposes exactly thirteen UX tools. It does not forward the generic backend's agent-list, stream, or push-notification tools to ChatGPT.
9. The wrapper redacts secret-looking fields in backend fallbacks and never logs the A2A bearer-token value.
10. `hermes_activity` is read-only with respect to Hermes: it reads local JSONL traces without calling the A2A backend.
11. Activity traces do not store the full instruction; they store SHA-256 plus a redacted/truncated preview.
12. `scripts/start-bridge.sh` uses `umask 077`; the wrapper attempts to keep `.runtime/hermes-activity.jsonl` at mode `0600`.
13. `list_hermes_sessions` is read-only with respect to Hermes conversations: it invokes Hermes' native `sessions list` command and returns redacted compact metadata without loading message histories or contacting the model.
14. `get_hermes_session` uses Hermes' native `sessions export` with `--redact`; its temporary JSONL lives under gitignored `.runtime/` and is removed in a `finally` block after parsing.
15. Native session commands use Node `execFile` with argument arrays, not a shell command string, so a supplied `sessionId` or instruction is not shell-interpreted by the bridge.
16. `continue_hermes_session` resumes an existing privileged Hermes conversation and can therefore cause the same local actions that Hermes could perform in that session; treat it as an action tool, not a read-only history tool.
17. Controllable runs use Hermes' authenticated API server on loopback only. `scripts/setup-hermes-control.sh` sets `API_SERVER_HOST=127.0.0.1` and never prints the bearer key.
18. `scripts/start-bridge.sh` reads only `API_SERVER_KEY` and optional `API_SERVER_PORT` from `~/.hermes/.env`; the key is redacted from wrapper errors/results and is never written to the repository or activity log.
19. `steer_hermes_run` can change live agent behavior and `stop_hermes_run` can interrupt active local work. Both require an exact `runId` created under the same authenticated Hermes API profile.

Native session exports are requested with Hermes' own secret redaction and are then passed through the bridge redaction layer before returning to ChatGPT. This is defense in depth, not a formal DLP boundary. The activity preview redaction is also only a safety aid. Do not intentionally put secrets in Hermes instructions. The idempotence cache is process-local: it reduces accidental duplicate execution inside one bridge process, but it is not a transactional guarantee across multiple bridge processes or restarts.

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


## Background runtime on macOS

The persistent setup uses a per-user LaunchAgent. The plist contains only local paths and the command to start the runtime; it does not contain the OpenAI runtime API key.

The runtime API key is stored as a macOS Keychain generic password with service:

`chatgpt-hermes-a2a.runtime-api-key`

At runtime, `scripts/daemon-run.sh` reads that single Keychain item, exports it only into the tunnel-client process environment, and then execs tunnel-client. The key is not written to the repository, LaunchAgent plist, reports, or logs by this project.

The LaunchAgent keeps the tunnel process alive and starts it again at user login. Hermes A2A remains loopback-only.
