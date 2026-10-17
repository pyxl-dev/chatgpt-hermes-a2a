#!/usr/bin/env bash
set -euo pipefail
umask 077

HERMES_BIN="${HERMES_BIN:-$(command -v hermes || true)}"
if [[ -z "$HERMES_BIN" ]]; then
  echo "hermes is not installed or not on PATH." >&2
  exit 1
fi

# --profile NAME (repeatable) gives an existing Hermes profile its own
# API_SERVER_KEY so ChatGPT can run work in it. Under Hermes' multiplexed
# gateway, /p/<profile>/ requests must carry that profile's key; the gateway
# reads it live, so no restart is needed.
PROFILES=()
while [[ $# -gt 0 ]]; do
  case "$1" in
    --profile)
      [[ $# -ge 2 && -n "$2" ]] || { echo "--profile needs a profile name." >&2; exit 64; }
      PROFILES+=("$2")
      shift 2
      ;;
    *)
      echo "Unknown argument: $1" >&2
      echo "Usage: $0 [--profile NAME]..." >&2
      exit 64
      ;;
  esac
done

new_api_key() {
  if command -v openssl >/dev/null 2>&1; then
    openssl rand -hex 32
  else
    node -e 'process.stdout.write(require("node:crypto").randomBytes(32).toString("hex"))'
  fi
}

if [[ ${#PROFILES[@]} -gt 0 ]]; then
  PORT="$("$HERMES_BIN" config get API_SERVER_PORT 2>/dev/null || true)"
  [[ "$PORT" =~ ^[0-9]+$ ]] || PORT=8642
  STATUS=0
  for PROFILE in "${PROFILES[@]}"; do
    if [[ ! "$PROFILE" =~ ^[a-z0-9][a-z0-9_-]{0,63}$ ]]; then
      echo "$PROFILE: invalid profile name." >&2
      STATUS=1
      continue
    fi
    if ! "$HERMES_BIN" profile show "$PROFILE" >/dev/null 2>&1; then
      echo "$PROFILE: no such Hermes profile." >&2
      STATUS=1
      continue
    fi
    KEY="$("$HERMES_BIN" -p "$PROFILE" config get API_SERVER_KEY --raw 2>/dev/null || true)"
    if [[ -z "$KEY" ]]; then
      KEY="$(new_api_key)"
      "$HERMES_BIN" -p "$PROFILE" config set API_SERVER_KEY "$KEY" >/dev/null
      echo "$PROFILE: created an API server key."
    else
      echo "$PROFILE: reusing its API server key."
    fi
    CODE="$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 \
      -H "Authorization: Bearer $KEY" \
      "http://127.0.0.1:$PORT/p/$PROFILE/v1/capabilities" || true)"
    unset KEY
    if [[ "$CODE" == "200" ]]; then
      echo "$PROFILE: reachable at /p/$PROFILE/ — ChatGPT can now use it."
    else
      echo "$PROFILE: the gateway answered HTTP $CODE on /p/$PROFILE/. Check that gateway.multiplex_profiles is on and the profile is not standalone or parked." >&2
      STATUS=1
    fi
  done
  exit "$STATUS"
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

read_config_raw() {
  local key="$1"
  "$HERMES_BIN" config get "$key" --raw 2>/dev/null || true
}

valid_port() {
  [[ "$1" =~ ^[0-9]+$ ]] &&
    (( 10#$1 >= 1 && 10#$1 <= 65535 ))
}

API_KEY="$(read_env_value API_SERVER_KEY)"
if [[ -z "$API_KEY" ]]; then
  API_KEY="$(read_config_raw API_SERVER_KEY)"
fi

if [[ -z "$API_KEY" ]]; then
  GENERATED_API_KEY="$(new_api_key)"
  "$HERMES_BIN" config set API_SERVER_KEY "$GENERATED_API_KEY" >/dev/null

  # Hermes 0.21.5 masks credential-shaped values from "config get" unless
  # --raw is requested. Prefer the file Hermes says it wrote, then use the
  # raw CLI as a compatibility fallback.
  API_KEY="$(read_env_value API_SERVER_KEY)"
  if [[ -z "$API_KEY" ]]; then
    API_KEY="$(read_config_raw API_SERVER_KEY)"
  fi
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

PORT="$(read_env_value API_SERVER_PORT)"
if ! valid_port "$PORT"; then
  PORT="$("$HERMES_BIN" config get API_SERVER_PORT 2>/dev/null || true)"
fi
if ! valid_port "$PORT"; then
  PORT=8642
fi

# Use the public API_SERVER_* settings documented by current Hermes instead of
# relying on legacy/internal platform config paths.
"$HERMES_BIN" config set API_SERVER_ENABLED true >/dev/null
"$HERMES_BIN" config set API_SERVER_HOST 127.0.0.1 >/dev/null
"$HERMES_BIN" config set API_SERVER_PORT "$PORT" >/dev/null

# "gateway restart" can intentionally drain active Runs for a very long time.
# Control-API setup needs the new environment to take effect now, so perform a
# bounded lifecycle restart instead. Hermes' stop path already escalates a
# non-exiting gateway after its bounded grace period.
echo "Restarting Hermes gateway with the control API enabled..."
"$HERMES_BIN" gateway stop >/dev/null 2>&1 || true
"$HERMES_BIN" gateway start >/dev/null

READY=0
for _ in $(seq 1 60); do
  if curl -fsS --max-time 2 "http://127.0.0.1:$PORT/health" >/dev/null 2>&1; then
    READY=1
    break
  fi
  sleep 1
done

if [[ "$READY" -ne 1 ]]; then
  echo "Hermes API server did not become ready on 127.0.0.1:$PORT." >&2
  "$HERMES_BIN" gateway status || true
  LOG_DIR="$(dirname "$ENV_FILE")/logs"
  if [[ -f "$LOG_DIR/gateway.error.log" ]]; then
    echo >&2
    echo "Hermes gateway stderr tail:" >&2
    tail -n 50 "$LOG_DIR/gateway.error.log" >&2 || true
  fi
  exit 2
fi

CAPS="$(curl -fsS --max-time 5 \
  -H "Authorization: Bearer $API_KEY" \
  "http://127.0.0.1:$PORT/v1/capabilities")"

if ! printf '%s' "$CAPS" | node -e '
const fs = require("node:fs");
try {
  const data = JSON.parse(fs.readFileSync(0, "utf8"));
  const features = data.features || {};
  const endpoints = data.endpoints || {};
  const ok =
    features.run_submission === true &&
    features.run_status === true &&
    features.run_stop === true &&
    (features.run_steer === true || Boolean(endpoints.run_steer));
  process.exit(ok ? 0 : 1);
} catch {
  process.exit(1);
}
'; then
  echo "Hermes API server is reachable but required Runs API capabilities are missing." >&2
  exit 3
fi

unset API_KEY CAPS

echo "===== HERMES CONTROL API ====="
echo "Enabled: YES"
echo "Bind: 127.0.0.1:$PORT"
echo "Authentication: bearer key resolved from Hermes .env/config"
echo "Run submission: READY"
echo "Run steer/stop: READY"
echo "===== END HERMES CONTROL API ====="
