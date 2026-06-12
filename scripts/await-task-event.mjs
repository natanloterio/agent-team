#!/usr/bin/env node
// One-shot task-queue watcher: blocks until a *.md lands in <tasksDir>/todo/
// or <tasksDir>/done/, prints one machine-readable line, exits 0.
// The team-leader arms it via Bash run_in_background; the harness re-invokes
// the model when it exits. Usage: node await-task-event.mjs [timeoutSeconds]
//
//   EVENT todo <file>   new task available        → run dispatch
//   EVENT done <file>   worker finished (slot freed) → dispatch + Review Mode
//   TIMEOUT             fallback (default 30 min) → dispatch (reap pass)
import { existsSync, mkdirSync, readdirSync, watch } from "node:fs";
import { join } from "node:path";
import { loadConfig, mainWorktreeRoot } from "./lib/config.mjs";

const DEFAULT_TIMEOUT_S = 1800;
const timeoutS = Number(process.argv[2] ?? DEFAULT_TIMEOUT_S);
if (!Number.isFinite(timeoutS) || timeoutS <= 0) {
  console.error(`Invalid timeout: ${process.argv[2]}`);
  process.exit(1);
}

let root, cfg;
try {
  root = mainWorktreeRoot();
  cfg = loadConfig(root);
} catch (err) {
  console.error(err.message);
  process.exit(1);
}

const dirs = {
  todo: join(root, cfg.tasksDir, "todo"),
  done: join(root, cfg.tasksDir, "done"),
};
for (const d of Object.values(dirs)) mkdirSync(d, { recursive: true });

const listMd = (dir) => new Set(readdirSync(dir).filter((f) => f.endsWith(".md")));
const snapshots = { todo: listMd(dirs.todo), done: listMd(dirs.done) };

const watchers = [];
function fire(line) {
  for (const w of watchers) w.close();
  console.log(line);
  process.exit(0);
}

for (const [kind, dir] of Object.entries(dirs)) {
  watchers.push(watch(dir, (eventType, filename) => {
    // fs.watch reports creation AND deletion as 'rename'; 'change' is a
    // content edit of an existing file — never a queue transition. A file
    // that still exists after a 'rename' is a creation/move-in; a missing
    // one is a removal (e.g. a todo→doing claim), which must NOT wake us.
    if (eventType !== "rename") return;
    if (filename) {
      if (!filename.endsWith(".md")) return;
      if (existsSync(join(dir, filename))) fire(`EVENT ${kind} ${filename}`);
      return;
    }
    // macOS can deliver null filenames: diff against the arm-time snapshot.
    const current = listMd(dir);
    for (const f of current) {
      if (!snapshots[kind].has(f)) fire(`EVENT ${kind} ${f}`);
    }
    snapshots[kind] = current;
  }));
}

setTimeout(() => fire("TIMEOUT"), timeoutS * 1000);
