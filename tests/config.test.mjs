import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { loadConfig, ConfigError, DEFAULTS } from "../scripts/lib/config.mjs";

function makeRepo(configBody) {
  const root = mkdtempSync(join(tmpdir(), "agent-team-test-"));
  if (configBody !== undefined) {
    mkdirSync(join(root, ".agent-team"), { recursive: true });
    writeFileSync(join(root, ".agent-team", "config.json"), configBody);
  }
  return root;
}

test("missing config throws ConfigError pointing to setup", () => {
  const root = makeRepo(undefined);
  assert.throws(() => loadConfig(root), (e) =>
    e instanceof ConfigError && /run \/agent-team:setup/.test(e.message));
});

test("malformed JSON throws ConfigError with clear message", () => {
  const root = makeRepo("{not json");
  assert.throws(() => loadConfig(root), (e) =>
    e instanceof ConfigError && /Malformed JSON/.test(e.message));
});

test("defaults applied for missing fields", () => {
  const root = makeRepo(JSON.stringify({ prBase: "dev" }));
  const cfg = loadConfig(root);
  assert.equal(cfg.prBase, "dev");
  assert.equal(cfg.maxWorkers, DEFAULTS.maxWorkers);
  assert.equal(cfg.tasksDir, ".tasks");
  assert.equal(cfg.worktree.linkEnvFiles, true);
  assert.equal(cfg.board.provider, "none");
});

test("invalid maxWorkers rejected", () => {
  const root = makeRepo(JSON.stringify({ maxWorkers: 0 }));
  assert.throws(() => loadConfig(root), /maxWorkers/);
});

test("trello provider requires boardId, listIds, envFile", () => {
  const root = makeRepo(JSON.stringify({ board: { provider: "trello" } }));
  assert.throws(() => loadConfig(root), /boardId/);
});

test("--print-env emits shell-safe lines; exit 3 when unconfigured", () => {
  const ok = makeRepo(JSON.stringify({ prBase: "dev", maxWorkers: 8 }));
  const out = execFileSync("node", ["scripts/lib/config.mjs", "--print-env"],
    { env: { ...process.env, AGENT_TEAM_ROOT: ok }, encoding: "utf8" });
  assert.match(out, /^AGENT_TEAM_ROOT='.*'$/m);
  assert.match(out, /^AGENT_TEAM_PR_BASE='dev'$/m);
  assert.match(out, /^AGENT_TEAM_MAX_WORKERS='8'$/m);

  const bare = makeRepo(undefined);
  assert.throws(() => execFileSync("node", ["scripts/lib/config.mjs", "--print-env"],
    { env: { ...process.env, AGENT_TEAM_ROOT: bare }, encoding: "utf8" }),
    (e) => e.status === 3);
});
