# `agent-team` Claude Code Plugin — v1 Design

**Date:** 2026-06-12
**Status:** Approved design, pending implementation plan
**Note:** This spec is born in the Pitaia repo but migrates to the new
`natanloterio/agent-team` repo (as `docs/specs/`) once it exists. It absorbs
and supersedes `2026-06-12-event-driven-dispatch-design.md`, whose content
now ships inside the plugin instead of directly in Pitaia.

## Goal

Open-source Pitaia's agent task-queue system (team-leader / worker / reviewer
skills + `.tasks/` filesystem queue + dispatch/daemon scripts) as an
installable Claude Code plugin so any project can run a multi-session agent
team. Pitaia becomes the first consumer, which also eliminates the current
3-copy skill drift problem.

## Decisions log (settled with Natan)

1. Distribution: Claude Code **plugin** in a new public repo `natanloterio/agent-team` (MIT).
2. Name: `agent-team` — skills namespaced `/agent-team:<skill>`.
3. v1 scope: core only — `setup`, `doctor`, `team-leader`, `worker`, `reviewer`. Night-shift stays in Pitaia (v2 candidate).
4. The event-driven dispatch design is implemented **directly in the plugin** (not in Pitaia first).
5. Trello is **optional** (`board.provider: "none" | "trello"`); a guided setup flow helps users configure their own Trello.
6. Platform: v1 is Unix native (Linux/macOS); Windows users go through WSL2. No native Windows code paths.
7. Dependency handling: **instructions only** — the plugin never executes installs. Setup shows the exact command for the detected package manager; the user runs it; setup re-verifies before moving on.
8. Node scripts use stdlib only — no `npm install` at plugin install time; any future lib is vendored.

## Repo layout

```
agent-team/
├── .claude-plugin/
│   ├── plugin.json          # plugin manifest (name, version, description)
│   └── marketplace.json     # repo doubles as its own marketplace
├── commands/
│   ├── setup.md             # guided onboarding wizard
│   ├── doctor.md            # dependency/config/daemon health check
│   ├── team-leader.md
│   ├── worker.md
│   └── reviewer.md
├── hooks/
│   ├── hooks.json           # plugin hook registration
│   ├── session-start.sh     # unconfigured-project nudge → /agent-team:setup
│   └── notify-leader.sh     # CC hook events → leader-events socket (fail-soft, 1s timeout)
├── scripts/
│   ├── lib/config.mjs       # loads .agent-team/config.json, applies defaults, validates
│   ├── dispatch-workers.sh  # reap + spawn tmux workers (reads config; portable lock — see below)
│   ├── await-task-event.mjs # one-shot fs.watch watcher (see Event-driven dispatch)
│   ├── leader-events.mjs
│   ├── leader-events-stop.mjs
│   ├── trello-sync.mjs
│   ├── trello-sync-stop.mjs
│   └── gwt.sh               # worktree helper (replaces the ~/.zshrc alias)
├── .github/workflows/ci.yml # smoke tests, matrix: ubuntu-latest + macos-latest; shellcheck
├── docs/specs/              # this spec + the dispatch spec move here
├── LICENSE                  # MIT
└── README.md                # quickstart, WSL note for Windows, architecture overview
```

User installation: `/plugin marketplace add natanloterio/agent-team` →
`/plugin install agent-team`. Skills resolve scripts via
`${CLAUDE_PLUGIN_ROOT}/scripts/...` — nothing is copied into the consumer
repo except the config file and the gitignored runtime dirs.

Manifest/hook schema details (exact `plugin.json` and `hooks.json` fields)
are verified against current Claude Code plugin docs at implementation time,
not assumed from memory.

## Consumer configuration

`.agent-team/config.json` in the consumer repo — committable, **never holds
secrets** (credentials live in a gitignored env file referenced by path):

```json
{
  "prBase": "dev",
  "maxWorkers": 8,
  "tasksDir": ".tasks",
  "workerSessionPrefix": "agent-worker-",
  "staleWorkerSeconds": 7200,
  "devServer": { "command": "<cmd>", "url": "http://localhost:8080" },
  "worktree": { "linkEnvFiles": true },
  "board": { "provider": "none" }
}
```

`worktree.linkEnvFiles` controls whether `gwt.sh` symlinks `.env*` files into
new worktrees (today's Pitaia behavior). Setup asks explicitly — some
consumers won't want secrets linked into every worktree.

Trello variant:

```json
"board": {
  "provider": "trello",
  "boardId": "<resolved id>",
  "listIds": { "todo": "...", "doing": "...", "done": "...", "approved": "..." },
  "envFile": ".env.agents"
}
```

Rules:

- `lib/config.mjs` is the single reader: applies defaults for every missing
  field, fails fast with a clear message on malformed JSON or invalid values
  (e.g. `maxWorkers < 1`), and is consumed by all `.mjs` scripts.
  `dispatch-workers.sh` gets its values via a small
  `node lib/config.mjs --print-env`-style helper so bash and Node never
  parse the config independently.
- `provider: "none"` → trello-sync never starts; skills skip board sections.
- IDs are stored **resolved** (board + each list) — no name lookup at
  runtime (the empty-ID-from-name-lookup bug class is eliminated by
  construction).
- Skills read the config at session bootstrap and use its values in place of
  today's hardcoded ones (`--base dev`, `pitaia-worker-`, cap 8, dev server
  command/URL, `.env.agents`).
