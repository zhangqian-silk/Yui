# TaskMux Technical Solution

## Architecture

TaskMux is divided into four stable boundaries:

```text
TaskMux CLI
  -> Task Store
  -> Role Manager
  -> Tmux Manager
  -> Agent Adapter
```

tmux owns persistent terminal execution. TaskMux owns task state, role metadata, comments, task event history, transcript indexing, and user-facing commands.

## Package Boundary

TaskMux is developed as a standalone npm package. The package exports CLI entrypoints only in the first version.

Running `taskmux` without arguments starts the local interactive dashboard. Startup first runs the same doctor checks as `taskmux doctor`; if any check is not `ok`, the dashboard is not opened and the command exits with `DATA_ERROR`. The dashboard is a foreground interactive CLI in the user's current terminal. It does not create a persistent TaskMux tmux home window. Role sessions still use per-task tmux sessions and per-role tmux windows.

`taskmux completion bash|zsh|fish` is implemented in the CLI entrypoint and prints static completion scripts for the current command surface. It does not read storage or require tmux.

## Release Pipeline

TaskMux publishes to npm through GitHub Actions Trusted Publishing.

The release workflow is `.github/workflows/publish.yml` and runs on `v*` tag pushes. It uses the GitHub `npm` environment and grants `id-token: write` so npm can verify the workflow identity through OIDC. The workflow does not read npm tokens, npm passwords, or OTP values.

Release tags are guarded by `scripts/verify-release-tag.mjs`. The script reads `package.json`, expects `GITHUB_REF_NAME` to equal `v<package.version>`, and exits with a non-zero status when the tag format or version does not match.

The publish job runs:

```text
npm ci
npm run verify:release-tag
npm run build
npm test
npm run lint
npm run pack:dry-run
npm publish --access public
```

`npm publish --access public` is required because `@zq-silk/taskmux` is a scoped public package.

## Tmux Manager

The Tmux Manager wraps tmux commands for:

- Checking tmux availability
- Creating task sessions
- Creating role windows
- Attaching to role windows
- Capturing pane output
- Inspecting window state
- Stopping or killing role windows when requested

TaskMux does not implement its own PTY supervisor in the first version.

The current tmux command contract is:

```text
task enter <task-id> <role>
  tmux has-session -t taskmux-<task-id>
  tmux new-session -d -s taskmux-<task-id>          # when missing
  tmux list-windows -t taskmux-<task-id> -F #{window_name}
  tmux new-window -t taskmux-<task-id> -n <role> -c <workspace> <agent shell-command>  # when missing
  tmux attach-session -t taskmux-<task-id>:<role>

task tail <task-id> <role>
  tmux capture-pane -p -t taskmux-<task-id>:<role> -S -80

task transcript <task-id> <role>
  tmux capture-pane -p -t taskmux-<task-id>:<role> -S -80

task status <task-id> <role>
  tmux list-windows -t taskmux-<task-id> -F #{window_name}
  # role window present -> running
  # task session inspectable but role window absent -> exited

task refresh <task-id>
  tmux list-windows -t taskmux-<task-id> -F #{window_name}
  # applied to every stored role for the task

task detach <task-id> <role>
  tmux detach-client -s taskmux-<task-id>

task stop <task-id> <role>
  tmux send-keys -t taskmux-<task-id>:<role> C-c

task kill <task-id> <role>
  tmux kill-window -t taskmux-<task-id>:<role>

task restart <task-id> <role>
  tmux kill-window -t taskmux-<task-id>:<role>  # ignored when already absent
  tmux has-session -t taskmux-<task-id>
  tmux new-session -d -s taskmux-<task-id>      # when missing
  tmux list-windows -t taskmux-<task-id> -F #{window_name}
  tmux new-window -t taskmux-<task-id> -n <role> -c <workspace> <agent>
  tmux attach-session -t taskmux-<task-id>:<role>

task role rename <task-id> <role> <new-role>
  tmux rename-window -t taskmux-<task-id>:<role> <new-role>  # best effort
```

`TASKMUX_TMUX_BIN` can override the tmux executable for tests and controlled environments. Normal users should rely on the default `tmux` executable.

`detectRoleStatus` treats tmux inspection as best-effort. If the tmux command fails, it returns the stored role status so TaskMux does not overwrite state with an uncertain result.

## Doctor

