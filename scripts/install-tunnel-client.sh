#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TOOLS_DIR="$ROOT/.tools/tunnel-client"

if command -v tunnel-client >/dev/null 2>&1; then
  command -v tunnel-client
  exit 0
fi

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "Automatic tunnel-client install currently supports macOS only." >&2
  exit 2
fi

case "$(uname -m)" in
  arm64) ARCH="arm64" ;;
  x86_64) ARCH="amd64" ;;
  *)
    echo "Unsupported macOS architecture: $(uname -m)" >&2
    exit 2
    ;;
esac

for cmd in curl python3 unzip shasum; do
  command -v "$cmd" >/dev/null 2>&1 || {
    echo "Missing prerequisite: $cmd" >&2
    exit 2
  }
done

mkdir -p "$TOOLS_DIR"
TMP="$(mktemp -d "${TMPDIR:-/tmp}/chatgpt-hermes-tunnel.XXXXXX")"
trap 'rm -rf "$TMP"' EXIT

RELEASE_JSON="$TMP/release.json"
curl -fsSL "https://api.github.com/repos/openai/tunnel-client/releases/latest" -o "$RELEASE_JSON"

TAG="$(python3 - "$RELEASE_JSON" <<'PY'
import json, sys
with open(sys.argv[1], "r", encoding="utf-8") as f:
    print(json.load(f)["tag_name"])
PY
)"

ASSET="tunnel-client-${TAG}-darwin-${ARCH}.zip"
BASE="https://github.com/openai/tunnel-client/releases/download/${TAG}"
ZIP="$TMP/$ASSET"
SUMS="$TMP/SHA256SUMS.txt"

curl -fsSL "$BASE/$ASSET" -o "$ZIP"
curl -fsSL "$BASE/SHA256SUMS.txt" -o "$SUMS"

EXPECTED="$(awk -v f="$ASSET" '$2 == f {print $1}' "$SUMS" | head -n 1)"
if [[ -z "$EXPECTED" ]]; then
  echo "Could not find $ASSET in official SHA256SUMS.txt" >&2
  exit 3
fi

ACTUAL="$(shasum -a 256 "$ZIP" | awk '{print $1}')"
if [[ "$EXPECTED" != "$ACTUAL" ]]; then
  echo "SHA256 verification failed for $ASSET" >&2
  exit 3
fi

DEST="$TOOLS_DIR/$TAG"
rm -rf "$DEST"
mkdir -p "$DEST"
unzip -q "$ZIP" -d "$DEST"

BIN="$(find "$DEST" -type f -name tunnel-client -perm -u+x | head -n 1 || true)"
if [[ -z "$BIN" ]]; then
  BIN="$(find "$DEST" -type f -name tunnel-client | head -n 1 || true)"
fi
if [[ -z "$BIN" ]]; then
  echo "Downloaded archive did not contain tunnel-client" >&2
  exit 3
fi

chmod +x "$BIN"
ln -sfn "$BIN" "$TOOLS_DIR/current"

echo "$TOOLS_DIR/current"
