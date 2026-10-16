import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import {
  DEFAULT_PROFILE,
  normalizeProfile,
  profileOrDefault,
} from "./hermes-profiles.mjs";

const DEFAULT_DEDUP_WINDOW_MS = 60_000;
const STATE_VERSION = 4;
// One ChatGPT conversation drives at most this many durable Hermes sessions
// ("slots"), each with at most one Run, so it never has more than this many
// Runs in flight. Slot 1 is the default and the only slot older clients use.
export const MAX_SLOTS = 3;
export const DEFAULT_SLOT = 1;
const SLOT_HISTORY_LIMIT = 10;
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

export function normalizeSlot(value) {
  if (value === undefined || value === null) return null;
  const slot = Number(value);
  if (!Number.isInteger(slot) || slot < 1 || slot > MAX_SLOTS) {
    throw coordinatorError(
      "HERMES_SLOT_INVALID",
      "slot must be an integer from 1 to " + MAX_SLOTS + ".",
      { slot: value },
    );
  }
  return slot;
}

function slotOf(scope) {
  return Number.isInteger(scope?.slot) ? scope.slot : DEFAULT_SLOT;
}

// Slot 1 keeps the pre-slot fingerprint so replays recorded before the v4
// migration still match; other slots get their own replay namespace so the
// same instruction sent to two slots is never deduplicated across them.
function slotFingerprint(slot, fingerprint) {
  if (!fingerprint || slot === DEFAULT_SLOT) return fingerprint;
  return sha256("slot:" + slot + "\n" + fingerprint);
}

// The default profile keeps the pre-profile fingerprint; other profiles get
// their own replay namespace so one instruction is never replayed across them.
function profileFingerprint(profile, fingerprint) {
  if (!fingerprint || !profile || profile === DEFAULT_PROFILE) return fingerprint;
  return sha256("profile:" + profile + "\n" + fingerprint);
}

