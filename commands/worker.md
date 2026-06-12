---
name: worker
description: Use when starting a Claude Code session that should self-assign and execute a task from the task queue
---

# Worker Protocol

You are a worker Claude Code session. Your job is to claim one task from the queue, implement it, and hand it off for review. Follow these steps exactly.

## Step 0 — Load config

```bash
env_out=$(node "${CLAUDE_PLUGIN_ROOT}/scripts/lib/config.mjs" --print-env) || { printf 'AGENT_TEAM_WORKER_%s\n' 'NO_CONFIG'; exit 3; }
eval "$env_out"
```

If the config load fails, print `AGENT_TEAM_WORKER_NO_CONFIG` and stop.

## Step 1 — Find an available task

If this command was invoked with an argument (`$ARGUMENTS` non-empty), that is a
specific task file pinned to this session — use it directly:

```bash
REPO=$(basename $(git rev-parse --show-toplevel))
TASK_FILE="$ARGUMENTS"           # e.g. "2026-06-11-remove-dead-code.md"
[ -f "$AGENT_TEAM_TASKS_DIR/todo/$TASK_FILE" ] || { echo "Pinned task not found"; exit 1; }
```

Otherwise (no argument — daytime pool behavior, unchanged):

```bash
REPO=$(basename $(git rev-parse --show-toplevel))
TASK_FILE=$(ls "$AGENT_TEAM_TASKS_DIR/todo/"*.md 2>/dev/null | head -1 | xargs basename)
```

If `$AGENT_TEAM_TASKS_DIR/todo/` is empty or `$TASK_FILE` is unset, print `AGENT_TEAM_WORKER_NO_TASKS` (constructed form: `printf 'AGENT_TEAM_WORKER_%s\n' 'NO_TASKS'`) and stop.

## Step 2 — Claim the task atomically

Move the file to `doing/`:

```bash
mv "$AGENT_TEAM_TASKS_DIR/todo/$TASK_FILE" "$AGENT_TEAM_TASKS_DIR/doing/$TASK_FILE"
```

If `mv` exits non-zero, another session claimed it; go back to Step 1 and pick the next file.

## Step 3 — Fill in claim metadata

Derive the branch name and set it as a shell variable:

```bash
SLUG=$(basename $TASK_FILE .md | sed 's/^[0-9-]*-//')
WORKTREE_BRANCH="feat/$SLUG"
```

Open `"$AGENT_TEAM_TASKS_DIR/doing/$TASK_FILE"` and fill in the frontmatter fields:

- `worktree_branch`: set to `$WORKTREE_BRANCH`
- `claimed_at`: current ISO 8601 timestamp

Also read the task title into a variable for use in the final report:

```bash
TASK_TITLE=$(grep '^title:' "$AGENT_TEAM_TASKS_DIR/doing/$TASK_FILE" | sed 's/^title: *//')
```

## Step 4 — Adopt the role

Read the `role` field from the task frontmatter. Treat it as your system prompt for the rest of this session — adopt that persona, expertise, and focus area.

## Step 5 — Create a worktree

```bash
bash "${CLAUDE_PLUGIN_ROOT}/scripts/gwt.sh" "$REPO-$WORKTREE_BRANCH" -b "$WORKTREE_BRANCH"
```

Note: Shell state persists across Bash tool calls in this session, but re-run the Step 0 eval in any NEW bash context if variables come up empty. All subsequent commands must use absolute paths. Use `$(git rev-parse --show-toplevel)` to resolve the main repo root when needed.

## Step 6 — Implement the task

- Read `acceptance_criteria` from the task file — these are your definition of done
- Use TDD: write failing tests first, then implement
- Follow all instructions in `CLAUDE.md`
- Do not implement anything beyond the acceptance criteria (YAGNI)

## Step 7 — Open a PR

```bash
PR_URL=$(gh pr create --base "$AGENT_TEAM_PR_BASE" --fill)
```

Write `$PR_URL` into the `pr_url` field in the main repo's copy of the task file at `"$AGENT_TEAM_ROOT/$AGENT_TEAM_TASKS_DIR/doing/$TASK_FILE"`.

## Step 8 — Move the task to done

Move the task file from `doing/` to `done/` in the main repo:

```bash
MAIN_REPO="$AGENT_TEAM_ROOT"
mv "$MAIN_REPO/$AGENT_TEAM_TASKS_DIR/doing/$TASK_FILE" "$MAIN_REPO/$AGENT_TEAM_TASKS_DIR/done/$TASK_FILE"
```

## Step 9 — Report

Tell the user: "Task `$TASK_TITLE` is done. PR: `$PR_URL`. Moved to done/."

The final line of the session MUST be:

```
AGENT_TEAM_WORKER_DONE $TASK_FILE
```

## Completion contract (MANDATORY)

The dispatcher reaps this session by scanning the pane for these exact
strings. End the session with exactly one of:

- `AGENT_TEAM_WORKER_DONE <task-filename>` — task implemented, PR open, file moved to done/
- `AGENT_TEAM_WORKER_NO_TASKS` — queue was empty
- `AGENT_TEAM_WORKER_NO_CONFIG` — .agent-team/config.json missing/invalid

Never paraphrase these lines. Print the line as the last output of your turn.

**Important:** Do not write these strings anywhere except the final printed line — not in prose, not inside quoted commands. When a command must emit one on failure, construct it (e.g. `printf 'AGENT_TEAM_WORKER_%s\n' 'NO_TASKS'`) so the literal never appears in your rendered input.
