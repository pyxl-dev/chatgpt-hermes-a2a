import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  buildToolTimeline,
  classifyToolOutcome,
  createHermesSessionAccess,
  normalizeTimestampMs,
  parseSinceOption,
} from "./hermes-sessions.mjs";

const SECRET_ARGUMENT = "SECRET_ARGUMENT_VALUE_do_not_leak";
const SECRET_RESULT = "SECRET_RESULT_TEXT_do_not_leak";

function sessionMessages() {
  return [
    { role: "user", content: "please run things", timestamp: 1000 },
    {
      role: "assistant",
      timestamp: 1001,
      tool_calls: [
        {
          id: "call-1",
          type: "function",
          function: { name: "terminal", arguments: `{"command":"${SECRET_ARGUMENT}"}` },
        },
        { id: "call-2", function: { name: "read_file", arguments: "{}" } },
      ],
    },
    {
      role: "tool",
      tool_call_id: "call-1",
      tool_name: "terminal",
      timestamp: 1003.5,
      content: `ok: wrote ${SECRET_RESULT}`,
    },
    {
      role: "tool",
      tool_call_id: "call-2",
      tool_name: "read_file",
      timestamp: 1004,
      content: '{"status": "error", "error": "no such file"}',
    },
    {
      role: "assistant",
      timestamp: 1005,
      tool_calls: [
        { id: "call-3", function: { name: "browser_exec", arguments: "{}" } },
      ],
    },
    { role: "tool", tool_call_id: "orphan-1", tool_name: "web_search", timestamp: 1006, content: "BLOCKED: denied by policy" },
  ];
}

test("normalizeTimestampMs accepts seconds, milliseconds and ISO strings", () => {
  assert.equal(normalizeTimestampMs(1000), 1_000_000);
  assert.equal(normalizeTimestampMs(1000.5), 1_000_500);
  assert.equal(normalizeTimestampMs(1_700_000_000_123), 1_700_000_000_123);
  assert.equal(normalizeTimestampMs("2026-10-10T00:00:00.000Z"), Date.parse("2026-10-10T00:00:00.000Z"));
  assert.equal(normalizeTimestampMs(null), null);
  assert.equal(normalizeTimestampMs("not-a-date"), null);
  assert.equal(normalizeTimestampMs(0), null);
});

test("parseSinceOption validates and normalizes the since filter", () => {
  assert.equal(parseSinceOption(undefined), null);
  assert.equal(parseSinceOption(""), null);
  assert.equal(parseSinceOption(1_700_000_000_000), 1_700_000_000_000);
  assert.equal(parseSinceOption("2026-10-10T00:00:00.000Z"), Date.parse("2026-10-10T00:00:00.000Z"));
  assert.throws(() => parseSinceOption("yesterday"), /ISO-8601/u);
  assert.throws(() => parseSinceOption({}), /ISO-8601/u);
});

test("classifyToolOutcome derives a status without exposing content", () => {
  assert.deepEqual(classifyToolOutcome({ content: "all good" }), {
    ok: true,
    errorKind: null,
  });
  assert.deepEqual(classifyToolOutcome({ content: "BLOCKED: command needs approval" }), {
    ok: false,
    errorKind: "blocked",
  });
  assert.deepEqual(
    classifyToolOutcome({ content: '{"error": "approval denied by user"}' }),
    { ok: false, errorKind: "denied" },
  );
  assert.deepEqual(classifyToolOutcome({ content: '{"exit_code": 2}' }), {
    ok: false,
    errorKind: "nonzero_exit",
  });
  assert.deepEqual(classifyToolOutcome({ content: '{"ok": true, "exit_code": 0}' }), {
    ok: true,
    errorKind: null,
  });
  assert.deepEqual(classifyToolOutcome({ content: "Traceback (most recent call last)" }), {
    ok: false,
    errorKind: "error",
  });
  assert.deepEqual(classifyToolOutcome({ content: null }), {
    ok: true,
    errorKind: null,
  });
});

test("buildToolTimeline pairs calls with results and keeps the timeline content-free", () => {
  const timeline = buildToolTimeline(sessionMessages(), { limit: 50 });

  assert.equal(timeline.totalEntryCount, 4);
  assert.equal(timeline.totals.toolCallCount, 3);
  assert.equal(timeline.totals.completedCount, 2);
  assert.equal(timeline.totals.startedOnlyCount, 1);
  assert.equal(timeline.totals.resultOnlyCount, 1);
  assert.equal(timeline.totals.errorCount, 2);
  assert.equal(timeline.totals.okCount, 1);
  assert.deepEqual(timeline.totals.toolNames, [
    "browser_exec",
    "read_file",
    "terminal",
    "web_search",
  ]);

  const [terminal, readFile, browserExec, webSearch] = timeline.entries;
  assert.equal(terminal.toolName, "terminal");
  assert.equal(terminal.durationMs, 2500);
  assert.equal(terminal.ok, true);
  assert.equal(terminal.state, "completed");
  assert.equal(readFile.errorKind, "error");
  assert.equal(browserExec.state, "started_only");
  assert.equal(browserExec.endedAt, null);
  assert.equal(browserExec.ok, null);
  assert.equal(webSearch.state, "result_only");
  assert.equal(webSearch.errorKind, "blocked");
  assert.match(terminal.startedAt, /^\d{4}-\d{2}-\d{2}T/u);

  const serialized = JSON.stringify(timeline);
  assert.equal(serialized.includes(SECRET_ARGUMENT), false);
  assert.equal(serialized.includes(SECRET_RESULT), false);
});

