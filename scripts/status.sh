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

if curl -fsS --max-time 3 http://127.0.0.1:9900/.well-known/agent-card.json >/dev/null 2>&1; then
  echo "Hermes A2A: READY"
else
  echo "Hermes A2A: NOT READY"
fi

READY=0
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
    READY=1
  else
    echo "Tunnel readyz: FAIL"
  fi
else
  echo "Tunnel health URL: MISSING"
fi

if [[ "$READY" -eq 1 ]]; then
  echo "Overall: READY"
else
  echo "Overall: NOT READY"
  echo
  echo "stderr tail:"
  tail -n 30 "$ERR_LOG" 2>/dev/null || true
  echo
  echo "stdout tail:"
  tail -n 30 "$OUT_LOG" 2>/dev/null || true
fi

echo "===== END STATUS ====="
exit $((1-READY))
