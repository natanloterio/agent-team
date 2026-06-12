#!/usr/bin/env node
// Stop the trello-sync daemon by SIGTERM'ing the PID in .tasks/.trello-sync.pid.

import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { loadConfig, mainWorktreeRoot } from "./lib/config.mjs";

const repoRoot = mainWorktreeRoot();
const cfg = loadConfig(repoRoot);
const pidPath = join(repoRoot, `${cfg.tasksDir}/.trello-sync.pid`);

if (!existsSync(pidPath)) {
  console.log("No PID file — daemon not running.");
  process.exit(0);
}

const pid = Number(readFileSync(pidPath, "utf8").trim());
if (!Number.isInteger(pid) || pid <= 0) {
  console.error("Invalid PID file contents — removing stale file.");
  unlinkSync(pidPath);
  process.exit(1);
}

try {
  process.kill(pid, "SIGTERM");
  console.log(`Sent SIGTERM to PID ${pid}.`);
} catch (err) {
  if (err.code === "ESRCH") {
    console.log(`Process ${pid} not running — cleaning stale PID file.`);
    unlinkSync(pidPath);
    process.exit(0);
  }
  throw err;
}
