#!/usr/bin/env bash
# Create an isolated git worktree under <main>/.worktrees/<name>, sharing the
# task queue (and, when worktree.linkEnvFiles is true, .env* files) with the
# main checkout. Replaces the legacy `gwt` shell function.
# usage: gwt.sh <path-or-name> [-b branch] [git-worktree-args...]
set -euo pipefail

SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
if [ $# -lt 1 ]; then
  echo "usage: gwt.sh <path-or-name> [-b branch] [git-worktree-args...]" >&2
  exit 2
fi

env_out=$(node "$SCRIPT_DIR/lib/config.mjs" --print-env) || exit 3
eval "$env_out"
root="$AGENT_TEAM_ROOT"

base=$(basename "$1")
shift
target="$root/.worktrees/$base"

mkdir -p "$root/.worktrees"
git -C "$root" worktree add "$target" "$@"

env_count=0
if [ "$AGENT_TEAM_LINK_ENV_FILES" = "true" ]; then
  while IFS= read -r env_file; do
    rel="${env_file#"$root"/}"
    dest="$target/$rel"
    mkdir -p "$(dirname "$dest")"
    ln -sf "$env_file" "$dest"
    env_count=$((env_count + 1))
  done < <(find "$root" -maxdepth 4 -name ".env*" \
    -not -path "*/.git/*" \
    -not -path "*/node_modules/*" \
    -not -path "*/.worktrees/*")
fi

task_linked="no"
if [ -d "$root/$AGENT_TEAM_TASKS_DIR" ]; then
  rm -rf "${target:?}/$AGENT_TEAM_TASKS_DIR"
  ln -s "$root/$AGENT_TEAM_TASKS_DIR" "$target/$AGENT_TEAM_TASKS_DIR"
  task_linked="yes"
fi

echo "Worktree: $target"
echo "  .env symlinks: $env_count"
echo "  $AGENT_TEAM_TASKS_DIR linked: $task_linked"
