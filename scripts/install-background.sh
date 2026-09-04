#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

PROFILE="chatgpt-hermes-a2a"
LABEL="com.pyxl.chatgpt-hermes-a2a"
KEYCHAIN_SERVICE="chatgpt-hermes-a2a.runtime-api-key"
ACCOUNT="$(id -un)"
UID_NUM="$(id -u)"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
LOG_DIR="$HOME/Library/Logs"
OUT_LOG="$LOG_DIR/chatgpt-hermes-a2a.out.log"
ERR_LOG="$LOG_DIR/chatgpt-hermes-a2a.err.log"
HEALTH_FILE="$ROOT/.runtime/daemon-health.url"

export PATH="$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"

mkdir -p "$ROOT/.runtime" "$LOG_DIR" "$HOME/Library/LaunchAgents"

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "This background installer currently targets macOS/launchd only." >&2
  exit 2
fi

if [[ ! -d "$ROOT/node_modules" ]]; then
  echo "Installing pinned MCP dependencies..."
  npm install --no-package-lock --no-audit --no-fund
fi

if command -v tunnel-client >/dev/null 2>&1; then
  TC="$(command -v tunnel-client)"
elif [[ -x "$ROOT/.tools/tunnel-client/current" ]]; then
  TC="$ROOT/.tools/tunnel-client/current"
else
  echo "Installing official OpenAI tunnel-client..."
  TC="$(bash "$ROOT/scripts/install-tunnel-client.sh")"
fi

TUNNEL_ID="${CONTROL_PLANE_TUNNEL_ID:-}"

if [[ -z "$TUNNEL_ID" ]]; then
  PROFILE_PATH="$("$TC" profiles list --json 2>/dev/null | python3 -c '
import json,sys
try:
    rows=json.load(sys.stdin)
except Exception:
    rows=[]
for row in rows:
    if row.get("name")=="chatgpt-hermes-a2a":
        print(row.get("path",""))
        break
' || true)"

  if [[ -n "$PROFILE_PATH" && -f "$PROFILE_PATH" ]]; then
    TUNNEL_ID="$(python3 - "$PROFILE_PATH" <<'PY'
import re,sys
text=open(sys.argv[1], encoding="utf-8", errors="ignore").read()
m=re.search(r"\btunnel_[A-Za-z0-9]+\b", text)
print(m.group(0) if m else "")
PY
)"
  fi
fi

if [[ -z "$TUNNEL_ID" ]]; then
  printf 'Tunnel ID (tunnel_...): '
  read -r TUNNEL_ID
fi

if [[ ! "$TUNNEL_ID" =~ ^tunnel_[A-Za-z0-9]+$ ]]; then
  echo "Invalid tunnel ID: expected tunnel_..." >&2
  exit 3
fi

if [[ "${RESET_RUNTIME_KEY:-0}" == "1" ]]; then
  /usr/bin/security delete-generic-password -a "$ACCOUNT" -s "$KEYCHAIN_SERVICE" >/dev/null 2>&1 || true
fi

if /usr/bin/security find-generic-password -a "$ACCOUNT" -s "$KEYCHAIN_SERVICE" -w >/dev/null 2>&1; then
  echo "Reusing runtime API key already stored in macOS Keychain."
else
  if [[ -n "${CONTROL_PLANE_API_KEY:-}" ]]; then
    RUNTIME_KEY="$CONTROL_PLANE_API_KEY"
  else
    printf 'Restricted OpenAI runtime API key (input hidden): '
    read -rs RUNTIME_KEY
    printf '\n'
  fi

  if [[ -z "${RUNTIME_KEY:-}" ]]; then
    echo "Runtime API key cannot be empty." >&2
    exit 3
  fi

  /usr/bin/security add-generic-password     -U     -a "$ACCOUNT"     -s "$KEYCHAIN_SERVICE"     -w "$RUNTIME_KEY"     >/dev/null

  unset RUNTIME_KEY
  echo "Stored runtime API key in macOS Keychain."
fi

