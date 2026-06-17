# Governance Layer — Design

**Date:** 2026-06-17
**Status:** Approved (design); pending implementation plan
**Topic:** A hierarchical planning/governance layer above agent-team's execution machine.

## Problem

Today `team-leader` breaks a goal into tasks by hand and drops them straight
into `todo/`. There is no formal step that (a) turns a raw demand into
requirements, (b) decomposes work while preserving the product vision, or
(c) peer-reviews the proposed work *before* it reaches the execution queue.
Quality control happens only at code-review time (the `reviewer`), so flawed
decomposition is caught late, after workers have already built against it.

## Goal

Add a **planning/governance layer** that runs *above* the existing execution
machine (workers + reviewer). The layer turns a demand into an **approved
backlog** through a Product Manager → Solution Designer → peer-review pipeline.
The execution machine is left untouched.

## Core Principle

The boundary between the two layers is an artifact that already exists: **task
files in `todo/`**. The planning layer's only output is well-formed, approved
task files. `worker` and `reviewer` do not change at all.

```text
┌─ PLANNING LAYER (new) ── one team-leader session, all via sub-agents ─┐
│  Administrador → Arquiteto(s) → Conselho                              │
└──────────────────────────────┬─────────────────────────────────────────┘
                                ▼   interface = approved .md files
                            todo/
                                ▼
┌─ EXECUTION LAYER (unchanged) ── tmux sessions, as today ──────────────┐
│  workers (in worktrees) → PR → reviewer → merge                       │
└─────────────────────────────────────────────────────────────────────────┘
```

## Two Execution Mechanisms (context)

agent-team already has two distinct ways to "invoke a Claude Code agent". The
design assigns each layer to one:

| Mechanism | What it is | Traits | Used by |
|---|---|---|---|
| **tmux session** | `claude` in a tmux session + slash command | Heavy, persistent, parallel, observable in the dashboard, talks via the task-queue filesystem | team-leader, worker, reviewer |
| **Sub-agent (Task tool)** | Ephemeral agent spawned *inside* a session | Light, fan-out friendly, returns structured output to the parent, dies on completion | worker (internally) |

**Decision:** the planning layer runs entirely as **sub-agents** inside the
**team-leader** session. The execution layer stays as **tmux sessions**.

## Roles (all sub-agents via the Task tool, inside the team-leader session)

| Role | Is | Mechanism | Input → Output |
|---|---|---|---|
| **Administrador** (PM) | 1 sub-agent | Task tool | Client demand → `requirements.md` + macro-task list |
| **Arquiteto/Engenheiro** (Solution Designer) | 1 sub-agent **per macro-task** (parallel) | Task tool fan-out | Macro-task → blocks → subtasks with strategic context |
| **Conselho** (peer-review panel) | N sub-agents **per block** (parallel) | Task tool fan-out | Proposed subtasks → findings + per-lens vote |

The `team-leader` **stops breaking tasks by hand** and instead **orchestrates
this pipeline**. Entry point stays `/agent-team:team-leader`. It reuses the
existing event daemon and dispatch.

## Flow

```text
Demand → [Administrador] → requirements.md + macro-tasks
              │
              ▼ (one sub-agent per macro-task, in parallel)
         [Arquiteto] → blocks → subtasks + strategic context
              │
              ▼ (N reviewers in parallel, per block)
         [Conselho] → votes
              │
       majority approves AND no CRITICAL veto?
         ┌────┴────┐
        yes        no → [Arquiteto revises] ──┐
         │             (cycle, max 2)          │
         │          ◄───────────────────────────┘
         │             2 cycles exhausted?
         │                   │
         ▼                   ▼
  subtasks → todo/    block → backlog/ (blocked)
         │            + findings summary + cycle history
         ▼            + team-leader notifies the human (escalate)
  dispatch (existing) → workers → reviewer → merge
```

## Council Verdict Rule

N reviewers with **fixed lenses** (requirements/factual, architecture/senior
eng, security, consistency, redundancy — aligned with the user's global
multi-perspective rules). Each returns a vote `approve|reject` plus findings
with severity.

- **Majority** approves, **AND**
- any **CRITICAL** finding is a **veto** that blocks (forces a correction
  cycle), regardless of the majority.

## Cycle Limit and Escalation

Maximum **2 correction cycles**. If exhausted without approval, the block moves
to `backlog/` (blocked) with a summary of unresolved findings plus the history
of both cycles, and the `team-leader` notifies the human.

**Invariant:** nothing enters `todo/` without Council approval or an explicit
human decision.

## Persistence (new queue area)

```text
.tasks/
  planning/
    <demand-slug>/
      requirements.md              ← Administrador
      macro-tasks.md               ← Administrador
      blocks/<block-slug>/
        subtasks.md                ← Arquiteto proposal (current version)
        council/cycle-1.md         ← findings + tally per reviewer
        council/cycle-2.md
        status.json                ← in-review | approved | escalated
  todo/ doing/ done/ approved/ backlog/   ← unchanged
```

Persisting the planning artifacts makes the process auditable, survives a
session crash, feeds the escalation summary, and can be surfaced in the
dashboard later.

## Task Template (extends the current frontmatter)

New fields (`project`, `block`) and the **CONTEXTO ESTRATÉGICO** block in the
body carry the product vision down to the worker — the "door of room 302"
idea: every subtask knows the larger objective it serves.

```markdown
---
title: <imperative title>
type: ui | backend | refactor | docs | bug | business
role: <worker persona>
project: <demand-slug>          # NEW
block: <block objective>        # NEW
acceptance_criteria:
  - <criterion 1>
# ...existing fields: preview_path, spec, worktree_branch, claimed_at, pr_url, rejection_reason
---

## CONTEXTO ESTRATÉGICO                    # NEW (mandatory)
PROJETO: <product vision>
OBJETIVO DO BLOCO: <what this block delivers>
Why this task matters to the larger objective.

## TAREFA
<full description, constraints, relevant files>
```

The new fields are additive — existing tasks without `project`/`block` still
parse and dispatch normally.

## What Does NOT Change

- `worker` and `reviewer` commands and behavior.
- `dispatch-workers.sh`, the event daemon, the tmux watcher dashboard.
- The `todo/ doing/ done/ approved/ backlog/` semantics (only a new sibling
  `planning/` directory is added).

## Open Questions / Deferred

- Optional human gate on `requirements.md` before the Arquiteto phase begins
  (deferred; default is fully autonomous until escalation).
- Exact reviewer count and whether lenses are dynamic per task type (default:
  fixed lens set).
- Dashboard surfacing of the `planning/` area (deferred to a later iteration).
