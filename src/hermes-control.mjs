import { createHash } from "node:crypto";

const DEFAULT_API_URL = "http://127.0.0.1:8642";
const DEFAULT_TIMEOUT_MS = 30000;
const UNSUCCESSFUL_TERMINAL_RUN_STATUSES = new Set([
  "failed",
  "rejected",
  "cancelled",
  "canceled",
  "interrupted",
]);

function requiredString(value, label) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(label + " must be a non-empty string");
  }
  return value.trim();
}

function normalizeInstruction(value) {
  return String(value || "").normalize("NFKC").trim().replace(/\s+/gu, " ");
}

function normalizedApiPort(value) {
  const text = String(value ?? "").trim();
  if (!/^\d+$/u.test(text)) return null;
  const port = Number(text);
  return Number.isInteger(port) && port >= 1 && port <= 65535
    ? String(port)
    : null;
}

export function resolveHermesApiUrl(
  apiServerUrl = process.env.HERMES_API_SERVER_URL,
  apiServerPort = process.env.API_SERVER_PORT,
) {
  const explicitUrl = String(apiServerUrl || "").trim();
  if (explicitUrl) return explicitUrl.replace(/\/+$/u, "");

  const port = normalizedApiPort(apiServerPort);
  return port ? "http://127.0.0.1:" + port : DEFAULT_API_URL;
}

export function controlIdempotencyKey(
  sessionId,
  instruction,
  scope = "unscoped",
  nowMs = Date.now(),
) {
  const normalizedScope = String(scope || "unscoped");
  const prefix =
    normalizedScope === "unscoped"
      ? "minute:" + Math.floor(nowMs / 60000)
      : "operation:" + normalizedScope;
  return createHash("sha256")
    .update(
      prefix +
        "\n" +
        String(sessionId || "new") +
        "\n" +
        normalizeInstruction(instruction),
    )
    .digest("hex");
}

export function createHermesControl({ redactText, redactValue }) {
  const apiUrl = resolveHermesApiUrl();
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

  async function request(
    path,
    {
      method = "GET",
      body,
      headers = {},
      timeoutOverrideMs = null,
    } = {},
  ) {
    ensureConfigured();
    const methodName = String(method || "GET").toUpperCase();
    const configuredOverride = Number(timeoutOverrideMs);
    const requestTimeoutMs =
      Number.isFinite(configuredOverride) && configuredOverride > 0
        ? Math.min(timeoutMs, Math.max(1, Math.floor(configuredOverride)))
        : timeoutMs;
    let requestUrl;
    let requestHeaders;
    try {
      requestUrl = new URL(apiUrl + path);
      if (
        !["http:", "https:"].includes(requestUrl.protocol) ||
        requestUrl.username !== "" ||
        requestUrl.password !== ""
      ) {
        throw new Error(
          "Hermes control API URL must use HTTP(S) and must not contain credentials",
        );
      }
      requestHeaders = new Headers({
        Authorization: "Bearer " + apiKey,
        Accept: "application/json",
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        ...headers,
      });
    } catch (error) {
      error.deliveryAmbiguous = false;
      throw error;
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), requestTimeoutMs);
    try {
      const response = await fetch(requestUrl, {
        method,
        signal: controller.signal,
        headers: requestHeaders,
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
        error.deliveryAmbiguous =
          methodName !== "GET" && response.status >= 500;
        throw error;
      }
      return redactValue(payload || {});
    } catch (error) {
      if (error?.name === "AbortError") {
        const timeoutError = new Error(
          "Hermes control API request timed out after " + requestTimeoutMs + "ms",
        );
        timeoutError.deliveryAmbiguous = methodName !== "GET";
        throw timeoutError;
      }
      if (
        methodName !== "GET" &&
        error?.deliveryAmbiguous === undefined &&
        error?.status === undefined
      ) {
        error.deliveryAmbiguous = true;
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

  async function startRun(
    instruction,
    sessionId = null,
    idempotencyScope = "unscoped",
  ) {
    const text = requiredString(instruction, "instruction");
    const durableSessionId =
      typeof sessionId === "string" && sessionId.trim()
        ? sessionId.trim()
        : null;
    const payload = await request("/v1/runs", {
      method: "POST",
      headers: {
        "Idempotency-Key": controlIdempotencyKey(
          durableSessionId,
          text,
          idempotencyScope,
        ),
      },
      body: {
        input: text,
        ...(durableSessionId ? { session_id: durableSessionId } : {}),
      },
    });
    const runId = payload?.run_id || payload?.id || null;
    const status = payload?.status || "started";
    if (
      !runId &&
      UNSUCCESSFUL_TERMINAL_RUN_STATUSES.has(
        String(status).toLowerCase(),
      )
    ) {
      const error = new Error(
        redactText(
          "Hermes rejected native Run submission before returning a runId" +
            (status ? " (status: " + status + ")" : "") +
            ".",
        ),
      );
      error.code = "HERMES_NATIVE_RUN_FAILED";
      error.deliveryAmbiguous = false;
      error.details = {
        runId: null,
        sessionId: payload?.session_id || durableSessionId || null,
        status,
        error: payload?.error || null,
      };
      throw error;
    }

    return {
      ok: true,
      operation: "start_hermes_run",
      agent: "hermes",
      runId,
      sessionId: payload?.session_id || durableSessionId || null,
      status,
      output: payload?.output || null,
      error: payload?.error || null,
      usage: payload?.usage || null,
      pendingSteer: payload?.pending_steer || null,
      lastEvent: payload?.last_event || null,
      approval: payload?.approval || null,
      replayed: payload?.replayed === true,
    };
  }

  async function getRun(runId, { timeoutMs: timeoutOverrideMs = null } = {}) {
    const id = requiredString(runId, "runId");
    const payload = await request("/v1/runs/" + encodeURIComponent(id), {
      timeoutOverrideMs,
    });
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
