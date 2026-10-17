import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmod, cp, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const projectRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

function sendJson(response, payload, status = 200) {
  response.writeHead(status, { "Content-Type": "application/json" });
  response.end(JSON.stringify(payload));
}

async function createControlApi({ canceledStatus }) {
  const state = { status: "running", runId: "smoke-run" };
  const server = createServer((request, response) => {
    const url = new URL(request.url, "http://127.0.0.1");
    request.resume();

    if (request.method === "GET" && url.pathname === "/v1/capabilities") {
      sendJson(response, {
        features: {
          run_submission: true,
          run_status: true,
          run_steer: true,
          run_stop: true,
        },
      });
      return;
    }

    if (request.method === "POST" && url.pathname === "/v1/runs") {
      sendJson(response, {
        run_id: state.runId,
        session_id: "smoke-session",
        status: state.status,
      });
      return;
    }

    if (
      request.method === "GET" &&
      url.pathname === "/v1/runs/" + state.runId
    ) {
      sendJson(response, {
        run_id: state.runId,
        session_id: "smoke-session",
        status: state.status,
      });
      return;
    }

    if (request.method === "POST" && url.pathname.endsWith("/steer")) {
      sendJson(response, { run_id: state.runId, accepted: true });
      return;
    }

    if (request.method === "POST" && url.pathname.endsWith("/stop")) {
      state.status = canceledStatus;
      sendJson(response, {
        run_id: state.runId,
        session_id: "smoke-session",
        status: canceledStatus,
      });
      return;
    }

    sendJson(response, { error: { message: "not found" } }, 404);
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });

  return {
    baseUrl: "http://127.0.0.1:" + server.address().port,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

async function createSubmissionApi() {
  const state = { submissions: 0, statusReads: 0 };
  const server = createServer((request, response) => {
    const url = new URL(request.url, "http://127.0.0.1");
    request.resume();

    if (request.method === "POST" && url.pathname === "/v1/runs") {
      state.submissions += 1;
      if (state.submissions === 1) {
        sendJson(response, {
          run_id: "run-rejected",
          session_id: "terminal-session",
          status: "rejected",
          error: { message: "policy rejected" },
        });
      } else {
        sendJson(response, {
          run_id: "run-completed",
          session_id: "terminal-session",
          status: "completed",
        });
      }
      return;
    }

    if (
      request.method === "GET" &&
      url.pathname.startsWith("/v1/runs/")
    ) {
      state.statusReads += 1;
      sendJson(response, {
        run_id: url.pathname.slice("/v1/runs/".length),
        session_id: "terminal-session",
        status: "running",
      });
      return;
    }

    if (request.method === "GET" && url.pathname === "/v1/capabilities") {
      sendJson(response, {
        features: {
          run_submission: true,
          run_status: true,
          run_steer: true,
          run_stop: true,
        },
      });
      return;
    }

    sendJson(response, { error: { message: "not found" } }, 404);
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });

  return {
    state,
    baseUrl: "http://127.0.0.1:" + server.address().port,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

function runProcess(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(
      () => child.kill("SIGKILL"),
      options.timeoutMs || 15_000,
    );

    child.stdout.setEncoding("utf8").on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.setEncoding("utf8").on("data", (chunk) => {
      stderr += chunk;
    });
    child.once("error", reject);
    child.once("close", (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, stdout, stderr });
    });
  });
}

