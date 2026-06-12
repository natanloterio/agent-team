#!/usr/bin/env node
// Trello Sync Daemon — keeps the configured board in sync with .tasks/ folder state.
//
// Runs from the main repo root. Walks .tasks/{todo,doing,done,approved}/*.md,
// reads `trello_card_id` from each, and PUTs the Trello card to the list that
// matches the file's folder position (approved > done > doing > todo).
//
// Worktree gotcha is handled by the gwt alias symlinking runtime dirs to the
// main repo, so folder location is now a reliable source of truth.
//
// Start:  node scripts/trello-sync.mjs
// Stop:   SIGTERM the PID in .tasks/.trello-sync.pid
// Log:    .tasks/.trello-sync.log (also stdout)

import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { loadConfig, mainWorktreeRoot } from "./lib/config.mjs";

const repoRoot = mainWorktreeRoot();
const cfg = loadConfig(repoRoot);
if (cfg.board.provider !== "trello") {
  console.log("board.provider is not 'trello' — trello-sync has nothing to do. Exiting.");
  process.exit(0);
}
const BOARD_ID = cfg.board.boardId;
const PRECEDENCE = ["approved", "done", "doing", "todo"]; // higher folder wins
const FOLDER_TO_LIST = {
  approved: cfg.board.listIds.approved,
  done: cfg.board.listIds.done,
  doing: cfg.board.listIds.doing,
  todo: cfg.board.listIds.todo,
};

const TICK_MS = 60_000;
const PID_FILE = `${cfg.tasksDir}/.trello-sync.pid`;
const LOG_FILE = `${cfg.tasksDir}/.trello-sync.log`;

function log(line) {
  const entry = `${new Date().toISOString()} ${line}\n`;
  process.stdout.write(entry);
  try {
    appendFileSync(join(repoRoot, LOG_FILE), entry);
  } catch {
    /* log dir may not exist on very first call */
  }
}

function loadCreds() {
  const raw = readFileSync(join(repoRoot, cfg.board.envFile), "utf8");
  const env = {};
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq < 0) continue;
    env[trimmed.slice(0, eq)] = trimmed.slice(eq + 1);
  }
  if (!env.TRELLO_API_KEY || !env.TRELLO_SECRET) {
    throw new Error(`Missing TRELLO_API_KEY or TRELLO_SECRET in ${cfg.board.envFile}`);
  }
  return { key: env.TRELLO_API_KEY, token: env.TRELLO_SECRET };
}

function parseCardId(content) {
  const match = content.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return "";
  const m = match[1].match(/^trello_card_id:\s*(\S+)/m);
  return m ? m[1] : "";
}

// Returns Map<cardId, highest-precedence-folder>
function scanTasks() {
  const byCard = new Map();
  for (const folder of PRECEDENCE) {
    const dir = join(repoRoot, cfg.tasksDir, folder);
    let entries;
    try {
      entries = readdirSync(dir);
    } catch {
      continue;
    }
    for (const name of entries) {
      if (name.startsWith(".") || !name.endsWith(".md")) continue;
      let content;
      try {
        content = readFileSync(join(dir, name), "utf8");
      } catch {
        continue;
      }
      const id = parseCardId(content);
      if (!id) continue;
      if (!byCard.has(id)) byCard.set(id, folder); // PRECEDENCE order means first hit wins
    }
  }
  return byCard;
}

async function trelloRequest(path, init, creds) {
  const sep = path.includes("?") ? "&" : "?";
  const url = `https://api.trello.com${path}${sep}key=${encodeURIComponent(creds.key)}&token=${encodeURIComponent(creds.token)}`;
  const res = await fetch(url, init);
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Trello ${res.status}: ${body.slice(0, 200)}`);
  }
  return res.json();
}

async function tick(creds, announced) {
  let lists;
  try {
    lists = await trelloRequest(
      `/1/boards/${BOARD_ID}/lists?cards=open&card_fields=id,name,idList`,
      undefined,
      creds,
    );
  } catch (err) {
    log(`TICK_ERROR get_lists ${err.message}`);
    return;
  }

  const cardById = new Map();
  const todoAgentsCardIds = new Set();
  const managedListIds = new Set(Object.values(FOLDER_TO_LIST));
  const todoListId = cfg.board.listIds.todo;
  for (const list of lists) {
    if (!managedListIds.has(list.id)) continue;
    for (const card of list.cards) {
      cardById.set(card.id, { idList: list.id, name: card.name });
      if (list.id === todoListId) todoAgentsCardIds.add(card.id);
    }
  }

  const tasksByCard = scanTasks();

  for (const [cardId, folder] of tasksByCard) {
    const card = cardById.get(cardId);
    if (!card) continue;
    const expected = FOLDER_TO_LIST[folder];
    if (card.idList === expected) continue;

    try {
      await trelloRequest(`/1/cards/${cardId}?idList=${expected}`, { method: "PUT" }, creds);
      log(`MOVED card=${cardId} from=${card.idList} to=${expected} (folder=${folder})`);
    } catch (err) {
      log(`MOVE_ERROR card=${cardId} ${err.message}`);
    }
  }

  for (const cardId of todoAgentsCardIds) {
    if (tasksByCard.has(cardId)) continue;
    if (announced.has(cardId)) continue;
    const card = cardById.get(cardId);
    log(`NEW_CARD: ${cardId} "${card.name}"`);
    announced.add(cardId);
  }
}

function writePid() {
  mkdirSync(join(repoRoot, cfg.tasksDir), { recursive: true });
  writeFileSync(join(repoRoot, PID_FILE), String(process.pid));
}

function cleanup() {
  try {
    unlinkSync(join(repoRoot, PID_FILE));
  } catch {
    /* already gone */
  }
}

async function main() {
  writePid();
  log(`BOOT pid=${process.pid} root=${repoRoot}`);

  const creds = loadCreds();
  const announced = new Set();

  let running = false;
  const runTick = async (cause) => {
    if (running) return;
    running = true;
    try {
      log(`TICK cause=${cause}`);
      await tick(creds, announced);
    } catch (err) {
      log(`TICK_FATAL ${err.stack || err.message}`);
    } finally {
      running = false;
    }
  };

  const interval = setInterval(() => void runTick("interval"), TICK_MS);

  const shutdown = (signal) => {
    log(`SHUTDOWN signal=${signal}`);
    clearInterval(interval);
    cleanup();
    process.exit(0);
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));

  await runTick("boot");
}

main().catch((err) => {
  log(`FATAL ${err.stack || err.message}`);
  cleanup();
  process.exit(1);
});
