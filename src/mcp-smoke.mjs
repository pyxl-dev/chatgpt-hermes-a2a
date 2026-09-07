import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const bridge = path.join(root, "scripts", "start-bridge.sh");
const proofFile = "/tmp/chatgpt-hermes-ux-proof.txt";
const proofText = "HERMES_UX_OK";
const proofTimeoutMs = Number(
  process.env.HERMES_UX_SMOKE_TIMEOUT_MS ||
    process.env.HERMES_A2A_SMOKE_TIMEOUT_MS ||
    180000,
);
const expectedTools = [
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
];

const childEnv = Object.fromEntries(
  Object.entries(process.env).filter((entry) => typeof entry[1] === "string"),
);

function extractText(result) {
  const parts = Array.isArray(result && result.content) ? result.content : [];
  return parts
    .map((part) => {
      if (part && part.type === "text") return part.text || "";
      try {
        return JSON.stringify(part);
      } catch {
        return String(part);
      }
    })
    .filter(Boolean)
    .join("\n");
}

function payloadOf(result) {
  if (result && result.structuredContent !== undefined) {
    return result.structuredContent;
  }
  const text = extractText(result);
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function preview(value, max = 2500) {
  const rendered = typeof value === "string" ? value : JSON.stringify(value);
  if (!rendered) return "";
  return rendered.length > max
    ? rendered.slice(0, max) + "…[truncated]"
    : rendered;
}

function resultSummary(result) {
  const payload = payloadOf(result);
  if (payload && typeof payload === "object") {
    return {
      ok: payload.ok,
      agent: payload.agent,
      traceId: payload.traceId,
      taskId: payload.taskId,
      contextId: payload.contextId,
      state: payload.state,
      stateName: payload.stateName,
      text: payload.text,
      cancelled: payload.cancelled,
      deduplicated: payload.deduplicated,
      duplicateOfTraceId: payload.duplicateOfTraceId,
      error: payload.error,
      control: payload.control,
    };
  }
  return preview(payload);
}

function assertToolSucceeded(result, name) {
  const payload = payloadOf(result);
  if (result && result.isError) {
    throw new Error(`${name} returned an MCP error: ${preview(payload)}`);
  }
  if (payload && typeof payload === "object" && payload.ok === false) {
    throw new Error(`${name} returned an application error: ${preview(payload)}`);
  }
  return payload;
}

async function sleep(ms) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForExactProof() {
  const deadline = Date.now() + proofTimeoutMs;
  while (Date.now() < deadline) {
    try {
      const onDisk = await fs.readFile(proofFile, "utf8");
      if (onDisk === proofText) return true;
    } catch {}
    await sleep(2000);
  }
  return false;
}

const summary = {
  ok: false,
  tools: [],
  hermesStatus: null,
  sessionList: null,
  delegate: null,
  duplicateDelegate: null,
  dedupSameTask: null,
  getTask: null,
  continue: null,
  activity: null,
  localToolProof: false,
  continuedSameContext: null,
  nativeSessionRead: "skipped",
  waitedMs: 0,
  error: null,
};

const transport = new StdioClientTransport({
  command: "/bin/bash",
  args: [bridge],
  env: childEnv,
  cwd: root,
  stderr: "inherit",
});

const client = new Client(
  { name: "chatgpt-hermes-ux-smoke", version: "0.1.0" },
  { capabilities: {} },
);

try {
  await client.connect(transport);

  const listed = await client.listTools();
  summary.tools = (listed.tools || []).map((tool) => tool.name);
  const actual = [...summary.tools].sort();
  const expected = [...expectedTools].sort();
  if (
    actual.length !== expected.length ||
    actual.some((name, index) => name !== expected[index])
  ) {
    throw new Error(
      `UX MCP surface mismatch. Expected exactly ${expectedTools.join(", ")}; got ${summary.tools.join(", ")}`,
    );
  }
  if (
    listed.tools.some(
      (tool) => typeof tool.description !== "string" || tool.description.length < 20,
    )
  ) {
    throw new Error("Every ergonomic UX tool must have an explicit description");
  }
  const descriptions = Object.fromEntries(
    listed.tools.map((tool) => [tool.name, tool.description]),
  );
  if (!/new/i.test(descriptions.delegate_to_hermes) || !/contextId/i.test(descriptions.delegate_to_hermes)) {
    throw new Error("delegate_to_hermes description must identify a new mission and contextId handoff");
  }
  if (!/existing|follow-up/i.test(descriptions.continue_with_hermes) || !/contextId/i.test(descriptions.continue_with_hermes)) {
    throw new Error("continue_with_hermes description must identify existing-context follow-ups");
  }
  if (!/sessionId/i.test(descriptions.list_hermes_sessions) || !/list|discover/i.test(descriptions.list_hermes_sessions)) {
    throw new Error("list_hermes_sessions description must identify session discovery");
  }
  if (!/sessionId/i.test(descriptions.get_hermes_session) || !/persisted|durable/i.test(descriptions.get_hermes_session)) {
    throw new Error("get_hermes_session description must identify durable Hermes session reads");
  }
  if (!/sessionId/i.test(descriptions.continue_hermes_session) || !/resume|existing/i.test(descriptions.continue_hermes_session)) {
    throw new Error("continue_hermes_session description must identify durable Hermes session resume");
  }
  if (!/controll|steer|stop/i.test(descriptions.start_hermes_run) || !/runId/i.test(descriptions.start_hermes_run)) {
    throw new Error("start_hermes_run description must explain controllable runs and runId");
  }
  if (!/runId/i.test(descriptions.get_hermes_run)) {
    throw new Error("get_hermes_run description must identify runId");
  }
  if (!/steer/i.test(descriptions.steer_hermes_run) || !/runId/i.test(descriptions.steer_hermes_run)) {
    throw new Error("steer_hermes_run description must identify live-run steering");
  }
  if (!/stop/i.test(descriptions.stop_hermes_run) || !/runId/i.test(descriptions.stop_hermes_run)) {
    throw new Error("stop_hermes_run description must identify live-run stopping");
  }

  const status = await client.callTool({
    name: "hermes_status",
    arguments: {},
  });
  const statusPayload = assertToolSucceeded(status, "hermes_status");
  if (statusPayload?.reachable !== true) {
    throw new Error("hermes_status did not report reachable=true");
  }
  if (
    statusPayload?.control?.configured === true &&
    (
      statusPayload.control.reachable !== true ||
      statusPayload.control.runSubmission !== true ||
      statusPayload.control.runStatus !== true ||
      statusPayload.control.runSteer !== true ||
      statusPayload.control.runStop !== true
    )
  ) {
    throw new Error(
      "Hermes control API is configured but not fully ready: " +
        preview(statusPayload.control),
    );
  }
  summary.hermesStatus = resultSummary(status);

  const sessionListResult = await client.callTool({
    name: "list_hermes_sessions",
    arguments: { limit: 5 },
  });
  const sessionListPayload = assertToolSucceeded(
    sessionListResult,
    "list_hermes_sessions",
  );
  if (!Array.isArray(sessionListPayload?.sessions)) {
    throw new Error("list_hermes_sessions did not return a sessions array");
  }
  for (const session of sessionListPayload.sessions) {
    if (typeof session?.sessionId !== "string" || !session.sessionId.trim()) {
      throw new Error("list_hermes_sessions returned a row without sessionId");
    }
  }
  summary.sessionList = {
    ok: sessionListPayload.ok,
    count: sessionListPayload.count,
    sessionIds: sessionListPayload.sessions
      .slice(0, 5)
      .map((session) => session.sessionId),
  };

  const smokeSessionId =
    typeof process.env.HERMES_UX_SMOKE_SESSION_ID === "string"
      ? process.env.HERMES_UX_SMOKE_SESSION_ID.trim()
      : "";
  if (smokeSessionId) {
    const nativeRead = await client.callTool({
      name: "get_hermes_session",
      arguments: { sessionId: smokeSessionId, limit: 5 },
    });
    const nativePayload = assertToolSucceeded(
      nativeRead,
      "get_hermes_session",
    );
    if (!nativePayload?.sessionId) {
      throw new Error("get_hermes_session did not return a sessionId");
    }
    summary.nativeSessionRead = {
      ok: nativePayload.ok,
      requestedSessionId: nativePayload.requestedSessionId,
      sessionId: nativePayload.sessionId,
      returnedMessageCount: nativePayload.returnedMessageCount,
    };
  }

  await fs.rm(proofFile, { force: true });
  const instruction =
    "Use your local terminal tool to create " +
    proofFile +
    " containing exactly " +
    proofText +
    " with no trailing newline, then read it back. Do not modify any other file, setting, repository, or service. Reply with exactly " +
    proofText +
    ".";

  const sentAt = Date.now();
  const delegated = await client.callTool({
    name: "delegate_to_hermes",
    arguments: { instruction },
  });
  const delegatedPayload = assertToolSucceeded(
    delegated,
    "delegate_to_hermes",
  );
  summary.delegate = resultSummary(delegated);
  summary.localToolProof = await waitForExactProof();
  summary.waitedMs = Date.now() - sentAt;

  if (!summary.localToolProof) {
    throw new Error(
      `Hermes did not create ${proofFile} with exactly ${proofText} before the smoke-test timeout.`,
    );
  }

  const taskId = delegatedPayload?.taskId;
  const contextId = delegatedPayload?.contextId;
  if (!taskId || !contextId) {
    throw new Error("delegate_to_hermes did not return both taskId and contextId");
  }
  if (delegatedPayload?.deduplicated !== false) {
    throw new Error("First delegate_to_hermes call must report deduplicated=false");
  }

  const duplicate = await client.callTool({
    name: "delegate_to_hermes",
    arguments: { instruction },
  });
  const duplicatePayload = assertToolSucceeded(
    duplicate,
    "delegate_to_hermes duplicate",
  );
  summary.duplicateDelegate = resultSummary(duplicate);
  summary.dedupSameTask =
    duplicatePayload?.taskId === taskId &&
    duplicatePayload?.contextId === contextId;

  if (duplicatePayload?.deduplicated !== true) {
    throw new Error("Second identical delegate_to_hermes call was not deduplicated");
  }
  if (summary.dedupSameTask !== true) {
    throw new Error("Deduplicated delegation did not reuse the original task/context");
  }
  if (duplicatePayload?.duplicateOfTraceId !== delegatedPayload?.traceId) {
    throw new Error("Deduplicated delegation did not point to the original traceId");
  }

  const task = await client.callTool({
    name: "get_hermes_task",
    arguments: { taskId },
  });
  assertToolSucceeded(task, "get_hermes_task");
  summary.getTask = resultSummary(task);
  const returnedText = [summary.delegate?.text, summary.getTask?.text]
    .filter(Boolean)
    .join("\n");
  if (!returnedText.includes(proofText)) {
    throw new Error(
      "delegate_to_hermes/get_hermes_task did not return the proof text read-back",
    );
  }

  const continued = await client.callTool({
    name: "continue_with_hermes",
    arguments: {
      contextId,
      instruction:
        "Do not use tools and do not modify any file. Reply exactly " +
          proofText +
          " to confirm this follow-up arrived in the same Hermes conversation.",
    },
  });
  const continuedPayload = assertToolSucceeded(
    continued,
    "continue_with_hermes",
  );
  summary.continue = resultSummary(continued);
  summary.continuedSameContext =
    continuedPayload?.contextId === undefined
      ? null
      : continuedPayload.contextId === contextId;
  if (summary.continuedSameContext !== true) {
    throw new Error("continue_with_hermes did not preserve the original contextId");
  }

  const activityResult = await client.callTool({
    name: "hermes_activity",
    arguments: { limit: 20 },
  });
  const activityPayload = assertToolSucceeded(activityResult, "hermes_activity");
  summary.activity = {
    ok: activityPayload?.ok,
    count: activityPayload?.count,
    totalMatching: activityPayload?.totalMatching,
    deduplicatedCount: activityPayload?.deduplicatedCount,
    errorCount: activityPayload?.errorCount,
    dedupWindowMs: activityPayload?.dedupWindowMs,
  };

  const traces = Array.isArray(activityPayload?.records)
    ? activityPayload.records
    : [];
  const firstDelegateTrace = traces.find(
    (trace) => trace.traceId === delegatedPayload.traceId,
  );
  const duplicateDelegateTrace = traces.find(
    (trace) => trace.traceId === duplicatePayload.traceId,
  );
  if (!firstDelegateTrace || !duplicateDelegateTrace) {
    throw new Error("hermes_activity did not expose both delegation traces");
  }
  if (
    firstDelegateTrace.deduplicated !== false ||
    duplicateDelegateTrace.deduplicated !== true
  ) {
    throw new Error("hermes_activity deduplication flags are incorrect");
  }
  for (const trace of [firstDelegateTrace, duplicateDelegateTrace]) {
    for (const key of [
      "traceId",
      "startedAt",
      "endedAt",
      "durationMs",
      "tool",
      "instructionHash",
      "instructionPreview",
      "inputContextId",
      "inputTaskId",
      "inputRunId",
      "outputContextId",
      "outputTaskId",
      "outputRunId",
      "inputSessionId",
      "outputSessionId",
      "state",
      "stateName",
      "ok",
      "error",
      "deduplicated",
      "background",
    ]) {
      if (!(key in trace)) {
        throw new Error("Activity trace is missing required field: " + key);
      }
    }
  }

  summary.ok = true;
} catch (error) {
  summary.error = error instanceof Error ? error.message : String(error);
  process.exitCode = 1;
} finally {
  try {
    await client.close();
  } catch {}
  await fs.rm(proofFile, { force: true }).catch(() => {});
}

process.stdout.write(JSON.stringify(summary, null, 2) + "\n");
