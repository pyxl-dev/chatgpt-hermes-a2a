import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  MAX_SLOTS,
  createHermesSessionCoordinator,
} from "./hermes-session-coordinator.mjs";

const metaA = { "openai/session": "slots-chat-a" };

async function makeCoordinator(root = null) {
  const dir =
    root || (await fs.mkdtemp(path.join(os.tmpdir(), "hermes-slots-")));
  let counter = 0;
  const coordinator = createHermesSessionCoordinator({
    root: dir,
    randomUUID: () => "slot-id-" + ++counter + "-" + Math.random(),
  });
  return { root: dir, coordinator };
}

function statePath(root) {
  return path.join(root, ".runtime", "chatgpt-session-coordinator.json");
}

async function readState(root) {
  return JSON.parse(await fs.readFile(statePath(root), "utf8"));
}

async function startRun(coordinator, scope, instruction, runId, sessionId) {
  const lease = await coordinator.begin(scope, {
    mode: "start_hermes_run",
    tool: "start_hermes_run",
    instruction,
  });
  await coordinator.complete(scope, lease.operationId, {
    payload: { ok: true, runId, sessionId, status: "running" },
    runId,
    sessionId,
    keepActive: true,
    activeKind: "run",
  });
  return lease;
}

async function finishRun(coordinator, scope, runId, sessionId, payload = null) {
  await coordinator.observe(scope, {
    kind: "run",
    id: runId,
    terminal: true,
    sessionId,
    replayPayload: payload,
    status: "completed",
  });
}

test("no slot means slot 1, exactly like the single-session coordinator", async () => {
  const { coordinator } = await makeCoordinator();
  const scope = coordinator.scopeFromMeta(metaA);
  assert.equal(scope.slot, 1);
  assert.equal(
    (await coordinator.scopeForSlot(scope, {})).slot,
    1,
  );

  await startRun(coordinator, scope, "work", "r1", "s1");
  const explicit = await coordinator.inspect(
    await coordinator.scopeForSlot(scope, { slot: 1 }),
  );
  assert.equal(explicit.canonicalSessionId, "s1");
  assert.equal(explicit.active?.runId, "r1");
});

test("invalid slots are rejected", async () => {
  const { coordinator } = await makeCoordinator();
  const scope = coordinator.scopeFromMeta(metaA);
  for (const slot of [0, MAX_SLOTS + 1, 1.5, "two"]) {
    await assert.rejects(
      coordinator.scopeForSlot(scope, { slot }),
      (error) => error?.code === "HERMES_SLOT_INVALID",
    );
  }
});

test("three slots run in parallel and warn about the shared workspace", async () => {
  const { coordinator } = await makeCoordinator();
  const base = coordinator.scopeFromMeta(metaA);
  const slot1 = await coordinator.scopeForSlot(base, { slot: 1 });
  const slot2 = await coordinator.scopeForSlot(base, { slot: 2 });
  const slot3 = await coordinator.scopeForSlot(base, { slot: 3 });

  const first = await startRun(coordinator, slot1, "task one", "r1", "s1");
  assert.deepEqual(first.parallelRuns, []);

  const second = await startRun(coordinator, slot2, "task two", "r2", "s2");
  assert.equal(second.slot, 2);
  assert.deepEqual(
    second.parallelRuns.map((run) => [run.slot, run.runId]),
    [[1, "r1"]],
  );

  const third = await startRun(coordinator, slot3, "task three", "r3", "s3");
  assert.deepEqual(
    third.parallelRuns.map((run) => run.slot),
    [1, 2],
  );

  const conversation = await coordinator.inspectConversation(base);
  assert.deepEqual(
    conversation.slots.map((slot) => [
      slot.slot,
      slot.canonicalSessionId,
      slot.active?.runId,
    ]),
    [
      [1, "s1", "r1"],
      [2, "s2", "r2"],
      [3, "s3", "r3"],
    ],
  );
  assert.equal(await coordinator.findSlotForRun(base, "r2"), 2);
  assert.equal(
    (await coordinator.scopeForSlot(base, { runId: "r3" })).slot,
    3,
  );
});

