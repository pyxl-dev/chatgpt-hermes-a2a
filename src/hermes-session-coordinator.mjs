import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

const DEFAULT_DEDUP_WINDOW_MS = 60_000;
const PROCESS_STATE_TRANSACTION_QUEUES = new Map();

async function withProcessStateTransactionQueue(key, fn) {
  const previous = PROCESS_STATE_TRANSACTION_QUEUES.get(key) || Promise.resolve();
  let release;
  const current = new Promise((resolve) => {
    release = resolve;
  });
  const queued = previous.catch(() => {}).then(() => current);
  PROCESS_STATE_TRANSACTION_QUEUES.set(key, queued);
  await previous.catch(() => {});
  try {
    return await fn();
  } finally {
    release();
    if (PROCESS_STATE_TRANSACTION_QUEUES.get(key) === queued) {
      PROCESS_STATE_TRANSACTION_QUEUES.delete(key);
    }
  }
}

const UNSUCCESSFUL_OUTCOMES = new Set([
  "failed",
  "rejected",
  "cancelled",
  "canceled",
  "interrupted",
]);

function sha256(value) {
  return createHash("sha256").update(String(value), "utf8").digest("hex");
}

function normalizeInstruction(value) {
  return String(value || "").normalize("NFKC").trim().replace(/\s+/gu, " ");
}

function legacyNativeMode(mode) {
  switch (mode) {
    case "delegate_to_hermes":
      return "delegate";
    case "continue_hermes_session":
      return "continue-session";
    case "start_hermes_run":
      return "start-run";
    default:
      return mode;
  }
}

function currentFingerprint(mode, requestedSessionId, instruction) {
  return sha256(
    [
      mode,
      requestedSessionId || "",
      normalizeInstruction(instruction),
    ].join("\n"),
  );
}

function legacyNativeFingerprint(mode, requestedSessionId, instruction) {
  return sha256(
    [
      legacyNativeMode(mode),
      "",
      requestedSessionId || "",
      "",
      normalizeInstruction(instruction),
    ].join("\n"),
  );
}

function normalizedDedupWindowMs(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 1000
    ? parsed
    : DEFAULT_DEDUP_WINDOW_MS;
}

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
    sessionId: active.sessionId || null,
    runId: active.runId || null,
    legacyFingerprint: active.legacyFingerprint || null,
    reusedSession:
      typeof active.reusedSession === "boolean"
        ? active.reusedSession
        : null,
  };
}

function sessionBindingResolved(record, active, returnedSessionId = null) {
  return Boolean(
    returnedSessionId ||
      record?.canonicalSessionId ||
      active?.sessionId,
  );
}

function nativeReplayPayload(payload) {
  if (!payload || typeof payload !== "object") return false;
  return Boolean(
    payload.runId ||
      payload.sessionId ||
      [
        "delegate_to_hermes",
        "start_hermes_run",
        "continue_hermes_session",
      ].includes(payload.operation),
  );
}

