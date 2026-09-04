#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RUNTIME_DIR="$ROOT/.runtime"
RUNTIME_CONFIG="$RUNTIME_DIR/a2a-mcp.config.yaml"
TEMPLATE="$ROOT/config/a2a-mcp.config.yaml"
BIN="$ROOT/node_modules/.bin/a2a-mcp"

mkdir -p "$RUNTIME_DIR"

# launchd does not inherit the interactive shell environment. If Hermes A2A
# uses a bearer token, load only that single value from ~/.hermes/.env.
if [[ -z "${A2A_BEARER_TOKEN:-}" && -f "$HOME/.hermes/.env" ]]; then
  DETECTED_TOKEN="$(/usr/bin/awk -F= '
    $1 ~ /^[[:space:]]*A2A_BEARER_TOKEN[[:space:]]*$/ {
      sub(/^[^=]*=/, "")
      gsub(/^[[:space:]]+|[[:space:]]+$/, "")
      if ((substr($0,1,1)=="\"" && substr($0,length($0),1)=="\"") ||
          (substr($0,1,1)==sprintf("%c",39) && substr($0,length($0),1)==sprintf("%c",39))) {
        $0=substr($0,2,length($0)-2)
      }
      print
      exit
    }
  ' "$HOME/.hermes/.env")"
  if [[ -n "$DETECTED_TOKEN" ]]; then
    export A2A_BEARER_TOKEN="$DETECTED_TOKEN"
  fi
  unset DETECTED_TOKEN
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

NODE_BIN="$(command -v node || true)"
if [[ -z "$NODE_BIN" ]]; then
  echo "node is not installed or is not on PATH." >&2
  exit 1
fi

# Keep the proven generic a2a-mcp process as the private backend. The UX
# wrapper owns the public MCP stdio connection and never forwards its tool list.
export HERMES_A2A_BACKEND_BIN="${HERMES_A2A_BACKEND_BIN:-${A2A_MCP_BACKEND_BIN:-$BIN}}"
exec "$NODE_BIN" "$ROOT/src/hermes-mcp.mjs"
