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