export function createHermesSessionCoordinator({
  root,
  randomUUID,
  statePath = null,
  dedupWindowMs = process.env.HERMES_DEDUP_WINDOW_MS,
}) {
  const runtimeDir = path.join(root, ".runtime");
  const filePath =
    statePath ||
    process.env.HERMES_SESSION_COORDINATOR_STATE ||
    path.join(runtimeDir, "chatgpt-session-coordinator.json");

  const replayWindowMs = normalizedDedupWindowMs(dedupWindowMs);
  const stateMutexPath = filePath + ".mutex.sqlite";
  const stateMutexWaitMs = 30_000;

  const state = { version: 3, sessions: {}, recentResults: {} };
  const instanceId = randomUUID();

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

  function pruneExpiredRecentResults(now = Date.now()) {
    if (
      !state.recentResults ||
      typeof state.recentResults !== "object" ||
      Array.isArray(state.recentResults)
    ) {
      state.recentResults = {};
      return true;
    }

    let changed = false;
    for (const [sessionHash, bucket] of Object.entries(state.recentResults)) {
      if (!bucket || typeof bucket !== "object" || Array.isArray(bucket)) {
        delete state.recentResults[sessionHash];
        changed = true;
        continue;
      }

      for (const [fingerprint, recent] of Object.entries(bucket)) {
        const settledAtMs = Number(recent?.settledAtMs);
        if (
          !recent ||
          typeof recent !== "object" ||
          Array.isArray(recent) ||
          !Number.isFinite(settledAtMs) ||
          now - settledAtMs > replayWindowMs
        ) {
          delete bucket[fingerprint];
          changed = true;
        }
      }

      if (Object.keys(bucket).length === 0) {
        delete state.recentResults[sessionHash];
        changed = true;
      }
    }
    return changed;
  }

  function migrateLegacyRecentResults(input, { markV1 = false } = {}) {
    const next = {};
    if (!input || typeof input !== "object" || Array.isArray(input)) {
      return next;
    }

    for (const [sessionHash, recent] of Object.entries(input)) {
      if (
        recent?.fingerprint &&
        recent?.payload &&
        nativeReplayPayload(recent.payload)
      ) {
        const key = markV1
          ? "legacy:" + recent.fingerprint
          : recent.fingerprint;
        next[sessionHash] = {
          [key]: {
            settledAtMs: recent.settledAtMs,
            traceId: recent.traceId || null,
            payload: recent.payload,
            ...(markV1
              ? { legacyFingerprint: recent.fingerprint }
              : {}),
          },
        };
      }
    }
    return next;
  }

  function migrateV1(parsed) {
    const nextSessions = {};
    const nextRecent = migrateLegacyRecentResults(
      parsed.recentResults,
      { markV1: true },
    );

    for (const [sessionHash, record] of Object.entries(parsed.sessions || {})) {
      if (!record || typeof record !== "object" || Array.isArray(record)) {
        continue;
      }
      const active = record.active;
      const nativeActive =
        active &&
        (
          active.route === "native" ||
          active.kind === "run" ||
          String(active.kind || "").startsWith("native-")
        )
          ? {
              operationId: active.operationId || null,
              tool: active.tool || null,
              kind: active.kind || "native-pending",
              traceId: active.traceId || null,
              startedAt: active.startedAt || null,
              sessionId: active.sessionId || null,
              runId: active.runId || null,
              fingerprint: null,
              legacyFingerprint: active.fingerprint || null,
              ownerInstanceId: active.ownerInstanceId || null,
              idempotencyKey: active.idempotencyKey || null,
            }
          : null;

      nextSessions[sessionHash] = {
        canonicalSessionId:
          record.canonicalSessionId ||
          nativeActive?.sessionId ||
          null,
        active: nativeActive,
        updatedAt: record.updatedAt || null,
      };

    }

    state.sessions = nextSessions;
    state.recentResults = nextRecent;
    state.version = 3;
  }

  async function persist() {
    pruneExpiredRecentResults();
    await fs.mkdir(path.dirname(filePath), {
      recursive: true,
      mode: 0o700,
    });
    const tempPath =
      filePath + "." + process.pid + "." + randomUUID() + ".tmp";
    try {
      await fs.writeFile(
        tempPath,
        JSON.stringify(state, null, 2) + "\n",
        { encoding: "utf8", mode: 0o600 },
      );
      await fs.rename(tempPath, filePath);
      await fs.chmod(filePath, 0o600).catch(() => {});
    } finally {
      await fs.rm(tempPath, { force: true }).catch(() => {});
    }
  }

  function resetState() {
    state.version = 3;
    state.sessions = {};
    state.recentResults = {};
  }

  async function loadStateFromDisk({ persistRepairs = false } = {}) {
    resetState();
    let migrated = false;

    try {
      const raw = await fs.readFile(filePath, "utf8");
      const parsed = JSON.parse(raw);

      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw coordinatorError(
          "HERMES_COORDINATOR_STATE_INVALID",
          "Hermes coordinator state is not a valid object.",
        );
      }

      if (![1, 2, 3].includes(parsed.version)) {
        throw coordinatorError(
          "HERMES_COORDINATOR_STATE_VERSION_UNSUPPORTED",
          "Hermes coordinator state uses an unsupported schema version; refusing to overwrite it.",
          { version: parsed.version ?? null },
        );
      }

      if (
        !parsed.sessions ||
        typeof parsed.sessions !== "object" ||
        Array.isArray(parsed.sessions)
      ) {
        throw coordinatorError(
          "HERMES_COORDINATOR_STATE_INVALID",
          "Hermes coordinator state has an invalid sessions object.",
          { version: parsed.version },
        );
      }

      if (parsed.version === 1) {
        migrateV1(parsed);
        migrated = true;
      } else if (parsed.version === 2) {
        state.sessions = parsed.sessions;
        state.recentResults = migrateLegacyRecentResults(
          parsed.recentResults,
        );
        state.version = 3;
        migrated = true;
      } else {
        state.sessions = parsed.sessions;
        state.recentResults =
          parsed.recentResults &&
          typeof parsed.recentResults === "object" &&
          !Array.isArray(parsed.recentResults)
            ? parsed.recentResults
            : {};
      }
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }

    const pruned = pruneExpiredRecentResults();
    if (persistRepairs && (migrated || pruned)) await persist();
  }

  async function acquireStateMutexTransaction() {
    const deadline = Date.now() + stateMutexWaitMs;

    while (true) {
      const database = new DatabaseSync(stateMutexPath);
      try {
        database.exec("PRAGMA busy_timeout = 0");
        database.exec("BEGIN IMMEDIATE");
        return database;
      } catch (error) {
        database.close();
        if (!/database is (locked|busy)/iu.test(String(error?.message || ""))) {
          throw error;
        }

        const remaining = deadline - Date.now();
        if (remaining <= 0) {
          throw coordinatorError(
            "HERMES_COORDINATOR_LOCK_TIMEOUT",
            "Timed out waiting for the Hermes coordinator SQLite transaction mutex.",
            { lockPath: stateMutexPath },
          );
        }
        await new Promise((resolve) =>
          setTimeout(resolve, Math.min(25, remaining)),
        );
      }
    }
  }

  async function withStateTransaction(fn) {
    return withProcessStateTransactionQueue(stateMutexPath, async () => {
      await fs.mkdir(path.dirname(filePath), {
        recursive: true,
        mode: 0o700,
      });

      const database = await acquireStateMutexTransaction();
      let transactionOpen = true;
      try {
        await fs.chmod(stateMutexPath, 0o600).catch(() => {});
        await loadStateFromDisk({ persistRepairs: true });
        const result = await fn();
        database.exec("COMMIT");
        transactionOpen = false;
        return result;
      } catch (error) {
        if (transactionOpen) {
          try {
            database.exec("ROLLBACK");
          } catch {}
        }
        throw error;
      } finally {
        database.close();
      }
    });
  }

  function getRecord(sessionHash) {
    let record = state.sessions[sessionHash];
    if (!record || typeof record !== "object" || Array.isArray(record)) {
      record = {
        canonicalSessionId: null,
        active: null,
        updatedAt: null,
      };
      state.sessions[sessionHash] = record;
    }
    return record;
  }

  function getRecentResult(sessionHash, fingerprint) {
    if (!fingerprint) return null;
    const bucket = state.recentResults?.[sessionHash];
    const recent = bucket?.[fingerprint];
    return recent && typeof recent === "object" && !Array.isArray(recent)
      ? recent
      : null;
  }

  function findLegacyRecentResult(sessionHash, legacyFingerprint) {
    if (!legacyFingerprint) return null;
    const bucket = state.recentResults?.[sessionHash];
    if (!bucket || typeof bucket !== "object" || Array.isArray(bucket)) {
      return null;
    }
    for (const [key, recent] of Object.entries(bucket)) {
      if (
        recent &&
        typeof recent === "object" &&
        !Array.isArray(recent) &&
        recent.legacyFingerprint === legacyFingerprint
      ) {
        return { key, recent };
      }
    }
    return null;
  }

  function setRecentResult(sessionHash, fingerprint, value) {
    if (!fingerprint) return;
    let bucket = state.recentResults[sessionHash];
    if (!bucket || typeof bucket !== "object" || Array.isArray(bucket)) {
      bucket = {};
      state.recentResults[sessionHash] = bucket;
    }
    const existing = getRecentResult(sessionHash, fingerprint);
    bucket[fingerprint] = {
      ...value,
      settledAtMs: existing?.settledAtMs ?? value.settledAtMs,
    };

  }

  function deleteRecentResult(sessionHash, fingerprint) {
    if (!fingerprint) return;
    const bucket = state.recentResults?.[sessionHash];
    if (!bucket || typeof bucket !== "object" || Array.isArray(bucket)) return;
    delete bucket[fingerprint];
    if (Object.keys(bucket).length === 0) {
      delete state.recentResults[sessionHash];
    }
  }

  function activeIdentity(active) {
    if (!active || typeof active !== "object") return null;
    return {
      operationId: active.operationId || null,
      kind: active.kind || null,
      runId: active.runId || null,
      sessionId: active.sessionId || null,
      fingerprint: active.fingerprint || null,
      legacyFingerprint: active.legacyFingerprint || null,
      ownerInstanceId: active.ownerInstanceId || null,
      idempotencyKey: active.idempotencyKey || null,
      startedAt: active.startedAt || null,
      reusedSession:
        typeof active.reusedSession === "boolean"
          ? active.reusedSession
          : null,
    };
  }

  function sameActiveIdentity(active, expected) {
    if (!expected) return false;
    const current = activeIdentity(active);
    return Boolean(
      current &&
      current.operationId === expected.operationId &&
      current.kind === expected.kind &&
      current.runId === expected.runId &&
      current.sessionId === expected.sessionId &&
      current.fingerprint === expected.fingerprint &&
      current.legacyFingerprint === expected.legacyFingerprint &&
      current.ownerInstanceId === expected.ownerInstanceId &&
      current.idempotencyKey === expected.idempotencyKey &&
      current.startedAt === expected.startedAt &&
      current.reusedSession === expected.reusedSession
    );
  }

  function snapshot(scope, record) {
    return {
      tracked: Boolean(scope?.tracked),
      sessionHash: scope?.sessionHash || null,
      canonicalSessionId: record?.canonicalSessionId || null,
      active: activeSummary(record?.active),
    };
  }

  async function inspect(scope) {
    if (!scope?.tracked || !scope.sessionHash) {
      return {
        tracked: false,
        sessionHash: null,
        canonicalSessionId: null,
        active: null,
      };
    }
    return withStateTransaction(async () =>
      snapshot(scope, getRecord(scope.sessionHash)),
    );
  }

  async function begin(
    scope,
    {
      mode = "delegate",
      tool,
      traceId = null,
      instruction,
      requestedSessionId = null,
      reconcileActive = null,
    },
  ) {
    const requested =
      typeof requestedSessionId === "string" && requestedSessionId.trim()
        ? requestedSessionId.trim()
        : null;

    const fingerprint =
      typeof instruction === "string" && instruction.trim()
        ? currentFingerprint(mode, requested, instruction)
        : null;
    const legacyFingerprint =
      typeof instruction === "string" && instruction.trim()
        ? legacyNativeFingerprint(mode, requested, instruction)
        : null;

    if (!scope?.tracked || !scope.sessionHash) {
      return {
        tracked: false,
        replay: false,
        operationId: null,
        canonicalSessionId: requested,
        sessionIdToUse: requested,
        idempotencyKey: null,
      };
    }

    let reconcileTarget = null;
    if (typeof reconcileActive === "function") {
      reconcileTarget = await withStateTransaction(async () => {
        const record = state.sessions[scope.sessionHash];
        let active =
          record &&
          typeof record === "object" &&
          !Array.isArray(record)
            ? record.active
            : null;

        if (active?.legacyFingerprint) {
          if (
            !fingerprint ||
            !legacyFingerprint ||
            active.legacyFingerprint !== legacyFingerprint
          ) {
            return null;
          }
          record.active = {
            ...active,
            fingerprint,
            legacyFingerprint: null,
          };
          record.updatedAt = new Date().toISOString();
          await persist();
          active = record.active;
        }

        return active
          ? {
              identity: activeIdentity(active),
              summary: activeSummary(active),
            }
          : null;
      });
    }

    let reconciled = null;
    if (reconcileTarget) {
      try {
        reconciled = await reconcileActive(reconcileTarget.summary);
      } catch (error) {
        if (error?.code === "HERMES_NATIVE_RUN_ID_MISMATCH") throw error;
        // A transient status failure is not evidence that the active Run ended.
      }
    }

    return withStateTransaction(async () => {
      const record = getRecord(scope.sessionHash);
      let changed = false;

      if (
        reconciled &&
        reconcileTarget &&
        sameActiveIdentity(record.active, reconcileTarget.identity)
      ) {
        const expectedSessionId =
          record.canonicalSessionId || record.active.sessionId || null;
        if (
          reconciled.sessionId &&
          expectedSessionId &&
          reconciled.sessionId !== expectedSessionId
        ) {
          throw coordinatorError(
            "HERMES_NATIVE_SESSION_DRIFT",
            "Hermes reported a different sessionId while reconciling the active Run.",
            {
              sessionHash: scope.sessionHash,
              expectedSessionId,
              returnedSessionId: reconciled.sessionId,
              active: activeSummary(record.active),
            },
          );
        }

        if (reconciled.sessionId && !record.canonicalSessionId) {
          record.canonicalSessionId = reconciled.sessionId;
          changed = true;
        }

        if (reconciled.terminal === true) {
          const currentActive = record.active;
          const fingerprint = currentActive.fingerprint || null;
          const reusable =
            fingerprint &&
            reconciled.replayPayload &&
            payloadIsReusable(reconciled.replayPayload);

          if (
            reusable &&
            (
              currentActive.kind !== "native-session-unresolved" ||
              getRecentResult(scope.sessionHash, fingerprint)
            )
          ) {
            setRecentResult(scope.sessionHash, fingerprint, {
              settledAtMs: Date.now(),
              traceId: currentActive.traceId || null,
              payload: reconciled.replayPayload,
            });
          } else if (fingerprint) {
            deleteRecentResult(scope.sessionHash, fingerprint);
          }

          if (
            reusable &&
            !sessionBindingResolved(
              record,
              currentActive,
              reconciled.sessionId || null,
            )
          ) {
            record.active = {
              ...currentActive,
              kind: "native-session-unresolved",
              runId: currentActive.runId || null,
              sessionId: null,
              ownerInstanceId: instanceId,
            };
          } else {
            record.active = null;
          }
          changed = true;
        }
      }

      if (changed) {
        record.updatedAt = new Date().toISOString();
        await persist();
      }

      if (
        record.active?.legacyFingerprint &&
        fingerprint &&
        legacyFingerprint &&
        record.active.legacyFingerprint === legacyFingerprint
      ) {
        record.active = {
          ...record.active,
          fingerprint,
          legacyFingerprint: null,
        };
        record.updatedAt = new Date().toISOString();
        await persist();
      }

      const active = record.active;
      const recoverablePending =
        active?.kind === "native-submission-unknown" &&
        fingerprint &&
        active.fingerprint === fingerprint;

      const now = Date.now();
      let recent = getRecentResult(scope.sessionHash, fingerprint);

      if (!recent && fingerprint && legacyFingerprint) {
        const legacyRecent = findLegacyRecentResult(
          scope.sessionHash,
          legacyFingerprint,
        );
        if (legacyRecent) {
          recent = legacyRecent.recent;
          setRecentResult(scope.sessionHash, fingerprint, {
            ...legacyRecent.recent,
            legacyFingerprint: null,
          });
          if (legacyRecent.key !== fingerprint) {
            deleteRecentResult(scope.sessionHash, legacyRecent.key);
          }
          record.updatedAt = new Date().toISOString();
          await persist();
        }
      }

      if (
        fingerprint &&
        recent &&
        now - Number(recent.settledAtMs) <= replayWindowMs
      ) {
        return {
          tracked: true,
          replay: true,
          operationId: null,
          canonicalSessionId: record.canonicalSessionId || null,
          sessionIdToUse: requested || record.canonicalSessionId || null,
          replayPayload: {
            ...recent.payload,
            deduplicated: true,
            duplicateOfTraceId: recent.traceId || null,
            dedupWindowMs: replayWindowMs,
          },
          idempotencyKey: null,
        };
      }

      const exactActiveRun =
        active?.kind === "run" &&
        Boolean(active.runId) &&
        fingerprint &&
        active.fingerprint === fingerprint;

      if (exactActiveRun) {
        return {
          tracked: true,
          replay: false,
          activeRun: true,
          operationId: active.operationId || null,
          canonicalSessionId: record.canonicalSessionId || null,
          sessionIdToUse:
            active.sessionId ||
            requested ||
            record.canonicalSessionId ||
            null,
          runId: active.runId,
          activeTraceId: active.traceId || null,
          reusedSession:
            typeof active.reusedSession === "boolean"
              ? active.reusedSession
              : Boolean(record.canonicalSessionId),
          idempotencyKey: active.idempotencyKey || null,
        };
      }

      if (active?.kind === "native-session-unresolved") {
        throw coordinatorError(
          "HERMES_NATIVE_SESSION_UNRESOLVED",
          "Hermes completed the previous sessionless Run without returning a durable sessionId. Exact retries can replay the completed result, but different work is blocked until Hermes exposes the durable session binding.",
          {
            sessionHash: scope.sessionHash,
            active: activeSummary(active),
          },
        );
      }

      if (active && !recoverablePending) {
        throw coordinatorError(
          "HERMES_SESSION_BUSY",
          "Another Hermes Run is already active for this ChatGPT conversation.",
          {
            sessionHash: scope.sessionHash,
            active: activeSummary(active),
          },
        );
      }

      if (
        requested &&
        record.canonicalSessionId &&
        requested !== record.canonicalSessionId
      ) {
        throw coordinatorError(
          "HERMES_NATIVE_SESSION_MISMATCH",
          "The requested Hermes sessionId does not match the canonical durable session for this ChatGPT conversation.",
          {
            sessionHash: scope.sessionHash,
            canonicalSessionId: record.canonicalSessionId,
            requestedSessionId: requested,
          },
        );
      }

      const operationId = randomUUID();
      const idempotencyKey =
        recoverablePending && active?.idempotencyKey
          ? active.idempotencyKey
          : sha256(scope.sessionHash + "\n" + operationId);

      const reusedSession =
        recoverablePending && typeof active?.reusedSession === "boolean"
          ? active.reusedSession
          : Boolean(requested || record.canonicalSessionId);

      record.active = {
        operationId,
        tool,
        kind: "native-pending",
        traceId,
        startedAt: new Date().toISOString(),
        sessionId: requested || record.canonicalSessionId || null,
        runId: null,
        fingerprint,
        ownerInstanceId: instanceId,
        idempotencyKey,
        reusedSession,
      };
      record.updatedAt = new Date().toISOString();
      await persist();

      return {
        tracked: true,
        replay: false,
        operationId,
        canonicalSessionId: record.canonicalSessionId || null,
        sessionIdToUse: requested || record.canonicalSessionId || null,
        reusedSession,
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
      sessionId = null,
      runId = null,
      keepActive = false,
      activeKind = null,
    } = {},
  ) {
    if (!scope?.tracked || !scope.sessionHash || !operationId) return;

    return withStateTransaction(async () => {
      const record = getRecord(scope.sessionHash);
      const active = record.active;
      if (!active || active.operationId !== operationId) {
        return snapshot(scope, record);
      }

      const returnedSessionId =
        typeof sessionId === "string" && sessionId.trim()
          ? sessionId.trim()
          : null;
      const expectedSessionId =
        record.canonicalSessionId || active.sessionId || null;

      if (
        returnedSessionId &&
        expectedSessionId &&
        returnedSessionId !== expectedSessionId
      ) {
        if (runId) {
          record.active = {
            ...active,
            kind: activeKind || "run",
            runId,
            sessionId: active.sessionId || null,
            ownerInstanceId: instanceId,
          };
          record.updatedAt = new Date().toISOString();
          await persist();
        }
        throw coordinatorError(
          "HERMES_NATIVE_SESSION_DRIFT",
          "Hermes returned a different sessionId than the requested or canonical durable session.",
          {
            sessionHash: scope.sessionHash,
            expectedSessionId,
            returnedSessionId,
            runId: runId || null,
          },
        );
      }

      if (returnedSessionId && !record.canonicalSessionId) {
        record.canonicalSessionId = returnedSessionId;
      }

      const cacheable =
        active.fingerprint &&
        payload &&
        payloadIsReusable(payload) &&
        !(keepActive && (activeKind || active.kind) === "run");

      if (keepActive) {
        record.active = {
          ...active,
          kind: activeKind || "run",
          sessionId:
            returnedSessionId ||
            active.sessionId ||
            record.canonicalSessionId ||
            null,
          runId: runId || active.runId || null,
          ownerInstanceId: instanceId,
        };
      } else if (
        cacheable &&
        !sessionBindingResolved(record, active, returnedSessionId)
      ) {
        record.active = {
          ...active,
          kind: "native-session-unresolved",
          sessionId: null,
          runId: runId || active.runId || null,
          ownerInstanceId: instanceId,
        };
      } else {
        record.active = null;
      }

      if (cacheable) {
        setRecentResult(scope.sessionHash, active.fingerprint, {
          settledAtMs: Date.now(),
          traceId: traceId || active.traceId || null,
          payload,
        });
      } else if (!keepActive && active.fingerprint) {
        deleteRecentResult(scope.sessionHash, active.fingerprint);
      }

      record.updatedAt = new Date().toISOString();
      await persist();
      return snapshot(scope, record);
    });
  }

  async function fail(scope, operationId) {
    if (!scope?.tracked || !scope.sessionHash || !operationId) return;
    return withStateTransaction(async () => {
      const record = getRecord(scope.sessionHash);
      if (record.active?.operationId === operationId) {
        record.active = null;
        record.updatedAt = new Date().toISOString();
        await persist();
      }
      return snapshot(scope, record);
    });
  }

  async function preserveSubmittedRun(
    scope,
    operationId,
    { runId, sessionId = null } = {},
  ) {
    if (
      !scope?.tracked ||
      !scope.sessionHash ||
      !operationId ||
      typeof runId !== "string" ||
      !runId.trim()
    ) {
      return;
    }

    return withStateTransaction(async () => {
      const record = getRecord(scope.sessionHash);
      const active = record.active;
      if (!active || active.operationId !== operationId) {
        return snapshot(scope, record);
      }

      const returnedSessionId =
        typeof sessionId === "string" && sessionId.trim()
          ? sessionId.trim()
          : null;
      const expectedSessionId =
        record.canonicalSessionId || active.sessionId || null;
      const safeSessionId =
        returnedSessionId &&
        (!expectedSessionId || returnedSessionId === expectedSessionId)
          ? returnedSessionId
          : active.sessionId || record.canonicalSessionId || null;

      if (returnedSessionId && !record.canonicalSessionId && safeSessionId === returnedSessionId) {
        record.canonicalSessionId = returnedSessionId;
      }

      record.active = {
        ...active,
        kind: "run",
        runId: runId.trim(),
        sessionId:
          safeSessionId ||
          active.sessionId ||
          record.canonicalSessionId ||
          null,
        ownerInstanceId: instanceId,
      };
      record.updatedAt = new Date().toISOString();
      await persist();
      return snapshot(scope, record);
    });
  }

  async function markSubmissionUnknown(scope, operationId) {
    if (!scope?.tracked || !scope.sessionHash || !operationId) return;
    return withStateTransaction(async () => {
      const record = getRecord(scope.sessionHash);
      if (record.active?.operationId === operationId) {
        record.active = {
          ...record.active,
          kind: "native-submission-unknown",
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
      sessionId = null,
      replayPayload = null,
    },
  ) {
    if (!scope?.tracked || !scope.sessionHash) return;

    return withStateTransaction(async () => {
      const record = getRecord(scope.sessionHash);
      const active = record.active;
      if (
        kind !== "run" ||
        !["run", "native-session-unresolved"].includes(active?.kind) ||
        active?.runId !== id
      ) {
        return snapshot(scope, record);
      }

      const returnedSessionId =
        typeof sessionId === "string" && sessionId.trim()
          ? sessionId.trim()
          : null;
      const expectedSessionId =
        record.canonicalSessionId || active.sessionId || null;

      if (
        returnedSessionId &&
        expectedSessionId &&
        returnedSessionId !== expectedSessionId
      ) {
        throw coordinatorError(
          "HERMES_NATIVE_SESSION_DRIFT",
          "Hermes reported a different sessionId while observing the active Run.",
          {
            sessionHash: scope.sessionHash,
            expectedSessionId,
            returnedSessionId,
            active: activeSummary(active),
          },
        );
      }

      if (returnedSessionId && !record.canonicalSessionId) {
        record.canonicalSessionId = returnedSessionId;
      }

      if (terminal === true) {
        const reusable =
          active.fingerprint &&
          replayPayload &&
          payloadIsReusable(replayPayload);

        if (
          reusable &&
          (
            active.kind !== "native-session-unresolved" ||
            getRecentResult(scope.sessionHash, active.fingerprint)
          )
        ) {
          setRecentResult(scope.sessionHash, active.fingerprint, {
            settledAtMs: Date.now(),
            traceId: active.traceId || null,
            payload: replayPayload,
          });
        } else if (active.fingerprint) {
          deleteRecentResult(scope.sessionHash, active.fingerprint);
        }

        if (
          reusable &&
          !sessionBindingResolved(record, active, returnedSessionId)
        ) {
          record.active = {
            ...active,
            kind: "native-session-unresolved",
            sessionId: null,
            ownerInstanceId: instanceId,
          };
        } else {
          record.active = null;
        }
      }

      record.updatedAt = new Date().toISOString();
      await persist();
      return snapshot(scope, record);
    });
  }

  async function assertActiveRun(scope, runId) {
    if (!scope?.tracked || !scope.sessionHash) return;
    return withStateTransaction(async () => {
      const record = getRecord(scope.sessionHash);
      if (record.active?.kind === "run" && record.active.runId === runId) {
        return snapshot(scope, record);
      }
      throw coordinatorError(
        "HERMES_RUN_MISMATCH",
        "The requested runId is not the active Hermes Run for this ChatGPT conversation.",
        {
          sessionHash: scope.sessionHash,
          requestedRunId: runId,
          active: activeSummary(record.active),
        },
      );
    });
  }

  return {
    scopeFromMeta,
    inspect,
    begin,
    complete,
    fail,
    preserveSubmittedRun,
    markSubmissionUnknown,
    observe,
    assertActiveRun,
  };
}
