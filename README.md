# agent-team

agent-team turns one repo into a multi-session Claude Code agent team. A
team-leader session writes tasks into a filesystem queue; tmux worker sessions
claim and implement them in isolated git worktrees and open PRs; a review cycle
verifies acceptance criteria and auto-merges passing work. Board sync with
Trello is optional. The dispatch loop is event-driven (inotify on Linux,
FSEvents on macOS) — the leader wakes exactly when a task arrives or a worker
finishes, not on a polling interval.

## Queue layout

```
.tasks/
  todo/      <- available tasks
  doing/     <- claimed by a worker session
  done/      <- completed, awaiting review
  approved/  <- reviewed and approved
  backlog/   <- blocked tasks
```

Task files are Markdown with YAML frontmatter. The queue is gitignored and
shared across all parallel sessions via symlinks created by `gwt.sh`.

## Requirements

- Linux or macOS
- Node >= 20
- `git`, `tmux`, `gh` (authenticated with `gh auth login`), `claude` (Claude Code)

### Windows

Native Windows is not supported in v1. Use WSL2 — everything works inside a
WSL distro once the above dependencies are installed there.

## Install

```
/plugin marketplace add natanloterio/agent-team
/plugin install agent-team@agent-team
/agent-team:setup
```

`/agent-team:setup` walks you through a dependency preflight (it reports what
is missing and shows the exact install command — you run it; setup never
installs anything itself), writes `.agent-team/config.json`, creates the queue
skeleton, and optionally connects a Trello board.

## Roles

### `/agent-team:team-leader`

The coordinator. It receives goals from the developer, breaks them into task
files in `todo/`, dispatches worker sessions, and reviews completed work.

Dispatch is event-driven: after the first one-shot dispatch at bootstrap, the
leader arms `scripts/await-task-event.mjs` as a background process. The
watcher uses `fs.watch` (inotify/FSEvents) and exits as soon as a `*.md` file
appears in `todo/` or `done/`, printing one of three lines: `EVENT todo
<file>`, `EVENT done <file>`, or `TIMEOUT` (30-minute fallback to recover
missed events and reap stale workers). On every wake the leader re-arms the
watcher first (closing the race window), then runs `dispatch-workers.sh`; if
the wake was `EVENT done`, it runs a full review pass automatically without
prompting the developer.

The leader also starts the leader-events daemon (receives Stop/Notification
events from worker sessions via a Unix socket) and the Trello sync daemon when
`board.provider` is `"trello"`.

Attach to a worker session to watch it: `tmux attach -t <session-name>`.

### `/agent-team:worker`

A self-contained implementation session. On startup a worker:

1. Loads config and fails fast (`AGENT_TEAM_WORKER_NO_CONFIG`) if
   `.agent-team/config.json` is absent.
2. Claims the first available task atomically via `mv todo/ -> doing/`; exits
   with `AGENT_TEAM_WORKER_NO_TASKS` if the queue is empty.
3. Creates an isolated git worktree under `.worktrees/` using `gwt.sh`.
4. Adopts the task's `role` field as its persona and implements the task
   following TDD.
5. Opens a PR against the configured `prBase` branch, records the URL in the
   task file, and moves the file to `done/`.
6. Prints `AGENT_TEAM_WORKER_DONE <task-filename>` as its final line.

Workers are spawned by `dispatch-workers.sh` as detached tmux sessions. They
can also be started manually with `/agent-team:worker`.

### `/agent-team:reviewer`

Walks `done/`, verifies every task's acceptance criteria against the PR diff,
runs a headless Playwright browser check for `type: ui` tasks, and either
approves + auto-merges or rejects back to `todo/` with a reason.

Auto-merge applies only to PRs targeting the configured `prBase` branch and
not opted out via `auto_merge: false` in the task frontmatter. Rejection uses
`gh pr comment` (not `gh pr review --request-changes`, which fails on
self-authored PRs).

The reviewer can run standalone or be scheduled with
`/loop 5m /agent-team:reviewer` for a continuous review cycle. An empty
`done/` produces a silent exit so loop ticks are noise-free.

## Configuration reference

`.agent-team/config.json` is committed to the consumer repo. It never holds
secrets — credentials live in a gitignored file referenced by `board.envFile`.

