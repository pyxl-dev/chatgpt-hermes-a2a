#!/usr/bin/env bash
set +e

ROOT="/Users/yoan/Projects/chatgpt-hermes-a2a"
TEST_JS="$ROOT/.runtime/native-coordinator-e2e-temp.mjs"
RESULT="/tmp/native-coordinator-e2e-result.json"
LOG="/tmp/native-coordinator-e2e.log"

sleep 8
cd "$ROOT" || exit 90
BEFORE="$(git status --short)"
: >"$LOG"

echo "=== STOP BRIDGE ===" >>"$LOG"
bash scripts/stop.sh >>"$LOG" 2>&1
STOP_RC=$?
sleep 2

echo "=== RUN NATIVE E2E ===" >>"$LOG"
node "$TEST_JS" >>"$LOG" 2>&1
TEST_RC=$?

echo "=== RESTART BRIDGE ===" >>"$LOG"
bash scripts/restart.sh >>"$LOG" 2>&1
RESTART_RC=$?
AFTER="$(git status --short)"

python3 - "$RESULT" "$BEFORE" "$AFTER" "$STOP_RC" "$TEST_RC" "$RESTART_RC" <<'PY'
import json, sys
result_path, before, after, stop_rc, test_rc, restart_rc = sys.argv[1:]
try:
    with open(result_path, "r", encoding="utf-8") as f:
        data = json.load(f)
except Exception as e:
    data = {"ok": False, "errors": [f"result read failed: {e}"]}
data["gitStatusBefore"] = before
data["gitStatusAfter"] = after
data["stopRc"] = int(stop_rc)
data["testRc"] = int(test_rc)
data["restartRc"] = int(restart_rc)
with open(result_path, "w", encoding="utf-8") as f:
    json.dump(data, f, indent=2, ensure_ascii=False)
    f.write("\n")
PY

rm -f "$TEST_JS"
exit 0