- **Missing config = fail fast.** If `.agent-team/config.json` does not
  exist, `team-leader`/`worker`/`reviewer` stop immediately with "not
  configured — run `/agent-team:setup`". Headless workers print the
  machine-readable no-config line (see worker contract) and exit, so a
  misconfigured consumer never burns a 90-minute confused session.

## Skills

### `/agent-team:setup` — guided onboarding

1. **Dependency preflight, one dependency at a time** — `tmux`, `gh`
   (binary AND `gh auth status`), `git`, `node`, `claude`. For each missing
   one: detect the package manager (apt/dnf/pacman/brew), print the exact
   install command **as an instruction**, wait for the user to run it
   (suggesting the `! <command>` prompt prefix), re-verify, only then move
   on.
2. **Project config** — ask package manager / dev server command + URL / PR
   base branch / worker cap; write `.agent-team/config.json`.
3. **Hygiene checks** — ensure `tasksDir` and the board env file are
   gitignored (offer to append); create the `tasksDir` skeleton
   (`todo/ doing/ done/ approved/ backlog/`).
4. **Optional Trello** — if the user opts in: point to `trello.com/app-key`,
   explain API key vs token authorization, accept credentials, then either
   create a board + the four lists via API or let the user pick existing
   ones; persist **resolved IDs** in the config and credentials in the env
   file; finish with a smoke test (create card → move → delete) and report
   "Trello connected".

### `/agent-team:doctor`

The setup preflight re-packaged as a standalone check, plus runtime state:
config file valid, daemons running (PID files + liveness), socket present,
`gh auth status`, tmux reachable, and platform checks (locking mechanism
works, `fs.watch` delivers events on the host filesystem). Every runtime
error message in scripts and skills points here.

### `/agent-team:team-leader`

Today's team-leader generalized:

- Bootstrap: start leader-events daemon; start trello-sync **only if**
  `provider: "trello"`; run one dispatch; **arm the event watcher** (below).
- Dispatch Mode / Review Mode / Trello Sync Mode as today, with config
  values substituted and review's UI check using `devServer` from config.
- No `/loop` tick — replaced by event-driven dispatch.

### `/agent-team:worker` and `/agent-team:reviewer`

Generalized copies of today's skills: `gwt.sh` invoked from
`${CLAUDE_PLUGIN_ROOT}` (symlinks the configured `tasksDir` — not a
hardcoded `.tasks` — and `.env*` only when `worktree.linkEnvFiles` is true),
PRs opened against `prBase`, reviewer merge rules keyed on `prBase`.

**Worker completion contract.** The worker skill MUST end every session by
printing exactly one of these machine-readable lines as its final output:

```
AGENT_TEAM_WORKER_DONE <task-filename>
AGENT_TEAM_WORKER_NO_TASKS
AGENT_TEAM_WORKER_NO_CONFIG
```

