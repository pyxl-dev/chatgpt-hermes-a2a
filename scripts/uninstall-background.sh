#!/usr/bin/env bash
set -euo pipefail

LABEL="com.pyxl.chatgpt-hermes-a2a"
KEYCHAIN_SERVICE="chatgpt-hermes-a2a.runtime-api-key"
ACCOUNT="$(id -un)"
UID_NUM="$(id -u)"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"

launchctl bootout "gui/$UID_NUM/$LABEL" >/dev/null 2>&1 || true
rm -f "$PLIST"

if [[ "${DELETE_RUNTIME_KEY:-0}" == "1" ]]; then
  /usr/bin/security delete-generic-password -a "$ACCOUNT" -s "$KEYCHAIN_SERVICE" >/dev/null 2>&1 || true
  echo "Removed LaunchAgent and runtime key from Keychain."
else
  echo "Removed LaunchAgent. Runtime key remains in Keychain."
  echo "To remove it too: DELETE_RUNTIME_KEY=1 bash scripts/uninstall-background.sh"
fi
