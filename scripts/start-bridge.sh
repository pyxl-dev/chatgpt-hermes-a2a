#!/usr/bin/env bash
set -euo pipefail
umask 077

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RUNTIME_DIR="$ROOT/.runtime"

mkdir -p "$RUNTIME_DIR"
chmod 700 "$RUNTIME_DIR" 2>/dev/null || true

resolve_hermes_env_file() {
  local hermes_bin
  local resolved
  hermes_bin="$(command -v hermes || true)"
  if [[ -n "$hermes_bin" ]]; then
    resolved="$("$hermes_bin" config env-path 2>/dev/null || true)"
    if [[ -n "$resolved" && -f "$resolved" ]]; then
      printf '%s\n' "$resolved"
      return 0
    fi
  fi
  printf '%s\n' "$HOME/.hermes/.env"
}

HERMES_ENV_FILE="$(resolve_hermes_env_file)"

read_hermes_env_value() {
  local key="$1"
  local file="$HERMES_ENV_FILE"
  [[ -f "$file" ]] || return 0
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
  ' "$file"
}

if [[ -z "${API_SERVER_KEY:-}" && -n "${HERMES_API_SERVER_KEY:-}" ]]; then
  export API_SERVER_KEY="$HERMES_API_SERVER_KEY"
fi

if [[ -z "${API_SERVER_KEY:-}" ]]; then
  DETECTED_API_KEY="$(read_hermes_env_value API_SERVER_KEY)"
  HERMES_BIN_FOR_SECRET="$(command -v hermes || true)"
  if [[ -z "$DETECTED_API_KEY" && -n "$HERMES_BIN_FOR_SECRET" ]]; then
    DETECTED_API_KEY="$("$HERMES_BIN_FOR_SECRET" config get API_SERVER_KEY 2>/dev/null || true)"
  fi
  if [[ -n "$DETECTED_API_KEY" ]]; then
    export API_SERVER_KEY="$DETECTED_API_KEY"
  fi
  unset DETECTED_API_KEY HERMES_BIN_FOR_SECRET
fi

if [[ -z "${API_SERVER_PORT:-}" ]]; then
  DETECTED_API_PORT="$(read_hermes_env_value API_SERVER_PORT)"
  HERMES_BIN_FOR_CONFIG="$(command -v hermes || true)"
  if [[ -z "$DETECTED_API_PORT" && -n "$HERMES_BIN_FOR_CONFIG" ]]; then
    DETECTED_API_PORT="$("$HERMES_BIN_FOR_CONFIG" config get API_SERVER_PORT 2>/dev/null || true)"
  fi
  if [[ -z "$DETECTED_API_PORT" && -n "$HERMES_BIN_FOR_CONFIG" ]]; then
    DETECTED_API_PORT="$("$HERMES_BIN_FOR_CONFIG" config get platforms.api_server.extra.port 2>/dev/null || true)"
  fi
  if [[ "$DETECTED_API_PORT" =~ ^[0-9]+$ ]] &&
     (( DETECTED_API_PORT >= 1 && DETECTED_API_PORT <= 65535 )); then
    export API_SERVER_PORT="$DETECTED_API_PORT"
  fi
  unset DETECTED_API_PORT HERMES_BIN_FOR_CONFIG
fi

if [[ -z "${API_SERVER_KEY:-}" ]]; then
  echo "Hermes native Runs API key is not configured." >&2
  echo "Run: bash $ROOT/scripts/setup-hermes-control.sh" >&2
  exit 1
fi

export HERMES_ACTIVITY_LOG="${HERMES_ACTIVITY_LOG:-$RUNTIME_DIR/hermes-activity.jsonl}"

NODE_BIN="$(command -v node || true)"
if [[ -z "$NODE_BIN" ]]; then
  echo "node is not installed or is not on PATH." >&2
  exit 1
fi

unset HERMES_ENV_FILE
exec "$NODE_BIN" "$ROOT/src/hermes-mcp.mjs"
