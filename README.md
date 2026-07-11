# TaskMux

TaskMux is a local controller and task board for long-running native agent CLI sessions backed by tmux.

It lets a user create local tasks, assign roles, bind each role to a native agent CLI such as Codex CLI or Claude Code, and switch between role sessions without interrupting the underlying process.

## Package

```sh
npm install -g @zq-silk/taskmux
```

Command entrypoint:

```sh
taskmux
```

Running `taskmux` without arguments runs `doctor` first. If every check passes, TaskMux opens an interactive dashboard that shows the current task, last task, and grouped task board. The dashboard accepts short commands such as `board`, `current task-1`, `open`, `roles`, `enter leader`, and `q`.

## Core Model

- TaskMux stores task data in a user-level data directory.
- Running `taskmux` without arguments opens the local interactive dashboard after passing doctor checks.
- A Task is a long-lived mission with only an `archived` marker; completion belongs to finite WorkItems, Cycles, and AgentRuns.
- The local Controller auto-starts for ordinary CLI commands, binds to `127.0.0.1`, authenticates with a random token, serializes mutations, deduplicates request ids, coalesces wakeups, and performs inactivity and schedule scans.
- Complete snapshot writes are staged before atomic replacement. Multi-file commands and Scheduler scans commit complete write/delete sets through a replayable domain-transaction journal; Controller startup finishes staged transactions before rebuilding the deletable SQLite index.
- A recursive local watcher reloads valid direct edits into the derived index. Invalid edits remain untouched while the Controller serves its last valid value and records diagnostics under `runtime/logs/`.
- Each successfully dispatched Leader wakeup creates a durable Cycle describing the coalesced trigger reasons; linked WorkItems move from running to completed or failed with their AgentRun outcome.
- One Task maps to one tmux session. Each independent role maps to one tmux window and native Agent session.
- TaskMux has two protected system roles: global `operator` for user-facing CLI administration and task-local `leader` for task stewardship.
- Every task includes the system `leader` role. `leader` is created with the task, immediately receives its first Controller-managed run, and cannot be renamed. Claude Leader session IDs are reserved at Task creation; Codex registers its CLI-assigned `CODEX_THREAD_ID` on first launch because Codex does not accept a caller-selected ID for a new interactive session.
- Child roles contain only descriptive constraints for a parent role. They have no TaskMux-managed Agent session, tmux window, or worktree.
- Leaving a role means detaching from tmux, not exiting the agent CLI.
- `task status` checks tmux window state and writes detected role status back to storage.
- `task events` lists the append-only local event history for task creation, lifecycle changes, role assignment, and comments.
- `task context` renders a task handoff snapshot across task metadata, roles, comments, events, and optional stored transcripts.
- List, board, status, check, role, comment, event, activity, and timeline views render structured records as wrapped tables.
- Agent ids are user configured. Global role presets can bind to agents and are copied into tasks when assigned.

## Example

