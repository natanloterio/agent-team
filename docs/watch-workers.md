# Watching the team

When several workers run in parallel, attaching to them one at a time
(`tmux attach -t agent-worker-3`) gets tedious. The `watch-workers.sh` script
opens a single **live dashboard** that tiles every running worker into one tmux
window.

```
bash scripts/watch-workers.sh
```

One pane per `agent-worker-*` session, each mirroring that worker's output, with
the worker's name on the pane border. Detach with `Ctrl-b d` — the workers (and
the dashboard) keep running. Re-run the command to re-attach.

## What it is — and isn't

- **Read-only.** Each pane renders a worker by polling `tmux capture-pane`; the
  dashboard never attaches a client to a worker session. It therefore cannot
  resize a worker or send it keystrokes, and watching never disturbs the work.
  To actually drive a worker, attach to it directly: `tmux attach -t agent-worker-N`.
- **Dynamic.** A background controller window tiles in a new pane whenever a new
  worker appears, so the view grows with the team. A worker that finishes is
  marked `(ended)` in place; run `--rebuild` to drop ended panes and re-tile to
  exactly the current set.

## Options

| Invocation | Effect |
|---|---|
| `watch-workers.sh` | Build the dashboard (or attach if it already exists). |
| `watch-workers.sh --here` | Embed the dashboard in the **current** tmux window, beside the pane you ran it from (see below). |
| `watch-workers.sh --interval 1` | Refresh each pane every 1s (default: 2). |
| `watch-workers.sh --rebuild` | Force a fresh re-tile to the current worker set. |
| `watch-workers.sh --no-auto` | Don't auto-tile new workers as they appear. |
| `watch-workers.sh --once` | Print a one-shot text snapshot of every worker and exit (no tmux session — handy for the leader or CI). |
| `watch-workers.sh --help` | Show usage. |

## Embedding it beside the team-leader (`--here`)

The default mode lives in its own session, so running it from inside tmux
switches your client over to it — you lose sight of whatever you were doing.
`--here` is for the common setup where you want a **team-leader pane on one side
and the workers tiling in beside it, in the same window**:

```
┌──────────────────────┬───────────────────────────┐
│                      │ agent-team · dashboard …  │  ← control strip
│   team-leader        ├─────────────┬─────────────┤
│   (Claude Code)      │ agent-worker-1            │
│                      ├─────────────┤ agent-...-2 │  ← worker mirrors
│                      │ agent-worker-3            │
└──────────────────────┴─────────────┴─────────────┘
```

1. In your window, keep the team-leader Claude Code session in one pane.
2. Split a second pane beside it (`Ctrl-b %`) and run there:

   ```
   bash scripts/watch-workers.sh --here
   ```

The pane you launch it from becomes a thin **control strip** (it shows how many
workers are being watched and the keys to close/detach), and the worker mirrors
tile into the rest of that pane's region. The team-leader pane is never resized
or touched — only the launching pane's region is subdivided, and the tiling
grows as new workers appear (unless you pass `--no-auto`).

- **Ctrl-C** (in the control strip) closes the embedded dashboard: the mirror
  panes are removed and the region collapses back, while the workers themselves
  keep running.
- **Ctrl-b d** detaches the whole client as usual; everything keeps running.

`--here` must be run from inside a tmux pane (it has nothing to embed into
otherwise). Without it, the script keeps its original behavior — a standalone
dashboard session described below.

## The dashboard session

The dashboard lives in its own tmux session, separate from the workers:

- Default name: `agent-team-monitor` (override with the
  `AGENT_TEAM_MONITOR_SESSION` environment variable).
- It has two windows: `agents` (the tiled worker view) and `_control` (the
  background controller that adds panes for new workers).
- Killing it (`tmux kill-session -t agent-team-monitor`) affects nothing else —
  the workers keep running.

The worker session prefix it watches (`agent-worker-` by default) comes from
your `.agent-team/config.json`, so the script needs a configured repo. Run
`/agent-team:setup` first if it reports "not configured."
