# Plugin Schema Notes

> Source URLs (verified 2026-06-12):
> - https://code.claude.com/docs/en/plugins
> - https://code.claude.com/docs/en/plugins-reference
> - https://code.claude.com/docs/en/plugin-marketplaces

---

## (a) `plugin.json` — required and optional fields

**Location:** `.claude-plugin/plugin.json` (the `.claude-plugin/` directory must contain only `plugin.json`; all other directories go at the plugin root)

**Only one field is required:**

| Field  | Type   | Required | Notes |
|--------|--------|----------|-------|
| `name` | string | **Yes**  | Kebab-case, no spaces. Used as the skill namespace prefix (e.g. skills load as `/agent-team:worker`) |

**All other fields are optional:**

| Field             | Type            | Notes |
|-------------------|-----------------|-------|
| `displayName`     | string          | Human-readable; may have spaces/casing. Requires CC v2.1.143+ |
| `version`         | string          | Semver. If omitted, git commit SHA is used. Bump on every release or omit for rolling updates |
| `description`     | string          | Shown in plugin manager |
| `author`          | object          | `{ name, email?, url? }` |
| `homepage`        | string          | Documentation URL |
| `repository`      | string          | Source URL |
| `license`         | string          | SPDX identifier (e.g. `"MIT"`) |
| `keywords`        | array           | Discovery tags |
| `defaultEnabled`  | boolean         | Requires CC v2.1.154+; defaults to `true` |
| `$schema`         | string          | Ignored at load time; for editor autocomplete |
| `skills`          | string\|array   | Custom skill dir paths (adds to default `skills/`) |
| `commands`        | string\|array   | Custom command paths (replaces default `commands/`) |
| `agents`          | string\|array   | Custom agent file paths (replaces default `agents/`) |
| `hooks`           | string\|array\|object | Custom hooks path or inline config |
| `mcpServers`      | string\|array\|object | MCP config paths or inline |
| `lspServers`      | string\|array\|object | LSP config paths or inline |
| `outputStyles`    | string\|array   | |
| `experimental.themes`   | string\|array | |
| `experimental.monitors` | string\|array | |
| `userConfig`      | object          | Prompts user at enable time |
| `channels`        | array           | MCP-based message channels |
| `dependencies`    | array           | Other plugins this plugin requires |

**Unrecognized fields** are silently ignored (warn only in `--strict` validate). This means existing `package.json` / DXT / VS Code fields can coexist.

---

## (b) `marketplace.json` — shape for a self-hosted git repo

**Location:** `.claude-plugin/marketplace.json` (same `.claude-plugin/` directory as `plugin.json`)

**Required fields:**

| Field       | Type   | Notes |
|-------------|--------|-------|
| `name`      | string | Kebab-case marketplace identifier. Users install as `plugin-name@<this-name>` |
| `owner`     | object | `{ name: string (required), email?: string }` |
| `plugins`   | array  | List of plugin entries |

**Each plugin entry requires:**

| Field    | Type           | Notes |
|----------|----------------|-------|
| `name`   | string         | Kebab-case |
| `source` | string\|object | Where to fetch the plugin. For same-repo: `"./"`  (relative path starting with `./`, resolved from the marketplace root, i.e. the directory containing `.claude-plugin/`) |

**Optional marketplace-level fields:** `$schema`, `description`, `version`, `metadata.pluginRoot`, `allowCrossMarketplaceDependenciesOn`

**Optional per-plugin-entry fields:** all `plugin.json` metadata fields (`description`, `version`, `author`, `homepage`, `repository`, `license`, `keywords`) plus `category`, `tags`, `strict`, `defaultEnabled`, and component path overrides (`skills`, `commands`, `agents`, `hooks`, `mcpServers`, `lspServers`).

**Self-hosted single-plugin repo pattern** (this repo): the plugin root and the marketplace root are the same directory. The `source` value should be `"./"`.

Users install with:
```
/plugin marketplace add natanloterio/agent-team
/plugin install agent-team@agent-team
```

---

## (c) Hooks — file location and format

**Default location:** `hooks/hooks.json` at the plugin root (NOT inside `.claude-plugin/`)

The file uses the same format as the `hooks` object in `.claude/settings.json`. The outer wrapper key is `"hooks"`:

```json
{
  "hooks": {
    "PostToolUse": [
      {
        "matcher": "Write|Edit",
        "hooks": [
          {
            "type": "command",
            "command": "\"${CLAUDE_PLUGIN_ROOT}\"/scripts/format-code.sh"
          }
        ]
      }
    ]
  }
}
```

You can also declare hooks inline in `plugin.json` via the `hooks` field (accepts path string, array, or inline object), or point to a non-default path.

Supported hook types: `command`, `http`, `mcp_tool`, `prompt`, `agent`.

Supported events: `SessionStart`, `Setup`, `UserPromptSubmit`, `UserPromptExpansion`, `PreToolUse`, `PermissionRequest`, `PermissionDenied`, `PostToolUse`, `PostToolUseFailure`, `PostToolBatch`, `Notification`, `MessageDisplay`, `SubagentStart`, `SubagentStop`, `TaskCreated`, `TaskCompleted`, `Stop`, `StopFailure`, `TeammateIdle`, `InstructionsLoaded`, `ConfigChange`, `CwdChanged`, `FileChanged`, `WorktreeCreate`, `WorktreeRemove`, `PreCompact`, `PostCompact`, `Elicitation`, `ElicitationResult`, `SessionEnd`.

---

## (d) `${CLAUDE_PLUGIN_ROOT}` in command/skill markdown files

`${CLAUDE_PLUGIN_ROOT}` is substituted **everywhere**:

- **Inline in skill and agent content** (markdown body and frontmatter) — substituted before the content reaches the model
- **Hook commands** (`hooks/hooks.json` and inline hooks in `plugin.json`)
- **MCP / LSP server configs** (`.mcp.json`, `.lsp.json`, inline in `plugin.json`)
- **Monitor commands** (`monitors/monitors.json`)
- Also **exported as an environment variable** to hook processes and MCP/LSP server subprocesses

This means our commands/skills CAN reference `${CLAUDE_PLUGIN_ROOT}` in their bash blocks — the substitution happens before the model sees the content. Example in a skill's markdown body:

````markdown
```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/dispatch.mjs" "$ARGUMENTS"
```
````

**In shell-form hooks**, wrap in double-quotes to handle paths with spaces:
```json
"command": "\"${CLAUDE_PLUGIN_ROOT}\"/scripts/notify-leader.sh"
```

**In exec-form hooks** (using `args` array), pass as a single element without extra quoting — the plugin system handles splitting correctly.

Three path variables are available:
- `${CLAUDE_PLUGIN_ROOT}` — plugin installation directory (ephemeral; changes on update)
- `${CLAUDE_PLUGIN_DATA}` — persistent data directory that survives updates (`~/.claude/plugins/data/{id}/`)
- `${CLAUDE_PROJECT_DIR}` — project root where Claude Code was launched

---

## Schema adjustments made to the proposed JSON

### `plugin.json`
No structural adjustments needed. The proposed fields (`name`, `version`, `description`, `author`) are all valid. The only required field (`name`) is present.

### `marketplace.json`
**Adjustment required:** The proposed JSON was missing the required `plugins[].source` field. Since this repo doubles as its own marketplace and the plugin lives at the repo root (same level as `.claude-plugin/`), the source is `"./"`.

Also: the `owner` field structure is correct (`{ name }`) but the proposed JSON had `"owner": { "name": "Natan Loterio" }` which is valid.

The proposed top-level `plugins` array entry was also missing `source`. Added `"source": "./"`.
