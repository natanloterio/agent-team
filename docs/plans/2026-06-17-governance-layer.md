# Governance Layer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a hierarchical planning/governance layer (Administrador → Arquiteto → Conselho) that runs as sub-agents inside the `team-leader` session and produces an approved backlog in `todo/`, leaving the worker/reviewer execution layer untouched.

**Architecture:** The deterministic core — the council verdict rule (majority + CRITICAL veto), the 2-cycle limit, and the `.tasks/planning/` state machine — lives in two new pure/CLI Node modules (`council.mjs`, `planning.mjs`) that are unit-tested. The agentic orchestration (which sub-agents to spawn, in what order, with what prompts) lives as a new "Governance Mode" section in `commands/team-leader.md`. The boundary to the existing system is unchanged task files in `todo/`.

**Tech Stack:** Node.js ESM (`node:test`, `node:fs`), Bash, Claude Code plugin command Markdown. No new dependencies.

---

## File Structure

| File | Action | Responsibility |
|---|---|---|
| `scripts/lib/council.mjs` | Create | Pure `computeVerdict(votes, {cycle, maxCycles})` — the council decision rule. No I/O. |
| `tests/council.test.mjs` | Create | Unit tests for the verdict rule and edge cases. |
| `scripts/lib/config.mjs` | Modify | Add a `governance` config block (enabled, councilLenses, maxCycles) with defaults, validation, and `--print-env` output. |
| `tests/config.test.mjs` | Modify | Tests for governance defaults and validation. |
| `scripts/planning.mjs` | Create | State machine + CLI for `.tasks/planning/`: scaffold demands/blocks, record verdicts (via `council.mjs`), promote approved blocks to `todo/`, escalate exhausted ones to `backlog/`. |
| `tests/planning.test.mjs` | Create | Unit tests for the planning state machine. |
| `commands/team-leader.md` | Modify | Add "Governance Mode" orchestrating the Administrador/Arquiteto/Conselho sub-agents and the extended task template. |
| `docs/configuration.md` | Modify | Document the `governance` config block. |
| `docs/roles.md` | Modify | Document Governance Mode and the three planning roles. |
| `README.md` | Modify | One-paragraph mention + link. |

Each task below is independently mergeable and leaves the repo green.

---

## Task 1: Council verdict rule (pure logic)

**Files:**
- Create: `scripts/lib/council.mjs`
- Test: `tests/council.test.mjs`

- [ ] **Step 1: Write the failing tests**

Create `tests/council.test.mjs`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { computeVerdict } from "../scripts/lib/council.mjs";

const approve = (lens) => ({ lens, vote: "approve", findings: [] });
const reject = (lens, severity, note) => ({
  lens, vote: "reject", findings: [{ severity, note }],
});

test("strict majority with no critical → approved", () => {
  const v = computeVerdict(
    [approve("a"), approve("b"), reject("c", "minor", "nit")],
    { cycle: 1, maxCycles: 2 });
  assert.equal(v.decision, "approved");
  assert.equal(v.approveCount, 2);
  assert.equal(v.rejectCount, 1);
  assert.deepEqual(v.vetoes, []);
});

test("tie is not a majority → revise on cycle 1", () => {
  const v = computeVerdict(
    [approve("a"), approve("b"), reject("c", "minor", "x"), reject("d", "minor", "y")],
    { cycle: 1, maxCycles: 2 });
  assert.equal(v.decision, "revise");
  assert.match(v.reasons.join(" "), /no majority/);
});

test("critical finding vetoes even with majority approve", () => {
  const v = computeVerdict(
    [approve("a"), approve("b"), reject("sec", "critical", "secret leak")],
    { cycle: 1, maxCycles: 2 });
  assert.equal(v.decision, "revise");
  assert.equal(v.vetoes.length, 1);
  assert.equal(v.vetoes[0].lens, "sec");
  assert.match(v.reasons.join(" "), /CRITICAL veto \(sec\)/);
});

test("unresolved at max cycles → escalated", () => {
  const v = computeVerdict(
    [approve("a"), reject("sec", "critical", "still leaking")],
    { cycle: 2, maxCycles: 2 });
  assert.equal(v.decision, "escalated");
});

test("approval at max cycle is still approved (not escalated)", () => {
  const v = computeVerdict([approve("a"), approve("b")], { cycle: 2, maxCycles: 2 });
  assert.equal(v.decision, "approved");
});

test("empty votes throws", () => {
  assert.throws(() => computeVerdict([], { cycle: 1, maxCycles: 2 }), /non-empty/);
});

