# Runtime And Storage Requirements

## Task Lifecycle

Task status is changed through explicit commands:

| Command | Stored Status |
| --- | --- |
| `task start <task-id>` | `active` |
| `task done <task-id>` | `done` |
| `task archive <task-id>` | `archived` |
| `task reopen <task-id>` | `open` |

Each transition updates `task.json` and refreshes `updatedAt`.

`task delete <task-id>` moves the full task directory to `trash/tasks/<task-id>` and removes it from active task commands. `task restore <task-id>` moves that directory back to `tasks/<task-id>` and preserves task metadata, roles, comments, events, and transcripts.

## Task Event Log

TaskMux records task-level mutations in `events.jsonl` under the task directory. The log is append-only and local to the configured TaskMux home.

The current event stream records:

| Event Type | Trigger | Payload |
| --- | --- | --- |
| `task.created` | `task create` succeeds | `title` |
| `task.cloned` | `task clone` succeeds | `from` |
| `task.updated` | `task update` succeeds | `title` |
| `task.deleted` | `task delete` succeeds | `task` |
| `task.restored` | `task restore` succeeds | `task` |
| `task.status_changed` | `task start`, `task done`, `task archive`, or `task reopen` succeeds | `from`, `to` |
| `role.assigned` | `task assign` succeeds | `role`, `agent` |
| `role.updated` | `task role update` succeeds | `role` |
| `role.renamed` | `task role rename` succeeds | `from`, `to` |
| `comment.added` | `task comment` succeeds | `comment` |

`task events <task-id>` lists events in storage order as `event-id`, timestamp, event type, and key-value payload pairs. A task with no event file returns `No events found.` instead of failing.

## Role Status Detection

`task status <task-id> <role>` is the stable command for checking a role's current execution state.

TaskMux resolves the role from storage, inspects the backing tmux session with `list-windows`, and compares window names against the role name.

- If the role window exists, status is `running`.
- If the task session can be inspected and the role window is absent, status is `exited`.
- If tmux inspection fails, TaskMux keeps the stored role status.

Detected status changes are written back to `role.json` with a refreshed `updatedAt` timestamp.

`task refresh <task-id>` applies the same detection to every assigned role in a task and prints the refreshed role status table.

`task cleanup <task-id>` is non-destructive. It refreshes stored role statuses from the current tmux window state and marks stale role records as `exited`; it does not delete tasks, roles, comments, transcripts, sessions, or windows.

## Role Lifecycle Actions

- Every new task receives the system `owner` role before `task create` returns.
- TaskMux also has the protected global `assistant` role for user-facing conversation through `role enter assistant`.
- `owner` first copies a same-named global role preset when present. Otherwise it uses explicit `--agent` / `--workspace` values when present, then `default-agent` / `default-workspace`. Workspace falls back to the current directory; agent must resolve to a configured agent.
- `task role rename` rejects attempts to rename `owner` or rename another role to `owner`.
- `task enter <task-id> <role>` records the role as `running` after a successful tmux attach command returns.
- `task detach <task-id> <role>` records the role as `detached` after tmux detaches clients from the task session.
- `task stop <task-id> <role>` records the role as `exited` after sending `C-c`.
- `task kill <task-id> <role>` records the role as `exited` after killing the role window.
- `task restart <task-id> <role>` attempts to kill the old role window, recreates the role window from stored role metadata, attaches to it, and records the role as `running`.
- `task role update <task-id> <role>` updates a task-local role's stored agent contract, workspace, or both.
- `task role rename <task-id> <role> <new-role>` updates the editable role name and attempts to rename the matching tmux window. Missing tmux sessions or windows do not block the local role rename.

## Agent Configuration

Agent definitions are managed with:

- `agent add <agent-id> --command <command> [--arg <arg> ...] [--env KEY=value ...]`
- `agent list`
- `agent show <agent-id>`
- `agent remove <agent-id>`

Fresh installs have no configured agents until `setup` or `agent add` writes one. Agent ids may contain letters, numbers, hyphens, and underscores. `codex` and `claude` are normal agent ids that users may bind to Codex CLI and Claude Code.

`task assign --agent <agent-id>` resolves the agent before writing `role.json`. Role records store the resolved `agent`, `command`, `args`, and `env`. Later changes to the agent definition do not mutate already assigned roles. `task role update --agent <agent-id>` resolves the current agent definition and overwrites the task-local role's stored execution contract.

`setup` shows a numbered table of built-in common agent CLI candidates after checking each command locally and marking it `installed` or `missing`. Every interactive run shows the full agent and workspace prompts. Current values are marked or shown as the enter key default, so pressing enter keeps the current value when one exists or accepts the displayed default. The selected agent is stored using the selected name as both id and command with empty args and env when needed, then setup writes default agent and workspace. `doctor` checks configured agent commands with `--version` and reports them as `agent:<agent-id>` in a wrapped table.

