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

The protocol is a faithful reimplementation of the
`superpowers:brainstorming` skill, embedded directly in the team-leader skill
(no dependency on other plugins), with the deliberate divergences listed at
the end of this document.

## Trigger

The leader enters Brainstorm Mode when:

- The developer asks for it explicitly ("brainstorm this", "let's think
  through X", "I'm not sure how to approach Y"), or
- The goal is too vague or ambiguous to break into tasks — in that case the
  leader **offers** Brainstorm Mode instead of dispatching blind.

## Protocol

The leader follows these steps in order:

1. **Explore repo context first** — relevant files, docs, recent commits.
2. **Scope check before detailed questions** — if the goal describes multiple
   independent subsystems, flag it immediately and help the developer
   decompose into sub-goals instead of refining details of something that
   needs splitting first. Brainstorm the first sub-goal through the normal
   flow; each sub-goal gets its own spec → tasks cycle.
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

**Hard gate:** the leader writes nothing — no spec file, no task files, no
code — until the developer has approved the design. This applies regardless
of perceived simplicity. "Simple" goals are where unexamined assumptions
cause the most wasted worker cycles; the design for a trivial goal can be a
few sentences, but it must still be presented and approved.

**Short-circuit for trivial goals:** if during the brainstorm the goal turns
out to be trivial, the leader may compress steps 4–6 into a single message —
a few-sentence design plus "this is straightforward — want me to just create
the task?". Developer approval is still required; the hard gate holds.

If the developer aborts mid-brainstorm, nothing is written; there is no
pending state.

### Key principles

Embedded verbatim from the upstream skill:

- **One question at a time** — don't overwhelm with multiple questions.
- **Multiple choice preferred** — easier to answer than open-ended.
- **YAGNI ruthlessly** — remove unnecessary features from all designs.
- **Explore alternatives** — always propose 2–3 approaches before settling.
- **Incremental validation** — present design, get approval before moving on.
- **Be flexible** — go back and clarify when something doesn't make sense.

Design-quality guidance also carries over: break the system into small units
with one clear purpose and well-defined interfaces; in existing code, follow
existing patterns and include only targeted improvements that serve the
current goal — no unrelated refactoring.

## Output

On approval the leader:

1. Saves the design doc to `$AGENT_TEAM_TASKS_DIR/specs/YYYY-MM-DD-<slug>.md`
   (creating `specs/` if absent).
2. **Spec self-review** — rereads the saved spec with fresh eyes and fixes
   issues inline (no re-review loop):
   - Placeholder scan: any "TBD", "TODO", incomplete sections, vague
     requirements?
   - Internal consistency: do sections contradict each other?
   - Scope check: focused enough for one batch of tasks, or does it need
     decomposition?
   - Ambiguity check: could any requirement be read two ways? Pick one and
     make it explicit.
3. **Developer review gate** — reports the spec path and asks the developer
   to review it before any tasks are created: "Spec written to `<path>`.
   Please review it and let me know if you want changes before I break it
   into tasks." If changes are requested, the leader applies them and re-runs
   the self-review. Only proceeds on approval.
4. Breaks the design into task files in `todo/` using the existing
   frontmatter format, adding one optional field:

   ```yaml
   spec: ../specs/YYYY-MM-DD-<slug>.md
   ```

   The path is relative to the task file's own directory, so it resolves from
   `todo/`, `doing/`, and `done/` alike.
5. Reports to the developer: spec path + list of created tasks with
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

## Divergences from `superpowers:brainstorming`

Deliberate adaptations to the agent-team context; everything else is
reimplemented as-is:

| Upstream skill | Brainstorm Mode |
|---|---|
| Spec saved to `docs/superpowers/specs/` and committed to git | Saved to `$AGENT_TEAM_TASKS_DIR/specs/`, not committed (see rationale above) |
| Terminal step: invoke the `writing-plans` skill | Terminal step: break the spec into task files in `todo/` — the team-leader's planning analog |
| Visual Companion (browser mockups) | Out of scope — the leader is a terminal coordinator |
| Checklist tracked via TodoWrite tasks | The protocol steps are the checklist, written into the mode itself |
| Optional `elements-of-style` skill for spec prose | Omitted — no plugin dependencies |

## Out of scope

- Mandatory brainstorming before every dispatch (rejected: stays on-demand).
- A separate `/agent-team:brainstorm` command (rejected: it is a mode of the
  team-leader session).
- Trello integration with specs.
- Visual Companion / browser-based mockups.

## Documentation and tests

- README: new subsection under the team-leader role describing Brainstorm
  Mode and the `spec:` field.
- Any test that validates task frontmatter must accept the optional `spec:`
  field.
