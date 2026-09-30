import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createHermesSessionCoordinator } from "./hermes-session-coordinator.mjs";

async function makeCoordinator(options = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "hermes-session-test-"));
  let counter = 0;
  const coordinator = createHermesSessionCoordinator({
    root,
    randomUUID: () => "id-" + ++counter,
    ...options,
  });
  return { root, coordinator };
}

const metaA = { "openai/session": "chatgpt-conversation-a" };
const metaB = { "openai/session": "chatgpt-conversation-b" };

test("hashes ChatGPT session metadata without persisting the raw id", async () => {
  const { root, coordinator } = await makeCoordinator();
  const scope = coordinator.scopeFromMeta(metaA);
  assert.equal(scope.tracked, true);
  assert.match(scope.sessionHash, /^[a-f0-9]{64}$/u);
  assert.notEqual(scope.sessionHash, metaA["openai/session"]);

  const lease = await coordinator.begin(scope, {
    mode: "delegate",
    tool: "delegate_to_hermes",
    traceId: "trace-1",
    instruction: "inspect the repository",
  });
  await coordinator.complete(scope, lease.operationId, {
    payload: { ok: true, sessionId: "native-1" },
    traceId: "trace-1",
    sessionId: "native-1",
  });

  const state = await fs.readFile(
    path.join(root, ".runtime", "chatgpt-session-coordinator.json"),
    "utf8",
  );
  assert.equal(state.includes(metaA["openai/session"]), false);
});

test("rejects a second mutating operation while one is active", async () => {
  const { coordinator } = await makeCoordinator();
  const scope = coordinator.scopeFromMeta(metaA);

  await coordinator.begin(scope, {
    mode: "delegate",
    tool: "delegate_to_hermes",
    traceId: "trace-1",
    instruction: "first operation",
  });

  await assert.rejects(
    coordinator.begin(scope, {
      mode: "delegate",
      tool: "delegate_to_hermes",
      traceId: "trace-2",
      instruction: "different operation",
    }),
    (error) =>
      error?.code === "HERMES_SESSION_BUSY" &&
      error?.details?.active?.traceId === "trace-1",
  );
});

test("defaults delegate to one canonical native session and reuses it", async () => {
  const { coordinator } = await makeCoordinator();
  const scope = coordinator.scopeFromMeta(metaA);

  const first = await coordinator.begin(scope, {
    mode: "delegate",
    tool: "delegate_to_hermes",
    traceId: "trace-1",
    instruction: "first",
  });
  assert.equal(first.canonicalRoute, "native");
  assert.equal(first.sessionIdToUse, null);
  assert.equal(first.contextIdToUse, null);

  await coordinator.complete(scope, first.operationId, {
    payload: { ok: true, sessionId: "native-canonical" },
    traceId: "trace-1",
    sessionId: "native-canonical",
  });

  const second = await coordinator.begin(scope, {
    mode: "delegate",
    tool: "delegate_to_hermes",
    traceId: "trace-2",
    instruction: "follow up",
  });
  assert.equal(second.sessionIdToUse, "native-canonical");
  assert.equal(second.contextIdToUse, null);
  assert.equal(second.canonicalRoute, "native");
});

test("replays an identical completed instruction inside the dedup window", async () => {
  const { coordinator } = await makeCoordinator({ dedupWindowMs: 60_000 });
  const scope = coordinator.scopeFromMeta(metaA);

  const first = await coordinator.begin(scope, {
    mode: "delegate",
    tool: "delegate_to_hermes",
    traceId: "trace-original",
    instruction: "same instruction",
  });
  await coordinator.complete(scope, first.operationId, {
    payload: { ok: true, sessionId: "native-1", text: "done" },
    traceId: "trace-original",
    sessionId: "native-1",
  });

  const replay = await coordinator.begin(scope, {
    mode: "delegate",
    tool: "delegate_to_hermes",
    traceId: "trace-retry",
    instruction: "same   instruction",
  });
  assert.equal(replay.replay, true);
  assert.equal(replay.replayPayload.text, "done");
  assert.equal(replay.replayPayload.deduplicated, true);
  assert.equal(replay.replayPayload.duplicateOfTraceId, "trace-original");
});

