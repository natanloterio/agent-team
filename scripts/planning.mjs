#!/usr/bin/env node
// State machine + CLI for the governance planning area, .tasks/planning/.
// Exported functions are pure-ish (filesystem only, explicit args) so they can
// be unit-tested; the CLI at the bottom wires them to the loaded config.
import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, renameSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
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
  try { writeFileSync(path, body, { flag: "wx" }); }
  catch (err) { if (err.code !== "EEXIST") throw err; }
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
  const dest = statusPath(root, tasksDir, demand, block);
  const tmp = dest + ".tmp";
  writeFileSync(tmp, JSON.stringify(status, null, 2) + "\n");
  renameSync(tmp, dest);
}

export function addBlock(root, tasksDir, demand, block, objective) {
  const dir = blockDir(root, tasksDir, demand, block);
  if (existsSync(statusPath(root, tasksDir, demand, block)))
    throw new Error(`block ${demand}/${block} already exists`);
  mkdirSync(join(dir, "council"), { recursive: true });
  mkdirSync(join(dir, "subtasks"), { recursive: true });
  writeStatus(root, tasksDir, demand, block,
    { objective: String(objective ?? ""), state: "in-review", cycle: 0, history: [] });
  return dir;
}

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
  if (status.state === "approved" || status.state === "escalated")
    throw new Error(`block ${demand}/${block} is already terminal (state=${status.state})`);
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

// --- CLI ---------------------------------------------------------------
function isMain() {
  return process.argv[1] === fileURLToPath(import.meta.url);
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
        if (!rest[0] || !rest[1] || !rest[2]) {
          process.stderr.write("usage: planning.mjs verdict <demand> <block> <votes.json>\n");
          process.exit(2);
        }
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
