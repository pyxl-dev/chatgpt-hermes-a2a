#!/usr/bin/env node

import { randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

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

const TOOLS = [
  {
    name: "delegate_to_hermes",
    description:
      "Start a NEW local mission on the user's Mac through Hermes. Use this for a first request to inspect or act on local files, apps, terminal, browser, code, or other Mac resources. The instruction is sent to the Hermes agent loop, not executed by this MCP wrapper. For a follow-up to an existing mission, use continue_with_hermes with the exact contextId returned here instead of starting a new context.",
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
      },
      required: ["contextId", "instruction"],
    },
  },
  {
    name: "get_hermes_task",
    description:
      "Read the current state and available result of a Hermes task. Use this when a previous delegate or continue call returned a taskId, especially when the state was submitted or working. Pass the taskId exactly as returned; do not use this to start work.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        taskId: {
          type: "string",
          minLength: 1,
          description: "Opaque A2A taskId returned by Hermes.",
        },
      },
      required: ["taskId"],
    },
  },
  {
    name: "cancel_hermes_task",
    description:
      "Request cancellation of a Hermes task that is still running. Use only when the user asks to stop the task or continuing it is undesirable. Pass the taskId exactly as returned by Hermes.",
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
];

let backend = null;
let backendConnectPromise = null;

function createBackendTransport() {
  const childEnv = {
    A2A_MCP_CONFIG:
      process.env.A2A_MCP_CONFIG ||
      path.join(ROOT, ".runtime", "a2a-mcp.config.yaml"),
    ...(process.env.A2A_BEARER_TOKEN
      ? { A2A_BEARER_TOKEN: process.env.A2A_BEARER_TOKEN }
      : {}),
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
      { name: "chatgpt-hermes-ux-backend", version: "0.2.0" },
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

function toolError(error, operation = "unknown") {
  const payload = {
    ok: false,
    operation,
    agent: AGENT,
    ...(operation === "hermes_status" ? { reachable: false } : {}),
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
  const result = await client.callTool(
    { name, arguments: args },
    undefined,
    {
      timeout: BACKEND_TIMEOUT_MS,
      maxTotalTimeout: BACKEND_TIMEOUT_MS,
    },
  );

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

function messageText(message) {
  if (!message || typeof message !== "object") return "";
  return (message.parts || message.content || [])
    .map(partText)
    .filter(Boolean)
    .join("\n")
    .trim();
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
  if (artifactTexts.length) return artifactTexts.join("\n").trim();

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

  return typeof task?.text === "string" ? task.text : "";
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

function makeUserMessage(instruction, contextId) {
  return {
    messageId: randomUUID(),
    ...(contextId ? { contextId } : {}),
    role: "ROLE_USER",
    parts: [{ text: instruction }],
  };
}

async function delegate(instruction) {
  const raw = await callBackend("a2a_send_message", {
    agent: AGENT,
    request: {
      message: makeUserMessage(instruction),
      configuration: { returnImmediately: true },
    },
  });
  return normalizeTask(raw, "delegate_to_hermes");
}

async function continueContext(contextId, instruction) {
  const raw = await callBackend("a2a_send_message", {
    agent: AGENT,
    request: {
      message: makeUserMessage(instruction, contextId),
      configuration: { returnImmediately: true },
    },
  });
  return normalizeTask(raw, "continue_with_hermes");
}

async function getTask(taskId) {
  const raw = await callBackend("a2a_get_task", {
    agent: AGENT,
    request: { id: taskId, historyLength: 20 },
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

  return {
    ok: true,
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
  };
}

const server = new Server(
  { name: "hermes-mac", version: "0.2.0" },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: TOOLS,
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  try {
    const args = requireObject(request.params.arguments);

    switch (request.params.name) {
      case "delegate_to_hermes":
        return toolText(await delegate(requireString(args, "instruction")));

      case "continue_with_hermes":
        return toolText(
          await continueContext(
            requireString(args, "contextId"),
            requireString(args, "instruction"),
          ),
        );

      case "get_hermes_task":
        return toolText(await getTask(requireString(args, "taskId")));

      case "cancel_hermes_task":
        return toolText(await cancelTask(requireString(args, "taskId")));

      case "hermes_status":
        return toolText(await status());

      default:
        throw new Error(`Unknown tool: ${request.params.name}`);
    }
  } catch (error) {
    return toolError(error, request.params.name);
  }
});

let closing = false;
async function shutdown() {
  if (closing) return;
  closing = true;
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
  console.error("Hermes Mac UX MCP ready on stdio");
} catch (error) {
  console.error(`Failed to start Hermes Mac UX MCP: ${errorMessage(error)}`);
  await shutdown();
  process.exit(1);
}
