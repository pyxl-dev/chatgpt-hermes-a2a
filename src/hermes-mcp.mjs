#!/usr/bin/env node

import { randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

import { createHermesControl } from "./hermes-control.mjs";
import { createHermesObservability } from "./hermes-observability.mjs";
import {
  MAX_SLOTS,
  createHermesSessionCoordinator,
} from "./hermes-session-coordinator.mjs";
import { createHermesSessionAccess } from "./hermes-sessions.mjs";
import { createRunNotifierFromEnv } from "./hermes-run-notifier.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const AGENT = "hermes";
const configuredNativeDelegateTimeout = Number(
  process.env.HERMES_NATIVE_DELEGATE_TIMEOUT_MS,
);
const MAX_NATIVE_DELEGATE_WAIT_MS = 90000;
const NATIVE_DELEGATE_TIMEOUT_MS =
  Number.isFinite(configuredNativeDelegateTimeout) &&
  configuredNativeDelegateTimeout >= 1000
    ? Math.min(configuredNativeDelegateTimeout, MAX_NATIVE_DELEGATE_WAIT_MS)
    : MAX_NATIVE_DELEGATE_WAIT_MS;
const configuredNativePollMs = Number(
  process.env.HERMES_NATIVE_DELEGATE_POLL_MS,
);
const NATIVE_DELEGATE_POLL_MS =
  Number.isFinite(configuredNativePollMs) && configuredNativePollMs >= 100
    ? configuredNativePollMs
    : 750;
const configuredNativeRunPollWaitMs = Number(
  process.env.HERMES_NATIVE_RUN_POLL_WAIT_MS,
);
const MAX_NATIVE_RUN_POLL_WAIT_MS = 55000;
// A single get_hermes_run call holds the Run open for this long before handing
// back a nonterminal status, so one assistant turn can sit on the Run instead of
// spending a fresh model decision between every poll.
const NATIVE_RUN_POLL_WAIT_MS =
  Number.isFinite(configuredNativeRunPollWaitMs) &&
  configuredNativeRunPollWaitMs >= 0
    ? Math.min(configuredNativeRunPollWaitMs, MAX_NATIVE_DELEGATE_WAIT_MS)
    : MAX_NATIVE_RUN_POLL_WAIT_MS;

const SERVER_INSTRUCTIONS = [
  "Hermes runs real work on the user's Mac; a Run can outlive a single ChatGPT turn.",
  "Delegation protocol: when delegate_to_hermes, continue_hermes_session or start_hermes_run answers pending:true, keep calling get_hermes_run in the SAME turn until the Run reaches a terminal status.",
  "get_hermes_run holds the call open for up to 55 seconds on its own, so call it again immediately after each nonterminal result. Do not narrate the wait, do not ask the user whether to keep checking, and do not end the turn while a Run is still running.",
  "get_hermes_run accepts no runId: it then reads the Run currently bound to this conversation, which is what a later user follow-up needs.",
  "Slots: one conversation can drive up to " + MAX_SLOTS + " durable Hermes sessions (slot 1 to " + MAX_SLOTS + "), each with at most one Run, so up to " + MAX_SLOTS + " Runs can work in parallel. Omit slot for normal work: it uses slot 1.",
  "Use slot 2 or 3 only when the user explicitly asks for parallel work, or for a genuinely independent task that must not wait for the busy slot; never split one task across slots, and keep parallel slots on disjoint files because every slot shares the same Mac workspace.",
  "A slot keeps its Hermes session and context after its Run ends: send follow-ups for that line of work to the same slot. Pass replaceSession:true only when the user wants that slot to start a fresh Hermes session; the old one is archived, never deleted.",
  "With several slots running, call get_hermes_run with no arguments: it waits on every active slot at once and returns each slot's Run; keep calling it in the same turn until no slot is pending. A busy slot answers HERMES_SESSION_BUSY: poll it instead of resubmitting.",
  "Stop polling only when the Run is terminal, when the user asks you to stop, or after roughly 20 minutes of continuous waiting; then report the runId, the status and anything that needs the user's decision.",
  "Read tools never mutate the user's machine and need no confirmation.",
].join(" ");

function redactText(value) {
  let text = String(value);
  for (const key of [
    "CONTROL_PLANE_API_KEY",
    "OPENAI_API_KEY",
    "API_SERVER_KEY",
    "HERMES_API_SERVER_KEY",
    "HERMES_A2A_DISCORD_WEBHOOK_URL",
  ]) {
    const secret = process.env[key];
    if (secret) text = text.split(secret).join("[REDACTED]");
  }
  return text
    .replace(/(Bearer\s+)[^\s"'\x60]+/gi, "$1[REDACTED]")
    .replace(/(Basic\s+)[^\s"'\x60]+/gi, "$1[REDACTED]")
    .replace(
      /((?:token|secret|password|api[_-]?key)\s*[=:]\s*)[^\s,}"']+/gi,
      "$1[REDACTED]",
    );
}

function redactValue(value) {
  if (typeof value === "string") return redactText(value);
  if (Array.isArray(value)) return value.map(redactValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, child]) => {
        const sensitiveKey =
          /(?:authorization|credential|token|secret|password|api[_-]?key)/i.test(
            key,
          );
        return [key, sensitiveKey ? "[REDACTED]" : redactValue(child)];
      }),
    );
  }
  return value;
}

function errorMessage(error) {
  return redactText(error instanceof Error ? error.message : String(error));
}

function publicError(error) {
  return {
    message: errorMessage(error),
    ...(typeof error?.code === "string" ? { code: error.code } : {}),
    ...(error?.details ? { details: redactValue(error.details) } : {}),
  };
}

function codedError(code, message, details = null) {
  const error = new Error(message);
  error.code = code;
  if (details) error.details = details;
  return error;
}

function requireObject(value) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value
    : {};
}

function requireString(args, key) {
  const value = args[key];
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(key + " must be a non-empty string");
  }
  return value.trim();
}

function optionalString(args, key) {
  const value = args[key];
  return typeof value === "string" && value.trim() !== ""
    ? value.trim()
    : null;
}

