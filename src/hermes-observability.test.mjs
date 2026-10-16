import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createHermesObservability } from "./hermes-observability.mjs";

test("native activity traces are redacted, persisted and filterable", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "hermes-observability-"));
  let uuid = 0;
  const observability = createHermesObservability({
    root,
    redactText: (value) => String(value).replaceAll("SECRET", "[REDACTED]"),
    redactValue: (value) => value,
    randomUUID: () => "trace-" + ++uuid,
  });

  const base = observability.beginTrace(
    "delegate_to_hermes",
    {
      instruction: "inspect   SECRET",
      sessionId: "session-1",
    },
    { chatgptSessionHash: "hash-1" },
  );

  const finished = observability.finishTrace(
    base,
    {
      ok: true,
      operation: "delegate_to_hermes",
      runId: "run-1",
      sessionId: "session-1",
      status: "completed",
      deduplicated: true,
      duplicateOfTraceId: "trace-original",
    },
    null,
  );

  await observability.appendTrace(finished);
  await observability.flush();

  const result = await observability.readActivity({
    limit: 10,
    tool: "delegate_to_hermes",
    deduplicatedOnly: true,
  });

  assert.equal(result.count, 1);
  assert.equal(result.records[0].purpose, "delegate-native-session");
  assert.equal(result.records[0].chatgptSessionHash, "hash-1");
  assert.equal(result.records[0].inputSessionId, "session-1");
  assert.equal(result.records[0].outputRunId, "run-1");
  assert.equal(result.records[0].status, "completed");
  assert.equal(result.records[0].instructionPreview.includes("SECRET"), false);
  assert.equal(result.records[0].deduplicated, true);

  const raw = await fs.readFile(
    path.join(root, ".runtime", "hermes-activity.jsonl"),
    "utf8",
  );
  assert.equal(raw.includes("SECRET"), false);
});

test("activity traces rotate at a bounded size and reads span segments", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "hermes-rotation-"));
  const previousMax = process.env.HERMES_ACTIVITY_MAX_BYTES;
  const previousBackups = process.env.HERMES_ACTIVITY_BACKUPS;
  process.env.HERMES_ACTIVITY_MAX_BYTES = "1024";
  process.env.HERMES_ACTIVITY_BACKUPS = "2";

  try {
    let uuid = 0;
    const observability = createHermesObservability({
      root,
      redactText: (value) => String(value),
      redactValue: (value) => value,
      randomUUID: () => "trace-" + ++uuid,
    });
    assert.equal(observability.activityMaxBytes, 1024);
    assert.equal(observability.activityBackups, 2);

    const activityLog = path.join(root, ".runtime", "hermes-activity.jsonl");
    for (let index = 0; index < 6; index += 1) {
      // ~600 bytes per record: the second write crosses the 1 KiB cap.
      const finished = observability.finishTrace(
        observability.beginTrace("hermes_activity", {}),
        { ok: true, padding: "p".repeat(500), index },
        null,
      );
      await observability.appendTrace(finished);
    }
    await observability.flush();

    const base = await fs.stat(activityLog);
    // Rotation happens before a write once the cap is reached, so a segment may
    // exceed the cap by at most one record.
    assert.ok(base.size <= 1024 + 700, "base segment stays near the cap");
    const segmentOne = await fs.stat(activityLog + ".1");
    assert.ok(segmentOne.size <= 1024 + 700);
    await assert.rejects(fs.stat(activityLog + ".3"), { code: "ENOENT" });

    const mode = (await fs.stat(activityLog)).mode & 0o777;
    assert.equal(mode, 0o600, "activity log must stay owner-only");

    const read = await observability.readActivity({ limit: 200 });
    assert.equal(read.rotation.maxBytes, 1024);
    assert.equal(read.rotation.backups, 2);
    assert.equal(read.rotation.segments, 3);
    assert.equal(read.rotation.readTruncated, false);
    assert.ok(read.totalMatching <= 6);
    // Only the live segment can hold two of the ~600-byte records, so more than
    // two matches prove the read spans rotated segments.
    assert.ok(read.totalMatching > 2, "reads must span rotated segments");
  } finally {
    if (previousMax === undefined) delete process.env.HERMES_ACTIVITY_MAX_BYTES;
    else process.env.HERMES_ACTIVITY_MAX_BYTES = previousMax;
    if (previousBackups === undefined) delete process.env.HERMES_ACTIVITY_BACKUPS;
    else process.env.HERMES_ACTIVITY_BACKUPS = previousBackups;
    await fs.rm(root, { recursive: true, force: true });
  }
});