`taskmux doctor` runs environment checks without mutating task state and renders check results as a wrapped table.

Current checks:

- Node.js version from the current process
- tmux executable using `tmux -V`
- configured agent executables using `<agent command> --version`
- resolved TaskMux home directory

The tmux executable path can be overridden with `TASKMUX_TMUX_BIN` for tests and managed environments.

## Agent Adapter

Agent adapters describe how to start a native CLI for a role.

`src/runner/runnerRegistry.ts` resolves user-configured agent records from storage. Fresh installs have no configured agents. Role assignment rejects unsupported agents before writing `role.json`, and task creation rejects missing agent configuration when no same-named global role preset can be copied.

Agent definitions provide:

- Agent id
- Command
- Ordered args
- Environment variables
- Source metadata: `custom`

Custom agent records live in `TASKMUX_HOME/runners/<agent-id>/runner.json` for compatibility with existing local data. Existing task roles store the resolved command contract so later agent edits do not silently change already assigned roles.

`taskmux setup` requires an interactive terminal and guides the user through the required local defaults: `default-agent` and `default-workspace`. Setup first initializes the TaskMux home resolved by the normal resolver, then writes the schema manifest before any config, role, or workspace data. Every run renders the built-in common agent CLI candidates as a numbered table, probes each candidate locally, marks the current agent when present, and labels candidates `installed` or `missing`. Selecting a candidate only requires its name; pressing enter keeps the current agent or accepts the displayed default. Setup persists the selected name as both agent id and command with empty args and env, creates `<taskmux-home>/workspace`, writes it as `default-workspace`, and writes the protected `assistant` and `leader` global role presets when the agent resolves. If tmux is missing, setup prints install guidance and asks before executing package-manager commands. Non-interactive invocations fail with guidance to use `taskmux config set default-agent <agent-id>` and `taskmux config set default-workspace <path>`. Setup finishes with a concise completion message plus tmux status or install guidance; `taskmux config show` remains the explicit command for configuration status.

## Global Role Presets

Global role presets live under `TASKMUX_HOME/roles/<role>/role.json`. A global role stores a role name plus the resolved agent command, args, env, workspace, and timestamps.

`task bind <task-id> <role>` and `task assign <task-id> <role>` without `--agent` copy the global role into `TASKMUX_HOME/tasks/<task-id>/roles/<role>/`. The copied task role is independent: later `role update` changes only the global preset, and later `task role update` changes only the task-local copy.

The protected global role names are `assistant` and `leader`. They always appear in global role and board views; missing protected role configuration is rendered as `?`. They cannot be removed. `taskmux assistant` and `role enter assistant` start the configured assistant agent directly in its workspace as the global user-facing conversation entry point.

Assistant entry writes `assistant/TASKMUX_ASSISTANT.md` under TaskMux home and injects `TASKMUX_HOME`, `TASKMUX_ROLE`, `TASKMUX_WORKSPACE`, and `TASKMUX_ASSISTANT_CONTEXT` into the agent process. The context tells the assistant to manage TaskMux through CLI commands such as `taskmux task create`, `taskmux role add`, `taskmux task assign`, and `taskmux task bind` instead of directly editing JSON storage. When the assistant command is Codex CLI and the stored assistant args are empty, TaskMux passes an initial prompt pointing Codex at the generated context.

Tmux starts roles with one shell-command argument assembled from the stored role command, env, and args. Example:

```text
env TASKMUX_MODE=dev /path/to/agent-js --model review
```

## Config And Templates

`config.json` lives at the TaskMux home root and is read through `FileTaskStore.getConfig`.

The first config schema stores:

```json
{
  "schemaVersion": 1,
  "defaultAgent": "codex",
  "defaultWorkspace": "/path/to/project",
  "currentTaskId": "task-1",
  "lastTaskId": "task-2"
}
```

`src/commands/configCommands.ts` owns `config show/set/unset`. `task create`, `task create --template`, and `task assign-many` read these defaults through the `TaskStore` boundary. Task workflow commands update `currentTaskId` and `lastTaskId` through the same config boundary so pointer state remains separate from task runtime records.

Built-in templates live in `src/commands/taskCommands.ts` because they compose task metadata and role assignment in one use case. Templates do not introduce a new storage record type; they create normal task, role, and event records. Every task creation includes the system `leader` role before template roles are added. `leader` cannot be renamed.