test("synchronous delegate finalizes terminal submission responses without polling", async () => {
  const tempDir = await mkdtemp(
    path.join(os.tmpdir(), "hermes-terminal-submit-"),
  );
  const api = await createSubmissionApi();
  let client = null;

  try {
    const sandboxSrc = path.join(tempDir, "src");
    await cp(path.join(projectRoot, "src"), sandboxSrc, { recursive: true });
    await symlink(
      path.join(projectRoot, "node_modules"),
      path.join(tempDir, "node_modules"),
      "dir",
    );

    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [path.join(sandboxSrc, "hermes-mcp.mjs")],
      cwd: tempDir,
      stderr: "pipe",
      env: {
        ...process.env,
        API_SERVER_KEY: "test-control-key",
        HERMES_API_SERVER_KEY: "test-control-key",
        HERMES_API_SERVER_URL: api.baseUrl,
        HERMES_ACTIVITY_LOG: path.join(tempDir, "activity.jsonl"),
        HERMES_NATIVE_DELEGATE_TIMEOUT_MS: "1000",
        HERMES_NATIVE_DELEGATE_POLL_MS: "100",
      },
    });

    client = new Client(
      { name: "terminal-submission-regression", version: "1.0.0" },
      { capabilities: {} },
    );
    await client.connect(transport);

    const metadata = {
      "openai/session": "terminal-submission-regression",
    };

    const rejected = await client.callTool({
      name: "delegate_to_hermes",
      arguments: {
        instruction: "first rejected terminal submission",
      },
      _meta: metadata,
    });
    assert.equal(rejected.isError, true);
    assert.equal(
      rejected.structuredContent?.error?.code,
      "HERMES_NATIVE_RUN_FAILED",
    );
    assert.equal(
      rejected.structuredContent?.error?.details?.status,
      "rejected",
    );
    assert.equal(
      api.state.statusReads,
      0,
      "terminal rejection must not be polled",
    );

    const completed = await client.callTool({
      name: "delegate_to_hermes",
      arguments: {
        instruction: "second immediately completed submission",
      },
      _meta: metadata,
    });
    assert.notEqual(
      completed.isError,
      true,
      "successful MCP responses may omit isError instead of setting false",
    );
    assert.equal(completed.structuredContent?.status, "completed");
    assert.notEqual(completed.structuredContent?.pending, true);
    assert.equal(
      api.state.submissions,
      2,
      "the failed lease must be released",
    );
    assert.equal(
      api.state.statusReads,
      0,
      "terminal success must not be polled",
    );
  } finally {
    await client?.close();
    await api.close();
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("hermes_tool_timeline is exposed read-only and returns content-free entries", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "hermes-timeline-mcp-"));
  const api = await createControlApi({ canceledStatus: "cancelled" });
  let client = null;
  const secretArgument = "SECRET_CALL_ARGUMENT_VALUE";
  const secretResult = "SECRET_TOOL_RESULT_TEXT";
  const fixture = {
    id: "session-mcp-1",
    title: "timeline fixture",
    source: "api_server",
    started_at: 1000,
    ended_at: 1005,
    message_count: 3,
    messages: [
      {
        role: "assistant",
        timestamp: 1000,
        tool_calls: [
          {
            id: "call-mcp-1",
            type: "function",
            function: {
              name: "terminal",
              arguments: `{"command":"${secretArgument}"}`,
            },
          },
        ],
      },
      {
        role: "tool",
        tool_call_id: "call-mcp-1",
        tool_name: "terminal",
        timestamp: 1002,
        content: `BLOCKED: ${secretResult}`,
      },
    ],
  };

  try {
    const sandboxSrc = path.join(tempDir, "src");
    await cp(path.join(projectRoot, "src"), sandboxSrc, { recursive: true });
    await symlink(
      path.join(projectRoot, "node_modules"),
      path.join(tempDir, "node_modules"),
      "dir",
    );

    const stubBin = path.join(tempDir, "hermes-stub.mjs");
    await writeFile(
      stubBin,
      [
        "#!/usr/bin/env node",
        "import fs from 'node:fs/promises';",
        "const args = process.argv.slice(2);",
        "const marker = args.indexOf('export');",
        "await fs.writeFile(args[marker + 1], process.env.TIMELINE_FIXTURE + '\\n');",
        "process.stdout.write('Exported 1 session');",
        "",
      ].join("\n"),
    );
    await chmod(stubBin, 0o755);

    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [path.join(sandboxSrc, "hermes-mcp.mjs")],
      cwd: tempDir,
      stderr: "pipe",
      env: {
        ...process.env,
        API_SERVER_KEY: "test-control-key",
        HERMES_API_SERVER_KEY: "test-control-key",
        HERMES_API_SERVER_URL: api.baseUrl,
        HERMES_ACTIVITY_LOG: path.join(tempDir, "activity.jsonl"),
        HERMES_BIN: stubBin,
        TIMELINE_FIXTURE: JSON.stringify(fixture),
      },
    });

    client = new Client(
      { name: "timeline-surface", version: "1.0.0" },
      { capabilities: {} },
    );
    await client.connect(transport);

    const listed = await client.listTools();
    const names = (listed.tools || []).map((tool) => tool.name);
    assert.equal(names.length, 12, "the 10 native tools plus the read-only timeline and profile list");
    assert.ok(names.includes("list_hermes_profiles"));
    assert.ok(names.includes("hermes_tool_timeline"));
    assert.ok(names.includes("delegate_to_hermes"), "existing tools stay exposed");

    const missing = await client.callTool({
      name: "hermes_tool_timeline",
      arguments: {},
    });
    assert.equal(missing.isError, true);
    assert.equal(
      missing.structuredContent?.error?.code,
      "HERMES_TIMELINE_TARGET_REQUIRED",
    );

    const timeline = await client.callTool({
      name: "hermes_tool_timeline",
      arguments: { sessionId: "session-mcp-1", runId: "run-mcp-1" },
    });
    assert.notEqual(timeline.isError, true);
    const payload = timeline.structuredContent;
    assert.equal(payload?.ok, true);
    assert.equal(payload?.contentFree, true);
    assert.equal(payload?.scope, "session");
    assert.equal(payload?.requestedRunId, "run-mcp-1");
    assert.equal(payload?.runFilterApplied, false);
    assert.equal(payload?.correlation, "explicit-session-id");
    assert.equal(payload?.entries?.length, 1);
    assert.equal(payload?.entries?.[0]?.toolName, "terminal");
    assert.equal(payload?.entries?.[0]?.errorKind, "blocked");
    assert.equal(payload?.entries?.[0]?.durationMs, 2000);
    assert.equal(payload?.totals?.errorCount, 1);
    assert.equal(
      Object.hasOwn(payload || {}, "runId"),
      false,
      "a per-run label must never be returned",
    );

    const serialized = JSON.stringify(payload);
    assert.equal(serialized.includes(secretArgument), false);
    assert.equal(serialized.includes(secretResult), false);

    // runId alone never borrows the conversation's current canonical session
    // and never claims per-run filtering.
    const byRunId = await client.callTool({
      name: "hermes_tool_timeline",
      arguments: { runId: "run_old_unrelated" },
    });
    assert.notEqual(byRunId.isError, true);
    const byRunIdPayload = byRunId.structuredContent;
    assert.equal(byRunIdPayload?.correlation, "run-id-as-session-id");
    assert.equal(byRunIdPayload?.requestedSessionId, "run_old_unrelated");
    assert.equal(byRunIdPayload?.scope, "session");
    assert.equal(byRunIdPayload?.runFilterApplied, false);
    assert.equal(byRunIdPayload?.requestedRunId, "run_old_unrelated");
    assert.equal(Object.hasOwn(byRunIdPayload || {}, "runId"), false);
  } finally {
    await client?.close();
    await api.close();
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("control smoke accepts both canceled and cancelled terminal statuses", async () => {
  for (const canceledStatus of ["canceled", "cancelled"]) {
    const tempDir = await mkdtemp(
      path.join(os.tmpdir(), "hermes-control-smoke-"),
    );
    const api = await createControlApi({ canceledStatus });

    try {
      const result = await runProcess(
        process.execPath,
        [path.join(projectRoot, "src", "mcp-control-smoke.mjs")],
        {
          cwd: projectRoot,
          env: {
            ...process.env,
            API_SERVER_KEY: "smoke-test-key",
            HERMES_API_SERVER_KEY: "smoke-test-key",
            HERMES_API_SERVER_URL: api.baseUrl,
            HERMES_ACTIVITY_LOG: path.join(tempDir, "activity.jsonl"),
            HERMES_CONTROL_SMOKE_TIMEOUT_MS: "3000",
          },
          timeoutMs: 10_000,
        },
      );

      assert.equal(
        result.code,
        0,
        "control smoke failed for " +
          canceledStatus +
          ":\nstdout:\n" +
          result.stdout +
          "\nstderr:\n" +
          result.stderr,
      );

      const summary = JSON.parse(result.stdout);
      assert.equal(summary.ok, true);
      assert.equal(summary.terminal?.status, canceledStatus);
    } finally {
      await api.close();
      await rm(tempDir, { recursive: true, force: true });
    }
  }
});

async function createPollingApi({ terminalAfterMs = 1200 } = {}) {
  const state = { submissions: 0, statusReads: 0, terminalAt: null };
  const server = createServer((request, response) => {
    const url = new URL(request.url, "http://127.0.0.1");
    request.resume();

    if (request.method === "POST" && url.pathname === "/v1/runs") {
      state.submissions += 1;
      sendJson(response, {
        run_id: "run-polled",
        session_id: "polled-session",
        status: "running",
      });
      return;
    }

    if (request.method === "GET" && url.pathname.startsWith("/v1/runs/")) {
      state.statusReads += 1;
      const runId = url.pathname.slice("/v1/runs/".length);
      if (state.terminalAt === null) {
        state.terminalAt = Date.now() + terminalAfterMs;
      }
      if (Date.now() < state.terminalAt) {
        sendJson(response, {
          run_id: runId,
          session_id: "polled-session",
          status: "running",
        });
      } else {
        sendJson(response, {
          run_id: runId,
          session_id: "polled-session",
          status: "completed",
          output: "polled work finished",
        });
      }
      return;
    }

    if (request.method === "GET" && url.pathname === "/v1/capabilities") {
      sendJson(response, {
        features: {
          run_submission: true,
          run_status: true,
          run_steer: true,
          run_stop: true,
        },
      });
      return;
    }

    sendJson(response, { error: { message: "not found" } }, 404);
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });

  return {
    state,
    baseUrl: "http://127.0.0.1:" + server.address().port,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

async function startBridgeForPollTest(api, tempDir, extraEnv = {}) {
  const sandboxSrc = path.join(tempDir, "src");
  await cp(path.join(projectRoot, "src"), sandboxSrc, { recursive: true });
  await symlink(
    path.join(projectRoot, "node_modules"),
    path.join(tempDir, "node_modules"),
    "dir",
  );

  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(sandboxSrc, "hermes-mcp.mjs")],
    cwd: tempDir,
    stderr: "pipe",
    env: {
      ...process.env,
      API_SERVER_KEY: "test-control-key",
      HERMES_API_SERVER_KEY: "test-control-key",
      HERMES_API_SERVER_URL: api.baseUrl,
      HERMES_ACTIVITY_LOG: path.join(tempDir, "activity.jsonl"),
      HERMES_NATIVE_DELEGATE_TIMEOUT_MS: "1000",
      HERMES_NATIVE_DELEGATE_POLL_MS: "100",
      HERMES_NATIVE_RUN_POLL_WAIT_MS: "5000",
      ...extraEnv,
    },
  });

  const client = new Client(
    { name: "run-poll-regression", version: "1.0.0" },
    { capabilities: {} },
  );
  await client.connect(transport);
  return client;
}

