import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

const DEFAULT_DEDUP_WINDOW_MS = 60000;
const DEFAULT_ACTIVITY_LIMIT = 50;
const MAX_ACTIVITY_LIMIT = 200;
const INSTRUCTION_PREVIEW_MAX = 240;

const TOOL_PURPOSE = {
  delegate_to_hermes: "new-mission",
  continue_with_hermes: "continue-existing-context",
  list_hermes_sessions: "list-native-sessions",
  get_hermes_session: "read-native-session",
  continue_hermes_session: "continue-native-session",
  get_hermes_task: "read-task-state",
  cancel_hermes_task: "cancel-task",
  hermes_status: "health-check",
  hermes_activity: "read-local-activity",
};

function normalizeInstruction(value) {
  return String(value).normalize("NFKC").trim().replace(/\s+/gu, " ");
}

function configuredPositiveNumber(value, fallback, minimum = 1) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= minimum ? parsed : fallback;
}

export function createHermesObservability({
  root,
  redactText,
  redactValue,
  randomUUID,
}) {
  const runtimeDir = path.join(root, ".runtime");
  const activityLog =
    process.env.HERMES_ACTIVITY_LOG ||
    path.join(runtimeDir, "hermes-activity.jsonl");
  const dedupWindowMs = configuredPositiveNumber(
    process.env.HERMES_DEDUP_WINDOW_MS,
    DEFAULT_DEDUP_WINDOW_MS,
    1000,
  );

  let activityWriteChain = Promise.resolve();
  const recentActivity = [];
  const delegationCache = new Map();
  const sessionContinuationCache = new Map();

  function instructionHash(value) {
    if (typeof value !== "string" || value.trim() === "") return null;
    return createHash("sha256")
      .update(normalizeInstruction(value), "utf8")
      .digest("hex");
  }

  function instructionPreview(value) {
    if (typeof value !== "string" || value.trim() === "") return null;
    const safe = redactText(normalizeInstruction(value));
    return safe.length > INSTRUCTION_PREVIEW_MAX
      ? safe.slice(0, INSTRUCTION_PREVIEW_MAX) + "…"
      : safe;
  }

  function beginTrace(tool, args) {
    const startedAtMs = Date.now();
    return {
      traceId: randomUUID(),
      startedAt: new Date(startedAtMs).toISOString(),
      startedAtMs,
      tool,
      purpose: TOOL_PURPOSE[tool] || "unknown",
      instructionHash: instructionHash(args?.instruction),
      instructionPreview: instructionPreview(args?.instruction),
      inputContextId:
        typeof args?.contextId === "string" ? args.contextId : null,
      inputTaskId: typeof args?.taskId === "string" ? args.taskId : null,
      inputSessionId:
        typeof args?.sessionId === "string" ? args.sessionId : null,
      background: args?.background === true,
    };
  }

  function finishTrace(base, payload, error) {
    const endedAtMs = Date.now();
    return {
      traceId: base.traceId,
      startedAt: base.startedAt,
      endedAt: new Date(endedAtMs).toISOString(),
      durationMs: Math.max(0, endedAtMs - base.startedAtMs),
      tool: base.tool,
      purpose: base.purpose,
      instructionHash: base.instructionHash,
      instructionPreview: base.instructionPreview,
      inputContextId: base.inputContextId,
      inputTaskId: base.inputTaskId,
      outputContextId:
        payload && typeof payload.contextId === "string"
          ? payload.contextId
          : null,
      outputTaskId:
        payload && typeof payload.taskId === "string" ? payload.taskId : null,
      inputSessionId: base.inputSessionId,
      outputSessionId:
        payload && typeof payload.sessionId === "string"
          ? payload.sessionId
          : null,
      state: payload?.state ?? null,
      stateName: payload?.stateName ?? null,
      ok: !error && payload?.ok !== false,
      error: error
        ? { message: redactText(error instanceof Error ? error.message : String(error)) }
        : payload?.error
          ? redactValue(payload.error)
          : null,
      deduplicated: payload?.deduplicated === true,
      duplicateOfTraceId: payload?.duplicateOfTraceId || null,
      background: base.background,
    };
  }

  async function appendTrace(record) {
    const safeRecord = redactValue(record);
    recentActivity.push(safeRecord);
    if (recentActivity.length > MAX_ACTIVITY_LIMIT) recentActivity.shift();

    const line = JSON.stringify(safeRecord) + "\n";
    activityWriteChain = activityWriteChain
      .catch(() => {})
      .then(async () => {
        await fs.mkdir(path.dirname(activityLog), {
          recursive: true,
          mode: 0o700,
        });
        await fs.appendFile(activityLog, line, {
          encoding: "utf8",
          mode: 0o600,
        });
        await fs.chmod(activityLog, 0o600).catch(() => {});
      });

    try {
      await activityWriteChain;
    } catch (error) {
      process.stderr.write(
        "[hermes-activity] failed to persist trace " +
          record.traceId +
          ": " +
          redactText(error instanceof Error ? error.message : String(error)) +
          "\n",
      );
    }
  }

  async function flush() {
    try {
      await activityWriteChain;
    } catch {}
  }

  function parseSince(value) {
    if (value === undefined) return null;
    if (typeof value !== "string" || value.trim() === "") {
      throw new Error("since must be a non-empty ISO-8601 timestamp");
    }
    const parsed = Date.parse(value);
    if (!Number.isFinite(parsed)) {
      throw new Error("since must be a valid ISO-8601 timestamp");
    }
    return parsed;
  }

  async function loadActivityRecords() {
    try {
      const raw = await fs.readFile(activityLog, "utf8");
      return raw
        .split("\n")
        .filter(Boolean)
        .map((line) => {
          try {
            return JSON.parse(line);
          } catch {
            return null;
          }
        })
        .filter(Boolean);
    } catch (error) {
      if (error?.code === "ENOENT") return [...recentActivity];
      throw error;
    }
  }

  async function readActivity(args = {}) {
    const limit =
      args.limit === undefined ? DEFAULT_ACTIVITY_LIMIT : args.limit;
    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_ACTIVITY_LIMIT) {
      throw new Error(
        "limit must be an integer between 1 and " + MAX_ACTIVITY_LIMIT,
      );
    }

    const sinceMs = parseSince(args.since);
    const tool =
      typeof args.tool === "string" && args.tool.trim() ? args.tool : null;
    const records = await loadActivityRecords();

    const filtered = records.filter((record) => {
      if (tool && record.tool !== tool) return false;
      if (args.deduplicatedOnly === true && record.deduplicated !== true) {
        return false;
      }
      if (args.errorsOnly === true && record.ok !== false) return false;
      if (sinceMs !== null) {
        const startedAtMs = Date.parse(record.startedAt);
        if (!Number.isFinite(startedAtMs) || startedAtMs < sinceMs) {
          return false;
        }
      }
      return true;
    });

    const selected = filtered.slice(-limit).reverse();
    return {
      ok: true,
      operation: "hermes_activity",
      agent: "hermes",
      source: activityLog,
      count: selected.length,
      totalMatching: filtered.length,
      deduplicatedCount: selected.filter(
        (record) => record.deduplicated === true,
      ).length,
      errorCount: selected.filter((record) => record.ok === false).length,
      dedupWindowMs,
      records: selected,
      deduplicated: false,
    };
  }

  function pruneCache(cache, now = Date.now()) {
    for (const [key, entry] of cache.entries()) {
      if (
        entry.settledAtMs !== null &&
        now - entry.settledAtMs > dedupWindowMs
      ) {
        cache.delete(key);
      }
    }
  }

  function wrapDelegate(executeDelegate) {
    return async function deduplicatedDelegate(
      instruction,
      background = false,
      traceId = null,
    ) {
      const hash = instructionHash(instruction);
      const now = Date.now();
      pruneCache(delegationCache, now);

      const existing = delegationCache.get(hash);
      const reusable =
        existing &&
        (existing.settledAtMs === null ||
          now - existing.settledAtMs <= dedupWindowMs);

      if (reusable) {
        try {
          const result = await existing.promise;
          return {
            ...result,
            deduplicated: true,
            duplicateOfTraceId: existing.traceId,
            dedupWindowMs,
          };
        } catch (error) {
          if (error && typeof error === "object") {
            error.deduplicated = true;
            error.duplicateOfTraceId = existing.traceId;
          }
          throw error;
        }
      }

      const promise = executeDelegate(instruction, background);
      const entry = {
        traceId,
        createdAtMs: now,
        settledAtMs: null,
        promise,
      };
      delegationCache.set(hash, entry);

      try {
        const result = await promise;
        entry.settledAtMs = Date.now();
        entry.promise = Promise.resolve(result);
        return {
          ...result,
          deduplicated: false,
          duplicateOfTraceId: null,
          dedupWindowMs,
        };
      } catch (error) {
        if (delegationCache.get(hash) === entry) {
          delegationCache.delete(hash);
        }
        throw error;
      }
    };
  }

  function wrapSessionContinue(executeContinue) {
    return async function deduplicatedSessionContinue(
      sessionId,
      instruction,
      traceId = null,
    ) {
      const hash = instructionHash(instruction);
      const key = String(sessionId) + ":" + hash;
      const now = Date.now();
      pruneCache(sessionContinuationCache, now);

      const existing = sessionContinuationCache.get(key);
      const reusable =
        existing &&
        (existing.settledAtMs === null ||
          now - existing.settledAtMs <= dedupWindowMs);

      if (reusable) {
        try {
          const result = await existing.promise;
          return {
            ...result,
            deduplicated: true,
            duplicateOfTraceId: existing.traceId,
            dedupWindowMs,
          };
        } catch (error) {
          if (error && typeof error === "object") {
            error.deduplicated = true;
            error.duplicateOfTraceId = existing.traceId;
          }
          throw error;
        }
      }

      const promise = executeContinue(sessionId, instruction);
      const entry = {
        traceId,
        createdAtMs: now,
        settledAtMs: null,
        promise,
      };
      sessionContinuationCache.set(key, entry);

      try {
        const result = await promise;
        entry.settledAtMs = Date.now();
        entry.promise = Promise.resolve(result);
        return {
          ...result,
          deduplicated: false,
          duplicateOfTraceId: null,
          dedupWindowMs,
        };
      } catch (error) {
        if (sessionContinuationCache.get(key) === entry) {
          sessionContinuationCache.delete(key);
        }
        throw error;
      }
    };
  }

  return {
    activityLog,
    dedupWindowMs,
    beginTrace,
    finishTrace,
    appendTrace,
    flush,
    readActivity,
    wrapDelegate,
    wrapSessionContinue,
  };
}
