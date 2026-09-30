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
import { createHermesSessionCoordinator } from "./hermes-session-coordinator.mjs";
import { createHermesSessionAccess } from "./hermes-sessions.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const AGENT = "hermes";
const configuredNativeDelegateTimeout = Number(
  process.env.HERMES_NATIVE_DELEGATE_TIMEOUT_MS,
);
const NATIVE_DELEGATE_TIMEOUT_MS =
  Number.isFinite(configuredNativeDelegateTimeout) &&
  configuredNativeDelegateTimeout >= 1000
    ? configuredNativeDelegateTimeout
    : 330000;
const configuredNativePollMs = Number(
  process.env.HERMES_NATIVE_DELEGATE_POLL_MS,
);
const NATIVE_DELEGATE_POLL_MS =
  Number.isFinite(configuredNativePollMs) && configuredNativePollMs >= 100
    ? configuredNativePollMs
    : 750;

function redactText(value) {
  let text = String(value);
  for (const key of [
    "CONTROL_PLANE_API_KEY",
    "OPENAI_API_KEY",
    "API_SERVER_KEY",
    "HERMES_API_SERVER_KEY",
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
  cleanText: cleanHermesText,
});

const sessionCoordinator = createHermesSessionCoordinator({
  root: ROOT,
  randomUUID,
});

const TOOLS = [
  {
    name: "delegate_to_hermes",
    description:
      "Run ordinary Hermes work in the single durable native Hermes session bound to this ChatGPT conversation. Uses Hermes' authenticated Runs API, serializes mutating work, and automatically reuses the returned durable sessionId on later turns.",
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
      },
      required: ["instruction"],
    },
  },
  {
    name: "list_hermes_sessions",
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
      "Continue an explicitly chosen durable Hermes session through the authenticated Runs API. The wrapper rejects a different session once this ChatGPT conversation has a canonical Hermes session.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        sessionId: { type: "string", minLength: 1 },
        instruction: { type: "string", minLength: 1 },
      },
      required: ["sessionId", "instruction"],
    },
  },
  {
    name: "start_hermes_run",
    description:
      "Start the single controllable Hermes Run allowed for this ChatGPT conversation and return its runId. Reuses the canonical durable session when known.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        instruction: { type: "string", minLength: 1 },
        sessionId: { type: "string", minLength: 1 },
      },
      required: ["instruction"],
    },
  },
  {
    name: "get_hermes_run",
    description:
      "Read the status/result of a Hermes Run by runId and reconcile coordinator state when it is the active Run.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        runId: { type: "string", minLength: 1 },
      },
      required: ["runId"],
    },
  },
  {
    name: "steer_hermes_run",
    description:
      "Queue course-correction guidance into the active Hermes Run. Requires the exact active runId for tracked ChatGPT conversations.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        runId: { type: "string", minLength: 1 },
        instruction: { type: "string", minLength: 1 },
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
      },
      required: ["runId"],
    },
  },
  {
    name: "hermes_status",
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
          ],
        },
        since: { type: "string" },
        deduplicatedOnly: { type: "boolean", default: false },
        errorsOnly: { type: "boolean", default: false },
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
    { sessionHash: sessionScope?.sessionHash || null },
  );
  error.deliveryAmbiguous = true;
  throw error;
}

