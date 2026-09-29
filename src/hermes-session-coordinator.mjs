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
  if (!active || active.taskId || active.runId) return false;
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

  const state = { version: 1, sessions: {} };
  const recentResults = new Map();
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
      };
    }

    await ensureLoaded();
    return withLock(scope.sessionHash, async () => {
      const record = getRecord(scope.sessionHash);
      let changed = false;

      if (isStalePending(record.active, stalePendingMs)) {
        record.active = null;
        changed = true;
      }

      if (record.active && typeof reconcileActive === "function") {
        try {
          const reconciled = await reconcileActive(activeSummary(record.active));
          if (reconciled?.terminal === true) {
            if (reconciled.contextId && !record.canonicalContextId) {
              record.canonicalContextId = reconciled.contextId;
            }
            if (reconciled.sessionId && !record.canonicalSessionId) {
              record.canonicalSessionId = reconciled.sessionId;
            }
            record.active = null;
            changed = true;
          }
        } catch {
          // A status failure must never make us assume an active Hermes job ended.
        }
      }

      const resumableTask =
        record.active?.kind === "a2a-task" &&
        requestedTaskId &&
        record.active.taskId === requestedTaskId &&
        ["input-required", "auth-required"].includes(record.active.stateName);

      if (record.active && !resumableTask) {
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
          ? record.canonicalRoute || "a2a"
          : mode === "continue-context"
            ? "a2a"
            : "native";
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
      const recent = recentResults.get(scope.sessionHash);
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

      if (resumableTask) {
        record.active = null;
        changed = true;
      }

      const operationId = randomUUID();
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

      if (
        active.route &&
        record.canonicalRoute &&
        active.route !== record.canonicalRoute
      ) {
        record.active = null;
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

      if (
        contextId &&
        record.canonicalContextId &&
        contextId !== record.canonicalContextId
      ) {
        record.active = null;
        record.updatedAt = new Date().toISOString();
        await persist();
        throw coordinatorError(
          "HERMES_CONTEXT_DRIFT",
          "Hermes returned a different contextId than the canonical context for this ChatGPT conversation.",
          {
            sessionHash: scope.sessionHash,
            canonicalContextId: record.canonicalContextId,
            returnedContextId: contextId,
          },
        );
      }

      if (
        sessionId &&
        record.canonicalSessionId &&
        sessionId !== record.canonicalSessionId
      ) {
        record.active = null;
        record.updatedAt = new Date().toISOString();
        await persist();
        throw coordinatorError(
          "HERMES_NATIVE_SESSION_DRIFT",
          "Hermes returned a different sessionId than the canonical durable session for this ChatGPT conversation.",
          {
            sessionHash: scope.sessionHash,
            canonicalSessionId: record.canonicalSessionId,
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

      if (active.fingerprint && payload) {
        recentResults.set(scope.sessionHash, {
          fingerprint: active.fingerprint,
          settledAtMs: Date.now(),
          traceId: traceId || active.traceId || null,
          payload,
        });
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
        record.active = null;
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

      if (contextId && !record.canonicalContextId) {
        record.canonicalContextId = contextId;
      }
      if (sessionId && !record.canonicalSessionId) {
        record.canonicalSessionId = sessionId;
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
    observe,
    assertActiveRun,
    assertActiveTask,
    inspect,
  };
}
