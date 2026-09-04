#!/usr/bin/env bash
set -euo pipefail

LABEL="com.pyxl.chatgpt-hermes-a2a"
UID_NUM="$(id -u)"

if launchctl bootout "gui/$UID_NUM/$LABEL" >/dev/null 2>&1; then
  echo "Hermes Mac tunnel stopped for this login session."
  echo "The LaunchAgent plist remains installed, so it will start again at the next login."
else
  echo "Hermes Mac tunnel was not loaded."
fi
