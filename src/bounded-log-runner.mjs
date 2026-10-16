#!/usr/bin/env node

import { spawn } from "node:child_process";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import {
  positiveInteger,
  rotateIfNeeded,
  shiftSegments,
} from "./hermes-log-rotation.mjs";

/**
 * Bounded stdout/stderr runner for the persistent macOS LaunchAgent.
 *
 * launchd opens StandardOutPath/StandardErrorPath itself and never rotates
 * them, so a long-lived tunnel-client grows them without limit. This runner
 * owns the file instead: it starts the real command as a child, appends both
 * streams to owner-only files, and renames the file to a bounded generation
 * (file.1, file.2, ...) once the byte cap is reached. The command, its
 * arguments and its exit code are preserved.
 *
 * Concurrency model: each output file has exactly one writer with its own
 * promise queue, so chunks are written in arrival order and a rotation can
 * never interleave with another chunk of the same stream. Backpressure pauses
 * the child's pipe while the queue is deep, so a flooding child cannot grow
 * memory without limit. A failed write is counted and reported on exit; it
 * never takes the supervised command down.
 */

const DEFAULT_MAX_BYTES = 2_000_000;
const DEFAULT_BACKUPS = 3;
const SIGNAL_EXIT_CODES = {
  SIGHUP: 1,
  SIGINT: 2,
  SIGQUIT: 3,
  SIGKILL: 9,
  SIGPIPE: 13,
  SIGTERM: 15,
};
// Signals Node can install a handler for. SIGKILL/SIGSTOP must stay out: the
// kernel rejects handlers for them (uv_signal_start EINVAL).
const FORWARDED_SIGNALS = ["SIGHUP", "SIGINT", "SIGQUIT", "SIGTERM"];

export class RunnerUsageError extends Error {}

export function parseRunnerArgs(argv) {
  const config = {
    file: null,
    errFile: null,
    maxBytes: DEFAULT_MAX_BYTES,
    backups: DEFAULT_BACKUPS,
    command: null,
    args: [],
  };

  let index = 0;
  while (index < argv.length) {
    const token = argv[index];
    if (token === "--") {
      config.command = argv[index + 1] || null;
      config.args = argv.slice(index + 2);
      break;
    }
    if (token === "--file" || token === "--err-file") {
      const value = argv[index + 1];
      if (typeof value !== "string" || !value.trim()) {
        throw new RunnerUsageError(token + " requires a path");
      }
      if (token === "--file") config.file = value;
      else config.errFile = value;
      index += 2;
      continue;
    }
    if (token === "--max-bytes" || token === "--backups") {
      const value = argv[index + 1];
      if (typeof value !== "string" || !/^\d+$/u.test(value.trim())) {
        throw new RunnerUsageError(token + " requires a non-negative integer");
      }
      if (token === "--max-bytes") config.maxBytes = Number(value.trim());
      else config.backups = Number(value.trim());
      index += 2;
      continue;
    }
    throw new RunnerUsageError("unexpected argument: " + token);
  }

  if (!config.file) throw new RunnerUsageError("--file is required");
  if (!config.command) {
    throw new RunnerUsageError("a command is required after --");
  }
  if (config.maxBytes < 1024) {
    throw new RunnerUsageError("--max-bytes must be at least 1024");
  }
  return config;
}

function openStream(filePath) {
  const stream = fs.createWriteStream(filePath, { flags: "a", mode: 0o600 });
  return new Promise((resolve, reject) => {
    stream.once("open", () => resolve(stream));
    stream.once("error", reject);
  });
}

function closeStream(stream) {
  return new Promise((resolve) => {
    if (!stream || stream.closed) {
      resolve();
      return;
    }
    stream.end(() => resolve());
  });
}

async function createWriter(filePath, { maxBytes, backups }) {
  await fsp.mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  await rotateIfNeeded(filePath, { maxBytes, backups });
  const stream = await openStream(filePath);
  await fsp.chmod(filePath, 0o600).catch(() => {});
  const stats = await fsp.stat(filePath);
  return { path: filePath, stream, bytes: stats.size, maxBytes, backups };
}

async function rotateWriter(writer) {
  await closeStream(writer.stream);
  await shiftSegments(writer.path, writer.backups);
  writer.stream = await openStream(writer.path);
  await fsp.chmod(writer.path, 0o600).catch(() => {});
  writer.bytes = 0;
}

/**
 * Append one chunk, slicing it so no single segment can exceed `maxBytes`.
 * A chunk larger than the cap is split across rotations instead of being
 * written whole.
 */
