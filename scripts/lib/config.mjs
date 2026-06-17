#!/usr/bin/env node
// Single reader for .agent-team/config.json. Every script — Node directly,
// bash via `--print-env` — gets config through here; nothing else parses it.
import { execSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export const DEFAULTS = Object.freeze({
  prBase: "main",
  maxWorkers: 4,
  tasksDir: ".tasks",
  workerSessionPrefix: "agent-worker-",
  staleWorkerSeconds: 7200,
  devServer: null,
  worktree: Object.freeze({ linkEnvFiles: true }),
  board: Object.freeze({ provider: "none" }),
  governance: Object.freeze({
    enabled: false,
    councilLenses: Object.freeze([
      "requirements", "architecture", "security", "consistency", "redundancy",
    ]),
    maxCycles: 2,
  }),
});

export class ConfigError extends Error {}

export function mainWorktreeRoot() {
  // AGENT_TEAM_ROOT overrides for tests/CI. Otherwise the main worktree is
  // authoritative — gwt symlinks tasksDir into every worktree, so all
  // sessions must anchor on the same root.
  if (process.env.AGENT_TEAM_ROOT) return process.env.AGENT_TEAM_ROOT;
  const out = execSync("git worktree list --porcelain", { encoding: "utf8" });
  for (const line of out.split("\n")) {
    if (line.startsWith("worktree ")) return line.slice("worktree ".length);
  }
  throw new ConfigError("Could not determine main worktree root.");
}

export function configPath(root) {
  return join(root, ".agent-team", "config.json");
}

export function loadConfig(root = mainWorktreeRoot()) {
  const path = configPath(root);
  if (!existsSync(path)) {
    throw new ConfigError(
      `agent-team is not configured (missing ${path}) — run /agent-team:setup`);
  }
  let raw;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch (err) {
    throw new ConfigError(
      `Malformed JSON in ${path}: ${err.message} — fix it or re-run /agent-team:setup`);
  }
  const cfg = {
    ...DEFAULTS,
    ...raw,
    worktree: { ...DEFAULTS.worktree, ...(raw.worktree ?? {}) },
    board: { ...DEFAULTS.board, ...(raw.board ?? {}) },
    governance: { ...DEFAULTS.governance, ...(raw.governance ?? {}) },
  };
  validate(cfg, path);
  return cfg;
}

function validate(cfg, path) {
  const fail = (msg) => { throw new ConfigError(`Invalid config at ${path}: ${msg}`); };
  if (!Number.isInteger(cfg.maxWorkers) || cfg.maxWorkers < 1)
    fail(`maxWorkers must be an integer >= 1, got ${JSON.stringify(cfg.maxWorkers)}`);
  if (typeof cfg.prBase !== "string" || !cfg.prBase)
    fail("prBase must be a non-empty string");
  if (typeof cfg.tasksDir !== "string" || !cfg.tasksDir || cfg.tasksDir.startsWith("/"))
    fail("tasksDir must be a non-empty repo-relative path");
  if (cfg.tasksDir.split("/").includes(".."))
    fail("tasksDir must not contain path traversal (..)");
  if (typeof cfg.workerSessionPrefix !== "string" || !cfg.workerSessionPrefix)
    fail("workerSessionPrefix must be a non-empty string");
  if (!Number.isInteger(cfg.staleWorkerSeconds) || cfg.staleWorkerSeconds < 60)
    fail("staleWorkerSeconds must be an integer >= 60");
  if (typeof cfg.worktree.linkEnvFiles !== "boolean")
    fail("worktree.linkEnvFiles must be a boolean");
  if (cfg.devServer !== null && cfg.devServer !== undefined) {
    if (typeof cfg.devServer !== "object")
      fail("devServer must be an object or null");
    if (typeof cfg.devServer.command !== "string" || !cfg.devServer.command)
      fail("devServer.command must be a non-empty string");
    if (typeof cfg.devServer.url !== "string" || !cfg.devServer.url)
      fail("devServer.url must be a non-empty string");
  }
  if (!["none", "trello"].includes(cfg.board.provider))
    fail(`board.provider must be "none" or "trello", got ${JSON.stringify(cfg.board.provider)}`);
  if (cfg.board.provider === "trello") {
    if (!cfg.board.boardId) fail("board.boardId is required when provider is trello");
    for (const k of ["todo", "doing", "done", "approved"]) {
      if (!cfg.board.listIds?.[k]) fail(`board.listIds.${k} is required when provider is trello`);
    }
    if (!cfg.board.envFile) fail("board.envFile is required when provider is trello");
  }
  const g = cfg.governance;
  if (typeof g.enabled !== "boolean")
    fail("governance.enabled must be a boolean");
  if (!Number.isInteger(g.maxCycles) || g.maxCycles < 1)
    fail(`governance.maxCycles must be an integer >= 1, got ${JSON.stringify(g.maxCycles)}`);
  if (!Array.isArray(g.councilLenses) || g.councilLenses.length < 1
      || !g.councilLenses.every((l) => typeof l === "string" && l))
    fail("governance.councilLenses must be a non-empty array of non-empty strings");
}

function shellQuote(v) {
  return `'${String(v).replace(/'/g, `'\\''`)}'`;
}

if (process.argv[2] === "--print-env") {
  try {
    const root = mainWorktreeRoot();
    const cfg = loadConfig(root);
    const vars = {
      AGENT_TEAM_ROOT: root,
      AGENT_TEAM_PR_BASE: cfg.prBase,
      AGENT_TEAM_MAX_WORKERS: cfg.maxWorkers,
      AGENT_TEAM_TASKS_DIR: cfg.tasksDir,
      AGENT_TEAM_WORKER_PREFIX: cfg.workerSessionPrefix,
      AGENT_TEAM_STALE_SECONDS: cfg.staleWorkerSeconds,
      AGENT_TEAM_LINK_ENV_FILES: cfg.worktree.linkEnvFiles,
      AGENT_TEAM_BOARD_PROVIDER: cfg.board.provider,
      AGENT_TEAM_GOV_ENABLED: cfg.governance.enabled,
      AGENT_TEAM_GOV_MAX_CYCLES: cfg.governance.maxCycles,
      AGENT_TEAM_GOV_LENSES: cfg.governance.councilLenses.join(","),
    };
    process.stdout.write(
      Object.entries(vars).map(([k, v]) => `${k}=${shellQuote(v)}`).join("\n") + "\n");
  } catch (err) {
    process.stderr.write(`${err.message}\n`);
    process.exit(3);
  }
}
