import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createHermesSessionCoordinator } from "./hermes-session-coordinator.mjs";

async function makeCoordinator(options = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "hermes-native-coord-"));
  let counter = 0;
  const coordinator = createHermesSessionCoordinator({
    root,
    randomUUID: () => "id-" + ++counter,
    ...options,
  });
  return { root, coordinator };
}

const metaA = { "openai/session": "chat-a" };
const metaB = { "openai/session": "chat-b" };

test("hashes raw ChatGPT session ids", async () => {
  const { coordinator } = await makeCoordinator();
  const scope = coordinator.scopeFromMeta(metaA);
  assert.equal(scope.tracked, true);
  assert.match(scope.sessionHash, /^[a-f0-9]{64}$/u);
  assert.notEqual(scope.sessionHash, metaA["openai/session"]);
});

test("untracked clients are not coordinated", async () => {
  const { coordinator } = await makeCoordinator();
  const scope = coordinator.scopeFromMeta({});
  const lease = await coordinator.begin(scope, {
    mode: "delegate",
    tool: "delegate_to_hermes",
    instruction: "x",
  });
  assert.equal(lease.tracked, false);
  assert.equal(lease.operationId, null);
});

test("first native operation starts without a durable session", async () => {
  const { coordinator } = await makeCoordinator();
  const scope = coordinator.scopeFromMeta(metaA);
  const lease = await coordinator.begin(scope, {
    mode: "delegate",
    tool: "delegate_to_hermes",
    instruction: "first",
  });
  assert.equal(lease.sessionIdToUse, null);
  assert.ok(lease.idempotencyKey);
});

test("successful completion binds and reuses the durable session", async () => {
  const { coordinator } = await makeCoordinator();
  const scope = coordinator.scopeFromMeta(metaA);
  const first = await coordinator.begin(scope, {
    mode: "delegate",
    tool: "delegate_to_hermes",
    instruction: "first",
  });
  await coordinator.complete(scope, first.operationId, {
    payload: { ok: true, operation: "delegate_to_hermes", sessionId: "s1" },
    sessionId: "s1",
  });

  const second = await coordinator.begin(scope, {
    mode: "delegate",
    tool: "delegate_to_hermes",
    instruction: "second",
  });
  assert.equal(second.sessionIdToUse, "s1");
});

test("rejects a different explicit durable session", async () => {
  const { coordinator } = await makeCoordinator();
  const scope = coordinator.scopeFromMeta(metaA);
  const first = await coordinator.begin(scope, {
    mode: "continue-session",
    tool: "continue_hermes_session",
    instruction: "bind",
    requestedSessionId: "s1",
  });
  await coordinator.complete(scope, first.operationId, {
    payload: { ok: true, sessionId: "s1" },
    sessionId: "s1",
  });

  await assert.rejects(
    coordinator.begin(scope, {
      mode: "continue-session",
      tool: "continue_hermes_session",
      instruction: "wrong",
      requestedSessionId: "s2",
    }),
    (error) => error?.code === "HERMES_NATIVE_SESSION_MISMATCH",
  );
});

test("blocks parallel mutating work", async () => {
  const { coordinator } = await makeCoordinator();
  const scope = coordinator.scopeFromMeta(metaA);
  await coordinator.begin(scope, {
    mode: "delegate",
    tool: "delegate_to_hermes",
    instruction: "first",
  });

  await assert.rejects(
    coordinator.begin(scope, {
      mode: "delegate",
      tool: "delegate_to_hermes",
      instruction: "different",
    }),
    (error) => error?.code === "HERMES_SESSION_BUSY",
  );
});

test("ambiguous submission permits only normalized exact recovery", async () => {
  const { coordinator } = await makeCoordinator();
  const scope = coordinator.scopeFromMeta(metaA);
  const first = await coordinator.begin(scope, {
    mode: "delegate",
    tool: "delegate_to_hermes",
    instruction: "do  x",
  });
  await coordinator.markSubmissionUnknown(scope, first.operationId);

  const retry = await coordinator.begin(scope, {
    mode: "delegate",
    tool: "delegate_to_hermes",
    instruction: "do x",
  });
  assert.equal(retry.idempotencyKey, first.idempotencyKey);

  await coordinator.markSubmissionUnknown(scope, retry.operationId);
  await assert.rejects(
    coordinator.begin(scope, {
      mode: "delegate",
      tool: "delegate_to_hermes",
      instruction: "different",
    }),
    (error) => error?.code === "HERMES_SESSION_BUSY",
  );
});

test("definitive submission failure releases the lease", async () => {
  const { coordinator } = await makeCoordinator();
  const scope = coordinator.scopeFromMeta(metaA);
  const first = await coordinator.begin(scope, {
    mode: "delegate",
    tool: "delegate_to_hermes",
    instruction: "first",
  });
  await coordinator.fail(scope, first.operationId);
  const second = await coordinator.begin(scope, {
    mode: "delegate",
    tool: "delegate_to_hermes",
    instruction: "second",
  });
  assert.ok(second.operationId);
});

