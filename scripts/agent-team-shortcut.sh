# agent-team — live workers dashboard shortcut (works in bash & zsh)
#
# This file ships with the agent-team plugin. To enable the `agent-watch`
# command, source it from your shell rc (~/.bashrc and/or ~/.zshrc):
#
#   [ -f "$HOME/.claude/plugins/marketplaces/agent-team/scripts/agent-team-shortcut.sh" ] \
#     && source "$HOME/.claude/plugins/marketplaces/agent-team/scripts/agent-team-shortcut.sh"
#
# /agent-team:setup can add that line for you (opt-in). Because the file lives
# inside the plugin, the function updates whenever the plugin updates.
#
# Usage — run it from inside the target project's git repo, so the script reads
# that repo's .agent-team/config.json (it decides which agent-worker-* sessions
# to show):
#
#   agent-watch                 build (or attach to) the live dashboard
#   agent-watch --here          embed it in the current tmux window
#   agent-watch --once          one-shot text snapshot, no tmux
#   agent-watch --interval 1    any watch-workers.sh flag is passed through
#
# Multi-project tip: each project should set a distinct workerSessionPrefix in
# its config; pass MONITOR=<name> to keep dashboards separate, e.g.
#   MONITOR=monitor-proj-a agent-watch
agent-watch() {
  local script=""
  # Prefer a repo-local copy (when run from a clone of agent-team itself),
  # otherwise fall back to the installed plugin location.
  if [ -f "scripts/watch-workers.sh" ]; then
    script="scripts/watch-workers.sh"
  elif [ -f "$HOME/.claude/plugins/marketplaces/agent-team/scripts/watch-workers.sh" ]; then
    script="$HOME/.claude/plugins/marketplaces/agent-team/scripts/watch-workers.sh"
  else
    echo "agent-watch: watch-workers.sh not found — is the agent-team plugin installed?" >&2
    return 1
  fi
  # Optional per-project monitor session: `MONITOR=foo agent-watch`
  if [ -n "${MONITOR:-}" ]; then
    AGENT_TEAM_MONITOR_SESSION="$MONITOR" bash "$script" "$@"
  else
    bash "$script" "$@"
  fi
}
