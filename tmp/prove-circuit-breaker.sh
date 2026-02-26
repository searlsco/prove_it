#!/usr/bin/env bash
set -euo pipefail

CLI="$(cd "$(dirname "$0")/.." && pwd)/cli.js"
TMPDIR_BASE="$(mktemp -d)"
PROJECT="$TMPDIR_BASE/my-project"
SESSION_ID="circuit-breaker-demo-$$"

cleanup() { rm -rf "$TMPDIR_BASE"; }
trap cleanup EXIT

# ── Setup ──
mkdir -p "$PROJECT/.claude/prove_it"
cd "$PROJECT"
git init -q && git config user.email "x@x" && git config user.name "x"
touch .gitkeep && git add . && git commit -q -m init

# Write an invalid config (stale key from a hypothetical old version)
cat > .claude/prove_it/config.json <<'EOF'
{
  "enabled": true,
  "staleKeyFromOldVersion": true,
  "hooks": [
    {
      "type": "claude",
      "event": "Stop",
      "tasks": [
        { "name": "fast-tests", "type": "script", "command": "exit 0" }
      ]
    }
  ]
}
EOF

export CLAUDE_PROJECT_DIR="$PROJECT"
export HOME="$TMPDIR_BASE"
export PROVE_IT_DIR="$TMPDIR_BASE/.prove_it"

echo "============================================================"
echo "  Config error circuit breaker — end-to-end proof"
echo "============================================================"
echo ""
echo "Project dir:  $PROJECT"
echo "Session ID:   $SESSION_ID"
echo ""
echo "Config (intentionally invalid — has 'staleKeyFromOldVersion'):"
cat .claude/prove_it/config.json
echo ""

# ── 1. SessionStart ──
echo "============================================================"
echo "  1. SessionStart (startup)"
echo "============================================================"
RESULT=$(echo '{"hook_event_name":"SessionStart","source":"startup","session_id":"'"$SESSION_ID"'"}' \
  | node "$CLI" hook claude:SessionStart 2>/dev/null || true)
echo "stdout: $RESULT"
echo ""

# ── 2. First Stop ──
echo "============================================================"
echo "  2. First Stop — should approve with warning (not block)"
echo "============================================================"
RESULT=$(echo '{"hook_event_name":"Stop","session_id":"'"$SESSION_ID"'"}' \
  | node "$CLI" hook claude:Stop 2>/dev/null || true)
echo "stdout: $RESULT"
if echo "$RESULT" | python3 -c "import sys,json; d=json.load(sys.stdin); assert d['decision']=='approve'" 2>/dev/null; then
  echo "  ✓ decision=approve (not block)"
else
  echo "  ✗ UNEXPECTED — got block or no output"
fi
echo ""

# ── 3. Second Stop — should be silent ──
echo "============================================================"
echo "  3. Second Stop — should be SILENT (circuit breaker tripped)"
echo "============================================================"
RESULT=$(echo '{"hook_event_name":"Stop","session_id":"'"$SESSION_ID"'"}' \
  | node "$CLI" hook claude:Stop 2>/dev/null || true)
if [ -z "$RESULT" ]; then
  echo "  ✓ No output (silent exit — circuit breaker working)"
else
  echo "  ✗ UNEXPECTED output: $RESULT"
fi
echo ""

# ── 4. Third Stop — still silent ──
echo "============================================================"
echo "  4. Third Stop — still silent"
echo "============================================================"
RESULT=$(echo '{"hook_event_name":"Stop","session_id":"'"$SESSION_ID"'"}' \
  | node "$CLI" hook claude:Stop 2>/dev/null || true)
if [ -z "$RESULT" ]; then
  echo "  ✓ No output (still silent)"
else
  echo "  ✗ UNEXPECTED output: $RESULT"
fi
echo ""

# ── 5. PreToolUse — also silent (same session) ──
echo "============================================================"
echo "  5. PreToolUse — also silent (same session, already reported)"
echo "============================================================"
RESULT=$(echo '{"hook_event_name":"PreToolUse","tool_name":"Bash","tool_input":{"command":"echo hi"},"session_id":"'"$SESSION_ID"'"}' \
  | node "$CLI" hook claude:PreToolUse 2>/dev/null || true)
if [ -z "$RESULT" ]; then
  echo "  ✓ No output (circuit breaker covers all events)"
else
  echo "  ✗ UNEXPECTED output: $RESULT"
fi
echo ""

# ── 6. SessionStart resume — always emits ──
echo "============================================================"
echo "  6. SessionStart (resume) — always emits even after breaker"
echo "============================================================"
RESULT=$(echo '{"hook_event_name":"SessionStart","source":"resume","session_id":"'"$SESSION_ID"'"}' \
  | node "$CLI" hook claude:SessionStart 2>/dev/null || true)
echo "stdout: $RESULT"
if echo "$RESULT" | python3 -c "import sys,json; d=json.load(sys.stdin); assert 'invalid' in d.get('additionalContext','')" 2>/dev/null; then
  echo "  ✓ SessionStart still warns about invalid config"
else
  echo "  ✗ UNEXPECTED — no warning in SessionStart"
fi
echo ""

# ── Session logs ──
echo "============================================================"
echo "  Session log (JSONL — what prove_it monitor sees)"
echo "============================================================"
LOG_FILE="$PROVE_IT_DIR/sessions/$SESSION_ID.jsonl"
if [ -f "$LOG_FILE" ]; then
  while IFS= read -r line; do
    echo "$line" | python3 -m json.tool 2>/dev/null || echo "$line"
  done < "$LOG_FILE"
else
  echo "  (no log file found at $LOG_FILE)"
fi
echo ""

echo "============================================================"
echo "  Session state (JSON — circuit breaker flag)"
echo "============================================================"
STATE_FILE="$PROVE_IT_DIR/sessions/$SESSION_ID.json"
if [ -f "$STATE_FILE" ]; then
  python3 -m json.tool "$STATE_FILE" 2>/dev/null || cat "$STATE_FILE"
else
  echo "  (no state file found at $STATE_FILE)"
fi
echo ""

echo "============================================================"
echo "  Summary"
echo "============================================================"
echo ""
echo "  Before this change:"
echo "    Stop → block → agent retries → Stop → block → infinite loop"
echo "    PreToolUse → deny → agent can't use any tool → stuck"
echo ""
echo "  After this change:"
echo "    Stop #1 → approve with warning (non-blocking)"
echo "    Stop #2+ → silent exit (no output, no loop)"
echo "    SessionStart → always shows the error prominently"
echo "    Log has exactly ONE BOOM entry (not N)"
echo ""
BOOM_COUNT=$(grep -c '"BOOM"' "$LOG_FILE" 2>/dev/null || echo 0)
echo "  BOOM entries in log: $BOOM_COUNT (expected: 1)"
echo ""
if [ "$BOOM_COUNT" = "1" ]; then
  echo "  ✓ Circuit breaker is working correctly"
else
  echo "  ✗ Something is wrong"
fi
