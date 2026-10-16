import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  positiveInteger,
  readSegments,
  rotateIfNeeded,
  segmentPaths,
} from "./hermes-log-rotation.mjs";

async function tempFile(name) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "hermes-log-rotation-"));
  return path.join(dir, name);
}

test("rotateIfNeeded leaves a small file untouched", async () => {
  const file = await tempFile("activity.jsonl");
  await fs.writeFile(file, "line-1\n");

  const result = await rotateIfNeeded(file, { maxBytes: 1024, backups: 3 });

  assert.equal(result.rotated, false);
  assert.equal(result.sizeBytes, "line-1\n".length);
  assert.equal(await fs.readFile(file, "utf8"), "line-1\n");
  await assert.rejects(fs.stat(file + ".1"), { code: "ENOENT" });
});

test("rotateIfNeeded is a no-op when the file is missing", async () => {
  const file = await tempFile("missing.jsonl");
  const result = await rotateIfNeeded(file, { maxBytes: 10, backups: 2 });
  assert.equal(result.rotated, false);
  assert.equal(result.sizeBytes, 0);
});

test("rotateIfNeeded shifts bounded segments and drops the oldest", async () => {
  const file = await tempFile("activity.jsonl");

  for (const generation of ["one", "two", "three", "four"]) {
    await fs.writeFile(file, generation + "\n");
    await rotateIfNeeded(file, { maxBytes: 1, backups: 2 });
  }

  assert.deepEqual(segmentPaths(file, 2), [file + ".2", file + ".1", file]);

  assert.equal(await fs.readFile(file + ".1", "utf8"), "four\n");
  assert.equal(await fs.readFile(file + ".2", "utf8"), "three\n");
  await assert.rejects(fs.stat(file + ".3"), { code: "ENOENT" });
  // The rotated base file no longer exists: bounded file count, bounded bytes.
  await assert.rejects(fs.stat(file), { code: "ENOENT" });

  const total = await Promise.all(
    [file + ".1", file + ".2"].map(async (candidate) => {
      const stats = await fs.stat(candidate);
      return stats.size;
    }),
  );
  assert.deepEqual(total, [5, 6]);
});

test("rotateIfNeeded truncates when no backups are requested", async () => {
  const file = await tempFile("activity.jsonl");
  await fs.writeFile(file, "x".repeat(64));
  await rotateIfNeeded(file, { maxBytes: 16, backups: 0 });
  assert.equal(await fs.readFile(file, "utf8"), "");
  await assert.rejects(fs.stat(file + ".1"), { code: "ENOENT" });
});

test("readSegments returns segments in chronological order under a budget", async () => {
  const file = await tempFile("activity.jsonl");
  await fs.writeFile(file + ".1", "old-1\nold-2\n");
  await fs.writeFile(file, "new-1\n");

  const full = await readSegments(file, { backups: 3, maxBytes: 0 });
  assert.equal(full.text, "old-1\nold-2\nnew-1\n");
  assert.equal(full.truncated, false);

  const budgeted = await readSegments(file, { backups: 3, maxBytes: 8 });
  assert.equal(budgeted.text, "2\nnew-1\n");
  assert.equal(budgeted.truncated, true);
  assert.equal(budgeted.bytes, 8);

  const missing = await readSegments(await tempFile("absent.jsonl"), {
    backups: 2,
    maxBytes: 64,
  });
  assert.equal(missing.text, "");
  assert.equal(missing.truncated, false);
});

test("positiveInteger accepts valid values and rejects nonsense", () => {
  assert.equal(positiveInteger("2048", 10), 2048);
  assert.equal(positiveInteger(0, 10, 1), 10);
  assert.equal(positiveInteger("-5", 10, 1), 10);
  assert.equal(positiveInteger("abc", 10), 10);
  assert.equal(positiveInteger(undefined, 10), 10);
});