test("known run remains locked until terminal observation", async () => {
  const { coordinator } = await makeCoordinator();
  const scope = coordinator.scopeFromMeta(metaA);
  const lease = await coordinator.begin(scope, {
    mode: "start-run",
    tool: "start_hermes_run",
    instruction: "long",
  });
  await coordinator.complete(scope, lease.operationId, {
    payload: { ok: true, runId: "r1", status: "started" },
    runId: "r1",
    keepActive: true,
    activeKind: "run",
  });

  await assert.rejects(
    coordinator.begin(scope, {
      mode: "delegate",
      tool: "delegate_to_hermes",
      instruction: "parallel",
    }),
    (error) => error?.code === "HERMES_SESSION_BUSY",
  );

  await coordinator.observe(scope, {
    kind: "run",
    id: "r1",
    terminal: true,
    replayPayload: null,
  });
  const next = await coordinator.begin(scope, {
    mode: "delegate",
    tool: "delegate_to_hermes",
    instruction: "after",
  });
  assert.ok(next.operationId);
});

test("session drift preserves a known run lock", async () => {
  const { coordinator } = await makeCoordinator();
  const scope = coordinator.scopeFromMeta(metaA);
  const lease = await coordinator.begin(scope, {
    mode: "start-run",
    tool: "start_hermes_run",
    instruction: "x",
    requestedSessionId: "s1",
  });

  await assert.rejects(
    coordinator.complete(scope, lease.operationId, {
      payload: { ok: true, runId: "r1", sessionId: "s2" },
      runId: "r1",
      sessionId: "s2",
      keepActive: true,
      activeKind: "run",
    }),
    (error) => error?.code === "HERMES_NATIVE_SESSION_DRIFT",
  );

  const snapshot = await coordinator.inspect(scope);
  assert.equal(snapshot.active?.runId, "r1");
});

test("terminal success is replayed for normalized exact retry", async () => {
  const { coordinator } = await makeCoordinator({ dedupWindowMs: 60_000 });
  const scope = coordinator.scopeFromMeta(metaA);
  const lease = await coordinator.begin(scope, {
    mode: "delegate",
    tool: "delegate_to_hermes",
    instruction: "same  thing",
  });
  await coordinator.complete(scope, lease.operationId, {
    payload: {
      ok: true,
      operation: "delegate_to_hermes",
      runId: "r1",
      sessionId: "s1",
      status: "completed",
      text: "done",
    },
    runId: "r1",
    sessionId: "s1",
  });

  const retry = await coordinator.begin(scope, {
    mode: "delegate",
    tool: "delegate_to_hermes",
    instruction: "same thing",
  });
  assert.equal(retry.replay, true);
  assert.equal(retry.replayPayload.runId, "r1");
  assert.equal(retry.replayPayload.text, "done");
});

test("terminal failure is never replayed and genuine retry is possible", async () => {
  const { coordinator } = await makeCoordinator();
  const scope = coordinator.scopeFromMeta(metaA);
  const lease = await coordinator.begin(scope, {
    mode: "start-run",
    tool: "start_hermes_run",
    instruction: "fail",
  });
  await coordinator.complete(scope, lease.operationId, {
    payload: { ok: false, status: "failed", error: "boom", runId: "r1" },
    runId: "r1",
  });
  const retry = await coordinator.begin(scope, {
    mode: "start-run",
    tool: "start_hermes_run",
    instruction: "fail",
  });
  assert.equal(retry.replay, false);
  assert.ok(retry.operationId);
});

test("successful polled run caches recovered delegate replay", async () => {
  const { coordinator } = await makeCoordinator();
  const scope = coordinator.scopeFromMeta(metaA);
  const lease = await coordinator.begin(scope, {
    mode: "delegate",
    tool: "delegate_to_hermes",
    instruction: "poll me",
  });
  await coordinator.complete(scope, lease.operationId, {
    payload: { ok: true, runId: "r1", status: "started" },
    runId: "r1",
    keepActive: true,
    activeKind: "run",
  });
  await coordinator.observe(scope, {
    kind: "run",
    id: "r1",
    terminal: true,
    sessionId: "s1",
    replayPayload: {
      ok: true,
      operation: "delegate_to_hermes",
      runId: "r1",
      sessionId: "s1",
      status: "completed",
      text: "done",
    },
  });
  const retry = await coordinator.begin(scope, {
    mode: "delegate",
    tool: "delegate_to_hermes",
    instruction: "poll  me",
  });
  assert.equal(retry.replay, true);
  assert.equal(retry.replayPayload.runId, "r1");
});

