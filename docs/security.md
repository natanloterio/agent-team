# Security model

> **Read this before running agent-team on a repo that holds real secrets or
> accepts tasks from people you don't trust.**

Workers run as `claude --dangerously-skip-permissions` in detached tmux
sessions. This is required for unattended operation: without it, every file
write, shell command, and tool call would pause and wait for a human to approve
it in the tmux pane — defeating the purpose of async workers.

## What this means

- **Workers can run any command in the repo without prompting.** A malicious or
  buggy task file could delete files, exfiltrate data, or make network requests.
- **Workers can read your env secrets.** When `worktree.linkEnvFiles` is `true`
  (the default), `gwt.sh` symlinks every `.env*` file from the main repo into
  each worktree so dev servers can start. Any worker therefore has access to
  those files.

## Recommended mitigations

- **Isolate the host.** Run agent-team on a dedicated machine or container that
  does not hold production secrets — especially when the task source is
  untrusted (e.g. Trello cards written by external contributors).
- **Don't link env files when workers don't need them.** Set
  `worktree.linkEnvFiles: false` in `.agent-team/config.json` for backend tasks
  that never start a dev server. Workers still run fine; only UI review checks
  that need a running dev server will fail until you re-enable it.
- **Review task files before dispatching** on sensitive repos, just as you'd
  review a PR from an unknown contributor.
- **Read the scripts.** Review `scripts/dispatch-workers.sh` and
  `scripts/gwt.sh` before your first run to understand exactly what each worker
  session can access.
