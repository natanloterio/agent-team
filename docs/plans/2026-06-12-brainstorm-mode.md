# Brainstorm Mode Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an optional, on-demand Brainstorm Mode to the team-leader skill that refines vague goals into an approved spec before breaking them into task files.

**Architecture:** All changes are to markdown protocol files (the plugin's "code" is Claude Code skill instructions) plus the README. A new `## Brainstorm Mode` section goes into `commands/team-leader.md` between Dispatch Mode and Review Mode; `commands/worker.md` Step 6 learns to read an optional `spec:` frontmatter field; the README documents both. Spec source of truth: `docs/specs/2026-06-12-brainstorm-mode-design.md`.

**Tech Stack:** Markdown skill protocols, bash snippets embedded in skills. No executable code changes — no new automated tests apply (no existing test validates task frontmatter; the spec's test requirement is satisfied vacuously). The existing suite (`node --test tests/*.test.mjs`, `bash tests/dispatch-workers.test.sh`, `shellcheck`) is run once at the end as a regression guard.

---

### Task 1: Add Brainstorm Mode section to team-leader.md

**Files:**
- Modify: `commands/team-leader.md` (insert new section between `## Dispatch Mode` and `## Review Mode`, i.e. immediately before the line `## Review Mode — Reviewing completed tasks`)

- [ ] **Step 1: Insert the Brainstorm Mode section**

Insert the following block immediately before `## Review Mode — Reviewing completed tasks`:

````markdown
## Brainstorm Mode — Refining a vague goal before dispatch

Enter this mode when:

- The developer asks for it explicitly ("brainstorm this", "let's think
  through X", "I'm not sure how to approach Y"), or
- A goal is too vague or ambiguous to break into tasks — in that case,
  **offer** Brainstorm Mode instead of dispatching blind.

Dispatch Mode remains the default for clear goals.

### Protocol

Follow these steps in order:

1. **Explore repo context first** — relevant files, docs, recent commits.
2. **Scope check before detailed questions** — if the goal describes multiple
   independent subsystems, flag it immediately and help the developer
   decompose into sub-goals instead of refining details of something that
   needs splitting first. Brainstorm the first sub-goal through this flow;
   each sub-goal gets its own spec → tasks cycle.
3. **Clarifying questions, one at a time** — only one question per message;
   if a topic needs more exploration, break it into multiple questions.
   Prefer multiple choice (open-ended is fine too); focus on purpose,
   constraints, and success criteria. Never batch questions.
4. **Propose 2–3 approaches** with trade-offs, leading with the recommended
   option and the reasoning behind it.
5. **Present the design in sections**, each scaled to its complexity (a few
   sentences if straightforward, longer if nuanced), asking after each
   section whether it looks right so far. Cover, where applicable:
   architecture, components, data flow, error handling, testing. Go back and
   clarify whenever something doesn't make sense.
6. **Get explicit developer approval** of the full design before producing
   any output.

**HARD GATE: write nothing — no spec file, no task files — until the
developer has approved the design.** This applies regardless of perceived
simplicity. "Simple" goals are where unexamined assumptions cause the most
wasted worker cycles; the design for a trivial goal can be a few sentences,
but it must still be presented and approved.

**Short-circuit for trivial goals:** if during the brainstorm the goal turns
out to be trivial, compress steps 4–6 into a single message — a few-sentence
design plus "this is straightforward — want me to just create the task?".
Developer approval is still required; the hard gate holds.

If the developer aborts mid-brainstorm, write nothing; there is no pending
state.

**Key principles:** one question at a time; multiple choice preferred; YAGNI
ruthlessly — remove unnecessary features from all designs; always explore
2–3 alternatives before settling; incremental validation — present design,
get approval before moving on; be flexible — go back and clarify when
something doesn't make sense. Break designs into small units with one clear
purpose and well-defined interfaces; follow existing repo patterns; include
only targeted improvements that serve the current goal — no unrelated
refactoring.

### Output on approval

1. Save the approved design as a spec:

```bash
mkdir -p "$AGENT_TEAM_TASKS_DIR/specs"
# Write the design to: $AGENT_TEAM_TASKS_DIR/specs/YYYY-MM-DD-<slug>.md
```

2. **Spec self-review** — reread the saved spec with fresh eyes and fix
   issues inline (no re-review loop):
   - Placeholder scan: any "TBD", "TODO", incomplete sections, vague
     requirements?
   - Internal consistency: do sections contradict each other?
   - Scope check: focused enough for one batch of tasks, or does it need
     decomposition?
   - Ambiguity check: could any requirement be read two ways? Pick one and
     make it explicit.

3. **Developer review gate** — report the spec path and ask the developer to
   review it before any tasks are created: "Spec written to `<path>`. Please
   review it and let me know if you want changes before I break it into
   tasks." If changes are requested, apply them and re-run the self-review.
   Only proceed on approval.

4. Break the design into task files in `todo/` following Dispatch Mode,
   adding one extra frontmatter field to each task:

```yaml
spec: ../specs/YYYY-MM-DD-<slug>.md
```

   The path is relative to the task file's own directory, so it resolves
   from `todo/`, `doing/`, and `done/` alike.

5. Report to the developer: spec path + list of created tasks with
   acceptance criteria.

The spec lives in the tasks dir (not `docs/`) because `gwt.sh` symlinks the
tasks dir into every worker worktree — workers see the spec immediately,
with no commit/merge on the base branch required. A developer who wants the
spec in git history can copy it into `docs/` afterwards.
````

- [ ] **Step 2: Add the vague-goal pointer to Dispatch Mode**

In `commands/team-leader.md`, change the Dispatch Mode opening line:

```markdown
When the developer gives you a goal:
```

to:

```markdown
When the developer gives you a goal (if the goal is too vague or ambiguous
to break into tasks, offer Brainstorm Mode — below — instead of dispatching
blind):
```

- [ ] **Step 3: Add the optional `spec:` field to the canonical frontmatter template**

In the Dispatch Mode frontmatter template in `commands/team-leader.md`, change:

```markdown
worktree_branch:
claimed_at:
```

to:

```markdown
spec:                  # optional — set by Brainstorm Mode; path relative to the task file
worktree_branch:
claimed_at:
```

- [ ] **Step 4: Add a Brainstorm rule to the Rules section**

In the `## Rules` list at the end of `commands/team-leader.md`, after the line
`- Never implement tasks yourself — you coordinate only`, add:

```markdown
- In Brainstorm Mode, never write a spec or task files before the developer approves the design — the hard gate is absolute
```

- [ ] **Step 5: Verify the section landed correctly**

Run:

```bash
grep -n "^## " commands/team-leader.md
```

Expected: `## Brainstorm Mode — Refining a vague goal before dispatch` appears between `## Dispatch Mode — Breaking down a goal into tasks` and `## Review Mode — Reviewing completed tasks`.

```bash
grep -n "spec:" commands/team-leader.md
```

Expected: at least two hits — the frontmatter template line and the Brainstorm output yaml block.

- [ ] **Step 6: Commit**

```bash
git add commands/team-leader.md
git commit -m "feat: add Brainstorm Mode to team-leader skill"
```

---

### Task 2: Teach the worker to read the optional spec

**Files:**
- Modify: `commands/worker.md` (Step 6 — Implement the task, currently lines 81–86)

- [ ] **Step 1: Add the spec bullet to Step 6**

In `commands/worker.md`, change:

```markdown
## Step 6 — Implement the task

- Read `acceptance_criteria` from the task file — these are your definition of done
```

to:

```markdown
## Step 6 — Implement the task

- If the task frontmatter has a non-empty `spec:` field, read that file first — the path is relative to the task file's own directory (e.g. `../specs/<name>.md` resolves inside `$AGENT_TEAM_TASKS_DIR`). It is the approved design behind this task; treat it as binding context. If the field is empty or absent, proceed as normal.
- Read `acceptance_criteria` from the task file — these are your definition of done
```

- [ ] **Step 2: Verify**

```bash
grep -n "spec:" commands/worker.md
```

Expected: one hit inside Step 6.

- [ ] **Step 3: Commit**

```bash
git add commands/worker.md
git commit -m "feat: worker reads optional spec: field before implementing"
```

---

### Task 3: Document Brainstorm Mode in the README

**Files:**
- Modify: `README.md` (team-leader role section, after the paragraph describing daemons, currently around line 66–68)

- [ ] **Step 1: Add the Brainstorm Mode subsection**

In `README.md`, insert after the paragraph ending `...the Trello sync daemon when` `board.provider` `is` `"trello"`. and before `Attach to a worker session to watch it:`:

```markdown
For vague or ambiguous goals, the leader offers **Brainstorm Mode**: a
structured refinement loop (clarifying questions one at a time, 2–3
approaches with trade-offs, sectioned design review) that writes nothing
until the developer approves the design. On approval it saves a spec to
`<tasksDir>/specs/` — visible to every worker worktree via the `gwt.sh`
symlink — and breaks it into task files whose frontmatter carries an
optional `spec:` field pointing back to it. Workers read the spec before
implementing.
```

- [ ] **Step 2: Verify**

```bash
grep -n "Brainstorm Mode" README.md
```

Expected: one hit in the team-leader role section.

- [ ] **Step 3: Commit**

```bash
git add README.md
git commit -m "docs: document Brainstorm Mode and the spec: task field"
```

---

### Task 4: Regression check

**Files:** none modified.

- [ ] **Step 1: Run the existing suite**

```bash
node --test tests/*.test.mjs && bash tests/dispatch-workers.test.sh && shellcheck scripts/*.sh hooks/*.sh tests/*.sh
```

Expected: all Node tests pass, smoke test prints its pass lines, shellcheck silent. (Markdown-only change — this guards against accidental script edits.)

- [ ] **Step 2: Spec coverage check**

Confirm each spec section maps to a change:
- Trigger / Protocol / hard gate / short-circuit / key principles → Task 1 Step 1
- Vague-goal offer from Dispatch → Task 1 Step 2
- `spec:` frontmatter field → Task 1 Steps 1 & 3
- Output (specs dir, self-review, review gate, report) → Task 1 Step 1
- Worker change → Task 2
- README → Task 3
- Tests-accept-optional-field → vacuous (no frontmatter-validating test exists); regression suite run in this task