test("failed first continuation does not poison canonical route or ids", async () => {
  const { coordinator } = await makeCoordinator();
  const scope = coordinator.scopeFromMeta(metaA);

  const provisional = await coordinator.begin(scope, {
    mode: "continue-context",
    tool: "continue_with_hermes",
    traceId: "trace-bad",
    instruction: "bad first continuation",
    requestedContextId: "ctx-mistyped",
  });
  await coordinator.fail(scope, provisional.operationId);

  const afterFailure = await coordinator.inspect(scope);
  assert.equal(afterFailure.canonicalRoute, null);
  assert.equal(afterFailure.canonicalContextId, null);
  assert.equal(afterFailure.canonicalSessionId, null);
  assert.equal(afterFailure.active, null);

  const native = await coordinator.begin(scope, {
    mode: "continue-session",
    tool: "continue_hermes_session",
    traceId: "trace-good",
    instruction: "valid native continuation",
    requestedSessionId: "native-valid",
  });
  assert.equal(native.canonicalRoute, "native");
  assert.equal(native.sessionIdToUse, "native-valid");
});

test("invalid resumable context keeps the original task locked", async () => {
  const { coordinator } = await makeCoordinator();
  const scope = coordinator.scopeFromMeta(metaA);

  const lease = await coordinator.begin(scope, {
    mode: "continue-context",
    tool: "continue_with_hermes",
    traceId: "trace-input",
    instruction: "needs input",
    requestedContextId: "ctx-canonical",
  });
  await coordinator.complete(scope, lease.operationId, {
    payload: {
      ok: true,
      taskId: "task-input",
      contextId: "ctx-canonical",
      stateName: "input-required",
    },
    traceId: "trace-input",
    taskId: "task-input",
    contextId: "ctx-canonical",
    keepActive: true,
    activeKind: "a2a-task",
    activeStateName: "input-required",
  });

  await assert.rejects(
    coordinator.begin(scope, {
      mode: "continue-context",
      tool: "continue_with_hermes",
      traceId: "trace-wrong-context",
      instruction: "resume with wrong context",
      requestedContextId: "ctx-wrong",
      requestedTaskId: "task-input",
    }),
    (error) => error?.code === "HERMES_CONTEXT_MISMATCH",
  );

  const snapshot = await coordinator.inspect(scope);
  assert.equal(snapshot.active?.taskId, "task-input");
  assert.equal(snapshot.active?.stateName, "input-required");
  assert.equal(snapshot.canonicalContextId, "ctx-canonical");
});

test("deduplicated resumable retry preserves the active task lock", async () => {
  const { coordinator } = await makeCoordinator({ dedupWindowMs: 60_000 });
  const scope = coordinator.scopeFromMeta(metaA);

  const initial = await coordinator.begin(scope, {
    mode: "continue-context",
    tool: "continue_with_hermes",
    traceId: "trace-initial",
    instruction: "needs input",
    requestedContextId: "ctx-canonical",
  });
  await coordinator.complete(scope, initial.operationId, {
    payload: {
      ok: true,
      taskId: "task-input",
      contextId: "ctx-canonical",
      stateName: "input-required",
    },
    traceId: "trace-initial",
    taskId: "task-input",
    contextId: "ctx-canonical",
    keepActive: true,
    activeKind: "a2a-task",
    activeStateName: "input-required",
  });

  const resume = await coordinator.begin(scope, {
    mode: "continue-context",
    tool: "continue_with_hermes",
    traceId: "trace-resume",
    instruction: "same resume answer",
    requestedContextId: "ctx-canonical",
    requestedTaskId: "task-input",
  });
  await coordinator.complete(scope, resume.operationId, {
    payload: {
      ok: true,
      taskId: "task-input",
      contextId: "ctx-canonical",
      stateName: "input-required",
      text: "still needs input",
    },
    traceId: "trace-resume",
    taskId: "task-input",
    contextId: "ctx-canonical",
    keepActive: true,
    activeKind: "a2a-task",
    activeStateName: "input-required",
  });

  const retry = await coordinator.begin(scope, {
    mode: "continue-context",
    tool: "continue_with_hermes",
    traceId: "trace-resume-retry",
    instruction: "same   resume   answer",
    requestedContextId: "ctx-canonical",
    requestedTaskId: "task-input",
  });

  assert.equal(retry.replay, true);
  assert.equal(retry.replayPayload.text, "still needs input");
  assert.equal(retry.replayPayload.deduplicated, true);

  const snapshot = await coordinator.inspect(scope);
  assert.equal(snapshot.active?.taskId, "task-input");
  assert.equal(snapshot.active?.stateName, "input-required");

  await assert.rejects(
    coordinator.begin(scope, {
      mode: "delegate",
      tool: "delegate_to_hermes",
      traceId: "trace-parallel",
      instruction: "parallel work must stay blocked",
    }),
    (error) => error?.code === "HERMES_SESSION_BUSY",
  );
});

