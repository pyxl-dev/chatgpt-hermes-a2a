#!/usr/bin/env node

import { randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { createHermesObservability } from "./hermes-observability.mjs";
import { createHermesSessionAccess } from "./hermes-sessions.mjs";
import { createHermesControl } from "./hermes-control.mjs";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const BACKEND_BIN =
  process.env.HERMES_A2A_BACKEND_BIN ||
  process.env.A2A_MCP_BACKEND_BIN ||
  path.join(ROOT, "node_modules", ".bin", "a2a-mcp");
const AGENT = "hermes";
const configuredTimeout = Number(process.env.HERMES_MCP_BACKEND_TIMEOUT_MS);
const BACKEND_TIMEOUT_MS =
  Number.isFinite(configuredTimeout) && configuredTimeout > 0
    ? configuredTimeout
    : 330000;
const REQUIRED_BACKEND_TOOLS = [
  "a2a_get_agent_card",
  "a2a_send_message",
  "a2a_get_task",
  "a2a_cancel_task",
];

function redactText(value) {
  let text = String(value);
  for (const key of [
    "A2A_BEARER_TOKEN",
    "CONTROL_PLANE_API_KEY",
    "OPENAI_API_KEY",
    "API_SERVER_KEY",
    "HERMES_API_SERVER_KEY",
  ]) {
    const secret = process.env[key];
    if (secret) text = text.split(secret).join("[REDACTED]");
  }
  return text
    .replace(/(Bearer\s+)[^\s"'`]+/gi, "$1[REDACTED]")
    .replace(/(Basic\s+)[^\s"'`]+/gi, "$1[REDACTED]")
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
        const sensitiveKey = /(?:authorization|credential|token|secret|password|api[_-]?key)/i.test(
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

const TOOLS = [
  {
    name: "delegate_to_hermes",
    description:
      "Start a NEW local mission on the user's Mac through Hermes over A2A. Use this for ordinary short requests. The instruction is sent to the Hermes agent loop, not executed by this MCP wrapper. For a follow-up to an existing A2A mission, use continue_with_hermes with the exact contextId returned here. If the work may need live steering or a true agent stop, use start_hermes_run instead.",
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
        background: {
          type: "boolean",
          description:
            "Optional. Leave false/omit for normal interactive use so the tool waits for Hermes to finish. Set true only for intentionally long-running work; then use get_hermes_task with the returned taskId.",
          default: false,
        },
      },
      required: ["instruction"],
    },
  },
  {
    name: "continue_with_hermes",
    description:
      "Continue an EXISTING Hermes mission in the same A2A conversation. Use only with a contextId previously returned by delegate_to_hermes or this tool; reuse that opaque value exactly so Hermes retains the prior context. Do not invent a contextId and do not use this for a new unrelated mission.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        contextId: {
          type: "string",
          minLength: 1,
          description:
            "Opaque A2A contextId returned by an earlier Hermes call. Copy it exactly.",
        },
        instruction: {
          type: "string",
          minLength: 1,
          description: "The follow-up instruction for Hermes in that same context.",
        },
        taskId: {
          type: "string",
          minLength: 1,
          description:
            "Optional. Pass the previous taskId only when resuming an interrupted input-required/auth-required task. For a normal follow-up after completion, omit it and use contextId only.",
        },
        background: {
          type: "boolean",
          description:
            "Optional. Leave false/omit for normal interactive use so the tool waits for Hermes to finish. Set true only for intentionally long-running work; then poll get_hermes_task.",
          default: false,
        },
      },
      required: ["contextId", "instruction"],
    },
  },
  {
    name: "list_hermes_sessions",
    description:
      "List recent persisted Hermes conversations so you can discover the correct durable sessionId before reading or resuming one. Uses Hermes' native sessions list command, does not contact the model, and returns compact metadata such as title/preview, workspace, last activity, source when available, and sessionId.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        limit: {
          type: "integer",
          minimum: 1,
          maximum: 200,
          default: 50,
          description:
            "Maximum number of recent sessions to return, ordered by Hermes' native session listing.",
        },
        source: {
          type: "string",
          minLength: 1,
          description:
            "Optional Hermes source filter such as cli, tui, telegram, discord, slack, cron, a2a, or tool.",
        },
        workspace: {
          type: "string",
          minLength: 1,
          description:
            "Optional Hermes workspace filter. Hermes matches a path substring or exact directory basename.",
        },
      },
    },
  },
  {
    name: "get_hermes_session",
    description:
      "Read a persisted Hermes conversation directly by its durable Hermes sessionId. This uses Hermes' native session export, does not create a new A2A context, does not ask the model to summarize itself, excludes system/tool messages by default, and redacts secrets before returning history.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        sessionId: {
          type: "string",
          minLength: 1,
          description:
            "Durable Hermes session ID such as 20260905_053252_4248284e. Copy it exactly.",
        },
        limit: {
          type: "integer",
          minimum: 0,
          maximum: 200,
          default: 50,
          description:
            "Maximum number of most recent visible messages to return. Use 0 for metadata only.",
        },
        includeTools: {
          type: "boolean",
          default: false,
          description:
            "When true, include persisted tool-result messages as well as user/assistant messages. Leave false unless tool history is needed.",
        },
      },
      required: ["sessionId"],
    },
  },
  {
    name: "continue_hermes_session",
    description:
      "Continue a persisted Hermes conversation directly by its durable Hermes sessionId. This resumes the existing Hermes session with its stored transcript; it does not create a new A2A conversation. Use this when the user provides a Hermes session ID or when get_hermes_session returned one.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        sessionId: {
          type: "string",
          minLength: 1,
          description:
            "Durable Hermes session ID to resume, copied exactly.",
        },
        instruction: {
          type: "string",
          minLength: 1,
          description:
            "The next instruction to execute inside that existing Hermes conversation.",
        },
      },
      required: ["sessionId", "instruction"],
    },
  },
  {
    name: "start_hermes_run",
    description:
      "Start a CONTROLLABLE Hermes run and return immediately with a runId. Use this instead of a blocking delegation when the work may need steering or stopping. Pass sessionId to continue an existing durable Hermes conversation, or omit sessionId to start a new run.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        instruction: {
          type: "string",
          minLength: 1,
          description: "The task for Hermes.",
        },
        sessionId: {
          type: "string",
          minLength: 1,
          description:
            "Optional durable Hermes session ID. When present, Hermes loads that session transcript before starting the run.",
        },
      },
      required: ["instruction"],
    },
  },
  {
    name: "get_hermes_run",
    description:
      "Read the status/result of a controllable Hermes run by runId. Use after start_hermes_run and after steering/stopping to see whether the run is running, stopping, completed, failed, cancelled, or waiting for approval.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        runId: {
          type: "string",
          minLength: 1,
          description: "Hermes run ID returned by start_hermes_run.",
        },
      },
      required: ["runId"],
    },
  },
  {
    name: "steer_hermes_run",
    description:
      "Steer a currently RUNNING Hermes run by its exact runId without starting a new user turn. Hermes queues the guidance into the live agent and applies it at the next tool boundary. A successful response means queued, not necessarily consumed; poll get_hermes_run afterward.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        runId: {
          type: "string",
          minLength: 1,
          description: "Running Hermes run ID.",
        },
        instruction: {
          type: "string",
          minLength: 1,
          description: "Course-correction guidance to inject into the live run.",
        },
      },
      required: ["runId", "instruction"],
    },
  },
  {
    name: "stop_hermes_run",
    description:
      "Stop a controllable Hermes run by its exact runId through Hermes' native interruption mechanism. This requests a safe cooperative stop and returns immediately; poll get_hermes_run until the run settles as cancelled or another terminal state.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        runId: {
          type: "string",
          minLength: 1,
          description: "Hermes run ID to stop.",
        },
      },
      required: ["runId"],
    },
  },
  {
    name: "get_hermes_task",
    description:
      "Read the current state and available result of a Hermes task. Use this after a background delegation/continuation, or when a previous call returned submitted/working. Pass the taskId exactly as returned; do not use this to start work.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        taskId: {
          type: "string",
          minLength: 1,
          description: "Opaque A2A taskId returned by Hermes.",
        },
        historyLength: {
          type: "integer",
          minimum: 0,
          maximum: 100,
          description:
            "Optional number of task history messages to include. Omit unless additional context is needed.",
        },
      },
      required: ["taskId"],
    },
  },
  {
    name: "cancel_hermes_task",
    description:
      "Cancel an A2A task envelope that is still running. This resolves/cancels the A2A task but does NOT guarantee interruption of Hermes' underlying agent computation. For a true live agent stop, use start_hermes_run and stop_hermes_run. Pass the taskId exactly as returned by Hermes.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        taskId: {
          type: "string",
          minLength: 1,
          description: "Opaque A2A taskId to cancel.",
        },
      },
      required: ["taskId"],
    },
  },
  {
    name: "hermes_status",
    description:
      "Check whether the local Hermes agent is reachable through A2A and return a compact connectivity summary. Use this for health/connectivity checks, not to delegate work or inspect a task.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {},
    },
  },
  {
    name: "hermes_activity",
    description:
      "Read recent local MCP activity traces from the bridge without contacting Hermes. Use this to inspect call counts, tools, sanitized instruction previews, task/context IDs, duration, state, errors, background usage, and whether a delegate_to_hermes call was deduplicated.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        limit: {
          type: "integer",
          minimum: 1,
          maximum: 200,
          default: 50,
          description: "Maximum number of newest matching trace records to return.",
        },
        tool: {
          type: "string",
          enum: [
            "delegate_to_hermes",
            "continue_with_hermes",
            "list_hermes_sessions",
            "get_hermes_session",
            "continue_hermes_session",
            "start_hermes_run",
            "get_hermes_run",
            "steer_hermes_run",
            "stop_hermes_run",
            "get_hermes_task",
            "cancel_hermes_task",
            "hermes_status",
            "hermes_activity",
          ],
          description: "Optional tool name filter.",
        },
        since: {
          type: "string",
          description:
            "Optional ISO-8601 timestamp. Only traces that started at or after this timestamp are returned.",
        },
        deduplicatedOnly: {
          type: "boolean",
          default: false,
          description: "When true, return only deduplicated calls.",
        },
        errorsOnly: {
          type: "boolean",
          default: false,
          description: "When true, return only failed calls.",
        },
      },
    },
  },
];