`doctor` also checks `default-agent`. Missing `default-agent` is reported as `missing` with guidance to run `taskmux setup`, and a configured default agent that does not resolve to an agent record is reported as `invalid`.

## Global Role Presets

Global role presets are managed with:

- `role add <role> --agent <agent-id> [--workspace <path>]`
- `role list`
- `role show <role>`
- `role update <role> [--agent <agent-id>] [--workspace <path>]`
- `role remove <role>`
- `role enter <role>`

Global role records live under `roles/<role>/role.json`. Binding a global role with `task bind <task-id> <role>` or `task assign <task-id> <role>` without `--agent` creates a task-local copy under `tasks/<task-id>/roles/<role>/`. Later global role changes do not mutate already-bound task roles, and `task role update` does not mutate the global preset.

The protected global role names are `assistant` and `owner`. `role remove assistant` and `role remove owner` fail with `USAGE_ERROR`. When either protected role is not configured, `role list`, `role show`, and `board` display `?` for agent and workspace. When `default-agent` resolves to a configured agent, `setup` configures both protected global roles with that agent and `default-workspace` or the current working directory.

## Defaults And Templates

TaskMux stores user defaults and workflow pointers in `config.json` under the TaskMux home. The first supported user-managed keys are `defaultAgent` and `defaultWorkspace`, managed through `taskmux config show/set/unset`.

`currentTaskId` and `lastTaskId` are TaskMux-managed pointers. `task current [<task-id>]` shows or sets the current pointer. `task last` shows the last touched task. Task creation, clone, show, open, context, and explicit current selection update `lastTaskId`.

Templated task creation assigns common roles and metadata:

| Template | Metadata | Roles |
| --- | --- | --- |
| none | explicit task metadata only | `owner` |
| `feature` | `priority=medium`, `tag=feature` | `owner`, `rd`, `reviewer` |
| `bug` | `priority=high`, `tag=bug` | `owner`, `rd`, `tester` |
| `review` | `priority=medium`, `tag=review` | `owner`, `reviewer` |

`task create --template <name>` may override template metadata with explicit task options. Task creation and template roles first copy same-named global role presets when present. Without a preset, they use explicit `--agent` / `--workspace`, then configured defaults. Workspace falls back to the current working directory; agent has no built-in fallback and must resolve to a configured agent.

`task assign-many` accepts repeated `--role` values and uses explicit or configured default agent/workspace values.

`task clone <task-id> [--title <title>]` creates a new task from the source task's editable metadata and assigned role execution contracts. Cloned roles are reset to `idle` so the user can start fresh native CLI sessions for the copied work.

## Interactive Task Shell

`task shell <task-id>` exposes task control commands without repeating the task id. It accepts the full command names and these aliases:

| Alias | Command |
| --- | --- |
| `q` | `exit` |
| `r` | `roles` |
| `c` | `comments` |
| `e` | `events` |
| `a` | `activity` |
| `t` | `timeline` |

Aliases are normalized before dispatch so they reuse the same command handlers and error behavior as non-interactive commands.

## Error Codes

CLI errors are structured for automation and shell scripts.

| Exit Code | Error Code | Trigger |
| --- | --- | --- |
| 2 | `USAGE_ERROR` | Missing task id, missing role name, missing option values, unsupported agent, empty title, or empty comment |
| 3 | `TASK_NOT_FOUND` | The requested task record does not exist |
| 3 | `ROLE_NOT_FOUND` | The requested role record does not exist under an existing task |
| 3 | `AGENT_NOT_FOUND` | The requested agent id cannot be resolved |
| 4 | `DATA_ERROR` | Stored task, role, comment, event, or agent JSON cannot be parsed or does not match the active schema |
| 5 | `RUNTIME_ERROR` | Unexpected runtime failure |

Non-interactive commands write errors to stderr as `<ERROR_CODE>: <message>` and exit with the mapped code. The interactive task shell prints structured command errors and keeps the shell running.

## Data Schema

TaskMux storage records are local JSON or JSONL files. Every first-version record includes `schemaVersion: 1`.

The TaskMux data directory also contains a global storage schema manifest:

```json
{
  "schemaVersion": 1,
  "storageVersion": 1,
  "updatedAt": "2026-06-24T00:00:00.000Z"
}
```

Normal task, agent, and role commands check the manifest before reading domain records. Missing manifests are initialized to the current storage schema version. Older manifests stop the command with `DATA_ERROR: Storage schema upgrade required: <current> -> <latest>. Run \`taskmux migrate\`.` Newer or invalid manifests also fail with `DATA_ERROR`.

`taskmux backup` creates a timestamped raw copy of the current TaskMux data under `backups/backup-<timestamp>/`. Backup creation copies current storage entries and excludes `backups/` so backup chains do not recursively include previous backups.

`taskmux migrate` runs registered storage migrations in order and writes the latest manifest only after successful migration. When upgrading from an older manifest, TaskMux creates a backup before applying migration steps and prints the backup path. Current business stores do not include fallback readers for older storage layouts; older storage is handled by migration scripts.