test("failed resumable retry restores the original active task lock", async () => {
  const { coordinator } = await makeCoordinator();
  const scope = coordinator.scopeFromMeta(metaA);

  const initial = await coordinator.begin(scope, {
    mode: "continue-context",
    tool: "continue_with_hermes",
    traceId: "trace-initial",
    instruction: "needs input",
    requestedContextId: "ctx-canonical",
  });
  await coordinator.complete(scope, initial.operationId, {
    payload: {
      ok: true,
      taskId: "task-input",
      contextId: "ctx-canonical",
      stateName: "input-required",
    },
    traceId: "trace-initial",
    taskId: "task-input",
    contextId: "ctx-canonical",
    keepActive: true,
    activeKind: "a2a-task",
    activeStateName: "input-required",
  });

  const resume = await coordinator.begin(scope, {
    mode: "continue-context",
    tool: "continue_with_hermes",
    traceId: "trace-resume",
    instruction: "answer for Hermes",
    requestedContextId: "ctx-canonical",
    requestedTaskId: "task-input",
  });

  const duringRetry = await coordinator.inspect(scope);
  assert.equal(duringRetry.active?.kind, "a2a-pending");
  assert.equal(duringRetry.active?.taskId, "task-input");

  await coordinator.fail(scope, resume.operationId);

  const restored = await coordinator.inspect(scope);
  assert.equal(restored.active?.kind, "a2a-task");
  assert.equal(restored.active?.taskId, "task-input");
  assert.equal(restored.active?.stateName, "input-required");
  assert.equal(restored.active?.contextId, "ctx-canonical");

  await assert.rejects(
    coordinator.begin(scope, {
      mode: "delegate",
      tool: "delegate_to_hermes",
      traceId: "trace-parallel",
      instruction: "parallel work must remain blocked",
    }),
    (error) => error?.code === "HERMES_SESSION_BUSY",
  );
});

test("context drift during a resumable retry restores the original task lock", async () => {
  const { coordinator } = await makeCoordinator();
  const scope = coordinator.scopeFromMeta(metaA);

  const initial = await coordinator.begin(scope, {
    mode: "continue-context",
    tool: "continue_with_hermes",
    traceId: "trace-initial",
    instruction: "needs input",
    requestedContextId: "ctx-canonical",
  });
  await coordinator.complete(scope, initial.operationId, {
    payload: {
      ok: true,
      taskId: "task-input",
      contextId: "ctx-canonical",
      stateName: "input-required",
    },
    traceId: "trace-initial",
    taskId: "task-input",
    contextId: "ctx-canonical",
    keepActive: true,
    activeKind: "a2a-task",
    activeStateName: "input-required",
  });

  const resume = await coordinator.begin(scope, {
    mode: "continue-context",
    tool: "continue_with_hermes",
    traceId: "trace-resume",
    instruction: "resume",
    requestedContextId: "ctx-canonical",
    requestedTaskId: "task-input",
  });

  await assert.rejects(
    coordinator.complete(scope, resume.operationId, {
      payload: {
        ok: true,
        taskId: "task-input",
        contextId: "ctx-drifted",
        stateName: "input-required",
      },
      traceId: "trace-resume",
      taskId: "task-input",
      contextId: "ctx-drifted",
      keepActive: true,
      activeKind: "a2a-task",
      activeStateName: "input-required",
    }),
    (error) => error?.code === "HERMES_CONTEXT_DRIFT",
  );

  const restored = await coordinator.inspect(scope);
  assert.equal(restored.active?.kind, "a2a-task");
  assert.equal(restored.active?.taskId, "task-input");
  assert.equal(restored.active?.stateName, "input-required");
  assert.equal(restored.active?.contextId, "ctx-canonical");

  await assert.rejects(
    coordinator.begin(scope, {
      mode: "delegate",
      tool: "delegate_to_hermes",
      traceId: "trace-parallel",
      instruction: "parallel work must remain blocked",
    }),
    (error) => error?.code === "HERMES_SESSION_BUSY",
  );
});