test("read tools are annotated read-only and advertise the delegate-then-poll loop", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "hermes-readonly-hints-"));
  const api = await createPollingApi();
  let client = null;

  try {
    client = await startBridgeForPollTest(api, tempDir);
    const tools = (await client.listTools()).tools;
    const byName = new Map(tools.map((tool) => [tool.name, tool]));

    for (const name of [
      "list_hermes_sessions",
      "get_hermes_session",
      "get_hermes_run",
      "hermes_status",
      "hermes_activity",
      "hermes_tool_timeline",
    ]) {
      assert.equal(
        byName.get(name)?.annotations?.readOnlyHint,
        true,
        name + " must be advertised as read-only so unattended turns are not stopped by a confirmation prompt",
      );
    }

    for (const name of [
      "delegate_to_hermes",
      "continue_hermes_session",
      "start_hermes_run",
      "steer_hermes_run",
      "stop_hermes_run",
    ]) {
      assert.notEqual(
        byName.get(name)?.annotations?.readOnlyHint,
        true,
        name + " mutates the user's machine and must not claim read-only access",
      );
    }

    const getRun = byName.get("get_hermes_run");
    assert.equal(
      getRun?.inputSchema?.required,
      undefined,
      "runId must be optional so a later turn can resume with no argument",
    );

    const instructions = String(client.getInstructions() || "");
    assert.match(instructions, /get_hermes_run/);
    assert.match(instructions, /same turn/i);
  } finally {
    await client?.close();
    await api.close();
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("get_hermes_run without a runId resolves the conversation's active Run and holds the call until terminal", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "hermes-run-poll-"));
  const api = await createPollingApi({ terminalAfterMs: 1200 });
  let client = null;

  try {
    client = await startBridgeForPollTest(api, tempDir);
    const metadata = { "openai/session": "run-poll-regression" };

    const delegated = await client.callTool({
      name: "delegate_to_hermes",
      arguments: { instruction: "long running work" },
      _meta: metadata,
    });
    assert.equal(delegated.structuredContent?.pending, true);
    assert.equal(delegated.structuredContent?.runId, "run-polled");

    const first = await client.callTool({
      name: "get_hermes_run",
      arguments: {},
      _meta: metadata,
    });
    assert.notEqual(first.isError, true);
    assert.equal(first.structuredContent?.runId, "run-polled");
    assert.equal(
      first.structuredContent?.resolution,
      "conversation-active-run",
    );
    assert.equal(first.structuredContent?.status, "completed");
    assert.equal(first.structuredContent?.pending, false);
    assert.ok(
      (first.structuredContent?.waitedMs || 0) >= 100,
      "the read must wait for the Run instead of returning immediately; waitedMs=" +
        String(first.structuredContent?.waitedMs),
    );
    assert.ok(
      api.state.statusReads >= 3,
      "the bridge must poll the Run, not read it once",
    );
  } finally {
    await client?.close();
    await api.close();
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("get_hermes_run without a runId answers no-active-run when nothing is bound", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "hermes-run-idle-"));
  const api = await createPollingApi();
  let client = null;

  try {
    client = await startBridgeForPollTest(api, tempDir, {
      HERMES_NATIVE_RUN_POLL_WAIT_MS: "0",
    });

    const result = await client.callTool({
      name: "get_hermes_run",
      arguments: {},
      _meta: { "openai/session": "idle-conversation" },
    });
    assert.notEqual(result.isError, true);
    assert.equal(result.structuredContent?.ok, true);
    assert.equal(result.structuredContent?.status, "no-active-run");
    assert.equal(result.structuredContent?.runId, null);
    assert.equal(
      api.state.statusReads,
      0,
      "an idle conversation must not hit the Runs API",
    );
  } finally {
    await client?.close();
    await api.close();
    await rm(tempDir, { recursive: true, force: true });
  }
});
async function createFakeDiscord() {
  const messages = [];
  const server = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => {
      body += chunk;
    });
    request.on("end", () => {
      messages.push({ path: request.url, body: JSON.parse(body || "{}") });
      response.writeHead(204);
      response.end();
    });
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  return {
    messages,
    baseUrl: "http://127.0.0.1:" + server.address().port,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

async function waitFor(predicate, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return predicate();
}

function notifyEnv(discord) {
  return {
    HERMES_A2A_DISCORD_WEBHOOK_URL: discord.baseUrl + "/api/webhooks/1/test-token",
    HERMES_A2A_NOTIFY_POLL_MS: "100",
    HERMES_A2A_NOTIFY_GRACE_MS: "200",
  };
}

test("a Run ChatGPT stopped polling is announced on Discord when it finishes", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "hermes-run-notify-"));
  const api = await createPollingApi({ terminalAfterMs: 1200 });
  const discord = await createFakeDiscord();
  let client = null;

  try {
    client = await startBridgeForPollTest(api, tempDir, notifyEnv(discord));
    const delegated = await client.callTool({
      name: "delegate_to_hermes",
      arguments: { instruction: "abandoned long work" },
      _meta: { "openai/session": "abandoned-conversation" },
    });
    assert.equal(delegated.structuredContent?.pending, true);

    // ChatGPT never calls get_hermes_run again.
    assert.ok(
      await waitFor(() => discord.messages.length > 0, 8000),
      "the finished Run must be announced",
    );
    const [message] = discord.messages;
    assert.equal(message.path, "/api/webhooks/1/test-token");
    assert.deepEqual(message.body.allowed_mentions, { parse: [] });
    assert.match(message.body.content, /completed/);
    assert.match(message.body.content, /abandoned long work/);
    assert.match(message.body.content, /run-polled/);
    assert.doesNotMatch(message.body.content, /polled work finished/, "Hermes output must not be sent");

    await new Promise((resolve) => setTimeout(resolve, 600));
    assert.equal(discord.messages.length, 1, "exactly one notification per Run");
  } finally {
    await client?.close();
    await discord.close();
    await api.close();
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("a Run ChatGPT collects itself is never announced", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "hermes-run-quiet-"));
  const api = await createPollingApi({ terminalAfterMs: 1200 });
  const discord = await createFakeDiscord();
  let client = null;

  try {
    client = await startBridgeForPollTest(api, tempDir, {
      ...notifyEnv(discord),
      HERMES_A2A_NOTIFY_GRACE_MS: "1500",
    });
    const metadata = { "openai/session": "attentive-conversation" };
    const delegated = await client.callTool({
      name: "delegate_to_hermes",
      arguments: { instruction: "watched work" },
      _meta: metadata,
    });
    assert.equal(delegated.structuredContent?.pending, true);

    const polled = await client.callTool({
      name: "get_hermes_run",
      arguments: {},
      _meta: metadata,
    });
    assert.equal(polled.structuredContent?.status, "completed");

    await new Promise((resolve) => setTimeout(resolve, 2500));
    assert.equal(discord.messages.length, 0);
  } finally {
    await client?.close();
    await discord.close();
    await api.close();
    await rm(tempDir, { recursive: true, force: true });
  }
});

