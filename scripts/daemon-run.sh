#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PROFILE="${TUNNEL_PROFILE:-chatgpt-hermes-a2a}"
KEYCHAIN_SERVICE="chatgpt-hermes-a2a.runtime-api-key"
ACCOUNT="$(id -un)"
HEALTH_FILE="$ROOT/.runtime/daemon-health.url"

export HOME="${HOME:-$(dscl . -read /Users/"$ACCOUNT" NFSHomeDirectory 2>/dev/null | awk '{print $2}')}"
export PATH="$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"

# launchd opens StandardOutPath/StandardErrorPath itself and never rotates them,
# so a long-lived tunnel-client grows them without limit. Run the tunnel client
# through the bounded log runner instead: same paths, owner-only files, and a
# size cap that rotates to file.1 ... file.N.
LOG_FILE="${A2A_LOG_FILE:-$HOME/Library/Logs/chatgpt-hermes-a2a.out.log}"
LOG_ERR_FILE="${A2A_LOG_ERR_FILE:-$HOME/Library/Logs/chatgpt-hermes-a2a.err.log}"
LOG_MAX_BYTES="${A2A_LOG_MAX_BYTES:-2000000}"
LOG_BACKUPS="${A2A_LOG_BACKUPS:-3}"
[[ "$LOG_MAX_BYTES" =~ ^[0-9]+$ ]] || LOG_MAX_BYTES=2000000
[[ "$LOG_BACKUPS" =~ ^[0-9]+$ ]] || LOG_BACKUPS=3

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

exec node "$ROOT/src/bounded-log-runner.mjs" \
  --file "$LOG_FILE" \
  --err-file "$LOG_ERR_FILE" \
  --max-bytes "$LOG_MAX_BYTES" \
  --backups "$LOG_BACKUPS" \
  -- "$TC" run \
  --profile "$PROFILE" \
  --health.listen-addr 127.0.0.1:0 \
  --health.url-file "$HEALTH_FILE"
