#!/usr/bin/env bash
# Nudge toward /agent-team:setup — ONLY in repos that show agent-team
# footprint (an .agent-team/ dir or a task-queue skeleton) but lack a valid
# config. Plain repos get no output at all.
set -u
root=$(git rev-parse --show-toplevel 2>/dev/null) || exit 0
config="$root/.agent-team/config.json"

if [ -f "$config" ]; then
  if node -e "JSON.parse(require('fs').readFileSync(process.argv[1],'utf8'))" "$config" 2>/dev/null; then
    exit 0   # configured and parseable — silent
  fi
  echo "agent-team: $config exists but is not valid JSON — run /agent-team:setup (or /agent-team:doctor) to repair it."
  exit 0
fi

if [ -d "$root/.agent-team" ] || [ -d "$root/.tasks/todo" ]; then
  echo "agent-team is installed but this project is not configured — run /agent-team:setup to get started."
fi
exit 0
