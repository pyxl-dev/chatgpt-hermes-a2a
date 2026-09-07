import { createHash } from "node:crypto";

const DEFAULT_API_URL = "http://127.0.0.1:8642";
const DEFAULT_TIMEOUT_MS = 30000;

function requiredString(value, label) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(label + " must be a non-empty string");
  }
  return value.trim();
}

function controlIdempotencyKey(sessionId, instruction) {
  const bucket = Math.floor(Date.now() / 60000);
  return createHash("sha256")
    .update(String(bucket) + "\n" + String(sessionId || "new") + "\n" + instruction)
    .digest("hex");
}

export function createHermesControl({ redactText, redactValue }) {
  const apiUrl = String(
    process.env.HERMES_API_SERVER_URL ||
      (process.env.API_SERVER_PORT
        ? "http://127.0.0.1:" + process.env.API_SERVER_PORT
        : DEFAULT_API_URL),
  ).replace(/\/+$/u, "");
  const apiKey =
    process.env.HERMES_API_SERVER_KEY || process.env.API_SERVER_KEY || "";
  const configuredTimeout = Number(process.env.HERMES_CONTROL_TIMEOUT_MS);
  const timeoutMs =
    Number.isFinite(configuredTimeout) && configuredTimeout >= 1000
      ? configuredTimeout
      : DEFAULT_TIMEOUT_MS;

  function ensureConfigured() {
    if (!apiKey) {
      throw new Error(
        "Hermes control API is not configured. Run scripts/setup-hermes-control.sh, restart the bridge, then retry.",
      );
    }
  }

  async function request(path, { method = "GET", body, headers = {} } = {}) {
    ensureConfigured();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(apiUrl + path, {
        method,
        signal: controller.signal,
        headers: {
          Authorization: "Bearer " + apiKey,
          Accept: "application/json",
          ...(body === undefined ? {} : { "Content-Type": "application/json" }),
          ...headers,
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      const raw = await response.text();
      let payload = null;
      if (raw) {
        try {
          payload = JSON.parse(raw);
        } catch {
          payload = { text: raw };
        }
      }
      if (!response.ok) {
        const message =
          payload?.error?.message ||
          payload?.message ||
          payload?.text ||
          response.statusText ||
          "Hermes control API request failed";
        const error = new Error(
          redactText(
            "Hermes control API " +
              method +
              " " +
              path +
              " failed (" +
              response.status +
              "): " +
              message,
          ),
        );
        error.status = response.status;
        error.code = payload?.error?.code || payload?.code || null;
        throw error;
      }
      return redactValue(payload || {});
    } catch (error) {
      if (error?.name === "AbortError") {
        throw new Error(
          "Hermes control API request timed out after " + timeoutMs + "ms",
        );
      }
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  async function status() {
    const payload = await request("/v1/capabilities");
    return {
      ok: true,
      operation: "hermes_control_status",
      agent: "hermes",
      apiUrl,
      runSubmission: payload?.features?.run_submission === true,
      runStatus: payload?.features?.run_status === true,
      runSteer:
        payload?.features?.run_steer === true ||
        Boolean(payload?.endpoints?.run_steer),
      runStop: payload?.features?.run_stop === true,
    };
  }

  async function startRun(instruction, sessionId = null) {
    const text = requiredString(instruction, "instruction");
    const durableSessionId =
      typeof sessionId === "string" && sessionId.trim()
        ? sessionId.trim()
        : null;
    const payload = await request("/v1/runs", {
      method: "POST",
      headers: {
        "Idempotency-Key": controlIdempotencyKey(durableSessionId, text),
      },
      body: {
        input: text,
        ...(durableSessionId ? { session_id: durableSessionId } : {}),
      },
    });
    return {
      ok: true,
      operation: "start_hermes_run",
      agent: "hermes",
      runId: payload?.run_id || payload?.id || null,
      sessionId: payload?.session_id || durableSessionId || null,
      status: payload?.status || "started",
      replayed: payload?.replayed === true,
    };
  }

  async function getRun(runId) {
    const id = requiredString(runId, "runId");
    const payload = await request("/v1/runs/" + encodeURIComponent(id));
    return {
      ok: true,
      operation: "get_hermes_run",
      agent: "hermes",
      runId: payload?.run_id || id,
      sessionId: payload?.session_id || null,
      status: payload?.status || null,
      output: payload?.output || null,
      error: payload?.error || null,
      usage: payload?.usage || null,
      pendingSteer: payload?.pending_steer || null,
      lastEvent: payload?.last_event || null,
      approval: payload?.approval || null,
    };
  }

  async function steerRun(runId, instruction) {
    const id = requiredString(runId, "runId");
    const text = requiredString(instruction, "instruction");
    const payload = await request(
      "/v1/runs/" + encodeURIComponent(id) + "/steer",
      {
        method: "POST",
        body: { input: text },
      },
    );
    return {
      ok: true,
      operation: "steer_hermes_run",
      agent: "hermes",
      runId: payload?.run_id || id,
      accepted: payload?.accepted === true,
      status: payload?.accepted === true ? "queued" : payload?.status || null,
    };
  }

  async function stopRun(runId) {
    const id = requiredString(runId, "runId");
    const payload = await request(
      "/v1/runs/" + encodeURIComponent(id) + "/stop",
      { method: "POST", body: {} },
    );
    return {
      ok: true,
      operation: "stop_hermes_run",
      agent: "hermes",
      runId: payload?.run_id || id,
      sessionId: payload?.session_id || null,
      status: payload?.status || null,
      output: payload?.output || null,
    };
  }

  return {
    apiUrl,
    configured: Boolean(apiKey),
    status,
    startRun,
    getRun,
    steerRun,
    stopRun,
  };
}
