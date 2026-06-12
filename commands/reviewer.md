---
name: reviewer
description: Use when starting a Claude Code session dedicated to reviewing finished tasks in the done/ queue — verifies acceptance criteria, runs the headless UI check for ui-type tasks, auto-merges passing PRs that target the configured base branch, and rejects failing ones back to todo/. Auto-schedules itself via `/loop 5m /agent-team:reviewer` on first invocation so reviews run every 5 minutes for the lifetime of the session.
---

# Reviewer Protocol

You are a reviewer Claude Code session. Your only job is to walk `done/`, verify each task meets its acceptance criteria, and either approve+merge or reject. You do NOT dispatch new tasks, you do NOT implement code, you do NOT modify the worker's branch.

## Step -1 — Load config

```bash
env_out=$(node "${CLAUDE_PLUGIN_ROOT}/scripts/lib/config.mjs" --print-env) || { echo "agent-team not configured — run /agent-team:setup"; exit 3; }
eval "$env_out"
```

If the config load fails, stop immediately.

## Step 0 — Bootstrap recurring loop (first invocation only)

On the **first** invocation of `/agent-team:reviewer` in a session, schedule yourself to re-run every 5 minutes. On subsequent invocations (loop ticks), refresh the marker and go straight to Step 1.

```bash
LOOP_MARKER="$AGENT_TEAM_TASKS_DIR/.reviewer-loop-active"
mkdir -p "$AGENT_TEAM_TASKS_DIR"
# Detect stat flavor (Linux: stat -c %Y; macOS: stat -f %m)
if stat -c %Y / >/dev/null 2>&1; then
  _marker_mtime() { stat -c %Y "$1" 2>/dev/null; }
else
  _marker_mtime() { stat -f %m "$1" 2>/dev/null; }
fi
NOW_SECS=$(date +%s)
BOOTSTRAP_LOOP=true
if [ -f "$LOOP_MARKER" ]; then
  MARKER_MTIME=$(_marker_mtime "$LOOP_MARKER")
  if [ -n "$MARKER_MTIME" ]; then
    MARKER_AGE=$(( NOW_SECS - MARKER_MTIME ))
    if [ "$MARKER_AGE" -lt 3600 ]; then
      BOOTSTRAP_LOOP=false
      # Refresh the marker: every healthy tick keeps it young, so it only
      # goes stale when the scheduler actually stops firing.
      touch "$LOOP_MARKER"
      echo "BOOTSTRAP_LOOP=false (loop active since $(cat "$LOOP_MARKER"), last tick ${MARKER_AGE}s ago)"
    fi
  fi
fi
if [ "$BOOTSTRAP_LOOP" = "true" ]; then
  date -u +"%Y-%m-%dT%H:%M:%SZ" > "$LOOP_MARKER"
  echo "BOOTSTRAP_LOOP=true"
fi
```

If the output shows `BOOTSTRAP_LOOP=true`, invoke the `loop` skill via the Skill tool with `args: "5m /agent-team:reviewer"` to start the recurring review. The Skill tool call schedules the loop and the framework will fire `/agent-team:reviewer` every 5 minutes — each tick re-enters this protocol, refreshes the marker, and goes directly to Step 1.

If `BOOTSTRAP_LOOP=false`, the loop is already armed — proceed directly to Step 1 without invoking `loop` again (prevents nested/duplicate schedulers).

Every tick refreshes the marker's mtime, so a healthy loop never re-bootstraps. The marker only goes stale (older than 60 minutes) when the scheduler stops firing — a crashed or expired loop is then recovered on the next manual invocation.

The marker lives at `$AGENT_TEAM_TASKS_DIR/.reviewer-loop-active` (gitignored runtime state). Delete it manually only if you explicitly want a fresh loop to be scheduled on the next invocation.

Note: the `loop` skill may not be available in every Claude Code installation. If invoking it fails, tell the user: reviews ran once; to schedule recurring reviews run `/loop 5m /agent-team:reviewer` if they have the loop skill, or re-invoke `/agent-team:reviewer` manually.

## Step 1 — Walk done/

```bash
mkdir -p "$AGENT_TEAM_TASKS_DIR/approved"
FILES=$(ls "$AGENT_TEAM_TASKS_DIR/done/"*.md 2>/dev/null | grep -v "\.gitkeep" || true)
if [ -z "$FILES" ]; then
  echo "Nothing in done/ to review."
  exit 0
fi
echo "Found $(echo "$FILES" | wc -l) task(s) to review."
```

If `done/` is empty, report "Nothing in done/ to review." and stop. This keeps `/loop` ticks quiet.

## Step 2 — For each task, run the review sequence

```bash
for TASK_PATH in $FILES; do
  TASK_FILE=$(basename "$TASK_PATH")
  # run Steps A-F below using $TASK_FILE (F only on Pass with auto-merge)
done
```