```sh
taskmux
taskmux setup
taskmux operator
# The Operator opens in the persistent taskmux-operator tmux session.
# `controller start` remains available for explicit lifecycle management.
taskmux controller status
taskmux agent add claude --command claude
taskmux role add reviewer --agent claude --workspace ~/projects/app
taskmux board
taskmux task create "Refactor login page" --description "Update the auth form" --priority high --tag frontend --due 2026-07-01
taskmux task create "Add export flow" --template feature
taskmux agent add agent-js --command ~/bin/agent-js --arg --model --arg review --env TASKMUX_MODE=dev
taskmux agent list
taskmux agent show agent-js
taskmux task list --tag frontend
taskmux task list --priority high
taskmux task list --search auth
taskmux task board --tag frontend --with-roles
taskmux task show task-1
taskmux task current task-1
taskmux task last
taskmux task clone task-1 --title "Follow-up export flow"
taskmux task update task-1 --priority urgent --tag blocked
taskmux task update task-1 --clear-due
taskmux task archive task-1 --reason "Current phase is stable" --summary "Canary complete; revisit at the next release."
taskmux task unarchive task-1
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
taskmux task topic create task-1 --id data-migration --name "Data migration" --description "Schema and compatibility work"
taskmux task topic summarize task-1 --topic architecture --summary "Controller owns all ordinary mutations."
taskmux task input draft task-1 "New user context"
taskmux task input submit task-1
taskmux task cycle create task-1 --cause operator-input --summary "Process submitted context"
taskmux task cycle end task-1 cycle-1 --summary "Submitted context has been incorporated"
taskmux task decision record task-1 --title "Use canary deployment" --rationale "Limit rollback impact" --topic architecture --topic deployment
taskmux task work-item create task-1 --title "Run canary checks" --assignee leader --topic testing --topic deployment
taskmux task role child task-1 risk-reviewer --parent leader --description "Review risks" --expected-output "Risk report"
taskmux task session record task-1 leader --native-id native-session-id
taskmux task dispatch task-1 reviewer --mode resume --work-item work-item-1 --topic testing --input "Continue review"
taskmux task yield task-1 reviewer --summary "Review completed"
taskmux task schedule set task-1 --inactivity-minutes 60 --cooldown-minutes 15 --every-minutes 1440 --next-at 2026-07-12T00:00:00Z
taskmux task worktree create task-1 reviewer --path ../task-1-reviewer --branch taskmux/reviewer
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

Append `--json` to ordinary commands for a stable `{ "ok", "output" }` envelope. Errors use `{ "ok": false, "code", "message", "details" }`. `task context --format json` continues to return the structured Task context directly.

TaskMux-launched role sessions receive `TASKMUX_HOME`, `TASKMUX_TASK_ID`, `TASKMUX_ROLE`, `TASKMUX_RUN_ID`, and `TASKMUX_WORKSPACE`. Scoped commands such as `taskmux task context --format json` and `taskmux task yield --summary "..."` can therefore omit Task and role ids inside a role session.

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
taskmux operator
taskmux agent add codex --command codex
taskmux config set default-agent codex
taskmux config set default-workspace ~/projects/app
taskmux task create "Refactor login page" --description "Update the auth form" --priority high --tag frontend --due 2026-07-01
taskmux agent add agent-js --command ~/bin/agent-js --arg --model --arg review --env TASKMUX_MODE=dev
taskmux role add reviewer --agent agent-js --workspace ~/projects/app
taskmux board
taskmux agent list
taskmux agent show agent-js
taskmux task list --tag frontend
taskmux task list --priority high
taskmux task list --search auth
taskmux task board --tag frontend --with-roles
taskmux task show task-1
taskmux task current task-1
taskmux task last
taskmux task clone task-1 --title "Follow-up export flow"
taskmux task update task-1 --priority urgent --tag blocked
taskmux task update task-1 --clear-due
taskmux task archive task-1
taskmux task unarchive task-1
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
taskmux setup
taskmux backup
taskmux migrate
taskmux completion zsh
```

Agent definitions are user configured with `agent add/list/show/remove`, stored under the TaskMux data directory, and can define a command, repeated args, and environment variables. `taskmux setup` offers built-in common agent CLI candidates such as `codex` and `claude`; each candidate is prechecked locally and shown as `installed` or `missing`, then the user selects by number. A setup-created agent stores the selected name as both id and command with no args or env.

Global role presets are managed with `role add/list/show/update/remove`. A preset stores a role name plus the resolved agent command, args, env, and workspace. Binding a preset into a task copies that data into `tasks/<task-id>/roles/<role>/role.json`; later edits to either the global preset or the task-local role do not affect the other. The protected system roles are `operator` and `leader`; they cannot be removed. When they are not configured, `role list`, `role show`, and `board` display their agent as `?`.

`taskmux operator` enters the protected Operator role. It starts the configured Agent in its workspace and injects local TaskMux context so it can administer the CLI on the user's behalf without performing Task work. `taskmux assistant` remains a compatibility alias for homes created before storage schema v2.

`config show/set/unset` manages local defaults in `config.json`. `default-agent` is used as a fallback agent id when task creation cannot copy a same-named global role preset. `doctor` reports a missing or invalid `default-agent` as a failed check. `default-workspace` is used by task creation and direct role assignment when explicit values are omitted. TaskMux also stores `currentTaskId` and `lastTaskId` workflow pointers in the same config record.