function cleanHermesText(value) {
  const text = String(value || "").trim();
  return text
    .replace(
      /^💭\s*\*\*Reasoning:\*\*\s*(?:\n\x60\x60\x60[\s\S]*?\x60\x60\x60\s*)?/u,
      "",
    )
    .trim();
}

const observability = createHermesObservability({
  root: ROOT,
  redactText,
  redactValue,
  randomUUID,
});

const control = createHermesControl({
  redactText,
  redactValue,
});

const sessionAccess = createHermesSessionAccess({
  root: ROOT,
  redactText,
  randomUUID,
});

const sessionCoordinator = createHermesSessionCoordinator({
  root: ROOT,
  randomUUID,
});

const runNotifier = createRunNotifierFromEnv({
  getRun: (runId) => control.getRun(runId),
  onError: (error, runId) =>
    console.error(
      "Run-finished notifier error for " + runId + ": " + errorMessage(error),
    ),
});

// Every tool answer that carries a runId tells the notifier whether ChatGPT
// still has to come back for that Run (watch) or already holds its outcome
// (settle).
const RUN_TOOLS = new Set([
  "delegate_to_hermes",
  "continue_hermes_session",
  "start_hermes_run",
  "get_hermes_run",
  "steer_hermes_run",
  "stop_hermes_run",
]);

function trackRunForNotification(name, args, payload, failure) {
  if (!runNotifier.enabled || !RUN_TOOLS.has(name)) return;
  if (name === "stop_hermes_run") {
    if (!failure) runNotifier.settle(optionalString(args, "runId"));
    return;
  }
  if (failure) {
    if (failure?.code === "HERMES_NATIVE_RUN_FAILED") {
      runNotifier.settle(failure.details?.runId || null);
    }
    return;
  }
  // get_hermes_run over several slots answers one entry per slot's Run.
  const runs = Array.isArray(payload?.runs) ? payload.runs : [payload];
  for (const run of runs) {
    const runId = typeof run?.runId === "string" ? run.runId : null;
    if (!runId) continue;
    if (runIsTerminal(run)) {
      runNotifier.settle(runId);
    } else if (run.pending === true || run.status) {
      runNotifier.watch(runId, {
        instruction:
          typeof args.instruction === "string" ? args.instruction : null,
        slot: Number.isInteger(run.slot) ? run.slot : null,
      });
    }
  }
}

const SLOT_PROPERTY = {
  type: "integer",
  minimum: 1,
  maximum: MAX_SLOTS,
  description:
    "Optional Hermes slot of this conversation (1-" +
    MAX_SLOTS +
    "). Defaults to 1. Use 2 or 3 only for parallel, independent work.",
};

const REPLACE_SESSION_PROPERTY = {
  type: "boolean",
  default: false,
  description:
    "Start this slot on a fresh Hermes session (or on the given sessionId) and archive its previous session binding. Only when the user asks for a fresh context; the slot must be idle.",
};

const TOOLS = [
  {
    name: "delegate_to_hermes",
    description:
      "Run ordinary Hermes work in the durable native Hermes session bound to this ChatGPT conversation's slot (slot 1 unless slot is given). Uses Hermes' authenticated Runs API, allows one Run per slot, and automatically reuses the slot's durable sessionId on later turns. Waits up to 90 seconds; if Hermes is still running, returns the existing runId/status so get_hermes_run can continue polling. An exact retry reuses the same active Run instead of starting duplicate work.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        instruction: {
          type: "string",
          minLength: 1,
          description:
            "The complete task for Hermes. Include exact paths, constraints, expected result, and anything Hermes must not change.",
        },
        slot: SLOT_PROPERTY,
        replaceSession: REPLACE_SESSION_PROPERTY,
      },
      required: ["instruction"],
    },
  },
  {
    name: "list_hermes_sessions",
    annotations: {
      readOnlyHint: true,
      openWorldHint: false,
    },
    description:
      "List recent persisted Hermes conversations using Hermes' native sessions list command.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        limit: { type: "integer", minimum: 1, maximum: 200, default: 50 },
        source: { type: "string", minLength: 1 },
        workspace: { type: "string", minLength: 1 },
      },
    },
  },
  {
    name: "get_hermes_session",
    annotations: {
      readOnlyHint: true,
      openWorldHint: false,
    },
    description:
      "Read a persisted Hermes conversation by durable sessionId using Hermes' native redacted session export.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        sessionId: { type: "string", minLength: 1 },
        limit: { type: "integer", minimum: 0, maximum: 200, default: 50 },
        includeTools: { type: "boolean", default: false },
      },
      required: ["sessionId"],
    },
  },
  {
    name: "continue_hermes_session",
    description:
      "Continue an explicitly chosen durable Hermes session through the authenticated Runs API. The wrapper rejects a different session once the addressed slot (slot 1 by default) has a canonical Hermes session, unless replaceSession is true, and never binds one session to two slots. Long work hands back the active runId after at most 90 seconds for polling, and exact retries reuse that Run.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        sessionId: { type: "string", minLength: 1 },
        instruction: { type: "string", minLength: 1 },
        slot: SLOT_PROPERTY,
        replaceSession: REPLACE_SESSION_PROPERTY,
      },
      required: ["sessionId", "instruction"],
    },
  },
  {
    name: "start_hermes_run",
    description:
      "Start the single controllable Hermes Run allowed for this conversation's slot (slot 1 unless slot is given) and return its runId. Reuses the slot's canonical durable session when known; an exact retry while that Run is still active returns the same runId instead of failing busy or submitting duplicate work.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        instruction: { type: "string", minLength: 1 },
        sessionId: { type: "string", minLength: 1 },
        slot: SLOT_PROPERTY,
        replaceSession: REPLACE_SESSION_PROPERTY,
      },
      required: ["instruction"],
    },
  },
  {
    name: "get_hermes_run",
    description:
      "Read the status/result of a Hermes Run by runId and reconcile coordinator state when it is the active Run. Holds the call open for up to 55 seconds while the Run is still running, so call it again immediately instead of ending the turn between polls. Omit runId to read the Run currently bound to this conversation; with several slots running and no slot given, waits on every active slot and returns each slot's Run.",
    annotations: {
      readOnlyHint: true,
      openWorldHint: false,
    },
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        runId: {
          type: "string",
          minLength: 1,
          description:
            "Optional. Defaults to the Run currently bound to this conversation.",
        },
        slot: SLOT_PROPERTY,
      },
    },
  },
  {
    name: "steer_hermes_run",
    description:
      "Queue course-correction guidance into the active Hermes Run. Requires the exact active runId of one of this conversation's slots for tracked ChatGPT conversations.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        runId: { type: "string", minLength: 1 },
        instruction: { type: "string", minLength: 1 },
        slot: SLOT_PROPERTY,
      },
      required: ["runId", "instruction"],
    },
  },
  {
    name: "stop_hermes_run",
    description:
      "Request a cooperative stop for the active Hermes Run. Poll get_hermes_run until it reaches a terminal state if the stop response is nonterminal.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        runId: { type: "string", minLength: 1 },
        slot: SLOT_PROPERTY,
      },
      required: ["runId"],
    },
  },
  {
    name: "hermes_status",
    annotations: {
      readOnlyHint: true,
      openWorldHint: false,
    },
    description:
      "Check the authenticated Hermes native Runs API capabilities used by this bridge.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {},
    },
  },
  {
    name: "hermes_activity",
    annotations: {
      readOnlyHint: true,
      openWorldHint: false,
    },
    description:
      "Read recent redacted local bridge activity traces without contacting Hermes.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        limit: { type: "integer", minimum: 1, maximum: 200, default: 50 },
        tool: {
          type: "string",
          enum: [
            "delegate_to_hermes",
            "list_hermes_sessions",
            "get_hermes_session",
            "continue_hermes_session",
            "start_hermes_run",
            "get_hermes_run",
            "steer_hermes_run",
            "stop_hermes_run",
            "hermes_status",
            "hermes_activity",
            "hermes_tool_timeline",
          ],
        },
        since: { type: "string" },
        deduplicatedOnly: { type: "boolean", default: false },
        errorsOnly: { type: "boolean", default: false },
      },
    },
  },
  {
    name: "hermes_tool_timeline",
    annotations: {
      readOnlyHint: true,
      openWorldHint: false,
    },
    description:
      "Read a session-scoped, content-free tool timeline (tool name, start/end, duration, ok/error kind, call state) for one persisted Hermes session. sessionId selects the session directly; runId only locates that session (the coordinator's active run, then the run-bound session id) and never narrows the entries to one run. It never returns tool arguments, tool results, prompts, assistant text or reasoning, and it never contacts the network.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        sessionId: {
          type: "string",
          minLength: 1,
          description:
            "Durable Hermes session id. Optional when runId is supplied.",
        },
        runId: {
          type: "string",
          minLength: 1,
          description:
            "Hermes Run id used only to locate its session: the coordinator's active run is preferred, then the run-bound session id from GET /v1/runs/{id}.",
        },
        limit: { type: "integer", minimum: 1, maximum: 500, default: 100 },
        since: {
          type: "string",
          description: "ISO-8601 timestamp; keep entries ending at or after it.",
        },
        errorsOnly: { type: "boolean", default: false },
        tool: {
          type: "string",
          minLength: 1,
          description: "Keep entries for one exact tool name.",
        },
      },
    },
  },
];