### Step A — Read the task and extract frontmatter

```bash
cat "$AGENT_TEAM_TASKS_DIR/done/$TASK_FILE"
TITLE=$(grep "^title:" "$AGENT_TEAM_TASKS_DIR/done/$TASK_FILE" | sed 's/^title: *//')
TYPE=$(grep "^type:" "$AGENT_TEAM_TASKS_DIR/done/$TASK_FILE" | sed 's/^type: *//')
PR_URL=$(grep "^pr_url:" "$AGENT_TEAM_TASKS_DIR/done/$TASK_FILE" | sed 's/^pr_url: *//')
PREVIEW_PATH=$(grep "^preview_path:" "$AGENT_TEAM_TASKS_DIR/done/$TASK_FILE" | sed 's/^preview_path: *//')
SLUG=$(basename "$TASK_FILE" .md | sed 's/^[0-9-]*-//')
AUTO_MERGE=$(grep "^auto_merge:" "$AGENT_TEAM_TASKS_DIR/done/$TASK_FILE" | sed 's/^auto_merge: *//')
WORKTREE_BRANCH=$(grep "^worktree_branch:" "$AGENT_TEAM_TASKS_DIR/done/$TASK_FILE" | sed 's/^worktree_branch: *//')
MERGE_ENABLED="no"
```

If `PR_URL` is empty, treat as Fail with reason "pr_url missing in frontmatter — worker did not record PR".

### Step B — Fetch the PR diff and metadata

```bash
gh pr diff "$PR_URL"

PR_META=$(gh pr view "$PR_URL" --json baseRefName,mergeable,mergeStateStatus,state,statusCheckRollup)
BASE_REF=$(echo "$PR_META" | node -e "console.log(JSON.parse(require('fs').readFileSync(0,'utf8')).baseRefName||'')")
MERGEABLE=$(echo "$PR_META" | node -e "console.log(JSON.parse(require('fs').readFileSync(0,'utf8')).mergeable||'')")
MERGE_STATE=$(echo "$PR_META" | node -e "console.log(JSON.parse(require('fs').readFileSync(0,'utf8')).mergeStateStatus||'')")
PR_STATE=$(echo "$PR_META" | node -e "console.log(JSON.parse(require('fs').readFileSync(0,'utf8')).state||'')")

# CI: pass if all checks SUCCESS, or only-pending checks are deploy-preview-related (e.g. Vercel)
CI_OK=$(echo "$PR_META" | node -e "
const d=JSON.parse(require('fs').readFileSync(0,'utf8'));
const checks=(d.statusCheckRollup||[]).filter(c=>c.__typename==='CheckRun'||c.__typename==='StatusContext');
const fail=checks.find(c=>['FAILURE','ERROR','CANCELLED','TIMED_OUT'].includes((c.conclusion||c.state||'').toUpperCase()));
if(fail){console.log('FAIL: '+ (fail.name||fail.context||'unknown'));process.exit(0);}
const pending=checks.filter(c=>['PENDING','IN_PROGRESS','QUEUED','EXPECTED'].includes((c.status||c.state||'').toUpperCase()));
const nonDeployPending=pending.filter(c=>!/vercel/i.test(c.name||c.context||''));
if(nonDeployPending.length){console.log('PENDING: '+nonDeployPending.map(c=>c.name||c.context).join(','));process.exit(0);}
console.log('OK');
")
```

Interpretation rules for Step E:
- `BASE_REF` — must equal `"$AGENT_TEAM_PR_BASE"` for auto-merge (PRs targeting other branches get approved but NOT auto-merged)
- `MERGEABLE` — must be `MERGEABLE` (not `CONFLICTING` / `UNKNOWN`)
- `PR_STATE` — must be `OPEN`
- `CI_OK` — must start with `OK` (means: all checks success, or only deploy-preview checks pending — e.g. Vercel may stay pending)

### Step C — Check acceptance criteria

Read each `acceptance_criteria` item from the task file. For each one, look at the diff and state explicitly whether it is satisfied and why. Do not approve unless every criterion is verified by the diff (or, for behavioural criteria, by the UI check in Step D).

### Step D — UI check (only if `type: ui`)

Write and execute a single self-contained script:

```bash
WORKTREE=$(ls -d "${AGENT_TEAM_ROOT}/.worktrees/"*"${SLUG}"* 2>/dev/null | head -1)

if [ -z "$WORKTREE" ]; then
  echo "ERROR: No worktree found for slug '$SLUG' — cannot run UI check. Treat as FAIL."
  UI_CHECK_RESULT="fail"
else
  # Read devServer config
  DEV_CMD=$(node --input-type=module -e "
const {loadConfig} = await import('${CLAUDE_PLUGIN_ROOT}/scripts/lib/config.mjs');
const c = loadConfig();
console.log(c.devServer?.command || '');
")
  DEV_URL=$(node --input-type=module -e "
const {loadConfig} = await import('${CLAUDE_PLUGIN_ROOT}/scripts/lib/config.mjs');
const c = loadConfig();
console.log(c.devServer?.url || '');
")

  if [ -z "$DEV_CMD" ] || [ -z "$DEV_URL" ]; then
    echo "ERROR: devServer not configured — run /agent-team:setup. UI check cannot proceed."
    UI_CHECK_RESULT="fail"
  else
    UI_SCRIPT=$(mktemp /tmp/ui-check-XXXX.sh)
    chmod +x "$UI_SCRIPT"
    # Check whether playwright is installed in the consumer repo's node_modules
    PLAYWRIGHT_AVAILABLE=$(cd "${WORKTREE}" && node -e "require.resolve('playwright')" 2>/dev/null && echo "yes" || echo "no")
    cat > "$UI_SCRIPT" << SCRIPT
#!/bin/bash
set -e
SCREENSHOT="/tmp/ui-check-${SLUG}.png"

(cd "${WORKTREE}" && $DEV_CMD) &
DEV_PID=\$!
trap "kill \$DEV_PID 2>/dev/null || true" EXIT

TRIES=0
until curl -sf ${DEV_URL} > /dev/null 2>&1; do
  sleep 1; TRIES=\$((TRIES+1))
  if [ \$TRIES -gt 60 ]; then
    echo "ERROR: dev server did not start within 60s"
    exit 1
  fi
done

if [ "${PLAYWRIGHT_AVAILABLE}" = "yes" ]; then
  node -e "
const { chromium } = require('playwright');
(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  const errors = [];
  page.on('console', msg => { if (msg.type() === 'error') errors.push(msg.text()); });
  await page.goto('${DEV_URL}${PREVIEW_PATH}');
  await page.waitForLoadState('networkidle');
  await page.screenshot({ path: '\${SCREENSHOT}' });
  await browser.close();
  if (errors.length) { console.error('Console errors:', JSON.stringify(errors)); process.exit(1); }
})();
"
else
  npx --yes playwright@latest install chromium --with-deps 2>/dev/null || true
  npx --yes playwright@latest screenshot --wait-for-timeout=5000 "${DEV_URL}${PREVIEW_PATH}" "\${SCREENSHOT}"
  echo "playwright package not installed in this repo — ran CLI screenshot fallback (no console-error capture). For full-fidelity UI checks add playwright as a devDependency."
fi

echo "UI_CHECK_PASSED"
echo "Screenshot: \${SCREENSHOT}"
SCRIPT

    if bash "$UI_SCRIPT"; then
      UI_CHECK_RESULT="pass"
      echo "UI check passed. Screenshot: /tmp/ui-check-${SLUG}.png"
    else
      UI_CHECK_RESULT="fail"
      echo "UI check FAILED — see errors above."
    fi
    rm -f "$UI_SCRIPT"
  fi
fi
```

If `UI_CHECK_RESULT` is "fail", the task is a Fail in Step E regardless of acceptance-criteria analysis.

### Step E — Verdict

**Pass:** all acceptance criteria met AND (for `ui` tasks) `UI_CHECK_RESULT=pass` AND PR is OPEN AND `mergeable=MERGEABLE` AND CI is green-or-only-deploy-preview-pending.

```bash
# Approve
gh pr review "$PR_URL" --approve --body "Acceptance criteria verified. Approved by /agent-team:reviewer." \
  || gh pr comment "$PR_URL" --body "✅ Acceptance criteria verified. Approved by /agent-team:reviewer. (self-review fallback)"

# Auto-merge — only if PR targets the configured base branch
# AND the task does not opt out via auto_merge: false
if [ "$BASE_REF" = "$AGENT_TEAM_PR_BASE" ] && [ "$AUTO_MERGE" != "false" ]; then
  if gh pr merge "$PR_URL" --auto --merge --delete-branch; then
    MERGE_ENABLED="yes"
    echo "Auto-merge enabled for $PR_URL"
  else
    echo "WARNING: auto-merge failed for $PR_URL — needs manual merge"
  fi
elif [ "$AUTO_MERGE" = "false" ]; then
  echo "Task has auto_merge: false — approved but NOT merged. Surfaces in the report under 'Awaiting manual merge'."
else
  echo "PR targets '$BASE_REF', not '$AGENT_TEAM_PR_BASE' — approved but NOT auto-merged. Surface to human."
fi

# Move task file — when board.provider is trello, the trello-sync daemon syncs cards based on folder location
mv "$AGENT_TEAM_TASKS_DIR/done/$TASK_FILE" "$AGENT_TEAM_TASKS_DIR/approved/$TASK_FILE"
```