async function createSlotsApi({ maxConcurrent = 10 } = {}) {
  const state = { submissions: [], runs: new Map(), statusReads: 0 };
  const server = createServer((request, response) => {
    const url = new URL(request.url, "http://127.0.0.1");
    let body = "";
    request.on("data", (chunk) => {
      body += chunk;
    });
    request.on("end", () => {
      const now = Date.now();
      const running = [...state.runs.values()].filter(
        (run) => now < run.terminalAt,
      ).length;

      if (request.method === "POST" && url.pathname === "/v1/runs") {
        const input = JSON.parse(body || "{}");
        if (running >= maxConcurrent) {
          sendJson(
            response,
            { error: { message: "Too many concurrent runs" } },
            429,
          );
          return;
        }
        const index = state.submissions.length + 1;
        const run = {
          runId: "run-" + index,
          sessionId: input.session_id || "session-" + index,
          terminalAt: now + (/slow/u.test(input.input) ? 2500 : 700),
        };
        state.runs.set(run.runId, run);
        state.submissions.push({ ...input, runId: run.runId });
        sendJson(response, {
          run_id: run.runId,
          session_id: run.sessionId,
          status: "running",
        });
        return;
      }

      if (request.method === "GET" && url.pathname.startsWith("/v1/runs/")) {
        state.statusReads += 1;
        const run = state.runs.get(url.pathname.slice("/v1/runs/".length));
        if (!run) {
          sendJson(response, { error: { message: "run not found" } }, 404);
          return;
        }
        sendJson(response, {
          run_id: run.runId,
          session_id: run.sessionId,
          status: now < run.terminalAt ? "running" : "completed",
          ...(now < run.terminalAt ? {} : { output: run.runId + " done" }),
        });
        return;
      }

      sendJson(response, { error: { message: "not found" } }, 404);
    });
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });

  return {
    state,
    baseUrl: "http://127.0.0.1:" + server.address().port,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

test("one conversation drives two slots in parallel and collects both Runs", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "hermes-slots-bridge-"));
  const api = await createSlotsApi();
  let client = null;

  try {
    client = await startBridgeForPollTest(api, tempDir, {
      HERMES_NATIVE_DELEGATE_TIMEOUT_MS: "1000",
    });
    const metadata = { "openai/session": "parallel-conversation" };
    const call = (name, args) =>
      client.callTool({ name, arguments: args, _meta: metadata });

    const tools = (await client.listTools()).tools;
    for (const name of [
      "delegate_to_hermes",
      "continue_hermes_session",
      "start_hermes_run",
      "get_hermes_run",
      "steer_hermes_run",
      "stop_hermes_run",
    ]) {
      const slot = tools.find((tool) => tool.name === name)?.inputSchema
        ?.properties?.slot;
      assert.equal(slot?.maximum, 3, name + " must accept an optional slot");
    }
    assert.match(String(client.getInstructions()), /slot 2 or 3/i);

    const first = await call("delegate_to_hermes", {
      instruction: "slow refactor of module A",
    });
    assert.equal(first.structuredContent?.pending, true);
    assert.equal(first.structuredContent?.slot, 1);
    assert.equal(first.structuredContent?.warnings, undefined);

    const busy = await call("delegate_to_hermes", {
      instruction: "unrelated question",
    });
    assert.equal(busy.isError, true);
    assert.equal(busy.structuredContent?.error?.code, "HERMES_SESSION_BUSY");
    assert.deepEqual(busy.structuredContent?.error?.details?.freeSlots, [2, 3]);

    const second = await call("start_hermes_run", {
      instruction: "independent docs fix",
      slot: 2,
    });
    assert.notEqual(second.isError, true);
    assert.equal(second.structuredContent?.slot, 2);
    assert.equal(second.structuredContent?.parallelRuns?.[0]?.slot, 1);
    assert.match(
      second.structuredContent?.warnings?.[0] || "",
      /same Mac workspace/,
    );

    const seen = new Map();
    let sawAllSlots = false;
    for (let attempt = 0; attempt < 6; attempt += 1) {
      const polled = await call("get_hermes_run", {});
      assert.notEqual(polled.isError, true);
      const content = polled.structuredContent;
      for (const run of content.runs || [content]) {
        if (run.runId && run.pending === false) seen.set(run.slot, run);
      }
      if (seen.size === 2) break;
      if (!content.runs) {
        assert.equal(content.resolution, "conversation-active-run");
      } else {
        assert.equal(content.resolution, "conversation-active-slots");
        assert.equal(content.runs.length, 2);
        sawAllSlots = true;
      }
    }
    assert.ok(sawAllSlots, "get_hermes_run must report every busy slot at once");
    assert.equal(seen.get(1)?.runId, "run-1");
    assert.equal(seen.get(1)?.status, "completed");
    assert.equal(seen.get(2)?.runId, "run-2");
    assert.equal(seen.get(2)?.output, "run-2 done");

    // Slot 2 keeps its own Hermes session for follow-ups.
    const followUp = await call("start_hermes_run", {
      instruction: "follow-up on the docs",
      slot: 2,
    });
    assert.equal(followUp.structuredContent?.slot, 2);
    assert.equal(api.state.submissions.at(-1).session_id, "session-2");

    const idle = await call("get_hermes_run", { slot: 1 });
    assert.equal(idle.structuredContent?.status, "no-active-run");
    assert.equal(idle.structuredContent?.sessionId, "session-1");

    // An explicit runId finds its slot without the slot argument.
    const byRunId = await call("get_hermes_run", { runId: followUp.structuredContent.runId });
    assert.equal(byRunId.structuredContent?.slot, 2);
    assert.equal(byRunId.structuredContent?.status, "completed");
  } finally {
    await client?.close();
    await api.close();
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("Hermes' global Run cap surfaces as a clear error and frees the slot", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "hermes-slots-cap-"));
  const api = await createSlotsApi({ maxConcurrent: 1 });
  let client = null;

  try {
    client = await startBridgeForPollTest(api, tempDir, {
      HERMES_NATIVE_RUN_POLL_WAIT_MS: "0",
    });
    const metadata = { "openai/session": "capped-conversation" };
    const call = (name, args) =>
      client.callTool({ name, arguments: args, _meta: metadata });

    const first = await call("start_hermes_run", { instruction: "slow one" });
    assert.notEqual(first.isError, true);

    const rejected = await call("start_hermes_run", {
      instruction: "slow two",
      slot: 3,
    });
    assert.equal(rejected.isError, true);
    assert.equal(
      rejected.structuredContent?.error?.code,
      "HERMES_RUN_CAPACITY_EXHAUSTED",
    );

    const slot3 = await call("get_hermes_run", { slot: 3 });
    assert.equal(slot3.structuredContent?.status, "no-active-run");
  } finally {
    await client?.close();
    await api.close();
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("with several slots running, every answer steers ChatGPT to one no-argument get_hermes_run", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "hermes-slots-guidance-"));
  const api = await createSlotsApi();
  let client = null;

  try {
    client = await startBridgeForPollTest(api, tempDir, {
      HERMES_NATIVE_RUN_POLL_WAIT_MS: "0",
    });
    const metadata = { "openai/session": "guided-conversation" };
    const call = (name, args) =>
      client.callTool({ name, arguments: args, _meta: metadata });

    assert.match(String(client.getInstructions()), /NO arguments/);
    const getRun = (await client.listTools()).tools.find(
      (tool) => tool.name === "get_hermes_run",
    );
    assert.match(getRun.description, /^Wait for and read Hermes Runs\. Call it with NO arguments/);

    const first = await call("start_hermes_run", { instruction: "slow job one" });
    assert.equal(first.structuredContent?.pollWith, undefined, "a lone slot keeps the usual guidance");

    const second = await call("start_hermes_run", {
      instruction: "slow job two",
      slot: 2,
    });
    assert.equal(second.structuredContent?.pollWith, "get_hermes_run with no arguments");
    assert.match(second.structuredContent?.nextStep || "", /NO arguments/);

    const perSlot = await call("get_hermes_run", { slot: 2 });
    assert.equal(perSlot.structuredContent?.pending, true);
    assert.deepEqual(perSlot.structuredContent?.otherActiveSlots, [1]);
    assert.match(perSlot.structuredContent?.nextStep || "", /NO arguments/);

    const all = await call("get_hermes_run", {});
    assert.equal(all.structuredContent?.resolution, "conversation-active-slots");
    assert.match(all.structuredContent?.nextStep || "", /no arguments/);
  } finally {
    await client?.close();
    await api.close();
    await rm(tempDir, { recursive: true, force: true });
  }
});

