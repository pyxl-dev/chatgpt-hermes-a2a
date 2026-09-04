#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
mkdir -p "$ROOT/.runtime/logs"

TUNNELS_URL="https://platform.openai.com/settings/organization/tunnels"
KEYS_URL="https://platform.openai.com/settings/organization/api-keys"
CONNECTORS_URL="https://chatgpt.com/#settings/Connectors"

cat <<'TXT'

Next step: connect the validated local Hermes MCP→A2A bridge to ChatGPT.

Two OpenAI values are required:
  1) a Tunnel ID (tunnel_...)
  2) a Restricted runtime API key whose principal has Tunnels Read + Use

Your key will be read silently and kept only in this process environment.
It is not written to the repository or report.

I am opening the official OpenAI setup pages now.
TXT

open "$TUNNELS_URL" >/dev/null 2>&1 || true
open "$KEYS_URL" >/dev/null 2>&1 || true

printf '\nCreate or select the tunnel, then paste its ID here: '
read -r CONTROL_PLANE_TUNNEL_ID
if [[ ! "$CONTROL_PLANE_TUNNEL_ID" =~ ^tunnel_[A-Za-z0-9]+$ ]]; then
  echo "That does not look like a tunnel ID (expected tunnel_...)." >&2
  exit 2
fi

printf 'Paste the Restricted runtime API key (input hidden): '
read -rs CONTROL_PLANE_API_KEY
printf '\n'
if [[ -z "$CONTROL_PLANE_API_KEY" ]]; then
  echo "Runtime API key cannot be empty." >&2
  exit 2
fi

export CONTROL_PLANE_TUNNEL_ID
export CONTROL_PLANE_API_KEY

HEALTH_FILE="$ROOT/.runtime/live-tunnel-health.url"
LOG_FILE="$ROOT/.runtime/logs/live-tunnel.log"
rm -f "$HEALTH_FILE"

echo
echo "Starting tunnel-client and waiting for readiness..."
TUNNEL_HEALTH_URL_FILE="$HEALTH_FILE" bash "$ROOT/scripts/start-tunnel.sh" >"$LOG_FILE" 2>&1 &
PID=$!

cleanup() {
  kill "$PID" 2>/dev/null || true
  wait "$PID" 2>/dev/null || true
}
trap cleanup EXIT INT TERM

READY=0
for _ in $(seq 1 45); do
  if ! kill -0 "$PID" 2>/dev/null; then
    break
  fi
  if [[ -s "$HEALTH_FILE" ]]; then
    HEALTH_URL="$(cat "$HEALTH_FILE" 2>/dev/null || true)"
    if [[ -n "$HEALTH_URL" ]] && curl -fsS --max-time 3 "$HEALTH_URL/readyz" >/dev/null 2>&1; then
      READY=1
      break
    fi
  fi
  sleep 1
done

if [[ "$READY" -ne 1 ]]; then
  echo
  echo "Tunnel did not reach ready state. Last log lines:"
  tail -n 60 "$LOG_FILE" |     sed -E       -e 's/(Bearer )[A-Za-z0-9._~+\/-]+/\1[REDACTED]/g'       -e 's/(sk-[A-Za-z0-9_-]{8})[A-Za-z0-9_-]+/\1...[REDACTED]/g'
  exit 3
fi

echo
echo "TUNNEL READY"
echo "Tunnel ID: $CONTROL_PLANE_TUNNEL_ID"
echo "Local Hermes path: MCP -> A2A -> Hermes -> Mac"
echo
echo "Opening ChatGPT connector settings."
echo "Create/edit the plugin, choose Connection: Tunnel, then select or paste:"
echo "  $CONTROL_PLANE_TUNNEL_ID"
echo
echo "Keep this terminal window open while testing the plugin in ChatGPT."
echo "Press Ctrl-C when you want to stop the tunnel."

open "$CONNECTORS_URL" >/dev/null 2>&1 || true

wait "$PID"
