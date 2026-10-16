import assert from "node:assert/strict";
import test from "node:test";

import {
  createRunNotifier,
  createDiscordWebhookSender,
  formatRunNotification,
} from "./hermes-run-notifier.mjs";

function fakeClock() {
  let nowMs = 0;
  return {
    now: () => nowMs,
    sleep: async (ms) => {
      nowMs += ms;
      await new Promise((resolve) => setImmediate(resolve));
    },
  };
}

test("notifies once when a watched Run finishes and nobody collected it", async () => {
  const clock = fakeClock();
  const statuses = ["running", "running", "completed"];
  const sent = [];
  const notifier = createRunNotifier({
    getRun: async () => ({ status: statuses.shift() || "completed" }),
    send: async (text) => sent.push(text),
    pollMs: 60000,
    graceMs: 1000,
    ...clock,
  });

  assert.equal(notifier.watch("run-1", { instruction: "build the report" }), true);
  assert.equal(notifier.watch("run-1"), false, "a second watch must not double up");
  await notifier.drain("run-1");

  assert.equal(sent.length, 1);
  assert.match(sent[0], /completed/);
  assert.match(sent[0], /build the report/);
  assert.match(sent[0], /run-1/);
  assert.deepEqual(notifier.watching(), []);
});

test("stays silent when ChatGPT collects the result during the grace period", async () => {
  const clock = fakeClock();
  const sent = [];
  let notifier = null;
  notifier = createRunNotifier({
    getRun: async () => ({ status: "completed" }),
    send: async (text) => sent.push(text),
    pollMs: 10,
    graceMs: 1000,
    now: clock.now,
    sleep: async (ms) => {
      await clock.sleep(ms);
      // ChatGPT's own long poll returns the terminal result meanwhile.
      if (ms === 1000) notifier.settle("run-2");
    },
  });

  notifier.watch("run-2");
  await notifier.drain("run-2");
  assert.equal(sent.length, 0);
});

test("a settled Run cannot be re-armed by a late pending payload", async () => {
  const sent = [];
  const notifier = createRunNotifier({
    getRun: async () => ({ status: "completed" }),
    send: async (text) => sent.push(text),
    ...fakeClock(),
  });
  notifier.settle("run-3");
  assert.equal(notifier.watch("run-3"), false);
  assert.equal(sent.length, 0);
});

test("keeps watching through transient read errors and gives up after the max window", async () => {
  const clock = fakeClock();
  const errors = [];
  const sent = [];
  const notifier = createRunNotifier({
    getRun: async () => {
      throw new Error("Hermes restarting");
    },
    send: async (text) => sent.push(text),
    pollMs: 1000,
    maxWatchMs: 5000,
    onError: (error) => errors.push(error.message),
    ...clock,
  });
  notifier.watch("run-4");
  await notifier.drain("run-4");
  assert.ok(errors.length >= 3);
  assert.equal(sent.length, 0);
});

test("is inert without a sender", () => {
  const notifier = createRunNotifier({ getRun: async () => ({}), send: null });
  assert.equal(notifier.enabled, false);
  assert.equal(notifier.watch("run-5"), false);
});

test("formats a short message without Hermes output", () => {
  const text = formatRunNotification({
    runId: "run_abc",
    status: "failed",
    elapsedMs: 95 * 60000,
    instruction: "x".repeat(400),
  });
  assert.match(text, /^⚠️ Hermes a fini un run : failed après 1 h 35\./);
  assert.ok(text.length < 400, "the instruction preview must be truncated");
  assert.match(text, /continue/);
});

test("names the slot only for parallel slots", () => {
  const base = { runId: "run_s", status: "completed", elapsedMs: 120000 };
  assert.match(
    formatRunNotification({ ...base, slot: 2 }),
    /^✅ Hermes a fini un run \(slot 2\) : completed/,
  );
  assert.match(
    formatRunNotification({ ...base, slot: 1 }),
    /^✅ Hermes a fini un run : completed/,
  );
});

test("Discord sender posts to the webhook, mutes mentions and never leaks the URL", async () => {
  const calls = [];
  const send = createDiscordWebhookSender({
    webhookUrl: "https://discord.test/api/webhooks/1/SECRET",
    fetchImpl: async (url, init) => {
      calls.push({ url, body: JSON.parse(init.body) });
      return { ok: calls.length === 1, status: 401 };
    },
  });
  await send("hello @everyone");
  assert.equal(calls[0].url, "https://discord.test/api/webhooks/1/SECRET");
  assert.deepEqual(calls[0].body, {
    content: "hello @everyone",
    username: "Hermes",
    allowed_mentions: { parse: [] },
  });
  await assert.rejects(send("again"), (error) => {
    assert.doesNotMatch(error.message, /SECRET|discord\.test/);
    return true;
  });
  assert.equal(createDiscordWebhookSender({ webhookUrl: "" }), null);
});
