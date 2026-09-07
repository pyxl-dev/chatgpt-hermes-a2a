import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const bridge = path.join(root, "scripts", "start-bridge.sh");
const timeoutMs = Number(process.env.HERMES_CONTROL_SMOKE_TIMEOUT_MS || 45000);
const terminalStatuses = new Set(["completed", "failed", "cancelled", "interrupted"]);

const childEnv = Object.fromEntries(
  Object.entries(process.env).filter((entry) => typeof entry[1] === "string"),
);

function extractText(result) {
  const parts = Array.isArray(result?.content) ? result.content : [];
  return parts
    .map((part) => (part?.type === "text" ? part.text || "" : ""))
    .filter(Boolean)
    .join("\n");
}

function payloadOf(result) {
  if (result?.structuredContent !== undefined) return result.structuredContent;
  const text = extractText(result);
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function assertOk(result, name) {
  const payload = payloadOf(result);
  if (result?.isError) {
    throw new Error(name + " returned MCP error: " + JSON.stringify(payload));
  }
  if (payload && typeof payload === "object" && payload.ok === false) {
    throw new Error(name + " returned application error: " + JSON.stringify(payload));
  }
  return payload;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function pollRun(client, runId, predicate, label) {
  const deadline = Date.now() + timeoutMs;
  let latest = null;
  while (Date.now() < deadline) {
    const result = await client.callTool({
      name: "get_hermes_run",
      arguments: { runId },
    });
    latest = assertOk(result, "get_hermes_run");
    if (predicate(latest)) return latest;
    await sleep(500);
  }
  throw new Error(
    label + " timed out after " + timeoutMs + "ms; latest=" + JSON.stringify(latest),
  );
}

const transport = new StdioClientTransport({
  command: "/bin/bash",
  args: [bridge],
  env: childEnv,
  cwd: root,
  stderr: "inherit",
});

const client = new Client(
  { name: "chatgpt-hermes-control-smoke", version: "0.1.0" },
  { capabilities: {} },
);

const summary = {
  ok: false,
  runId: null,
  started: null,
  running: null,
  steer: null,
  stop: null,
  terminal: null,
  error: null,
};

let activeRunId = null;

try {
  await client.connect(transport);

  const statusResult = await client.callTool({
    name: "hermes_status",
    arguments: {},
  });
  const status = assertOk(statusResult, "hermes_status");
  if (
    status?.control?.configured !== true ||
    status?.control?.reachable !== true ||
    status?.control?.runSubmission !== true ||
    status?.control?.runStatus !== true ||
    status?.control?.runSteer !== true ||
    status?.control?.runStop !== true
  ) {
    throw new Error(
      "Hermes control plane is not fully ready: " +
        JSON.stringify(status?.control || null),
    );
  }

  const nonce = Date.now().toString(36);
  const instruction =
    "CONTROL SMOKE " +
    nonce +
    ": use your local terminal tool to run exactly " +
    '`python3 -c "import time; time.sleep(60)"`' +
    ". Do not create, edit, or delete any files. After the command finishes, reply exactly CONTROL_SMOKE_NATURAL_COMPLETION.";

  const startResult = await client.callTool({
    name: "start_hermes_run",
    arguments: { instruction },
  });
  const started = assertOk(startResult, "start_hermes_run");
  if (typeof started?.runId !== "string" || !started.runId) {
    throw new Error("start_hermes_run did not return runId");
  }
  activeRunId = started.runId;
  summary.runId = activeRunId;
  summary.started = {
    status: started.status,
    replayed: started.replayed === true,
  };

  const running = await pollRun(
    client,
    activeRunId,
    (payload) => payload?.status === "running",
    "waiting for running state",
  );
  summary.running = {
    status: running.status,
    lastEvent: running.lastEvent || null,
  };

  const steerResult = await client.callTool({
    name: "steer_hermes_run",
    arguments: {
      runId: activeRunId,
      instruction:
        "CONTROL SMOKE STEER: after the current tool boundary, do not start another tool. If allowed to continue, reply exactly CONTROL_STEERED.",
    },
  });
  const steered = assertOk(steerResult, "steer_hermes_run");
  if (steered?.accepted !== true) {
    throw new Error("steer_hermes_run was not accepted");
  }
  summary.steer = {
    accepted: true,
    status: steered.status || null,
  };

  const stopResult = await client.callTool({
    name: "stop_hermes_run",
    arguments: { runId: activeRunId },
  });
  const stopped = assertOk(stopResult, "stop_hermes_run");
  summary.stop = {
    status: stopped.status || null,
  };

  const terminal = await pollRun(
    client,
    activeRunId,
    (payload) => terminalStatuses.has(payload?.status),
    "waiting for terminal state after stop",
  );
  summary.terminal = {
    status: terminal.status,
    lastEvent: terminal.lastEvent || null,
    error: terminal.error || null,
  };

  if (terminal.status !== "cancelled") {
    throw new Error(
      "Expected stopped run to settle as cancelled; got " + terminal.status,
    );
  }

  activeRunId = null;
  summary.ok = true;
} catch (error) {
  summary.error = error instanceof Error ? error.message : String(error);
  process.exitCode = 1;
} finally {
  if (activeRunId) {
    try {
      await client.callTool({
        name: "stop_hermes_run",
        arguments: { runId: activeRunId },
      });
    } catch {}
  }
  try {
    await client.close();
  } catch {}
}

process.stdout.write(JSON.stringify(summary, null, 2) + "\n");
