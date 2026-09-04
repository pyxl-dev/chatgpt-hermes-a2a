#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RUNTIME_DIR="$ROOT/.runtime"
RUNTIME_CONFIG="$RUNTIME_DIR/a2a-mcp.config.yaml"
TEMPLATE="$ROOT/config/a2a-mcp.config.yaml"
BIN="$ROOT/node_modules/.bin/a2a-mcp"

mkdir -p "$RUNTIME_DIR"

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
exec "$BIN"
