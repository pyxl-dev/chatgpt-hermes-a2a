import assert from "node:assert/strict";
import { chmod, mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  controlIdempotencyKey,
  createHermesControl,
  resolveHermesApiUrl,
} from "./hermes-control.mjs";

const projectRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

test("native idempotency key is scoped by ChatGPT conversation", () => {
  const nowMs = 1_800_000;
  const a = controlIdempotencyKey(
    null,
    "same instruction",
    "chatgpt-scope-a",
    nowMs,
  );
  const b = controlIdempotencyKey(
    null,
    "same instruction",
    "chatgpt-scope-b",
    nowMs,
  );
  const aRetry = controlIdempotencyKey(
    null,
    "same instruction",
    "chatgpt-scope-a",
    nowMs,
  );

  assert.notEqual(a, b);
  assert.equal(a, aRetry);
});

test("native idempotency key keeps durable session and instruction boundaries", () => {
  const nowMs = 1_800_000;
  const base = controlIdempotencyKey(
    "session-a",
    "instruction-a",
    "chatgpt-scope-a",
    nowMs,
  );

  assert.notEqual(
    base,
    controlIdempotencyKey(
      "session-b",
      "instruction-a",
      "chatgpt-scope-a",
      nowMs,
    ),
  );
  assert.notEqual(
    base,
    controlIdempotencyKey(
      "session-a",
      "instruction-b",
      "chatgpt-scope-a",
      nowMs,
    ),
  );
});

test("native idempotency key is stable across normalized retry text", () => {
  const base = controlIdempotencyKey(
    "session-a",
    "do  x",
    "operation-token",
    1_800_000,
  );
  const retry = controlIdempotencyKey(
    "session-a",
    "do x",
    "operation-token",
    1_920_000,
  );
  const unicodeRetry = controlIdempotencyKey(
    "session-a",
    "do\u00a0x",
    "operation-token",
    1_920_000,
  );

  assert.equal(base, retry);
  assert.equal(base, unicodeRetry);
});

test("scoped native idempotency remains stable across minute boundaries", () => {
  const first = controlIdempotencyKey(
    "session-a",
    "same instruction",
    "operation-token",
    1_800_000,
  );
  const later = controlIdempotencyKey(
    "session-a",
    "same instruction",
    "operation-token",
    1_920_000,
  );
  assert.equal(first, later);

  const unscopedFirst = controlIdempotencyKey(
    "session-a",
    "same instruction",
    "unscoped",
    1_800_000,
  );
  const unscopedLater = controlIdempotencyKey(
    "session-a",
    "same instruction",
    "unscoped",
    1_920_000,
  );
  assert.notEqual(unscopedFirst, unscopedLater);
});

test("native control URL validates explicit port overrides", () => {
  assert.equal(
    resolveHermesApiUrl(null, "9000"),
    "http://127.0.0.1:9000",
  );

  for (const invalid of ["0", "70000", "abc", "", "  ", "12.5"]) {
    assert.equal(
      resolveHermesApiUrl(null, invalid),
      "http://127.0.0.1:8642",
      "invalid port " + JSON.stringify(invalid) + " should use default URL",
    );
  }
});

test("explicit Hermes API URL takes precedence over port", () => {
  assert.equal(
    resolveHermesApiUrl("http://127.0.0.1:9999///", "70000"),
    "http://127.0.0.1:9999",
  );
});

