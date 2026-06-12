#!/usr/bin/env node
// Leader Events Daemon — receives push-style notifications from Claude Code
// hooks (Stop, SubagentStop, Notification, SessionStart, SessionEnd) and
// appends classified entries to .tasks/.leader-events.log.
//
// Replaces 60s polling of .tasks/ for "did a worker finish?" / "is a worker
// blocked on permission?" with sub-second pushes. Worker sessions still move
// task files between .tasks/{todo,doing,done,approved}/ as before — this
// daemon just lets the team-leader react in real time.
//
// Listens on a Unix socket at .tasks/.leader-events.sock (no TCP port, no
// cross-project conflicts). The hook bridge at hooks/notify-leader.sh
// posts JSON payloads to it via `curl --unix-socket`.
//
// Start:  node scripts/leader-events.mjs
// Stop:   SIGTERM the PID in .tasks/.leader-events.pid
// Log:    .tasks/.leader-events.log (also stdout)

import {
  appendFileSync,
  chmodSync,
  mkdirSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { loadConfig, mainWorktreeRoot } from "./lib/config.mjs";

const repoRoot = mainWorktreeRoot();
const cfg = loadConfig(repoRoot);
const SOCK_FILE = `${cfg.tasksDir}/.leader-events.sock`;
const PID_FILE = `${cfg.tasksDir}/.leader-events.pid`;
const LOG_FILE = `${cfg.tasksDir}/.leader-events.log`;
const MAX_BODY_BYTES = 256 * 1024;

const sockPath = join(repoRoot, SOCK_FILE);
const pidPath = join(repoRoot, PID_FILE);
const logPath = join(repoRoot, LOG_FILE);

function log(line) {
  const entry = `${new Date().toISOString()} ${line}\n`;
  process.stdout.write(entry);
  try {
    appendFileSync(logPath, entry);
  } catch {
    /* log dir may not exist on very first call */
  }
}

function classify(payload) {
  const event = payload.hook_event_name || "Unknown";
  const cwd = typeof payload.cwd === "string" ? payload.cwd : "";
  const session = (payload.session_id || "").slice(0, 8);
  const marker = "/.worktrees/";
  const idx = cwd.indexOf(marker);
  const isWorker = idx >= 0;
  const worktreeName = isWorker
    ? cwd.slice(idx + marker.length).split("/")[0]
    : "";
  return { event, cwd, session, isWorker, worktreeName };
}

async function readBody(req) {
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > MAX_BODY_BYTES) {
      throw new Error(`body exceeds ${MAX_BODY_BYTES} bytes`);
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function handleRequest(req, res) {
  if (req.method !== "POST" || req.url !== "/event") {
    res.writeHead(404).end();
    return;
  }

  let body;
  try {
    body = await readBody(req);
  } catch (err) {
    log(`READ_ERROR ${err.message}`);
    res.writeHead(413).end();
    return;
  }

  let payload;
  try {
    payload = JSON.parse(body);
  } catch {
    log(`PARSE_ERROR ${body.slice(0, 80)}`);
    res.writeHead(400).end("invalid json");
    return;
  }

  const info = classify(payload);
  const who = info.isWorker ? `worker=${info.worktreeName}` : "leader";
  log(`EVENT ${info.event} ${who} session=${info.session}`);

  res.writeHead(204).end();
}

function writePid() {
  mkdirSync(join(repoRoot, cfg.tasksDir), { recursive: true });
  writeFileSync(pidPath, String(process.pid));
}

function removeStaleSocket() {
  try {
    unlinkSync(sockPath);
  } catch {
    /* not present — fine */
  }
}

function cleanup() {
  try {
    unlinkSync(pidPath);
  } catch {
    /* already gone */
  }
  try {
    unlinkSync(sockPath);
  } catch {
    /* already gone */
  }
}

function main() {
  removeStaleSocket();
  writePid();
  log(`BOOT pid=${process.pid} root=${repoRoot} sock=${SOCK_FILE}`);

  const server = createServer((req, res) => {
    handleRequest(req, res).catch((err) => {
      log(`HANDLE_ERROR ${err.stack || err.message}`);
      try {
        res.writeHead(500).end();
      } catch {
        /* response may already be sent */
      }
    });
  });

  server.on("error", (err) => {
    log(`SERVER_ERROR ${err.message}`);
  });

  server.listen(sockPath, () => {
    // Restrict the socket to the owner so other users on a shared box can't
    // forge events into our team-leader.
    try {
      chmodSync(sockPath, 0o600);
    } catch (err) {
      log(`CHMOD_WARN ${err.message}`);
    }
    log(`LISTEN ${SOCK_FILE}`);
  });

  const shutdown = (signal) => {
    log(`SHUTDOWN signal=${signal}`);
    server.close(() => {
      cleanup();
      process.exit(0);
    });
    setTimeout(() => {
      cleanup();
      process.exit(0);
    }, 1000).unref();
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}

try {
  main();
} catch (err) {
  log(`FATAL ${err.stack || err.message}`);
  cleanup();
  process.exit(1);
}
