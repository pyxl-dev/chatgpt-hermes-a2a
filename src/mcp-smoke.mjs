import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const bridge = path.join(root, "scripts", "start-bridge.sh");
const proofFile = "/tmp/chatgpt-hermes-native-proof.txt";
const proofText = "HERMES_NATIVE_OK";

const expectedTools = [
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
];

const childEnv = Object.fromEntries(
  Object.entries(process.env).filter((entry) => typeof entry[1] === "string"),
);

function payloadOf(result) {
  if (result?.structuredContent !== undefined) return result.structuredContent;
  const text = (result?.content || [])
    .filter((part) => part?.type === "text")
    .map((part) => part.text || "")
    .join("\n");
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

const transport = new StdioClientTransport({
  command: "/bin/bash",
  args: [bridge],
  env: childEnv,
  cwd: root,
  stderr: "inherit",
});

const client = new Client(
  { name: "chatgpt-hermes-native-smoke", version: "0.1.0" },
  { capabilities: {} },
);

const summary = {
  ok: false,
  tools: [],
  status: null,
  sessionCount: null,
  delegate: null,
  proof: false,
  error: null,
};

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
      "Native MCP surface mismatch. Expected " +
        expectedTools.join(", ") +
        "; got " +
        summary.tools.join(", "),
    );
  }
  if (summary.tools.some((name) => /a2a|task/i.test(name))) {
    throw new Error("A2A/task tools are still exposed: " + summary.tools.join(", "));
  }

  const status = assertOk(
    await client.callTool({ name: "hermes_status", arguments: {} }),
    "hermes_status",
  );
  if (
    status?.reachable !== true ||
    status?.nativeOnly !== true ||
    status?.control?.runSubmission !== true ||
    status?.control?.runStatus !== true ||
    status?.control?.runSteer !== true ||
    status?.control?.runStop !== true
  ) {
    throw new Error("Native Hermes control API is not ready: " + JSON.stringify(status));
  }
  summary.status = {
    reachable: status.reachable,
    nativeOnly: status.nativeOnly,
    runSubmission: status.control.runSubmission,
    runStatus: status.control.runStatus,
    runSteer: status.control.runSteer,
    runStop: status.control.runStop,
  };

  const sessions = assertOk(
    await client.callTool({
      name: "list_hermes_sessions",
      arguments: { limit: 5 },
    }),
    "list_hermes_sessions",
  );
  if (!Array.isArray(sessions?.sessions)) {
    throw new Error("list_hermes_sessions did not return an array");
  }
  summary.sessionCount = sessions.sessions.length;

  await fs.rm(proofFile, { force: true });
  const instruction =
    "Use your local terminal tool to create " +
    proofFile +
    " containing exactly " +
    proofText +
    " with no trailing newline, read it back, and reply exactly " +
    proofText +
    ". Do not modify any other file, setting, repository, or service.";

  const delegated = assertOk(
    await client.callTool({
      name: "delegate_to_hermes",
      arguments: { instruction },
    }),
    "delegate_to_hermes",
  );

  if (!delegated?.runId || !delegated?.sessionId) {
    throw new Error("delegate_to_hermes did not return runId + durable sessionId");
  }
  if (delegated?.nativeSession !== true) {
    throw new Error("delegate_to_hermes did not report nativeSession=true");
  }
  summary.delegate = {
    runId: delegated.runId,
    sessionId: delegated.sessionId,
    status: delegated.status,
    text: delegated.text,
  };

  const proof = await fs.readFile(proofFile, "utf8");
  summary.proof = proof === proofText;
  if (!summary.proof) {
    throw new Error("Hermes did not create the exact native smoke proof");
  }

  const activity = assertOk(
    await client.callTool({
      name: "hermes_activity",
      arguments: { limit: 10 },
    }),
    "hermes_activity",
  );
  if (!Array.isArray(activity?.records)) {
    throw new Error("hermes_activity did not return records");
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
