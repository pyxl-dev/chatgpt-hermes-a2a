# Architecture

The repository name is historical. The current runtime is **native-only** and does not use Hermes A2A.

## Runtime path

```text
ChatGPT Web
  |
  | OpenAI Secure MCP Tunnel
  v
openai/tunnel-client
  |
  | MCP stdio
  v
src/hermes-mcp.mjs
  |\
  | \ Hermes native session CLI
  |  \-> sessions list
  |  \-> sessions export --session-id
  |
  \---- authenticated Hermes Runs API on loopback
       \-> POST /v1/runs
       \-> GET  /v1/runs/:id
       \-> POST /v1/runs/:id/steer
       \-> POST /v1/runs/:id/stop
             |
             v
        Hermes Agent
             |
             v
            macOS
```

There is no private A2A MCP backend, no A2A task envelope, no A2A context routing and no dependency on port 9900.

## Public MCP surface

The wrapper exposes 10 tools:

- `delegate_to_hermes`
- `list_hermes_sessions`
- `get_hermes_session`
- `continue_hermes_session`
- `start_hermes_run`
- `get_hermes_run`
- `steer_hermes_run`
- `stop_hermes_run`
- `hermes_status`
- `hermes_activity`

Ordinary ChatGPT work should use `delegate_to_hermes`. Long work that may need intervention should use `start_hermes_run` followed by get/steer/stop.

## Trust boundaries

There are two runtime control boundaries:

1. **OpenAI ↔ local MCP wrapper** — Secure MCP Tunnel starts the wrapper as a local stdio child. The wrapper itself is not exposed on a public HTTP port.
2. **MCP wrapper ↔ Hermes** — mutating work uses Hermes' bearer-authenticated Runs API on loopback; persisted session discovery/export uses Hermes' local CLI.

The tunnel gives ChatGPT access to the wrapper, not arbitrary direct network or shell access to the Mac.

## Native session coordinator

`src/hermes-session-coordinator.mjs` is the concurrency/idempotency boundary for ChatGPT-scoped mutating calls.

The raw `_meta["openai/session"]` value is SHA-256 hashed immediately. Only the hash is persisted.

Each record contains:

```text
canonicalSessionId
active:
  operationId
  tool
  kind: native-pending | native-submission-unknown | run
  traceId
  sessionId
  runId
  fingerprint
  ownerInstanceId
  idempotencyKey
recentResult:
  fingerprint
  settledAtMs
  traceId
  payload
```

There is deliberately no route discriminator, `contextId`, `taskId`, A2A state or restore-on-A2A-resumption logic.

## State transitions

### First synchronous delegation

1. `begin()` creates a persisted `native-pending` lease.
2. `control.startRun()` submits the instruction with an operation-scoped idempotency key.
3. Once Hermes returns a `runId`, `complete(... keepActive=true)` persists an active `run`.
4. The wrapper polls the Runs API.
5. On successful terminal completion, the durable `sessionId` is bound and the final result is cached for bounded exact replay.
6. On terminal failure, the active Run is released and no successful replay is cached.

### Later delegation

Later calls automatically use the bound canonical `sessionId`. A different explicit durable session is rejected.

### Ambiguous submission

If POST delivery times out, fails at the network layer, receives a 5xx response, or succeeds without a usable `runId`, the coordinator stores `native-submission-unknown`.

Only an exact retry may recover this state. It reuses the persisted operation idempotency key. Different work remains blocked because Hermes may already have accepted the original Run.

### Known active Run

Once a `runId` is known, it is never replaced by a plain pending state. New mutating work is rejected until the Run becomes terminal.

After a bridge restart, `begin()` reconciles the persisted active Run through `GET /v1/runs/:id` before deciding whether new work is allowed.

### Exact replay

Successful terminal results are persisted for a bounded deduplication window. The fingerprint uses normalized NFKC/trim/collapsed-whitespace instruction text plus operation mode and explicit session binding.

Exact retries inside the window return the prior result rather than resubmitting work, including after a bridge restart.

Failed/rejected/cancelled/interrupted results are not reusable replay payloads.

Expired replay payloads are pruned globally on state load and before persistence.

## Native API idempotency

`src/hermes-control.mjs` computes the Runs API `Idempotency-Key` from:

- the persisted operation scope;
- the target durable session or `new`;
- the same normalized instruction semantics used by the coordinator.

This ensures a retry the coordinator considers exact also reaches Hermes with the same native idempotency key.

## Run control

`start_hermes_run` exposes the same submission path asynchronously. The returned `runId` remains the active mutating operation.

- `get_hermes_run` observes terminal state and can preserve replay for a successful original operation.
- `steer_hermes_run` requires the active `runId` for tracked ChatGPT sessions.
- `stop_hermes_run` requires the active `runId`; if the stop races with natural successful completion, the coordinator preserves the successful replay instead of losing it.

## Persisted-state migration

Coordinator state version 2 is native-only.

When loading version-1 mixed-route state:

- native canonical `sessionId` and native Run state are retained;
- legacy A2A contexts/tasks are discarded;
- only native-looking replay payloads are retained.

This migration exists so existing installations can move to the native-only bridge without keeping the old A2A state machine alive.

## Session discovery

`src/hermes-sessions.mjs` uses Hermes' local CLI for read-only persisted-session access:

- `hermes sessions list`
- `hermes sessions export ... --redact`

User text is not shell-interpreted: Node `execFile` passes command arguments directly.

Mutating continuation uses the Runs API rather than the CLI path.

## Observability

`src/hermes-observability.mjs` appends redacted local traces to:

```text
.runtime/hermes-activity.jsonl
```

The trace includes timing, tool name, hashed ChatGPT session scope, instruction hash/preview, Run/session IDs, success/error state and deduplication metadata.

`hermes_activity` reads this file only; it does not contact Hermes.

## Dependencies

- Hermes Agent with native session CLI and authenticated API server;
- Node.js >=20;
- `@modelcontextprotocol/sdk` 1.30.0;
- OpenAI `tunnel-client`.

The bridge no longer depends on `@cognicellai/a2a-mcp`.

## Validation criterion

A valid local pipeline must prove:

1. the MCP wrapper exposes exactly the native-only 10-tool surface;
2. Hermes native control capabilities are reachable;
3. a real delegated Run reaches Hermes and uses a local tool;
4. start/poll/steer/stop works;
5. coordinator tests cover serialization, idempotent retry, restart recovery, drift, terminal replay and persisted-state migration.