test("restart reconciles active run before accepting new work", async () => {
  const { root, coordinator } = await makeCoordinator();
  const scope = coordinator.scopeFromMeta(metaA);
  const lease = await coordinator.begin(scope, {
    mode: "start-run",
    tool: "start_hermes_run",
    instruction: "async",
  });
  await coordinator.complete(scope, lease.operationId, {
    payload: { ok: true, runId: "r1", status: "started" },
    runId: "r1",
    keepActive: true,
    activeKind: "run",
  });

  let n = 0;
  const restarted = createHermesSessionCoordinator({
    root,
    randomUUID: () => "restart-" + ++n,
  });
  const restartedScope = restarted.scopeFromMeta(metaA);
  const next = await restarted.begin(restartedScope, {
    mode: "delegate",
    tool: "delegate_to_hermes",
    instruction: "next",
    reconcileActive: async (active) => {
      assert.equal(active.runId, "r1");
      return { terminal: true, sessionId: "s1", replayPayload: null };
    },
  });
  assert.ok(next.operationId);
  assert.equal(next.sessionIdToUse, "s1");
});

test("multiple successful results remain independently replayable", async () => {
  const { coordinator } = await makeCoordinator({ dedupWindowMs: 60_000 });
  const scope = coordinator.scopeFromMeta(metaA);

  const first = await coordinator.begin(scope, {
    mode: "delegate",
    tool: "delegate_to_hermes",
    instruction: "operation A",
  });
  await coordinator.complete(scope, first.operationId, {
    payload: {
      ok: true,
      operation: "delegate_to_hermes",
      runId: "run-a",
      sessionId: "session-1",
      status: "completed",
      text: "A done",
    },
    runId: "run-a",
    sessionId: "session-1",
  });

  const second = await coordinator.begin(scope, {
    mode: "delegate",
    tool: "delegate_to_hermes",
    instruction: "operation B",
  });
  await coordinator.complete(scope, second.operationId, {
    payload: {
      ok: true,
      operation: "delegate_to_hermes",
      runId: "run-b",
      sessionId: "session-1",
      status: "completed",
      text: "B done",
    },
    runId: "run-b",
    sessionId: "session-1",
  });

  const replayA = await coordinator.begin(scope, {
    mode: "delegate",
    tool: "delegate_to_hermes",
    instruction: "operation   A",
  });
  assert.equal(replayA.replay, true);
  assert.equal(replayA.replayPayload.runId, "run-a");
  assert.equal(replayA.replayPayload.text, "A done");

  const replayB = await coordinator.begin(scope, {
    mode: "delegate",
    tool: "delegate_to_hermes",
    instruction: "operation B",
  });
  assert.equal(replayB.replay, true);
  assert.equal(replayB.replayPayload.runId, "run-b");
});

test("completed replay survives restart", async () => {
  const { root, coordinator } = await makeCoordinator({
    dedupWindowMs: 60_000,
  });
  const scope = coordinator.scopeFromMeta(metaA);
  const lease = await coordinator.begin(scope, {
    mode: "delegate",
    tool: "delegate_to_hermes",
    instruction: "persist",
  });
  await coordinator.complete(scope, lease.operationId, {
    payload: {
      ok: true,
      operation: "delegate_to_hermes",
      runId: "r1",
      sessionId: "s1",
      status: "completed",
    },
    runId: "r1",
    sessionId: "s1",
  });

  let n = 0;
  const restarted = createHermesSessionCoordinator({
    root,
    dedupWindowMs: 60_000,
    randomUUID: () => "restart-" + ++n,
  });
  const retry = await restarted.begin(restarted.scopeFromMeta(metaA), {
    mode: "delegate",
    tool: "delegate_to_hermes",
    instruction: "persist",
  });
  assert.equal(retry.replay, true);
  assert.equal(retry.replayPayload.runId, "r1");
});

test("expired replays are pruned globally on restart", async () => {
  const { root, coordinator } = await makeCoordinator({
    dedupWindowMs: 60_000,
  });
  for (const [meta, suffix] of [[metaA, "a"], [metaB, "b"]]) {
    const scope = coordinator.scopeFromMeta(meta);
    const lease = await coordinator.begin(scope, {
      mode: "delegate",
      tool: "delegate_to_hermes",
      instruction: "persist-" + suffix,
    });
    await coordinator.complete(scope, lease.operationId, {
      payload: {
        ok: true,
        operation: "delegate_to_hermes",
        runId: "r-" + suffix,
        sessionId: "s-" + suffix,
        status: "completed",
      },
      runId: "r-" + suffix,
      sessionId: "s-" + suffix,
    });
  }

  const statePath = path.join(
    root,
    ".runtime",
    "chatgpt-session-coordinator.json",
  );
  const state = JSON.parse(await fs.readFile(statePath, "utf8"));
  const scopeA = coordinator.scopeFromMeta(metaA);
  const bucketA = state.recentResults[scopeA.sessionHash];
  const fingerprintA = Object.keys(bucketA)[0];
  bucketA[fingerprintA].settledAtMs = 1;
  await fs.writeFile(statePath, JSON.stringify(state, null, 2) + "\n");

  let n = 0;
  const restarted = createHermesSessionCoordinator({
    root,
    dedupWindowMs: 60_000,
    randomUUID: () => "restart-" + ++n,
  });
  await restarted.inspect(restarted.scopeFromMeta(metaB));
  const pruned = JSON.parse(await fs.readFile(statePath, "utf8"));
  assert.equal(pruned.recentResults[scopeA.sessionHash], undefined);
});

