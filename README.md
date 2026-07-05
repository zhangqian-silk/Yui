# TaskMux

TaskMux is a local task board for native agent CLI sessions backed by tmux.

It lets a user create local tasks, assign roles, bind each role to a native agent CLI such as Codex CLI or Claude Code, and switch between role sessions without interrupting the underlying process.

## Package

```sh
npm install -g @zq-silk/taskmux
```

Command entrypoint:

```sh
taskmux
```

Running `taskmux` without arguments runs `doctor` first. If every check passes, TaskMux opens an interactive dashboard that shows the current task, last task, and grouped task board. The dashboard accepts short commands such as `board`, `current task-1`, `open`, `roles`, `enter owner`, and `q`.

## Core Model

- TaskMux stores task data in a user-level data directory.
- Running `taskmux` without arguments opens the local interactive dashboard after passing doctor checks.
- One task maps to one tmux session.
- One role maps to one tmux window.
- Each role window runs one native agent CLI process.
- TaskMux has two protected system roles: global `assistant` for user-facing conversation and task-local `owner` for scheduling task roles.
- Every task includes the system `owner` role. `owner` is created with the task and cannot be renamed.
- Leaving a role means detaching from tmux, not exiting the agent CLI.
- `task status` checks tmux window state and writes detected role status back to storage.
- `task events` lists the append-only local event history for task creation, lifecycle changes, role assignment, and comments.
- `task context` renders a task handoff snapshot across task metadata, roles, comments, events, and optional stored transcripts.
- Agent ids are user configured. Global role presets can bind to agents and are copied into tasks when assigned.

## Example

```sh
taskmux
taskmux setup
taskmux agent add claude --command claude
taskmux role add reviewer --agent claude --workspace ~/projects/app
taskmux board
taskmux task create "Refactor login page" --description "Update the auth form" --priority high --tag frontend --owner alex --due 2026-07-01
taskmux task create "Add export flow" --template feature
taskmux agent add agent-js --command ~/bin/agent-js --arg --model --arg review --env TASKMUX_MODE=dev
taskmux agent list
taskmux agent show agent-js
taskmux task list --owner alex
taskmux task list --tag frontend
taskmux task list --priority high
taskmux task list --search auth
taskmux task board --owner alex --with-roles
taskmux task show task-1
taskmux task current task-1
taskmux task last
taskmux task clone task-1 --title "Follow-up export flow"
taskmux task update task-1 --priority urgent --tag blocked
taskmux task update task-1 --clear-due --clear-owner
taskmux task start task-1
taskmux task done task-1
taskmux task archive task-1
taskmux task reopen task-1
taskmux task delete task-1
taskmux task restore task-1
taskmux task open task-1
taskmux task context task-1
taskmux task context task-1 --format json --include-transcripts
taskmux task shell task-1
taskmux task bind task-1 reviewer
taskmux task assign task-1 rd --agent agent-js --workspace ~/projects/app
taskmux task assign-many task-1 --role rd --role reviewer --agent codex --workspace ~/projects/app
taskmux task assign task-1 reviewer --agent claude --workspace ~/projects/app
taskmux task role update task-1 rd --agent codex --workspace ~/projects/app
taskmux task role rename task-1 rd developer
taskmux task roles task-1
taskmux task comment task-1 "Keep old session compatibility."
taskmux task comments task-1
taskmux task events task-1
taskmux task enter task-1 rd
taskmux task tail task-1 rd
taskmux task detail task-1 rd
taskmux task status task-1 rd
taskmux task refresh task-1
taskmux task transcript task-1 rd
taskmux task transcript export task-1 rd --format markdown --output task-1-rd.md
taskmux task activity task-1
taskmux task timeline task-1
taskmux task detach task-1 rd
taskmux task stop task-1 rd
taskmux task kill task-1 rd
taskmux task restart task-1 rd
taskmux task cleanup task-1
taskmux agent remove agent-js
taskmux doctor
taskmux setup
taskmux backup
taskmux migrate
taskmux migrate --dry-run
taskmux export --output taskmux-snapshot.json
taskmux import taskmux-snapshot.json
taskmux prune --trash
taskmux completion bash
```

Inside the task shell:

