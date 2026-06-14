#!/usr/bin/env bash
# watch-workers.sh — open a live tmux dashboard that tiles every running
# agent-worker-* session into a single window, so you can watch the whole team
# at a glance instead of attaching to workers one by one.
#
# It is READ-ONLY: each pane mirrors a worker's output via `tmux capture-pane`,
# so the dashboard never attaches a client to the workers (it can't resize them
# or send them keystrokes). It is DYNAMIC: a background controller tiles in new
# workers as they are spawned, so panes appear as the team grows.
#
# usage:
#   watch-workers.sh                 build (or attach to) the live dashboard
#   watch-workers.sh --interval 1    refresh each pane every 1s (default: 2)
#   watch-workers.sh --rebuild       force a fresh re-tile to the current workers
#   watch-workers.sh --no-auto       don't auto-tile new workers as they appear
#   watch-workers.sh --once          print a one-shot snapshot and exit (no tmux)
#   watch-workers.sh -h | --help     show this help
#
# The dashboard lives in its own tmux session (default: "agent-team-monitor",
# override with AGENT_TEAM_MONITOR_SESSION). Detach with the usual tmux key
# (Ctrl-b d); the workers keep running. Re-run to re-attach.
set -euo pipefail

SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
SELF="$SCRIPT_DIR/$(basename "${BASH_SOURCE[0]}")"

# Help must work without a configured repo, so handle it before anything else.
for _a in "$@"; do
  case "$_a" in
    -h|--help) sed -n '2,/^set -euo/p' "$SELF" | sed '$d; s/^# \{0,1\}//'; exit 0 ;;
  esac
done

# These are needed by the internal entrypoints below, which tmux spawns from the
# server's environment (no config available there). The parent passes them in as
# AGENT_TEAM_WORKER_PREFIX / AGENT_TEAM_MONITOR_SESSION when it spawns a pane or
# the controller, so internal modes never have to load config.
PREFIX="${AGENT_TEAM_WORKER_PREFIX:-}"
MONITOR="${AGENT_TEAM_MONITOR_SESSION:-agent-team-monitor}"
AGENTS_WIN="$MONITOR:agents"

list_workers() {
  tmux list-sessions -F '#{session_name}' 2>/dev/null \
    | grep "^${PREFIX}" | sort || true
}

# --- internal entrypoints (invoked by the panes / controller, not by humans) ---
case "${1:-}" in
  __pane)
    # __pane <worker-session> <interval> — live read-only mirror of one worker.
    target="$2"; interval="$3"
    trap 'exit 0' INT TERM
    while true; do
      printf '\033[H\033[2J'                                   # home + clear
      if tmux has-session -t "$target" 2>/dev/null; then
        h=$(tmux display-message -p '#{pane_height}' 2>/dev/null || echo 40)
        if [ "$h" -gt 2 ] 2>/dev/null; then tail_n=$(( h - 1 )); else tail_n=24; fi
        tmux capture-pane -p -t "$target" 2>/dev/null | tail -n "$tail_n"
      else
        printf '(%s ended)\n' "$target"
      fi
      sleep "$interval"
    done
    ;;
  __control)
    # __control <interval> — add a pane whenever a new worker appears and drop
    # the placeholder once the first real worker arrives. Never kills the
    # session, so it survives alongside the panes it manages.
    interval="$2"
    while tmux has-session -t "$MONITOR" 2>/dev/null; do
      have=$(tmux list-panes -t "$AGENTS_WIN" -F '#{pane_title}' 2>/dev/null || true)
      while IFS= read -r w; do
        [ -n "$w" ] || continue
        if ! printf '%s\n' "$have" | grep -qxF "$w"; then
          pid=$(tmux split-window -t "$AGENTS_WIN" -P -F '#{pane_id}' \
                  "AGENT_TEAM_WORKER_PREFIX='$PREFIX' AGENT_TEAM_MONITOR_SESSION='$MONITOR' '$SELF' __pane $w $interval")
          tmux select-pane -t "$pid" -T "$w"
          tmux select-layout -t "$AGENTS_WIN" tiled >/dev/null 2>&1 || true
          ph=$(tmux list-panes -t "$AGENTS_WIN" -F '#{pane_id} #{pane_title}' \
                 2>/dev/null | awk '$2=="_waiting"{print $1}')
          [ -n "$ph" ] && tmux kill-pane -t "$ph" 2>/dev/null || true
        fi
      done < <(list_workers)
      sleep 3
    done
    exit 0
    ;;
