import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const DEFAULT_TIMEOUT_MS = 330000;
const DEFAULT_HISTORY_LIMIT = 50;
const MAX_HISTORY_LIMIT = 200;
const MAX_MESSAGE_CHARS = 12000;
const MAX_BUFFER_BYTES = 16 * 1024 * 1024;

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

export function createHermesSessionAccess({
  root,
  redactText,
  randomUUID,
  cleanText,
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

  async function continueSession(sessionId, instruction) {
    const requestedSessionId = requireSessionId(sessionId);
    if (typeof instruction !== "string" || instruction.trim() === "") {
      throw new Error("instruction must be a non-empty string");
    }

    const { stdout } = await runHermes([
      "chat",
      "-q",
      instruction,
      "-Q",
      "--resume",
      requestedSessionId,
    ]);

    return {
      ok: true,
      operation: "continue_hermes_session",
      agent: "hermes",
      requestedSessionId,
      sessionId: requestedSessionId,
      state: 3,
      stateName: "completed",
      text: cleanText(stdout || "") || null,
    };
  }

  return {
    hermesBin,
    timeoutMs,
    getSession,
    continueSession,
  };
}