```text
taskmux task-42> start
taskmux task-42> r
taskmux task-42> refresh
taskmux task-42> comment "Keep old session compatibility."
taskmux task-42> c
taskmux task-42> e
taskmux task-42> context
taskmux task-42> a
taskmux task-42> t
taskmux task-42> role rename rd developer
taskmux task-42> enter rd
taskmux task-42> restart rd
taskmux task-42> q
```

`enter rd` attaches to the tmux window for the `rd` role. Detaching returns to the task shell while the role process continues running.

## Task Storage

TaskMux stores task data in the user-level data directory:

```text
~/.taskmux
```

Tests, automation, and isolated runs can override this location:

```sh
TASKMUX_HOME=/tmp/taskmux-demo taskmux agent add codex --command codex
TASKMUX_HOME=/tmp/taskmux-demo taskmux config set default-agent codex
TASKMUX_HOME=/tmp/taskmux-demo taskmux task create "Try TaskMux" --workspace "$PWD"
```

The current task command surface is:

```sh
taskmux setup
taskmux agent add codex --command codex
taskmux config set default-agent codex
taskmux config set default-workspace ~/projects/app
taskmux task create "Refactor login page" --description "Update the auth form" --priority high --tag frontend --owner alex --due 2026-07-01
taskmux agent add agent-js --command ~/bin/agent-js --arg --model --arg review --env TASKMUX_MODE=dev
taskmux role add reviewer --agent agent-js --workspace ~/projects/app
taskmux board
taskmux agent list
taskmux agent show agent-js
taskmux task list --owner alex
taskmux task list --tag frontend
taskmux task list --priority high
taskmux task list --search auth
taskmux task board --owner alex --with-roles
taskmux task show task-1
taskmux task current task-1
taskmux task last
taskmux task clone task-1 --title "Follow-up export flow"
taskmux task update task-1 --priority urgent --tag blocked
taskmux task update task-1 --clear-due --clear-owner
taskmux task start task-1
taskmux task done task-1
taskmux task archive task-1
taskmux task reopen task-1
taskmux task delete task-1
taskmux task restore task-1
taskmux task open task-1
taskmux task context task-1
taskmux task context task-1 --format json --include-transcripts
taskmux task shell task-1
taskmux task bind task-1 reviewer
taskmux task assign task-1 rd --agent agent-js --workspace ~/projects/app
taskmux task role update task-1 rd --agent codex --workspace ~/projects/app
taskmux task role rename task-1 rd developer
taskmux task roles task-1
taskmux task comment task-1 "Keep old session compatibility."
taskmux task comments task-1
taskmux task events task-1
taskmux task enter task-1 rd
taskmux task tail task-1 rd
taskmux task detail task-1 rd
taskmux task status task-1 rd
taskmux task refresh task-1
taskmux task transcript task-1 rd
taskmux task detach task-1 rd
taskmux task stop task-1 rd
taskmux task kill task-1 rd
taskmux task restart task-1 rd
taskmux task cleanup task-1
taskmux agent remove agent-js
taskmux doctor
taskmux setup --yes
taskmux backup
taskmux migrate
taskmux completion zsh
```

Agent definitions are user configured with `agent add/list/show/remove`, stored under the TaskMux data directory, and can define a command, repeated args, and environment variables. `taskmux setup` offers built-in common agent CLI candidates such as `codex` and `claude`; each candidate is prechecked locally and shown as `installed` or `missing`, then the user selects by number. A setup-created agent stores the selected name as both id and command with no args or env.

Global role presets are managed with `role add/list/show/update/remove`. A preset stores a role name plus the resolved agent command, args, env, and workspace. Binding a preset into a task copies that data into `tasks/<task-id>/roles/<role>/role.json`; later edits to either the global preset or the task-local role do not affect the other. The protected system roles are `assistant` and `owner`; they cannot be removed. When they are not configured, `role list`, `role show`, and `board` display their agent as `?`.

`role enter assistant` starts the configured `assistant` agent directly in its workspace, giving users a global conversational entry point similar to starting Codex CLI or Claude Code directly.

