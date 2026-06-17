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