async function writeChunk(writer, chunk) {
  let offset = 0;
  while (offset < chunk.length) {
    if (writer.bytes >= writer.maxBytes) await rotateWriter(writer);
    const room = Math.max(1, writer.maxBytes - writer.bytes);
    const slice = chunk.subarray(offset, Math.min(chunk.length, offset + room));
    await new Promise((resolve, reject) => {
      writer.stream.write(slice, (error) => (error ? reject(error) : resolve()));
    });
    writer.bytes += slice.length;
    offset += slice.length;
  }
}

/**
 * Serialize every write for one writer through a promise queue: chunks keep
 * arrival order and a rotation never interleaves with another chunk.
 */
function createWriteQueue(writer) {
  let chain = Promise.resolve();
  let droppedChunks = 0;
  return {
    enqueue(chunk) {
      chain = chain
        .then(() => writeChunk(writer, chunk))
        .catch(() => {
          droppedChunks += 1;
        });
      return chain;
    },
    flush() {
      return chain.catch(() => {});
    },
    get droppedChunks() {
      return droppedChunks;
    },
  };
}

/**
 * Run `config.command` with bounded, rotating stdout/stderr files.
 * Resolves with the child's exit code (128 + signal when it died by signal).
 */
export async function runBoundedLogRunner(config, { spawnImpl = spawn } = {}) {
  let outWriter = null;
  let errWriter = null;

  try {
    outWriter = await createWriter(config.file, config);
    if (!config.errFile || config.errFile === config.file) {
      errWriter = outWriter;
    } else {
      errWriter = await createWriter(config.errFile, config);
    }
  } catch (error) {
    await closeStream(outWriter?.stream);
    throw error;
  }

  const outQueue = createWriteQueue(outWriter);
  const errQueue = errWriter === outWriter ? outQueue : createWriteQueue(errWriter);
  const queues = errQueue === outQueue ? [outQueue] : [outQueue, errQueue];

  const child = spawnImpl(config.command, config.args, {
    stdio: ["ignore", "pipe", "pipe"],
    env: process.env,
  });

  const forward = (signal) => {
    try {
      child.kill(signal);
    } catch {}
  };
  const signals = FORWARDED_SIGNALS;
  for (const signal of signals) process.on(signal, forward);

  let droppedChunks = 0;
  const pipe = (readable, queue) => {
    let pending = 0;
    const highWater = 32;
    readable.on("data", (chunk) => {
      pending += 1;
      if (pending > highWater) readable.pause();
      queue.enqueue(chunk).finally(() => {
        pending -= 1;
        if (pending <= highWater / 2) readable.resume();
      });
    });
  };
  pipe(child.stdout, outQueue);
  pipe(child.stderr, errQueue);

  const exitCode = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => {
      if (typeof code === "number") resolve(code);
      else resolve(128 + (SIGNAL_EXIT_CODES[signal] || 0));
    });
  }).catch(async (error) => {
    for (const signal of signals) process.off(signal, forward);
    await Promise.all(queues.map((queue) => queue.flush()));
    await closeStream(outWriter?.stream);
    if (errWriter && errWriter !== outWriter) await closeStream(errWriter.stream);
    throw error;
  });

  for (const signal of signals) process.off(signal, forward);
  // Drain every queued chunk before closing: closing first would lose output
  // that is still being written.
  await Promise.all(queues.map((queue) => queue.flush()));
  await closeStream(outWriter?.stream);
  if (errWriter && errWriter !== outWriter) await closeStream(errWriter.stream);
  droppedChunks = queues.reduce((total, queue) => total + queue.droppedChunks, 0);
  if (droppedChunks) {
    process.stderr.write(
      "bounded-log-runner: " +
        droppedChunks +
        " output chunk(s) could not be written to the log\n",
    );
  }
  return exitCode;
}

async function main() {
  let config;
  try {
    config = parseRunnerArgs(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(
      "bounded-log-runner: " +
        (error instanceof Error ? error.message : String(error)) +
        "\nusage: bounded-log-runner.mjs --file PATH [--err-file PATH] " +
        "[--max-bytes N] [--backups K] -- COMMAND [ARGS...]\n",
    );
    process.exitCode = 2;
    return;
  }

  try {
    process.exitCode = await runBoundedLogRunner(config);
  } catch (error) {
    process.stderr.write(
      "bounded-log-runner: " +
        (error instanceof Error ? error.message : String(error)) +
        "\n",
    );
    process.exitCode = 127;
  }
}

const invokedPath = process.argv[1]
  ? pathToFileURL(path.resolve(process.argv[1])).href
  : null;
if (invokedPath === import.meta.url) {
  await main();
}
