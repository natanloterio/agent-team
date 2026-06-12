# Reviewer Branch Cleanup Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** After a successful auto-merge, the reviewer removes the worker's local worktree and branch, so approved tasks stop leaking checkouts.

**Architecture:** Markdown protocol change only. A new `### Step F — Branch cleanup` goes into `commands/reviewer.md` inside the Pass path documentation (after Step E), the Step 3 summary line gains a cleanup field, and the Rules list gains one bullet. README gets one sentence. Spec source of truth: `docs/specs/2026-06-12-reviewer-branch-cleanup-design.md`.

**Tech Stack:** Markdown skill protocols with embedded bash. No executable code changes; existing suite (`node --test tests/*.test.mjs`, `bash tests/dispatch-workers.test.sh`) runs once as regression guard.

---

### Task 1: Add Step F and supporting edits to reviewer.md

**Files:**
- Modify: `commands/reviewer.md` (three edits: insert Step F after the Step E Fail block; update Step 3 summary template; add one Rules bullet)

- [ ] **Step 1: Extract `worktree_branch` in Step A**

In `### Step A — Read the task and extract frontmatter`, after the line:

```bash
AUTO_MERGE=$(grep "^auto_merge:" "$AGENT_TEAM_TASKS_DIR/done/$TASK_FILE" | sed 's/^auto_merge: *//')
```

add:

```bash
WORKTREE_BRANCH=$(grep "^worktree_branch:" "$AGENT_TEAM_TASKS_DIR/done/$TASK_FILE" | sed 's/^worktree_branch: *//')
```

- [ ] **Step 2: Record whether auto-merge was enabled in Step E**

In the Step E Pass block, change:

```bash
if [ "$BASE_REF" = "$AGENT_TEAM_PR_BASE" ] && [ "$AUTO_MERGE" != "false" ]; then
  gh pr merge "$PR_URL" --auto --merge --delete-branch \
    && echo "Auto-merge enabled for $PR_URL" \
    || echo "WARNING: auto-merge failed for $PR_URL — needs manual merge"
```

to:

```bash
MERGE_ENABLED="no"
if [ "$BASE_REF" = "$AGENT_TEAM_PR_BASE" ] && [ "$AUTO_MERGE" != "false" ]; then
  if gh pr merge "$PR_URL" --auto --merge --delete-branch; then
    MERGE_ENABLED="yes"
    echo "Auto-merge enabled for $PR_URL"
  else
    echo "WARNING: auto-merge failed for $PR_URL — needs manual merge"
  fi
```

(The `elif`/`else` branches and the task-file `mv` stay unchanged.)

- [ ] **Step 3: Insert Step F after the Step E Fail block**

Insert the following immediately before `## Step 3 — Final summary`:

````markdown
### Step F — Branch cleanup (Pass path with auto-merge only)

Run only when the verdict was Pass **and** `MERGE_ENABLED=yes`. The worker's
work is on the remote (PR approved, auto-merge armed), so the local worktree
and branch are disposable. Never run this for rejections, `auto_merge: false`
tasks, or PRs targeting a non-base branch — those keep their worktrees.

```bash
CLEANUP_RESULT="skipped"
if [ "$MERGE_ENABLED" = "yes" ]; then
  CLEANUP_WORKTREE=$(ls -d "${AGENT_TEAM_ROOT}/.worktrees/"*"${SLUG}"* 2>/dev/null | head -1)
  if [ -z "$CLEANUP_WORKTREE" ] && [ -z "$WORKTREE_BRANCH" ]; then
    CLEANUP_RESULT="skipped: no worktree or branch recorded"
  else
    CLEANUP_RESULT="done"
    if [ -n "$CLEANUP_WORKTREE" ]; then
      git -C "$AGENT_TEAM_ROOT" worktree remove --force "$CLEANUP_WORKTREE" \
        || CLEANUP_RESULT="WARNING: worktree remove failed for $CLEANUP_WORKTREE"
    fi
    if [ -n "$WORKTREE_BRANCH" ]; then
      git -C "$AGENT_TEAM_ROOT" branch -D "$WORKTREE_BRANCH" 2>/dev/null \
        || true   # branch may not exist locally — not a warning
    fi
    git -C "$AGENT_TEAM_ROOT" worktree prune
  fi
fi
echo "Cleanup: $CLEANUP_RESULT"
```

