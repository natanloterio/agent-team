# Configuration reference

`.agent-team/config.json` is committed to your repo and read by every role. It
**never holds secrets** — credentials live in a separate gitignored file that
`board.envFile` points to.

You normally don't write this file by hand. `/agent-team:setup` generates it for
you. Use this page when you want to understand or tweak a specific setting.

## Fields

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

## Trello list IDs

List IDs are stored **resolved** — the 24-character hex Trello IDs, not the
human-readable list names. This eliminates a class of runtime bugs where a name
lookup returned an empty ID.

Keys may intentionally share an ID. For example, you can map both `done` and
`doing` to the same Trello column while tasks are in review.