export CONTROL_PLANE_API_KEY="$(/usr/bin/security find-generic-password   -a "$ACCOUNT"   -s "$KEYCHAIN_SERVICE"   -w)"

MCP_COMMAND="/bin/bash $ROOT/scripts/start-bridge.sh"

echo "Writing tunnel profile for $TUNNEL_ID..."
"$TC" profiles add "$PROFILE"   --force   --sample sample_mcp_stdio_local   --tunnel-id "$TUNNEL_ID"   --mcp-command "$MCP_COMMAND"

echo "Validating tunnel profile..."
"$TC" doctor --profile "$PROFILE" --explain >/dev/null
echo "Profile validation passed."

# Retire the foreground POC runtime if it is still running.
while IFS= read -r row; do
  pid="${row%% *}"
  cmd="${row#* }"
  if [[ "$cmd" == *"tunnel-client"* && "$cmd" == *" run "* && "$cmd" == *"--profile"* && "$cmd" == *"$PROFILE"* ]]; then
    if [[ "$pid" != "$$" ]]; then
      kill -TERM "$pid" 2>/dev/null || true
    fi
  fi
done < <(ps ax -o pid=,command= | sed -E 's/^ +//')

sleep 1

cat >"$PLIST" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>$LABEL</string>

  <key>ProgramArguments</key>
  <array>
    <string>/bin/bash</string>
    <string>$ROOT/scripts/daemon-run.sh</string>
  </array>

  <key>RunAtLoad</key>
  <true/>

  <key>KeepAlive</key>
  <true/>

  <key>ThrottleInterval</key>
  <integer>10</integer>

  <key>ProcessType</key>
  <string>Background</string>

  <key>StandardOutPath</key>
  <string>$OUT_LOG</string>

  <key>StandardErrorPath</key>
  <string>$ERR_LOG</string>
</dict>
</plist>
PLIST

plutil -lint "$PLIST" >/dev/null

launchctl bootout "gui/$UID_NUM/$LABEL" >/dev/null 2>&1 || true
launchctl bootstrap "gui/$UID_NUM" "$PLIST"
launchctl enable "gui/$UID_NUM/$LABEL" >/dev/null 2>&1 || true
launchctl kickstart -k "gui/$UID_NUM/$LABEL"

rm -f "$HEALTH_FILE"

READY=0
for _ in $(seq 1 45); do
  if [[ -s "$HEALTH_FILE" ]]; then
    HEALTH_URL="$(cat "$HEALTH_FILE" 2>/dev/null || true)"
    if [[ -n "$HEALTH_URL" ]] && curl -fsS --max-time 3 "$HEALTH_URL/readyz" >/dev/null 2>&1; then
      READY=1
      break
    fi
  fi
  sleep 1
done

echo
echo "===== BACKGROUND INSTALL REPORT ====="
echo "LaunchAgent: $LABEL"
echo "Tunnel ID: $TUNNEL_ID"
echo "Profile: $PROFILE"
echo "Runtime key storage: macOS Keychain ($KEYCHAIN_SERVICE)"
echo "LaunchAgent plist: $PLIST"

if [[ "$READY" -eq 1 ]]; then
  echo "Tunnel ready: YES"
  echo "Health URL: $HEALTH_URL"
  echo "Autostart at login: YES"
  echo "Auto-restart if tunnel-client exits: YES"
  echo "Terminal required after setup: NO"
else
  echo "Tunnel ready: NO"
  echo
  echo "launchd state:"
  launchctl print "gui/$UID_NUM/$LABEL" 2>&1 | tail -n 40 || true
  echo
  echo "stderr tail:"
  tail -n 50 "$ERR_LOG" 2>/dev/null || true
  echo
  echo "stdout tail:"
  tail -n 50 "$OUT_LOG" 2>/dev/null || true
  exit 4
fi

echo
echo "Maintenance:"
echo "  bash $ROOT/scripts/status.sh"
echo "  bash $ROOT/scripts/restart.sh"
echo "  bash $ROOT/scripts/stop.sh"
echo "===== END BACKGROUND INSTALL REPORT ====="