`task create` creates the `leader` role before returning. `task create --template feature|bug|review` adds template metadata and template roles on top of `leader`: `feature` adds `rd` and `reviewer`, `bug` adds `rd` and `tester`, and `review` adds `reviewer`. Creation copies same-named global role presets when present. If no preset exists, creation uses `--agent` / `--workspace` when provided, then configured defaults; workspace falls back to the current working directory, while the agent must resolve to a configured agent.

`task current [<task-id>]` shows or sets the current task for shorter workflows. `task last` shows the most recently touched task. Task creation, show, open, context, and clone update the last-task pointer. `task clone <task-id> [--title <title>]` creates a new task from an existing task's metadata and assigned roles while resetting cloned roles to `idle`.

Editable task and role labels are separated from runtime state. Task title and task board metadata live in `tasks/<task-id>/info.json`; role name lives in `tasks/<task-id>/roles/<role>/info.json`. Users can edit those `info.json` files directly. The Controller watches valid edits and keeps the previous valid value available when an edit is malformed.

`runtime/index.sqlite` contains only derived Task, role, and WorkItem lookup data. It may be deleted at any time and is rebuilt from TaskMux files. `runtime/recovery-journal/` contains complete pending snapshot writes used for crash recovery; successful writes remove their journal entry.

Assigned roles are stored under the task directory. Each role runtime record stores `schemaVersion`, agent, command, args, env, workspace, status, and timestamps.

Runtime records with inline task titles or role names are invalid in the current schema.

Task comments are appended to `comments.jsonl` under the task directory and can be listed without entering a role session. Comments and Cycles accept repeated `--topic` associations. Curated per-Topic context is appended to `topic-summaries.md` with `task topic summarize`.

Task events are appended to `events.jsonl` under the task directory. The event stream records Task changes, archive transitions, role operations, dispatches, AgentRun yields, decisions, milestones, and comments; each event record includes `schemaVersion`, `id`, `type`, `payload`, and `createdAt`.

`task archive` and `task unarchive` update the Task's only terminal-like marker. WorkItem and AgentRun records carry finite execution states.

`task update` edits task board metadata and supports `--clear-description`, `--clear-priority`, `--clear-tags`, and `--clear-due`. `task delete` moves a task into `trash/tasks/<task-id>`; `task restore` moves it back without losing task files. `task list` supports `--archived`, `--tag`, `--priority`, and `--search` filters. `task board` groups the same filtered Task set into `Ongoing` and `Archived`; `--with-roles` adds stored role status counts.

`task bind <task-id> <role>` copies a global role preset into a task. `task assign` without `--agent` behaves the same; with `--agent`, it creates a task-local role directly from that agent. A TaskRole's Agent type is fixed after creation; `task role update` may refresh the same Agent contract or change its workspace. `task role rename` updates the role info record and attempts to rename the matching tmux window when it exists; the system `leader` role cannot be renamed. `task enter` uses tmux to create or reuse a task session and role window, starts the stored command with its args and env, attaches the user to that role's native agent CLI, then commits the `running` status through the Controller. `task tail` reads recent role output with `tmux capture-pane`.

Configured role Skills are loaded from `TASKMUX_HOME/skills/<skill>/SKILL.md` and merged after the applicable TaskMux system Skill. Independent roles whose Leader workspace is a Git repository must have a recorded TaskMux Worktree before dispatch.

`task assign-many` assigns multiple roles in one command with repeated `--role` values.

`task shell` opens an interactive TaskMux control prompt for the Task. Shell commands reuse the same handlers as the non-interactive CLI, including archive, role refresh, cleanup, events, and restart commands. Common shell aliases are `q` for `exit`, `r` for `roles`, `c` for `comments`, `e` for `events`, `a` for `activity`, and `t` for `timeline`.

`task detail` shows stored role metadata and tmux target information. `task status` probes `tmux list-windows`; when the role window exists it reports and persists `running`, when the session exists but the role window is absent it reports and persists `exited`, and when tmux cannot be inspected it keeps the stored status. `task refresh` applies the same detection to every role in a task. `task cleanup` marks stale stored roles according to the current tmux window state without deleting task data. `task transcript` reads tmux capture output and persists it to `roles/<role>/transcript.log`.