test("per-session replay storage is bounded", async () => {
  const { root, coordinator } = await makeCoordinator({
    dedupWindowMs: 600_000,
  });
  const scope = coordinator.scopeFromMeta(metaA);

  for (let i = 0; i < 70; i += 1) {
    const lease = await coordinator.begin(scope, {
      mode: "delegate",
      tool: "delegate_to_hermes",
      instruction: "bounded-" + i,
    });
    await coordinator.complete(scope, lease.operationId, {
      payload: {
        ok: true,
        operation: "delegate_to_hermes",
        runId: "run-" + i,
        sessionId: "session-bounded",
        status: "completed",
      },
      runId: "run-" + i,
      sessionId: "session-bounded",
    });
  }

  const disk = JSON.parse(
    await fs.readFile(
      path.join(root, ".runtime", "chatgpt-session-coordinator.json"),
      "utf8",
    ),
  );
  assert.equal(
    Object.keys(disk.recentResults[scope.sessionHash]).length,
    64,
  );
});

test("v1 native state migrates and v1 A2A state is dropped", async () => {
  const { root, coordinator } = await makeCoordinator();
  const scopeA = coordinator.scopeFromMeta(metaA);
  const scopeB = coordinator.scopeFromMeta(metaB);
  const statePath = path.join(
    root,
    ".runtime",
    "chatgpt-session-coordinator.json",
  );
  await fs.mkdir(path.dirname(statePath), { recursive: true });
  await fs.writeFile(
    statePath,
    JSON.stringify({
      version: 1,
      sessions: {
        [scopeA.sessionHash]: {
          canonicalRoute: "native",
          canonicalSessionId: "s1",
          active: {
            operationId: "op1",
            tool: "start_hermes_run",
            kind: "run",
            route: "native",
            runId: "r1",
            sessionId: "s1",
          },
        },
        [scopeB.sessionHash]: {
          canonicalRoute: "a2a",
          canonicalContextId: "ctx1",
          active: {
            operationId: "op2",
            tool: "continue_with_hermes",
            kind: "a2a-task",
            route: "a2a",
            taskId: "t1",
          },
        },
      },
      recentResults: {},
    }, null, 2) + "\n",
  );

  let n = 0;
  const migrated = createHermesSessionCoordinator({
    root,
    randomUUID: () => "migrate-" + ++n,
  });
  const a = await migrated.inspect(migrated.scopeFromMeta(metaA));
  const b = await migrated.inspect(migrated.scopeFromMeta(metaB));
  assert.equal(a.canonicalSessionId, "s1");
  assert.equal(a.active?.runId, "r1");
  assert.equal(b.canonicalSessionId, null);
  assert.equal(b.active, null);

  const disk = JSON.parse(await fs.readFile(statePath, "utf8"));
  assert.equal(disk.version, 3);
});

test("independent ChatGPT conversations remain independent", async () => {
  const { coordinator } = await makeCoordinator();
  const a = await coordinator.begin(coordinator.scopeFromMeta(metaA), {
    mode: "delegate",
    tool: "delegate_to_hermes",
    instruction: "same",
  });
  const b = await coordinator.begin(coordinator.scopeFromMeta(metaB), {
    mode: "delegate",
    tool: "delegate_to_hermes",
    instruction: "same",
  });
  assert.notEqual(a.idempotencyKey, b.idempotencyKey);
});

test("assertActiveRun rejects unrelated run ids", async () => {
  const { coordinator } = await makeCoordinator();
  const scope = coordinator.scopeFromMeta(metaA);
  const lease = await coordinator.begin(scope, {
    mode: "start-run",
    tool: "start_hermes_run",
    instruction: "x",
  });
  await coordinator.complete(scope, lease.operationId, {
    payload: { ok: true, runId: "r1", status: "started" },
    runId: "r1",
    keepActive: true,
    activeKind: "run",
  });
  await assert.rejects(
    coordinator.assertActiveRun(scope, "r2"),
    (error) => error?.code === "HERMES_RUN_MISMATCH",
  );
});