test("rejects a returned context that differs from the first requested binding", async () => {
  const { coordinator } = await makeCoordinator();
  const scope = coordinator.scopeFromMeta(metaA);

  const lease = await coordinator.begin(scope, {
    mode: "continue-context",
    tool: "continue_with_hermes",
    traceId: "trace-first-context",
    instruction: "continue exact context",
    requestedContextId: "ctx-requested",
  });

  await assert.rejects(
    coordinator.complete(scope, lease.operationId, {
      payload: { ok: true, contextId: "ctx-returned" },
      traceId: "trace-first-context",
      contextId: "ctx-returned",
    }),
    (error) => error?.code === "HERMES_CONTEXT_DRIFT",
  );

  const snapshot = await coordinator.inspect(scope);
  assert.equal(snapshot.canonicalContextId, null);
  assert.equal(snapshot.active, null);
});

test("rejects a returned session that differs from the first requested binding", async () => {
  const { coordinator } = await makeCoordinator();
  const scope = coordinator.scopeFromMeta(metaA);

  const lease = await coordinator.begin(scope, {
    mode: "continue-session",
    tool: "continue_hermes_session",
    traceId: "trace-first-session",
    instruction: "continue exact session",
    requestedSessionId: "session-requested",
  });

  await assert.rejects(
    coordinator.complete(scope, lease.operationId, {
      payload: { ok: true, sessionId: "session-returned" },
      traceId: "trace-first-session",
      sessionId: "session-returned",
    }),
    (error) => error?.code === "HERMES_NATIVE_SESSION_DRIFT",
  );

  const snapshot = await coordinator.inspect(scope);
  assert.equal(snapshot.canonicalSessionId, null);
  assert.equal(snapshot.active, null);
});

test("completion session drift with a known run keeps the run locked", async () => {
  const { coordinator } = await makeCoordinator();
  const scope = coordinator.scopeFromMeta(metaA);

  const lease = await coordinator.begin(scope, {
    mode: "start-run",
    tool: "start_hermes_run",
    traceId: "trace-drift-start",
    instruction: "run in exact session",
    requestedSessionId: "session-a",
  });

  await assert.rejects(
    coordinator.complete(scope, lease.operationId, {
      payload: {
        ok: true,
        runId: "run-drift",
        sessionId: "session-b",
      },
      traceId: "trace-drift-start",
      runId: "run-drift",
      sessionId: "session-b",
      keepActive: true,
      activeKind: "run",
    }),
    (error) => error?.code === "HERMES_NATIVE_SESSION_DRIFT",
  );

  const snapshot = await coordinator.inspect(scope);
  assert.equal(snapshot.canonicalSessionId, null);
  assert.equal(snapshot.active?.kind, "run");
  assert.equal(snapshot.active?.runId, "run-drift");
  assert.equal(snapshot.active?.sessionId, "session-a");
});

test("observed session drift keeps the active run locked", async () => {
  const { coordinator } = await makeCoordinator();
  const scope = coordinator.scopeFromMeta(metaA);

  const lease = await coordinator.begin(scope, {
    mode: "start-run",
    tool: "start_hermes_run",
    traceId: "trace-run",
    instruction: "run",
    requestedSessionId: "session-a",
  });
  await coordinator.complete(scope, lease.operationId, {
    payload: { ok: true, runId: "run-1", sessionId: "session-a" },
    traceId: "trace-run",
    runId: "run-1",
    sessionId: "session-a",
    keepActive: true,
    activeKind: "run",
  });

  await assert.rejects(
    coordinator.observe(scope, {
      kind: "run",
      id: "run-1",
      terminal: true,
      sessionId: "session-b",
    }),
    (error) => error?.code === "HERMES_NATIVE_SESSION_DRIFT",
  );

  const snapshot = await coordinator.inspect(scope);
  assert.equal(snapshot.canonicalSessionId, "session-a");
  assert.equal(snapshot.active?.runId, "run-1");
});

