#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

echo "===== CHATGPT -> HERMES NATIVE DIAGNOSTIC ====="
echo "Repo: $ROOT"
echo "Commit: $(git rev-parse --short HEAD 2>/dev/null || echo unknown)"

for cmd in git curl node npm hermes; do
  if ! command -v "$cmd" >/dev/null 2>&1; then
    echo "MISSING: $cmd" >&2
    exit 2
  fi
done

if ! node -e '
  const [major, minor] = process.versions.node.split(".").map(Number);
  process.exit(major > 22 || (major === 22 && minor >= 13) ? 0 : 1);
'; then
  echo "Node.js >=22.13.0 is required; got $(node -v)" >&2
  exit 2
fi

echo "[1/6] Installing pinned Node dependencies"
npm install --no-package-lock --no-audit --no-fund

echo "[2/6] Configuring/verifying Hermes native Runs API"
bash "$ROOT/scripts/setup-hermes-control.sh"

echo "[3/6] Running unit tests"
npm test

echo "[4/6] Running syntax checks"
npm run check

echo "[5/6] Running native control smoke"
npm run smoke:control

echo "[6/6] Running native MCP smoke"
npm run smoke

echo
echo "LOCAL PIPELINE READY"
echo "Path: ChatGPT -> Secure MCP Tunnel -> MCP wrapper -> Hermes native Runs API -> Mac"
echo "A2A is not required or used by this bridge."
echo "===== END DIAGNOSTIC ====="