## Interactive Task Shell

The interactive shell is implemented in `src/shell/taskShell.ts`. It loads a task, prints the same summary as `task open`, then maps shell commands to existing task commands.

Examples:

```text
summary -> task open <task-id>
start -> task start <task-id>
done -> task done <task-id>
archive -> task archive <task-id>
reopen -> task reopen <task-id>
delete -> task delete <task-id>
roles -> task roles <task-id>
r -> task roles <task-id>
comments -> task comments <task-id>
c -> task comments <task-id>
events -> task events <task-id>
e -> task events <task-id>
context -> task context <task-id>
refresh -> task refresh <task-id>
cleanup -> task cleanup <task-id>
role update <role> ... -> task role update <task-id> <role> ...
role rename <role> <new-role> -> task role rename <task-id> <role> <new-role>
comment <body> -> task comment <task-id> <body>
enter <role> -> task enter <task-id> <role>
restart <role> -> task restart <task-id> <role>
activity -> task activity <task-id>
a -> task activity <task-id>
timeline -> task timeline <task-id>
t -> task timeline <task-id>
assign-many --role <role> ... -> task assign-many <task-id> --role <role> ...
transcript export <role> ... -> task transcript export <task-id> <role> ...
q -> exit
```

The shell does not implement separate business logic and does not intercept native Codex or Claude input after `enter`.

Structured `CliError` failures are printed in the shell without closing the prompt. Non-interactive commands let `src/cli.ts` convert the same error type into stderr and a process exit code.

## Storage

TaskMux stores state in a user-level data directory. The first version may use JSON and JSONL files.

The storage layer must keep task state independent from project workspace contents.

The current storage implementation uses:

```text
TASKMUX_HOME or ~/.taskmux
  config.json
  schema.json
  backups/
    backup-<timestamp>/
  trash/
    tasks/
      task-1/
  tasks/
    task-1/
      info.json
      task.json
      events.jsonl
```

`schema.json` stores the global storage schema manifest: `schemaVersion`, `storageVersion`, and `updatedAt`. `info.json` stores the user-editable task title and task board metadata: `description`, `priority`, `tags`, and `dueAt`. `task.json` stores runtime state: `schemaVersion`, `id`, `status`, `createdAt`, and `updatedAt`. `FileTaskStore` owns id allocation, task persistence, task listing, task lookup, and task lifecycle status writes. The CLI resolves the data directory once and passes the store into task command handlers.

`config.json` stores local defaults for agent and workspace plus current and last task pointers. The config parser validates `schemaVersion: 1` and optional string fields before returning values to commands.

Task board commands live in `src/commands/taskCommands.ts`. `task create` and `task update` compose task title and metadata writes before saving through `TaskStore`; clear flags write `undefined` optional metadata so JSON encoding omits those fields. `task list` and `task board` share one filter parser for status, tag, priority, and search. Both commands render wrapped tables through `src/output/table.ts`; `task board` keeps lifecycle grouping in a `Status` column for `open`, `active`, `done`, and `archived`. `task board --with-roles` reads stored roles and appends status counts without tmux probes.

`task create` composes task metadata and role assignment in one command. It copies same-named global role presets when present; otherwise it resolves the configured agent before saving task data. It saves the task, records `task.created`, then creates the system `leader` role and any template roles. Each role write records a `role.assigned` event.

`task current` and `task last` are pointer commands over `config.json`. `task current <task-id>` validates that the task exists, then writes both `currentTaskId` and `lastTaskId`. Commands that make a task the obvious focus, including create, clone, show, open, and context, update `lastTaskId`.

`task clone` composes normal task and role records. It reads the source task and roles, creates a new task id, copies editable metadata unless `--title` is supplied, copies role agent contracts and workspace values, resets cloned role status to `idle`, and records `task.created`, `task.cloned`, and cloned `role.assigned` events on the new task.

`task context` composes a handoff snapshot from the same store boundary. It reads the task, roles, comments, and events, then renders either text or JSON. `--include-transcripts` reads persisted `roles/<role>/transcript.log` files through `TaskStore.readTranscript`; it does not call tmux or mutate transcript state.

`task transcript export` also reads persisted transcript files only. It renders text, JSON, or Markdown and optionally writes the rendered output to a user-provided path. `task activity` reads roles and stored transcripts to compute transcript line counts. `task timeline` merges event and comment records by timestamp.

