import assert from "node:assert/strict";
import test from "node:test";

import { controlIdempotencyKey } from "./hermes-control.mjs";

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