`task open` prints a compact task context summary for outer-shell workflows. `task context` prints a full handoff snapshot with task metadata, roles, comments, and events; `--format json` emits the same context as structured JSON, and `--include-transcripts` includes stored `transcript.log` content for each role when present. `task detach` asks tmux to detach clients from the task session while leaving role processes running and records the role as `detached`. `task stop` sends `C-c` to the role window; `task kill` kills the role window. `task restart` kills an existing role window when present, recreates the role window from stored role metadata, attaches to it, and records the role as `running`.

`task transcript export` renders stored transcripts as text, JSON, or Markdown and can write them to a file. `task activity` summarizes role status, agent, transcript line count, and update time. `task timeline` merges task events and comments into one chronological view.

TaskMux maintains a global storage schema manifest at `schema.json` under the configured data directory. Normal task, agent, and role commands check that manifest on startup. Missing storage fails with `DATA_ERROR` and tells the user to run `taskmux setup`; normal commands do not initialize storage. If the local storage version is older than the CLI's latest storage version, the command fails with `DATA_ERROR` and tells the user to run `taskmux migrate`.

`backup` creates a timestamped raw copy of the current TaskMux data under `backups/` while excluding older backups from the new copy. It builds the copy under a private pending name and atomically publishes the completed backup.

`migrate` runs storage migrations in version order after a schema manifest already exists, and updates `schema.json` after a successful upgrade. Missing storage is initialized by `setup`, not by `migrate`. When an older storage version is upgraded, TaskMux creates a backup before running migration steps and prints the backup path. Current task and agent stores only read and write the latest schema; older layouts are handled by migration scripts instead of fallback branches in business commands.

`migrate --dry-run` reports the pending storage migration without writing `schema.json` or creating backups; missing storage reports `setup` guidance instead of an initialization plan. `export` writes a local JSON snapshot containing config, agents, global role presets, tasks, task roles, comments, events, and stored transcripts. `import` restores that snapshot into the configured TaskMux home. `prune --trash` removes deleted task directories, and `prune --backups --keep-backups <count>` removes older backups after keeping the newest entries.

`setup` requires an interactive terminal and configures the required local defaults in `config.json`: the default Agent and default workspace. It also configures the protected `operator` and `leader` global role templates. TaskMux home is `~/.taskmux` by default, or `TASKMUX_HOME` when set. `doctor` checks Node.js, tmux, configured Agent commands, storage schema, permissions, and stored records. Outdated storage is reported as `upgrade-required` with `taskmux migrate` guidance.

`completion bash|zsh|fish` prints a shell completion script for the selected shell.

## Operator Mode

Operator mode uses a native Agent CLI as the TaskMux administrative control surface. The Operator creates and configures Tasks, handles draft/submit input, and manages roles by running `taskmux` commands; it does not perform Task work or become a Leader.

If a fixed Leader session cannot be recovered, TaskMux pauses further Leader wakeups, stores a durable notification under `runtime/operator-notifications/`, and best-effort alerts the active Operator tmux session. Recording or replacing the Leader session clears both the pause and its notification.

Common Operator commands:

```sh
taskmux task board --with-roles
taskmux task create "Implement checkout flow" --priority high --tag frontend
taskmux role add reviewer --agent codex --workspace ~/projects/app
taskmux task assign task-1 reviewer --agent codex --workspace ~/projects/app
taskmux task bind task-1 reviewer
```

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

## Testing

The default suite uses fake executors plus an isolated real tmux server when tmux is installed:

```sh
npm test
```

Real CLI contract smoke checks are opt-in and do not start paid Agent work:

```sh
TASKMUX_SMOKE_CODEX=1 TASKMUX_SMOKE_CLAUDE=1 node --test test/agent-smoke.test.js
```

## License

MIT

## Release

TaskMux publishes through npm Trusted Publishing from GitHub Actions.

```sh
npm version patch
git push origin master --follow-tags
```

The publish workflow runs on `v*` tags, verifies the tag matches `package.json`, runs build, tests, lint, package dry-run, and publishes `@zq-silk/taskmux` with `npm publish --access public`.
