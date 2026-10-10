import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const DEFAULT_TIMEOUT_MS = 330000;
const DEFAULT_HISTORY_LIMIT = 50;
const MAX_HISTORY_LIMIT = 200;
const DEFAULT_SESSION_LIST_LIMIT = 50;
const MAX_SESSION_LIST_LIMIT = 200;
const MAX_MESSAGE_CHARS = 12000;
const MAX_BUFFER_BYTES = 16 * 1024 * 1024;
const DEFAULT_TIMELINE_LIMIT = 100;
const MAX_TIMELINE_LIMIT = 500;
const MAX_TOOL_CALL_ID_CHARS = 128;

/**
 * Content-free tool timeline helpers.
 *
 * The bridge already persists every tool call and result inside Hermes' own
 * session store. These helpers derive an operational chronology (tool name,
 * start/end, duration, ok/error kind) from that store WITHOUT ever returning
 * tool arguments, tool results, prompts, assistant text or reasoning.
 */

function configuredPositiveNumber(value, fallback, minimum = 1) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= minimum ? parsed : fallback;
}

function requireSessionId(value) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error("sessionId must be a non-empty string");
  }
  if (value.includes("\u0000")) {
    throw new Error("sessionId must not contain NUL bytes");
  }
  return value.trim();
}

function messageText(content) {
  if (content === null || content === undefined) return "";
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === "string") return part;
        if (part && typeof part === "object") {
          if (typeof part.text === "string") return part.text;
          if (typeof part.content === "string") return part.content;
        }
        try {
          return JSON.stringify(part);
        } catch {
          return String(part);
        }
      })
      .filter(Boolean)
      .join("\n");
  }
  if (typeof content === "object") {
    if (typeof content.text === "string") return content.text;
    if (typeof content.content === "string") return content.content;
    try {
      return JSON.stringify(content);
    } catch {
      return String(content);
    }
  }
  return String(content);
}

function truncateText(value) {
  const text = String(value || "");
  return text.length > MAX_MESSAGE_CHARS
    ? text.slice(0, MAX_MESSAGE_CHARS) + "…[truncated]"
    : text;
}

function sessionIdOf(session, fallback) {
  return String(session?.id || session?.session_id || fallback || "");
}

function nullableCell(value) {
  const text = String(value || "").trim();
  return !text || text === "—" ? null : text;
}

function parseSessionList(stdout, requestedSource = null) {
  const lines = String(stdout || "")
    .split(/\r?\n/u)
    .map((line) => line.replace(/\s+$/u, ""))
    .filter(Boolean);

  if (!lines.length || lines[0].trim() === "No sessions found.") {
    return [];
  }

  const headerIndex = lines.findIndex(
    (line) => line.includes("ID") && line.includes("Last Active"),
  );
  if (headerIndex < 0 || headerIndex + 1 >= lines.length) {
    throw new Error("Could not parse Hermes sessions list output");
  }

  const header = lines[headerIndex];
  const known = ["Title", "Preview", "Workspace", "Last Active", "Src", "ID"];
  const columns = known
    .map((label) => ({ label, start: header.indexOf(label) }))
    .filter((column) => column.start >= 0)
    .sort((a, b) => a.start - b.start);

  if (!columns.some((column) => column.label === "ID")) {
    throw new Error("Hermes sessions list output is missing the ID column");
  }

  const rows = [];
  for (const line of lines.slice(headerIndex + 2)) {
    if (!line.trim() || /^[─-]+$/u.test(line.trim())) continue;

    const values = {};
    for (let index = 0; index < columns.length; index += 1) {
      const current = columns[index];
      const next = columns[index + 1];
      values[current.label] = line
        .slice(current.start, next ? next.start : undefined)
        .trim();
    }

    const sessionId = nullableCell(values.ID);
    if (!sessionId) continue;

    rows.push({
      sessionId,
      title: nullableCell(values.Title),
      preview: nullableCell(values.Preview),
      workspace: nullableCell(values.Workspace),
      lastActive: nullableCell(values["Last Active"]),
      source: nullableCell(values.Src) || requestedSource || null,
    });
  }
  return rows;
}