`task delete` and `task restore` are implemented as directory moves in `FileTaskStore`. Delete moves `tasks/<task-id>` into `trash/tasks/<task-id>` and active task reads no longer see it. Restore moves the same directory back and preserves nested roles, comments, events, and transcripts.

Role assignment uses the same store boundary:

```text
TASKMUX_HOME or ~/.taskmux
  runners/                  # compatibility storage path for agents
    agent-js/
      runner.json
  roles/
    reviewer/
      role.json
  tasks/
    task-1/
      roles/
        rd/
          info.json
          role.json
```

Agent `runner.json` records store `schemaVersion`, `id`, `command`, `args`, `env`, `createdAt`, and `updatedAt`.

`info.json` stores the user-editable role name. Task-local `role.json` stores runtime state: `schemaVersion`, `agent`, `command`, `args`, `env`, `workspace`, `status`, `createdAt`, and `updatedAt`. Runtime records containing inline task title or role name are rejected by the current schema. Role runtime records must include the resolved command contract (`command`, `args`, and `env`) so tmux can restart roles from persisted state without consulting mutable agent definitions. `task role update` overwrites that command contract or workspace while preserving status and created time. `task role rename` updates the role info record in its existing storage directory and calls `TmuxManager.renameRole` best effort, except the system `leader` role cannot be renamed. The first stable role status is `idle`; `task enter` writes `running`, `task detach` writes `detached`, and `task stop` / `task kill` write `exited`. `task status`, `task refresh`, and `task cleanup` refresh role status from tmux when possible and write detected changes back to `role.json`; `task detail` reads stored role metadata without probing tmux.

Task comments are append-only JSONL records:

```text
TASKMUX_HOME or ~/.taskmux
  tasks/
    task-1/
      comments.jsonl
```

Each comment stores `schemaVersion`, `id`, `body`, and `createdAt`. The first version derives comment ids from the current comment count for the task.

Task events are append-only JSONL records:

```text
TASKMUX_HOME or ~/.taskmux
  tasks/
    task-1/
      events.jsonl
```

Each event stores `schemaVersion`, `id`, `type`, `payload`, and `createdAt`. `src/event/taskEvent.ts` defines the event record shape. `FileTaskStore` derives event ids from the current event count for the task and validates every loaded event before returning it to command handlers.

The command layer appends events only after the underlying user-visible mutation succeeds. Current event types are `task.created`, `task.cloned`, `task.updated`, `task.deleted`, `task.restored`, `task.status_changed`, `role.assigned`, `role.updated`, `role.renamed`, and `comment.added`.

Storage reads validate JSON records before returning domain objects:

- Task info records require `schemaVersion: 1` and string title. Optional task board metadata requires string description, priority `low|medium|high|urgent`, string-array tags, and string due date. Task runtime records require `schemaVersion: 1`, string ids and timestamps, and a valid task status.
- Role info records require `schemaVersion: 1` and string name. Role runtime records require `schemaVersion: 1`, string agent, string command, string-array args, string-map env, workspace, timestamps, and a valid role status.
- Comment records require `schemaVersion: 1`, string id, body, and timestamp.
- Event records require `schemaVersion: 1`, string id, string type, string-map payload, and timestamp.
- Agent records require `schemaVersion: 1`, string id, string command, string-array args, string-map env, and timestamps.
- Global role records require `schemaVersion: 1`, string role name, agent, command, string-array args, string-map env, workspace, and timestamps.

Invalid records raise `DATA_ERROR` instead of being skipped silently.

Controller-backed reads wrap `FileTaskStore` with `createResilientTaskStore`. The wrapper refreshes cached values after valid reads and returns the method's last valid value when a later direct edit fails schema validation. Startup and file-watcher refreshes prime individual Task, role, Cycle, WorkItem, milestone, decision, session, and runner lookup paths. Invalid edits remain untouched and are recorded in `runtime/logs/controller.jsonl`.

Snapshot writes use `src/storage/recoveryJournal.ts`. Each write first stages a complete target-relative payload under `runtime/recovery-journal/`, atomically replaces the snapshot, and removes the staged record. Controller startup replays any records left by an interrupted process before accepting requests.