`--force` and `-D` are safe here: the remote branch holds everything; the
worktree is a disposable checkout and stray untracked files in it are
expected. A cleanup failure is a WARNING in the summary — it never fails the
review or blocks the task's move to `approved/`.
````

NOTE: the block above is fenced for transport; insert its content as plain markdown (the inner ```bash fence IS part of the content).

- [ ] **Step 4: Add the cleanup field to the Step 3 summary template**

In `## Step 3 — Final summary`, change:

```
    - <title> — <pr_url> — auto-merge: <enabled|skipped: targets non-base branch|failed>
```

to:

```
    - <title> — <pr_url> — auto-merge: <enabled|skipped: targets non-base branch|failed> — cleanup: <done|skipped|WARNING: reason>
```

- [ ] **Step 5: Add the Rules bullet**

In `## Rules`, immediately after the bullet `- Read-only on the PR — never push commits, never modify worker code`, add:

```markdown
- Local cleanup only on the Pass+auto-merge path: remove the worker's worktree and local branch (Step F); rejections, `auto_merge: false`, and non-base PRs keep their worktrees
```

- [ ] **Step 6: Verify**

```bash
grep -n "Step F" commands/reviewer.md
```
Expected: the Step F heading between the Step E Fail block and `## Step 3`.

```bash
grep -n "MERGE_ENABLED" commands/reviewer.md
```
Expected: at least three hits (Step E set, Step F guard).

```bash
grep -c "cleanup:" commands/reviewer.md
```
Expected: ≥ 1 (summary template).

- [ ] **Step 7: Commit**

```bash
git add commands/reviewer.md
git commit -m "feat: reviewer cleans up worker worktree and branch after auto-merge"
```

---

### Task 2: Document cleanup in the README

**Files:**
- Modify: `README.md` (the `### /agent-team:reviewer` section)

- [ ] **Step 1: Extend the auto-merge paragraph**

In the `### /agent-team:reviewer` section, change:

```markdown
Auto-merge applies only to PRs targeting the configured `prBase` branch and
not opted out via `auto_merge: false` in the task frontmatter. Rejection uses
`gh pr comment` (not `gh pr review --request-changes`, which fails on
self-authored PRs).
```

to:

```markdown
Auto-merge applies only to PRs targeting the configured `prBase` branch and
not opted out via `auto_merge: false` in the task frontmatter. After a
successful auto-merge the reviewer also removes the worker's local worktree
under `.worktrees/` and its local branch — rejected and manually-merged
tasks keep theirs. Rejection uses `gh pr comment` (not
`gh pr review --request-changes`, which fails on self-authored PRs).
```

- [ ] **Step 2: Verify**

```bash
grep -n "removes the worker's local worktree" README.md
```
Expected: one hit in the reviewer section.

- [ ] **Step 3: Commit**

```bash
git add README.md
git commit -m "docs: document reviewer post-merge worktree cleanup"
```

---

### Task 3: Regression check

**Files:** none modified.

- [ ] **Step 1: Run the suite**

```bash
node --test tests/*.test.mjs && bash tests/dispatch-workers.test.sh
```
Expected: 12/12 Node tests pass; smoke test prints `ALL DISPATCH SMOKE TESTS PASSED`. (shellcheck runs in CI; no shell files are touched.)

- [ ] **Step 2: Spec coverage check**

- Step F behavior + guards → Task 1 Steps 2–3
- `worktree_branch` extraction → Task 1 Step 1
- Summary reporting → Task 1 Step 4
- Rules → Task 1 Step 5
- README → Task 2
- Divergences/Out-of-scope → nothing to implement (documentation-of-intent only)