let backend = null;
let backendConnectPromise = null;

function createBackendTransport() {
  const childEnv = {
    ...process.env,
    A2A_MCP_CONFIG:
      process.env.A2A_MCP_CONFIG ||
      path.join(ROOT, ".runtime", "a2a-mcp.config.yaml"),
  };
  const transport = new StdioClientTransport({
    command: BACKEND_BIN,
    cwd: ROOT,
    env: childEnv,
    stderr: "pipe",
  });

  transport.stderr?.on("data", (chunk) => {
    process.stderr.write(`[a2a-mcp] ${redactText(chunk.toString())}`);
  });
  return transport;
}

async function ensureBackend() {
  if (backend) return backend;
  if (backendConnectPromise) return backendConnectPromise;

  backendConnectPromise = (async () => {
    const client = new Client(
      { name: "chatgpt-hermes-ux-backend", version: "0.5.0" },
      { capabilities: {} },
    );
    const transport = createBackendTransport();

    try {
      await client.connect(transport);
      const listed = await client.listTools();
      const available = new Set((listed.tools || []).map((tool) => tool.name));
      const missing = REQUIRED_BACKEND_TOOLS.filter(
        (name) => !available.has(name),
      );
      if (missing.length) {
        throw new Error(
          `A2A backend is missing required tools: ${missing.join(", ")}`,
        );
      }
      backend = client;
      return client;
    } catch (error) {
      await client.close().catch(() => {});
      throw error;
    }
  })();

  try {
    return await backendConnectPromise;
  } finally {
    if (!backend) backendConnectPromise = null;
  }
}

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
    ...(operation === "hermes_status" ? { reachable: false } : {}),
    ...metadata,
    error: { message: errorMessage(error) },
  };
  return {
    isError: true,
    content: [{ type: "text", text: JSON.stringify(payload) }],
    structuredContent: payload,
  };
}