`config show/set/unset` manages local defaults in `config.json`. `default-agent` is used as a fallback agent id when task creation cannot copy a same-named global role preset. `doctor` reports a missing or invalid `default-agent` as a failed check. `default-workspace` is used by task creation and direct role assignment when explicit values are omitted. TaskMux also stores `currentTaskId` and `lastTaskId` workflow pointers in the same config record.

`task create` creates the `owner` role before returning. `task create --template feature|bug|review` adds template metadata and template roles on top of `owner`: `feature` adds `rd` and `reviewer`, `bug` adds `rd` and `tester`, and `review` adds `reviewer`. Creation copies same-named global role presets when present. If no preset exists, creation uses `--agent` / `--workspace` when provided, then configured defaults; workspace falls back to the current working directory, while the agent must resolve to a configured agent.

`task current [<task-id>]` shows or sets the current task for shorter workflows. `task last` shows the most recently touched task. Task creation, show, open, context, and clone update the last-task pointer. `task clone <task-id> [--title <title>]` creates a new task from an existing task's metadata and assigned roles while resetting cloned roles to `idle`.

Editable task and role labels are separated from runtime state. Task title and task board metadata live in `tasks/<task-id>/info.json`; role name lives in `tasks/<task-id>/roles/<role>/info.json`. Users can edit those `info.json` files directly, and TaskMux reads the edited values on the next command.

Assigned roles are stored under the task directory. Each role runtime record stores `schemaVersion`, agent, command, args, env, workspace, status, and timestamps.

Runtime records with inline task titles or role names are invalid in the current schema.

Task comments are appended to `comments.jsonl` under the task directory and can be listed without entering a role session. Each comment record includes `schemaVersion`.

Task events are appended to `events.jsonl` under the task directory. The current event stream records `task.created`, `task.cloned`, `task.updated`, `task.deleted`, `task.restored`, `task.status_changed`, `role.assigned`, `role.updated`, `role.renamed`, and `comment.added`; each event record includes `schemaVersion`, `id`, `type`, `payload`, and `createdAt`.

`task start`, `task done`, `task archive`, and `task reopen` update the task lifecycle status.

`task update` edits task board metadata and supports `--clear-description`, `--clear-priority`, `--clear-tags`, `--clear-owner`, and `--clear-due`. `task delete` moves a task into `trash/tasks/<task-id>`; `task restore` moves it back without losing task files. `task list` supports `--status`, `--owner`, `--tag`, `--priority`, and `--search` filters. `task board` renders the same filtered task set grouped by `open`, `active`, `done`, and `archived`; `--with-roles` adds stored role status counts.

`task bind <task-id> <role>` copies a global role preset into a task. `task assign` without `--agent` behaves the same; with `--agent`, it creates or replaces a task-local role directly from that agent. `task role update` can replace a task-local role's agent contract and workspace without changing the global preset. `task role rename` updates the role info record and attempts to rename the matching tmux window when it exists; the system `owner` role cannot be renamed. `task enter` uses tmux to create or reuse a task session and role window, starts the stored command with its args and env, attaches the user to that role's native agent CLI, and records the role as `running` after a successful attach. `task tail` reads recent role output with `tmux capture-pane`.

`task assign-many` assigns multiple roles in one command with repeated `--role` values.

`task shell` opens an interactive TaskMux control prompt for the task. Shell commands reuse the same task command handlers as the non-interactive CLI, including task lifecycle, role refresh, cleanup, events, and restart commands. Common shell aliases are `q` for `exit`, `r` for `roles`, `c` for `comments`, `e` for `events`, `a` for `activity`, and `t` for `timeline`.

`task detail` shows stored role metadata and tmux target information. `task status` probes `tmux list-windows`; when the role window exists it reports and persists `running`, when the session exists but the role window is absent it reports and persists `exited`, and when tmux cannot be inspected it keeps the stored status. `task refresh` applies the same detection to every role in a task. `task cleanup` marks stale stored roles according to the current tmux window state without deleting task data. `task transcript` reads tmux capture output and persists it to `roles/<role>/transcript.log`.