test("reconciliation session drift keeps the active run locked", async () => {
  const { coordinator } = await makeCoordinator();
  const scope = coordinator.scopeFromMeta(metaA);

  const lease = await coordinator.begin(scope, {
    mode: "start-run",
    tool: "start_hermes_run",
    traceId: "trace-run",
    instruction: "run",
    requestedSessionId: "session-a",
  });
  await coordinator.complete(scope, lease.operationId, {
    payload: { ok: true, runId: "run-1", sessionId: "session-a" },
    traceId: "trace-run",
    runId: "run-1",
    sessionId: "session-a",
    keepActive: true,
    activeKind: "run",
  });

  await assert.rejects(
    coordinator.begin(scope, {
      mode: "delegate",
      tool: "delegate_to_hermes",
      traceId: "trace-next",
      instruction: "next",
      reconcileActive: async () => ({
        terminal: true,
        sessionId: "session-b",
      }),
    }),
    (error) => error?.code === "HERMES_NATIVE_SESSION_DRIFT",
  );

  const snapshot = await coordinator.inspect(scope);
  assert.equal(snapshot.active?.runId, "run-1");
});

test("ambiguous native submission permits only an identical recovery retry", async () => {
  const { coordinator } = await makeCoordinator();
  const scope = coordinator.scopeFromMeta(metaA);

  const first = await coordinator.begin(scope, {
    mode: "delegate",
    tool: "delegate_to_hermes",
    traceId: "trace-first",
    instruction: "same native request",
  });
  await coordinator.markSubmissionUnknown(scope, first.operationId);

  await assert.rejects(
    coordinator.begin(scope, {
      mode: "delegate",
      tool: "delegate_to_hermes",
      traceId: "trace-other",
      instruction: "different native request",
    }),
    (error) => error?.code === "HERMES_SESSION_BUSY",
  );

  const retry = await coordinator.begin(scope, {
    mode: "delegate",
    tool: "delegate_to_hermes",
    traceId: "trace-retry",
    instruction: "same   native   request",
  });
  assert.equal(retry.replay, false);
  assert.notEqual(retry.operationId, first.operationId);
  assert.equal(retry.idempotencyKey, first.idempotencyKey);

  await coordinator.fail(scope, retry.operationId);
  const restored = await coordinator.inspect(scope);
  assert.equal(restored.active?.kind, "native-submission-unknown");
});

test("bridge restart can retry the exact persisted native pending submission", async () => {
  const { root, coordinator } = await makeCoordinator();
  const scope = coordinator.scopeFromMeta(metaA);

  const first = await coordinator.begin(scope, {
    mode: "delegate",
    tool: "delegate_to_hermes",
    traceId: "trace-before-crash",
    instruction: "recover after wrapper crash",
  });
  assert.ok(first.operationId);

  let counter = 0;
  const restarted = createHermesSessionCoordinator({
    root,
    randomUUID: () => "restart-" + ++counter,
  });
  const restartedScope = restarted.scopeFromMeta(metaA);

  const retry = await restarted.begin(restartedScope, {
    mode: "delegate",
    tool: "delegate_to_hermes",
    traceId: "trace-after-crash",
    instruction: "recover   after wrapper crash",
  });
  assert.equal(retry.replay, false);
  assert.ok(retry.operationId);
  assert.equal(retry.idempotencyKey, first.idempotencyKey);

  await assert.rejects(
    restarted.begin(restartedScope, {
      mode: "delegate",
      tool: "delegate_to_hermes",
      traceId: "trace-different",
      instruction: "different work",
    }),
    (error) => error?.code === "HERMES_SESSION_BUSY",
  );
});