test("a busy slot refuses different work and names the free slots", async () => {
  const { coordinator } = await makeCoordinator();
  const base = coordinator.scopeFromMeta(metaA);
  const slot2 = { ...base, slot: 2 };
  await startRun(coordinator, slot2, "long work", "r2", "s2");

  await assert.rejects(
    coordinator.begin(slot2, {
      mode: "delegate_to_hermes",
      tool: "delegate_to_hermes",
      instruction: "something else",
    }),
    (error) =>
      error?.code === "HERMES_SESSION_BUSY" &&
      error.details?.slot === 2 &&
      error.details?.active?.runId === "r2" &&
      JSON.stringify(error.details?.freeSlots) === "[1,3]",
  );

  // The exact same instruction on the busy slot reuses its Run.
  const retry = await coordinator.begin(slot2, {
    mode: "start_hermes_run",
    tool: "start_hermes_run",
    instruction: "long   work",
  });
  assert.equal(retry.activeRun, true);
  assert.equal(retry.runId, "r2");

  // Slot 1 is untouched by slot 2's Run.
  const slot1 = await coordinator.begin(base, {
    mode: "delegate_to_hermes",
    tool: "delegate_to_hermes",
    instruction: "something else",
  });
  assert.ok(slot1.operationId);
  assert.equal(slot1.sessionIdToUse, null);
});

test("a session bound to one slot cannot be driven from another", async () => {
  const { coordinator } = await makeCoordinator();
  const base = coordinator.scopeFromMeta(metaA);
  await startRun(coordinator, base, "first", "r1", "s1");
  await finishRun(coordinator, base, "r1", "s1");

  await assert.rejects(
    coordinator.begin({ ...base, slot: 2 }, {
      mode: "continue_hermes_session",
      tool: "continue_hermes_session",
      instruction: "piggyback",
      requestedSessionId: "s1",
    }),
    (error) =>
      error?.code === "HERMES_SESSION_BOUND_TO_OTHER_SLOT" &&
      error.details?.boundSlot === 1,
  );
});

test("slot bindings and history persist across a bridge restart", async () => {
  const { root, coordinator } = await makeCoordinator();
  const base = coordinator.scopeFromMeta(metaA);
  const slot2 = { ...base, slot: 2 };
  await startRun(coordinator, slot2, "parallel", "r2", "s2");
  await finishRun(coordinator, slot2, "r2", "s2");
  await startRun(coordinator, base, "default", "r1", "s1");

  const { coordinator: restarted } = await makeCoordinator(root);
  const conversation = await restarted.inspectConversation(
    restarted.scopeFromMeta(metaA),
  );
  const bySlot = Object.fromEntries(
    conversation.slots.map((slot) => [slot.slot, slot]),
  );
  assert.equal(bySlot[1].canonicalSessionId, "s1");
  assert.equal(bySlot[1].active?.runId, "r1");
  assert.equal(bySlot[2].canonicalSessionId, "s2");
  assert.equal(bySlot[2].active, null, "a finished slot is idle but stays bound");
  assert.equal(bySlot[2].lastRun?.runId, "r2");
  assert.equal(bySlot[2].lastRun?.outcome, "completed");

  // The idle slot keeps its session for the next Run.
  const next = await restarted.begin({ ...restarted.scopeFromMeta(metaA), slot: 2 }, {
    mode: "delegate_to_hermes",
    tool: "delegate_to_hermes",
    instruction: "follow-up",
  });
  assert.equal(next.sessionIdToUse, "s2");
  assert.equal(next.reusedSession, true);
});

test("reads never create slots", async () => {
  const { root, coordinator } = await makeCoordinator();
  const base = coordinator.scopeFromMeta(metaA);
  await startRun(coordinator, base, "default", "r1", "s1");
  await coordinator.inspect({ ...base, slot: 3 });
  await coordinator.findSlotForRun(base, "nope");
  const disk = await readState(root);
  assert.deepEqual(
    Object.keys(disk.conversations[base.sessionHash].slots),
    ["1"],
  );
});

