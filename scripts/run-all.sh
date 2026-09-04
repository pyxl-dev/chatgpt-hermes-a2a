#!/usr/bin/env bash
set -u

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

mkdir -p "$ROOT/.runtime/logs" "$ROOT/reports"
STAMP="$(date '+%Y%m%d-%H%M%S')"
REPORT="$ROOT/reports/diagnostic-$STAMP.md"
PASS=0
WARN=0
FAIL=0

touch "$REPORT"

line() {
  printf '%s\n' "$*" | tee -a "$REPORT"
}

section() {
  line ""
  line "## $1"
  line ""
}

pass() {
  PASS=$((PASS + 1))
  line "- PASS: $1"
}

warn() {
  WARN=$((WARN + 1))
  line "- WARN: $1"
}

fail() {
  FAIL=$((FAIL + 1))
  line "- FAIL: $1"
}

capture() {
  local slug="$1"
  shift
  local log="$ROOT/.runtime/logs/$STAMP-$slug.log"
  "$@" >"$log" 2>&1
  local rc=$?
  if [[ $rc -ne 0 ]]; then
    line ""
    line "  Log tail ($slug, rc=$rc):"
    line "~~~text"
    tail -n 25 "$log" |       sed -E         -e 's/(Bearer )[A-Za-z0-9._~+\/-]+/\1[REDACTED]/g'         -e 's/(sk-[A-Za-z0-9_-]{8})[A-Za-z0-9_-]+/\1...[REDACTED]/g'         -e 's/(A2A_BEARER_TOKEN=).*/\1[REDACTED]/g'         -e 's/(CONTROL_PLANE_API_KEY=).*/\1[REDACTED]/g'       | tee -a "$REPORT"
    line "~~~"
  fi
  return $rc
}

line "# chatgpt-hermes-a2a diagnostic"
line ""
line "- Timestamp: $(date -Iseconds 2>/dev/null || date)"
line "- Repo commit: $(git rev-parse --short HEAD 2>/dev/null || echo unknown)"
line "- OS: $(sw_vers -productVersion 2>/dev/null || uname -sr)"
line "- Architecture: $(uname -m)"

section "1. Prerequisites"

for cmd in git curl python3 node npm hermes; do
  if command -v "$cmd" >/dev/null 2>&1; then
    pass "$cmd found at $(command -v "$cmd")"
  else
    fail "$cmd is missing"
  fi
done

NODE_MAJOR=0
if command -v node >/dev/null 2>&1; then
  NODE_MAJOR="$(node -p 'Number(process.versions.node.split(".")[0])' 2>/dev/null || echo 0)"
  if [[ "$NODE_MAJOR" -ge 20 ]]; then
    pass "Node.js $(node -v) satisfies a2a-mcp requirement (>=20)"
  else
    fail "Node.js $(node -v 2>/dev/null) is too old; >=20 is required"
  fi
fi

if command -v hermes >/dev/null 2>&1; then
  HERMES_VERSION="$(hermes --version 2>/dev/null | head -n 1)"
  [[ -n "$HERMES_VERSION" ]] && line "- Hermes version: $HERMES_VERSION"
fi

section "2. Hermes A2A endpoint"

A2A_URL="http://127.0.0.1:9900/.well-known/agent-card.json"
CARD="$ROOT/.runtime/hermes-agent-card.json"
rm -f "$CARD"

if ! curl -fsS --max-time 3 "$A2A_URL" -o "$CARD" 2>/dev/null; then
  warn "Hermes A2A Agent Card is not reachable yet on 127.0.0.1:9900"

  if command -v hermes >/dev/null 2>&1; then
    capture "gateway-status" hermes gateway status || true
    if capture "gateway-start" hermes gateway start; then
      line "- Attempted to start the installed Hermes gateway service."
    else
      warn "Could not start the Hermes gateway service automatically"
    fi

    for _ in 1 2 3 4 5 6 7 8 9 10; do
      sleep 1
      if curl -fsS --max-time 3 "$A2A_URL" -o "$CARD" 2>/dev/null; then
        break
      fi
    done
  fi
fi

if [[ -s "$CARD" ]]; then
  if python3 - "$CARD" >/dev/null 2>&1 <<'PY'
import json, sys
json.load(open(sys.argv[1], encoding="utf-8"))
PY
  then
    pass "Hermes A2A Agent Card is reachable and valid JSON"
    CARD_SUMMARY="$(python3 - "$CARD" <<'PY'
import json, sys
d=json.load(open(sys.argv[1], encoding="utf-8"))
keys=("name","description","version","protocolVersion","url")
print(", ".join(f"{k}={d[k]!r}" for k in keys if k in d))
PY
)"
    [[ -n "$CARD_SUMMARY" ]] && line "- Agent Card: $CARD_SUMMARY"
  else
    fail "Hermes A2A endpoint responded but Agent Card was not valid JSON"
  fi
else
  fail "Hermes A2A is not reachable. Most likely A2A is not enabled in the Hermes gateway."
  line "- Hermes documented enable path: hermes gateway setup, then select A2A."
fi

if [[ -z "${A2A_BEARER_TOKEN:-}" && -f "$HOME/.hermes/.env" ]]; then
  DETECTED_TOKEN="$(python3 - "$HOME/.hermes/.env" <<'PY'
