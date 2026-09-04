#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LABEL="com.pyxl.chatgpt-hermes-a2a"
UID_NUM="$(id -u)"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"

if ! launchctl print "gui/$UID_NUM/$LABEL" >/dev/null 2>&1; then
  if [[ ! -f "$PLIST" ]]; then
    echo "LaunchAgent is not installed. Run scripts/install-background.sh first." >&2
    exit 2
  fi
  launchctl bootstrap "gui/$UID_NUM" "$PLIST"
fi

launchctl kickstart -k "gui/$UID_NUM/$LABEL"
sleep 2
exec /bin/bash "$ROOT/scripts/status.sh"