test("buildToolTimeline filters by errors, tool name, since and keeps the tail", () => {
  const messages = sessionMessages();

  const errorsOnly = buildToolTimeline(messages, { limit: 50, errorsOnly: true });
  assert.deepEqual(
    errorsOnly.entries.map((entry) => entry.toolName),
    ["read_file", "web_search"],
  );

  const singleTool = buildToolTimeline(messages, { limit: 50, tool: "terminal" });
  assert.equal(singleTool.entries.length, 1);
  assert.equal(singleTool.entries[0].toolName, "terminal");
  assert.equal(singleTool.totals.toolCallCount, 3, "totals ignore filters");

  const since = buildToolTimeline(messages, {
    limit: 50,
    sinceMs: 1_005_000,
  });
  assert.deepEqual(
    since.entries.map((entry) => entry.toolName),
    ["browser_exec", "web_search"],
  );

  const tail = buildToolTimeline(messages, { limit: 2 });
  assert.equal(tail.entries.length, 2);
  assert.deepEqual(
    tail.entries.map((entry) => entry.index),
    [3, 4],
  );
  assert.equal(tail.matchingCount, 4);

  assert.throws(() => buildToolTimeline(messages, { limit: 0 }), /between 1 and 500/u);
  assert.throws(() => buildToolTimeline(messages, { limit: 501 }), /between 1 and 500/u);
  assert.throws(() => buildToolTimeline(messages, { limit: 1.5 }), /between 1 and 500/u);
});

test("getToolTimeline reads a persisted session and never returns content", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "hermes-timeline-"));
  const stubBin = path.join(dir, "hermes-stub.mjs");
  // The session was continued: it holds tool calls from an earlier run
  // (timestamps ~1000) and a later run (timestamps ~2000).
  const session = {
    id: "session-timeline-1",
    title: "timeline fixture",
    source: "api_server",
    started_at: 1000,
    ended_at: 2010,
    message_count: 8,
    messages: [
      ...sessionMessages(),
      {
        role: "assistant",
        timestamp: 2000,
        tool_calls: [
          { id: "call-later-1", function: { name: "later_tool", arguments: "{}" } },
        ],
      },
      {
        role: "tool",
        tool_call_id: "call-later-1",
        tool_name: "later_tool",
        timestamp: 2002,
        content: "done",
      },
    ],
  };

  await fs.writeFile(
    stubBin,
    [
      "#!/usr/bin/env node",
      "import fs from 'node:fs/promises';",
      "const args = process.argv.slice(2);",
      "const marker = args.indexOf('export');",
      "const outputPath = args[marker + 1];",
      "const fixture = process.env.TIMELINE_FIXTURE;",
      "await fs.writeFile(outputPath, JSON.stringify(JSON.parse(fixture)) + '\\n');",
      "process.stdout.write('Exported 1 session');",
      "",
    ].join("\n"),
  );
  await fs.chmod(stubBin, 0o755);

  const previousBin = process.env.HERMES_BIN;
  const previousFixture = process.env.TIMELINE_FIXTURE;
  process.env.HERMES_BIN = stubBin;
  process.env.TIMELINE_FIXTURE = JSON.stringify(session);

  try {
    const access = createHermesSessionAccess({
      root: dir,
      redactText: (value) => String(value),
      randomUUID: () => "uuid-1",
    });

    const result = await access.getToolTimeline("session-timeline-1", {
      limit: 10,
      runId: "run_earlier",
      correlation: "run-id-as-session-id",
    });

    assert.equal(result.ok, true);
    assert.equal(result.operation, "hermes_tool_timeline");
    assert.equal(result.sessionId, "session-timeline-1");
    assert.equal(result.requestedRunId, "run_earlier");
    assert.equal(result.scope, "session");
    assert.equal(result.runFilterApplied, false);
    assert.match(result.runFilterNote, /whole persisted session/u);
    assert.equal(
      Object.hasOwn(result, "runId"),
      false,
      "an old runId must never become a per-run label",
    );
    assert.equal(result.contentFree, true);
    assert.equal(result.returnedEntryCount, 5);
    assert.equal(result.totals.toolCallCount, 4);
    assert.equal(result.totals.errorCount, 2);
    // Both the earlier and the later run remain visible: nothing is filtered
    // as if it belonged to one run.
    assert.ok(result.totals.toolNames.includes("later_tool"));
    assert.ok(result.totals.toolNames.includes("terminal"));

    const serialized = JSON.stringify(result);
    assert.equal(serialized.includes(SECRET_ARGUMENT), false);
    assert.equal(serialized.includes(SECRET_RESULT), false);
    assert.equal(serialized.includes("please run things"), false);

    await assert.rejects(
      access.getToolTimeline("session-timeline-1", { since: "nope" }),
      /ISO-8601/u,
    );
    await assert.rejects(access.getToolTimeline("  "), /sessionId/u);
  } finally {
    if (previousBin === undefined) delete process.env.HERMES_BIN;
    else process.env.HERMES_BIN = previousBin;
    if (previousFixture === undefined) delete process.env.TIMELINE_FIXTURE;
    else process.env.TIMELINE_FIXTURE = previousFixture;
    await fs.rm(dir, { recursive: true, force: true });
  }
});
