# Troubleshooting

**Run `/agent-team:doctor` first.** It checks config validity, daemon liveness
(PID files + socket presence), `gh auth status`, tmux reachability, and platform
assumptions (locking mechanism, `fs.watch` delivery). Most problems show up here.

## Common issues

### `gh auth status` fails
Run `gh auth login`, then restart the leader session.

### Dispatch lock left behind
A stale lock (its holder PID is no longer alive) is reclaimed automatically on
the next dispatch run. If it persists, remove `<tasksDir>/.dispatch.lock.d/`
manually.

### Workers aren't being reaped
The dispatcher relies on the [worker completion
contract](roles.md#worker-completion-contract). If a worker crashes before
printing its final line, the fallback spinner-line heuristic may miss it. Run
`/agent-team:doctor` to inspect session state.

## Daemon logs

Both logs live under your tasks directory and are gitignored:

- **leader-events:** `<tasksDir>/.leader-events.log`
- **Trello sync:** `<tasksDir>/.trello-sync.log`
