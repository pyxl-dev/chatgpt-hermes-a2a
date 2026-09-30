import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

const DEFAULT_STALE_PENDING_MS = 10 * 60 * 1000;
const DEFAULT_DEDUP_WINDOW_MS = 60 * 1000;

function positiveNumber(value, fallback, minimum = 1) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= minimum ? parsed : fallback;
}

function normalizeInstruction(value) {
  return String(value || "").normalize("NFKC").trim().replace(/\s+/gu, " ");
}

function sha256(value) {
  return createHash("sha256").update(String(value), "utf8").digest("hex");
}

const UNSUCCESSFUL_OUTCOMES = new Set([
  "failed",
  "rejected",
  "cancelled",
  "canceled",
  "interrupted",
]);

function payloadIsReusable(payload) {
  if (!payload || payload.ok === false || payload.error) return false;
  const status = String(payload.status || "").toLowerCase();
  const stateName = String(payload.stateName || "").toLowerCase();
  return (
    !UNSUCCESSFUL_OUTCOMES.has(status) &&
    !UNSUCCESSFUL_OUTCOMES.has(stateName)
  );
}

function coordinatorError(code, message, details = null) {
  const error = new Error(message);
  error.code = code;
  if (details) error.details = details;
  return error;
}

function activeSummary(active) {
  if (!active || typeof active !== "object") return null;
  return {
    operationId: active.operationId || null,
    tool: active.tool || null,
    kind: active.kind || null,
    traceId: active.traceId || null,
    startedAt: active.startedAt || null,
    contextId: active.contextId || null,
    sessionId: active.sessionId || null,
    taskId: active.taskId || null,
    runId: active.runId || null,
    stateName: active.stateName || null,
  };
}

function isStalePending(active, stalePendingMs, now = Date.now()) {
  if (
    !active ||
    active.taskId ||
    active.runId ||
    active.route === "native" ||
    active.kind === "a2a-pending" ||
    active.kind === "a2a-submission-unknown"
  ) return false;
  const startedAtMs = Date.parse(active.startedAt || "");
  return (
    Number.isFinite(startedAtMs) &&
    now - startedAtMs > stalePendingMs
  );
}

