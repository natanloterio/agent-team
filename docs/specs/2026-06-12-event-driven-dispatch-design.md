# Event-Driven Dispatch for Team Leader — Design

**Date:** 2026-06-12
**Status:** Approved design, pending implementation plan

## Problem

The team-leader session currently sets up `/loop 1m bash scripts/dispatch-workers.sh`
at bootstrap. Every minute the Claude session wakes, runs the script, and the
output enters the model context — ~60 wakes/hour even when nothing happens.
This pollutes context and burns turns on no-op checks.

`dispatch-workers.sh` is pure bash (reap + spawn via tmux); the model is only
needed to *trigger* it and to *react* to results (e.g. review completed tasks).

## Solution

Replace the 1-minute loop with an event-driven wake: a one-shot watcher script
run via the Bash tool with `run_in_background`. The Claude Code harness
re-invokes the model when a background process exits, so the script simply
blocks until a filesystem event and exits. Zero turns while nothing happens.

## Components

### 1. `scripts/await-task-event.mjs` (new)

A one-shot watcher using Node's `fs.watch` (inotify on Linux — no new system
dependency; `inotifywait` was considered and rejected because it requires
`apt install inotify-tools`).

Behavior:

- Anchors paths on the **main worktree** root via `git worktree list
  --porcelain` (same pattern as `leader-events.mjs`), so it works regardless
  of which checkout it's launched from.
- Watches `.tasks/todo/` and `.tasks/done/`.
- Exits on the **first** relevant event — a `*.md` file created or moved into
  either directory — printing a single machine-readable line:
  - `EVENT todo <filename>` — new task available
  - `EVENT done <filename>` — worker finished a task (slot freed + review needed)
- Ignores non-`.md` files (lock files, hidden files) and delete/claim events
  (`todo/ → doing/` removal must NOT wake the leader).
- Fallback timeout (default **30 minutes**, overridable via argv): exits
  printing `TIMEOUT`. This guarantees dead/idle workers still get reaped and
  any missed event is recovered. Exit code 0 in all cases (the wake itself is
  the signal; the printed line carries the meaning).
- Validates that `.tasks/todo/` and `.tasks/done/` exist (creates them with
  `mkdirSync recursive` before watching), and fails fast with a clear message
  if the repo root cannot be determined.

### 2. Team-leader skill changes

In `.claude/commands/team-leader.md` (repo) and `~/.claude/skills/team-leader.md`
(global copy — keep in sync, same lesson as the worker.md drift):

- **Remove** the "Recurring auto-dispatch" section (`/loop 1m ...`).
- **Add** an "Event-driven dispatch" section:

  **Bootstrap:** run `bash scripts/dispatch-workers.sh` once, then arm the
  watcher: `node scripts/await-task-event.mjs` via Bash `run_in_background`.

  **On wake** (background task exits):
  1. **Re-arm first** — launch a new background `await-task-event.mjs`
     immediately, *before* doing anything else. This closes the race window:
     a file that lands while dispatch/review is running is caught by the
     already-armed watcher. Worst case is a spurious wake, which is cheap
     because dispatch is idempotent and lock-protected.
  2. Run `bash scripts/dispatch-workers.sh` (covers all wake reasons:
     new todo → spawn; done → freed slot, pull queued todos; timeout → reap).
  3. If the event was `EVENT done <file>`: **run Review Mode automatically**
     for the files in `.tasks/done/` (the existing review sequence: read task,
     fetch PR diff, check acceptance criteria, UI check for `type: ui`,
     verdict). No developer prompt needed.
  4. If `TIMEOUT`: dispatch only; do not report anything to the developer
     unless dispatch output shows reaps or spawns.

  **Guard:** only one watcher may be armed at a time. If a wake fires while a
  previous review is still in progress, re-arm exactly once (the harness
  serializes turns, so this is naturally enforced; the instruction exists to
  prevent the model from arming duplicates).

## Race analysis

- **Event during the unarmed gap** (between watcher exit and re-arm): step 1
  (re-arm first) shrinks the gap to a single tool call; anything missed inside
  that sliver is recovered by the 30-min timeout pass, and `dispatch-workers.sh`
  always scans the whole `todo/` dir rather than acting on a single file.
- **Burst of files** (e.g. Trello sync creates 5 tasks): watcher exits on the
  first; dispatch handles all 5; the re-armed watcher may fire once more
  spuriously for a file dispatch already consumed — harmless no-op.
- **Atomic `mv` claims** (`todo/ → doing/`): generate only a removal event in
  `todo/`, which the watcher ignores. No wake on claims.

## Non-goals

- The leader-events daemon (`scripts/leader-events.mjs`) is unchanged. Its
  Stop/Notification log remains a complementary signal; this design does not
  consume it.
- `dispatch-workers.sh` is unchanged.
- Night-shift's own loop (`/loop 30m /night-shift`) is unaffected — it runs in
  a separate session and does not use the team-leader dispatch loop.

## Testing

- Unit-ish smoke test for `await-task-event.mjs` (vitest or plain script):
  - touch a `.md` file in `todo/` → process exits printing `EVENT todo <name>`
  - `mv` a `.md` file into `done/` → exits printing `EVENT done <name>`
  - non-`.md` file → no exit
  - short timeout (e.g. 2s via argv) → exits printing `TIMEOUT`
- Manual end-to-end: arm via `run_in_background` in a live team-leader
  session, drop a task file, confirm the session wakes and dispatches.

## Impact

Worst-case idle night: ~16 trivial wakes (timeouts) instead of ~480
unconditional loop ticks. Active periods wake exactly when a task arrives or
completes — which is also when the model actually has work to do.
