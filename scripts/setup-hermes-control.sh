#!/usr/bin/env bash
set -euo pipefail
umask 077

HERMES_BIN="${HERMES_BIN:-$(command -v hermes || true)}"
if [[ -z "$HERMES_BIN" ]]; then
  echo "hermes is not installed or not on PATH." >&2
  exit 1
fi

ENV_FILE="$HOME/.hermes/.env"
mkdir -p "$HOME/.hermes"

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
  if command -v openssl >/dev/null 2>&1; then
    API_KEY="$(openssl rand -hex 32)"
  else
    API_KEY="$(python3 - <<'PY'
import secrets
print(secrets.token_hex(32))
PY
)"
  fi
  "$HERMES_BIN" config set API_SERVER_KEY "$API_KEY" >/dev/null
  echo "Created a Hermes API server key in ~/.hermes/.env."
else
  echo "Reusing the existing Hermes API server key."
fi

"$HERMES_BIN" config set API_SERVER_ENABLED true >/dev/null
"$HERMES_BIN" config set API_SERVER_HOST 127.0.0.1 >/dev/null

PORT="$(read_env_value API_SERVER_PORT)"
PORT="${PORT:-8642}"

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

if [[ "$CAPS" != *'"run_submission": true'* ||
      "$CAPS" != *'"run_stop": true'* ]]; then
  echo "Hermes API server is reachable but required Runs API capabilities are missing." >&2
  exit 3
fi

unset API_KEY CAPS

echo "===== HERMES CONTROL API ====="
echo "Enabled: YES"
echo "Bind: 127.0.0.1:$PORT"
echo "Authentication: bearer key in ~/.hermes/.env"
echo "Run submission: READY"
echo "Run steer/stop: READY"
echo "===== END HERMES CONTROL API ====="