export function createHermesSessionCoordinator({
  root,
  randomUUID,
  statePath = null,
  stalePendingMs = positiveNumber(
    process.env.HERMES_SESSION_STALE_PENDING_MS,
    DEFAULT_STALE_PENDING_MS,
    1000,
  ),
  dedupWindowMs = positiveNumber(
    process.env.HERMES_DEDUP_WINDOW_MS,
    DEFAULT_DEDUP_WINDOW_MS,
    1000,
  ),
}) {
  const runtimeDir = path.join(root, ".runtime");
  const filePath =
    statePath ||
    process.env.HERMES_SESSION_COORDINATOR_STATE ||
    path.join(runtimeDir, "chatgpt-session-coordinator.json");

  const state = { version: 1, sessions: {}, recentResults: {} };
  const instanceId = randomUUID();
  const locks = new Map();
  let loaded = false;
  let loadPromise = null;
  let writeChain = Promise.resolve();

  function scopeFromMeta(meta) {
    const raw =
      meta && typeof meta === "object"
        ? meta["openai/session"]
        : null;
    if (typeof raw !== "string" || !raw.trim()) {
      return { tracked: false, sessionHash: null };
    }
    return {
      tracked: true,
      sessionHash: sha256(raw.trim()),
    };
  }

  async function ensureLoaded() {
    if (loaded) return;
    if (loadPromise) return loadPromise;
    loadPromise = (async () => {
      try {
        const raw = await fs.readFile(filePath, "utf8");
        const parsed = JSON.parse(raw);
        if (
          parsed &&
          parsed.version === 1 &&
          parsed.sessions &&
          typeof parsed.sessions === "object" &&
          !Array.isArray(parsed.sessions)
        ) {
          state.sessions = parsed.sessions;
          if (
            parsed.recentResults &&
            typeof parsed.recentResults === "object" &&
            !Array.isArray(parsed.recentResults)
          ) {
            state.recentResults = parsed.recentResults;
          }
        }
      } catch (error) {
        if (error?.code !== "ENOENT") throw error;
      }
      loaded = true;
    })();
    try {
      await loadPromise;
    } finally {
      loadPromise = null;
    }
  }

  async function persist() {
    writeChain = writeChain
      .catch(() => {})
      .then(async () => {
        await fs.mkdir(path.dirname(filePath), {
          recursive: true,
          mode: 0o700,
        });
        const tempPath = filePath + "." + randomUUID() + ".tmp";
        const body = JSON.stringify(state, null, 2) + "\n";
        await fs.writeFile(tempPath, body, {
          encoding: "utf8",
          mode: 0o600,
        });
        await fs.rename(tempPath, filePath);
        await fs.chmod(filePath, 0o600).catch(() => {});
      });
    await writeChain;
  }

  async function withLock(sessionHash, fn) {
    const previous = locks.get(sessionHash) || Promise.resolve();
    let release;
    const current = new Promise((resolve) => {
      release = resolve;
    });
    const queued = previous.catch(() => {}).then(() => current);
    locks.set(sessionHash, queued);
    await previous.catch(() => {});
    try {
      return await fn();
    } finally {
      release();
      if (locks.get(sessionHash) === queued) {
        locks.delete(sessionHash);
      }
    }
  }

  function getRecord(sessionHash) {
    let record = state.sessions[sessionHash];
    if (!record || typeof record !== "object" || Array.isArray(record)) {
      record = {
        canonicalRoute: null,
        canonicalContextId: null,
        canonicalSessionId: null,
        active: null,
        updatedAt: null,
      };
      state.sessions[sessionHash] = record;
    }
    return record;
  }

  function getRecentResult(sessionHash) {
    const recent = state.recentResults?.[sessionHash];
    return recent && typeof recent === "object" && !Array.isArray(recent)
      ? recent
      : null;
  }

  function setRecentResult(sessionHash, value) {
    if (!state.recentResults || typeof state.recentResults !== "object") {
      state.recentResults = {};
    }
    state.recentResults[sessionHash] = value;
  }

  function deleteRecentResult(sessionHash) {
    if (state.recentResults && typeof state.recentResults === "object") {
      delete state.recentResults[sessionHash];
    }
  }

  function snapshot(scope, record) {
    return {
      tracked: scope?.tracked === true,
      sessionHash: scope?.sessionHash || null,
      canonicalRoute: record?.canonicalRoute || null,
      canonicalContextId: record?.canonicalContextId || null,
      canonicalSessionId: record?.canonicalSessionId || null,
      active: activeSummary(record?.active),
    };
  }

  async function begin(
    scope,
    {
      mode,
      tool,
      traceId,
      instruction,
      requestedContextId = null,
      requestedSessionId = null,
      requestedTaskId = null,
      reconcileActive = null,
    },
  ) {
    if (!scope?.tracked || !scope.sessionHash) {
      return {
        tracked: false,
        replay: false,
        operationId: null,
        canonicalRoute: null,
        canonicalContextId: requestedContextId || null,
        canonicalSessionId: requestedSessionId || null,
        contextIdToUse: requestedContextId || null,
        sessionIdToUse: requestedSessionId || null,
        idempotencyKey: null,
      };
    }

    await ensureLoaded();
    return withLock(scope.sessionHash, async () => {
      const record = getRecord(scope.sessionHash);
      let changed = false;

      if (isStalePending(record.active, stalePendingMs)) {
        record.active = record.active.restoreOnFailure || null;
        changed = true;
      }

      if (record.active && typeof reconcileActive === "function") {
        let reconciled = null;
        try {
          reconciled = await reconcileActive(activeSummary(record.active));
        } catch {
          // A status failure must never make us assume an active Hermes job ended.
        }

        if (reconciled) {
          const expectedContextId =
            record.canonicalContextId || record.active.contextId || null;
          if (
            reconciled.contextId &&
            expectedContextId &&
            reconciled.contextId !== expectedContextId
          ) {
            throw coordinatorError(
              "HERMES_CONTEXT_DRIFT",
              "Hermes reported a different contextId while reconciling the active operation.",
              {
                sessionHash: scope.sessionHash,
                expectedContextId,
                returnedContextId: reconciled.contextId,
                active: activeSummary(record.active),
              },
            );
          }

          const expectedSessionId =
            record.canonicalSessionId || record.active.sessionId || null;
          if (
            reconciled.sessionId &&
            expectedSessionId &&
            reconciled.sessionId !== expectedSessionId
          ) {
            throw coordinatorError(
              "HERMES_NATIVE_SESSION_DRIFT",
              "Hermes reported a different sessionId while reconciling the active operation.",
              {
                sessionHash: scope.sessionHash,
                expectedSessionId,
                returnedSessionId: reconciled.sessionId,
                active: activeSummary(record.active),
              },
            );
          }

          if (reconciled.contextId && !record.canonicalContextId) {
            record.canonicalContextId = reconciled.contextId;
            changed = true;
          }
          if (reconciled.sessionId && !record.canonicalSessionId) {
            record.canonicalSessionId = reconciled.sessionId;
            changed = true;
          }
          if (reconciled.terminal === true) {
            const activeFingerprint = record.active.fingerprint || null;
            if (
              activeFingerprint &&
              reconciled.replayPayload &&
              payloadIsReusable(reconciled.replayPayload)
            ) {
              setRecentResult(scope.sessionHash, {
                fingerprint: activeFingerprint,
                settledAtMs: Date.now(),
                traceId: record.active.traceId || null,
                payload: reconciled.replayPayload,
              });
            } else if (activeFingerprint) {
              const recent = getRecentResult(scope.sessionHash);
              if (recent?.fingerprint === activeFingerprint) {
                deleteRecentResult(scope.sessionHash);
              }
            }
            record.active = null;
            changed = true;
          }
        }
      }

      const fingerprint =
        typeof instruction === "string" && instruction.trim()
          ? sha256(
              [
                mode,
                requestedContextId || "",
                requestedSessionId || "",
                requestedTaskId || "",
                normalizeInstruction(instruction),
              ].join("\n"),
            )
          : null;

      const resumableTask =
        record.active?.kind === "a2a-task" &&
        requestedTaskId &&
        record.active.taskId === requestedTaskId &&
        ["input-required", "auth-required"].includes(record.active.stateName);

      const recoverablePending =
        record.active &&
        [
          "native-pending",
          "native-submission-unknown",
          "a2a-pending",
          "a2a-submission-unknown",
        ].includes(record.active.kind) &&
        fingerprint &&
        record.active.fingerprint === fingerprint &&
        (
          record.active.kind.endsWith("-submission-unknown") ||
          record.active.ownerInstanceId !== instanceId
        );

      if (record.active && !resumableTask && !recoverablePending) {
        if (changed) {
          record.updatedAt = new Date().toISOString();
          await persist();
        }
        throw coordinatorError(
          "HERMES_SESSION_BUSY",
          "Another Hermes operation is already active for this ChatGPT conversation. Reuse or inspect that operation instead of starting parallel work.",
          {
            sessionHash: scope.sessionHash,
            active: activeSummary(record.active),
          },
        );
      }

      const targetRoute =
        mode === "delegate"
          ? record.canonicalRoute || "native"
          : mode === "continue-context"
            ? "a2a"
            : "native";

      if (
        record.canonicalRoute === "native" &&
        !record.canonicalSessionId &&
        !requestedSessionId &&
        (mode === "delegate" || mode === "start-run")
      ) {
        throw coordinatorError(
          "HERMES_NATIVE_SESSION_UNRESOLVED",
          "This ChatGPT conversation is already bound to the native Hermes route, but its durable sessionId has not been resolved yet. Inspect the previous run until Hermes returns a sessionId, or resume an explicitly known durable session.",
          {
            sessionHash: scope.sessionHash,
            canonicalRoute: record.canonicalRoute,
            active: activeSummary(record.active),
          },
        );
      }
      if (record.canonicalRoute && record.canonicalRoute !== targetRoute) {
        throw coordinatorError(
          "HERMES_ROUTE_CONFLICT",
          "This ChatGPT conversation is already bound to the " +
            record.canonicalRoute +
            " Hermes route. Starting work through " +
            targetRoute +
            " would create a second Hermes conversation.",
          {
            sessionHash: scope.sessionHash,
            canonicalRoute: record.canonicalRoute,
            requestedRoute: targetRoute,
            canonicalContextId: record.canonicalContextId || null,
            canonicalSessionId: record.canonicalSessionId || null,
          },
        );
      }

      if (
        requestedContextId &&
        record.canonicalContextId &&
        requestedContextId !== record.canonicalContextId
      ) {
        throw coordinatorError(
          "HERMES_CONTEXT_MISMATCH",
          "The requested A2A contextId does not match the canonical Hermes context for this ChatGPT conversation.",
          {
            sessionHash: scope.sessionHash,
            canonicalContextId: record.canonicalContextId,
            requestedContextId,
          },
        );
      }

      if (
        requestedSessionId &&
        record.canonicalSessionId &&
        requestedSessionId !== record.canonicalSessionId
      ) {
        throw coordinatorError(
          "HERMES_NATIVE_SESSION_MISMATCH",
          "The requested Hermes sessionId does not match the canonical durable session for this ChatGPT conversation.",
          {
            sessionHash: scope.sessionHash,
            canonicalSessionId: record.canonicalSessionId,
            requestedSessionId,
          },
        );
      }

      const recent = getRecentResult(scope.sessionHash);
      const now = Date.now();
      if (
        fingerprint &&
        recent &&
        recent.fingerprint === fingerprint &&
        now - recent.settledAtMs <= dedupWindowMs
      ) {
        return {
          tracked: true,
          replay: true,
          operationId: null,
          canonicalRoute: record.canonicalRoute || targetRoute,
          canonicalContextId: record.canonicalContextId || null,
          canonicalSessionId: record.canonicalSessionId || null,
          contextIdToUse:
            requestedContextId || record.canonicalContextId || null,
          sessionIdToUse:
            requestedSessionId || record.canonicalSessionId || null,
          replayPayload: {
            ...recent.payload,
            deduplicated: true,
            duplicateOfTraceId: recent.traceId || null,
            dedupWindowMs,
          },
        };
      }

      const restoreOnFailure = resumableTask
        ? { ...record.active, restoreOnFailure: null }
        : recoverablePending && record.active?.restoreOnFailure
          ? {
              ...record.active.restoreOnFailure,
              restoreOnFailure: null,
            }
          : null;

      const operationId = randomUUID();
      const idempotencyKey =
        recoverablePending && record.active?.idempotencyKey
          ? record.active.idempotencyKey
          : sha256(scope.sessionHash + "\n" + operationId);
      record.active = {
        operationId,
        tool,
        kind: targetRoute === "a2a" ? "a2a-pending" : "native-pending",
        route: targetRoute,
        traceId: traceId || null,
        startedAt: new Date().toISOString(),
        contextId:
          requestedContextId || record.canonicalContextId || null,
        sessionId:
          requestedSessionId || record.canonicalSessionId || null,
        taskId: requestedTaskId || null,
        runId: null,
        stateName: null,
        fingerprint,
        restoreOnFailure,
        ownerInstanceId: instanceId,
        idempotencyKey,
      };
      record.updatedAt = new Date().toISOString();
      await persist();

      return {
        tracked: true,
        replay: false,
        operationId,
        canonicalRoute: record.canonicalRoute || targetRoute,
        canonicalContextId: record.canonicalContextId || null,
        canonicalSessionId: record.canonicalSessionId || null,
        contextIdToUse:
          requestedContextId || record.canonicalContextId || null,
        sessionIdToUse:
          requestedSessionId || record.canonicalSessionId || null,
        idempotencyKey,
      };
    });
  }

  async function complete(
    scope,
    operationId,
    {
      payload,
      traceId = null,
      contextId = null,
      sessionId = null,
      taskId = null,
      runId = null,
      keepActive = false,
      activeKind = null,
      activeStateName = null,
    } = {},
  ) {
    if (!scope?.tracked || !scope.sessionHash || !operationId) return;

    await ensureLoaded();
    return withLock(scope.sessionHash, async () => {
      const record = getRecord(scope.sessionHash);
      const active = record.active;
      if (!active || active.operationId !== operationId) {
        return snapshot(scope, record);
      }

      const driftRecoveryActive = () => {
        if (active.restoreOnFailure) {
          return active.restoreOnFailure;
        }
        if (runId) {
          return {
            ...active,
            kind: activeKind || "run",
            runId,
            taskId: taskId || active.taskId || null,
            stateName: activeStateName || active.stateName || null,
            restoreOnFailure: null,
          };
        }
        if (keepActive && taskId) {
          return {
            ...active,
            kind: activeKind || "a2a-task",
            taskId,
            stateName: activeStateName || active.stateName || null,
            restoreOnFailure: null,
          };
        }
        return null;
      };

      if (
        active.route &&
        record.canonicalRoute &&
        active.route !== record.canonicalRoute
      ) {
        record.active = driftRecoveryActive();
        record.updatedAt = new Date().toISOString();
        await persist();
        throw coordinatorError(
          "HERMES_ROUTE_DRIFT",
          "Hermes operation completed through a different route than the canonical route for this ChatGPT conversation.",
          {
            sessionHash: scope.sessionHash,
            canonicalRoute: record.canonicalRoute,
            returnedRoute: active.route,
          },
        );
      }

      const expectedContextId =
        record.canonicalContextId || active.contextId || null;
      if (
        contextId &&
        expectedContextId &&
        contextId !== expectedContextId
      ) {
        record.active = driftRecoveryActive();
        record.updatedAt = new Date().toISOString();
        await persist();
        throw coordinatorError(
          "HERMES_CONTEXT_DRIFT",
          "Hermes returned a different contextId than the context requested or already bound for this ChatGPT conversation.",
          {
            sessionHash: scope.sessionHash,
            expectedContextId,
            returnedContextId: contextId,
          },
        );
      }

      const expectedSessionId =
        record.canonicalSessionId || active.sessionId || null;
      if (
        sessionId &&
        expectedSessionId &&
        sessionId !== expectedSessionId
      ) {
        record.active = driftRecoveryActive();
        record.updatedAt = new Date().toISOString();
        await persist();
        throw coordinatorError(
          "HERMES_NATIVE_SESSION_DRIFT",
          "Hermes returned a different sessionId than the session requested or already bound for this ChatGPT conversation.",
          {
            sessionHash: scope.sessionHash,
            expectedSessionId,
            returnedSessionId: sessionId,
          },
        );
      }

      if (active.route && !record.canonicalRoute) {
        record.canonicalRoute = active.route;
      }
      if (contextId && !record.canonicalContextId) {
        record.canonicalContextId = contextId;
      }
      if (sessionId && !record.canonicalSessionId) {
        record.canonicalSessionId = sessionId;
      }

      if (keepActive) {
        record.active = {
          ...active,
          restoreOnFailure: null,
          kind: activeKind || active.kind,
          contextId: contextId || active.contextId || null,
          sessionId: sessionId || active.sessionId || null,
          taskId: taskId || active.taskId || null,
          runId: runId || active.runId || null,
          stateName: activeStateName || active.stateName || null,
        };
      } else {
        record.active = null;
      }

      const cacheableResult =
        active.fingerprint &&
        payload &&
        payloadIsReusable(payload) &&
        !(
          keepActive &&
          (activeKind || active.kind) === "run"
        );
      if (cacheableResult) {
        setRecentResult(scope.sessionHash, {
          fingerprint: active.fingerprint,
          settledAtMs: Date.now(),
          traceId: traceId || active.traceId || null,
          payload,
        });
      } else if (!keepActive) {
        const recent = getRecentResult(scope.sessionHash);
        const staleFingerprints = new Set(
          [
            active.fingerprint || null,
            active.restoreOnFailure?.fingerprint || null,
          ].filter(Boolean),
        );
        if (recent && staleFingerprints.has(recent.fingerprint)) {
          deleteRecentResult(scope.sessionHash);
        }
      }
      record.updatedAt = new Date().toISOString();
      await persist();
      return snapshot(scope, record);
    });
  }

  async function fail(scope, operationId) {
    if (!scope?.tracked || !scope.sessionHash || !operationId) return;
    await ensureLoaded();
    return withLock(scope.sessionHash, async () => {
      const record = getRecord(scope.sessionHash);
      if (record.active?.operationId === operationId) {
        record.active = record.active.restoreOnFailure || null;
        record.updatedAt = new Date().toISOString();
        await persist();
      }
      return snapshot(scope, record);
    });
  }

  async function markSubmissionUnknown(
    scope,
    operationId,
    route = "native",
  ) {
    if (!scope?.tracked || !scope.sessionHash || !operationId) return;
    await ensureLoaded();
    return withLock(scope.sessionHash, async () => {
      const record = getRecord(scope.sessionHash);
      if (record.active?.operationId === operationId) {
        record.active = {
          ...record.active,
          kind:
            route === "a2a"
              ? "a2a-submission-unknown"
              : "native-submission-unknown",
          ownerInstanceId: instanceId,
        };
        record.updatedAt = new Date().toISOString();
        await persist();
      }
      return snapshot(scope, record);
    });
  }

  async function observe(
    scope,
    {
      kind,
      id,
      terminal,
      contextId = null,
      sessionId = null,
      replayPayload = null,
    },
  ) {
    if (!scope?.tracked || !scope.sessionHash) return;
    await ensureLoaded();
    return withLock(scope.sessionHash, async () => {
      const record = getRecord(scope.sessionHash);
      const active = record.active;
      const matches =
        kind === "run"
          ? active?.kind === "run" && active?.runId === id
          : active?.kind === "a2a-task" && active?.taskId === id;
      if (!matches) return snapshot(scope, record);

      const expectedContextId =
        record.canonicalContextId || active.contextId || null;
      if (
        contextId &&
        expectedContextId &&
        contextId !== expectedContextId
      ) {
        throw coordinatorError(
          "HERMES_CONTEXT_DRIFT",
          "Hermes reported a different contextId while observing the active operation.",
          {
            sessionHash: scope.sessionHash,
            expectedContextId,
            returnedContextId: contextId,
            active: activeSummary(active),
          },
        );
      }

      const expectedSessionId =
        record.canonicalSessionId || active.sessionId || null;
      if (
        sessionId &&
        expectedSessionId &&
        sessionId !== expectedSessionId
      ) {
        throw coordinatorError(
          "HERMES_NATIVE_SESSION_DRIFT",
          "Hermes reported a different sessionId while observing the active operation.",
          {
            sessionHash: scope.sessionHash,
            expectedSessionId,
            returnedSessionId: sessionId,
            active: activeSummary(active),
          },
        );
      }

      if (contextId && !record.canonicalContextId) {
        record.canonicalContextId = contextId;
      }
      if (sessionId && !record.canonicalSessionId) {
        record.canonicalSessionId = sessionId;
      }
      if (terminal === true && active.fingerprint) {
        if (replayPayload && payloadIsReusable(replayPayload)) {
          setRecentResult(scope.sessionHash, {
            fingerprint: active.fingerprint,
            settledAtMs: Date.now(),
            traceId: active.traceId || null,
            payload: replayPayload,
          });
        } else {
          const recent = getRecentResult(scope.sessionHash);
          if (recent?.fingerprint === active.fingerprint) {
            deleteRecentResult(scope.sessionHash);
          }
        }
      }
      if (terminal === true) {
        record.active = null;
      }
      record.updatedAt = new Date().toISOString();
      await persist();
      return snapshot(scope, record);
    });
  }

  async function assertActiveRun(scope, runId) {
    if (!scope?.tracked || !scope.sessionHash) return;
    await ensureLoaded();
    return withLock(scope.sessionHash, async () => {
      const record = getRecord(scope.sessionHash);
      if (record.active?.kind === "run" && record.active.runId === runId) {
        return snapshot(scope, record);
      }
      throw coordinatorError(
        "HERMES_RUN_MISMATCH",
        "The requested runId is not the active Hermes run for this ChatGPT conversation.",
        {
          sessionHash: scope.sessionHash,
          requestedRunId: runId,
          active: activeSummary(record.active),
        },
      );
    });
  }

  async function assertActiveTask(scope, taskId) {
    if (!scope?.tracked || !scope.sessionHash) return;
    await ensureLoaded();
    return withLock(scope.sessionHash, async () => {
      const record = getRecord(scope.sessionHash);
      if (
        record.active?.kind === "a2a-task" &&
        record.active.taskId === taskId
      ) {
        return snapshot(scope, record);
      }
      throw coordinatorError(
        "HERMES_TASK_MISMATCH",
        "The requested taskId is not the active Hermes task for this ChatGPT conversation.",
        {
          sessionHash: scope.sessionHash,
          requestedTaskId: taskId,
          active: activeSummary(record.active),
        },
      );
    });
  }

  async function inspect(scope) {
    if (!scope?.tracked || !scope.sessionHash) {
      return {
        tracked: false,
        sessionHash: null,
        canonicalRoute: null,
        canonicalContextId: null,
        canonicalSessionId: null,
        active: null,
      };
    }
    await ensureLoaded();
    return withLock(scope.sessionHash, async () =>
      snapshot(scope, getRecord(scope.sessionHash)),
    );
  }

  return {
    statePath: filePath,
    stalePendingMs,
    dedupWindowMs,
    scopeFromMeta,
    begin,
    complete,
    fail,
    markSubmissionUnknown,
    observe,
    assertActiveRun,
    assertActiveTask,
    inspect,
  };
}