function simplifyMessage(message) {
  const role = String(message?.role || "unknown");
  const toolName =
    role === "tool"
      ? String(message?.tool_name || message?.name || "tool")
      : null;
  return {
    role,
    text: truncateText(messageText(message?.content)),
    timestamp: message?.timestamp ?? null,
    messageId: message?.id ?? null,
    ...(toolName ? { toolName } : {}),
  };
}

export function normalizeTimestampMs(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === "string" && value.trim()) {
    const parsed = Date.parse(value.trim());
    return Number.isFinite(parsed) ? parsed : null;
  }
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) return null;
  // Hermes stores unix seconds with sub-second precision; anything large is
  // already milliseconds.
  return numeric > 1e12 ? Math.round(numeric) : Math.round(numeric * 1000);
}

function shortToolCallId(value) {
  if (typeof value !== "string") return null;
  const text = value.trim();
  return text && text.length <= MAX_TOOL_CALL_ID_CHARS ? text : null;
}

function toolNameOf(message) {
  const name = message?.function?.name ?? message?.name ?? message?.tool_name;
  if (typeof name !== "string") return null;
  const text = name.trim();
  return text && text.length <= 200 ? text : null;
}

function matchErrorKind(value) {
  const text = String(value || "");
  if (!text) return null;
  if (/blocked\b|\bBLOCKED:/iu.test(text)) return "blocked";
  if (/approval[^.\n]{0,40}(?:denied|refused)|(?:^|\n)\s*denied\b/iu.test(text)) {
    return "denied";
  }
  if (
    /(?:^|[\s\n])(?:error|exception|traceback|failed)\b/iu.test(
      text.slice(0, 200),
    )
  ) {
    return "error";
  }
  return null;
}

/**
 * Accept an ISO-8601 timestamp or Unix milliseconds for `since` filters.
 * Returns null when no filter was supplied; throws on an unusable value.
 */
export function parseSinceOption(value) {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new Error("since must be an ISO-8601 timestamp or Unix milliseconds");
    }
    return Math.round(value);
  }
  if (typeof value !== "string") {
    throw new Error("since must be an ISO-8601 timestamp or Unix milliseconds");
  }
  const parsed = Date.parse(value.trim());
  if (!Number.isFinite(parsed)) {
    throw new Error("since must be a valid ISO-8601 timestamp");
  }
  return parsed;
}

function parseJsonObject(text) {
  const trimmed = String(text || "").trim();
  if (!trimmed.startsWith("{") || !trimmed.endsWith("}")) return null;
  try {
    const parsed = JSON.parse(trimmed);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed
      : null;
  } catch {
    return null;
  }
}

/**
 * Reduce one tool message to a content-free outcome: { ok, errorKind }.
 * The tool text is inspected only to derive this boolean/enum and is never
 * returned to the caller.
 */
export function classifyToolOutcome(message) {
  const disposition = message?.effect_disposition;
  if (disposition && typeof disposition === "object") {
    const statusText = [
      disposition.status,
      disposition.outcome,
      disposition.disposition,
      disposition.result,
    ]
      .filter((value) => typeof value === "string")
      .join(" ");
    if (statusText) {
      const kind = matchErrorKind(statusText);
      if (kind) return { ok: false, errorKind: kind };
      if (
        /(?:^|[\s])(?:ok|success|succeeded|completed)(?:$|[\s])/iu.test(
          statusText,
        ) &&
        disposition.error === undefined
      ) {
        return { ok: true, errorKind: null };
      }
    }
  }

  const text = messageText(message?.content).trim();
  const parsed = parseJsonObject(text);
  if (parsed) {
    const exitCode = Number(parsed.exit_code);
    const failed =
      Boolean(parsed.error) ||
      parsed.isError === true ||
      parsed.success === false ||
      parsed.status === "error" ||
      (Number.isFinite(exitCode) && exitCode !== 0);
    if (!failed) return { ok: true, errorKind: null };
    return {
      ok: false,
      errorKind:
        matchErrorKind(
          typeof parsed.error === "string"
            ? parsed.error
            : JSON.stringify(parsed.error ?? ""),
        ) ||
        (Number.isFinite(exitCode) && exitCode !== 0 ? "nonzero_exit" : "error"),
    };
  }

  const kind = matchErrorKind(text.slice(0, 200));
  return kind ? { ok: false, errorKind: kind } : { ok: true, errorKind: null };
}