test("replays a successfully reconciled native delegate instead of resubmitting", async () => {
  const { coordinator } = await makeCoordinator({ dedupWindowMs: 60_000 });
  const scope = coordinator.scopeFromMeta(metaA);

  const lease = await coordinator.begin(scope, {
    mode: "delegate",
    tool: "delegate_to_hermes",
    traceId: "trace-timeout",
    instruction: "do the privileged thing once",
  });

  await coordinator.complete(scope, lease.operationId, {
    payload: {
      ok: true,
      runId: "run-timeout",
      status: "started",
    },
    traceId: "trace-timeout",
    runId: "run-timeout",
    keepActive: true,
    activeKind: "run",
  });

  const retry = await coordinator.begin(scope, {
    mode: "delegate",
    tool: "delegate_to_hermes",
    traceId: "trace-retry",
    instruction: "do   the privileged thing once",
    reconcileActive: async () => ({
      terminal: true,
      sessionId: "session-timeout",
      replayPayload: {
        ok: true,
        operation: "delegate_to_hermes",
        runId: "run-timeout",
        sessionId: "session-timeout",
        status: "completed",
        text: "done once",
        nativeSession: true,
      },
    }),
  });

  assert.equal(retry.replay, true);
  assert.equal(retry.replayPayload.runId, "run-timeout");
  assert.equal(retry.replayPayload.sessionId, "session-timeout");
  assert.equal(retry.replayPayload.text, "done once");

  const snapshot = await coordinator.inspect(scope);
  assert.equal(snapshot.canonicalSessionId, "session-timeout");
  assert.equal(snapshot.active, null);
});

test("failed reconciled native delegate is released for a genuine retry", async () => {
  const { coordinator } = await makeCoordinator({ dedupWindowMs: 60_000 });
  const scope = coordinator.scopeFromMeta(metaA);

  const lease = await coordinator.begin(scope, {
    mode: "delegate",
    tool: "delegate_to_hermes",
    traceId: "trace-failed",
    instruction: "retryable native work",
  });

  await coordinator.complete(scope, lease.operationId, {
    payload: {
      ok: true,
      runId: "run-failed",
      status: "started",
    },
    traceId: "trace-failed",
    runId: "run-failed",
    keepActive: true,
    activeKind: "run",
  });

  const retry = await coordinator.begin(scope, {
    mode: "delegate",
    tool: "delegate_to_hermes",
    traceId: "trace-retry",
    instruction: "retryable   native work",
    reconcileActive: async () => ({
      terminal: true,
      sessionId: "session-failed",
      replayPayload: null,
    }),
  });

  assert.equal(retry.replay, false);
  assert.ok(retry.operationId);
  assert.equal(retry.sessionIdToUse, "session-failed");
});

test("failed terminal A2A result is not cached for dedup replay", async () => {
  const { coordinator } = await makeCoordinator({ dedupWindowMs: 60_000 });
  const scope = coordinator.scopeFromMeta(metaA);

  const first = await coordinator.begin(scope, {
    mode: "continue-context",
    tool: "continue_with_hermes",
    traceId: "trace-a2a-failed",
    instruction: "retry this continuation",
    requestedContextId: "ctx-a2a",
  });

  await coordinator.complete(scope, first.operationId, {
    payload: {
      ok: true,
      contextId: "ctx-a2a",
      taskId: "task-failed",
      stateName: "failed",
      text: "failed",
    },
    traceId: "trace-a2a-failed",
    contextId: "ctx-a2a",
    taskId: "task-failed",
  });

  const retry = await coordinator.begin(scope, {
    mode: "continue-context",
    tool: "continue_with_hermes",
    traceId: "trace-a2a-retry",
    instruction: "retry   this continuation",
    requestedContextId: "ctx-a2a",
  });

  assert.equal(retry.replay, false);
  assert.ok(retry.operationId);
});

test("rejects a different A2A context for the same ChatGPT conversation", async () => {
  const { coordinator } = await makeCoordinator();
  const scope = coordinator.scopeFromMeta(metaA);

  const first = await coordinator.begin(scope, {
    mode: "continue-context",
    tool: "continue_with_hermes",
    traceId: "trace-1",
    instruction: "continue",
    requestedContextId: "ctx-1",
  });
  await coordinator.complete(scope, first.operationId, {
    payload: { ok: true, contextId: "ctx-1" },
    traceId: "trace-1",
    contextId: "ctx-1",
  });

  await assert.rejects(
    coordinator.begin(scope, {
      mode: "continue-context",
      tool: "continue_with_hermes",
      traceId: "trace-2",
      instruction: "other",
      requestedContextId: "ctx-2",
    }),
    (error) => error?.code === "HERMES_CONTEXT_MISMATCH",
  );
});