This is the pinned contract between `worker.md` and the dispatcher's reaper
— today it is an implicit coupling to prose strings ("Task ... is done.").
`dispatch-workers.sh` reaps on these exact lines as the **primary** signal.
The spinner-line heuristic (detecting Claude's past-tense "✻ Worked for 9m"
idle state) remains as a **best-effort fallback** for crashed/stuck
sessions; it is explicitly documented as fragile (it breaks when Claude
Code's UI strings change) and `doctor` is the named diagnostic when reaping
misbehaves. Future improvement (out of v1 scope): use the leader-events
daemon's Stop events as the idle signal, which requires a worktree→tmux
session mapping that doesn't exist today.

## Plugin hooks

- `notify-leader.sh` — as today: posts hook payloads (Stop, SubagentStop,
  Notification, SessionStart, SessionEnd) to the leader-events socket,
  fail-soft with a 1s timeout.
- `session-start.sh` — the "/agent-team:setup nudge" must NOT fire in every
  repo the user opens (plugin hooks run wherever the plugin is enabled, and
  almost every repo lacks `.agent-team/config.json`). It stays **silent by
  default** and nudges only on a positive signal: the repo contains an
  `.agent-team/` directory or a `<tasksDir>` queue skeleton but the config
  file is missing or invalid. Plain repos with no agent-team footprint get
  no output; discoverability is the README/marketplace description's job.

## Dispatcher locking (portability)

`flock(1)` is a util-linux binary and does not exist on macOS, so today's
`exec 200>$LOCK; flock -n 200` pattern would break every Mac consumer.
`dispatch-workers.sh` v1 uses a **portable `mkdir`-based lock** instead
(atomic on POSIX): `mkdir <tasksDir>/.dispatch.lock.d` to acquire, with the
holder's PID written inside; a stale lock (PID no longer alive) is reclaimed;
`rmdir`/cleanup on exit via trap. `doctor` includes a platform check that
validates the locking mechanism (and other platform assumptions like
`fs.watch` availability) on the host.

## Event-driven dispatch (absorbed spec)

Replaces the `/loop 1m` tick. Full rationale and race analysis live in
`2026-06-12-event-driven-dispatch-design.md`; summary of what ships:

- `scripts/await-task-event.mjs`: one-shot watcher, `fs.watch` (inotify on
  Linux, FSEvents on macOS) on `<tasksDir>/todo/` and `<tasksDir>/done/`;
  exits printing `EVENT todo <file>` / `EVENT done <file>` on the first
  relevant `*.md` creation/move-in, or `TIMEOUT` after 30 min
  (argv-overridable). Anchors on the main worktree root like
  `leader-events.mjs`; exit code 0 in all cases.
- **Event-distinction mechanism** (does not fall out of the API): `fs.watch`
  reports creation AND deletion as the same `'rename'` event type, so
  "removals are ignored" — the property that keeps `todo/ → doing/` claims
  from waking the leader — is implemented by `existsSync`-ing the reported
  filename on every event and only firing when the file is present. On
  macOS the `filename` argument can be `null`; in that case the watcher
  falls back to diffing the directory listing against a snapshot taken at
  arm time. The "ignores removals" smoke test asserts this mechanism.
- Team-leader protocol: arm via Bash `run_in_background` → on wake
  **re-arm first**, then run `dispatch-workers.sh`; if the event was
  `done` → run Review Mode automatically; if `TIMEOUT` → dispatch only,
  report nothing unless it reaped/spawned.
- `done/` events double as "a worker slot freed" signal, so queued todos
  beyond the cap get dispatched without polling.

## Pitaia migration (first consumer)

One PR in `pitaia.me` (after the plugin repo is functional):

1. Add `.agent-team/config.json` with current values (`prBase: "dev"`, cap
   8, pnpm dev server, Trello provider with the cached board/list IDs,
   `envFile: ".env.agents"`).
2. Remove `.claude/commands/{team-leader,worker,reviewer}.md` and the moved
   scripts (`dispatch-workers.sh`, `leader-events*.mjs`, `trello-sync*.mjs`);
   update `package.json` script entries accordingly.
3. Re-point `.claude/settings.json` hooks to the plugin's `notify-leader.sh`
   (or drop them if the plugin's own hook registration covers it).
4. Adapt night-shift (stays in Pitaia) to invoke `/agent-team:worker` and
   the plugin's script paths, and make it read the Trello board/list IDs
   from `.agent-team/config.json` instead of the constant hardcoded in
   `scripts/night-shift/night-report.mjs`.
5. Update `CLAUDE.md` (Agent Task Queue section) to reference the plugin.
6. Manually delete the stale copies in `~/.claude/skills/` and
   `~/.claude/commands/` (outside git; checklist item in the PR
   description).
7. Remove the `gwt` function from `~/.zshrc` (or make it a thin delegate to
   `${CLAUDE_PLUGIN_ROOT}/scripts/gwt.sh`) — same drift class as the
   3-copy skill problem; leaving two implementations alive defeats the
   point.

Worker spawn line changes from `/worker` to `/agent-team:worker` in
`dispatch-workers.sh`.

## Testing & CI

- Node smoke tests (plain `node --test`, no npm deps):
  - `await-task-event.mjs`: todo event, done event, ignores non-`.md`,
    ignores removals (asserting the existsSync-on-rename mechanism), short
    timeout path.
  - `lib/config.mjs`: defaults applied, malformed JSON fails with clear
    message, invalid values rejected.
- `dispatch-workers.sh` smoke test that **executes the script** on both CI
  OSes (tmux installed via the runner's package manager): empty-queue path
  runs cleanly, a concurrent second invocation is skipped by the mkdir
  lock, and a stale lock (dead PID) is reclaimed. This is what catches
  macOS-only breakage like the flock issue — shellcheck and the Node tests
  cannot.
- `shellcheck` on all `.sh`.
- CI matrix: `ubuntu-latest` + `macos-latest`. No Windows runner (WSL is
  documented, not CI-tested, in v1).
- End-to-end validation = the Pitaia migration PR running the real system.

## Non-goals (v1)

- Night-shift skill (stays Pitaia-local; v2 candidate).
- Native Windows support (WSL2 documented in README).
- Board providers beyond Trello (`provider` field leaves the door open for
  GitHub Issues / Linear).
- Forges beyond GitHub (`gh` is assumed).
