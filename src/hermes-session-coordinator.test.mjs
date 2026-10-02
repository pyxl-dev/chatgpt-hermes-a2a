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

async function completeSessionlessSuccess(coordinator, scope, instruction, runId) {
  const lease = await coordinator.begin(scope, {
    mode: "delegate",
    tool: "delegate_to_hermes",
    instruction,
  });
  await coordinator.complete(scope, lease.operationId, {
    payload: {
      ok: true,
      operation: "delegate_to_hermes",
      runId,
      status: "completed",
    },
    runId,
    sessionId: null,
  });
}

async function readCoordinatorState(root) {
  return JSON.parse(
    await fs.readFile(
      path.join(root, ".runtime", "chatgpt-session-coordinator.json"),
      "utf8",
    ),
  );
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

test("normalized exact retry reuses the active native run", async () => {
  const { coordinator } = await makeCoordinator();
  const scope = coordinator.scopeFromMeta(metaA);
  const lease = await coordinator.begin(scope, {
    mode: "delegate_to_hermes",
    tool: "delegate_to_hermes",
    instruction: "long   task",
  });
  await coordinator.complete(scope, lease.operationId, {
    payload: {
      ok: true,
      runId: "run-active",
      sessionId: "session-active",
      status: "running",
    },
    sessionId: "session-active",
    runId: "run-active",
    keepActive: true,
    activeKind: "run",
  });

  const retry = await coordinator.begin(scope, {
    mode: "delegate_to_hermes",
    tool: "delegate_to_hermes",
    instruction: "long task",
    reconcileActive: async (active) => {
      assert.equal(active.runId, "run-active");
      return {
        terminal: false,
        sessionId: "session-active",
        replayPayload: null,
      };
    },
  });

  assert.equal(retry.replay, false);
  assert.equal(retry.activeRun, true);
  assert.equal(retry.runId, "run-active");
  assert.equal(retry.operationId, lease.operationId);
  assert.equal(retry.idempotencyKey, lease.idempotencyKey);
  assert.equal(retry.sessionIdToUse, "session-active");

  await assert.rejects(
    coordinator.begin(scope, {
      mode: "delegate_to_hermes",
      tool: "delegate_to_hermes",
      instruction: "different work",
    }),
    (error) => error?.code === "HERMES_SESSION_BUSY",
  );
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

test("successful sessionless completion retains unresolved binding and blocks different work", async () => {
  const { coordinator } = await makeCoordinator({ dedupWindowMs: 60_000 });
  const scope = coordinator.scopeFromMeta(metaA);

  const lease = await coordinator.begin(scope, {
    mode: "delegate",
    tool: "delegate_to_hermes",
    instruction: "sessionless success",
  });
  await coordinator.complete(scope, lease.operationId, {
    payload: {
      ok: true,
      operation: "delegate_to_hermes",
      runId: "run-sessionless",
      status: "completed",
      text: "done",
    },
    runId: "run-sessionless",
    sessionId: null,
  });

  const snapshot = await coordinator.inspect(scope);
  assert.equal(snapshot.canonicalSessionId, null);
  assert.equal(snapshot.active?.kind, "native-session-unresolved");
  assert.equal(snapshot.active?.runId, "run-sessionless");

  const replay = await coordinator.begin(scope, {
    mode: "delegate",
    tool: "delegate_to_hermes",
    instruction: "sessionless   success",
  });
  assert.equal(replay.replay, true);
  assert.equal(replay.replayPayload.runId, "run-sessionless");

  await assert.rejects(
    coordinator.begin(scope, {
      mode: "delegate",
      tool: "delegate_to_hermes",
      instruction: "different work",
    }),
    (error) => error?.code === "HERMES_NATIVE_SESSION_UNRESOLVED",
  );
});

test("reconciliation can resolve a previously sessionless successful binding", async () => {
  const { coordinator } = await makeCoordinator({ dedupWindowMs: 60_000 });
  const scope = coordinator.scopeFromMeta(metaA);

  const lease = await coordinator.begin(scope, {
    mode: "start-run",
    tool: "start_hermes_run",
    instruction: "sessionless async success",
  });
  await coordinator.complete(scope, lease.operationId, {
    payload: {
      ok: true,
      operation: "start_hermes_run",
      runId: "run-resolve-later",
      status: "completed",
    },
    runId: "run-resolve-later",
    sessionId: null,
  });

  const next = await coordinator.begin(scope, {
    mode: "delegate",
    tool: "delegate_to_hermes",
    instruction: "different after binding resolves",
    reconcileActive: async (active) => {
      assert.equal(active.kind, "native-session-unresolved");
      assert.equal(active.runId, "run-resolve-later");
      return {
        terminal: true,
        sessionId: "session-resolved",
        replayPayload: {
          ok: true,
          operation: "start_hermes_run",
          runId: "run-resolve-later",
          sessionId: "session-resolved",
          status: "completed",
        },
      };
    },
  });

  assert.equal(next.sessionIdToUse, "session-resolved");
  assert.ok(next.operationId);
  const snapshot = await coordinator.inspect(scope);
  assert.equal(snapshot.canonicalSessionId, "session-resolved");
});

test("observing a resolved sessionless run preserves exact replay", async () => {
  const { coordinator } = await makeCoordinator({ dedupWindowMs: 60_000 });
  const scope = coordinator.scopeFromMeta(metaA);

  const lease = await coordinator.begin(scope, {
    mode: "delegate",
    tool: "delegate_to_hermes",
    instruction: "resolve via get run",
  });
  await coordinator.complete(scope, lease.operationId, {
    payload: {
      ok: true,
      operation: "delegate_to_hermes",
      runId: "run-get-resolve",
      status: "completed",
      text: "done",
    },
    runId: "run-get-resolve",
    sessionId: null,
  });

  const unresolved = await coordinator.inspect(scope);
  assert.equal(unresolved.active?.kind, "native-session-unresolved");

  await coordinator.observe(scope, {
    kind: "run",
    id: "run-get-resolve",
    terminal: true,
    sessionId: "session-get-resolved",
    replayPayload: {
      ok: true,
      operation: "delegate_to_hermes",
      runId: "run-get-resolve",
      sessionId: "session-get-resolved",
      status: "completed",
      text: "done",
      nativeSession: true,
    },
  });

  const resolved = await coordinator.inspect(scope);
  assert.equal(resolved.canonicalSessionId, "session-get-resolved");
  assert.equal(resolved.active, null);

  const replay = await coordinator.begin(scope, {
    mode: "delegate",
    tool: "delegate_to_hermes",
    instruction: "resolve   via get run",
  });
  assert.equal(replay.replay, true);
  assert.equal(replay.replayPayload.runId, "run-get-resolve");
  assert.equal(replay.replayPayload.sessionId, "session-get-resolved");
});

test("repeated reconciliation cannot extend or revive an expired replay", async () => {
  const { root, coordinator } = await makeCoordinator({ dedupWindowMs: 1_000 });
  const scope = coordinator.scopeFromMeta(metaA);
  const originalNow = Date.now;
  let now = 10_000;
  Date.now = () => now;
  try {
    await completeSessionlessSuccess(
      coordinator,
      scope,
      "reconcile immutable replay",
      "run-reconcile-immutable",
    );
    const initialState = await readCoordinatorState(root);
    const originalTimestamp =
      initialState.recentResults[scope.sessionHash][
        Object.keys(initialState.recentResults[scope.sessionHash])[0]
      ].settledAtMs;

    const reconcile = () =>
      coordinator.begin(scope, {
        mode: "delegate",
        tool: "delegate_to_hermes",
        instruction: "different reconciliation work",
        reconcileActive: async () => ({
          terminal: true,
          sessionId: null,
          replayPayload: {
            ok: true,
            operation: "delegate_to_hermes",
            runId: "run-reconcile-immutable",
            status: "completed",
          },
        }),
      });

    now = 10_500;
    await assert.rejects(
      reconcile(),
      (error) => error?.code === "HERMES_NATIVE_SESSION_UNRESOLVED",
    );
    const refreshedState = await readCoordinatorState(root);
    const refreshedBucket = refreshedState.recentResults[scope.sessionHash];
    assert.equal(
      refreshedBucket[Object.keys(refreshedBucket)[0]].settledAtMs,
      originalTimestamp,
    );

    now = 11_001;
    await assert.rejects(
      reconcile(),
      (error) => error?.code === "HERMES_NATIVE_SESSION_UNRESOLVED",
    );
    assert.equal(
      (await readCoordinatorState(root)).recentResults[scope.sessionHash],
      undefined,
    );

    now = 12_500;
    await assert.rejects(
      reconcile(),
      (error) => error?.code === "HERMES_NATIVE_SESSION_UNRESOLVED",
    );
    assert.equal(
      (await readCoordinatorState(root)).recentResults[scope.sessionHash],
      undefined,
    );
  } finally {
    Date.now = originalNow;
  }
});

test("repeated observation cannot extend or revive an expired replay", async () => {
  const { root, coordinator } = await makeCoordinator({ dedupWindowMs: 1_000 });
  const scope = coordinator.scopeFromMeta(metaA);
  const originalNow = Date.now;
  let now = 20_000;
  Date.now = () => now;
  try {
    await completeSessionlessSuccess(
      coordinator,
      scope,
      "observe immutable replay",
      "run-observe-immutable",
    );
    const initialState = await readCoordinatorState(root);
    const initialBucket = initialState.recentResults[scope.sessionHash];
    const fingerprint = Object.keys(initialBucket)[0];
    const originalTimestamp = initialBucket[fingerprint].settledAtMs;
    const observe = () =>
      coordinator.observe(scope, {
        kind: "run",
        id: "run-observe-immutable",
        terminal: true,
        replayPayload: {
          ok: true,
          operation: "delegate_to_hermes",
          runId: "run-observe-immutable",
          status: "completed",
        },
      });

    now = 20_500;
    await observe();
    const refreshedState = await readCoordinatorState(root);
    assert.equal(
      refreshedState.recentResults[scope.sessionHash][fingerprint].settledAtMs,
      originalTimestamp,
    );

    now = 21_001;
    await observe();
    assert.equal(
      (await readCoordinatorState(root)).recentResults[scope.sessionHash],
      undefined,
    );

    now = 22_500;
    await observe();
    assert.equal(
      (await readCoordinatorState(root)).recentResults[scope.sessionHash],
      undefined,
    );
  } finally {
    Date.now = originalNow;
  }
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

test("invalid deduplication windows fall back to the default expiry", async () => {
  for (const invalidWindow of [Number.NaN, Number.POSITIVE_INFINITY, 0, -1]) {
    const { root, coordinator } = await makeCoordinator({
      dedupWindowMs: 60_000,
    });
    const scope = coordinator.scopeFromMeta(metaA);
    const lease = await coordinator.begin(scope, {
      mode: "delegate",
      tool: "delegate_to_hermes",
      instruction: "expire-invalid-window",
    });
    await coordinator.complete(scope, lease.operationId, {
      payload: {
        ok: true,
        operation: "delegate_to_hermes",
        runId: "run-expire",
        sessionId: "session-expire",
        status: "completed",
      },
      runId: "run-expire",
      sessionId: "session-expire",
    });

    const statePath = path.join(
      root,
      ".runtime",
      "chatgpt-session-coordinator.json",
    );
    const state = JSON.parse(await fs.readFile(statePath, "utf8"));
    const bucket = state.recentResults[scope.sessionHash];
    const fingerprint = Object.keys(bucket)[0];
    bucket[fingerprint].settledAtMs = Date.now() - 120_000;
    await fs.writeFile(statePath, JSON.stringify(state, null, 2) + "\n");

    let n = 0;
    const restarted = createHermesSessionCoordinator({
      root,
      dedupWindowMs: invalidWindow,
      randomUUID: () => "invalid-window-" + ++n,
    });
    await restarted.inspect(restarted.scopeFromMeta(metaA));

    const pruned = JSON.parse(await fs.readFile(statePath, "utf8"));
    assert.equal(
      pruned.recentResults[scope.sessionHash],
      undefined,
      "invalid window " + String(invalidWindow) + " should use default expiry",
    );
  }
});

test("all live replay results remain available inside the dedup window", async () => {
  const { coordinator } = await makeCoordinator({
    dedupWindowMs: 600_000,
  });
  const scope = coordinator.scopeFromMeta(metaA);

  for (let i = 0; i < 70; i += 1) {
    const lease = await coordinator.begin(scope, {
      mode: "delegate",
      tool: "delegate_to_hermes",
      instruction: "live-replay-" + i,
    });
    await coordinator.complete(scope, lease.operationId, {
      payload: {
        ok: true,
        operation: "delegate_to_hermes",
        runId: "run-" + i,
        sessionId: "session-replay",
        status: "completed",
        text: "done-" + i,
      },
      runId: "run-" + i,
      sessionId: "session-replay",
    });
  }

  const firstReplay = await coordinator.begin(scope, {
    mode: "delegate",
    tool: "delegate_to_hermes",
    instruction: "live-replay-0",
  });
  assert.equal(firstReplay.replay, true);
  assert.equal(firstReplay.replayPayload.runId, "run-0");
  assert.equal(firstReplay.replayPayload.text, "done-0");

  const lastReplay = await coordinator.begin(scope, {
    mode: "delegate",
    tool: "delegate_to_hermes",
    instruction: "live-replay-69",
  });
  assert.equal(lastReplay.replay, true);
  assert.equal(lastReplay.replayPayload.runId, "run-69");
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
