import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { parseRunnerArgs, RunnerUsageError } from "./bounded-log-runner.mjs";

const projectRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const runnerPath = path.join(projectRoot, "src", "bounded-log-runner.mjs");

function runProcess(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env || process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(
      () => child.kill("SIGKILL"),
      options.timeoutMs || 20_000,
    );
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.once("error", reject);
    child.once("close", (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, stdout, stderr });
    });
  });
}

async function readSegments(filePath, backups) {
  const parts = [];
  for (let index = backups; index >= 1; index -= 1) {
    try {
      parts.push(await fs.readFile(filePath + "." + index, "utf8"));
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }
  try {
    parts.push(await fs.readFile(filePath, "utf8"));
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  return parts.join("");
}

test("parseRunnerArgs validates the bounded log runner surface", () => {
  const parsed = parseRunnerArgs([
    "--file",
    "/tmp/out.log",
    "--max-bytes",
    "4096",
    "--backups",
    "2",
    "--",
    "/bin/echo",
    "hello",
  ]);
  assert.equal(parsed.file, "/tmp/out.log");
  assert.equal(parsed.errFile, null);
  assert.equal(parsed.maxBytes, 4096);
  assert.equal(parsed.backups, 2);
  assert.equal(parsed.command, "/bin/echo");
  assert.deepEqual(parsed.args, ["hello"]);

  assert.throws(() => parseRunnerArgs(["--max-bytes", "10"]), RunnerUsageError);
  assert.throws(() => parseRunnerArgs(["--file", "/tmp/x.log"]), RunnerUsageError);
  assert.equal(
    parseRunnerArgs(["--file", "/tmp/x.log", "--", "/bin/echo"]).maxBytes,
    2_000_000,
  );
  assert.throws(
    () =>
      parseRunnerArgs([
        "--file",
        "/tmp/x.log",
        "--max-bytes",
        "512",
        "--",
        "/bin/echo",
      ]),
    RunnerUsageError,
  );
});

test("bounded log runner rotates segments, keeps every byte and propagates exit code", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "hermes-log-runner-"));
  const childScript = path.join(dir, "child.mjs");
  const outLog = path.join(dir, "chatgpt-hermes-a2a.out.log");
  const errLog = path.join(dir, "chatgpt-hermes-a2a.err.log");

  await fs.writeFile(
    childScript,
    [
      "for (let index = 0; index < 10; index += 1) {",
      "  process.stdout.write('a'.repeat(200));",
      "  process.stderr.write('b'.repeat(200));",
      "  await new Promise((resolve) => setTimeout(resolve, 10));",
      "}",
      "process.exit(3);",
      "",
    ].join("\n"),
  );

  try {
    const result = await runProcess(
      process.execPath,
      [
        runnerPath,
        "--file",
        outLog,
        "--err-file",
        errLog,
        "--max-bytes",
        "1024",
        "--backups",
        "2",
        "--",
        process.execPath,
        childScript,
      ],
      { cwd: dir },
    );

    assert.equal(result.code, 3, "child exit code must be propagated: " + result.stderr);
    assert.deepEqual(result.signal, null);

    const stdoutText = await readSegments(outLog, 2);
    const stderrText = await readSegments(errLog, 2);
    assert.equal(stdoutText, "a".repeat(2000), "no stdout byte may be lost");
    assert.equal(stderrText, "b".repeat(2000), "no stderr byte may be lost");

    const base = await fs.stat(outLog);
    assert.ok(base.size < 2000, "the live segment must have been rotated");
    const rotated = await fs.stat(outLog + ".1");
    assert.ok(rotated.size > 0);
    await assert.rejects(fs.stat(outLog + ".3"), { code: "ENOENT" });

    const mode = (await fs.stat(outLog)).mode & 0o777;
    assert.equal(mode, 0o600, "rotated logs must stay owner-only");
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("bounded log runner bounds total bytes across repeated restarts", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "hermes-log-restart-"));
  const childScript = path.join(dir, "child.mjs");
  const outLog = path.join(dir, "restart.out.log");
  const maxBytes = 1024;
  const backups = 2;

  await fs.writeFile(
    childScript,
    [
      "for (let index = 0; index < 12; index += 1) {",
      "  process.stdout.write('c'.repeat(200));",
      "  await new Promise((resolve) => setTimeout(resolve, 5));",
      "}",
      "",
    ].join("\n"),
  );

  try {
    for (let start = 0; start < 3; start += 1) {
      const result = await runProcess(
        process.execPath,
        [
          runnerPath,
          "--file",
          outLog,
          "--max-bytes",
          String(maxBytes),
          "--backups",
          String(backups),
          "--",
          process.execPath,
          childScript,
        ],
        { cwd: dir },
      );
      assert.equal(result.code, 0, result.stderr);
    }

    const segments = [outLog, outLog + ".1", outLog + ".2"];
    const sizes = [];
    for (const segment of segments) {
      const stats = await fs.stat(segment);
      sizes.push(stats.size);
    }
    // Strictly bounded: chunks are sliced so no segment exceeds the cap.
    assert.ok(
      sizes.every((size) => size <= maxBytes),
      "segments must not exceed the cap: " + sizes.join(","),
    );
    assert.ok(
      sizes.reduce((total, size) => total + size, 0) <= maxBytes * (backups + 1),
      "total bytes must stay bounded across restarts",
    );
    await assert.rejects(fs.stat(outLog + ".3"), { code: "ENOENT" });
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("bounded log runner reasons about oversized and bursty chunks", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "hermes-log-chunks-"));
  const oversized = path.join(dir, "oversized.out.log");
  const burst = path.join(dir, "burst.out.log");
  const maxBytes = 1024;

  const oversizedScript = path.join(dir, "oversized.mjs");
  await fs.writeFile(
    oversizedScript,
    [
      "// One single 8 KB chunk: it must be sliced across rotations.",
      "process.stdout.write('z'.repeat(8192));",
      "",
    ].join("\n"),
  );

  const burstScript = path.join(dir, "burst.mjs");
  await fs.writeFile(
    burstScript,
    [
      "// 200 rapid chunks of 100 bytes with ordered, unique markers.",
      "for (let index = 0; index < 200; index += 1) {",
      "  process.stdout.write(String(index).padStart(3, '0').repeat(33) + 'x');",
      "}",
      "",
    ].join("\n"),
  );

  try {
    const oversizedRun = await runProcess(
      process.execPath,
      [
        runnerPath,
        "--file",
        oversized,
        "--max-bytes",
        String(maxBytes),
        "--backups",
        "3",
        "--",
        process.execPath,
        oversizedScript,
      ],
      { cwd: dir },
    );
    assert.equal(oversizedRun.code, 0, oversizedRun.stderr);

    const oversizedPayload = "z".repeat(8192);
    const oversizedSegments = await readSegments(oversized, 3);
    assert.ok(
      oversizedPayload.endsWith(oversizedSegments),
      "the surviving bytes must be an uncorrupted tail of the payload",
    );
    for (const candidate of [oversized, oversized + ".1", oversized + ".2", oversized + ".3"]) {
      const stats = await fs.stat(candidate).catch(() => null);
      if (!stats) continue;
      assert.ok(
        stats.size <= maxBytes,
        candidate + " must not exceed the cap: " + stats.size,
      );
    }

    const burstRun = await runProcess(
      process.execPath,
      [
        runnerPath,
        "--file",
        burst,
        "--max-bytes",
        String(maxBytes),
        "--backups",
        "2",
        "--",
        process.execPath,
        burstScript,
      ],
      { cwd: dir },
    );
    assert.equal(burstRun.code, 0, burstRun.stderr);

    let burstPayload = "";
    for (let index = 0; index < 200; index += 1) {
      burstPayload += String(index).padStart(3, "0").repeat(33) + "x";
    }
    const burstSegments = await readSegments(burst, 2);
    assert.ok(
      burstPayload.endsWith(burstSegments),
      "queued chunks must keep order: surviving bytes are the payload tail",
    );
    assert.equal(burstSegments.length > 0, true);
    for (const candidate of [burst, burst + ".1", burst + ".2"]) {
      const stats = await fs.stat(candidate).catch(() => null);
      if (!stats) continue;
      assert.ok(stats.size <= maxBytes, "burst segment over cap: " + stats.size);
    }
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("bounded log runner reports usage errors without spawning anything", async () => {
  const result = await runProcess(process.execPath, [runnerPath, "--max-bytes", "2048"]);
  assert.equal(result.code, 2);
  assert.match(result.stderr, /--file is required/u);
  assert.match(result.stderr, /usage: bounded-log-runner/u);
});