async function createProfileApi() {
  const keys = { "": "test-control-key", "/p/rea": "rea-key" };
  const state = { requests: [], runs: new Map() };
  const server = createServer((request, response) => {
    const url = new URL(request.url, "http://127.0.0.1");
    let body = "";
    request.on("data", (chunk) => {
      body += chunk;
    });
    request.on("end", () => {
      const match = /^(\/p\/[^/]+)?(\/v1\/.*)$/u.exec(url.pathname);
      const prefix = match?.[1] || "";
      const route = match?.[2] || url.pathname;
      state.requests.push({
        method: request.method,
        prefix,
        route,
        auth: request.headers.authorization,
      });
      if (!(prefix in keys)) {
        sendJson(response, { error: "Unknown or unconfigured profile" }, 404);
        return;
      }
      if (request.headers.authorization !== "Bearer " + keys[prefix]) {
        sendJson(response, { error: { message: "Invalid gateway API key" } }, 401);
        return;
      }
      if (request.method === "POST" && route === "/v1/runs") {
        const input = JSON.parse(body || "{}");
        const runId = "run-" + (state.runs.size + 1);
        state.runs.set(runId, {
          prefix,
          sessionId: input.session_id || (prefix ? "rea-session" : "default-session"),
          terminalAt: Date.now() + 1500,
        });
        sendJson(response, {
          run_id: runId,
          session_id: state.runs.get(runId).sessionId,
          status: "running",
        });
        return;
      }
      if (request.method === "GET" && route.startsWith("/v1/runs/")) {
        const runId = route.slice("/v1/runs/".length);
        const run = state.runs.get(runId);
        if (!run || run.prefix !== prefix) {
          sendJson(response, { error: { message: "run not found" } }, 404);
          return;
        }
        const done = Date.now() >= run.terminalAt;
        sendJson(response, {
          run_id: runId,
          session_id: run.sessionId,
          status: done ? "completed" : "running",
          ...(done ? { output: "done in " + (prefix || "default") } : {}),
        });
        return;
      }
      sendJson(response, { error: { message: "not found" } }, 404);
    });
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  return {
    state,
    baseUrl: "http://127.0.0.1:" + server.address().port,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

test("ChatGPT picks a Hermes profile and the slot keeps routing to it", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "hermes-profile-bridge-"));
  const hermesHome = path.join(tempDir, "hermes-home");
  await mkdir(path.join(hermesHome, "profiles", "rea"), { recursive: true });
  await mkdir(path.join(hermesHome, "profiles", "youtube"), { recursive: true });
  await writeFile(
    path.join(hermesHome, "profiles", "rea", "profile.yaml"),
    "description: Reverse engineering\n",
  );
  await writeFile(path.join(hermesHome, "profiles", "rea", ".env"), "API_SERVER_KEY=rea-key\n");
  await writeFile(
    path.join(hermesHome, "profiles", "youtube", "profile.yaml"),
    "description: YouTube channel\n",
  );
  const api = await createProfileApi();
  let client = null;

  try {
    client = await startBridgeForPollTest(api, tempDir, {
      HERMES_ROOT_HOME: hermesHome,
      HERMES_NATIVE_DELEGATE_TIMEOUT_MS: "1000",
    });
    const metadata = { "openai/session": "profile-conversation" };
    const call = (name, args) =>
      client.callTool({ name, arguments: args, _meta: metadata });

    assert.match(String(client.getInstructions()), /list_hermes_profiles/);
    const listed = await call("list_hermes_profiles", {});
    assert.deepEqual(
      listed.structuredContent.profiles.map((profile) => [profile.name, profile.available]),
      [["default", true], ["rea", true], ["youtube", false]],
    );
    assert.doesNotMatch(JSON.stringify(listed), /rea-key|test-control-key/);

    const started = await call("delegate_to_hermes", {
      instruction: "slow analysis of the firmware",
      profile: "rea",
    });
    assert.notEqual(started.isError, true);
    assert.equal(started.structuredContent.pending, true);
    assert.equal(started.structuredContent.profile, "rea");

    let polled = null;
    for (let attempt = 0; attempt < 4; attempt += 1) {
      polled = await call("get_hermes_run", {});
      if (polled.structuredContent?.pending === false) break;
    }
    assert.equal(polled.structuredContent.status, "completed");
    assert.equal(polled.structuredContent.output, "done in /p/rea");
    assert.equal(polled.structuredContent.profile, "rea");

    const runCalls = api.state.requests.filter((entry) => entry.route.startsWith("/v1/runs"));
    assert.ok(runCalls.length >= 2);
    for (const entry of runCalls) {
      assert.equal(entry.prefix, "/p/rea", "every Run call must stay in the rea profile");
      assert.equal(entry.auth, "Bearer rea-key");
    }

    const mismatch = await call("delegate_to_hermes", {
      instruction: "write a script",
      profile: "default",
    });
    assert.equal(mismatch.structuredContent?.error?.code, "HERMES_PROFILE_MISMATCH");

    const unconfigured = await call("start_hermes_run", {
      instruction: "thumbnail ideas",
      profile: "youtube",
      slot: 2,
    });
    assert.equal(unconfigured.structuredContent?.error?.code, "HERMES_PROFILE_NOT_CONFIGURED");
    const freed = await call("get_hermes_run", { slot: 2 });
    assert.equal(freed.structuredContent?.status, "no-active-run");
  } finally {
    await client?.close();
    await api.close();
    await rm(tempDir, { recursive: true, force: true });
  }
});
