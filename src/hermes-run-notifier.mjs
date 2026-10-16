// Run-finished notifier.
//
// ChatGPT can only wait on a Run for as long as one assistant turn lasts
// (~23-26 min). Runs that outlive that turn, or that ChatGPT simply stopped
// polling, finish with nobody looking. This module watches every Run the bridge
// hands back as still pending and, once it reaches a terminal status that no
// tool call has already returned to ChatGPT, sends a short Telegram message so
// the user can come back and say "continue".
//
// The message is deliberately small: status, duration, a short preview of the
// instruction ChatGPT sent and the run id. Hermes output never leaves the Mac
// through this path.

const TERMINAL_STATUSES = new Set([
  "completed",
  "failed",
  "cancelled",
  "canceled",
  "interrupted",
  "rejected",
]);

const DEFAULT_POLL_MS = 20000;
const DEFAULT_GRACE_MS = 45000;
const DEFAULT_MAX_WATCH_MS = 12 * 60 * 60 * 1000;
const PREVIEW_CHARS = 120;

function isTerminal(status) {
  return TERMINAL_STATUSES.has(String(status || "").toLowerCase());
}

function boundedNumber(value, fallback, min) {
  const number = Number(value);
  return Number.isFinite(number) && number >= min ? number : fallback;
}

function preview(text) {
  const flat = String(text || "").replace(/\s+/g, " ").trim();
  if (!flat) return null;
  return flat.length > PREVIEW_CHARS
    ? flat.slice(0, PREVIEW_CHARS - 1) + "…"
    : flat;
}

function formatDuration(ms) {
  const minutes = Math.round(ms / 60000);
  if (minutes < 1) return "moins d'une minute";
  if (minutes < 60) return minutes + " min";
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return hours + " h" + (rest ? " " + String(rest).padStart(2, "0") : "");
}

export function formatRunNotification({ runId, status, elapsedMs, instruction }) {
  const normalized = String(status || "").toLowerCase();
  const icon = normalized === "completed" ? "✅" : "⚠️";
  const lines = [
    icon + " Hermes a fini un run : " + (normalized || "inconnu") +
      " après " + formatDuration(elapsedMs) + ".",
  ];
  const shown = preview(instruction);
  if (shown) lines.push("Demande : " + shown);
  lines.push("Dans ChatGPT, écris « continue » pour récupérer le résultat.");
  lines.push("run " + runId);
  return lines.join("\n");
}

export function createTelegramSender({
  token,
  chatId,
  threadId = null,
  apiBase = "https://api.telegram.org",
  fetchImpl = globalThis.fetch,
  timeoutMs = 15000,
}) {
  if (!token || !chatId) return null;
  const url = apiBase.replace(/\/+$/, "") + "/bot" + token + "/sendMessage";
  return async function send(text) {
    const body = {
      chat_id: chatId,
      text,
      disable_web_page_preview: true,
      ...(threadId ? { message_thread_id: Number(threadId) } : {}),
    };
    const response = await fetchImpl(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) {
      // Never surface the URL: it carries the bot token.
      throw new Error("Telegram sendMessage failed with HTTP " + response.status);
    }
  };
}

export function createRunNotifier({
  getRun,
  send,
  pollMs = DEFAULT_POLL_MS,
  graceMs = DEFAULT_GRACE_MS,
  maxWatchMs = DEFAULT_MAX_WATCH_MS,
  now = () => Date.now(),
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms).unref?.()),
  onError = () => {},
}) {
  const enabled = typeof send === "function" && typeof getRun === "function";
  // runId -> { startedAtMs, instruction, delivered }
  const watched = new Map();
  // Runs whose terminal result already reached ChatGPT, or that the user
  // stopped: kept briefly so a late pending payload cannot re-arm a watch.
  const settled = new Set();

  function settle(runId) {
    settled.add(runId);
    if (settled.size > 500) settled.delete(settled.values().next().value);
  }

  async function loop(runId, entry) {
    let lastStatus = null;
    while (!entry.delivered) {
      if (now() - entry.startedAtMs > maxWatchMs) break;
      await sleep(pollMs);
      if (entry.delivered) break;
      try {
        const result = await getRun(runId);
        lastStatus = result?.status || null;
      } catch (error) {
        onError(error, runId);
        continue;
      }
      if (!isTerminal(lastStatus)) continue;

      // The Run is done. ChatGPT may be mid-poll and about to collect it; give
      // it a moment before pinging the user.
      await sleep(graceMs);
      if (entry.delivered) break;
      entry.delivered = true;
      try {
        await send(
          formatRunNotification({
            runId,
            status: lastStatus,
            elapsedMs: now() - entry.startedAtMs,
            instruction: entry.instruction,
          }),
        );
      } catch (error) {
        onError(error, runId);
      }
      break;
    }
    watched.delete(runId);
    settle(runId);
  }

  return {
    enabled,

    // Called whenever a tool hands ChatGPT a Run that is still running.
    watch(runId, { instruction = null } = {}) {
      if (!enabled || !runId || settled.has(runId)) return false;
      const existing = watched.get(runId);
      if (existing) {
        if (instruction && !existing.instruction) existing.instruction = instruction;
        return false;
      }
      const entry = { startedAtMs: now(), instruction, delivered: false };
      watched.set(runId, entry);
      entry.done = loop(runId, entry);
      return true;
    },

    // Called when ChatGPT has received the terminal result, or chose to stop
    // the Run itself: nothing left to tell the user.
    settle(runId) {
      if (!runId) return;
      const entry = watched.get(runId);
      if (entry) entry.delivered = true;
      settle(runId);
    },

    watching() {
      return [...watched.keys()];
    },

    // Test hook: resolves once the given run's watch loop has exited.
    async drain(runId) {
      await watched.get(runId)?.done;
    },
  };
}

export function createRunNotifierFromEnv({ getRun, env = process.env, onError }) {
  if (String(env.HERMES_A2A_NOTIFY || "").toLowerCase() === "off") {
    return createRunNotifier({ getRun, send: null });
  }
  const send = createTelegramSender({
    token: env.HERMES_A2A_TELEGRAM_BOT_TOKEN,
    chatId: env.HERMES_A2A_TELEGRAM_CHAT_ID,
    threadId: env.HERMES_A2A_TELEGRAM_THREAD_ID || null,
    ...(env.HERMES_A2A_TELEGRAM_API_BASE
      ? { apiBase: env.HERMES_A2A_TELEGRAM_API_BASE }
      : {}),
  });
  return createRunNotifier({
    getRun,
    send,
    pollMs: boundedNumber(env.HERMES_A2A_NOTIFY_POLL_MS, DEFAULT_POLL_MS, 50),
    graceMs: boundedNumber(env.HERMES_A2A_NOTIFY_GRACE_MS, DEFAULT_GRACE_MS, 0),
    onError,
  });
}
