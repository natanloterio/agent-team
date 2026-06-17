import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { initDemand, addBlock, readStatus, blockDir } from "../scripts/planning.mjs";

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