test("replay is scoped per slot", async () => {
  const { coordinator } = await makeCoordinator();
  const base = coordinator.scopeFromMeta(metaA);
  const slot2 = { ...base, slot: 2 };
  const payload = (runId) => ({
    ok: true,
    operation: "delegate_to_hermes",
    runId,
    status: "completed",
  });

  const lease1 = await coordinator.begin(base, {
    mode: "delegate_to_hermes",
    tool: "delegate_to_hermes",
    instruction: "same words",
  });
  await coordinator.complete(base, lease1.operationId, {
    payload: payload("r1"),
    runId: "r1",
    sessionId: "s1",
  });

  // The same instruction on slot 2 is new work there, not a replay of slot 1.
  const lease2 = await coordinator.begin(slot2, {
    mode: "delegate_to_hermes",
    tool: "delegate_to_hermes",
    instruction: "same words",
  });
  assert.equal(lease2.replay, false);
  assert.ok(lease2.operationId);
  await coordinator.complete(slot2, lease2.operationId, {
    payload: payload("r2"),
    runId: "r2",
    sessionId: "s2",
  });

  const replay1 = await coordinator.begin(base, {
    mode: "delegate_to_hermes",
    tool: "delegate_to_hermes",
    instruction: "same words",
  });
  const replay2 = await coordinator.begin(slot2, {
    mode: "delegate_to_hermes",
    tool: "delegate_to_hermes",
    instruction: "same words",
  });
  assert.equal(replay1.replay, true);
  assert.equal(replay1.replayPayload.runId, "r1");
  assert.equal(replay2.replay, true);
  assert.equal(replay2.replayPayload.runId, "r2");
});

test("an uncertain submission on slot 2 recovers only by exact retry on slot 2", async () => {
  const { coordinator } = await makeCoordinator();
  const base = coordinator.scopeFromMeta(metaA);
  const slot2 = { ...base, slot: 2 };
  const first = await coordinator.begin(slot2, {
    mode: "delegate_to_hermes",
    tool: "delegate_to_hermes",
    instruction: "maybe sent",
  });
  await coordinator.markSubmissionUnknown(slot2, first.operationId);

  // Slot 1 is free to do other work meanwhile.
  const other = await coordinator.begin(base, {
    mode: "delegate_to_hermes",
    tool: "delegate_to_hermes",
    instruction: "maybe sent",
  });
  assert.notEqual(other.idempotencyKey, first.idempotencyKey);

  await assert.rejects(
    coordinator.begin(slot2, {
      mode: "delegate_to_hermes",
      tool: "delegate_to_hermes",
      instruction: "different",
    }),
    (error) => error?.code === "HERMES_SESSION_BUSY",
  );
  const retry = await coordinator.begin(slot2, {
    mode: "delegate_to_hermes",
    tool: "delegate_to_hermes",
    instruction: "maybe  sent",
  });
  assert.equal(retry.idempotencyKey, first.idempotencyKey);
});

test("a sessionless success on slot 3 stays unresolved without blocking slot 1", async () => {
  const { coordinator } = await makeCoordinator();
  const base = coordinator.scopeFromMeta(metaA);
  const slot3 = { ...base, slot: 3 };
  const lease = await coordinator.begin(slot3, {
    mode: "delegate_to_hermes",
    tool: "delegate_to_hermes",
    instruction: "sessionless",
  });
  await coordinator.complete(slot3, lease.operationId, {
    payload: { ok: true, runId: "r3", status: "completed" },
    runId: "r3",
    sessionId: null,
  });

  await assert.rejects(
    coordinator.begin(slot3, {
      mode: "delegate_to_hermes",
      tool: "delegate_to_hermes",
      instruction: "other",
    }),
    (error) =>
      error?.code === "HERMES_NATIVE_SESSION_UNRESOLVED" &&
      error.details?.slot === 3,
  );
  const slot1 = await coordinator.begin(base, {
    mode: "delegate_to_hermes",
    tool: "delegate_to_hermes",
    instruction: "other",
  });
  assert.ok(slot1.operationId);
});