function toolText(payload) {
  const safePayload = redactValue(payload);
  return {
    content: [{ type: "text", text: JSON.stringify(safePayload) }],
    structuredContent: safePayload,
  };
}

function toolError(
  error,
  operation = "unknown",
  traceId = null,
  metadata = {},
) {
  const payload = {
    ok: false,
    operation,
    agent: AGENT,
    ...(traceId ? { traceId } : {}),
    ...metadata,
    error: publicError(error),
  };
  return {
    isError: true,
    content: [{ type: "text", text: JSON.stringify(payload) }],
    structuredContent: payload,
  };
}

const TERMINAL_RUN_STATUSES = new Set([
  "completed",
  "failed",
  "cancelled",
  "canceled",
  "interrupted",
  "rejected",
]);

function runIsTerminal(result) {
  return TERMINAL_RUN_STATUSES.has(
    String(result?.status || "").toLowerCase(),
  );
}

function nativeRunSucceeded(result) {
  return (
    String(result?.status || "").toLowerCase() === "completed" &&
    !result?.error
  );
}

function requireNativeRunId(result, sessionScope) {
  if (typeof result?.runId === "string" && result.runId.trim()) {
    return result.runId.trim();
  }
  const error = codedError(
    "HERMES_NATIVE_RUN_ID_MISSING",
    "Hermes accepted native Run submission without returning a runId. Delivery may have succeeded, so tracked ChatGPT work remains locked for an exact idempotent retry.",
    {
      sessionHash: sessionScope?.sessionHash || null,
      slot: sessionScope?.slot ?? null,
    },
  );
  error.deliveryAmbiguous = true;
  throw error;
}

function nativeRunNotFoundError(error) {
  return (
    error?.code === "run_not_found" ||
    (error?.status === 404 &&
      /run\s+not\s+found/iu.test(String(error?.message || "")))
  );
}

function nativeRunFailureError(result, runId, sessionScope) {
  return codedError(
    "HERMES_NATIVE_RUN_FAILED",
    "Hermes native Run reached an unsuccessful terminal state.",
    {
      sessionHash: sessionScope?.sessionHash || null,
      slot: sessionScope?.slot ?? null,
      runId,
      sessionId: result?.sessionId || null,
      status: result?.status || null,
      error: result?.error || null,
    },
  );
}

function nativeDelegateResult(started, completed, reusedSession) {
  const output = completed?.output ?? null;
  return {
    ...completed,
    ok: nativeRunSucceeded(completed),
    operation: "delegate_to_hermes",
    agent: AGENT,
    runId: completed?.runId || started?.runId || null,
    sessionId: completed?.sessionId || started?.sessionId || null,
    text:
      typeof output === "string"
        ? cleanHermesText(output) || null
        : null,
    nativeSession: true,
    continuedCanonicalSession: reusedSession === true,
    createdCanonicalSession:
      reusedSession !== true &&
      Boolean(completed?.sessionId || started?.sessionId),
  };
}