esac

# --- normal invocation: load config, parse flags ------------------------------
env_out=$(node "$SCRIPT_DIR/lib/config.mjs" --print-env) || {
  echo "agent-team not configured — run /agent-team:setup" >&2
  exit 3
}
eval "$env_out"
PREFIX="$AGENT_TEAM_WORKER_PREFIX"   # authoritative value from config

INTERVAL=2
AUTO=1
MODE=open
while [ $# -gt 0 ]; do
  case "$1" in
    --interval) INTERVAL="${2:?--interval needs a value}"; shift 2 ;;
    --rebuild)  MODE=rebuild; shift ;;
    --no-auto)  AUTO=0; shift ;;
    --once)     MODE=once; shift ;;
    *) echo "unknown argument: $1 (try --help)" >&2; exit 2 ;;
  esac
done

command -v tmux >/dev/null || { echo "tmux not installed — run /agent-team:doctor" >&2; exit 1; }

# Command string for a pane/controller that carries the env they need, so the
# tmux-server-spawned process never has to find config.
pane_cmd() { printf "AGENT_TEAM_WORKER_PREFIX='%s' AGENT_TEAM_MONITOR_SESSION='%s' '%s' %s" \
  "$PREFIX" "$MONITOR" "$SELF" "$1"; }

# --- one-shot snapshot (no tmux session; handy for the leader or CI) ----------
if [ "$MODE" = once ]; then
  found=0
  while IFS= read -r w; do
    [ -n "$w" ] || continue
    found=1
    printf '\n===== %s =====\n' "$w"
    tmux capture-pane -p -t "$w" 2>/dev/null | tail -n 20
  done < <(list_workers)
  [ "$found" = 1 ] || echo "No active ${PREFIX}* workers."
  exit 0
fi

# --- build the tiled dashboard from the current worker set --------------------
build_dashboard() {
  tmux kill-session -t "$MONITOR" 2>/dev/null || true

  first=""
  while IFS= read -r w; do [ -n "$w" ] && { first="$w"; break; }; done < <(list_workers)

  if [ -z "$first" ]; then
    tmux new-session -d -s "$MONITOR" -n agents \
      "printf 'Waiting for %s* workers…\\n(this view fills in as the team starts)\\n' '$PREFIX'; while :; do sleep 3; done"
    pid=$(tmux list-panes -t "$AGENTS_WIN" -F '#{pane_id}' | head -1)
    tmux select-pane -t "$pid" -T "_waiting"
  else
    tmux new-session -d -s "$MONITOR" -n agents "$(pane_cmd "__pane $first $INTERVAL")"
    pid=$(tmux list-panes -t "$AGENTS_WIN" -F '#{pane_id}' | head -1)
    tmux select-pane -t "$pid" -T "$first"
    while IFS= read -r w; do
      [ -n "$w" ] && [ "$w" != "$first" ] || continue
      npid=$(tmux split-window -t "$AGENTS_WIN" -P -F '#{pane_id}' "$(pane_cmd "__pane $w $INTERVAL")")
      tmux select-pane -t "$npid" -T "$w"
      tmux select-layout -t "$AGENTS_WIN" tiled >/dev/null 2>&1 || true
    done < <(list_workers)
  fi

  tmux select-layout -t "$AGENTS_WIN" tiled >/dev/null 2>&1 || true
  tmux set-option -t "$MONITOR" mouse on >/dev/null 2>&1 || true
  tmux set-option -t "$MONITOR" pane-border-status top >/dev/null 2>&1 || true
  tmux set-option -t "$MONITOR" pane-border-format ' #{pane_title} ' >/dev/null 2>&1 || true

  if [ "$AUTO" = 1 ]; then
    tmux new-window -d -t "$MONITOR" -n _control "$(pane_cmd "__control $INTERVAL")"
  fi
}

# --- open / rebuild + attach --------------------------------------------------
if [ "$MODE" = rebuild ] || ! tmux has-session -t "$MONITOR" 2>/dev/null; then
  build_dashboard
fi

if [ -n "${TMUX:-}" ]; then
  tmux switch-client -t "$MONITOR"
else
  exec tmux attach-session -t "$MONITOR"
fi