test("replacing a slot's session archives the old binding and restores it if submission fails", async () => {
  const { coordinator } = await makeCoordinator();
  const base = coordinator.scopeFromMeta(metaA);
  const slot2 = { ...base, slot: 2 };
  await startRun(coordinator, slot2, "first", "r2", "s2");

  await assert.rejects(
    coordinator.begin(slot2, {
      mode: "delegate_to_hermes",
      tool: "delegate_to_hermes",
      instruction: "fresh while busy",
      replaceSession: true,
    }),
    (error) => error?.code === "HERMES_SESSION_BUSY",
  );
  await finishRun(coordinator, slot2, "r2", "s2");

  const failed = await coordinator.begin(slot2, {
    mode: "delegate_to_hermes",
    tool: "delegate_to_hermes",
    instruction: "fresh",
    replaceSession: true,
  });
  assert.equal(failed.sessionIdToUse, null);
  assert.equal(failed.reusedSession, false);
  assert.equal(failed.replacedSessionId, "s2");
  await coordinator.fail(slot2, failed.operationId);
  let snapshot = await coordinator.inspect(slot2);
  assert.equal(snapshot.canonicalSessionId, "s2");
  assert.deepEqual(snapshot.archivedSessions, []);

  const lease = await coordinator.begin(slot2, {
    mode: "delegate_to_hermes",
    tool: "delegate_to_hermes",
    instruction: "fresh",
    replaceSession: true,
  });
  await coordinator.complete(slot2, lease.operationId, {
    payload: { ok: true, runId: "r2b", sessionId: "s2b", status: "completed" },
    runId: "r2b",
    sessionId: "s2b",
  });
  snapshot = await coordinator.inspect(slot2);
  assert.equal(snapshot.canonicalSessionId, "s2b");
  assert.deepEqual(
    snapshot.archivedSessions.map((entry) => [entry.sessionId, entry.reason, entry.lastRunId]),
    [["s2", "replaced", "r2"]],
  );

  // The archived session can be adopted again explicitly.
  const back = await coordinator.begin(slot2, {
    mode: "continue_hermes_session",
    tool: "continue_hermes_session",
    instruction: "go back",
    requestedSessionId: "s2",
    replaceSession: true,
  });
  assert.equal(back.sessionIdToUse, "s2");
  assert.equal(back.replacedSessionId, "s2b");
});

