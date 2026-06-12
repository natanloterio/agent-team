# Reviewer branch cleanup — design

Date: 2026-06-12
Status: approved

## Problem

The reviewer merges PRs with `gh pr merge --auto --merge --delete-branch`,
which deletes the **remote** branch only. The worker's local worktree under
`.worktrees/` and its local branch are never removed — every approved task
leaks one worktree and one branch, accumulating forever.

## Decision

Add a **Step F — Branch cleanup** to `commands/reviewer.md`, executed only on
the **Pass path when auto-merge was enabled** (the same condition that runs
`gh pr merge`).

The step is an adapted reimplementation of the
`superpowers:finishing-a-development-branch` skill, embedded directly in the
reviewer skill (no dependency on other plugins), with the deliberate
divergences listed at the end of this document — the same pattern used for
Brainstorm Mode.

## Behavior

Step F runs after Step E's Pass branch, per task:

1. Resolve the worker's worktree by branch: parse
   `git worktree list --porcelain` for the entry whose branch is
   `refs/heads/<worktree_branch>`. Never match by name substring — slugs can
   be substrings of one another, and a fuzzy match could force-delete
   another task's in-progress worktree. Step F must still run **after**
   Step D, which needs the worktree alive.
2. Read `worktree_branch` from the task frontmatter.
3. Clean up from the main repo:
   - `git -C "$AGENT_TEAM_ROOT" worktree remove --force "<worktree-path>"`
   - `git -C "$AGENT_TEAM_ROOT" branch -D "<worktree_branch>"`
   - `git -C "$AGENT_TEAM_ROOT" worktree prune`
4. Any cleanup failure is a WARNING in the final summary — it never fails
   the review or blocks the task's move to `approved/`. The merge is already
   guaranteed at this point.

### Why `--force` and `-D` are safe

The worker's work is on the remote: the PR is approved and auto-merge is
armed before Step F runs. The worktree is a disposable checkout; the local
branch never holds anything the remote branch does not. `--force` tolerates
stray untracked files workers leave behind; `-D` tolerates the local base
branch being behind the remote (the local branch is "unmerged" only from the
stale local perspective).

### When cleanup does NOT run

- **Rejections** — the task returns to `todo/`; the next worker may reuse or
  recreate the worktree.
- **`auto_merge: false`** — approved but human merges manually; the human
  may still want the worktree (e.g. to re-run checks).
- **PRs targeting a non-base branch** — approved but flagged for human;
  same reasoning.
- Missing worktree or empty `worktree_branch` — skip silently with a note;
  nothing to clean.

## Reporting

The Step 3 final summary gains a cleanup note per approved task:

```
✅ Approved: <count>
  - <title> — <pr_url> — auto-merge: <...> — cleanup: <done|skipped|WARNING: reason>
```

## Divergences from `superpowers:finishing-a-development-branch`

Deliberate adaptations to the autonomous reviewer context; the cleanup
mechanics are reimplemented as-is:

| Upstream skill | Reviewer Step F |
|---|---|
| Presents 4 interactive options (merge/PR/keep/discard) | No options — the review verdict IS the choice; Pass+auto-merge ≙ upstream Option 1 |
| Verifies tests before offering options | CI gate in Steps B/E fulfills this role (`CI_OK` must be OK before approval) |
| Merges locally (`git merge`) | Merge happens on the remote via `gh pr merge --auto`; only the cleanup half of Option 1 is reimplemented |
| Typed "discard" confirmation for destructive ops | Not applicable — nothing unmerged is deleted; the remote holds everything |
| Worktree kept for Options 2/3 | Worktree kept for the analogous cases: rejection, `auto_merge: false`, non-base PRs |

## Out of scope

- Cleanup in team-leader.md's Review Mode (the reviewer skill is the
  long-running review surface; the leader's inline review predates it and is
  not extended here).
- Cleaning worktrees of rejected tasks.
- Pruning orphaned worktrees from crashed workers (doctor territory).

## Documentation and tests

- README: extend the `/agent-team:reviewer` section with one sentence on
  post-merge cleanup.
- No executable code changes; existing suite runs as regression guard.
