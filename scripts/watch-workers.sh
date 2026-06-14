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
#   watch-workers.sh --here          embed the dashboard in the CURRENT tmux
#                                    window, beside the pane you ran it from
#   watch-workers.sh --interval 1    refresh each pane every 1s (default: 2)
#   watch-workers.sh --rebuild       force a fresh re-tile to the current workers
#   watch-workers.sh --no-auto       don't auto-tile new workers as they appear
#   watch-workers.sh --once          print a one-shot snapshot and exit (no tmux)
#   watch-workers.sh -h | --help     show this help
#
# By default the dashboard lives in its own tmux session (default:
# "agent-team-monitor", override with AGENT_TEAM_MONITOR_SESSION). Detach with
# the usual tmux key (Ctrl-b d); the workers keep running. Re-run to re-attach.
#
# With --here (must be run from inside a tmux pane) the dashboard is embedded in
# your current window instead: the calling pane becomes a small control strip and
# the worker mirrors tile into its region, so you can keep a team-leader pane on
# one side and watch the workers tile in beside it. Ctrl-C closes the embedded
# dashboard (the worker panes are removed; the workers themselves keep running).
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
          if [ -n "$ph" ]; then tmux kill-pane -t "$ph" 2>/dev/null || true; fi
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

# Default the monitor session name off the worker prefix, so dashboards for
# different projects (which should use distinct prefixes) never collide on a
# single shared session. An explicit AGENT_TEAM_MONITOR_SESSION always wins;
# the resolved value is passed down to panes/controller via pane_cmd, keeping
# every spawned process consistent.
if [ -z "${AGENT_TEAM_MONITOR_SESSION:-}" ]; then
  slug=$(printf '%s' "$PREFIX" | tr -c 'A-Za-z0-9_-' '-' | sed 's/-*$//')
  MONITOR="agent-team-monitor${slug:+-$slug}"
  AGENTS_WIN="$MONITOR:agents"
fi

INTERVAL=2
AUTO=1
MODE=open
HERE=0
while [ $# -gt 0 ]; do
  case "$1" in
    --interval) INTERVAL="${2:?--interval needs a value}"; shift 2 ;;
    --here)     HERE=1; shift ;;
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

# --- embedded (--here) dashboard ----------------------------------------------
# Unlike the default mode (which lives in its own session and steals the client
# with switch-client), --here tiles the worker mirrors into the CURRENT window,
# beside the pane it was launched from. The launching pane stays in the
# foreground as a thin control strip running the loop below; the worker mirrors
# are split off into its region. The team-leader pane in the same window is never
# touched, because we only ever split the control pane (once) or panes we created
# ourselves (identified by their PREFIX* title).

# true if some pane in $HERE_WIN already mirrors worker $1 (matched by title).
worker_has_pane() {
  tmux list-panes -t "$HERE_WIN" -F '#{pane_title}' 2>/dev/null | grep -qxF "$1"
}

# "<pane_id> <width> <height>" of the largest worker mirror pane we manage, so we
# split the roomiest one next and keep the region evenly tiled. Empty if none.
largest_worker_pane() {
  tmux list-panes -t "$HERE_WIN" -F '#{pane_id} #{pane_width} #{pane_height} #{pane_title}' 2>/dev/null \
    | awk -v pfx="$PREFIX" '
        index($4, pfx)==1 { a=$2*$3; if (a>best){best=a; id=$1; w=$2; h=$3} }
        END { if (id!="") print id, w, h }'
}

# split a new read-only mirror pane for worker $1 into the region and title it.
add_worker_pane() {
  local w="$1" src src_id wpx hpx dir npid
  src=$(largest_worker_pane)
  if [ -z "$src" ]; then
    # First worker: carve it out of the control pane, then shrink the control
    # pane to a thin strip so the worker mirror gets the bulk of the region.
    npid=$(tmux split-window -v -P -F '#{pane_id}' -t "$HERE_CTRL" "$(pane_cmd "__pane $w $INTERVAL")")
    tmux resize-pane -t "$HERE_CTRL" -y 6 2>/dev/null || true
  else
    read -r src_id wpx hpx <<<"$src"
    # Cells are ~2x taller than wide, so a "square" region has width ≈ 2*height;
    # split the long axis to keep the new panes roughly square.
    if [ "$wpx" -gt $((2 * hpx)) ]; then dir=-h; else dir=-v; fi
    npid=$(tmux split-window "$dir" -P -F '#{pane_id}' -t "$src_id" "$(pane_cmd "__pane $w $INTERVAL")")
  fi
  tmux select-pane -t "$npid" -T "$w"
  printf '%s' "$npid"
}

# redraw the control strip: a compact live header in the launching pane.
render_here_header() {
  local n; n=$(list_workers | grep -c . || true)
  printf '\033[H\033[2J'
  printf 'agent-team · embedded worker dashboard\n'
  printf -- '----------------------------------------\n'
  if [ "$n" -eq 0 ]; then
    printf 'Waiting for %s* workers…\n' "$PREFIX"
  else
    printf 'Watching %s worker(s): ' "$n"
    list_workers | tr '\n' ' '; printf '\n'
  fi
  printf 'Ctrl-C: close dashboard (workers keep running)  ·  Ctrl-b d: detach\n'
}

# kill the mirror panes we created and restore the launching pane to a shell.
here_teardown() {
  trap - INT TERM
  local p
  for p in $HERE_CREATED; do tmux kill-pane -t "$p" 2>/dev/null || true; done
  printf '\033[H\033[2J'
  exit 0
}

here_dashboard() {
  HERE_CTRL=$(tmux display-message -p '#{pane_id}')
  HERE_WIN=$(tmux display-message -p '#{window_id}')
  HERE_CREATED=""
  tmux select-pane -t "$HERE_CTRL" -T "_monitor" 2>/dev/null || true
  tmux set-option -w pane-border-status top >/dev/null 2>&1 || true
  tmux set-option -w pane-border-format ' #{pane_title} ' >/dev/null 2>&1 || true
  tmux set-option mouse on >/dev/null 2>&1 || true
  trap 'here_teardown' INT TERM

  while tmux display-message -p -t "$HERE_WIN" '#{window_id}' >/dev/null 2>&1; do
    while IFS= read -r w; do
      [ -n "$w" ] || continue
      if ! worker_has_pane "$w"; then
        npid=$(add_worker_pane "$w") && HERE_CREATED="$HERE_CREATED $npid"
      fi
    done < <(list_workers)
    render_here_header
    if [ "$AUTO" != 1 ]; then
      # --no-auto: built the current set once; idle, refreshing only the header.
      while tmux display-message -p -t "$HERE_WIN" '#{window_id}' >/dev/null 2>&1; do
        render_here_header; sleep "$INTERVAL"
      done
      break
    fi
    sleep 3
  done
}

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
      if [ -z "$w" ] || [ "$w" = "$first" ]; then continue; fi
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

# --- embedded mode: tile into the current window instead of a new session -----
if [ "$HERE" = 1 ]; then
  if [ -z "${TMUX:-}" ]; then
    echo "--here must be run from inside a tmux pane" >&2
    exit 1
  fi
  here_dashboard
  exit 0
fi

# --- open / rebuild + attach --------------------------------------------------
if [ "$MODE" = rebuild ] || ! tmux has-session -t "$MONITOR" 2>/dev/null; then
  build_dashboard
fi

if [ -n "${TMUX:-}" ]; then
  tmux switch-client -t "$MONITOR"
else
  exec tmux attach-session -t "$MONITOR"
fi