test("status script trims API URL whitespace and all trailing slashes", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "hermes-status-url-"));
  const curlPath = path.join(tempDir, "curl");
  const launchctlPath = path.join(tempDir, "launchctl");
  const capturedUrlsPath = path.join(tempDir, "curl-urls.txt");
  try {
    await writeFile(
      curlPath,
      "#!/bin/bash\n" +
        "for arg in \"$@\"; do url=\"$arg\"; done\n" +
        "printf '%s\\n' \"$url\" >> \"$STATUS_CURL_CAPTURE\"\n" +
        "if [[ \"$url\" == */v1/capabilities ]]; then\n" +
        "  printf '%s\\n' '{\"features\":{\"run_submission\":true,\"run_status\":true}}'\n" +
        "fi\n" +
        "exit 0\n",
      "utf8",
    );
    await chmod(curlPath, 0o755);
    await writeFile(launchctlPath, "#!/bin/bash\nexit 1\n", "utf8");
    await chmod(launchctlPath, 0o755);

    spawnSync("bash", [path.join(projectRoot, "scripts", "status.sh")], {
      cwd: projectRoot,
      encoding: "utf8",
      env: {
        ...process.env,
        HOME: tempDir,
        PATH: tempDir + path.delimiter + process.env.PATH,
        API_SERVER_PORT: "8642",
        HERMES_API_SERVER_KEY: "test-key",
        HERMES_API_SERVER_URL: " \t https://hermes.example/api/// \n",
        STATUS_CURL_CAPTURE: capturedUrlsPath,
      },
    });

    const capturedUrls = (await readFile(capturedUrlsPath, "utf8"))
      .trim()
      .split("\n");
    assert.ok(
      capturedUrls.includes("https://hermes.example/api/v1/capabilities"),
      "status should request capabilities from the trimmed base URL",
    );
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("native run status supports a shorter per-poll timeout", async () => {
  const originalFetch = globalThis.fetch;
  const originalKey = process.env.HERMES_API_SERVER_KEY;
  try {
    process.env.HERMES_API_SERVER_KEY = "test-key";
    globalThis.fetch = (_url, options = {}) =>
      new Promise((_resolve, reject) => {
        const onAbort = () => {
          const error = new Error("aborted");
          error.name = "AbortError";
          reject(error);
        };
        if (options.signal?.aborted) {
          onAbort();
        } else {
          options.signal?.addEventListener("abort", onAbort, { once: true });
        }
      });

    const control = createHermesControl({
      redactText: String,
      redactValue: (value) => value,
    });

    const startedAt = Date.now();
    await assert.rejects(
      control.getRun("run-timeout", { timeoutMs: 20 }),
      /timed out after 20ms/,
    );
    assert.ok(
      Date.now() - startedAt < 250,
      "per-poll timeout should bound a status request well below the default 30s",
    );
  } finally {
    globalThis.fetch = originalFetch;
    if (originalKey === undefined) {
      delete process.env.HERMES_API_SERVER_KEY;
    } else {
      process.env.HERMES_API_SERVER_KEY = originalKey;
    }
  }
});

test("status script falls back when API URL is whitespace only", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "hermes-status-blank-url-"));
  const curlPath = path.join(tempDir, "curl");
  const launchctlPath = path.join(tempDir, "launchctl");
  const capturedUrlsPath = path.join(tempDir, "curl-urls.txt");
  try {
    await writeFile(
      curlPath,
      "#!/bin/bash\n" +
        "for arg in \"$@\"; do url=\"$arg\"; done\n" +
        "printf '%s\\n' \"$url\" >> \"$STATUS_CURL_CAPTURE\"\n" +
        "if [[ \"$url\" == */v1/capabilities ]]; then\n" +
        "  printf '%s\\n' '{\"features\":{\"run_submission\":true,\"run_status\":true}}'\n" +
        "fi\n" +
        "exit 0\n",
      "utf8",
    );
    await chmod(curlPath, 0o755);
    await writeFile(launchctlPath, "#!/bin/bash\nexit 1\n", "utf8");
    await chmod(launchctlPath, 0o755);

    spawnSync("bash", [path.join(projectRoot, "scripts", "status.sh")], {
      cwd: projectRoot,
      encoding: "utf8",
      env: {
        ...process.env,
        HOME: tempDir,
        PATH: tempDir + path.delimiter + process.env.PATH,
        API_SERVER_PORT: "9001",
        HERMES_API_SERVER_KEY: "test-key",
        HERMES_API_SERVER_URL: "   \t \n",
        STATUS_CURL_CAPTURE: capturedUrlsPath,
      },
    });

    const capturedUrls = (await readFile(capturedUrlsPath, "utf8"))
      .trim()
      .split("\n");
    assert.ok(
      capturedUrls.includes("http://127.0.0.1:9001/v1/capabilities"),
      "blank normalized URL should fall back to the resolved loopback port",
    );
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("definitive terminal submission without run id is not treated as ambiguous", async () => {
  const originalFetch = globalThis.fetch;
  const originalKey = process.env.HERMES_API_SERVER_KEY;
  const originalUrl = process.env.HERMES_API_SERVER_URL;
  try {
    process.env.HERMES_API_SERVER_KEY = "test-key";
    process.env.HERMES_API_SERVER_URL = "http://127.0.0.1:8642";
    globalThis.fetch = async () =>
      new Response(
        JSON.stringify({
          status: "rejected",
          error: { message: "policy rejected" },
        }),
        {
          status: 200,
          headers: { "Content-Type": "application/json" },
        },
      );

    const control = createHermesControl({
      redactText: String,
      redactValue: (value) => value,
    });

    await assert.rejects(
      control.startRun("rejected work", null, "scope"),
      (error) =>
        error?.code === "HERMES_NATIVE_RUN_FAILED" &&
        error?.deliveryAmbiguous === false &&
        error?.details?.status === "rejected",
    );
  } finally {
    globalThis.fetch = originalFetch;
    if (originalKey === undefined) {
      delete process.env.HERMES_API_SERVER_KEY;
    } else {
      process.env.HERMES_API_SERVER_KEY = originalKey;
    }
    if (originalUrl === undefined) {
      delete process.env.HERMES_API_SERVER_URL;
    } else {
      process.env.HERMES_API_SERVER_URL = originalUrl;
    }
  }
});

test("malformed control URL fails definitively before submission", async () => {
  const originalFetch = globalThis.fetch;
  const originalKey = process.env.HERMES_API_SERVER_KEY;
  const originalUrl = process.env.HERMES_API_SERVER_URL;
  try {
    process.env.HERMES_API_SERVER_KEY = "test-key";
    process.env.HERMES_API_SERVER_URL = "not a valid url";
    let fetchCalled = false;
    globalThis.fetch = async () => {
      fetchCalled = true;
      throw new Error("fetch should not be called");
    };

    const control = createHermesControl({
      redactText: String,
      redactValue: (value) => value,
    });

    await assert.rejects(
      control.startRun("work", null, "scope"),
      (error) => error?.deliveryAmbiguous === false,
    );
    assert.equal(fetchCalled, false);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalKey === undefined) {
      delete process.env.HERMES_API_SERVER_KEY;
    } else {
      process.env.HERMES_API_SERVER_KEY = originalKey;
    }
    if (originalUrl === undefined) {
      delete process.env.HERMES_API_SERVER_URL;
    } else {
      process.env.HERMES_API_SERVER_URL = originalUrl;
    }
  }
});

test("invalid authorization header fails definitively before submission", async () => {
  const originalFetch = globalThis.fetch;
  const originalKey = process.env.HERMES_API_SERVER_KEY;
  const originalUrl = process.env.HERMES_API_SERVER_URL;
  try {
    process.env.HERMES_API_SERVER_KEY = "bad\nkey";
    process.env.HERMES_API_SERVER_URL = "http://127.0.0.1:8642";
    let fetchCalled = false;
    globalThis.fetch = async () => {
      fetchCalled = true;
      throw new Error("fetch should not be called");
    };

    const control = createHermesControl({
      redactText: String,
      redactValue: (value) => value,
    });

    await assert.rejects(
      control.startRun("work", null, "scope"),
      (error) => error?.deliveryAmbiguous === false,
    );
    assert.equal(fetchCalled, false);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalKey === undefined) {
      delete process.env.HERMES_API_SERVER_KEY;
    } else {
      process.env.HERMES_API_SERVER_KEY = originalKey;
    }
    if (originalUrl === undefined) {
      delete process.env.HERMES_API_SERVER_URL;
    } else {
      process.env.HERMES_API_SERVER_URL = originalUrl;
    }
  }
});
