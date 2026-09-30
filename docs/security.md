# Security notes

This project gives a remote ChatGPT session a path to a local Hermes Agent. Treat the bridge as privileged automation.

The repository name and LaunchAgent identifiers still contain `a2a` for backward compatibility with existing installations. The current runtime is native-only and does not use Hermes A2A.

## Runtime security invariants

1. Use OpenAI Secure MCP Tunnel for the ChatGPT-facing transport.
2. Keep the MCP wrapper local stdio; do not expose it as a public HTTP service.
3. Keep Hermes' API server bound to loopback.
4. Protect the Hermes API server with `API_SERVER_KEY`; do not commit or print it.
5. Never commit OpenAI API keys, tunnel runtime keys or Hermes secrets.
6. The wrapper reads only the specific Hermes configuration values it needs rather than sourcing the full Hermes environment.
7. The OpenAI runtime key is stored in macOS Keychain by the persistent installer.
8. `_meta["openai/session"]` is only a correlation key, never an authorization credential.
9. The raw ChatGPT session value is SHA-256 hashed immediately and is never persisted or logged.
10. The bridge exposes exactly 10 native/session/observability tools. No A2A context/task tools are exposed.
11. Only one mutating Hermes Run is allowed per tracked ChatGPT conversation.
12. A different explicit durable Hermes `sessionId` is rejected once a canonical session is bound.
13. Known active `runId` state is persisted before polling continues.
14. Ambiguous native POST delivery retains the conversation lock; only an exact retry can reuse the same operation idempotency key.
15. Network/timeout/5xx ambiguity is distinguished from definitive request rejection.
16. Successful terminal exact retries use bounded persisted replay rather than executing the action again.
17. Failed/rejected/cancelled/interrupted terminal outcomes are never cached as successful replay.
18. Replay payloads are globally pruned after the deduplication window.
19. Returned `sessionId` values are checked against the requested/canonical session before terminal state is accepted.
20. `steer_hermes_run` and `stop_hermes_run` require the exact active `runId` for a tracked ChatGPT conversation.

## Native control API

The bridge uses Hermes' authenticated loopback Runs API for mutating work:

```text
POST /v1/runs
GET  /v1/runs/:id
POST /v1/runs/:id/steer
POST /v1/runs/:id/stop
```

`scripts/setup-hermes-control.sh` configures the API server on loopback and never prints the bearer key.

`scripts/start-bridge.sh` resolves only:

- `API_SERVER_KEY`
- `API_SERVER_PORT`

from Hermes configuration.

## Native session access

`list_hermes_sessions` invokes Hermes' native `sessions list` command.

`get_hermes_session` uses `sessions export --redact`. The temporary JSONL file lives under the gitignored `.runtime/` directory and is deleted in a `finally` block.

The bridge uses Node `execFile` with an argument array, not a shell command string, so supplied session IDs are not shell-interpreted.

`continue_hermes_session` is mutating and uses the authenticated Runs API rather than the CLI continuation path.

## Coordinator state

Session coordination is persisted at:

```text
.runtime/chatgpt-session-coordinator.json
```

Permissions are restricted to the current user where supported.

State version 3 contains hashed ChatGPT session keys, canonical Hermes session IDs, active native Run metadata and a time-bounded replay map keyed by operation fingerprint. All still-live replay entries are retained until expiry so a later successful operation cannot make an earlier exact retry execute again.

When upgrading from the former mixed native/A2A schema or the intermediate native version-2 schema, native state is migrated, old A2A context/task state is discarded, and legacy single-slot replay is converted to the version-3 per-fingerprint map.

Do not intentionally place secrets in Hermes instructions. Replay payload persistence is for delivery safety, not a data-loss-prevention boundary.

## Activity traces

Every public call writes a redacted JSONL trace to:

```text
.runtime/hermes-activity.jsonl
```

The trace stores:

- timing;
- tool name;
- hashed ChatGPT session scope;
- instruction SHA-256;
- redacted/truncated instruction preview;
- Run/session identifiers;
- success/error and deduplication metadata.

It does not intentionally store the full instruction.

`hermes_activity` is read-only and only reads this local file.

## OpenAI tunnel credentials

Keep the long-lived runtime key separate from any administrative key.

Expected runtime values:

```bash
CONTROL_PLANE_TUNNEL_ID=...
CONTROL_PLANE_API_KEY=...
```

The persistent setup stores the runtime API key in macOS Keychain under the historical service name:

```text
chatgpt-hermes-a2a.runtime-api-key
```

The LaunchAgent label is also historical:

```text
com.pyxl.chatgpt-hermes-a2a
```

These names do not imply that A2A is still used.

## Threat model

The integration is powerful because Hermes can use local tools and permissions granted by the operator.

The main risks are therefore:

- untrusted instructions reaching a privileged local agent;
- overly broad Hermes tool permissions;
- leaked tunnel or Hermes API credentials;
- duplicate execution after network ambiguity;
- concurrent local work from the same ChatGPT conversation;
- stale local state after crash/restart.

The native-only coordinator is specifically designed to reduce the last three risks without maintaining a second A2A task/context state machine.

## Before making the repository public

- inspect repository files and Git history for secrets;
- keep runtime files and logs ignored;
- re-run secret scanning;
- document which Hermes local tools are enabled;
- retain loopback binding and bearer authentication for the Runs API;
- do not frame the bridge as bypassing ChatGPT product controls.