`src/storage/derivedIndex.ts` rebuilds `runtime/index.sqlite` from authoritative files. The index contains Task, role, and WorkItem lookup tables only; it is refreshed on startup, Controller mutations, scheduler scans, and valid file-watcher reloads. A missing or corrupt index is deleted and rebuilt without changing Task data.

`src/storage/taskRecordCodec.ts` owns task and role record encoding, decoding, and composition for the current storage schema. `FileTaskStore` only resolves file paths and raw file IO for these records. Cross-version upgrade handling belongs to the storage schema and migration boundary, not to fallback branches inside business stores.

`src/storage/storageSchema.ts` owns the global storage schema manifest, startup preflight, and migration runner. Normal `task`, `agent`, and `role` commands call the preflight before constructing business stores. Missing storage raises `DATA_ERROR` with `taskmux setup` guidance. Outdated storage raises `DATA_ERROR` with `taskmux migrate` guidance; preflight does not initialize missing storage or let business commands read older layouts.

Storage migrations live under `src/storage/migrations/` and are registered by the migration runner. Each migration handles one version step. `taskmux migrate` runs the required steps in order and writes the latest `schema.json` only after all required migrations complete. Missing storage is initialized by `taskmux setup`, not by migration commands.

`taskmux migrate --dry-run` uses the schema inspector only. It does not call the migration runner, create backups, or write the manifest.

`src/storage/storageBackup.ts` owns raw storage backups. `taskmux backup` creates `backups/backup-<timestamp>/` under the TaskMux home and copies all current storage entries except `backups/`. `taskmux migrate` creates a backup before applying migrations from an older schema version and includes that backup path in command output.

`src/commands/maintenanceCommands.ts` owns export, import, and prune. Export builds a JSON snapshot through store APIs. Import restores config, custom agents, global role presets, tasks, task roles, transcripts, comments, and events through the same store write APIs. Prune removes trash task directories and old backup directories by filesystem path under the configured TaskMux home.

`doctor` calls the storage schema inspector without initializing or upgrading storage. It reports missing storage with `taskmux setup` guidance, reports outdated storage as `upgrade-required`, and keeps upgrade execution behind the explicit `taskmux migrate` command. Doctor also checks `default-agent`, TaskMux home accessibility, storage read/write permission without writing probe files, and scans stored task, global role, task role, and agent records through the current store validators only when the schema is current. Missing or unresolved `default-agent` is a failed doctor check. Record validation failures are reported as `storage records invalid` instead of aborting the doctor report.

## Error Handling

`src/errors/cliError.ts` defines the CLI error contract.

| Error Code | Exit Code |
| --- | --- |
| `USAGE_ERROR` | 2 |
| `TASK_NOT_FOUND` | 3 |
| `ROLE_NOT_FOUND` | 3 |
| `AGENT_NOT_FOUND` | 3 |
| `DATA_ERROR` | 4 |
| `RUNTIME_ERROR` | 5 |

Command handlers throw `CliError` for expected user, lookup, and storage failures. The CLI entrypoint prints `<ERROR_CODE>: <message>` to stderr and exits with the mapped code. Unexpected errors are wrapped as `RUNTIME_ERROR` at the process boundary.

## Observability

TaskMux reads recent role output through tmux capture APIs. The first version exposes role detail, tail, transcript, and task event history without attaching to the role.

Controller infrastructure diagnostics are append-only JSONL records under `runtime/logs/controller.jsonl`. Storage reload and scheduler errors stay out of the curated Task timeline.

`task detail` combines role name from `info.json` with runtime metadata from `role.json` and derives the tmux target as `taskmux-<task-id>:<role>`. `task status` probes tmux window state and persists detected status changes. `task refresh` and `task cleanup` apply the same probe to every role in a task. `task transcript` reads tmux capture output and persists it to `roles/<role>/transcript.log`.

`task events` reads `events.jsonl` and prints event id, timestamp, type, and payload key-value pairs. `task open` reads task, role, and comment counts from storage and prints a task context summary. `task context` produces a fuller handoff snapshot, with JSON output available for automation. `task shell` provides an interactive wrapper over the same task command handlers, including `events` and `context`. `task detach` detaches tmux clients for the task session and does not terminate the role process.

## Testing Strategy

Domain behavior should be tested without requiring tmux. Tmux command construction and process integration should be isolated behind interfaces so unit tests can use fakes.

End-to-end tmux tests should be added only after the command surface and tmux manager interface stabilize.
