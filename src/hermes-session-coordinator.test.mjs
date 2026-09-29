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
    payload: { ok: true, contextId: "ctx-1" },
    traceId: "trace-1",
    contextId: "ctx-1",
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

test("binds one canonical A2A context and reuses it for later delegate calls", async () => {
  const { coordinator } = await makeCoordinator();
  const scope = coordinator.scopeFromMeta(metaA);

  const first = await coordinator.begin(scope, {
    mode: "delegate",
    tool: "delegate_to_hermes",
    traceId: "trace-1",
    instruction: "first",
  });
  await coordinator.complete(scope, first.operationId, {
    payload: { ok: true, contextId: "ctx-canonical" },
    traceId: "trace-1",
    contextId: "ctx-canonical",
  });

  const second = await coordinator.begin(scope, {
    mode: "delegate",
    tool: "delegate_to_hermes",
    traceId: "trace-2",
    instruction: "follow up",
  });
  assert.equal(second.contextIdToUse, "ctx-canonical");
  assert.equal(second.canonicalRoute, "a2a");
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
    payload: { ok: true, contextId: "ctx-1", text: "done" },
    traceId: "trace-original",
    contextId: "ctx-1",
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

test("prevents mixing A2A and native Hermes routes in one ChatGPT conversation", async () => {
  const { coordinator } = await makeCoordinator();
  const scope = coordinator.scopeFromMeta(metaA);

  const first = await coordinator.begin(scope, {
    mode: "delegate",
    tool: "delegate_to_hermes",
    traceId: "trace-1",
    instruction: "start a2a",
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