function nativeSessionContinuationResult(
  started,
  completed,
  requestedSessionId,
) {
  const output = completed?.output ?? null;
  return {
    ...completed,
    ok: nativeRunSucceeded(completed),
    operation: "continue_hermes_session",
    agent: AGENT,
    requestedSessionId,
    runId: completed?.runId || started?.runId || null,
    sessionId:
      completed?.sessionId ||
      started?.sessionId ||
      requestedSessionId ||
      null,
    text:
      typeof output === "string"
        ? cleanHermesText(output) || null
        : null,
    nativeSession: true,
  };
}

function nativePendingRunResult({
  operation,
  started = null,
  current = null,
  sessionId = null,
  requestedSessionId = null,
  deduplicated = false,
  duplicateOfTraceId = null,
  lastPollError = null,
}) {
  const source = current || started || {};
  return {
    ...source,
    ok: true,
    operation,
    agent: AGENT,
    runId: source?.runId || started?.runId || null,
    sessionId:
      source?.sessionId ||
      started?.sessionId ||
      sessionId ||
      requestedSessionId ||
      null,
    status: source?.status || started?.status || "running",
    nativeSession: true,
    pending: true,
    completed: false,
    handoffReason: "synchronous_wait_exhausted",
    pollWith: "get_hermes_run",
    nextAction:
      "Poll this runId with get_hermes_run. Do not resubmit or stop it merely because the synchronous wait ended.",
    ...(requestedSessionId ? { requestedSessionId } : {}),
    ...(deduplicated
      ? {
          deduplicated: true,
          duplicateOfTraceId: duplicateOfTraceId || null,
        }
      : {}),
    ...(lastPollError
      ? { lastPollError: errorMessage(lastPollError) }
      : {}),
  };
}