test("delegate follows an already-bound native Hermes route", async () => {
  const { coordinator } = await makeCoordinator();
  const scope = coordinator.scopeFromMeta(metaA);

  const native = await coordinator.begin(scope, {
    mode: "continue-session",
    tool: "continue_hermes_session",
    traceId: "trace-native",
    instruction: "resume native",
    requestedSessionId: "native-1",
  });
  await coordinator.complete(scope, native.operationId, {
    payload: { ok: true, sessionId: "native-1" },
    traceId: "trace-native",
    sessionId: "native-1",
  });

  const delegated = await coordinator.begin(scope, {
    mode: "delegate",
    tool: "delegate_to_hermes",
    traceId: "trace-delegate",
    instruction: "ordinary follow up",
  });
  assert.equal(delegated.canonicalRoute, "native");
  assert.equal(delegated.sessionIdToUse, "native-1");
  assert.equal(delegated.contextIdToUse, null);
});

test("prevents mixing A2A and native Hermes routes in one ChatGPT conversation", async () => {
  const { coordinator } = await makeCoordinator();
  const scope = coordinator.scopeFromMeta(metaA);

  const first = await coordinator.begin(scope, {
    mode: "continue-context",
    tool: "continue_with_hermes",
    traceId: "trace-1",
    instruction: "start a2a",
    requestedContextId: "ctx-1",
  });
  await coordinator.complete(scope, first.operationId, {
    payload: { ok: true, contextId: "ctx-1" },
    traceId: "trace-1",
    contextId: "ctx-1",
  });

  await assert.rejects(
    coordinator.begin(scope, {
      mode: "start-run",
      tool: "start_hermes_run",
      traceId: "trace-2",
      instruction: "switch route",
    }),
    (error) => error?.code === "HERMES_ROUTE_CONFLICT",
  );
});

test("blocks a second native session when the durable session id is unresolved", async () => {
  const { coordinator } = await makeCoordinator();
  const scope = coordinator.scopeFromMeta(metaA);

  const first = await coordinator.begin(scope, {
    mode: "delegate",
    tool: "delegate_to_hermes",
    traceId: "trace-native-first",
    instruction: "first native run",
  });
  await coordinator.complete(scope, first.operationId, {
    payload: { ok: true, runId: "run-first", status: "completed" },
    traceId: "trace-native-first",
    runId: "run-first",
  });

  const snapshot = await coordinator.inspect(scope);
  assert.equal(snapshot.canonicalRoute, "native");
  assert.equal(snapshot.canonicalSessionId, null);
  assert.equal(snapshot.active, null);

  await assert.rejects(
    coordinator.begin(scope, {
      mode: "delegate",
      tool: "delegate_to_hermes",
      traceId: "trace-native-second",
      instruction: "must not create another native session",
    }),
    (error) => error?.code === "HERMES_NATIVE_SESSION_UNRESOLVED",
  );

  const recovered = await coordinator.begin(scope, {
    mode: "continue-session",
    tool: "continue_hermes_session",
    traceId: "trace-native-recover",
    instruction: "recover known session",
    requestedSessionId: "native-recovered",
  });
  assert.equal(recovered.canonicalRoute, "native");
  assert.equal(recovered.sessionIdToUse, "native-recovered");
});

test("does not cache a provisional native run checkpoint after failure", async () => {
  const { coordinator } = await makeCoordinator({ dedupWindowMs: 60_000 });
  const scope = coordinator.scopeFromMeta(metaA);

  const lease = await coordinator.begin(scope, {
    mode: "delegate",
    tool: "delegate_to_hermes",
    traceId: "trace-native",
    instruction: "native work",
  });

  await coordinator.complete(scope, lease.operationId, {
    payload: {
      ok: true,
      runId: "run-native",
      sessionId: "session-native",
      status: "started",
    },
    traceId: "trace-native",
    runId: "run-native",
    sessionId: "session-native",
    keepActive: true,
    activeKind: "run",
  });

  await coordinator.observe(scope, {
    kind: "run",
    id: "run-native",
    terminal: true,
    sessionId: "session-native",
  });

  const retry = await coordinator.begin(scope, {
    mode: "delegate",
    tool: "delegate_to_hermes",
    traceId: "trace-retry",
    instruction: "native   work",
  });

  assert.equal(retry.replay, false);
  assert.ok(retry.operationId);
});

