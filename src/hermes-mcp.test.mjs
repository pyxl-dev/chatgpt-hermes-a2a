import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { cp, mkdtemp, rm, symlink } from "node:fs/promises";
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