`taskmux migrate --dry-run` reports the migration plan without creating backups, running migration steps, or writing `schema.json`.

`taskmux export --output <file>` writes a JSON snapshot containing config, custom agents, global role presets, active tasks, task roles, comments, events, and stored transcripts. `taskmux import <file>` restores that snapshot into the configured TaskMux home. Importing into non-empty storage overwrites tasks and roles with the same ids and appends imported comments and events.

`taskmux prune --trash` removes deleted task directories under `trash/tasks`. `taskmux prune --backups --keep-backups <count>` removes older backups after keeping the newest backup directories.

`doctor` includes `storage schema`, `storage permissions`, and `storage records` checks. Outdated storage is reported as `upgrade-required` with `current`, `latest`, and `run taskmux migrate` guidance. Invalid stored records are reported as `storage records invalid` without aborting the doctor report.

Task info record:

```json
{
  "schemaVersion": 1,
  "title": "Refactor login page",
  "description": "Update the auth form",
  "priority": "high",
  "tags": ["frontend", "auth"],
  "owner": "alex",
  "dueAt": "2026-07-01"
}
```

Config record:

```json
{
  "schemaVersion": 1,
  "defaultAgent": "codex",
  "defaultWorkspace": "/path/to/project",
  "currentTaskId": "task-1",
  "lastTaskId": "task-2"
}
```

Task board metadata fields are stored in `info.json` so users can edit them directly. `description`, `priority`, `tags`, `owner`, and `dueAt` are optional. Priority values are `low`, `medium`, `high`, and `urgent`; due dates use `YYYY-MM-DD`.

`task update` supports clearing optional metadata fields with `--clear-description`, `--clear-priority`, `--clear-tags`, `--clear-owner`, and `--clear-due`.

`task list` and `task board` share the same metadata filter model: status, owner, tag, priority, and case-insensitive search across title, description, owner, priority, due date, and tags. `task board` groups the filtered result set by lifecycle status. `task board --with-roles` appends stored role status counts for each task; it does not probe tmux.

## Task Handoff Context

`task context <task-id>` renders a full handoff snapshot for a task. The snapshot includes:

- Task runtime state and editable metadata
- Assigned roles with agent, status, and workspace
- Stored comments
- Stored events
- Stored role transcripts when `--include-transcripts` is present

The default format is text. `--format json` emits:

```json
{
  "task": {},
  "roles": [],
  "comments": [],
  "events": []
}
```

When transcripts are included, each role may include `transcript` with the stored `transcript.log` content or `null` when no transcript has been captured. `task context` does not call tmux; users capture fresh output with `task transcript <task-id> <role>` first.

`task transcript export <task-id> <role>` renders an already stored transcript as text, JSON, or Markdown and can write the rendered output to a file. Export does not call tmux.

`task activity <task-id>` summarizes assigned roles with agent, status, stored transcript line count, and last update timestamp. `task timeline <task-id>` merges stored events and comments into one chronological view.

Task runtime record:

```json
{
  "schemaVersion": 1,
  "id": "task-1",
  "status": "open",
  "createdAt": "2026-06-23T00:00:00.000Z",
  "updatedAt": "2026-06-23T00:00:00.000Z"
}
```

Role info record:

```json
{
  "schemaVersion": 1,
  "name": "rd"
}
```

Role runtime record:

```json
{
  "schemaVersion": 1,
  "agent": "agent-js",
  "command": "/path/to/agent-js",
  "args": ["--model", "review"],
  "env": {
    "TASKMUX_MODE": "dev"
  },
  "workspace": "/path/to/project",
  "status": "idle",
  "createdAt": "2026-06-23T00:00:00.000Z",
  "updatedAt": "2026-06-23T00:00:00.000Z"
}
```

Comment record:

```json
{
  "schemaVersion": 1,
  "id": "comment-1",
  "body": "Keep old session compatibility.",
  "createdAt": "2026-06-23T00:00:00.000Z"
}
```

Event record:

```json
{
  "schemaVersion": 1,
  "id": "event-1",
  "type": "task.status_changed",
  "payload": {
    "from": "open",
    "to": "active"
  },
  "createdAt": "2026-06-23T00:00:00.000Z"
}
```

Custom agent record:

```json
{
  "schemaVersion": 1,
  "id": "agent-js",
  "command": "/path/to/agent-js",
  "args": ["--model", "review"],
  "env": {
    "TASKMUX_MODE": "dev"
  },
  "createdAt": "2026-06-23T00:00:00.000Z",
  "updatedAt": "2026-06-23T00:00:00.000Z"
}
```

Allowed task statuses are `open`, `active`, `done`, and `archived`. Allowed role statuses are `idle`, `running`, `detached`, `exited`, and `failed`.

Task and role `info.json` files are the supported direct-edit surface. Runtime records remain managed by TaskMux. Task runtime records with inline `title` and role runtime records with inline `name` are invalid in the current schema.