**Fail:** one or more criteria not met, or `UI_CHECK_RESULT=fail`, or PR is unmergeable / failing CI.

```bash
# Write a specific, actionable reason
REJECTION_REASON="<exact reasons from Step C and/or D>"

# Update frontmatter — replace existing rejection_reason line (do NOT duplicate)
TMP=$(mktemp)
awk -v reason="$REJECTION_REASON" '
  /^rejection_reason:/ { print "rejection_reason: \"" reason "\""; next }
  { print }
' "$AGENT_TEAM_TASKS_DIR/done/$TASK_FILE" > "$TMP" && mv "$TMP" "$AGENT_TEAM_TASKS_DIR/done/$TASK_FILE"

# Move back to todo so a worker can re-pick
mv "$AGENT_TEAM_TASKS_DIR/done/$TASK_FILE" "$AGENT_TEAM_TASKS_DIR/todo/$TASK_FILE"

# Comment on the PR (do NOT use `gh pr review --request-changes` — fails on self-authored PRs).
gh pr comment "$PR_URL" --body "❌ Rejected by /agent-team:reviewer: $REJECTION_REASON"
```

### Step F — Branch cleanup (Pass path with auto-merge only)

Run only when the verdict was Pass **and** `MERGE_ENABLED=yes`. The worker's
work is on the remote (PR approved, auto-merge armed), so the local worktree
and branch are disposable. Never run this for rejections, `auto_merge: false`
tasks, or PRs targeting a non-base branch — those keep their worktrees.

```bash
CLEANUP_RESULT="skipped"
if [ "$MERGE_ENABLED" = "yes" ]; then
  # Resolve the worktree by branch — exact match, never by name substring
  # (slugs can be substrings of one another; a fuzzy match could delete
  # another task's in-progress worktree)
  CLEANUP_WORKTREE=$(git -C "$AGENT_TEAM_ROOT" worktree list --porcelain \
    | awk -v ref="refs/heads/$WORKTREE_BRANCH" '
        /^worktree /{wt=substr($0,10)}
        /^branch /{if ($2==ref) print wt}' | head -1)
  if [ -z "$CLEANUP_WORKTREE" ] && [ -z "$WORKTREE_BRANCH" ]; then
    CLEANUP_RESULT="skipped: no worktree or branch recorded"
  else
    CLEANUP_RESULT="done"
    if [ -n "$CLEANUP_WORKTREE" ]; then
      git -C "$AGENT_TEAM_ROOT" worktree remove --force "$CLEANUP_WORKTREE" \
        || CLEANUP_RESULT="WARNING: worktree remove failed for $CLEANUP_WORKTREE"
    fi
    if [ -n "$WORKTREE_BRANCH" ] && [ "$WORKTREE_BRANCH" != "$AGENT_TEAM_PR_BASE" ]; then
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

## Step 3 — Final summary

After the loop, print:

```
Reviewed N task(s):
  ✅ Approved: <count>
    - <title> — <pr_url> — auto-merge: <enabled|skipped: targets non-base branch|failed> — cleanup: <done|skipped|WARNING: reason>
  ❌ Rejected: <count>
    - <title> — back to todo/ — reason: <reason>
```

If wrapped in `/loop`, this summary becomes the per-tick output; keep it short.

## Rules

- Read-only on the PR — never push commits, never modify worker code
- Local cleanup only on the Pass+auto-merge path: remove the worker's worktree and local branch (Step F); rejections, `auto_merge: false`, and non-base PRs keep their worktrees
- For UI tasks, never skip the headless browser check
- Approval requires CI green or only-deploy-preview-pending (deploy-preview checks such as Vercel may stay pending). Treat FAILING checks as Fail.
- PRs not targeting `$AGENT_TEAM_PR_BASE` get approved but NEVER auto-merged — flag for human
- Use `gh pr comment` for rejections (not `gh pr review --request-changes` — fails on self-authored PRs)
- Move task files atomically with `mv` — never copy+delete
- When board.provider is trello, do NOT issue manual `curl` calls to move Trello cards — the trello-sync daemon syncs based on folder location (within 60s)
- Designed to be safe to run on a loop: empty `done/` → silent exit, no side effects
- The 5-minute auto-loop is bootstrapped from Step 0 using `$AGENT_TEAM_TASKS_DIR/.reviewer-loop-active` as a time-stamped marker — every tick refreshes the marker's mtime, so it only goes stale (>60 minutes) when the scheduler dies, at which point the next invocation re-bootstraps; never schedule a second loop while the marker is younger than 60 minutes
- `auto_merge: false` in the task frontmatter means approve-but-never-merge — the human merges manually (absent field = legacy behavior, merge allowed)
