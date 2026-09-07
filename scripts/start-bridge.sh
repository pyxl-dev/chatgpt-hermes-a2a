#!/usr/bin/env bash
set -euo pipefail
umask 077

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RUNTIME_DIR="$ROOT/.runtime"
RUNTIME_CONFIG="$RUNTIME_DIR/a2a-mcp.config.yaml"
TEMPLATE="$ROOT/config/a2a-mcp.config.yaml"
BIN="$ROOT/node_modules/.bin/a2a-mcp"

mkdir -p "$RUNTIME_DIR"
chmod 700 "$RUNTIME_DIR" 2>/dev/null || true

# launchd does not inherit the interactive shell environment. Resolve the
# active Hermes profile's env file through the Hermes CLI, then read only the
# exact values this bridge needs; never source the full Hermes .env.
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

if [[ -z "${A2A_BEARER_TOKEN:-}" ]]; then
  DETECTED_A2A_TOKEN="$(read_hermes_env_value A2A_BEARER_TOKEN)"
  if [[ -n "$DETECTED_A2A_TOKEN" ]]; then
    export A2A_BEARER_TOKEN="$DETECTED_A2A_TOKEN"
  fi
  unset DETECTED_A2A_TOKEN
fi

if [[ -z "${API_SERVER_KEY:-}" ]]; then
  DETECTED_API_KEY="$(read_hermes_env_value API_SERVER_KEY)"
  if [[ -n "$DETECTED_API_KEY" ]]; then
    export API_SERVER_KEY="$DETECTED_API_KEY"
  fi
  unset DETECTED_API_KEY
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

if [[ ! -x "$BIN" ]]; then
  echo "a2a-mcp is not installed. Run: npm install --no-package-lock --no-audit --no-fund" >&2
  exit 1
fi

if [[ -n "${A2A_BEARER_TOKEN:-}" ]]; then
  cat >"$RUNTIME_CONFIG" <<'YAML'
agents:
  hermes:
    cardUrl: "http://127.0.0.1:9900/.well-known/agent-card.json"
    allowedBindings: ["JSONRPC", "HTTP+JSON"]
    authProfile: "hermes-local"
    signaturePolicy: "disabled"
    directUrlPolicy: "disabled"

authProfiles:
  hermes-local:
    type: "bearer-env"
    env: "A2A_BEARER_TOKEN"

network:
  allowPrivateAddresses: true
  requireHttps: false
  timeoutMs: 330000
  maxResponseBytes: 10485760
YAML
else
  cp "$TEMPLATE" "$RUNTIME_CONFIG"
fi

export A2A_MCP_CONFIG="$RUNTIME_CONFIG"
export HERMES_ACTIVITY_LOG="${HERMES_ACTIVITY_LOG:-$RUNTIME_DIR/hermes-activity.jsonl}"

NODE_BIN="$(command -v node || true)"
if [[ -z "$NODE_BIN" ]]; then
  echo "node is not installed or is not on PATH." >&2
  exit 1
fi

# Keep the proven generic a2a-mcp process as the private backend. The UX
# wrapper owns the public MCP stdio connection and never forwards its tool list.
export HERMES_A2A_BACKEND_BIN="${HERMES_A2A_BACKEND_BIN:-${A2A_MCP_BACKEND_BIN:-$BIN}}"
unset HERMES_ENV_FILE
exec "$NODE_BIN" "$ROOT/src/hermes-mcp.mjs"
