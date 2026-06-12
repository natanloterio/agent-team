#!/usr/bin/env bash
# Smoke test for dispatch-workers.sh: empty-queue path, lock contention,
# stale-lock reclaim. Requires: git, node, tmux on PATH.
set -euo pipefail
PLUGIN_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)

ROOT=$(mktemp -d)
# Stub claude on PATH so the spawn path never boots a real
# `claude --dangerously-skip-permissions` — and doesn't die instantly on CI
# runners where claude is absent (dead session -> send-keys fails -> set -e
# aborts). The stub just sleeps, keeping the tmux session alive for the trap.
STUB=$(mktemp -d)
printf '#!/bin/sh\nsleep 600\n' > "$STUB/claude"; chmod +x "$STUB/claude"
export PATH="$STUB:$PATH"
trap 'rm -rf "$ROOT" "$STUB"; tmux list-sessions -F "#{session_name}" 2>/dev/null | grep "^dispatch-test-" | xargs -r -I{} tmux kill-session -t {} 2>/dev/null || true' EXIT
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

echo "--- stale doing/ claim is requeued"
mkdir -p "$ROOT/.tasks/doing" "$ROOT/.tasks/todo"
touch "$ROOT/.tasks/doing/old.md"
# Backdate 3 hours — touch -t YYYYMMDDHHMM works on both Linux and macOS
touch -t 202601010000 "$ROOT/.tasks/doing/old.md"
OUT=$(run)
echo "$OUT" | grep -q "Requeued (stale claim): old.md" || { echo "FAIL: stale claim not requeued: $OUT"; exit 1; }
[ -f "$ROOT/.tasks/todo/old.md" ] || { echo "FAIL: file not moved to todo/: $OUT"; exit 1; }
[ ! -f "$ROOT/.tasks/doing/old.md" ] || { echo "FAIL: file still in doing/ after requeue: $OUT"; exit 1; }
echo "$OUT" | grep -q "Spawned: dispatch-test-1" || { echo "FAIL: requeued task not spawned: $OUT"; exit 1; }

echo "ALL DISPATCH SMOKE TESTS PASSED"