`task open` prints a compact task context summary for outer-shell workflows. `task context` prints a full handoff snapshot with task metadata, roles, comments, and events; `--format json` emits the same context as structured JSON, and `--include-transcripts` includes stored `transcript.log` content for each role when present. `task detach` asks tmux to detach clients from the task session while leaving role processes running and records the role as `detached`. `task stop` sends `C-c` to the role window; `task kill` kills the role window. `task restart` kills an existing role window when present, recreates the role window from stored role metadata, attaches to it, and records the role as `running`.

`task transcript export` renders stored transcripts as text, JSON, or Markdown and can write them to a file. `task activity` summarizes role status, agent, transcript line count, and update time. `task timeline` merges task events and comments into one chronological view.

TaskMux maintains a global storage schema manifest at `schema.json` under the configured data directory. Normal task, agent, and role commands check that manifest on startup. If the local storage version is older than the CLI's latest storage version, the command fails with `DATA_ERROR` and tells the user to run `taskmux migrate`.

`backup` creates a timestamped raw copy of the current TaskMux data under `backups/` while excluding older backups from the new copy.

`migrate` runs storage migrations in version order and updates `schema.json` after a successful upgrade. When an older storage version is upgraded, TaskMux creates a backup before running migration steps and prints the backup path. Current task and agent stores only read and write the latest schema; older layouts are handled by migration scripts instead of fallback branches in business commands.

`migrate --dry-run` reports the pending storage migration without writing `schema.json` or creating backups. `export` writes a local JSON snapshot containing config, agents, global role presets, tasks, task roles, comments, events, and stored transcripts. `import` restores that snapshot into the configured TaskMux home. `prune --trash` removes deleted task directories, and `prune --backups --keep-backups <count>` removes older backups after keeping the newest entries.

`setup` interactively configures the required local defaults in `config.json`: the default agent and default workspace. Every interactive run shows the full agent candidate table and workspace prompt, with current values marked or shown as the enter key default. It labels each candidate `installed` or `missing`, stores a selected agent as `id=<name>, command=<name>`, checks tmux, and configures the protected `assistant` and `owner` global role presets with that default agent. In non-interactive environments, setup reports missing config and dependency install plans without blocking. `doctor` and setup status output render as wrapped tables. `doctor` checks Node.js, tmux, configured agent commands, `default-agent`, the configured TaskMux data directory, storage schema status, storage directory read/write permissions, and stored record health. When storage is outdated, `doctor` reports `upgrade-required` and points to `taskmux migrate`. Invalid stored records are reported as `storage records invalid` without aborting the doctor report. Test and managed environments can override the tmux executable with `TASKMUX_TMUX_BIN`.

`completion bash|zsh|fish` prints a shell completion script for the selected shell.

## Data Schema

TaskMux stores versioned local JSON records. Current records use `schemaVersion: 1`.

Storage schema manifest:

```json
{
  "schemaVersion": 1,
  "storageVersion": 1,
  "updatedAt": "2026-06-24T00:00:00.000Z"
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

Role info records use `name`. Role runtime records use `status` values `idle`, `running`, `detached`, `exited`, or `failed`. Comment records use `id`, `body`, and `createdAt`. Event records use `id`, `type`, `payload`, and `createdAt`. Invalid JSON or unsupported schema records fail with `DATA_ERROR`.

Role info record:

```json
{
  "schemaVersion": 1,
  "name": "rd"
}
```

Role runtime records keep execution data separate from the editable name.

Custom agent records also use `schemaVersion: 1`:

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

## Exit Codes

| Code | Name | Meaning |
| --- | --- | --- |
| 0 | OK | Command completed |
| 2 | USAGE_ERROR | Missing or invalid CLI input |
| 3 | TASK_NOT_FOUND / ROLE_NOT_FOUND / AGENT_NOT_FOUND | Requested task, role, or agent does not exist |
| 4 | DATA_ERROR | Stored TaskMux data is unreadable or fails schema validation |
| 5 | RUNTIME_ERROR | Unexpected runtime failure |

## License

MIT

## Release

TaskMux publishes through npm Trusted Publishing from GitHub Actions.

```sh
npm version patch
git push origin master --follow-tags
```

The publish workflow runs on `v*` tags, verifies the tag matches `package.json`, runs build, tests, lint, package dry-run, and publishes `@zq-silk/taskmux` with `npm publish --access public`.
