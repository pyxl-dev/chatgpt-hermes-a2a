#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PROFILE="${TUNNEL_PROFILE:-chatgpt-hermes-a2a}"

if [[ -z "${CONTROL_PLANE_TUNNEL_ID:-}" ]]; then
  echo "CONTROL_PLANE_TUNNEL_ID is required." >&2
  exit 2
fi
if [[ -z "${CONTROL_PLANE_API_KEY:-}" ]]; then
  echo "CONTROL_PLANE_API_KEY is required." >&2
  exit 2
fi

if command -v tunnel-client >/dev/null 2>&1; then
  TC="$(command -v tunnel-client)"
else
  TC="$(bash "$ROOT/scripts/install-tunnel-client.sh")"
fi

if [[ ! -d "$ROOT/node_modules" ]]; then
  (cd "$ROOT" && npm install --no-package-lock --no-audit --no-fund)
fi

if ! "$TC" profiles list 2>/dev/null | grep -Fq "$PROFILE"; then
  "$TC" init     --sample sample_mcp_stdio_local     --profile "$PROFILE"     --tunnel-id "$CONTROL_PLANE_TUNNEL_ID"     --mcp-command "$ROOT/scripts/start-bridge.sh"
fi

"$TC" doctor --profile "$PROFILE" --explain

HEALTH_FILE="${TUNNEL_HEALTH_URL_FILE:-$ROOT/.runtime/live-tunnel-health.url}"
mkdir -p "$ROOT/.runtime"
rm -f "$HEALTH_FILE"

exec "$TC" run   --profile "$PROFILE"   --health.listen-addr 127.0.0.1:0   --health.url-file "$HEALTH_FILE"
