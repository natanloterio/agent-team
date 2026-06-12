#!/usr/bin/env bash
# Smoke test for dispatch-workers.sh: empty-queue path, lock contention,
# stale-lock reclaim. Requires: git, node, tmux on PATH.
set -euo pipefail
PLUGIN_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)

ROOT=$(mktemp -d)
trap 'rm -rf "$ROOT"' EXIT
git -C "$ROOT" init -q -b main
mkdir -p "$ROOT/.agent-team"
echo '{"workerSessionPrefix": "dispatch-test-"}' > "$ROOT/.agent-team/config.json"
export AGENT_TEAM_ROOT="$ROOT"

run() { bash "$PLUGIN_DIR/scripts/dispatch-workers.sh"; }

echo "--- empty queue runs cleanly"
OUT=$(run)
echo "$OUT" | grep -q "No unclaimed tasks" || { echo "FAIL: expected empty-queue message, got: $OUT"; exit 1; }

echo "--- live lock is respected"
mkdir -p "$ROOT/.tasks/.dispatch.lock.d"
sleep 60 & HOLDER=$!
echo $HOLDER > "$ROOT/.tasks/.dispatch.lock.d/pid"
OUT=$(run)
kill $HOLDER
echo "$OUT" | grep -q "Another dispatch is running" || { echo "FAIL: live lock not respected: $OUT"; exit 1; }

echo "--- stale lock (dead pid) is reclaimed"
mkdir -p "$ROOT/.tasks/.dispatch.lock.d"
( : ) & DEAD=$!; wait $DEAD   # a PID guaranteed dead
echo $DEAD > "$ROOT/.tasks/.dispatch.lock.d/pid"
OUT=$(run)
echo "$OUT" | grep -q "No unclaimed tasks" || { echo "FAIL: stale lock not reclaimed: $OUT"; exit 1; }
[ ! -d "$ROOT/.tasks/.dispatch.lock.d" ] || { echo "FAIL: lock not released on exit"; exit 1; }

echo "ALL DISPATCH SMOKE TESTS PASSED"
