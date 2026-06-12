# Brainstorm Mode — design

Date: 2026-06-12
Status: approved

## Problem

The team-leader goes straight from a developer goal to task files (Dispatch
Mode). There is no structured way to refine a vague or ambiguous goal before
it becomes work for the workers. Badly-specified goals produce badly-specified
tasks, which produce rejected PRs and wasted worker cycles.

## Decision

Add an **optional, on-demand Brainstorm Mode** to `commands/team-leader.md`,
alongside the existing Dispatch / Review / Trello Sync modes. Dispatch Mode
remains the default path for clear goals.

## Trigger

The leader enters Brainstorm Mode when:

- The developer asks for it explicitly ("brainstorm this", "let's think
  through X", "I'm not sure how to approach Y"), or
- The goal is too vague or ambiguous to break into tasks — in that case the
  leader **offers** Brainstorm Mode instead of dispatching blind.

## Protocol

The protocol mirrors the essentials of a collaborative brainstorming session,
embedded directly in the skill (no dependency on other plugins):

1. **Explore repo context first** — relevant files, docs, recent commits.
2. **Clarifying questions, one at a time** — prefer multiple choice; focus on
   purpose, constraints, and success criteria. Never batch questions.
3. **Propose 2–3 approaches** with trade-offs and a recommendation.
4. **Present a design summary** and get explicit developer approval before
   producing any output.

If during the brainstorm the goal turns out to be trivial, the leader may
short-circuit: "this is straightforward — want me to just create the task?"

If the developer aborts mid-brainstorm, nothing is written; there is no
pending state.

## Output

On approval the leader:

1. Saves the design doc to `$AGENT_TEAM_TASKS_DIR/specs/YYYY-MM-DD-<slug>.md`
   (creating `specs/` if absent).
2. Breaks the design into task files in `todo/` using the existing
   frontmatter format, adding one optional field:

   ```yaml
   spec: ../specs/YYYY-MM-DD-<slug>.md
   ```

   The path is relative to the task file's own directory, so it resolves from
   `todo/`, `doing/`, and `done/` alike.
3. Reports to the developer: spec path + list of created tasks with
   acceptance criteria.

### Why the spec lives in the tasks dir, not `docs/`

`gwt.sh` symlinks the tasks dir into **every worker worktree**. A spec saved
there is visible to workers immediately, with no commit/merge on the base
branch required. A spec committed to `docs/` in the repo would only reach a
worker's worktree after landing on the base branch — in practice, never in
time. The tasks dir is gitignored, so the spec is not in git history; a
developer who wants to keep it can copy it into `docs/` afterwards.

## Worker change

`commands/worker.md` gains one instruction: if the claimed task has a `spec:`
field, read that file before implementing. The field is optional — tasks
without it behave exactly as today.

## Out of scope

- Mandatory brainstorming before every dispatch (rejected: stays on-demand).
- A separate `/agent-team:brainstorm` command (rejected: it is a mode of the
  team-leader session).
- Trello integration with specs.

## Documentation and tests

- README: new subsection under the team-leader role describing Brainstorm
  Mode and the `spec:` field.
- Any test that validates task frontmatter must accept the optional `spec:`
  field.
