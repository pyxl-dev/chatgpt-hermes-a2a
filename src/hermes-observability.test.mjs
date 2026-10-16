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
