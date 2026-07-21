<p align="right"><strong>English</strong> | <a href="./i18n/README.zh-CN.md">简体中文</a></p>

# TaskMux

TaskMux is a local orchestrator for long-running Codex and Claude work. It keeps its control state in inspectable JSON files, lets tmux own every Agent terminal, and creates deterministic Git worktrees for repository-backed Tasks.

The current implementation restores the useful Role/Agent/session and CLI framework without restoring the later data-maintenance, lease, schedule, and recovery-ledger systems.

## Requirements

- Node.js 20.17+, 22.9+, or 24.x
- Git
- tmux
- Codex CLI or Claude Code CLI

## Setup

```sh
npm install -g @zq-silk/taskmux
taskmux setup
taskmux doctor
```

`setup` is interactive. It detects installed Agent CLIs, asks which Agents to configure, selects the default and Operator Agent, confirms the Operator workspace, and offers shell-completion setup. Running it again preserves existing Tasks and Roles while allowing configuration changes.

`completion` is also interactive, with or without an explicit shell:

```sh
taskmux completion
taskmux completion zsh
```

Both forms confirm the generated script, installation path, and shell startup-file change. The installed completion is generated from the command catalog, including nested subcommands.

TaskMux uses `~/.taskmux` by default. Set `TASKMUX_HOME` to use an isolated home:

```sh
export TASKMUX_HOME=/absolute/path/to/taskmux-home
taskmux setup
```

The home contains `schema.json`, the authoritative `state.json`, Controller discovery files, and managed worktrees. The current storage version is exact and fresh-only; the migration registry exists for future versions, but this release does not migrate older formats.

## Quick start

Register a repository and create a Draft Task:

```sh
taskmux repository add app /absolute/path/to/app --base main
taskmux repository list

taskmux task create "Ship CSV export" --repository <repository-id> --base main
taskmux task update <task-id> --priority high --tags release,csv --due-at 2026-08-01T00:00:00Z
taskmux task update <task-id> --clear-priority --clear-tags --clear-due-at
taskmux task show <task-id>
taskmux task context <task-id>
taskmux task activate <task-id>
```

Use `task context` as the first detailed read of an existing Task. It combines the Task, Brief, active Decisions, recent Milestones, Roles, current and recent WorkItems with their Runs, recent Messages, open and resolved InputRequests, and recent Events. Terminal output keeps histories and long text compact; `taskmux --json task context <task-id>` returns the complete records in the top-level `data` field.

Activation queues the first durable Leader wake. For a repository-backed Task, the Controller first creates one worktree per Role at `<TASKMUX_HOME>/worktrees/<task-id>/<role-name>` on `taskmux/<task-id>/<role-name>`, then starts the Leader. Roles added later receive their own worktree before delivery.

Submit information through Operator:

```sh
taskmux operator submit "Compare CSV and JSON compatibility" --task <task-id>
taskmux operator submit "Investigate a smaller cache design"
taskmux operator enter
```

Without `--task`, `operator submit` creates a new Draft. Drafts accept planning changes but must be activated before Agent execution.

Add a Worker and dispatch a WorkItem:

```sh
taskmux task role add <task-id> implementer --agent codex
taskmux task role list <task-id>

taskmux task work create <task-id> "Implement the exporter" --role implementer
taskmux task work dispatch <work-item-id> --input "Implement and run focused tests"
```

The Worker completes its current Run explicitly:

```sh
taskmux task run yield <run-id> --summary "Implemented the exporter; focused tests pass"
```

Yield atomically completes the Run and WorkItem, appends the result message, and queues the Leader. A Leader never wakes itself; any already-pending Operator or Worker wake remains durable until the Leader is idle.

When an active Leader Run cannot continue without a user decision, it can create a durable InputRequest and yield its Run:

```sh
taskmux task input request <task-id> --question "Which format should be the default?" \
  --choice csv="CSV" --choice json="JSON" --blocks work-item:<work-item-id>
taskmux task input list
taskmux task input show <input-id>
taskmux task input answer <input-id> --choice csv
```

Requests are user-required by default and remain open until answered or cancelled. When the Agent has a safe recommendation, it may attach a choice fallback and explicit timeout:

```sh
taskmux task input request <task-id> --question "Which format should be the default?" \
  --choice csv="CSV" --choice json="JSON" \
  --recommend csv --timeout-seconds 300
```