test("caches the terminal native delegation result", async () => {
  const { coordinator } = await makeCoordinator({ dedupWindowMs: 60_000 });
  const scope = coordinator.scopeFromMeta(metaA);

  const lease = await coordinator.begin(scope, {
    mode: "delegate",
    tool: "delegate_to_hermes",
    traceId: "trace-native",
    instruction: "native work",
  });

  await coordinator.complete(scope, lease.operationId, {
    payload: {
      ok: true,
      runId: "run-native",
      sessionId: "session-native",
      status: "started",
    },
    traceId: "trace-native",
    runId: "run-native",
    sessionId: "session-native",
    keepActive: true,
    activeKind: "run",
  });

  await coordinator.complete(scope, lease.operationId, {
    payload: {
      ok: true,
      runId: "run-native",
      sessionId: "session-native",
      status: "completed",
      text: "done",
    },
    traceId: "trace-native",
    runId: "run-native",
    sessionId: "session-native",
  });

  const retry = await coordinator.begin(scope, {
    mode: "delegate",
    tool: "delegate_to_hermes",
    traceId: "trace-retry",
    instruction: "native   work",
  });

  assert.equal(retry.replay, true);
  assert.equal(retry.replayPayload.status, "completed");
  assert.equal(retry.replayPayload.text, "done");
});

test("tracks a controllable run until its terminal status is observed", async () => {
  const { coordinator } = await makeCoordinator();
  const scope = coordinator.scopeFromMeta(metaA);

  const lease = await coordinator.begin(scope, {
    mode: "start-run",
    tool: "start_hermes_run",
    traceId: "trace-run",
    instruction: "long task",
  });
  await coordinator.complete(scope, lease.operationId, {
    payload: { ok: true, runId: "run-1", sessionId: "session-1" },
    traceId: "trace-run",
    runId: "run-1",
    sessionId: "session-1",
    keepActive: true,
    activeKind: "run",
  });

  await assert.rejects(
    coordinator.begin(scope, {
      mode: "start-run",
      tool: "start_hermes_run",
      traceId: "trace-run-2",
      instruction: "another task",
    }),
    (error) => error?.code === "HERMES_SESSION_BUSY",
  );

  await coordinator.observe(scope, {
    kind: "run",
    id: "run-1",
    terminal: true,
    sessionId: "session-1",
  });

  const next = await coordinator.begin(scope, {
    mode: "start-run",
    tool: "start_hermes_run",
    traceId: "trace-run-3",
    instruction: "next task",
  });
  assert.equal(next.sessionIdToUse, "session-1");
});

test("keeps independent ChatGPT conversations independent", async () => {
  const { coordinator } = await makeCoordinator();
  const scopeA = coordinator.scopeFromMeta(metaA);
  const scopeB = coordinator.scopeFromMeta(metaB);

  await coordinator.begin(scopeA, {
    mode: "delegate",
    tool: "delegate_to_hermes",
    traceId: "trace-a",
    instruction: "A",
  });

  const leaseB = await coordinator.begin(scopeB, {
    mode: "delegate",
    tool: "delegate_to_hermes",
    traceId: "trace-b",
    instruction: "B",
  });
  assert.equal(leaseB.replay, false);
});

test("restores canonical routing after a bridge restart", async () => {
  const { root, coordinator } = await makeCoordinator();
  const scope = coordinator.scopeFromMeta(metaA);

  const first = await coordinator.begin(scope, {
    mode: "continue-session",
    tool: "continue_hermes_session",
    traceId: "trace-1",
    instruction: "resume",
    requestedSessionId: "native-1",
  });
  await coordinator.complete(scope, first.operationId, {
    payload: { ok: true, sessionId: "native-1" },
    traceId: "trace-1",
    sessionId: "native-1",
  });

  const restarted = createHermesSessionCoordinator({
    root,
    randomUUID: () => "restarted",
  });
  const restartedScope = restarted.scopeFromMeta(metaA);
  const snapshot = await restarted.inspect(restartedScope);
  assert.equal(snapshot.canonicalRoute, "native");
  assert.equal(snapshot.canonicalSessionId, "native-1");
});