export function buildToolTimeline(messages, options = {}) {
  const list = Array.isArray(messages) ? messages : [];
  const limit =
    options.limit === undefined ? DEFAULT_TIMELINE_LIMIT : options.limit;
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_TIMELINE_LIMIT) {
    throw new Error(
      "limit must be an integer between 1 and " + MAX_TIMELINE_LIMIT,
    );
  }
  const sinceMs =
    options.sinceMs === undefined || options.sinceMs === null
      ? null
      : options.sinceMs;
  const errorsOnly = options.errorsOnly === true;
  const toolFilter =
    typeof options.tool === "string" && options.tool.trim()
      ? options.tool.trim()
      : null;

  const entries = [];
  const byCallId = new Map();

  for (const message of list) {
    if (!message || typeof message !== "object") continue;
    const role = String(message.role || "");

    if (role === "assistant" && Array.isArray(message.tool_calls)) {
      const startedAtMs = normalizeTimestampMs(message.timestamp);
      for (const call of message.tool_calls) {
        if (!call || typeof call !== "object") continue;
        const toolCallId = shortToolCallId(call.id ?? call.call_id);
        const entry = {
          index: entries.length + 1,
          toolName: toolNameOf(call) || "unknown",
          toolCallId,
          startedAtMs,
          endedAtMs: null,
          ok: null,
          errorKind: null,
          state: "started_only",
        };
        entries.push(entry);
        if (toolCallId && !byCallId.has(toolCallId)) {
          byCallId.set(toolCallId, entry);
        }
      }
      continue;
    }

    if (role !== "tool") continue;

    const toolCallId = shortToolCallId(message.tool_call_id);
    const entry = toolCallId ? byCallId.get(toolCallId) : null;
    const outcome = classifyToolOutcome(message);
    const endedAtMs = normalizeTimestampMs(message.timestamp);

    if (entry) {
      entry.endedAtMs = endedAtMs;
      entry.ok = outcome.ok;
      entry.errorKind = outcome.errorKind;
      entry.state = "completed";
      if (entry.toolName === "unknown") {
        entry.toolName = toolNameOf(message) || entry.toolName;
      }
      continue;
    }

    entries.push({
      index: entries.length + 1,
      toolName: toolNameOf(message) || "unknown",
      toolCallId,
      startedAtMs: null,
      endedAtMs,
      ok: outcome.ok,
      errorKind: outcome.errorKind,
      state: "result_only",
    });
  }

  const all = entries.map((entry) => {
    const durationMs =
      entry.startedAtMs !== null && entry.endedAtMs !== null
        ? Math.max(0, entry.endedAtMs - entry.startedAtMs)
        : null;
    return {
      index: entry.index,
      toolName: entry.toolName,
      toolCallId: entry.toolCallId,
      startedAt:
        entry.startedAtMs === null
          ? null
          : new Date(entry.startedAtMs).toISOString(),
      endedAt:
        entry.endedAtMs === null ? null : new Date(entry.endedAtMs).toISOString(),
      durationMs,
      ok: entry.ok,
      errorKind: entry.errorKind,
      state: entry.state,
    };
  });

  const matching = all.filter((entry) => {
    if (toolFilter && entry.toolName !== toolFilter) return false;
    if (errorsOnly && entry.ok !== false) return false;
    if (sinceMs !== null) {
      const reference =
        entry.endedAt !== null ? Date.parse(entry.endedAt) : null;
      const started =
        entry.startedAt !== null ? Date.parse(entry.startedAt) : null;
      const at = reference ?? started;
      if (at === null || at < sinceMs) return false;
    }
    return true;
  });

  const startedStamps = all
    .map((entry) => (entry.startedAt === null ? null : Date.parse(entry.startedAt)))
    .filter((value) => typeof value === "number" && Number.isFinite(value));
  const endedStamps = all
    .map((entry) => (entry.endedAt === null ? null : Date.parse(entry.endedAt)))
    .filter((value) => typeof value === "number" && Number.isFinite(value));

  return {
    entries: matching.slice(-limit),
    totals: {
      toolCallCount: all.filter((entry) => entry.state !== "result_only").length,
      completedCount: all.filter((entry) => entry.state === "completed").length,
      startedOnlyCount: all.filter((entry) => entry.state === "started_only")
        .length,
      resultOnlyCount: all.filter((entry) => entry.state === "result_only")
        .length,
      errorCount: all.filter((entry) => entry.ok === false).length,
      okCount: all.filter((entry) => entry.ok === true).length,
      toolNames: [...new Set(all.map((entry) => entry.toolName))].sort(),
      firstStartedAt: startedStamps.length
        ? new Date(Math.min(...startedStamps)).toISOString()
        : null,
      lastEndedAt: endedStamps.length
        ? new Date(Math.max(...endedStamps)).toISOString()
        : null,
      wallClockMs:
        startedStamps.length && endedStamps.length
          ? Math.max(
              0,
              Math.max(...endedStamps) - Math.min(...startedStamps),
            )
          : null,
    },
    matchingCount: matching.length,
    totalEntryCount: all.length,
    limit,
  };
}