test("invalid cycle throws", () => {
  assert.throws(() => computeVerdict([approve("a")], { cycle: 0, maxCycles: 2 }), /cycle/);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test tests/council.test.mjs`
Expected: FAIL — `Cannot find module '../scripts/lib/council.mjs'`.

- [ ] **Step 3: Write the implementation**

Create `scripts/lib/council.mjs`:

```js
// Pure decision logic for the technical council (Conselho).
// Given one cycle's reviewer votes for a block, decide whether the proposed
// subtasks are approved, must be revised, or must be escalated to a human.
//
// A vote: { lens: string, vote: "approve"|"reject", findings: [{severity, note}] }
// Severity ladder: "info" < "minor" < "major" < "critical".
// Rule: strict majority of "approve" AND zero "critical" findings → approved.
//       Otherwise revise, unless this was the last allowed cycle → escalated.

export const SEVERITIES = Object.freeze(["info", "minor", "major", "critical"]);

export function computeVerdict(votes, { cycle, maxCycles } = {}) {
  if (!Array.isArray(votes) || votes.length === 0)
    throw new Error("votes must be a non-empty array");
  if (!Number.isInteger(cycle) || cycle < 1)
    throw new Error("cycle must be an integer >= 1");
  if (!Number.isInteger(maxCycles) || maxCycles < 1)
    throw new Error("maxCycles must be an integer >= 1");

  const approveCount = votes.filter((v) => v.vote === "approve").length;
  const rejectCount = votes.length - approveCount;

  const vetoes = votes.flatMap((v) =>
    (v.findings ?? [])
      .filter((f) => f.severity === "critical")
      .map((f) => ({ lens: v.lens, note: f.note })));

  // Strict majority: strictly more than half approve.
  const hasMajority = approveCount * 2 > votes.length;
  const approved = hasMajority && vetoes.length === 0;

  if (approved)
    return { decision: "approved", approveCount, rejectCount, vetoes, reasons: [] };

  const reasons = [];
  if (!hasMajority) reasons.push(`no majority: ${approveCount}/${votes.length} approved`);
  for (const v of vetoes) reasons.push(`CRITICAL veto (${v.lens}): ${v.note}`);

  const decision = cycle >= maxCycles ? "escalated" : "revise";
  return { decision, approveCount, rejectCount, vetoes, reasons };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test tests/council.test.mjs`
Expected: PASS — 7 tests.

- [ ] **Step 5: Commit**

```bash
git add scripts/lib/council.mjs tests/council.test.mjs
git commit -m "feat: add council verdict rule (majority + critical veto)"
```

---

## Task 2: Governance config block

**Files:**
- Modify: `scripts/lib/config.mjs`
- Test: `tests/config.test.mjs`

- [ ] **Step 1: Write the failing tests**

Append to `tests/config.test.mjs` (before the final close if any; these are top-level `test(...)` calls):

```js
test("governance defaults applied when absent", () => {
  const root = makeRepo(JSON.stringify({}));
  const cfg = loadConfig(root);
  assert.equal(cfg.governance.enabled, false);
  assert.equal(cfg.governance.maxCycles, 2);
  assert.deepEqual(cfg.governance.councilLenses,
    ["requirements", "architecture", "security", "consistency", "redundancy"]);
});

test("governance overrides merge", () => {
  const root = makeRepo(JSON.stringify({
    governance: { enabled: true, maxCycles: 3, councilLenses: ["security"] },
  }));
  const cfg = loadConfig(root);
  assert.equal(cfg.governance.enabled, true);
  assert.equal(cfg.governance.maxCycles, 3);
  assert.deepEqual(cfg.governance.councilLenses, ["security"]);
});

test("governance.maxCycles < 1 throws", () => {
  const root = makeRepo(JSON.stringify({ governance: { maxCycles: 0 } }));
  assert.throws(() => loadConfig(root), (e) =>
    e instanceof ConfigError && /maxCycles/.test(e.message));
});

test("governance.councilLenses must be non-empty array of strings", () => {
  const root = makeRepo(JSON.stringify({ governance: { councilLenses: [] } }));
  assert.throws(() => loadConfig(root), (e) =>
    e instanceof ConfigError && /councilLenses/.test(e.message));
});

test("governance.enabled must be boolean", () => {
  const root = makeRepo(JSON.stringify({ governance: { enabled: "yes" } }));
  assert.throws(() => loadConfig(root), (e) =>
    e instanceof ConfigError && /enabled/.test(e.message));
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test tests/config.test.mjs`
Expected: FAIL — `cfg.governance` is undefined.

- [ ] **Step 3: Add the default**

In `scripts/lib/config.mjs`, add `governance` to the `DEFAULTS` object (after `board`):

```js
  board: Object.freeze({ provider: "none" }),
  governance: Object.freeze({
    enabled: false,
    councilLenses: Object.freeze([
      "requirements", "architecture", "security", "consistency", "redundancy",
    ]),
    maxCycles: 2,
  }),
```

- [ ] **Step 4: Merge governance in loadConfig**

In `scripts/lib/config.mjs`, in the `cfg` object inside `loadConfig`, add the merge line after the `board` merge:

```js
  const cfg = {
    ...DEFAULTS,
    ...raw,
    worktree: { ...DEFAULTS.worktree, ...(raw.worktree ?? {}) },
    board: { ...DEFAULTS.board, ...(raw.board ?? {}) },
    governance: { ...DEFAULTS.governance, ...(raw.governance ?? {}) },
  };
```

- [ ] **Step 5: Validate governance**

In `scripts/lib/config.mjs`, in `validate(cfg, path)`, add before the closing brace:

```js
  const g = cfg.governance;
  if (typeof g.enabled !== "boolean")
    fail("governance.enabled must be a boolean");
  if (!Number.isInteger(g.maxCycles) || g.maxCycles < 1)
    fail(`governance.maxCycles must be an integer >= 1, got ${JSON.stringify(g.maxCycles)}`);
  if (!Array.isArray(g.councilLenses) || g.councilLenses.length < 1
      || !g.councilLenses.every((l) => typeof l === "string" && l))
    fail("governance.councilLenses must be a non-empty array of non-empty strings");
```

- [ ] **Step 6: Export governance to --print-env**

In `scripts/lib/config.mjs`, in the `--print-env` `vars` object, add three entries after `AGENT_TEAM_BOARD_PROVIDER`:

```js
      AGENT_TEAM_BOARD_PROVIDER: cfg.board.provider,
      AGENT_TEAM_GOV_ENABLED: cfg.governance.enabled,
      AGENT_TEAM_GOV_MAX_CYCLES: cfg.governance.maxCycles,
      AGENT_TEAM_GOV_LENSES: cfg.governance.councilLenses.join(","),
```

- [ ] **Step 7: Run tests to verify they pass**

Run: `node --test tests/config.test.mjs`
Expected: PASS — existing tests plus the 5 new ones.

- [ ] **Step 8: Commit**

```bash
git add scripts/lib/config.mjs tests/config.test.mjs
git commit -m "feat: add governance config block (enabled, councilLenses, maxCycles)"
```

---

## Task 3: Planning scaffold (init demand + add block)

**Files:**
- Create: `scripts/planning.mjs`
- Test: `tests/planning.test.mjs`

- [ ] **Step 1: Write the failing tests**

Create `tests/planning.test.mjs`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { initDemand, addBlock, readStatus } from "../scripts/planning.mjs";

const TASKS = ".tasks";
function makeRoot() {
  return mkdtempSync(join(tmpdir(), "agent-team-planning-"));
}

test("initDemand creates planning dir with requirements + macro-tasks stubs", () => {
  const root = makeRoot();
  const dir = initDemand(root, TASKS, "build-hotel");
  assert.ok(existsSync(join(dir, "requirements.md")));
  assert.ok(existsSync(join(dir, "macro-tasks.md")));
  assert.ok(existsSync(join(dir, "blocks")));
  assert.equal(dir, join(root, TASKS, "planning", "build-hotel"));
});

test("initDemand is idempotent and does not clobber existing files", () => {
  const root = makeRoot();
  const dir = initDemand(root, TASKS, "build-hotel");
  const before = readFileSync(join(dir, "requirements.md"), "utf8");
  initDemand(root, TASKS, "build-hotel");
  assert.equal(readFileSync(join(dir, "requirements.md"), "utf8"), before);
});

test("addBlock creates block with in-review status at cycle 0", () => {
  const root = makeRoot();
  initDemand(root, TASKS, "build-hotel");
  const bdir = addBlock(root, TASKS, "build-hotel", "room-access", "Finish room access doors");
  assert.ok(existsSync(join(bdir, "council")));
  assert.ok(existsSync(join(bdir, "subtasks")));
  const status = readStatus(root, TASKS, "build-hotel", "room-access");
  assert.equal(status.state, "in-review");
  assert.equal(status.cycle, 0);
  assert.equal(status.objective, "Finish room access doors");
});

test("addBlock rejects slugs with path traversal", () => {
  const root = makeRoot();
  initDemand(root, TASKS, "build-hotel");
  assert.throws(() => addBlock(root, TASKS, "build-hotel", "../evil", "x"), /slug/);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test tests/planning.test.mjs`
Expected: FAIL — `Cannot find module '../scripts/planning.mjs'`.

- [ ] **Step 3: Write the scaffold implementation**

Create `scripts/planning.mjs`:

```js
#!/usr/bin/env node
// State machine + CLI for the governance planning area, .tasks/planning/.
// Exported functions are pure-ish (filesystem only, explicit args) so they can
// be unit-tested; the CLI at the bottom wires them to the loaded config.
import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, renameSync } from "node:fs";
import { join } from "node:path";
import { computeVerdict } from "./lib/council.mjs";

const SLUG_RE = /^[a-z0-9][a-z0-9-]*$/;

function assertSlug(slug, label) {
  if (typeof slug !== "string" || !SLUG_RE.test(slug))
    throw new Error(`${label} slug must match ${SLUG_RE} (got ${JSON.stringify(slug)})`);
}

export function planningRoot(root, tasksDir) {
  return join(root, tasksDir, "planning");
}

export function demandDir(root, tasksDir, demand) {
  assertSlug(demand, "demand");
  return join(planningRoot(root, tasksDir), demand);
}

export function blockDir(root, tasksDir, demand, block) {
  assertSlug(block, "block");
  return join(demandDir(root, tasksDir, demand), "blocks", block);
}

function writeIfAbsent(path, body) {
  if (!existsSync(path)) writeFileSync(path, body);
}

export function initDemand(root, tasksDir, demand) {
  const dir = demandDir(root, tasksDir, demand);
  mkdirSync(join(dir, "blocks"), { recursive: true });
  writeIfAbsent(join(dir, "requirements.md"),
    `# Requirements — ${demand}\n\n> Written by the Administrador sub-agent.\n`);
  writeIfAbsent(join(dir, "macro-tasks.md"),
    `# Macro-tasks — ${demand}\n\n> Written by the Administrador sub-agent.\n`);
  return dir;
}

export function statusPath(root, tasksDir, demand, block) {
  return join(blockDir(root, tasksDir, demand, block), "status.json");
}

export function readStatus(root, tasksDir, demand, block) {
  return JSON.parse(readFileSync(statusPath(root, tasksDir, demand, block), "utf8"));
}

function writeStatus(root, tasksDir, demand, block, status) {
  writeFileSync(statusPath(root, tasksDir, demand, block),
    JSON.stringify(status, null, 2) + "\n");
}

export function addBlock(root, tasksDir, demand, block, objective) {
  const dir = blockDir(root, tasksDir, demand, block);
  mkdirSync(join(dir, "council"), { recursive: true });
  mkdirSync(join(dir, "subtasks"), { recursive: true });
  writeStatus(root, tasksDir, demand, block,
    { objective: String(objective ?? ""), state: "in-review", cycle: 0, history: [] });
  return dir;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test tests/planning.test.mjs`
Expected: PASS — 4 tests.

- [ ] **Step 5: Commit**

```bash
git add scripts/planning.mjs tests/planning.test.mjs
git commit -m "feat: add planning scaffold (init demand, add block)"
```

---

## Task 4: Record verdict transition

**Files:**
- Modify: `scripts/planning.mjs`
- Test: `tests/planning.test.mjs`

- [ ] **Step 1: Write the failing tests**

Append to `tests/planning.test.mjs`:

```js
import { recordVerdict } from "../scripts/planning.mjs";

const approve = (lens) => ({ lens, vote: "approve", findings: [] });
const rejectCrit = (lens, note) => ({ lens, vote: "reject", findings: [{ severity: "critical", note }] });

test("recordVerdict approves, bumps cycle, writes cycle file", () => {
  const root = makeRoot();
  initDemand(root, TASKS, "d");
  addBlock(root, TASKS, "d", "b", "obj");
  const v = recordVerdict(root, TASKS, "d", "b", [approve("a"), approve("b")], { maxCycles: 2 });
  assert.equal(v.decision, "approved");
  const status = readStatus(root, TASKS, "d", "b");
  assert.equal(status.state, "approved");
  assert.equal(status.cycle, 1);
  assert.equal(status.history.length, 1);
  assert.ok(existsSync(join(blockDir(root, TASKS, "d", "b"), "council", "cycle-1.md")));
});

test("recordVerdict revises on cycle 1, escalates on cycle 2", () => {
  const root = makeRoot();
  initDemand(root, TASKS, "d");
  addBlock(root, TASKS, "d", "b", "obj");
  const v1 = recordVerdict(root, TASKS, "d", "b", [rejectCrit("sec", "leak")], { maxCycles: 2 });
  assert.equal(v1.decision, "revise");
  assert.equal(readStatus(root, TASKS, "d", "b").state, "in-review");
  const v2 = recordVerdict(root, TASKS, "d", "b", [rejectCrit("sec", "still leaking")], { maxCycles: 2 });
  assert.equal(v2.decision, "escalated");
  assert.equal(readStatus(root, TASKS, "d", "b").cycle, 2);
  assert.equal(readStatus(root, TASKS, "d", "b").state, "escalated");
});
```

Note: `blockDir` is already imported in Step 1 of Task 3? It is not — add `blockDir` to the existing import line at the top of `tests/planning.test.mjs` so it reads:

```js
import { initDemand, addBlock, readStatus, blockDir } from "../scripts/planning.mjs";
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test tests/planning.test.mjs`
Expected: FAIL — `recordVerdict` is not exported.

- [ ] **Step 3: Implement recordVerdict**

Append to `scripts/planning.mjs` (before the CLI section, which is added in Task 6):

```js
function renderCycle(cycle, votes, verdict) {
  const lines = [`# Council cycle ${cycle} — ${verdict.decision}`, ""];
  lines.push(`Approve: ${verdict.approveCount} · Reject: ${verdict.rejectCount}`, "");
  for (const v of votes) {
    lines.push(`## ${v.lens} — ${v.vote}`);
    for (const f of v.findings ?? []) lines.push(`- [${f.severity}] ${f.note}`);
    lines.push("");
  }
  if (verdict.reasons.length) {
    lines.push("## Blocking reasons", ...verdict.reasons.map((r) => `- ${r}`), "");
  }
  return lines.join("\n");
}

export function recordVerdict(root, tasksDir, demand, block, votes, { maxCycles }) {
  const status = readStatus(root, tasksDir, demand, block);
  const cycle = status.cycle + 1;
  const verdict = computeVerdict(votes, { cycle, maxCycles });
  writeFileSync(
    join(blockDir(root, tasksDir, demand, block), "council", `cycle-${cycle}.md`),
    renderCycle(cycle, votes, verdict));
  const state = verdict.decision === "approved" ? "approved"
    : verdict.decision === "escalated" ? "escalated" : "in-review";
  writeStatus(root, tasksDir, demand, block, {
    ...status,
    cycle,
    state,
    history: [...status.history, {
      cycle, decision: verdict.decision, reasons: verdict.reasons,
      approveCount: verdict.approveCount, rejectCount: verdict.rejectCount,
    }],
  });
  return verdict;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test tests/planning.test.mjs`
Expected: PASS — 6 tests.

- [ ] **Step 5: Commit**

```bash
git add scripts/planning.mjs tests/planning.test.mjs
git commit -m "feat: record council verdict and transition block state"
```

---

## Task 5: Promote to todo/ and escalate to backlog/

**Files:**
- Modify: `scripts/planning.mjs`
- Test: `tests/planning.test.mjs`

- [ ] **Step 1: Write the failing tests**

Append to `tests/planning.test.mjs`:

```js
import { promoteBlock, escalateBlock } from "../scripts/planning.mjs";
import { writeFileSync as wf, mkdirSync as md } from "node:fs";

test("promoteBlock moves subtask files into todo/ only when approved", () => {
  const root = makeRoot();
  initDemand(root, TASKS, "d");
  const bdir = addBlock(root, TASKS, "d", "b", "obj");
  wf(join(bdir, "subtasks", "2026-06-17-door-302.md"), "---\ntitle: x\n---\nbody\n");
  // not approved yet → refuses
  assert.throws(() => promoteBlock(root, TASKS, "d", "b"), /not approved/);
  recordVerdict(root, TASKS, "d", "b", [approve("a"), approve("b")], { maxCycles: 2 });
  const moved = promoteBlock(root, TASKS, "d", "b");
  assert.deepEqual(moved, ["2026-06-17-door-302.md"]);
  assert.ok(existsSync(join(root, TASKS, "todo", "2026-06-17-door-302.md")));
});

test("escalateBlock writes a backlog summary only when escalated", () => {
  const root = makeRoot();
  initDemand(root, TASKS, "d");
  addBlock(root, TASKS, "d", "b", "obj");
  assert.throws(() => escalateBlock(root, TASKS, "d", "b"), /not escalated/);
  recordVerdict(root, TASKS, "d", "b", [rejectCrit("sec", "leak")], { maxCycles: 1 });
  const file = escalateBlock(root, TASKS, "d", "b");
  assert.ok(existsSync(file));
  assert.match(readFileSync(file, "utf8"), /leak/);
  assert.match(file, /backlog/);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test tests/planning.test.mjs`
Expected: FAIL — `promoteBlock` / `escalateBlock` not exported.

- [ ] **Step 3: Implement promote and escalate**

Append to `scripts/planning.mjs` (before the CLI section):

```js
export function promoteBlock(root, tasksDir, demand, block) {
  const status = readStatus(root, tasksDir, demand, block);
  if (status.state !== "approved")
    throw new Error(`block ${demand}/${block} is not approved (state=${status.state})`);
  const todo = join(root, tasksDir, "todo");
  mkdirSync(todo, { recursive: true });
  const src = join(blockDir(root, tasksDir, demand, block), "subtasks");
  const moved = [];
  for (const name of readdirSync(src).filter((n) => n.endsWith(".md"))) {
    renameSync(join(src, name), join(todo, name));
    moved.push(name);
  }
  return moved;
}

export function escalateBlock(root, tasksDir, demand, block) {
  const status = readStatus(root, tasksDir, demand, block);
  if (status.state !== "escalated")
    throw new Error(`block ${demand}/${block} is not escalated (state=${status.state})`);
  const backlog = join(root, tasksDir, "backlog");
  mkdirSync(backlog, { recursive: true });
  const file = join(backlog, `escalated-${demand}-${block}.md`);
  const lines = [
    `# ESCALATED: ${demand} / ${block}`, "",
    `**Objective:** ${status.objective}`,
    `**Cycles run:** ${status.cycle}`, "",
    "## Unresolved findings (latest cycle)",
  ];
  const last = status.history[status.history.length - 1];
  for (const r of last?.reasons ?? []) lines.push(`- ${r}`);
  lines.push("", "Human decision required before these subtasks can enter todo/.");
  writeFileSync(file, lines.join("\n") + "\n");
  return file;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test tests/planning.test.mjs`
Expected: PASS — 8 tests.

- [ ] **Step 5: Commit**

```bash
git add scripts/planning.mjs tests/planning.test.mjs
git commit -m "feat: promote approved blocks to todo and escalate exhausted ones"
```

---

## Task 6: Planning CLI dispatch

**Files:**
- Modify: `scripts/planning.mjs`
- Test: `tests/planning.test.mjs`

This wires the exported functions to a command-line interface the team-leader prompt invokes via Bash, resolving `tasksDir` and `maxCycles` from the loaded config.

- [ ] **Step 1: Write the failing test**

Append to `tests/planning.test.mjs`:

```js
import { execFileSync } from "node:child_process";

test("CLI init + add-block via AGENT_TEAM_ROOT", () => {
  const root = makeRoot();
  md(join(root, ".agent-team"), { recursive: true });
  wf(join(root, ".agent-team", "config.json"), JSON.stringify({ governance: { enabled: true } }));
  const env = { ...process.env, AGENT_TEAM_ROOT: root };
  execFileSync("node", ["scripts/planning.mjs", "init", "demo"], { env });
  execFileSync("node", ["scripts/planning.mjs", "add-block", "demo", "blk", "an objective"], { env });
  const status = readStatus(root, TASKS, "demo", "blk");
  assert.equal(status.objective, "an objective");
  assert.equal(status.state, "in-review");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/planning.test.mjs`
Expected: FAIL — CLI does nothing / unknown subcommand.

- [ ] **Step 3: Implement the CLI dispatch**

Append to the end of `scripts/planning.mjs`:

```js
// --- CLI ---------------------------------------------------------------
function isMain() {
  return process.argv[1] && process.argv[1].endsWith("planning.mjs");
}

if (isMain()) {
  const { loadConfig, mainWorktreeRoot } = await import("./lib/config.mjs");
  const root = mainWorktreeRoot();
  const cfg = loadConfig(root);
  const td = cfg.tasksDir;
  const mc = cfg.governance.maxCycles;
  const [cmd, ...rest] = process.argv.slice(2);
  try {
    switch (cmd) {
      case "init":
        process.stdout.write(initDemand(root, td, rest[0]) + "\n");
        break;
      case "add-block":
        process.stdout.write(addBlock(root, td, rest[0], rest[1], rest.slice(2).join(" ")) + "\n");
        break;
      case "verdict": {
        // rest: <demand> <block> <votesJsonFile>
        const votes = JSON.parse(readFileSync(rest[2], "utf8"));
        const v = recordVerdict(root, td, rest[0], rest[1], votes, { maxCycles: mc });
        process.stdout.write(`${v.decision} (approve ${v.approveCount}/${v.approveCount + v.rejectCount})\n`);
        break;
      }
      case "promote":
        process.stdout.write(promoteBlock(root, td, rest[0], rest[1]).join("\n") + "\n");
        break;
      case "escalate":
        process.stdout.write(escalateBlock(root, td, rest[0], rest[1]) + "\n");
        break;
      default:
        process.stderr.write(`unknown command: ${cmd}\n`);
        process.exit(2);
    }
  } catch (err) {
    process.stderr.write(`${err.message}\n`);
    process.exit(1);
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test tests/planning.test.mjs`
Expected: PASS — 9 tests.

- [ ] **Step 5: Run the full suite + shellcheck**

Run: `node --test tests/*.test.mjs && bash tests/dispatch-workers.test.sh && shellcheck scripts/*.sh hooks/*.sh tests/*.sh`
Expected: all green (shellcheck unaffected — new files are `.mjs`).

- [ ] **Step 6: Commit**

```bash
git add scripts/planning.mjs tests/planning.test.mjs
git commit -m "feat: add planning.mjs CLI dispatch"
```

---

## Task 7: Governance Mode in the team-leader command

**Files:**
- Modify: `commands/team-leader.md`

This is prompt content, not executable code — no unit test. The orchestration is described so the team-leader session reliably runs the pipeline and calls `scripts/planning.mjs`.

- [ ] **Step 1: Add the Governance Mode section**

In `commands/team-leader.md`, immediately after the `## Dispatch Mode — Breaking down a goal into tasks` section (before `## Brainstorm Mode`), insert:

````markdown
## Governance Mode — Hierarchical planning before dispatch

Use this mode when `governance.enabled` is `true` in config (check the
`AGENT_TEAM_GOV_ENABLED` env from `dispatch-workers.sh`/`config.mjs --print-env`)
**and** the goal is large enough to warrant requirements + peer review. For
small, clear goals, Dispatch Mode is still fine. The whole pipeline runs as
**sub-agents via the Task tool inside this session** — no new tmux sessions.

All planning artifacts live under `<tasksDir>/planning/<demand-slug>/`, managed
by `scripts/planning.mjs`. Nothing reaches `todo/` without Council approval or
your explicit decision.

### Step 1 — Administrador (1 sub-agent)

```
node "${CLAUDE_PLUGIN_ROOT}/scripts/planning.mjs" init <demand-slug>
```

Dispatch ONE sub-agent (general-purpose) acting as a Product Manager. Its job:
turn the demand into `planning/<demand-slug>/requirements.md` (problem, scope,
constraints, success criteria) and a numbered list of **macro-tasks** in
`planning/<demand-slug>/macro-tasks.md`. It returns the macro-task slugs.

### Step 2 — Arquiteto/Engenheiro (1 sub-agent per macro-task, in parallel)

For each macro-task, register a block and dispatch ONE Solution Designer
sub-agent **in parallel** (send all Task calls in a single message):

```
node "${CLAUDE_PLUGIN_ROOT}/scripts/planning.mjs" add-block <demand-slug> <block-slug> "<objective>"
```

Each Arquiteto sub-agent breaks its block into independently-implementable
subtasks and writes ONE file per subtask into
`planning/<demand-slug>/blocks/<block-slug>/subtasks/YYYY-MM-DD-<slug>.md`,
using the **extended task template** below (note the mandatory
`## CONTEXTO ESTRATÉGICO` block — every subtask must carry the product vision).

### Step 3 — Conselho (N sub-agents per block, in parallel)

For each block, dispatch one reviewer sub-agent **per lens** in
`AGENT_TEAM_GOV_LENSES` (default: requirements, architecture, security,
consistency, redundancy), all in parallel. Each reviewer reads the block's
`subtasks/` and returns a JSON object:

```json
{ "lens": "security", "vote": "approve|reject",
  "findings": [{ "severity": "info|minor|major|critical", "note": "..." }] }
```

Collect the votes into a JSON array file and record the verdict:

```
node "${CLAUDE_PLUGIN_ROOT}/scripts/planning.mjs" verdict <demand-slug> <block-slug> <votes.json>
```

The command prints the decision:
- **approved** → `node .../planning.mjs promote <demand-slug> <block-slug>` (moves subtasks into `todo/`).
- **revise** → re-dispatch that block's Arquiteto sub-agent with the cycle's
  blocking reasons (from `council/cycle-N.md`) to rewrite the subtasks, then
  re-run the Conselho. The verdict command enforces the **2-cycle limit**.
- **escalated** (2 cycles exhausted) → `node .../planning.mjs escalate <demand-slug> <block-slug>`
  (writes a summary into `backlog/`) and **report it to the developer**. Do NOT
  promote an escalated block.

### Step 4 — Handoff

Promoted subtasks are now in `todo/`. Run Worker Dispatch Mode exactly as today;
workers and the reviewer are unchanged.

### Extended task template (Governance Mode subtasks)

```markdown
---
title: <imperative title>
type: ui | backend | refactor | docs | bug | business
role: <worker persona>
project: <demand-slug>
block: <block objective>
acceptance_criteria:
  - <criterion 1>
preview_path:        # UI tasks only
spec:
worktree_branch:
claimed_at:
pr_url:
rejection_reason:
---

## CONTEXTO ESTRATÉGICO
PROJETO: <product vision>
OBJETIVO DO BLOCO: <what this block delivers>
Why this task matters to the larger objective.

## TAREFA
<full description, constraints, links to relevant files>
```
````

- [ ] **Step 2: Verify the section is well-formed**

Run: `grep -n "Governance Mode" commands/team-leader.md`
Expected: matches the new heading. Manually confirm the fenced code blocks are balanced (the outer block uses 4 backticks, inner uses 3).

- [ ] **Step 3: Commit**

```bash
git add commands/team-leader.md
git commit -m "feat: add Governance Mode to team-leader (Administrador/Arquiteto/Conselho)"
```

---

## Task 8: Documentation

**Files:**
- Modify: `docs/configuration.md`
- Modify: `docs/roles.md`
- Modify: `README.md`

- [ ] **Step 1: Document the governance config block**

In `docs/configuration.md`, add a section documenting the new block (match the file's existing table/prose style):

```markdown
### `governance`

Controls the optional hierarchical planning layer (Governance Mode in the
team-leader). Disabled by default — when off, the team-leader uses Dispatch
Mode exactly as before.

| Field | Type | Default | Meaning |
|---|---|---|---|
| `governance.enabled` | boolean | `false` | Turn Governance Mode on. |
| `governance.councilLenses` | string[] | `["requirements","architecture","security","consistency","redundancy"]` | One Conselho reviewer sub-agent is spawned per lens. |
| `governance.maxCycles` | integer ≥ 1 | `2` | Max Conselho correction cycles before a block escalates to `backlog/`. |

Planning artifacts are written under `<tasksDir>/planning/<demand-slug>/`.
```

- [ ] **Step 2: Document the roles in docs/roles.md**

In `docs/roles.md`, add a section (match existing style):

```markdown
## Governance Mode (team-leader)

When `governance.enabled` is true, the team-leader runs a planning pipeline as
sub-agents before dispatching workers:

1. **Administrador** (1 sub-agent) — turns the demand into `requirements.md` and a macro-task list.
2. **Arquiteto/Engenheiro** (1 sub-agent per macro-task) — breaks each macro-task into subtasks carrying strategic context.
3. **Conselho** (N sub-agents per block, one per lens) — peer-reviews the subtasks. A block is approved on a strict majority of approvals with no `critical` finding; any `critical` is a veto. Up to `maxCycles` correction cycles, then the block escalates to `backlog/` for a human decision.

Approved subtasks land in `todo/` and are picked up by workers exactly as in Dispatch Mode. State is tracked under `<tasksDir>/planning/`. See the [Governance Layer design](specs/2026-06-17-governance-layer-design.md).
```

- [ ] **Step 3: Mention it in the README**

In `README.md`, under the "The three roles" section, add a short paragraph after the role table:

```markdown
For large goals, the team-leader can run an optional **Governance Mode** — a
planning pipeline (Administrador → Arquiteto → Conselho peer review) that
produces a reviewed, approved backlog before any worker starts. Enable it with
`governance.enabled` in `.agent-team/config.json`. See
[**Roles in depth**](docs/roles.md#governance-mode-team-leader).
```

- [ ] **Step 4: Verify links resolve**

Run: `grep -rn "2026-06-17-governance-layer-design.md" docs/ && ls docs/specs/2026-06-17-governance-layer-design.md`
Expected: the link target exists.

- [ ] **Step 5: Commit**

```bash
git add docs/configuration.md docs/roles.md README.md
git commit -m "docs: document governance layer (config, roles, README)"
```

---

## Final verification

- [ ] **Run the whole suite**

Run: `node --test tests/*.test.mjs && bash tests/dispatch-workers.test.sh && shellcheck scripts/*.sh hooks/*.sh tests/*.sh`
Expected: all green.

- [ ] **Smoke-test the planning CLI end to end**

```bash
ROOT=$(mktemp -d); mkdir -p "$ROOT/.agent-team"
echo '{"governance":{"enabled":true,"maxCycles":2}}' > "$ROOT/.agent-team/config.json"
export AGENT_TEAM_ROOT="$ROOT"
node scripts/planning.mjs init hotel
node scripts/planning.mjs add-block hotel room-access "Finish room access doors"
mkdir -p "$ROOT/.tasks/planning/hotel/blocks/room-access/subtasks"
echo '---
title: Install door 302
project: hotel
block: Finish room access doors
---
body' > "$ROOT/.tasks/planning/hotel/blocks/room-access/subtasks/2026-06-17-door-302.md"
echo '[{"lens":"security","vote":"approve","findings":[]},{"lens":"architecture","vote":"approve","findings":[]}]' > /tmp/votes.json
node scripts/planning.mjs verdict hotel room-access /tmp/votes.json   # → approved
node scripts/planning.mjs promote hotel room-access                   # → moves file to todo/
ls "$ROOT/.tasks/todo/"                                               # → 2026-06-17-door-302.md
```
Expected: the subtask file ends up in `todo/`.
```
