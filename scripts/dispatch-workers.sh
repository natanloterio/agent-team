#!/usr/bin/env bash
# Dispatch /agent-team:worker tmux sessions for pending <tasksDir>/todo/ files.
# Reaps finished workers by the AGENT_TEAM_WORKER_* completion contract
# (primary) and Claude's idle-spinner heuristic (best-effort fallback).
set -euo pipefail

SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
env_out=$(node "$SCRIPT_DIR/lib/config.mjs" --print-env) || {
  echo "agent-team not configured — run /agent-team:setup" >&2
  exit 3
}
eval "$env_out"
cd "$AGENT_TEAM_ROOT"

command -v tmux >/dev/null || { echo "tmux not installed — run /agent-team:doctor" >&2; exit 1; }
mkdir -p "$AGENT_TEAM_TASKS_DIR"

# Portable lock: flock(1) is util-linux-only (absent on macOS); mkdir is
# atomic on every POSIX filesystem. A stale lock (holder PID dead) is reclaimed.
LOCK_DIR="$AGENT_TEAM_TASKS_DIR/.dispatch.lock.d"
acquire_lock() {
  if mkdir "$LOCK_DIR" 2>/dev/null; then
    echo $$ > "$LOCK_DIR/pid"
    return 0
  fi
  local holder
  holder=$(cat "$LOCK_DIR/pid" 2>/dev/null || echo "")
  if [ -n "$holder" ] && kill -0 "$holder" 2>/dev/null; then
    return 1
  fi
  # mv is atomic; prevents deleting a fresh lock another process just created
  local stale="$LOCK_DIR.stale.$$"
  mv "$LOCK_DIR" "$stale" 2>/dev/null && rm -rf "$stale" || true
  if mkdir "$LOCK_DIR" 2>/dev/null; then
    echo $$ > "$LOCK_DIR/pid"
    return 0
  fi
  return 1
}
if ! acquire_lock; then
  echo "Another dispatch is running; skipping."
  exit 0
fi
trap 'rm -rf "$LOCK_DIR"' EXIT

# --- Reap finished / idle / stale workers ---
NOW=$(date +%s)
MIN_AGE_FOR_IDLE_CHECK=60
for SESSION in $(tmux list-sessions -F '#{session_name}' 2>/dev/null | grep "^${AGENT_TEAM_WORKER_PREFIX}" || true); do
  LAST=$(tmux capture-pane -t "$SESSION" -p 2>/dev/null | tail -25)
  CREATED=$(tmux display-message -t "$SESSION" -p '#{session_created}' 2>/dev/null || echo "$NOW")
  AGE=$(( NOW - CREATED ))
  # Primary: the worker skill's pinned completion contract.
  # Age-gated to avoid false-positive reaping when the contract string appears
  # in the command text during session startup (before the worker has run).
  if [ "$AGE" -gt "$MIN_AGE_FOR_IDLE_CHECK" ] && echo "$LAST" | grep -qE "AGENT_TEAM_WORKER_(DONE|NO_TASKS|NO_CONFIG)"; then
    tmux kill-session -t "$SESSION" 2>/dev/null || true
    echo "Reaped (finished): $SESSION"
    continue
  fi
  # Fallback: Claude Code's spinner line turns past-tense + duration when a
  # turn finishes ("✻ Worked for 9m 21s", no ellipsis). FRAGILE — breaks when
  # the UI strings change; /agent-team:doctor is the diagnostic.
  if [ "$AGE" -gt "$MIN_AGE_FOR_IDLE_CHECK" ]; then
    IDLE_LINE=$(echo "$LAST" | grep -E '^[✻✶✽·*] [^[:space:]]+ for [0-9]+[ms]' | grep -v '…' | tail -1 || true)
    if [ -n "$IDLE_LINE" ]; then
      tmux kill-session -t "$SESSION" 2>/dev/null || true
      echo "Reaped (idle): $SESSION"
      continue
    fi
  fi
  if [ "$AGE" -gt "$AGENT_TEAM_STALE_SECONDS" ]; then
    tmux kill-session -t "$SESSION" 2>/dev/null || true
    echo "Reaped (>${AGENT_TEAM_STALE_SECONDS}s): $SESSION"
  fi
done

# --- Requeue stale doing/ claims ---
# Detect stat flavor once (Linux: stat -c %Y; macOS: stat -f %m)
if stat -c %Y / >/dev/null 2>&1; then
  _stat_mtime() { stat -c %Y "$1" 2>/dev/null; }
else
  _stat_mtime() { stat -f %m "$1" 2>/dev/null; }
fi
for DOING_FILE in "$AGENT_TEAM_TASKS_DIR/doing/"*.md; do
  [ -f "$DOING_FILE" ] || continue
  FILE_MTIME=$(_stat_mtime "$DOING_FILE")
  [ -n "$FILE_MTIME" ] || continue
  FILE_AGE=$(( NOW - FILE_MTIME ))
  if [ "$FILE_AGE" -gt "$AGENT_TEAM_STALE_SECONDS" ]; then
    DOING_BASENAME=$(basename "$DOING_FILE")
    mv "$DOING_FILE" "$AGENT_TEAM_TASKS_DIR/todo/$DOING_BASENAME"
    echo "Requeued (stale claim): $DOING_BASENAME"
  fi
done

# --- Spawn workers for unclaimed todos ---
ACTIVE=$(tmux list-sessions -F '#{session_name}' 2>/dev/null | grep -c "^${AGENT_TEAM_WORKER_PREFIX}" || true)
ACTIVE=${ACTIVE:-0}
SLOTS=$(( AGENT_TEAM_MAX_WORKERS - ACTIVE ))
echo "Active workers: $ACTIVE / $AGENT_TEAM_MAX_WORKERS. Slots: $SLOTS."
if [ "$SLOTS" -le 0 ]; then
  echo "Worker pool at capacity."
  exit 0
fi

mapfile -t TODOS < <(ls "$AGENT_TEAM_TASKS_DIR"/todo/*.md 2>/dev/null | sort | head -n "$SLOTS")
if [ ${#TODOS[@]} -eq 0 ]; then
  echo "No unclaimed tasks in $AGENT_TEAM_TASKS_DIR/todo/."
  exit 0
fi

SPAWNED=0
for N in $(seq 1 "$AGENT_TEAM_MAX_WORKERS"); do
  if [ $SPAWNED -ge ${#TODOS[@]} ]; then break; fi
  SESSION="${AGENT_TEAM_WORKER_PREFIX}${N}"
  if tmux has-session -t "$SESSION" 2>/dev/null; then continue; fi
  tmux new-session -d -s "$SESSION" -c "$AGENT_TEAM_ROOT" "claude --dangerously-skip-permissions"
  sleep 8
  tmux send-keys -t "$SESSION" "/agent-team:worker" Enter
  echo "Spawned: $SESSION (next available task: $(basename "${TODOS[$SPAWNED]}"))"
  SPAWNED=$(( SPAWNED + 1 ))
done
echo "Done. Spawned $SPAWNED worker(s)."
