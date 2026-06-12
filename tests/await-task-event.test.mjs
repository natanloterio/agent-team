import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawn } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";

function makeRepo() {
  const root = mkdtempSync(join(tmpdir(), "agent-team-watch-"));
  mkdirSync(join(root, ".agent-team"), { recursive: true });
  writeFileSync(join(root, ".agent-team", "config.json"), "{}");
  return root;
}

function run(root, timeoutS) {
  const child = spawn("node", ["scripts/await-task-event.mjs", String(timeoutS)],
    { env: { ...process.env, AGENT_TEAM_ROOT: root } });
  let stdout = "";
  child.stdout.on("data", (d) => (stdout += d));
  const exited = new Promise((res) => child.on("exit", (code) => res(code)));
  return { child, exited, out: () => stdout };
}

test("fires EVENT todo on .md creation", async () => {
  const root = makeRepo();
  const w = run(root, 10);
  await sleep(500); // let the watcher arm (it mkdirs todo/ + done/ itself)
  writeFileSync(join(root, ".tasks", "todo", "2026-06-12-x.md"), "x");
  assert.equal(await w.exited, 0);
  assert.match(w.out(), /^EVENT todo 2026-06-12-x\.md$/m);
});

test("fires EVENT done on .md moved in", async () => {
  const root = makeRepo();
  const w = run(root, 10);
  await sleep(500);
  writeFileSync(join(root, ".tasks", "done", "2026-06-12-y.md"), "y");
  assert.equal(await w.exited, 0);
  assert.match(w.out(), /^EVENT done 2026-06-12-y\.md$/m);
});

test("ignores non-.md files and removals; times out", async () => {
  const root = makeRepo();
  mkdirSync(join(root, ".tasks", "todo"), { recursive: true });
  writeFileSync(join(root, ".tasks", "todo", "pre-existing.md"), "p");
  const w = run(root, 3);
  await sleep(500);
  writeFileSync(join(root, ".tasks", "todo", "note.txt"), "n");   // non-.md
  rmSync(join(root, ".tasks", "todo", "pre-existing.md"));          // removal (claim)
  assert.equal(await w.exited, 0);
  assert.match(w.out(), /^TIMEOUT$/m); // neither event woke it
});