function emptySlotRecord() {
  return {
    canonicalSessionId: null,
    active: null,
    updatedAt: null,
    history: [],
    archivedSessions: [],
  };
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function conversationsFromLegacySessions(sessions) {
  const conversations = {};
  for (const [sessionHash, record] of Object.entries(sessions || {})) {
    if (!isPlainObject(record)) continue;
    conversations[sessionHash] = {
      slots: {
        [String(DEFAULT_SLOT)]: {
          ...emptySlotRecord(),
          ...record,
          history: Array.isArray(record.history) ? record.history : [],
          archivedSessions: Array.isArray(record.archivedSessions)
            ? record.archivedSessions
            : [],
        },
      },
    };
  }
  return conversations;
}

function coordinatorError(code, message, details = null) {
  const error = new Error(message);
  error.code = code;
  if (details) error.details = details;
  return error;
}

function lastRunSummary(record) {
  const history = Array.isArray(record?.history) ? record.history : [];
  return history.length ? history[history.length - 1] : null;
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
    profile: profileOrDefault(active.profile),
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

  const state = { version: STATE_VERSION, conversations: {}, recentResults: {} };
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
      slot: DEFAULT_SLOT,
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

    state.conversations = conversationsFromLegacySessions(nextSessions);
    state.recentResults = nextRecent;
    state.version = STATE_VERSION;
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
    state.version = STATE_VERSION;
    state.conversations = {};
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

      if (![1, 2, 3, STATE_VERSION].includes(parsed.version)) {
        throw coordinatorError(
          "HERMES_COORDINATOR_STATE_VERSION_UNSUPPORTED",
          "Hermes coordinator state uses an unsupported schema version; refusing to overwrite it.",
          { version: parsed.version ?? null },
        );
      }

      const containerKey =
        parsed.version === STATE_VERSION ? "conversations" : "sessions";
      if (!isPlainObject(parsed[containerKey])) {
        throw coordinatorError(
          "HERMES_COORDINATOR_STATE_INVALID",
          "Hermes coordinator state has an invalid " + containerKey + " object.",
          { version: parsed.version },
        );
      }

      const parsedRecent = isPlainObject(parsed.recentResults)
        ? parsed.recentResults
        : {};

      if (parsed.version === 1) {
        migrateV1(parsed);
        migrated = true;
      } else if (parsed.version === 2) {
        state.conversations = conversationsFromLegacySessions(parsed.sessions);
        state.recentResults = migrateLegacyRecentResults(
          parsed.recentResults,
        );
        migrated = true;
      } else if (parsed.version === 3) {
        // v3 bound exactly one session per conversation: it becomes slot 1,
        // and its replay keys stay valid because slot 1 fingerprints are
        // unchanged.
        state.conversations = conversationsFromLegacySessions(parsed.sessions);
        state.recentResults = parsedRecent;
        migrated = true;
      } else {
        state.conversations = parsed.conversations;
        state.recentResults = parsedRecent;
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

  function getConversation(sessionHash) {
    let conversation = state.conversations[sessionHash];
    if (!isPlainObject(conversation)) {
      conversation = { slots: {} };
      state.conversations[sessionHash] = conversation;
    }
    if (!isPlainObject(conversation.slots)) conversation.slots = {};
    return conversation;
  }

  function peekRecord(scope) {
    const record =
      state.conversations[scope.sessionHash]?.slots?.[String(slotOf(scope))];
    return isPlainObject(record) ? record : null;
  }

  // Creating a slot only lives in memory until a transaction persists it, so
  // reads never materialize slots 2/3; only work started on them does.
  function getRecord(scope) {
    const conversation = getConversation(scope.sessionHash);
    const key = String(slotOf(scope));
    let record = conversation.slots[key];
    if (!isPlainObject(record)) {
      record = emptySlotRecord();
      conversation.slots[key] = record;
    }
    if (!Array.isArray(record.history)) record.history = [];
    if (!Array.isArray(record.archivedSessions)) record.archivedSessions = [];
    return record;
  }

  function slotEntries(sessionHash) {
    const slots = state.conversations[sessionHash]?.slots;
    if (!isPlainObject(slots)) return [];
    return Object.entries(slots)
      .map(([key, record]) => [Number(key), record])
      .filter(
        ([slot, record]) =>
          Number.isInteger(slot) &&
          slot >= 1 &&
          slot <= MAX_SLOTS &&
          isPlainObject(record),
      )
      .sort(([a], [b]) => a - b);
  }

  function otherSlotEntries(scope) {
    const slot = slotOf(scope);
    return slotEntries(scope.sessionHash).filter(([other]) => other !== slot);
  }

  // The other slot, in any conversation, that holds sessionId: bound to it,
  // or running work in it.
  // Session ids are only compared within one Hermes profile.
  function findSessionHolder(scope, sessionId, profile = DEFAULT_PROFILE) {
    const ownSlot = slotOf(scope);
    for (const [sessionHash, conversation] of Object.entries(
      state.conversations,
    )) {
      if (!isPlainObject(conversation)) continue;
      for (const [slot, record] of slotEntries(sessionHash)) {
        if (sessionHash === scope.sessionHash && slot === ownSlot) continue;
        const recordProfile = profileOrDefault(
          record.active?.profile || record.profile,
        );
        if (recordProfile !== profile) continue;
        const busy =
          isPlainObject(record.active) &&
          (record.active.sessionId === sessionId ||
            record.canonicalSessionId === sessionId);
        if (busy || record.canonicalSessionId === sessionId) {
          if (!Array.isArray(record.archivedSessions)) {
            record.archivedSessions = [];
          }
          return {
            sessionHash,
            slot,
            record,
            busy,
            sameConversation: sessionHash === scope.sessionHash,
          };
        }
      }
    }
    return null;
  }

  function freeSlotsFor(scope) {
    const free = [];
    for (let slot = 1; slot <= MAX_SLOTS; slot += 1) {
      if (!isPlainObject(peekRecord({ ...scope, slot })?.active)) free.push(slot);
    }
    return free;
  }

  function parallelRunsFor(scope) {
    return otherSlotEntries(scope)
      .filter(([, record]) => isPlainObject(record.active))
      .map(([slot, record]) => ({
        slot,
        runId: record.active.runId || null,
        sessionId:
          record.active.sessionId || record.canonicalSessionId || null,
        profile: profileOrDefault(record.active.profile || record.profile),
        kind: record.active.kind || null,
        startedAt: record.active.startedAt || null,
      }));
  }

  // Remember a Run that just left the slot so the slot keeps a light trail of
  // what it did; the session binding itself is untouched.
  function recordRunEnded(record, active, outcome = null) {
    if (!active?.runId) return;
    if (!Array.isArray(record.history)) record.history = [];
    if (record.history.some((entry) => entry?.runId === active.runId)) return;
    record.history.push({
      runId: active.runId,
      tool: active.tool || null,
      traceId: active.traceId || null,
      sessionId: active.sessionId || record.canonicalSessionId || null,
      profile: profileOrDefault(active.profile || record.profile),
      startedAt: active.startedAt || null,
      endedAt: new Date().toISOString(),
      outcome: outcome ? String(outcome).toLowerCase() : null,
    });
    if (record.history.length > SLOT_HISTORY_LIMIT) {
      record.history.splice(0, record.history.length - SLOT_HISTORY_LIMIT);
    }
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
      slot: slotOf(scope),
      canonicalSessionId: record?.canonicalSessionId || null,
      profile: profileOrDefault(record?.profile),
      active: activeSummary(record?.active),
      lastRun: lastRunSummary(record),
      archivedSessions: Array.isArray(record?.archivedSessions)
        ? record.archivedSessions.map((entry) => ({ ...entry }))
        : [],
    };
  }

  async function inspect(scope) {
    if (!scope?.tracked || !scope.sessionHash) {
      return {
        tracked: false,
        sessionHash: null,
        slot: slotOf(scope),
        canonicalSessionId: null,
        profile: DEFAULT_PROFILE,
        active: null,
        lastRun: null,
        archivedSessions: [],
      };
    }
    return withStateTransaction(async () =>
      snapshot(scope, peekRecord(scope) || emptySlotRecord()),
    );
  }

  // Every slot this conversation has used, in slot order.
  async function inspectConversation(scope) {
    if (!scope?.tracked || !scope.sessionHash) {
      return { tracked: false, sessionHash: null, maxSlots: MAX_SLOTS, slots: [] };
    }
    return withStateTransaction(async () => ({
      tracked: true,
      sessionHash: scope.sessionHash,
      maxSlots: MAX_SLOTS,
      slots: slotEntries(scope.sessionHash).map(([slot, record]) => ({
        ...snapshot({ ...scope, slot }, record),
        updatedAt: record.updatedAt || null,
      })),
    }));
  }

  async function findSlotForRun(scope, runId) {
    if (!scope?.tracked || !scope.sessionHash || !runId) return null;
    return withStateTransaction(async () => {
      for (const [slot, record] of slotEntries(scope.sessionHash)) {
        if (record.active?.runId === runId) return slot;
      }
      return null;
    });
  }

  // Resolve which slot a tool call addresses: an explicit slot wins, then the
  // slot whose active Run matches runId, then the default slot.
  async function scopeForSlot(scope, { slot = null, runId = null } = {}) {
    const explicit = normalizeSlot(slot);
    if (explicit) return { ...scope, slot: explicit };
    const found = await findSlotForRun(scope, runId);
    return { ...scope, slot: found || DEFAULT_SLOT };
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
      replaceSession = false,
      profile = null,
    },
  ) {
    const requestedProfile = normalizeProfile(profile);
    const requested =
      typeof requestedSessionId === "string" && requestedSessionId.trim()
        ? requestedSessionId.trim()
        : null;
    const slot = slotOf(scope);

    const fingerprint =
      typeof instruction === "string" && instruction.trim()
        ? profileFingerprint(
            requestedProfile,
            slotFingerprint(slot, currentFingerprint(mode, requested, instruction)),
          )
        : null;
    // Pre-slot (v1) state only ever described the default slot.
    const legacyFingerprint =
      slot === DEFAULT_SLOT &&
      !requestedProfile &&
      typeof instruction === "string" &&
      instruction.trim()
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
        slot,
        profile: requestedProfile || DEFAULT_PROFILE,
        parallelRuns: [],
      };
    }

    let reconcileTarget = null;
    if (typeof reconcileActive === "function") {
      reconcileTarget = await withStateTransaction(async () => {
        const record = peekRecord(scope);
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
      const record = getRecord(scope);
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
              slot: slotOf(scope),
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

          recordRunEnded(
            record,
            currentActive,
            reconciled.status ||
              (reconciled.runMissing ? "missing" : null),
          );

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
          profile: profileOrDefault(recent.payload?.profile || record.profile),
          replayPayload: {
            ...recent.payload,
            deduplicated: true,
            duplicateOfTraceId: recent.traceId || null,
            dedupWindowMs: replayWindowMs,
          },
          idempotencyKey: null,
          slot,
          parallelRuns: [],
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
          slot,
          profile: profileOrDefault(active.profile),
          parallelRuns: parallelRunsFor(scope),
        };
      }

      if (active?.kind === "native-session-unresolved") {
        throw coordinatorError(
          "HERMES_NATIVE_SESSION_UNRESOLVED",
          "Hermes completed the previous sessionless Run without returning a durable sessionId. Exact retries can replay the completed result, but different work is blocked until Hermes exposes the durable session binding.",
          {
            sessionHash: scope.sessionHash,
            slot: slotOf(scope),
            active: activeSummary(active),
          },
        );
      }

      if (active && !recoverablePending) {
        throw coordinatorError(
          "HERMES_SESSION_BUSY",
          "Another Hermes Run is already active for this ChatGPT conversation" +
            (slot === DEFAULT_SLOT ? "." : " in slot " + slot + ".") +
            " Keep polling it with get_hermes_run, or use a free slot only for genuinely independent work.",
          {
            sessionHash: scope.sessionHash,
            slot: slotOf(scope),
            active: activeSummary(active),
            freeSlots: freeSlotsFor(scope),
          },
        );
      }

      // A durable Hermes session belongs to one slot of one conversation:
      // two bindings would interleave unrelated work in the same context, and
      // a session accepts one Run at a time anyway. A session in use elsewhere
      // is always refused; an idle one bound elsewhere moves here only on an
      // explicit replaceSession. Older state may already share an idle
      // canonical session between conversations; that binding keeps working.
      // A slot's Hermes session lives in one profile. An unbound slot takes
      // whichever profile is asked for; a bound one changes profile only on
      // an explicit replaceSession, which archives the old binding.
      const boundProfile = profileOrDefault(record.profile);
      const effectiveProfile = recoverablePending
        ? profileOrDefault(active?.profile)
        : requestedProfile || boundProfile;
      if (
        !recoverablePending &&
        requestedProfile &&
        requestedProfile !== boundProfile &&
        record.canonicalSessionId &&
        !replaceSession
      ) {
        throw coordinatorError(
          "HERMES_PROFILE_MISMATCH",
          "Slot " +
            slot +
            " of this ChatGPT conversation is bound to a Hermes session of profile '" +
            boundProfile +
            "'. Use a free slot for the '" +
            requestedProfile +
            "' profile, or pass replaceSession:true to start a fresh '" +
            requestedProfile +
            "' session in this slot.",
          {
            sessionHash: scope.sessionHash,
            slot,
            boundProfile,
            requestedProfile,
            canonicalSessionId: record.canonicalSessionId,
            freeSlots: freeSlotsFor(scope).filter(
              (free) =>
                free !== slot &&
                !peekRecord({ ...scope, slot: free })?.canonicalSessionId,
            ),
          },
        );
      }

      const targetSessionId =
        requested || (replaceSession ? null : record.canonicalSessionId) || null;
      const holder = targetSessionId
        ? findSessionHolder(scope, targetSessionId, effectiveProfile)
        : null;
      const newBinding =
        Boolean(holder) && targetSessionId !== record.canonicalSessionId;
      if (holder && (holder.busy || (newBinding && !replaceSession))) {
        throw coordinatorError(
          holder.sameConversation
            ? "HERMES_SESSION_BOUND_TO_OTHER_SLOT"
            : "HERMES_SESSION_BOUND_TO_OTHER_CONVERSATION",
          (holder.sameConversation
            ? "This Hermes sessionId is bound to slot " +
              holder.slot +
              " of this ChatGPT conversation"
            : "This Hermes sessionId is bound to another ChatGPT conversation") +
            (holder.busy
              ? ", which is running work in it right now."
              : ". Pass replaceSession:true to move it here, or start a new session."),
          {
            sessionHash: scope.sessionHash,
            slot,
            requestedSessionId: targetSessionId,
            busy: holder.busy,
            ...(holder.sameConversation ? { boundSlot: holder.slot } : {}),
          },
        );
      }

      // Replacing a slot's session only archives the binding: the Hermes
      // session and its history stay untouched and can be resumed later.
      let replacedSessionId =
        recoverablePending ? active?.replacedSessionId || null : null;
      if (
        replaceSession &&
        record.canonicalSessionId &&
        record.canonicalSessionId !== requested
      ) {
        replacedSessionId = record.canonicalSessionId;
        record.archivedSessions.push({
          sessionId: record.canonicalSessionId,
          profile: boundProfile,
          archivedAt: new Date().toISOString(),
          reason: "replaced",
          lastRunId: lastRunSummary(record)?.runId || null,
        });
        record.canonicalSessionId = null;
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
            slot: slotOf(scope),
            canonicalSessionId: record.canonicalSessionId,
            requestedSessionId: requested,
          },
        );
      }

      let movedFrom = recoverablePending ? active?.movedFrom || null : null;
      if (holder && newBinding) {
        holder.record.archivedSessions.push({
          sessionId: targetSessionId,
          profile: effectiveProfile,
          archivedAt: new Date().toISOString(),
          reason: holder.sameConversation
            ? "moved-to-slot-" + slot
            : "moved-to-other-conversation",
          lastRunId: lastRunSummary(holder.record)?.runId || null,
        });
        holder.record.canonicalSessionId = null;
        holder.record.updatedAt = new Date().toISOString();
        movedFrom = { sessionHash: holder.sessionHash, slot: holder.slot };
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

      const previousProfile = recoverablePending
        ? active?.previousProfile ?? null
        : record.profile ?? null;
      record.profile = effectiveProfile;
      record.active = {
        operationId,
        tool,
        kind: "native-pending",
        profile: effectiveProfile,
        previousProfile,
        traceId,
        startedAt: new Date().toISOString(),
        sessionId: requested || record.canonicalSessionId || null,
        runId: null,
        fingerprint,
        ownerInstanceId: instanceId,
        idempotencyKey,
        reusedSession,
        ...(replacedSessionId ? { replacedSessionId } : {}),
        ...(movedFrom ? { movedFrom } : {}),
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
        slot,
        profile: effectiveProfile,
        parallelRuns: parallelRunsFor(scope),
        replacedSessionId,
        movedFrom,
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
      const record = getRecord(scope);
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
            slot: slotOf(scope),
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
      } else {
        recordRunEnded(
          record,
          { ...active, runId: runId || active.runId || null },
          payload?.status || null,
        );
        if (
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
      const record = getRecord(scope);
      if (record.active?.operationId === operationId) {
        // Nothing reached Hermes, so an explicit replacement never happened:
        // put the previous binding, and the profile it lives in, back.
        if (Object.hasOwn(record.active, "previousProfile")) {
          record.profile = record.active.previousProfile;
        }
        const replaced = record.active.replacedSessionId || null;
        if (replaced && !record.canonicalSessionId) {
          record.canonicalSessionId = replaced;
          const index = record.archivedSessions.findLastIndex(
            (entry) => entry?.sessionId === replaced,
          );
          if (index >= 0) record.archivedSessions.splice(index, 1);
        }
        // Likewise, a session moved here from another slot goes back.
        const movedFrom = record.active.movedFrom || null;
        const source = movedFrom
          ? state.conversations[movedFrom.sessionHash]?.slots?.[
              String(movedFrom.slot)
            ]
          : null;
        const movedSessionId = record.active.sessionId || null;
        if (
          isPlainObject(source) &&
          movedSessionId &&
          !source.canonicalSessionId &&
          !source.active
        ) {
          source.canonicalSessionId = movedSessionId;
          const index = (source.archivedSessions || []).findLastIndex(
            (entry) => entry?.sessionId === movedSessionId,
          );
          if (index >= 0) source.archivedSessions.splice(index, 1);
          source.updatedAt = new Date().toISOString();
        }
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
      const record = getRecord(scope);
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
      const record = getRecord(scope);
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
      status = null,
    },
  ) {
    if (!scope?.tracked || !scope.sessionHash) return;

    return withStateTransaction(async () => {
      const record = getRecord(scope);
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
            slot: slotOf(scope),
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

        recordRunEnded(
          record,
          active,
          status || replayPayload?.status || null,
        );

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
      const record = getRecord(scope);
      if (record.active?.kind === "run" && record.active.runId === runId) {
        return snapshot(scope, record);
      }
      throw coordinatorError(
        "HERMES_RUN_MISMATCH",
        "The requested runId is not the active Hermes Run for this ChatGPT conversation.",
        {
          sessionHash: scope.sessionHash,
          slot: slotOf(scope),
          requestedRunId: runId,
          active: activeSummary(record.active),
        },
      );
    });
  }

  return {
    scopeFromMeta,
    scopeForSlot,
    inspect,
    inspectConversation,
    findSlotForRun,
    begin,
    complete,
    fail,
    preserveSubmittedRun,
    markSubmissionUnknown,
    observe,
    assertActiveRun,
  };
}
