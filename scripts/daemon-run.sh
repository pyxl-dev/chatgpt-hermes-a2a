#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PROFILE="${TUNNEL_PROFILE:-chatgpt-hermes-a2a}"
KEYCHAIN_SERVICE="chatgpt-hermes-a2a.runtime-api-key"
ACCOUNT="$(id -un)"
HEALTH_FILE="$ROOT/.runtime/daemon-health.url"

export HOME="${HOME:-$(dscl . -read /Users/"$ACCOUNT" NFSHomeDirectory 2>/dev/null | awk '{print $2}')}"
export PATH="$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"

mkdir -p "$ROOT/.runtime"
rm -f "$HEALTH_FILE"

if command -v tunnel-client >/dev/null 2>&1; then
  TC="$(command -v tunnel-client)"
elif [[ -x "$ROOT/.tools/tunnel-client/current" ]]; then
  TC="$ROOT/.tools/tunnel-client/current"
else
  echo "tunnel-client not found. Re-run scripts/install-background.sh" >&2
  exit 2
fi

CONTROL_PLANE_API_KEY="$(/usr/bin/security find-generic-password   -a "$ACCOUNT"   -s "$KEYCHAIN_SERVICE"   -w 2>/dev/null || true)"

if [[ -z "$CONTROL_PLANE_API_KEY" ]]; then
  echo "Runtime API key not found in macOS Keychain service $KEYCHAIN_SERVICE." >&2
  echo "Re-run scripts/install-background.sh." >&2
  exit 3
fi

export CONTROL_PLANE_API_KEY

exec "$TC" run   --profile "$PROFILE"   --health.listen-addr 127.0.0.1:0   --health.url-file "$HEALTH_FILE"