function recoveredNativeRunPayload(active, result) {
  if (!nativeRunSucceeded(result)) return null;
  if (active?.tool === "delegate_to_hermes") {
    return nativeDelegateResult(
      {
        runId: active.runId,
        sessionId: active.sessionId || null,
      },
      result,
      typeof active.reusedSession === "boolean"
        ? active.reusedSession
        : Boolean(active.sessionId),
    );
  }
  if (active?.tool === "continue_hermes_session") {
    return {
      ...nativeSessionContinuationResult(
        {
          runId: active.runId,
          sessionId: active.sessionId || null,
        },
        result,
        active.sessionId || result?.sessionId || null,
      ),
      recovered: true,
    };
  }
  if (active?.tool === "start_hermes_run") {
    return {
      ...result,
      operation: "start_hermes_run",
      recovered: true,
    };
  }
  return null;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForNativeRun(runId) {
  const deadline = Date.now() + NATIVE_DELEGATE_TIMEOUT_MS;
  let lastResult = null;
  let lastError = null;

  while (true) {
    const beforePoll = Date.now();
    const remainingBeforePoll = deadline - beforePoll;
    if (remainingBeforePoll <= 0) break;

    try {
      lastResult = await control.getRun(runId, {
        timeoutMs: remainingBeforePoll,
      });
      lastError = null;
      if (runIsTerminal(lastResult)) {
        return {
          terminal: true,
          result: lastResult,
          lastError: null,
        };
      }
    } catch (error) {
      if (error?.code === "HERMES_NATIVE_RUN_ID_MISMATCH") throw error;
      lastError = error;
    }

    const remainingBeforeSleep = deadline - Date.now();
    if (remainingBeforeSleep <= 0) break;
    await sleep(Math.min(NATIVE_DELEGATE_POLL_MS, remainingBeforeSleep));
  }

  return {
    terminal: false,
    result: lastResult,
    lastError,
  };
}

async function reconcileCoordinatorActive(active) {
  if (
    ["run", "native-session-unresolved"].includes(active?.kind) &&
    active.runId
  ) {
    try {
      const result = await control.getRun(active.runId);
      const terminal = runIsTerminal(result);
      return {
        terminal,
        status: result.status || null,
        sessionId: result.sessionId || active.sessionId || null,
        replayPayload:
          terminal ? recoveredNativeRunPayload(active, result) : null,
      };
    } catch (error) {
      if (nativeRunNotFoundError(error)) {
        if (active.kind === "native-session-unresolved") {
          return {
            terminal: false,
            sessionId: active.sessionId || null,
            replayPayload: null,
            runMissing: true,
            preserveUnresolved: true,
          };
        }
        return {
          terminal: true,
          sessionId: active.sessionId || null,
          replayPayload: null,
          runMissing: true,
        };
      }
      throw error;
    }
  }
  return { terminal: false };
}

async function reuseActiveNativeRun(
  operation,
  lease,
  requestedSessionId,
  sessionScope,
) {
  let current = null;
  let pollError = null;
  try {
    current = await control.getRun(lease.runId);
  } catch (error) {
    if (error?.code === "HERMES_NATIVE_RUN_ID_MISMATCH") throw error;
    if (nativeRunNotFoundError(error)) {
      await sessionCoordinator.observe(sessionScope, {
        kind: "run",
        id: lease.runId,
        terminal: true,
        sessionId: lease.sessionIdToUse || null,
        replayPayload: null,
        status: "missing",
      });
      throw codedError(
        "HERMES_NATIVE_RUN_NOT_FOUND_RECOVERED",
        "The previously active Hermes Run no longer exists. Its stale coordinator lease was cleared; retry the operation to start a fresh Run.",
        {
          sessionHash: sessionScope?.sessionHash || null,
          slot: sessionScope?.slot ?? null,
          runId: lease.runId,
        },
      );
    }
    pollError = error;
  }

  if (!current || !runIsTerminal(current)) {
    return nativePendingRunResult({
      operation,
      started: {
        runId: lease.runId,
        sessionId: lease.sessionIdToUse || null,
        status: "running",
      },
      current,
      sessionId: lease.sessionIdToUse || null,
      requestedSessionId,
      deduplicated: true,
      duplicateOfTraceId: lease.activeTraceId || null,
      lastPollError: pollError,
    });
  }

  if (!nativeRunSucceeded(current)) {
    await sessionCoordinator.observe(sessionScope, {
      kind: "run",
      id: lease.runId,
      terminal: true,
      sessionId: current.sessionId || lease.sessionIdToUse || null,
      replayPayload: null,
      status: current.status || null,
    });
    throw nativeRunFailureError(current, lease.runId, sessionScope);
  }

  const started = {
    runId: lease.runId,
    sessionId: lease.sessionIdToUse || null,
  };
  const result =
    operation === "continue_hermes_session"
      ? nativeSessionContinuationResult(
          started,
          current,
          lease.sessionIdToUse || requestedSessionId,
        )
      : operation === "delegate_to_hermes"
        ? nativeDelegateResult(
            started,
            current,
            lease.reusedSession === true,
          )
        : {
            ...current,
            ok: true,
            operation: "start_hermes_run",
            agent: AGENT,
            recovered: true,
          };

  await sessionCoordinator.observe(sessionScope, {
    kind: "run",
    id: lease.runId,
    terminal: true,
    sessionId: result.sessionId || lease.sessionIdToUse || null,
    replayPayload: result,
  });

  return {
    ...result,
    deduplicated: true,
    duplicateOfTraceId: lease.activeTraceId || null,
    reusedActiveRun: true,
  };
}

// Hermes caps concurrent Runs globally (api_server.max_concurrent_runs, 10 by
// default) and answers 429 beyond it. Nothing was submitted, so say so plainly.
function explainCapacityRejection(error) {
  if (error?.status !== 429 || !error || typeof error !== "object") return;
  error.code = "HERMES_RUN_CAPACITY_EXHAUSTED";
  error.message =
    "Hermes is already running its maximum number of concurrent Runs and did not accept this one. Wait for a Run to finish (poll get_hermes_run), then retry. " +
    error.message;
}

// Tool answers about a slot say which slot they used and warn when other
// slots of the conversation are working in the same Hermes workspace.
function withSlotContext(result, sessionScope, lease = null) {
  if (!sessionScope?.tracked || !result || typeof result !== "object") {
    return result;
  }
  const parallelRuns = Array.isArray(lease?.parallelRuns)
    ? lease.parallelRuns
    : [];
  const warnings = Array.isArray(result.warnings) ? [...result.warnings] : [];
  if (parallelRuns.length) {
    warnings.push(
      "Slot " +
        parallelRuns.map((run) => run.slot).join(" and ") +
        " of this conversation also has Hermes work in progress. Every slot shares the same Mac workspace, so keep parallel instructions on disjoint files and directories.",
    );
  }
  return {
    ...result,
    slot: sessionScope.slot ?? 1,
    ...(parallelRuns.length ? { parallelRuns } : {}),
    ...(lease?.replacedSessionId
      ? { archivedSessionId: lease.replacedSessionId }
      : {}),
    ...(warnings.length ? { warnings } : {}),
  };
}

async function releaseOrPreserveSubmissionFailure(
  sessionScope,
  operationId,
  error,
) {
  explainCapacityRejection(error);
  if (error?.deliveryAmbiguous === true) {
    await sessionCoordinator.markSubmissionUnknown(
      sessionScope,
      operationId,
    );
  } else {
    await sessionCoordinator.fail(sessionScope, operationId);
  }
}

async function preserveKnownSubmittedRun(
  sessionScope,
  operationId,
  runId,
  sessionId,
  originalError,
) {
  try {
    await sessionCoordinator.preserveSubmittedRun(
      sessionScope,
      operationId,
      { runId, sessionId },
    );
  } catch (recoveryError) {
    if (originalError && typeof originalError === "object") {
      originalError.details = {
        ...(originalError.details || {}),
        coordinatorRecoveryError: errorMessage(recoveryError),
      };
    }
  }
}

async function executeSynchronousNative(
  {
    operation,
    instruction,
    requestedSessionId,
    sessionScope,
    traceId,
    replaceSession = false,
  },
) {
  if (!control.configured) {
    throw codedError(
      "HERMES_NATIVE_CONTROL_REQUIRED",
      "Hermes' authenticated native Runs API is required. Run scripts/setup-hermes-control.sh, restart the bridge, then retry.",
      {
        sessionHash: sessionScope?.sessionHash || null,
        slot: sessionScope?.slot ?? null,
      },
    );
  }

  const lease = await sessionCoordinator.begin(sessionScope, {
    mode: operation,
    tool: operation,
    traceId,
    instruction,
    requestedSessionId,
    reconcileActive: reconcileCoordinatorActive,
    replaceSession,
  });
  return withSlotContext(
    await runSynchronousNativeLease(
      { operation, instruction, requestedSessionId, sessionScope, traceId },
      lease,
    ),
    sessionScope,
    lease,
  );
}

async function runSynchronousNativeLease(
  { operation, instruction, requestedSessionId, sessionScope, traceId },
  lease,
) {
  if (lease.replay) return lease.replayPayload;
  if (lease.activeRun) {
    return reuseActiveNativeRun(
      operation,
      lease,
      requestedSessionId,
      sessionScope,
    );
  }

  let runSubmitted = false;
  let runRecorded = false;
  let runId = null;
  let submittedSessionId = null;
  try {
    const started = await control.startRun(
      instruction,
      lease.sessionIdToUse,
      lease.idempotencyKey || "unscoped",
    );
    runId = requireNativeRunId(started, sessionScope);
    runSubmitted = true;
    submittedSessionId =
      started.sessionId || lease.sessionIdToUse || null;

    if (runIsTerminal(started)) {
      if (!nativeRunSucceeded(started)) {
        await sessionCoordinator.complete(
          sessionScope,
          lease.operationId,
          {
            payload: started,
            traceId,
            sessionId: started.sessionId || lease.sessionIdToUse || null,
            runId,
          },
        );
        runRecorded = true;
        throw nativeRunFailureError(started, runId, sessionScope);
      }

      const result =
        operation === "continue_hermes_session"
          ? nativeSessionContinuationResult(
              started,
              started,
              lease.sessionIdToUse || requestedSessionId,
            )
          : nativeDelegateResult(
              started,
              started,
              lease.reusedSession === true,
            );

      await sessionCoordinator.complete(
        sessionScope,
        lease.operationId,
        {
          payload: result,
          traceId,
          sessionId: result.sessionId || lease.sessionIdToUse || null,
          runId,
        },
      );
      runRecorded = true;
      return result;
    }

    await sessionCoordinator.complete(
      sessionScope,
      lease.operationId,
      {
        payload: started,
        traceId,
        sessionId: started.sessionId || lease.sessionIdToUse || null,
        runId,
        keepActive: true,
        activeKind: "run",
      },
    );
    runRecorded = true;

    const waited = await waitForNativeRun(runId);
    if (!waited.terminal) {
      return nativePendingRunResult({
        operation,
        started,
        current: waited.result,
        sessionId: lease.sessionIdToUse || null,
        requestedSessionId,
        lastPollError: waited.lastError,
      });
    }

    const completed = waited.result;
    if (!nativeRunSucceeded(completed)) {
      await sessionCoordinator.observe(sessionScope, {
        kind: "run",
        id: runId,
        terminal: true,
        sessionId:
          completed.sessionId ||
          started.sessionId ||
          lease.sessionIdToUse ||
          null,
        replayPayload: null,
        status: completed.status || null,
      });
      throw nativeRunFailureError(completed, runId, sessionScope);
    }

    const result =
      operation === "continue_hermes_session"
        ? nativeSessionContinuationResult(
            started,
            completed,
            lease.sessionIdToUse || requestedSessionId,
          )
        : nativeDelegateResult(
            started,
            completed,
            lease.reusedSession === true,
          );

    await sessionCoordinator.complete(
      sessionScope,
      lease.operationId,
      {
        payload: result,
        traceId,
        sessionId: result.sessionId || lease.sessionIdToUse || null,
        runId,
      },
    );
    return result;
  } catch (error) {
    if (!runSubmitted) {
      await releaseOrPreserveSubmissionFailure(
        sessionScope,
        lease.operationId,
        error,
      );
    } else {
      if (!runRecorded) {
        await preserveKnownSubmittedRun(
          sessionScope,
          lease.operationId,
          runId,
          submittedSessionId,
          error,
        );
      }
      if (!error?.details?.runId) {
        error.details = {
          ...(error?.details || {}),
          runId,
          sessionHash: sessionScope?.sessionHash || null,
          slot: sessionScope?.slot ?? null,
        };
      }
    }
    throw error;
  }
}

// Reads a Run once; a Run Hermes no longer knows releases the slot it held.
async function readTrackedRunOnce(slotScope, before, runId) {
  try {
    return await control.getRun(runId);
  } catch (error) {
    if (
      nativeRunNotFoundError(error) &&
      before?.active?.kind === "run" &&
      before.active.runId === runId
    ) {
      await sessionCoordinator.observe(slotScope, {
        kind: "run",
        id: runId,
        terminal: true,
        sessionId: before.active.sessionId || null,
        replayPayload: null,
        status: "missing",
      });
    }
    throw error;
  }
}

async function observeReadRun(slotScope, before, runId, result) {
  const terminal = runIsTerminal(result);
  const replayPayload =
    terminal &&
    ["run", "native-session-unresolved"].includes(before?.active?.kind) &&
    before.active.runId === runId
      ? recoveredNativeRunPayload(before.active, result)
      : null;
  await sessionCoordinator.observe(slotScope, {
    kind: "run",
    id: runId,
    terminal,
    sessionId: result.sessionId || null,
    replayPayload,
    status: result.status || null,
  });
  return terminal;
}

async function readSlotRun(slotScope, before, requestedRunId) {
  const runId = requestedRunId || before?.active?.runId || null;
  if (!runId) {
    return withSlotContext(
      {
        ok: true,
        operation: "get_hermes_run",
        agent: AGENT,
        runId: null,
        sessionId: before?.canonicalSessionId || null,
        status: "no-active-run",
        pending: false,
        hint:
          "This conversation has no active Run. Start work with delegate_to_hermes, or pass an explicit runId.",
      },
      slotScope,
    );
  }
  const pollStartedAtMs = Date.now();
  const deadline = pollStartedAtMs + NATIVE_RUN_POLL_WAIT_MS;
  let result = await readTrackedRunOnce(slotScope, before, runId);
  while (!runIsTerminal(result) && Date.now() < deadline) {
    await sleep(
      Math.min(NATIVE_DELEGATE_POLL_MS, Math.max(1, deadline - Date.now())),
    );
    result = await readTrackedRunOnce(slotScope, before, runId);
  }
  const terminal = await observeReadRun(slotScope, before, runId, result);
  return withSlotContext(
    {
      ...result,
      pending: !terminal,
      resolution: requestedRunId ? "explicit" : "conversation-active-run",
      waitedMs: Date.now() - pollStartedAtMs,
      nextStep: terminal
        ? null
        : "The Run is still working: call get_hermes_run again " +
          (slotScope?.slot > 1
            ? "with slot " + slotScope.slot
            : "without a runId") +
          ", in this same turn, until it is terminal.",
    },
    slotScope,
  );
}

// get_hermes_run with neither runId nor slot. With at most one busy slot it
// answers exactly like the single-slot bridge did; with several it waits on
// all of them at once and returns as soon as any one finishes.
async function readConversationRuns(sessionScope) {
  const conversation = await sessionCoordinator.inspectConversation(
    sessionScope,
  );
  const busy = conversation.slots.filter((slot) => slot.active?.runId);
  if (busy.length <= 1) {
    const slotScope = {
      ...sessionScope,
      slot: busy[0]?.slot ?? 1,
    };
    const before =
      busy[0] ||
      conversation.slots.find((slot) => slot.slot === 1) ||
      (await sessionCoordinator.inspect(slotScope));
    const result = await readSlotRun(slotScope, before, null);
    return conversation.slots.length > 1
      ? { ...result, slots: slotOverview(conversation.slots) }
      : result;
  }

  const entries = busy.map((before) => ({
    slotScope: { ...sessionScope, slot: before.slot },
    before,
    runId: before.active.runId,
    result: null,
    error: null,
  }));
  const readAll = () =>
    Promise.all(
      entries.map(async (entry) => {
        if (entry.error || runIsTerminal(entry.result)) return;
        try {
          entry.result = await readTrackedRunOnce(
            entry.slotScope,
            entry.before,
            entry.runId,
          );
        } catch (error) {
          if (error?.code === "HERMES_NATIVE_RUN_ID_MISMATCH") throw error;
          if (nativeRunNotFoundError(error)) entry.error = error;
          else entry.lastError = error;
        }
      }),
    );
  const settled = () =>
    entries.some((entry) => entry.error || runIsTerminal(entry.result));

  const pollStartedAtMs = Date.now();
  const deadline = pollStartedAtMs + NATIVE_RUN_POLL_WAIT_MS;
  await readAll();
  while (!settled() && Date.now() < deadline) {
    await sleep(
      Math.min(NATIVE_DELEGATE_POLL_MS, Math.max(1, deadline - Date.now())),
    );
    await readAll();
  }

  const runs = [];
  for (const entry of entries) {
    if (entry.error) {
      runs.push({
        slot: entry.slotScope.slot,
        runId: entry.runId,
        status: "missing",
        pending: false,
        error: publicError(entry.error),
      });
      continue;
    }
    if (!entry.result) {
      runs.push({
        slot: entry.slotScope.slot,
        runId: entry.runId,
        status: "unknown",
        pending: true,
        ...(entry.lastError
          ? { lastPollError: errorMessage(entry.lastError) }
          : {}),
      });
      continue;
    }
    const terminal = await observeReadRun(
      entry.slotScope,
      entry.before,
      entry.runId,
      entry.result,
    );
    runs.push({
      ...entry.result,
      slot: entry.slotScope.slot,
      pending: !terminal,
    });
  }

  const pendingSlots = runs.filter((run) => run.pending).map((run) => run.slot);
  return {
    ok: true,
    operation: "get_hermes_run",
    agent: AGENT,
    runId: null,
    status: pendingSlots.length ? "running" : "settled",
    pending: pendingSlots.length > 0,
    resolution: "conversation-active-slots",
    waitedMs: Date.now() - pollStartedAtMs,
    runs,
    slots: slotOverview(conversation.slots),
    nextStep: pendingSlots.length
      ? "Slot " +
        pendingSlots.join(" and ") +
        " still working: call get_hermes_run again with no arguments, in this same turn, until no slot is pending."
      : null,
  };
}

function slotOverview(slots) {
  return slots.map((slot) => ({
    slot: slot.slot,
    sessionId: slot.canonicalSessionId || slot.active?.sessionId || null,
    activeRunId: slot.active?.runId || null,
    lastRun: slot.lastRun || null,
  }));
}

async function startNativeRun(name, args, traceId, sessionScope) {
  const instruction = requireString(args, "instruction");
  const requestedSessionId =
    typeof args.sessionId === "string" && args.sessionId.trim()
      ? args.sessionId.trim()
      : null;
  const lease = await sessionCoordinator.begin(sessionScope, {
    mode: name,
    tool: name,
    traceId,
    instruction,
    requestedSessionId,
    reconcileActive: reconcileCoordinatorActive,
    replaceSession: args.replaceSession === true,
  });
  return withSlotContext(
    await runStartLease(
      name,
      instruction,
      requestedSessionId,
      traceId,
      sessionScope,
      lease,
    ),
    sessionScope,
    lease,
  );
}

async function runStartLease(
  name,
  instruction,
  requestedSessionId,
  traceId,
  sessionScope,
  lease,
) {
  if (lease.replay) return lease.replayPayload;
  if (lease.activeRun) {
    return reuseActiveNativeRun(
      name,
      lease,
      requestedSessionId,
      sessionScope,
    );
  }

  let submitted = false;
  let runRecorded = false;
  let runId = null;
  let submittedSessionId = null;
  try {
    const result = await control.startRun(
      instruction,
      lease.sessionIdToUse,
      lease.idempotencyKey || "unscoped",
    );
    runId = requireNativeRunId(result, sessionScope);
    submitted = true;
    submittedSessionId =
      result.sessionId || lease.sessionIdToUse || null;
    const terminal = runIsTerminal(result);

    await sessionCoordinator.complete(
      sessionScope,
      lease.operationId,
      {
        payload: result,
        traceId,
        sessionId: result.sessionId || lease.sessionIdToUse || null,
        runId,
        keepActive: !terminal,
        activeKind: !terminal ? "run" : null,
      },
    );
    runRecorded = true;

    if (terminal && !nativeRunSucceeded(result)) {
      throw nativeRunFailureError(result, runId, sessionScope);
    }
    return result;
  } catch (error) {
    if (!submitted) {
      await releaseOrPreserveSubmissionFailure(
        sessionScope,
        lease.operationId,
        error,
      );
    } else {
      if (!runRecorded) {
        await preserveKnownSubmittedRun(
          sessionScope,
          lease.operationId,
          runId,
          submittedSessionId,
          error,
        );
      }
      if (!error?.details?.runId) {
        error.details = {
          ...(error?.details || {}),
          runId,
          sessionHash: sessionScope?.sessionHash || null,
          slot: sessionScope?.slot ?? null,
        };
      }
    }
    throw error;
  }
}

async function slotScopeFor(args, sessionScope) {
  return sessionCoordinator.scopeForSlot(sessionScope, {
    slot: args.slot,
    runId: optionalString(args, "runId"),
  });
}

async function executePublicTool(name, args, traceId, sessionScope) {
  switch (name) {
    case "delegate_to_hermes":
      return executeSynchronousNative({
        operation: name,
        instruction: requireString(args, "instruction"),
        requestedSessionId: null,
        sessionScope: await slotScopeFor(args, sessionScope),
        traceId,
        replaceSession: args.replaceSession === true,
      });

    case "list_hermes_sessions":
      return sessionAccess.listSessions({
        ...(args.limit === undefined ? {} : { limit: args.limit }),
        ...(typeof args.source === "string" ? { source: args.source } : {}),
        ...(typeof args.workspace === "string"
          ? { workspace: args.workspace }
          : {}),
      });

    case "get_hermes_session":
      return sessionAccess.getSession(
        requireString(args, "sessionId"),
        {
          ...(args.limit === undefined ? {} : { limit: args.limit }),
          includeTools: args.includeTools === true,
        },
      );

    case "continue_hermes_session":
      return executeSynchronousNative({
        operation: name,
        instruction: requireString(args, "instruction"),
        requestedSessionId: requireString(args, "sessionId"),
        sessionScope: await slotScopeFor(args, sessionScope),
        traceId,
        replaceSession: args.replaceSession === true,
      });

    case "start_hermes_run":
      return startNativeRun(
        name,
        args,
        traceId,
        await slotScopeFor(args, sessionScope),
      );

    case "get_hermes_run": {
      const requestedRunId = optionalString(args, "runId");
      if (!requestedRunId && args.slot === undefined) {
        return readConversationRuns(sessionScope);
      }
      const slotScope = await slotScopeFor(args, sessionScope);
      const before = await sessionCoordinator.inspect(slotScope);
      return readSlotRun(slotScope, before, requestedRunId);
    }

    case "steer_hermes_run": {
      const runId = requireString(args, "runId");
      const slotScope = await slotScopeFor(args, sessionScope);
      await sessionCoordinator.assertActiveRun(slotScope, runId);
      return withSlotContext(
        await control.steerRun(runId, requireString(args, "instruction")),
        slotScope,
      );
    }

    case "stop_hermes_run": {
      const runId = requireString(args, "runId");
      const slotScope = await slotScopeFor(args, sessionScope);
      await sessionCoordinator.assertActiveRun(slotScope, runId);
      const before = await sessionCoordinator.inspect(slotScope);
      const result = await control.stopRun(runId);
      const terminal = runIsTerminal(result);
      const replayPayload =
        terminal &&
        before?.active?.kind === "run" &&
        before.active.runId === runId
          ? recoveredNativeRunPayload(before.active, result)
          : null;
      await sessionCoordinator.observe(slotScope, {
        kind: "run",
        id: runId,
        terminal,
        sessionId: result.sessionId || null,
        replayPayload,
        status: result.status || null,
      });
      return withSlotContext(result, slotScope);
    }

    case "hermes_status": {
      const controlStatus = await control.status();
      return {
        ok: true,
        operation: "hermes_status",
        agent: AGENT,
        reachable: true,
        nativeOnly: true,
        control: {
          ...controlStatus,
          configured: control.configured,
          reachable: true,
        },
      };
    }

    case "hermes_activity":
      return observability.readActivity(args);

    case "hermes_tool_timeline": {
      const explicitSessionId =
        typeof args.sessionId === "string" && args.sessionId.trim()
          ? args.sessionId.trim()
          : null;
      const requestedRunId =
        typeof args.runId === "string" && args.runId.trim()
          ? args.runId.trim()
          : null;
      let sessionId = explicitSessionId;
      let correlation = explicitSessionId ? "explicit-session-id" : null;

      if (!sessionId && requestedRunId) {
        // A runId is only used to locate its session. The coordinator's active
        // run is authoritative when it matches this exact runId; otherwise the
        // run-bound session id is the run id itself (GET /v1/runs/{id} binds
        // them). The conversation's current canonical session is deliberately
        // NOT used: it may belong to a different, later run.
        const state = await slotScopeFor(
          { runId: requestedRunId },
          sessionScope,
        )
          .then((slotScope) => sessionCoordinator.inspect(slotScope))
          .catch(() => null);
        const active = state?.active || null;
        const activeMatches =
          active &&
          (active.runId === requestedRunId || active.id === requestedRunId) &&
          Boolean(active.sessionId);
        if (activeMatches) {
          sessionId = active.sessionId;
          correlation = "coordinator-active-run";
        } else {
          sessionId = requestedRunId;
          correlation = "run-id-as-session-id";
        }
      }

      if (!sessionId) {
        throw codedError(
          "HERMES_TIMELINE_TARGET_REQUIRED",
          "sessionId or runId is required to read a tool timeline.",
        );
      }

      return sessionAccess.getToolTimeline(sessionId, {
        ...(args.limit === undefined ? {} : { limit: args.limit }),
        ...(args.since === undefined ? {} : { since: args.since }),
        errorsOnly: args.errorsOnly === true,
        ...(typeof args.tool === "string" ? { tool: args.tool } : {}),
        ...(requestedRunId ? { runId: requestedRunId } : {}),
        ...(correlation ? { correlation } : {}),
      });
    }

    default:
      throw new Error("Unknown tool: " + name);
  }
}

const server = new Server(
  { name: "hermes-mac", version: "0.9.0" },
  {
    capabilities: { tools: {} },
    instructions: SERVER_INSTRUCTIONS,
  },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: TOOLS,
}));

