#!/bin/sh
# chatgpt-hermes-a2a installer.
#
#   curl -fsSL https://raw.githubusercontent.com/pyxl-dev/chatgpt-hermes-a2a/main/install.sh | sh
#   ./install.sh               # from a clone: installs that clone
#   ./install.sh --uninstall
#
# Puts the code in ~/.local/share/chatgpt-hermes-a2a (or uses this clone),
# checks Node.js, Hermes and tunnel-client, and installs the single Node
# dependency. It does not touch your Hermes configuration and does not start
# anything: the next steps are printed at the end. Re-run it to update.
# Nothing outside your home folder is touched.
set -eu

REPO="${CHATGPT_HERMES_REPO:-https://github.com/pyxl-dev/chatgpt-hermes-a2a.git}"
DEST="${CHATGPT_HERMES_HOME:-$HOME/.local/share/chatgpt-hermes-a2a}"
PLIST="$HOME/Library/LaunchAgents/com.pyxl.chatgpt-hermes-a2a.plist"

if [ -t 1 ]; then B=$(printf '\033[1m'); G=$(printf '\033[32m'); Y=$(printf '\033[33m'); R=$(printf '\033[31m'); N=$(printf '\033[0m'); else B= G= Y= R= N=; fi
ok()   { printf '%s✓%s %s\n' "$G" "$N" "$1"; }
warn() { printf '%s!%s %s\n' "$Y" "$N" "$1"; }
die()  { printf '%s✗%s %s\n' "$R" "$N" "$1" >&2; exit 1; }

if [ "${1:-}" = "--uninstall" ]; then
  if [ -f "$PLIST" ]; then
    if [ -f "$DEST/scripts/uninstall-background.sh" ]; then
      bash "$DEST/scripts/uninstall-background.sh" >/dev/null 2>&1 || true
    else
      launchctl bootout "gui/$(id -u)/com.pyxl.chatgpt-hermes-a2a" >/dev/null 2>&1 || true
      rm -f "$PLIST"
    fi
    ok "removed the background service (LaunchAgent)"
  fi
  if [ -d "$DEST/.git" ]; then rm -rf "$DEST"; ok "removed $DEST"
  else warn "no managed install in $DEST (a clone you made yourself is left alone)"; fi
  echo "Left in place: the runtime key in the macOS Keychain (remove it with: security delete-generic-password -s chatgpt-hermes-a2a.runtime-api-key), the Hermes API key and the tunnel-client profile."
  exit 0
fi

printf '%schatgpt-hermes-a2a%s installer\n\n' "$B" "$N"
[ "$(uname -s)" = "Darwin" ] || warn "macOS is the supported platform (the background service uses launchd)."

# 1. Code: this clone, or a managed one in ~/.local/share.
HERE=
if [ -f "$0" ]; then HERE=$(cd "$(dirname "$0")" 2>/dev/null && pwd || true); fi
if [ -n "$HERE" ] && [ -f "$HERE/package.json" ] && [ -f "$HERE/src/hermes-mcp.mjs" ]; then
  DEST="$HERE"
  ok "using this clone: $DEST"
elif [ -d "$DEST/.git" ]; then
  git -C "$DEST" pull --ff-only -q || die "could not update $DEST (local changes?)"
  ok "updated $DEST"
else
  command -v git >/dev/null || die "git is missing: run  xcode-select --install"
  mkdir -p "$(dirname "$DEST")"
  git clone -q --depth 1 "$REPO" "$DEST" || die "could not download $REPO"
  ok "downloaded to $DEST"
fi

# 2. Node.js 22.13+ (the coordinator uses the built-in node:sqlite).
command -v node >/dev/null || die "Node.js is missing (22.13 or newer). Install it, then re-run:  brew install node"
node -e 'const [a,b]=process.versions.node.split(".").map(Number); process.exit(a>22||(a===22&&b>=13)?0:1)' \
  || die "Node.js $(node -v) is too old: 22.13 or newer is required."
command -v npm >/dev/null || die "npm is missing (it ships with Node.js)."
ok "Node.js $(node -v)"

# 3. The one dependency (@modelcontextprotocol/sdk, pinned).
(cd "$DEST" && npm install --no-package-lock --no-audit --no-fund >/dev/null 2>&1) \
  || die "npm install failed: run  cd $DEST && npm install  to see why."
ok "installed the Node dependency"

# 4. Optional pieces.
if command -v hermes >/dev/null; then ok "Hermes found"
else warn "hermes not found: install Hermes Agent first (https://github.com/NousResearch/hermes-agent)."; fi
if command -v tunnel-client >/dev/null || [ -x "$DEST/.tools/tunnel-client/current" ]; then ok "tunnel-client found"
else warn "tunnel-client not found: brew install openai/tools/tunnel-client (scripts/install-tunnel-client.sh also downloads it)."; fi

# 5. Next steps.
printf '\n%sDone.%s Next, from %s:\n' "$B" "$N" "$DEST"
echo "  1. bash scripts/setup-hermes-control.sh   enable Hermes' authenticated Runs API on loopback (restarts the Hermes gateway)"
echo "  2. npm test && npm run smoke              check the bridge"
echo "  3. bash scripts/connect-openai.sh         guided first connection to ChatGPT"
echo "  4. bash scripts/install-background.sh     keep it running at login (LaunchAgent)"