The recommendation is shown to the user. If no answer arrives, the first Controller scan at or after the deadline atomically applies that exact choice and queues the fixed Leader session to resume. Free-text and user-required requests never auto-resolve.

`task input list` is the authoritative global open-input Inbox; add a Task ID to scope it, or `--all` to include answered and cancelled requests. The Controller also makes one receipt-backed, best-effort delivery to an already-running Operator composer. It never starts or interrupts an Operator for this notification; an absent or busy Operator falls back to the durable Inbox and is reconsidered on a later Controller scan. Answers may be submitted by the user or Operator. An open request prevents unrelated pending wakes and Task completion or archival. The originating Leader may instead run `taskmux task input cancel <task-id> <input-id> --reason "..."`; cancellation does not self-wake it.

Inspect the result:

```sh
taskmux task context <task-id>
```

Use the narrower `task work`, `task message`, `task run`, and Task Knowledge commands when you need one collection or record.

When the requested outcome is finished, complete the Task to stop automatic Leader wakes without deleting its sessions or Role worktrees:

```sh
taskmux task complete <task-id> --summary "CSV export shipped and verified"
taskmux task reopen <task-id>
```

Completed Tasks reject messages, dispatch, enter, retry, and late yields until explicitly reopened. Archive remains terminal and performs tmux/worktree cleanup.
Task lifecycle completion/selection only suggests valid source states: Draft for activate, active for complete, and completed for reopen.

## Sessions and tmux

TaskMux never proxies an interactive Agent terminal. Before `operator enter`, `role enter`, or `task enter` attaches, TaskMux closes readline, leaves raw mode, pauses its stdin, and synchronously hands the terminal to tmux. As a result, native Codex features such as `/model`, slash-command suggestions, full-screen rendering, and key handling remain available.

```sh
taskmux role enter <global-role>
taskmux task enter <task-id> [role]
taskmux task role enter <task-id> <role>
```

Each Role can bind multiple configured Agents, has one active Agent, and keeps a separate native session per Agent binding. Switching Agents preserves dormant sessions; switching is blocked while that Role has an active Run or native process.

Claude session IDs are preallocated at launch. Managed Codex launches use Codex's structured `notify` callback; after a completed turn, the callback records the native thread ID without injecting a session-binding prompt into the model conversation.

## Controller and failure handling

One background Controller runs per `TASKMUX_HOME`:

```sh
taskmux controller status
taskmux controller stop
taskmux controller restart
```

`controller restart` replaces the Controller process and its scheduler/socket services with the currently installed TaskMux version. It does not stop or restart managed tmux/Agent sessions.

Its full reconciliation pass runs every 30 seconds by default; durable state changes still request an immediate pass. The retained loop is:

1. prepare active repository workspaces;
2. stop archived Task tmux sessions and clean only clean worktrees;
3. deliver queued Worker Runs;
4. detect exited active Role processes;
5. dispatch pending Leader wakes when the Leader is idle.

Automated input is sent only through tmux, after an Agent-specific readiness check. A pane-local receipt prevents the same Run from being typed twice after a Controller retry.

If a Role process exits before yielding, the Controller fails that Run and running WorkItem and queues the Leader. Recovery failures are exposed through the small compatibility Jobs view:

```sh
taskmux jobs list
taskmux jobs retry leader-recovery:<task-id>
taskmux task reconcile <task-id>
taskmux task run retry <failed-run-id>
```

`jobs` is not a restored generic queue: it presents durable pending Leader wakes and Leader recovery failures only.

Completion is the reversible execution fence. Archiving is terminal: it fails active Runs, stops the Task's tmux session, and removes each clean Role worktree. Dirty Role worktrees are preserved for deliberate cleanup.

## Management commands

The restored management surface includes:

```sh
taskmux update
taskmux agent add|list|show|update|remove
taskmux role add|list|show|update|remove|bind|enter
taskmux role session record|replace
taskmux repository add|list
```

Agent environment bindings store process-environment variable names, never secret values. Adapter-owned lifecycle arguments cannot be overridden through raw arguments.

## Scope

TaskMux targets one trusted local user on one machine. It intentionally omits Web/API surfaces, distributed coordination, backup/import/export commands, trash/restore, derived indexes, recovery journals, runtime leases, inactivity TTLs, cooldowns, and recurring schedules.

See [ARCHITECTURE.md](./ARCHITECTURE.md) for persistence and scheduling details.

## Development

```sh
npm run build
npm test
npm run lint
```

## License

[MIT](./LICENSE)
