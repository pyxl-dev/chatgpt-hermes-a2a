#!/usr/bin/env bash
set -euo pipefail
umask 077

HERMES_BIN="${HERMES_BIN:-$(command -v hermes || true)}"
if [[ -z "$HERMES_BIN" ]]; then
  echo "hermes is not installed or not on PATH." >&2
  exit 1
fi

ENV_FILE="$("$HERMES_BIN" config env-path 2>/dev/null || true)"
ENV_FILE="${ENV_FILE:-$HOME/.hermes/.env}"
mkdir -p "$(dirname "$ENV_FILE")"

read_env_value() {
  local key="$1"
  [[ -f "$ENV_FILE" ]] || return 0
  /usr/bin/awk -F= -v wanted="$key" '
    $1 ~ "^[[:space:]]*" wanted "[[:space:]]*$" {
      sub(/^[^=]*=/, "")
      gsub(/^[[:space:]]+|[[:space:]]+$/, "")
      if ((substr($0,1,1)=="\"" && substr($0,length($0),1)=="\"") ||
          (substr($0,1,1)==sprintf("%c",39) && substr($0,length($0),1)==sprintf("%c",39))) {
        $0=substr($0,2,length($0)-2)
      }
      print
      exit
    }
  ' "$ENV_FILE"
}

API_KEY="$(read_env_value API_SERVER_KEY)"
if [[ -z "$API_KEY" ]]; then
  API_KEY="$("$HERMES_BIN" config get API_SERVER_KEY 2>/dev/null || true)"
fi

if [[ -z "$API_KEY" ]]; then
  if command -v openssl >/dev/null 2>&1; then
    GENERATED_API_KEY="$(openssl rand -hex 32)"
  else
    GENERATED_API_KEY="$(python3 - <<'PY'
import secrets
print(secrets.token_hex(32))
PY
)"
  fi
  "$HERMES_BIN" config set API_SERVER_KEY "$GENERATED_API_KEY" >/dev/null

  # Do not trust the writer's exit code alone: resolve the value back through
  # Hermes' own config/secret precedence and fail closed if it was not retained.
  API_KEY="$("$HERMES_BIN" config get API_SERVER_KEY 2>/dev/null || true)"
  if [[ -z "$API_KEY" ]]; then
    unset GENERATED_API_KEY
    echo "Hermes did not retain API_SERVER_KEY after config set." >&2
    exit 4
  fi
  unset GENERATED_API_KEY
  echo "Created and verified a Hermes API server key."
else
  echo "Reusing the existing Hermes API server key."
fi

"$HERMES_BIN" config set API_SERVER_ENABLED true >/dev/null
"$HERMES_BIN" config set platforms.api_server.extra.host 127.0.0.1 >/dev/null

PORT="$(read_env_value API_SERVER_PORT)"
if [[ -z "$PORT" ]]; then
  PORT="$("$HERMES_BIN" config get API_SERVER_PORT 2>/dev/null || true)"
fi
if [[ -z "$PORT" ]]; then
  PORT="$("$HERMES_BIN" config get platforms.api_server.extra.port 2>/dev/null || true)"
fi
if [[ ! "$PORT" =~ ^[0-9]+$ ]] || (( PORT < 1 || PORT > 65535 )); then
  PORT=8642
fi

echo "Restarting Hermes gateway with the control API enabled..."
"$HERMES_BIN" gateway restart >/dev/null

READY=0
for _ in $(seq 1 30); do
  if curl -fsS --max-time 2 "http://127.0.0.1:$PORT/health" >/dev/null 2>&1; then
    READY=1
    break
  fi
  sleep 1
done

if [[ "$READY" -ne 1 ]]; then
  echo "Hermes API server did not become ready on 127.0.0.1:$PORT." >&2
  "$HERMES_BIN" gateway status || true
  exit 2
fi

CAPS="$(curl -fsS --max-time 5   -H "Authorization: Bearer $API_KEY"   "http://127.0.0.1:$PORT/v1/capabilities")"

if ! printf '%s' "$CAPS" | python3 -c '
import json, sys
data = json.load(sys.stdin)
features = data.get("features") or {}
endpoints = data.get("endpoints") or {}
ok = (
    features.get("run_submission") is True
    and features.get("run_stop") is True
    and (features.get("run_steer") is True or bool(endpoints.get("run_steer")))
)
raise SystemExit(0 if ok else 1)
'; then
  echo "Hermes API server is reachable but required Runs API capabilities are missing." >&2
  exit 3
fi

unset API_KEY CAPS

echo "===== HERMES CONTROL API ====="
echo "Enabled: YES"
echo "Bind: 127.0.0.1:$PORT"
echo "Authentication: bearer key resolved by Hermes config"
echo "Run submission: READY"
echo "Run steer/stop: READY"
echo "===== END HERMES CONTROL API ====="
