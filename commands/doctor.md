---
name: doctor
description: Check agent-team dependencies, configuration, and daemon health — run when anything misbehaves, or anytime.
---

# agent-team doctor

Run every check below, in order. Print one line per check: `OK <check>` or
`FAIL <check> — <what to do>`. Never stop at the first failure — report all.

## 1. System dependencies

```bash
for dep in git node tmux gh claude; do
  command -v "$dep" >/dev/null && echo "OK $dep" || echo "FAIL $dep — not on PATH"
done
gh auth status >/dev/null 2>&1 && echo "OK gh auth" || echo "FAIL gh auth — run: gh auth login"
```

For each FAIL, tell the user the install command for their platform
(detect with: `command -v apt-get || command -v dnf || command -v pacman || command -v brew`),
as an instruction to run themselves — NEVER run installs for them.

## 2. Platform checks

```bash
# mkdir-lock mechanism (used by the dispatcher)
T=$(mktemp -d); mkdir "$T/lock.d" && rmdir "$T/lock.d" && echo "OK mkdir-lock" || echo "FAIL mkdir-lock"
# fs.watch delivers events on this filesystem
node -e '
const fs = require("fs"), os = require("os"), path = require("path");
const d = fs.mkdtempSync(path.join(os.tmpdir(), "fswatch-"));
const w = fs.watch(d, () => { console.log("OK fs.watch"); process.exit(0); });
fs.writeFileSync(path.join(d, "probe.md"), "x");
setTimeout(() => { console.log("FAIL fs.watch — no event within 2s"); process.exit(0); }, 2000);
'
```

## 3. Configuration

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/lib/config.mjs" --print-env \
  && echo "OK config" || echo "FAIL config — run /agent-team:setup"
```

## 4. Runtime state (only meaningful in a configured repo)

Check, using `$AGENT_TEAM_TASKS_DIR` from the config output above:
- queue skeleton exists (`todo/ doing/ done/ approved/ backlog/`)
- leader-events daemon: PID file present AND `kill -0` succeeds AND socket file exists
- trello-sync daemon (only when `AGENT_TEAM_BOARD_PROVIDER=trello`): PID alive; tail the log for recent errors
- stale dispatch lock: if `.dispatch.lock.d` exists with a dead PID, report it (the next dispatch reclaims it automatically)

## 5. Summary

End with a one-paragraph verdict: fully healthy, or the ordered list of FAILs
with their fixes.