test("v3 state migrates to slot 1 without losing the binding, the Run or its replays", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "hermes-slots-v3-"));
  const { coordinator: probe } = await makeCoordinator(root);
  const scope = probe.scopeFromMeta(metaA);

  // Produce a genuine replay key with the pre-slot fingerprint scheme by
  // recording a completed result, then rewrite the file as a v3 document.
  const lease = await probe.begin(scope, {
    mode: "delegate_to_hermes",
    tool: "delegate_to_hermes",
    instruction: "finished before upgrade",
  });
  await probe.complete(scope, lease.operationId, {
    payload: {
      ok: true,
      operation: "delegate_to_hermes",
      runId: "old-run",
      sessionId: "legacy-session",
      status: "completed",
    },
    runId: "old-run",
    sessionId: "legacy-session",
  });
  const recorded = await readState(root);
  const recentResults = recorded.recentResults;
  assert.equal(Object.keys(recentResults[scope.sessionHash]).length, 1);

  await fs.writeFile(
    statePath(root),
    JSON.stringify(
      {
        version: 3,
        sessions: {
          [scope.sessionHash]: {
            canonicalSessionId: "legacy-session",
            active: {
              operationId: "legacy-op",
              tool: "start_hermes_run",
              kind: "run",
              traceId: "legacy-trace",
              startedAt: "2026-10-01T10:00:00.000Z",
              sessionId: "legacy-session",
              runId: "legacy-run",
              fingerprint: "legacy-fp",
              ownerInstanceId: "old-instance",
              idempotencyKey: "legacy-key",
              reusedSession: true,
            },
            updatedAt: "2026-10-01T10:00:00.000Z",
          },
        },
        recentResults,
      },
      null,
      2,
    ) + "\n",
  );

  const { coordinator } = await makeCoordinator(root);
  const migratedScope = coordinator.scopeFromMeta(metaA);
  const slot1 = await coordinator.inspect(migratedScope);
  assert.equal(slot1.slot, 1);
  assert.equal(slot1.canonicalSessionId, "legacy-session");
  assert.equal(slot1.active?.runId, "legacy-run");
  assert.equal(slot1.active?.operationId, "legacy-op");

  const disk = await readState(root);
  assert.equal(disk.version, 4);
  assert.equal(disk.sessions, undefined);
  assert.equal(
    disk.conversations[scope.sessionHash].slots["1"].active.idempotencyKey,
    "legacy-key",
  );
  assert.deepEqual(disk.recentResults, recentResults);

  // The pre-upgrade replay still answers an exact retry on the default slot.
  const replay = await coordinator.begin(migratedScope, {
    mode: "delegate_to_hermes",
    tool: "delegate_to_hermes",
    instruction: "finished before upgrade",
  });
  assert.equal(replay.replay, true);
  assert.equal(replay.replayPayload.runId, "old-run");

  // The migrated Run still locks slot 1 but not slot 2.
  await assert.rejects(
    coordinator.begin(migratedScope, {
      mode: "delegate_to_hermes",
      tool: "delegate_to_hermes",
      instruction: "new work",
    }),
    (error) => error?.code === "HERMES_SESSION_BUSY",
  );
  const parallel = await coordinator.begin({ ...migratedScope, slot: 2 }, {
    mode: "delegate_to_hermes",
    tool: "delegate_to_hermes",
    instruction: "new work",
  });
  assert.deepEqual(
    parallel.parallelRuns.map((run) => [run.slot, run.runId]),
    [[1, "legacy-run"]],
  );
});

test("slot history keeps only the most recent Runs", async () => {
  const { root, coordinator } = await makeCoordinator();
  const base = coordinator.scopeFromMeta(metaA);
  for (let index = 0; index < 12; index += 1) {
    await startRun(coordinator, base, "step " + index, "r" + index, "s1");
    await finishRun(coordinator, base, "r" + index, "s1");
  }
  const conversation = await coordinator.inspectConversation(base);
  assert.equal(conversation.slots[0].lastRun.runId, "r11");
  const history =
    (await readState(root)).conversations[base.sessionHash].slots["1"].history;
  assert.deepEqual(
    history.map((entry) => entry.runId),
    ["r2", "r3", "r4", "r5", "r6", "r7", "r8", "r9", "r10", "r11"],
  );
});

const metaB = { "openai/session": "slots-chat-b" };

function continueSession(coordinator, scope, sessionId, extra = {}) {
  return coordinator.begin(scope, {
    mode: "continue_hermes_session",
    tool: "continue_hermes_session",
    instruction: "pick up " + sessionId,
    requestedSessionId: sessionId,
    ...extra,
  });
}

test("a session bound to one conversation is refused in another", async () => {
  const { coordinator } = await makeCoordinator();
  const a = coordinator.scopeFromMeta(metaA);
  const b = coordinator.scopeFromMeta(metaB);
  await startRun(coordinator, a, "work in A", "rA", "shared");

  // While A runs in it, nobody else may touch it, even with replaceSession.
  await assert.rejects(
    continueSession(coordinator, b, "shared", { replaceSession: true }),
    (error) =>
      error?.code === "HERMES_SESSION_BOUND_TO_OTHER_CONVERSATION" &&
      error.details?.busy === true,
  );

  await finishRun(coordinator, a, "rA", "shared");
  await assert.rejects(
    continueSession(coordinator, b, "shared"),
    (error) =>
      error?.code === "HERMES_SESSION_BOUND_TO_OTHER_CONVERSATION" &&
      error.details?.busy === false &&
      /replaceSession/.test(error.message),
  );
  // A keeps its binding.
  assert.equal((await coordinator.inspect(a)).canonicalSessionId, "shared");
});