function requireObject(value) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value
    : {};
}

function requireString(args, key) {
  const value = args[key];
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${key} must be a non-empty string`);
  }
  return value;
}

function decodeBackendResult(result) {
  if (
    result?.structuredContent &&
    typeof result.structuredContent === "object" &&
    !Array.isArray(result.structuredContent)
  ) {
    return result.structuredContent;
  }

  const texts = (result?.content || [])
    .filter((item) => item?.type === "text" && typeof item.text === "string")
    .map((item) => item.text);

  for (const text of texts) {
    try {
      const parsed = JSON.parse(text);
      if (parsed && typeof parsed === "object") return parsed;
    } catch {
      // Plain text is a valid MCP tool result; handled below.
    }
  }

  return {
    text: texts.join("\n").trim(),
    rawContent: result?.content || [],
  };
}

async function callBackend(name, args) {
  const client = await ensureBackend();
  let result;
  try {
    result = await client.callTool(
      { name, arguments: args },
      undefined,
      {
        timeout: BACKEND_TIMEOUT_MS,
        maxTotalTimeout: BACKEND_TIMEOUT_MS,
      },
    );
  } catch (error) {
    if (backend === client) backend = null;
    backendConnectPromise = null;
    await client.close().catch(() => {});
    throw error;
  }

  if (result?.isError) {
    const decoded = decodeBackendResult(result);
    const backendError = decoded?.error;
    throw new Error(
      (typeof backendError === "string"
        ? backendError
        : backendError?.message) ||
        decoded?.text ||
        `Backend tool ${name} returned an MCP error`,
    );
  }

  return decodeBackendResult(result);
}

function unwrapBridge(value) {
  if (
    value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    value.result &&
    typeof value.result === "object"
  ) {
    return value.result;
  }
  return value;
}

function partText(part) {
  if (!part || typeof part !== "object") return "";
  if (typeof part.text === "string") return part.text;
  if (typeof part.content?.text === "string") return part.content.text;
  if (
    (part.content?.$case === "text" ||
      part.content?.case === "text" ||
      part.content?.type === "text") &&
    typeof part.content?.value === "string"
  ) {
    return part.content.value;
  }
  return "";
}

function cleanHermesText(value) {
  const text = String(value || "").trim();
  return text
    .replace(
      /^💭\s*\*\*Reasoning:\*\*\s*(?:\n```[\s\S]*?```\s*)?/u,
      "",
    )
    .trim();
}

const sessionAccess = createHermesSessionAccess({
  root: ROOT,
  redactText,
  randomUUID,
  cleanText: cleanHermesText,
});
const continueNativeSession = observability.wrapSessionContinue(
  sessionAccess.continueSession,
);

function messageText(message) {
  if (!message || typeof message !== "object") return "";
  return cleanHermesText(
    (message.parts || message.content || [])
      .map(partText)
      .filter(Boolean)
      .join("\n"),
  );
}

function isAgentMessage(message) {
  return (
    message?.role === "agent" ||
    message?.role === "ROLE_AGENT" ||
    message?.role === 2
  );
}

function taskText(task) {
  const artifactTexts = (task?.artifacts || [])
    .flatMap((artifact) => artifact?.parts || artifact?.content || [])
    .map(partText)
    .filter(Boolean);
  if (artifactTexts.length) {
    return cleanHermesText(artifactTexts.join("\n"));
  }

  const statusText = messageText(task?.status?.message || task?.status?.update);
  if (statusText) return statusText;

  const history = Array.isArray(task?.history) ? task.history : [];
  for (const message of [...history].reverse()) {
    if (isAgentMessage(message)) {
      const text = messageText(message);
      if (text) return text;
    }
  }
  for (const message of [...history].reverse()) {
    const text = messageText(message);
    if (text) return text;
  }

  return typeof task?.text === "string" ? cleanHermesText(task.text) : "";
}

function stateName(state) {
  if (state === null || state === undefined || state === "") return null;
  const numericNames = {
    0: "unknown",
    1: "submitted",
    2: "working",
    3: "completed",
    4: "failed",
    5: "canceled",
    6: "input-required",
    7: "rejected",
    8: "auth-required",
  };
  if (typeof state === "number") return numericNames[state] || String(state);

  const normalized = String(state).toLowerCase().replaceAll("_", "-");
  const aliases = {
    unspecified: "unknown",
    unknown: "unknown",
    submitted: "submitted",
    working: "working",
    completed: "completed",
    failed: "failed",
    canceled: "canceled",
    cancelled: "canceled",
    "input-required": "input-required",
    rejected: "rejected",
    "auth-required": "auth-required",
  };
  return aliases[normalized] || String(state);
}

function rawTaskState(task) {
  const looksLikeTask =
    task?.kind === "task" ||
    task?.id ||
    task?.taskId ||
    task?.status ||
    task?.artifacts ||
    task?.history;
  return {
    kind: task?.kind || (looksLikeTask ? "task" : "message"),
    id: task?.id || null,
    messageId: task?.messageId || null,
    taskId: task?.taskId || null,
    contextId: task?.contextId || task?.context_id || null,
    state: task?.status?.state ?? task?.state ?? null,
    status: task?.status || null,
    artifactCount: Array.isArray(task?.artifacts)
      ? task.artifacts.length
      : undefined,
    historyLength: Array.isArray(task?.history) ? task.history.length : undefined,
  };
}

function normalizeTask(value, operation) {
  const task = unwrapBridge(value) || {};
  const isMessage =
    task?.kind === "message" ||
    (task?.messageId && !task?.id && !task?.status);
  const rawState = task?.status?.state ?? task?.state ?? null;
  return {
    ok: true,
    operation,
    agent: AGENT,
    kind: task?.kind || (isMessage ? "message" : "task"),
    taskId: task.id || task.taskId || task.task_id || null,
    contextId: task.contextId || task.context_id || null,
    state: isMessage ? null : rawState,
    stateName: stateName(isMessage ? null : rawState),
    text: isMessage ? messageText(task) || null : taskText(task) || null,
    raw: rawTaskState(task),
  };
}

function makeUserMessage(instruction, contextId, taskId) {
  return {
    messageId: randomUUID(),
    ...(contextId ? { contextId } : {}),
    ...(taskId ? { taskId } : {}),
    role: "ROLE_USER",
    parts: [{ text: instruction }],
  };
}

async function delegateOnce(instruction, background = false) {
  const raw = await callBackend("a2a_send_message", {
    agent: AGENT,
    request: {
      message: makeUserMessage(instruction),
      ...(background
        ? { configuration: { returnImmediately: true } }
        : {}),
    },
  });
  return normalizeTask(raw, "delegate_to_hermes");
}

const delegate = observability.wrapDelegate(delegateOnce);

async function continueContext(
  contextId,
  instruction,
  taskId,
  background = false,
) {
  const raw = await callBackend("a2a_send_message", {
    agent: AGENT,
    request: {
      message: makeUserMessage(instruction, contextId, taskId),
      ...(background
        ? { configuration: { returnImmediately: true } }
        : {}),
    },
  });
  return normalizeTask(raw, "continue_with_hermes");
}

async function getTask(taskId, historyLength) {
  const request = { id: taskId };
  if (historyLength !== undefined) request.historyLength = historyLength;

  const raw = await callBackend("a2a_get_task", {
    agent: AGENT,
    request,
  });
  return normalizeTask(raw, "get_hermes_task");
}

async function cancelTask(taskId) {
  const raw = await callBackend("a2a_cancel_task", {
    agent: AGENT,
    request: { id: taskId },
  });
  const normalized = normalizeTask(raw, "cancel_hermes_task");
  return { ...normalized, cancelled: true, canceled: true };
}

async function status() {
  const raw = unwrapBridge(
    await callBackend("a2a_get_agent_card", {
      agent: AGENT,
      request: {},
    }),
  );
  const supportedInterface =
    raw?.supportedInterfaces?.[0] || raw?.interfaces?.[0] || {};

  let controlStatus = { configured: control.configured, reachable: false };
  if (control.configured) {
    try {
      controlStatus = {
        configured: true,
        reachable: true,
        ...(await control.status()),
      };
    } catch (error) {
      controlStatus = {
        configured: true,
        reachable: false,
        error: { message: errorMessage(error) },
      };
    }
  }

  return {
    ok: true,
    operation: "hermes_status",
    reachable: true,
    agent: AGENT,
    name: raw?.name || null,
    description: raw?.description || null,
    version: raw?.version || null,
    protocolVersion: supportedInterface.protocolVersion || null,
    protocolBinding:
      supportedInterface.protocolBinding || supportedInterface.transport || null,
    url: supportedInterface.url || raw?.url || null,
    capabilities: raw?.capabilities || {},
    skillsCount: Array.isArray(raw?.skills) ? raw.skills.length : null,
    control: controlStatus,
  };
}

async function executePublicTool(name, args, traceId) {
  switch (name) {
    case "delegate_to_hermes":
      return delegate(
        requireString(args, "instruction"),
        args.background === true,
        traceId,
      );

    case "continue_with_hermes":
      return continueContext(
        requireString(args, "contextId"),
        requireString(args, "instruction"),
        typeof args.taskId === "string" && args.taskId.trim()
          ? args.taskId
          : undefined,
        args.background === true,
      );

    case "list_hermes_sessions":
      return sessionAccess.listSessions({
        ...(args.limit === undefined ? {} : { limit: args.limit }),
        ...(typeof args.source === "string" ? { source: args.source } : {}),
        ...(typeof args.workspace === "string"
          ? { workspace: args.workspace }
          : {}),
      });

    case "get_hermes_session": {
      const limit = args.limit === undefined ? undefined : args.limit;
      return sessionAccess.getSession(requireString(args, "sessionId"), {
        ...(limit === undefined ? {} : { limit }),
        includeTools: args.includeTools === true,
      });
    }

    case "continue_hermes_session":
      return continueNativeSession(
        requireString(args, "sessionId"),
        requireString(args, "instruction"),
        traceId,
      );

    case "start_hermes_run":
      return control.startRun(
        requireString(args, "instruction"),
        typeof args.sessionId === "string" && args.sessionId.trim()
          ? args.sessionId
          : null,
      );

    case "get_hermes_run":
      return control.getRun(requireString(args, "runId"));

    case "steer_hermes_run":
      return control.steerRun(
        requireString(args, "runId"),
        requireString(args, "instruction"),
      );

    case "stop_hermes_run":
      return control.stopRun(requireString(args, "runId"));

    case "get_hermes_task": {
      let historyLength;
      if (args.historyLength !== undefined) {
        if (
          !Number.isInteger(args.historyLength) ||
          args.historyLength < 0 ||
          args.historyLength > 100
        ) {
          throw new Error(
            "historyLength must be an integer between 0 and 100",
          );
        }
        historyLength = args.historyLength;
      }
      return getTask(requireString(args, "taskId"), historyLength);
    }

    case "cancel_hermes_task":
      return cancelTask(requireString(args, "taskId"));

    case "hermes_status":
      return status();

    case "hermes_activity":
      return observability.readActivity(args);

    default:
      throw new Error("Unknown tool: " + name);
  }
}

const server = new Server(
  { name: "hermes-mac", version: "0.6.0" },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: TOOLS,
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const name = request.params.name;
  const args = requireObject(request.params.arguments);
  const trace = observability.beginTrace(name, args);
  let payload = null;
  let failure = null;

  try {
    payload = await executePublicTool(name, args, trace.traceId);
    payload = { ...payload, traceId: trace.traceId };
    return toolText(payload);
  } catch (error) {
    failure = error;
    payload = {
      ok: false,
      operation: name,
      agent: AGENT,
      traceId: trace.traceId,
      error: { message: errorMessage(error) },
      deduplicated: error?.deduplicated === true,
      duplicateOfTraceId: error?.duplicateOfTraceId || null,
    };
    return toolError(error, name, trace.traceId, {
      deduplicated: payload.deduplicated,
      duplicateOfTraceId: payload.duplicateOfTraceId,
    });
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
  try {
    await backend?.close();
  } catch {
    // Process is shutting down anyway.
  }
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
  // Keep the public MCP endpoint available so hermes_status can report a
  // backend/agent outage instead of making initialization fail opaquely.
  await server.connect(new StdioServerTransport());
  console.error(
    "Hermes Mac UX MCP ready on stdio; activity=" +
      observability.activityLog +
      "; dedup=" +
      observability.dedupWindowMs +
      "ms",
  );
} catch (error) {
  console.error(`Failed to start Hermes Mac UX MCP: ${errorMessage(error)}`);
  await shutdown();
  process.exit(1);
}
