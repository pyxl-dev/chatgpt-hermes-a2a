// Run-finished notifier.
//
// ChatGPT can only wait on a Run for as long as one assistant turn lasts
// (~23-26 min). Runs that outlive that turn, or that ChatGPT simply stopped
// polling, finish with nobody looking. This module watches every Run the bridge
// hands back as still pending and, once it reaches a terminal status that no
// tool call has already returned to ChatGPT, posts a short Discord message so
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

export function formatRunNotification({
  runId,
  status,
  elapsedMs,
  instruction,
  slot = null,
}) {
  const normalized = String(status || "").toLowerCase();
  const icon = normalized === "completed" ? "✅" : "⚠️";
  // Slot 1 is the default and stays unnamed; parallel slots say which one.
  const where = Number.isInteger(slot) && slot > 1 ? " (slot " + slot + ")" : "";
  const lines = [
    icon + " Hermes a fini un run" + where + " : " + (normalized || "inconnu") +
      " après " + formatDuration(elapsedMs) + ".",
  ];
  const shown = preview(instruction);
  if (shown) lines.push("Demande : " + shown);
  lines.push("Dans ChatGPT, écris « continue » pour récupérer le résultat.");
  lines.push("run " + runId);
  return lines.join("\n");
}

export function createDiscordWebhookSender({
  webhookUrl,
  fetchImpl = globalThis.fetch,
  timeoutMs = 15000,
}) {
  if (!webhookUrl) return null;
  return async function send(text) {
    const response = await fetchImpl(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        content: text,
        username: "Hermes",
        // The instruction preview is user text: never let it ping anyone.
        allowed_mentions: { parse: [] },
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) {
      // Never surface the URL: it is the webhook's credential.
      throw new Error("Discord webhook failed with HTTP " + response.status);
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
  // runId -> { startedAtMs, instruction, slot, profile, delivered }
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
        const result = await getRun(runId, { profile: entry.profile });
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
            slot: entry.slot,
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
    watch(runId, { instruction = null, slot = null, profile = null } = {}) {
      if (!enabled || !runId || settled.has(runId)) return false;
      const existing = watched.get(runId);
      if (existing) {
        if (instruction && !existing.instruction) existing.instruction = instruction;
        if (slot && !existing.slot) existing.slot = slot;
        if (profile && !existing.profile) existing.profile = profile;
        return false;
      }
      const entry = {
        startedAtMs: now(),
        instruction,
        slot,
        profile,
        delivered: false,
      };
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
  return createRunNotifier({
    getRun,
    send: createDiscordWebhookSender({
      webhookUrl: env.HERMES_A2A_DISCORD_WEBHOOK_URL,
    }),
    pollMs: boundedNumber(env.HERMES_A2A_NOTIFY_POLL_MS, DEFAULT_POLL_MS, 50),
    graceMs: boundedNumber(env.HERMES_A2A_NOTIFY_GRACE_MS, DEFAULT_GRACE_MS, 0),
    onError,
  });
}
