#!/usr/bin/env bash
set -u

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LABEL="com.pyxl.chatgpt-hermes-a2a"
UID_NUM="$(id -u)"
HEALTH_FILE="$ROOT/.runtime/daemon-health.url"
OUT_LOG="$HOME/Library/Logs/chatgpt-hermes-a2a.out.log"
ERR_LOG="$HOME/Library/Logs/chatgpt-hermes-a2a.err.log"

echo "===== HERMES MAC STATUS ====="

if launchctl print "gui/$UID_NUM/$LABEL" >/tmp/chatgpt-hermes-launchctl-status.$$ 2>&1; then
  echo "LaunchAgent loaded: YES"
  PID="$(grep -E '^[[:space:]]*pid = ' /tmp/chatgpt-hermes-launchctl-status.$$ | head -n1 | awk '{print $3}')"
  STATE="$(grep -E '^[[:space:]]*state = ' /tmp/chatgpt-hermes-launchctl-status.$$ | head -n1 | sed -E 's/^[[:space:]]*state = //')"
  [[ -n "$PID" ]] && echo "PID: $PID"
  [[ -n "$STATE" ]] && echo "launchd state: $STATE"
else
  echo "LaunchAgent loaded: NO"
fi
rm -f /tmp/chatgpt-hermes-launchctl-status.$$

resolve_hermes_env_file() {
  local hermes_bin resolved
  hermes_bin="$(command -v hermes || true)"
  if [[ -n "$hermes_bin" ]]; then
    resolved="$("$hermes_bin" config env-path 2>/dev/null || true)"
    if [[ -n "$resolved" && -f "$resolved" ]]; then
      printf '%s\n' "$resolved"
      return
    fi
  fi
  printf '%s\n' "$HOME/.hermes/.env"
}

read_env_value() {
  local key="$1" file="$2"
  [[ -f "$file" ]] || return 0
  /usr/bin/awk -F= -v wanted="$key" '
    $1 ~ "^[[:space:]]*" wanted "[[:space:]]*$" {
      sub(/^[^=]*=/, "")
      gsub(/^[[:space:]]+|[[:space:]]+$/, "")
      gsub(/^["'"'"']|["'"'"']$/, "")
      print
      exit
    }
  ' "$file"
}

valid_port() {
  [[ "$1" =~ ^[0-9]+$ ]] &&
    (( 10#$1 >= 1 && 10#$1 <= 65535 ))
}

HERMES_ENV_FILE="$(resolve_hermes_env_file)"

API_KEY="${HERMES_API_SERVER_KEY:-${API_SERVER_KEY:-$(read_env_value API_SERVER_KEY "$HERMES_ENV_FILE")}}"
HERMES_BIN_FOR_CONFIG="$(command -v hermes || true)"
if [[ -z "$API_KEY" && -n "$HERMES_BIN_FOR_CONFIG" ]]; then
  API_KEY="$("$HERMES_BIN_FOR_CONFIG" config get API_SERVER_KEY 2>/dev/null || true)"
fi

API_PORT="${API_SERVER_PORT:-}"
if ! valid_port "$API_PORT"; then
  API_PORT="$(read_env_value API_SERVER_PORT "$HERMES_ENV_FILE")"
fi
if ! valid_port "$API_PORT" && [[ -n "$HERMES_BIN_FOR_CONFIG" ]]; then
  API_PORT="$("$HERMES_BIN_FOR_CONFIG" config get API_SERVER_PORT 2>/dev/null || true)"
fi
if ! valid_port "$API_PORT" && [[ -n "$HERMES_BIN_FOR_CONFIG" ]]; then
  API_PORT="$("$HERMES_BIN_FOR_CONFIG" config get platforms.api_server.extra.port 2>/dev/null || true)"
fi
if ! valid_port "$API_PORT"; then
  API_PORT="8642"
fi
API_URL="$(node -e 'process.stdout.write(String(process.argv[1] || "").trim().replace(/\/+$/u, ""))' "${HERMES_API_SERVER_URL:-}")"
if [[ -z "$API_URL" ]]; then
  API_URL="http://127.0.0.1:$API_PORT"
fi

API_URL_VALID=1
if ! node -e '
try {
  const url = new URL(process.argv[1]);
  const supported =
    ["http:", "https:"].includes(url.protocol) &&
    url.username === "" &&
    url.password === "";
  process.exit(supported ? 0 : 1);
} catch {
  process.exit(1);
}
' "$API_URL"; then
  echo "Hermes API server URL is invalid or unsupported; expected HTTP(S) without credentials." >&2
  API_URL_VALID=0
fi

NATIVE_READY=0
CAPABILITIES_JSON=""
if [[ -n "$API_KEY" && "$API_URL_VALID" -eq 1 ]]; then
  CAPABILITIES_JSON="$(
    curl -fsS --max-time 3       -H "Authorization: Bearer $API_KEY"       "$API_URL/v1/capabilities" 2>/dev/null || true
  )"
fi

if [[ -n "$CAPABILITIES_JSON" ]] &&
   printf '%s' "$CAPABILITIES_JSON" | node -e '
     const fs = require("fs");
     try {
       const payload = JSON.parse(fs.readFileSync(0, "utf8"));
       const features = payload?.features || {};
       const endpoints = payload?.endpoints || {};
       process.exit(
         features.run_submission === true &&
         features.run_status === true &&
         features.run_stop === true &&
         (features.run_steer === true || Boolean(endpoints.run_steer))
           ? 0
           : 1
       );
     } catch {
       process.exit(1);
     }
   '; then
  echo "Hermes native Runs API: READY"
  NATIVE_READY=1
else
  echo "Hermes native Runs API: NOT READY"
fi
unset CAPABILITIES_JSON API_URL HERMES_BIN_FOR_CONFIG API_KEY API_PORT HERMES_ENV_FILE

TUNNEL_READY=0
if [[ -s "$HEALTH_FILE" ]]; then
  HEALTH_URL="$(cat "$HEALTH_FILE" 2>/dev/null || true)"
  echo "Tunnel health URL: ${HEALTH_URL:-unknown}"
  if [[ -n "${HEALTH_URL:-}" ]] && curl -fsS --max-time 3 "$HEALTH_URL/healthz" >/dev/null 2>&1; then
    echo "Tunnel healthz: OK"
  else
    echo "Tunnel healthz: FAIL"
  fi
  if [[ -n "${HEALTH_URL:-}" ]] && curl -fsS --max-time 3 "$HEALTH_URL/readyz" >/dev/null 2>&1; then
    echo "Tunnel readyz: OK"
    TUNNEL_READY=1
  else
    echo "Tunnel readyz: FAIL"
  fi
else
  echo "Tunnel health URL: MISSING"
fi

if [[ "$NATIVE_READY" -eq 1 && "$TUNNEL_READY" -eq 1 ]]; then
  echo "Overall: READY"
  RC=0
else
  echo "Overall: NOT READY"
  echo
  echo "stderr tail:"
  tail -n 30 "$ERR_LOG" 2>/dev/null || true
  echo
  echo "stdout tail:"
  tail -n 30 "$OUT_LOG" 2>/dev/null || true
  RC=1
fi

echo "===== END STATUS ====="
exit "$RC"
