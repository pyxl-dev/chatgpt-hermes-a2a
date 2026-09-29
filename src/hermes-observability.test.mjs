import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createHermesObservability } from "./hermes-observability.mjs";

test("delegate deduplication is isolated by ChatGPT session scope", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "hermes-observability-test-"));
  let uuid = 0;
  let calls = 0;
  const observability = createHermesObservability({
    root,
    redactText: (value) => String(value),
    redactValue: (value) => value,
    randomUUID: () => "uuid-" + ++uuid,
  });

  const delegate = observability.wrapDelegate(async () => {
    calls += 1;
    return {
      ok: true,
      taskId: "task-" + calls,
      contextId: "ctx-" + calls,
    };
  });

  const sessionA = await delegate(
    "same instruction",
    false,
    "trace-a",
    "chatgpt-session-a",
  );
  const sessionB = await delegate(
    "same instruction",
    false,
    "trace-b",
    "chatgpt-session-b",
  );

  assert.equal(calls, 2);
  assert.notEqual(sessionA.contextId, sessionB.contextId);
  assert.equal(sessionA.deduplicated, false);
  assert.equal(sessionB.deduplicated, false);

  const repeatedA = await delegate(
    "same   instruction",
    false,
    "trace-a-retry",
    "chatgpt-session-a",
  );
  assert.equal(calls, 2);
  assert.equal(repeatedA.contextId, sessionA.contextId);
  assert.equal(repeatedA.deduplicated, true);
  assert.equal(repeatedA.duplicateOfTraceId, "trace-a");
});
