import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmod, cp, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
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
    assert.equal(names.length, 11, "the 10 native tools plus the read-only timeline");
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