import shlex, sys
for raw in open(sys.argv[1], encoding="utf-8", errors="ignore"):
    line=raw.strip()
    if not line or line.startswith("#") or "=" not in line:
        continue
    key, value=line.split("=", 1)
    if key.strip() != "A2A_BEARER_TOKEN":
        continue
    value=value.strip()
    try:
        parts=shlex.split(value, posix=True)
        print(parts[0] if parts else "")
    except Exception:
        print(value.strip("'\""))
    break
PY
)"
  if [[ -n "$DETECTED_TOKEN" ]]; then
    export A2A_BEARER_TOKEN="$DETECTED_TOKEN"
    pass "Found A2A bearer-token configuration and loaded only that value without printing it"
  fi
  unset DETECTED_TOKEN
elif [[ -n "${A2A_BEARER_TOKEN:-}" ]]; then
  pass "A2A_BEARER_TOKEN is already exported"
fi

section "3. MCP -> A2A -> Hermes local smoke test"

if command -v npm >/dev/null 2>&1 && [[ "$NODE_MAJOR" -ge 20 ]]; then
  if capture "npm-install" npm install --no-package-lock --no-audit --no-fund; then
    pass "Pinned Node dependencies installed"
  else
    fail "npm dependency installation failed"
  fi

  chmod +x "$ROOT/scripts/start-bridge.sh" "$ROOT/scripts/install-tunnel-client.sh" "$ROOT/scripts/start-tunnel.sh" "$ROOT/scripts/run-all.sh" 2>/dev/null || true

  if [[ -s "$CARD" && -x "$ROOT/node_modules/.bin/a2a-mcp" ]]; then
    SMOKE_LOG="$ROOT/.runtime/logs/$STAMP-mcp-smoke.log"
    node "$ROOT/src/mcp-smoke.mjs" >"$SMOKE_LOG" 2>&1
    SMOKE_RC=$?

    if [[ $SMOKE_RC -eq 0 ]]; then
      pass "MCP bridge listed tools, reached Hermes over A2A, triggered Hermes agent loop, and Hermes created the local /tmp proof file"
    else
      fail "MCP/A2A smoke test failed"
      line ""
      line "  Smoke result:"
      line "~~~json"
      tail -n 80 "$SMOKE_LOG" |         sed -E           -e 's/(Bearer )[A-Za-z0-9._~+\/-]+/\1[REDACTED]/g'           -e 's/(sk-[A-Za-z0-9_-]{8})[A-Za-z0-9_-]+/\1...[REDACTED]/g'         | tee -a "$REPORT"
      line "~~~"
    fi
  else
    warn "Skipped MCP/A2A smoke test because the Hermes Agent Card or bridge dependency is unavailable"
  fi
else
  warn "Skipped Node/MCP checks because Node.js >=20 or npm is unavailable"
fi

section "4. OpenAI tunnel-client"

if command -v tunnel-client >/dev/null 2>&1; then
  TC="$(command -v tunnel-client)"
  pass "Using existing tunnel-client at $TC"
else
  if TC="$("$ROOT/scripts/install-tunnel-client.sh" 2>"$ROOT/.runtime/logs/$STAMP-tunnel-install.log")"; then
    pass "Downloaded and SHA256-verified the latest official OpenAI tunnel-client release"
  else
    TC=""
    fail "Could not install tunnel-client automatically"
    line ""
    line "  Log tail:"
    line "~~~text"
    tail -n 25 "$ROOT/.runtime/logs/$STAMP-tunnel-install.log" | tee -a "$REPORT"
    line "~~~"
  fi
fi

if [[ -n "${TC:-}" && -x "$TC" ]]; then
  TC_VERSION="$("$TC" --version 2>/dev/null | head -n 1)"
  line "- tunnel-client version: ${TC_VERSION:-unknown}"
  if capture "tunnel-quickstart" "$TC" help quickstart; then
    pass "tunnel-client binary executes successfully"
  else
    fail "tunnel-client binary failed its help smoke test"
  fi
fi

if [[ -n "${CONTROL_PLANE_TUNNEL_ID:-}" ]]; then
  pass "CONTROL_PLANE_TUNNEL_ID is exported"
else
  warn "CONTROL_PLANE_TUNNEL_ID is not exported; Secure MCP Tunnel cannot be started from this shell yet"
fi

if [[ -n "${CONTROL_PLANE_API_KEY:-}" ]]; then
  pass "CONTROL_PLANE_API_KEY is exported (value not printed)"
else
  warn "CONTROL_PLANE_API_KEY is not exported; tunnel-client cannot authenticate to OpenAI yet"
fi

section "5. Result"

line "- Passed: $PASS"
line "- Warnings: $WARN"
line "- Failed: $FAIL"
line "- Local bridge launcher: $ROOT/scripts/start-bridge.sh"
line "- Secure tunnel launcher once tunnel env vars exist: $ROOT/scripts/start-tunnel.sh"

if [[ $FAIL -eq 0 ]]; then
  line "- Overall: LOCAL PIPELINE READY"
  if [[ -n "${CONTROL_PLANE_TUNNEL_ID:-}" && -n "${CONTROL_PLANE_API_KEY:-}" ]]; then
    line "- Tunnel prerequisites: PRESENT"
  else
    line "- Tunnel prerequisites: MISSING ENVIRONMENT VALUES"
  fi
else
  line "- Overall: NEEDS FIXES; see failed checks above"
fi

line ""
line "REPORT_PATH=$REPORT"

printf '\n===== REPORT TO SEND BACK =====\n'
cat "$REPORT"
printf '===== END REPORT =====\n'