function nativeRunFailureError(result, runId, sessionScope) {
  return codedError(
    "HERMES_NATIVE_RUN_FAILED",
    "Hermes native Run reached an unsuccessful terminal state.",
    {
      sessionHash: sessionScope?.sessionHash || null,
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

function recoveredNativeRunPayload(active, result) {
  if (!nativeRunSucceeded(result)) return null;
  if (active?.tool === "delegate_to_hermes") {
    return nativeDelegateResult(
      {
        runId: active.runId,
        sessionId: active.sessionId || null,
      },
      result,
      Boolean(active.sessionId),
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

  while (Date.now() < deadline) {
    try {
      lastResult = await control.getRun(runId);
      lastError = null;
      if (runIsTerminal(lastResult)) return lastResult;
    } catch (error) {
      lastError = error;
    }
    await sleep(NATIVE_DELEGATE_POLL_MS);
  }

  throw codedError(
    "HERMES_NATIVE_RUN_TIMEOUT",
    "Hermes native Run did not reach a terminal state before the synchronous delegation timeout.",
    {
      runId,
      timeoutMs: NATIVE_DELEGATE_TIMEOUT_MS,
      lastStatus: lastResult?.status || null,
      lastError: lastError ? errorMessage(lastError) : null,
    },
  );
}

async function reconcileCoordinatorActive(active) {
  if (active?.kind === "run" && active.runId) {
    const result = await control.getRun(active.runId);
    const terminal = runIsTerminal(result);
    return {
      terminal,
      sessionId: result.sessionId || active.sessionId || null,
      replayPayload:
        terminal ? recoveredNativeRunPayload(active, result) : null,
    };
  }
  return { terminal: false };
}

async function releaseOrPreserveSubmissionFailure(
  sessionScope,
  operationId,
  error,
) {
  if (error?.deliveryAmbiguous === true) {
    await sessionCoordinator.markSubmissionUnknown(
      sessionScope,
      operationId,
    );
  } else {
    await sessionCoordinator.fail(sessionScope, operationId);
  }
}

async function executeSynchronousNative(
  {
    operation,
    instruction,
    requestedSessionId,
    sessionScope,
    traceId,
  },
) {
  if (!control.configured) {
    throw codedError(
      "HERMES_NATIVE_CONTROL_REQUIRED",
      "Hermes' authenticated native Runs API is required. Run scripts/setup-hermes-control.sh, restart the bridge, then retry.",
      { sessionHash: sessionScope?.sessionHash || null },
    );
  }

  const lease = await sessionCoordinator.begin(sessionScope, {
    mode: operation,
    tool: operation,
    traceId,
    instruction,
    requestedSessionId,
    reconcileActive: reconcileCoordinatorActive,
  });
  if (lease.replay) return lease.replayPayload;

  let runSubmitted = false;
  let runId = null;
  try {
    const started = await control.startRun(
      instruction,
      lease.sessionIdToUse,
      lease.idempotencyKey || "unscoped",
    );
    runId = requireNativeRunId(started, sessionScope);
    runSubmitted = true;

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

    const completed = await waitForNativeRun(runId);
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
            Boolean(lease.sessionIdToUse),
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
    } else if (!error?.details?.runId) {
      error.details = {
        ...(error?.details || {}),
        runId,
        sessionHash: sessionScope?.sessionHash || null,
      };
    }
    throw error;
  }
}

async function executePublicTool(name, args, traceId, sessionScope) {
  switch (name) {
    case "delegate_to_hermes":
      return executeSynchronousNative({
        operation: name,
        instruction: requireString(args, "instruction"),
        requestedSessionId: null,
        sessionScope,
        traceId,
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
        sessionScope,
        traceId,
      });

    case "start_hermes_run": {
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
      });
      if (lease.replay) return lease.replayPayload;

      let submitted = false;
      let runId = null;
      try {
        const result = await control.startRun(
          instruction,
          lease.sessionIdToUse,
          lease.idempotencyKey || "unscoped",
        );
        runId = requireNativeRunId(result, sessionScope);
        submitted = true;
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
        } else if (!error?.details?.runId) {
          error.details = {
            ...(error?.details || {}),
            runId,
            sessionHash: sessionScope?.sessionHash || null,
          };
        }
        throw error;
      }
    }

    case "get_hermes_run": {
      const runId = requireString(args, "runId");
      const before = await sessionCoordinator.inspect(sessionScope);
      const result = await control.getRun(runId);
      const terminal = runIsTerminal(result);
      const replayPayload =
        terminal &&
        before?.active?.kind === "run" &&
        before.active.runId === runId
          ? recoveredNativeRunPayload(before.active, result)
          : null;
      await sessionCoordinator.observe(sessionScope, {
        kind: "run",
        id: runId,
        terminal,
        sessionId: result.sessionId || null,
        replayPayload,
      });
      return result;
    }

    case "steer_hermes_run": {
      const runId = requireString(args, "runId");
      await sessionCoordinator.assertActiveRun(sessionScope, runId);
      return control.steerRun(
        runId,
        requireString(args, "instruction"),
      );
    }

    case "stop_hermes_run": {
      const runId = requireString(args, "runId");
      await sessionCoordinator.assertActiveRun(sessionScope, runId);
      const before = await sessionCoordinator.inspect(sessionScope);
      const result = await control.stopRun(runId);
      const terminal = runIsTerminal(result);
      const replayPayload =
        terminal &&
        before?.active?.kind === "run" &&
        before.active.runId === runId
          ? recoveredNativeRunPayload(before.active, result)
          : null;
      await sessionCoordinator.observe(sessionScope, {
        kind: "run",
        id: runId,
        terminal,
        sessionId: result.sessionId || null,
        replayPayload,
      });
      return result;
    }

    case "hermes_status": {
      const controlStatus = await control.status();
      return {
        ok: true,
        operation: "hermes_status",
        agent: AGENT,
        reachable: true,
        nativeOnly: true,
        control: controlStatus,
      };
    }

    case "hermes_activity":
      return observability.readActivity(args);

    default:
      throw new Error("Unknown tool: " + name);
  }
}

const server = new Server(
  { name: "hermes-mac", version: "0.9.0" },
  { capabilities: { tools: {} } },
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
    return toolText(payload);
  } catch (error) {
    failure = error;
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
      "ms",
  );
} catch (error) {
  console.error("Failed to start Hermes Mac native MCP: " + errorMessage(error));
  await shutdown();
  process.exit(1);
}
