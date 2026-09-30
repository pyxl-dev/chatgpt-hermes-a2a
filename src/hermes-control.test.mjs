import assert from "node:assert/strict";
import test from "node:test";

import {
  controlIdempotencyKey,
  resolveHermesApiUrl,
} from "./hermes-control.mjs";

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
