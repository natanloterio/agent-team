#!/usr/bin/env bash
# Forward a Claude Code hook event to the local leader-events daemon.
#
# Reads the hook JSON payload from stdin, POSTs it to a Unix socket the
# team-leader listens on. Designed to never block or fail the calling session:
#   - hard 1s curl timeout
#   - silent if the daemon isn't running (socket absent)
#   - errors swallowed (|| true)
#
# Wired via hooks/hooks.json for Stop, SubagentStop, Notification,
# SessionStart and SessionEnd.

set -u

payload=$(cat)
[ -z "$payload" ] && exit 0

# Resolve the main worktree (the socket lives in main's tasks/ and is
# symlinked into every worktree by `gwt`, but `git rev-parse --show-toplevel`
# from a worktree returns the worktree path, not main, so go through
# `git worktree list`).
root=$(git worktree list --porcelain 2>/dev/null | awk '/^worktree /{print $2; exit}')
[ -z "$root" ] && exit 0

tasksdir=$(node -e "
try {
  const c = JSON.parse(require('fs').readFileSync(process.argv[1] + '/.agent-team/config.json', 'utf8'));
  process.stdout.write(c.tasksDir || '.tasks');
} catch { process.stdout.write('.tasks'); }
" "$root" 2>/dev/null || echo ".tasks")
sock="$root/$tasksdir/.leader-events.sock"
[ -S "$sock" ] || exit 0

printf '%s' "$payload" | curl -fsS \
  --unix-socket "$sock" \
  --max-time 1 \
  -H 'Content-Type: application/json' \
  --data-binary @- \
  http://localhost/event \
  >/dev/null 2>&1 || true

exit 0