server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
  const name = request.params.name;
  const args = requireObject(request.params.arguments);
  const sessionScope = sessionCoordinator.scopeFromMeta(extra?._meta);
  const trace = observability.beginTrace(name, args, {
    chatgptSessionHash: sessionScope.sessionHash,
    metaKeys: Object.keys(extra?._meta || {})
      .sort()
      .slice(0, 16),
  });
  let payload = null;
  let failure = null;

  try {
    payload = await executePublicTool(
      name,
      args,
      trace.traceId,
      sessionScope,
    );
    payload = { ...payload, traceId: trace.traceId };
    trackRunForNotification(name, args, payload, null);
    return toolText(payload);
  } catch (error) {
    failure = error;
    trackRunForNotification(name, args, null, error);
    payload = {
      ok: false,
      operation: name,
      agent: AGENT,
      traceId: trace.traceId,
      error: publicError(error),
    };
    return toolError(error, name, trace.traceId);
  } finally {
    await observability.appendTrace(
      observability.finishTrace(trace, payload, failure),
    );
  }
});

let closing = false;
async function shutdown() {
  if (closing) return;
  closing = true;
  await observability.flush();
}

process.once("SIGTERM", async () => {
  await shutdown();
  process.exit(0);
});
process.once("SIGINT", async () => {
  await shutdown();
  process.exit(0);
});

try {
  await server.connect(new StdioServerTransport());
  console.error(
    "Hermes Mac native MCP ready on stdio; activity=" +
      observability.activityLog +
      "; dedup=" +
      observability.dedupWindowMs +
      "ms; runNotify=" +
      (runNotifier.enabled ? "discord" : "off"),
  );
} catch (error) {
  console.error("Failed to start Hermes Mac native MCP: " + errorMessage(error));
  await shutdown();
  process.exit(1);
}