test("replaceSession moves an idle session from another conversation, and a rejected submission moves it back", async () => {
  const { coordinator } = await makeCoordinator();
  const a = coordinator.scopeFromMeta(metaA);
  const b = coordinator.scopeFromMeta(metaB);
  await startRun(coordinator, a, "work in A", "rA", "shared");
  await finishRun(coordinator, a, "rA", "shared");

  const rejected = await continueSession(coordinator, b, "shared", {
    replaceSession: true,
  });
  assert.equal((await coordinator.inspect(a)).canonicalSessionId, null);
  await coordinator.fail(b, rejected.operationId);
  let snapshotA = await coordinator.inspect(a);
  assert.equal(snapshotA.canonicalSessionId, "shared");
  assert.deepEqual(snapshotA.archivedSessions, []);

  const moved = await continueSession(coordinator, b, "shared", {
    replaceSession: true,
  });
  assert.equal(moved.sessionIdToUse, "shared");
  await coordinator.complete(b, moved.operationId, {
    payload: { ok: true, runId: "rB", sessionId: "shared", status: "completed" },
    runId: "rB",
    sessionId: "shared",
  });
  assert.equal((await coordinator.inspect(b)).canonicalSessionId, "shared");

  snapshotA = await coordinator.inspect(a);
  assert.equal(snapshotA.canonicalSessionId, null);
  assert.deepEqual(
    snapshotA.archivedSessions.map((entry) => [entry.sessionId, entry.reason, entry.lastRunId]),
    [["shared", "moved-to-other-conversation", "rA"]],
  );

  // A's next work starts a fresh session instead of reusing B's.
  const nextA = await coordinator.begin(a, {
    mode: "delegate_to_hermes",
    tool: "delegate_to_hermes",
    instruction: "more work in A",
  });
  assert.equal(nextA.sessionIdToUse, null);
  assert.equal(nextA.reusedSession, false);
});

test("replaceSession moves an idle session between slots of one conversation", async () => {
  const { coordinator } = await makeCoordinator();
  const a = coordinator.scopeFromMeta(metaA);
  await startRun(coordinator, a, "slot one", "r1", "s1");
  await finishRun(coordinator, a, "r1", "s1");

  const moved = await continueSession(coordinator, { ...a, slot: 2 }, "s1", {
    replaceSession: true,
  });
  assert.equal(moved.sessionIdToUse, "s1");
  const slot1 = await coordinator.inspect(a);
  assert.equal(slot1.canonicalSessionId, null);
  assert.equal(slot1.archivedSessions[0]?.reason, "moved-to-slot-2");
});

test("conversations that already shared an idle session before the upgrade keep working, one Run at a time", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "hermes-slots-shared-"));
  const { coordinator: probe } = await makeCoordinator(root);
  const a = probe.scopeFromMeta(metaA);
  const b = probe.scopeFromMeta(metaB);
  await fs.mkdir(path.dirname(statePath(root)), { recursive: true });
  await fs.writeFile(
    statePath(root),
    JSON.stringify({
      version: 3,
      sessions: {
        [a.sessionHash]: { canonicalSessionId: "legacy", active: null },
        [b.sessionHash]: { canonicalSessionId: "legacy", active: null },
      },
      recentResults: {},
    }) + "\n",
  );

  const { coordinator } = await makeCoordinator(root);
  await startRun(coordinator, a, "A first", "rA", "legacy");
  await assert.rejects(
    coordinator.begin(b, {
      mode: "delegate_to_hermes",
      tool: "delegate_to_hermes",
      instruction: "B meanwhile",
    }),
    (error) =>
      error?.code === "HERMES_SESSION_BOUND_TO_OTHER_CONVERSATION" &&
      error.details?.busy === true,
  );
  await finishRun(coordinator, a, "rA", "legacy");
  const lease = await coordinator.begin(b, {
    mode: "delegate_to_hermes",
    tool: "delegate_to_hermes",
    instruction: "B afterwards",
  });
  assert.equal(lease.sessionIdToUse, "legacy");
});