| Field | Type | Default | Description |
|---|---|---|---|
| `prBase` | string | `"main"` | Base branch for worker PRs and reviewer auto-merge gating |
| `maxWorkers` | integer | `4` | Maximum concurrent tmux worker sessions |
| `tasksDir` | string | `".tasks"` | Repo-relative path to the task queue directory |
| `workerSessionPrefix` | string | `"agent-worker-"` | Prefix for tmux session names |
| `staleWorkerSeconds` | integer | `7200` | Age (seconds) after which a worker is force-reaped regardless of output |
| `devServer` | object\|null | `null` | `{ "command": "<start cmd>", "url": "http://localhost:8080" }` — required for UI task review checks |
| `worktree.linkEnvFiles` | boolean | `true` | Whether `gwt.sh` symlinks `.env*` files into each new worktree |
| `board.provider` | string | `"none"` | `"none"` or `"trello"` |
| `board.boardId` | string | — | Resolved Trello board ID (required when provider is `"trello"`) |
| `board.listIds.todo` | string | — | Resolved Trello list ID for the `todo/` folder |
| `board.listIds.doing` | string | — | Resolved Trello list ID for the `doing/` folder |
| `board.listIds.done` | string | — | Resolved list ID for `done/` (may share an ID with another key) |
| `board.listIds.approved` | string | — | Resolved list ID for `approved/` |
| `board.envFile` | string | — | Gitignored file holding `TRELLO_API_KEY` / `TRELLO_SECRET` |

List IDs are stored resolved (numeric Trello IDs, not names), eliminating the
empty-ID-from-name-lookup bug class at runtime. Keys may intentionally share
IDs — for example, mapping `done` and `doing` to the same Trello column while
tasks are in review.

## Worker completion contract

The dispatcher reaps worker sessions by scanning the tmux pane for one of three
machine-readable lines the worker skill prints as its final output:

```
AGENT_TEAM_WORKER_DONE <task-filename>
AGENT_TEAM_WORKER_NO_TASKS
AGENT_TEAM_WORKER_NO_CONFIG
```

This is the public coupling between `worker.md` and `dispatch-workers.sh`. The
dispatcher treats these as the primary reap signal. A spinner-line heuristic
(detecting Claude's past-tense idle indicator) is a best-effort fallback for
crashed or stuck sessions; it is explicitly fragile and breaks when Claude
Code's UI strings change. Run `/agent-team:doctor` if reaping misbehaves.

## Security model

Workers are spawned as `claude --dangerously-skip-permissions` in detached
tmux sessions. This is required for unattended operation: without it, every
file write, shell command, and tool call would pause and wait for a human to
approve it in the tmux pane — defeating the purpose of async workers.

Implications you should understand before running agent-team:

- **Workers can run any command in the repo without prompting.** A malicious
  or buggy task file could delete files, exfiltrate data, or make network
  requests.
- **Workers can read your env secrets.** When `worktree.linkEnvFiles` is
  `true` (the default), `gwt.sh` symlinks every `.env*` file from the main
  repo into each worktree so dev servers can start. This means any worker has
  access to those files.

Recommended mitigations:

- Run agent-team on a **dedicated machine or container** that does not hold
  production secrets, when the task source is untrusted (e.g. Trello cards
  written by external contributors).
- Set `worktree.linkEnvFiles: false` in `.agent-team/config.json` when
  workers do not need env files (e.g. backend tasks that do not start a dev
  server). Workers will still work; UI review checks that need a running dev
  server will fail until you re-enable it.
- **Review the task files** before dispatching workers on sensitive repos,
  just as you would review a PR from an unknown contributor.
- Review `scripts/dispatch-workers.sh` and `scripts/gwt.sh` before first
  run to understand exactly what each worker session can access.

## Troubleshooting

Run `/agent-team:doctor` first — it checks config validity, daemon liveness
(PID files + socket presence), `gh auth status`, tmux reachability, and
platform assumptions (locking mechanism, `fs.watch` delivery).

Common issues:

- **`gh auth status` fails** — run `gh auth login` and restart the leader session.
- **Dispatch lock left behind** — a stale lock (holder PID no longer alive) is
  reclaimed automatically on the next dispatch run. If it persists, remove
  `<tasksDir>/.dispatch.lock.d/` manually.
- **Daemon log locations** — leader-events: `<tasksDir>/.leader-events.log`;
  Trello sync: `<tasksDir>/.trello-sync.log`. Both are gitignored.

## License

MIT