export function createHermesSessionAccess({
  root,
  redactText,
  randomUUID,
}) {
  const runtimeDir = path.join(root, ".runtime");
  const hermesBin = process.env.HERMES_BIN || "hermes";
  const timeoutMs = configuredPositiveNumber(
    process.env.HERMES_SESSION_TIMEOUT_MS,
    DEFAULT_TIMEOUT_MS,
    1000,
  );

  async function runHermes(args) {
    try {
      return await execFileAsync(hermesBin, args, {
        cwd: root,
        env: process.env,
        encoding: "utf8",
        maxBuffer: MAX_BUFFER_BYTES,
        timeout: timeoutMs,
        windowsHide: true,
      });
    } catch (error) {
      const detail = [error?.stderr, error?.stdout, error?.message]
        .filter((value) => typeof value === "string" && value.trim())
        .map((value) => value.trim())
        .join("\n");
      throw new Error(
        redactText(
          "Hermes CLI failed for " +
            String(args?.[0] || "command") +
            ": " +
            (detail || String(error)),
        ),
      );
    }
  }

  async function listSessions(options = {}) {
    const limit =
      options.limit === undefined ? DEFAULT_SESSION_LIST_LIMIT : options.limit;
    if (
      !Number.isInteger(limit) ||
      limit < 1 ||
      limit > MAX_SESSION_LIST_LIMIT
    ) {
      throw new Error(
        "limit must be an integer between 1 and " + MAX_SESSION_LIST_LIMIT,
      );
    }

    const source =
      typeof options.source === "string" && options.source.trim()
        ? options.source.trim()
        : null;
    const workspace =
      typeof options.workspace === "string" && options.workspace.trim()
        ? options.workspace.trim()
        : null;

    const args = ["sessions", "list", "--limit", String(limit)];
    if (source) args.push("--source", source);
    if (workspace) args.push("--workspace", workspace);

    const { stdout } = await runHermes(args);
    const sessions = parseSessionList(stdout, source).map((session) => ({
      ...session,
      title: session.title ? redactText(session.title) : null,
      preview: session.preview ? redactText(session.preview) : null,
      workspace: session.workspace ? redactText(session.workspace) : null,
    }));

    return {
      ok: true,
      operation: "list_hermes_sessions",
      agent: "hermes",
      limit,
      source,
      workspace,
      count: sessions.length,
      sessions,
    };
  }

  async function exportSession(sessionId) {
    const requestedSessionId = requireSessionId(sessionId);
    await fs.mkdir(runtimeDir, { recursive: true, mode: 0o700 });
    const outputPath = path.join(
      runtimeDir,
      "hermes-session-" + randomUUID() + ".jsonl",
    );

    try {
      await runHermes([
        "sessions",
        "export",
        outputPath,
        "--session-id",
        requestedSessionId,
        "--format",
        "jsonl",
        "--redact",
      ]);

      const raw = await fs.readFile(outputPath, "utf8");
      const rows = raw
        .split("\n")
        .filter((line) => line.trim())
        .map((line) => JSON.parse(line));

      if (rows.length !== 1 || !rows[0] || typeof rows[0] !== "object") {
        throw new Error(
          "Hermes session export returned " +
            rows.length +
            " session records; expected exactly one",
        );
      }
      return rows[0];
    } finally {
      await fs.rm(outputPath, { force: true }).catch(() => {});
    }
  }

  async function getSession(sessionId, options = {}) {
    const requestedSessionId = requireSessionId(sessionId);
    const limit =
      options.limit === undefined ? DEFAULT_HISTORY_LIMIT : options.limit;
    if (
      !Number.isInteger(limit) ||
      limit < 0 ||
      limit > MAX_HISTORY_LIMIT
    ) {
      throw new Error(
        "limit must be an integer between 0 and " + MAX_HISTORY_LIMIT,
      );
    }

    const includeTools = options.includeTools === true;
    const session = await exportSession(requestedSessionId);
    const allMessages = Array.isArray(session.messages)
      ? session.messages.filter(
          (message) => message && typeof message === "object",
        )
      : [];
    const visibleMessages = allMessages.filter((message) => {
      const role = String(message.role || "");
      if (role === "system") return false;
      if (role === "tool" && !includeTools) return false;
      return true;
    });
    const selected =
      limit === 0 ? [] : visibleMessages.slice(-limit).map(simplifyMessage);

    return {
      ok: true,
      operation: "get_hermes_session",
      agent: "hermes",
      requestedSessionId,
      sessionId: sessionIdOf(session, requestedSessionId),
      title: session.title || null,
      source: session.source || null,
      model: session.model || null,
      provider: session.provider || null,
      cwd: session.cwd || null,
      startedAt: session.started_at ?? null,
      endedAt: session.ended_at ?? null,
      messageCount:
        session.message_count ?? allMessages.length,
      visibleMessageCount: visibleMessages.length,
      returnedMessageCount: selected.length,
      includeTools,
      messages: selected,
    };
  }


  async function getToolTimeline(sessionId, options = {}) {
    const requestedSessionId = requireSessionId(sessionId);
    const session = await exportSession(requestedSessionId);
    const messages = Array.isArray(session.messages)
      ? session.messages.filter(
          (message) => message && typeof message === "object",
        )
      : [];
    const sinceMs = parseSinceOption(options.since);
    const timeline = buildToolTimeline(messages, {
      ...(options.limit === undefined ? {} : { limit: options.limit }),
      sinceMs,
      errorsOnly: options.errorsOnly === true,
      ...(typeof options.tool === "string" ? { tool: options.tool } : {}),
    });

    return {
      ok: true,
      operation: "hermes_tool_timeline",
      agent: "hermes",
      requestedSessionId,
      sessionId: sessionIdOf(session, requestedSessionId),
      // The timeline is always a whole-session chronology. A runId is only a
      // way to find the session: tool calls cannot be attributed to one run
      // with proof, so no per-run filter is applied or implied.
      scope: "session",
      requestedRunId: options.runId || null,
      runFilterApplied: false,
      runFilterNote:
        "the returned chronology covers the whole persisted session; entries are neither filtered nor attributed to the requested run",
      correlation: options.correlation || null,
      title: session.title || null,
      source: session.source || null,
      contentFree: true,
      excludes: [
        "tool arguments",
        "tool results",
        "prompts",
        "assistant text",
        "reasoning",
      ],
      messageCount: session.message_count ?? messages.length,
      sessionStartedAt: session.started_at ?? null,
      sessionEndedAt: session.ended_at ?? null,
      returnedEntryCount: timeline.entries.length,
      matchingEntryCount: timeline.matchingCount,
      totalEntryCount: timeline.totalEntryCount,
      limit: timeline.limit,
      since: options.since === undefined ? null : options.since,
      errorsOnly: options.errorsOnly === true,
      tool: options.tool || null,
      totals: timeline.totals,
      entries: timeline.entries,
    };
  }

  return {
    hermesBin,
    timeoutMs,
    listSessions,
    getSession,
    getToolTimeline,
  };
}
