# Roles in depth

agent-team has three roles, each started as its own Claude Code session. This
page explains what each one does and the moving parts behind them. For a quick
summary, see the [README](../README.md#the-three-roles).

- [`/agent-team:team-leader`](#team-leader) — plans and coordinates
- [`/agent-team:worker`](#worker) — implements one task
- [`/agent-team:reviewer`](#reviewer) — verifies and merges

---

## team-leader

The coordinator. It receives goals from you, breaks them into task files in
`todo/`, dispatches worker sessions, and reviews completed work.

### Event-driven dispatch

Dispatch is event-driven — the leader wakes exactly when something happens, not
on a polling interval.

After the first one-shot dispatch at bootstrap, the leader arms
`scripts/await-task-event.mjs` as a background process. The watcher uses
`fs.watch` (inotify on Linux, FSEvents on macOS) and exits as soon as a `*.md`
file appears in `todo/` or `done/`, printing one of three lines:

- `EVENT todo <file>` — a new task is ready to dispatch
- `EVENT done <file>` — a worker finished; the leader runs a full review pass
- `TIMEOUT` — a 30-minute fallback to recover missed events and reap stale workers

On every wake the leader **re-arms the watcher first** (closing the race window),
then runs `dispatch-workers.sh`. A `done` event triggers an automatic review pass
without prompting you.

The leader also starts the leader-events daemon (which receives Stop/Notification
events from worker sessions over a Unix socket) and, when `board.provider` is
`"trello"`, the Trello sync daemon.

### Brainstorm Mode

For vague or ambiguous goals — or any time you ask ("brainstorm this") — the
leader offers **Brainstorm Mode**: a structured refinement loop that writes
nothing until you approve the design.

1. Clarifying questions, one at a time
2. 2–3 approaches with trade-offs
3. A sectioned design review

On approval it saves a spec to `<tasksDir>/specs/` — visible to every worker
worktree via the `gwt.sh` symlink — and breaks it into task files. Each task's
frontmatter carries an optional `spec:` field pointing back to the spec, and
workers read it before implementing.

> **Tip:** attach to a running worker to watch it work:
> `tmux attach -t <session-name>`

### Governance Mode

When `governance.enabled` is `true` in `.agent-team/config.json`, the
team-leader runs a planning pipeline of sub-agents **before** dispatching any
workers. In Dispatch Mode (the default) tasks go straight to `todo/`; in
Governance Mode they go through a three-phase review first.

**Pipeline phases:**

1. **Administrador** (1 sub-agent) — turns the raw demand into `requirements.md`
   and a macro-task list.
2. **Arquiteto/Engenheiro** (1 sub-agent per macro-task, run in parallel) —
   breaks each macro-task into blocks of subtasks, carrying strategic context
   (project vision, block objective) down to every task file.
3. **Conselho** (N sub-agents per block, one per configured lens, run in
   parallel) — peer-reviews the proposed subtasks. A block is approved on a
   **strict majority** of `approve` votes with **no `critical` finding**; any
   `critical` is a veto that forces a correction cycle. Up to `governance.maxCycles`
   cycles are attempted; if exhausted, the block moves to `backlog/` and the
   team-leader notifies you to decide.

Approved subtasks land in `todo/` and are picked up by workers exactly as in
Dispatch Mode. Planning artifacts (requirements, macro-tasks, per-block subtask
proposals, and per-cycle Council findings) are persisted under
`<tasksDir>/planning/<demand-slug>/` so the process is auditable and survives a
session crash.

See the [Governance Layer design](specs/2026-06-17-governance-layer-design.md)
for the full spec and the [configuration reference](configuration.md#fields)
for available knobs (`governance.enabled`, `governance.councilLenses`,
`governance.maxCycles`).

---

## worker

A self-contained implementation session. On startup a worker:

1. Loads config and **fails fast** (`AGENT_TEAM_WORKER_NO_CONFIG`) if
   `.agent-team/config.json` is absent.
2. Claims the first available task atomically via `mv todo/ -> doing/`; exits
   with `AGENT_TEAM_WORKER_NO_TASKS` if the queue is empty.
3. Creates an isolated git worktree under `.worktrees/` using `gwt.sh`.
4. Adopts the task's `role` field as its persona and implements the task
   following TDD.
5. Opens a PR against the configured `prBase` branch, records the URL in the
   task file, and moves the file to `done/`.
6. Prints `AGENT_TEAM_WORKER_DONE <task-filename>` as its final line.

Workers are normally spawned by `dispatch-workers.sh` as detached tmux sessions,
but you can also start one manually with `/agent-team:worker`.

### Worker completion contract

The dispatcher reaps worker sessions by scanning the tmux pane for one of three
machine-readable lines the worker prints as its final output:

```
AGENT_TEAM_WORKER_DONE <task-filename>
AGENT_TEAM_WORKER_NO_TASKS
AGENT_TEAM_WORKER_NO_CONFIG
```

This is the public coupling between `worker.md` and `dispatch-workers.sh`, and
it's the dispatcher's primary reap signal. A spinner-line heuristic (detecting
Claude's past-tense idle indicator) is a best-effort fallback for crashed or
stuck sessions — it is explicitly fragile and breaks when Claude Code's UI
strings change. Run `/agent-team:doctor` if reaping misbehaves.

---

## reviewer

Walks `done/`, verifies every task's acceptance criteria against the PR diff,
runs a headless Playwright browser check for `type: ui` tasks, and either
approves + auto-merges or rejects back to `todo/` with a reason.

**Auto-merge** applies only to PRs that:

- target the configured `prBase` branch, and
- have not opted out via `auto_merge: false` in the task frontmatter.

After a successful auto-merge the reviewer also removes the worker's local
worktree under `.worktrees/` and its local branch. Rejected and manually-merged
tasks keep theirs. Rejection uses `gh pr comment` rather than
`gh pr review --request-changes`, which fails on self-authored PRs.

The reviewer can run standalone or be scheduled with
`/loop 5m /agent-team:reviewer` for a continuous review cycle. An empty `done/`
produces a silent exit, so loop ticks stay noise-free.
