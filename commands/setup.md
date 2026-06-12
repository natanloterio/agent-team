---
name: setup
description: Guided first-time setup for agent-team — dependency preflight, project configuration, optional Trello board integration.
---

# agent-team setup

You are configuring this repository to run an agent team. Work through the
phases IN ORDER. Never run package installs yourself — show the command, let
the user run it, then re-verify.

## Phase 1 — Dependency preflight (one dependency at a time)

For each of `git`, `node`, `tmux`, `gh`, `claude`:

1. Check: `command -v <dep>`.
2. If missing: detect the package manager
   (`command -v apt-get || command -v dnf || command -v pacman || command -v brew`)
   and print the exact install command (e.g. `sudo apt-get install -y tmux`,
   `brew install tmux`; for gh/claude use their official install docs URL).
   Tell the user to run it — suggest the `! <command>` prompt prefix — and
   WAIT. Do not check the next dependency yet.
3. Re-verify with `command -v`. Only move on when it passes.
4. Extra for gh: `gh auth status` must pass; if not, instruct `gh auth login`
   (interactive — the user must run it themselves) and re-verify.

## Phase 2 — Project configuration

Ask, one question at a time (suggest detected defaults):
1. PR base branch (default: the repo's default branch from `gh repo view --json defaultBranchRef`)
2. Max concurrent workers (default 4)
3. Dev server command + URL for UI-task review checks (or "none" — UI tasks
   will then fail review with a clear reason until configured)
4. Symlink `.env*` files into worktrees? (explain: workers usually need env
   to run dev servers, but this links secrets into every worktree)

Then write `.agent-team/config.json`:

```json
{
  "prBase": "<answer 1>",
  "maxWorkers": <answer 2>,
  "tasksDir": ".tasks",
  "workerSessionPrefix": "agent-worker-",
  "devServer": { "command": "<answer 3>", "url": "<answer 3>" },
  "worktree": { "linkEnvFiles": <answer 4> },
  "board": { "provider": "none" }
}
```

(Omit `devServer` entirely if the answer was "none".)

Create the queue skeleton and ensure it is gitignored:

```bash
mkdir -p .tasks/todo .tasks/doing .tasks/done .tasks/approved .tasks/backlog
grep -qxF '.tasks/' .gitignore 2>/dev/null || echo '.tasks/' >> .gitignore
```

Validate before continuing: `node "${CLAUDE_PLUGIN_ROOT}/scripts/lib/config.mjs" --print-env` must succeed.

## Phase 3 — Optional Trello integration

Ask: "Do you want to sync the task queue to a Trello board? (optional)"
If no → skip to Phase 4.

1. Credentials: point the user to https://trello.com/app-key for the API key;
   explain the "Token" link on that page authorizes a token for their
   account. Ask for both.
2. Write them to `.env.agents` as `TRELLO_API_KEY=` / `TRELLO_SECRET=`, and
   ensure `.env.agents` is in `.gitignore` BEFORE writing.
3. Board: offer (a) create a new board with lists Todo-Agents / Doing / Done
   via the Trello REST API, or (b) use an existing board — list the user's
   boards (`GET /1/members/me/boards?fields=name`) and their lists, let them
   map each queue folder (todo/doing/done/approved) to a list. Folders MAY
   share a list (e.g. done→Doing while "in review", approved→Done).
4. Persist RESOLVED IDs (never names) into config:
   `board: { provider: "trello", boardId, listIds: {todo, doing, done, approved}, envFile: ".env.agents" }`.
5. Smoke test: create a card named "agent-team setup test" on the todo list,
   move it to the done list, delete it. All three calls must return 200.
   Report "Trello connected".

## Phase 4 — Wrap up

1. Run the doctor checks (see /agent-team:doctor sections 1-3) as final validation.
2. Tell the user how to start:
   - leader session: `/agent-team:team-leader`
   - the leader dispatches workers automatically; manual worker: `/agent-team:worker`
   - reviews: automatic on task completion, or `/agent-team:reviewer`
