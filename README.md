<p align="right"><strong>English</strong> | <a href="./i18n/README.zh-CN.md">简体中文</a></p>

# Yui

Yui is a local orchestrator for long-running Codex and Claude work. It keeps its control state in inspectable JSON files, lets tmux own every Agent terminal, and creates deterministic Git worktrees for repository-backed Tasks.

The current implementation restores the useful Role/Agent/session and CLI framework without restoring the later data-maintenance, lease, schedule, and recovery-ledger systems.

## Requirements

- Node.js 20.17+, 22.9+, or 24.x
- Git
- tmux
- Codex CLI or Claude Code CLI

## Setup

```sh
npm install -g @zq-silk/yui
yui setup
yui doctor
```

`setup` is interactive. It detects installed Agent CLIs, asks which Agents to configure, selects the default and Operator Agent, confirms the Operator workspace, and offers shell-completion setup. Running it again preserves existing Tasks and Roles while allowing configuration changes.

`completion` is also interactive, with or without an explicit shell:

```sh
yui completion
yui completion zsh
```

Both forms confirm the generated script, installation path, and shell startup-file change. The installed completion is generated from the command catalog, including nested subcommands.

Yui uses `~/.yui` by default. Set `YUI_HOME` to use an isolated home:

```sh
export YUI_HOME=/absolute/path/to/yui-home
yui setup
```

The home contains `schema.json`, the authoritative `state.json`, Controller discovery files, and managed worktrees. The current storage version is exact and fresh-only; the migration registry exists for future versions, but this release does not migrate older formats.

## Quick start

Register a repository and create a Draft Task:

```sh
yui repository add app /absolute/path/to/app --base main
yui repository list

yui task create "Ship CSV export" --repository <repository-id> --base main
yui task update <task-id> --priority high --tags release,csv --due-at 2026-08-01T00:00:00Z
yui task update <task-id> --clear-priority --clear-tags --clear-due-at
yui task show <task-id>
yui task context <task-id>
yui task activate <task-id>
```

Use `task context` as the first detailed read of an existing Task. It combines the Task, Brief, active Decisions, recent Milestones, Roles, current and recent WorkItems with their Runs, recent Messages, open and resolved InputRequests, and recent Events. Terminal output keeps histories and long text compact; `yui --json task context <task-id>` returns the complete records in the top-level `data` field.

Human-facing timestamps default to Beijing time (`Asia/Shanghai`) while durable
records and `--json` data remain UTC/RFC 3339. Inspect or change the IANA
timezone with:

```sh
yui config show
yui config set --time-zone Europe/London
```

Activation queues the first durable Leader wake. For a repository-backed Task, the Controller first creates one worktree per Role at `<YUI_HOME>/worktrees/<task-id>/<role-name>` on `yui/<task-id>/<role-name>`, then starts the Leader. Roles added later receive their own worktree before delivery.

Submit information through Operator:

```sh
yui operator submit "Compare CSV and JSON compatibility" --task <task-id>
yui operator submit "Investigate a smaller cache design"
yui operator enter
```

Without `--task`, `operator submit` creates a new Draft. Drafts accept planning changes but must be activated before Agent execution.

Add a Worker and dispatch a WorkItem:

```sh
yui task role add <task-id> implementer --agent codex
yui task role list <task-id>

yui task work create <task-id> "Implement the exporter" --role implementer
yui task work dispatch <work-item-id> --input "Implement and run focused tests"
```

The Worker completes its current Run explicitly:

```sh
yui task run yield <run-id> --summary "Implemented the exporter; focused tests pass"
```

Yield atomically completes the Run and WorkItem, appends the result message, and queues the Leader. A Leader never wakes itself; any already-pending Operator or Worker wake remains durable until the Leader is idle.

When an active Leader Run cannot continue without a user decision, it can create a durable InputRequest and yield its Run:

```sh
yui task input request <task-id> --question "Which format should be the default?" \
  --choice csv="CSV" --choice json="JSON" --blocks work-item:<work-item-id>
yui task input list
yui task input show <input-id>
yui task input answer <input-id> --choice csv
```

Requests are user-required by default and remain open until answered or cancelled. When the Agent has a safe recommendation, it may attach a choice fallback and explicit timeout:

```sh
yui task input request <task-id> --question "Which format should be the default?" \
  --choice csv="CSV" --choice json="JSON" \
  --recommend csv --timeout-seconds 300
```

The recommendation is shown to the user. If no answer arrives, the nearest-deadline timer wakes the Controller to atomically apply that exact choice and queue the fixed Leader session to resume. Free-text and user-required requests never auto-resolve.

`task input list` is the authoritative global open-input Inbox; add a Task ID to scope it, or `--all` to include answered and cancelled requests. The Controller also makes one receipt-backed, best-effort delivery to an already-running Operator composer. It never starts or interrupts an Operator for this notification; an absent or busy Operator falls back to the durable Inbox and is reconsidered on a later Controller pass. Answers may be submitted by the user or Operator. An open request prevents unrelated pending wakes and Task completion or archival. The originating Leader may instead run `yui task input cancel <task-id> <input-id> --reason "..."`; cancellation queues that fixed Leader session to resume.

Inspect the result:

```sh
yui task context <task-id>
```

Use the narrower `task work`, `task message`, `task run`, and Task Knowledge commands when you need one collection or record.

When the requested outcome is finished, complete the Task to stop automatic Leader wakes without deleting its sessions or Role worktrees:

```sh
yui task complete <task-id> --summary "CSV export shipped and verified"
yui task reopen <task-id>
```

Completed Tasks reject messages, dispatch, enter, retry, and late yields until explicitly reopened. Archive remains terminal and performs tmux/worktree cleanup.
Task lifecycle completion/selection only suggests valid source states: Draft for activate, active for complete, and completed for reopen.

## Sessions and tmux

Yui never proxies an interactive Agent terminal. Before `operator enter`, `role enter`, or `task enter` attaches, Yui closes readline, leaves raw mode, pauses its stdin, and synchronously hands the terminal to tmux. As a result, native Codex features such as `/model`, slash-command suggestions, full-screen rendering, and key handling remain available.

```sh
yui role enter <global-role>
yui task enter <task-id> [role]
yui task role enter <task-id> <role>
```

Each Role can bind multiple configured Agents, has one active Agent, and keeps a separate native session per Agent binding. Switching Agents preserves dormant sessions; switching is blocked while that Role has an active Run or native process.

Use `yui role unbind <global-role> <agent-id>` or `yui task role unbind <task-id> <role> <agent-id>` to retire a dormant binding. The active binding and any non-stopped native session are rejected; a stopped session record is removed atomically with the binding.

Claude session IDs are preallocated at launch. Managed Codex launches use Codex's structured `notify` callback; after a completed turn, the callback records the native thread ID without injecting a session-binding prompt into the model conversation.

Stable Role context is also launch metadata, never a bootstrap turn. Yui passes Role policy and `systemPrompt` through the Agent's native system/developer-instruction channel. Native Codex CLI has no per-launch extra-Skill-root option, so its developer instructions carry compact absolute Skill references and Codex reads each `SKILL.md` on demand. Because `developer_instructions` is one scalar setting, Yui inspects every supported Linux Codex layer—`/etc/codex/config.toml`, the user config, the selected `$CODEX_HOME/<name>.config.toml`, project configs, and `/etc/codex/managed_config.toml`—and refuses to replace a value found in any of them. Managed Codex sessions also require exclusive ownership of the structured `notify` callback that records native Turn completion; Yui refuses launch when any inspected layer already defines `notify`, so neither callback can silently replace the other. `skills.config` is not misused because it only enables or disables already-discovered Skills. Claude receives the same Skill content from a private `0600` managed context file rather than a large or sensitive argv value; retries and resumes reuse the Role-specific path. Non-Operator global Roles stay neutral and receive no Task Leader or Worker Skill. Operator therefore opens at an empty native composer, so the user's text remains its first user message. Leader wakeups and Worker Run assignments remain real mailbox-delivered work messages. An adapter without a native instruction channel must reject this context rather than silently converting it into a first user prompt.

## Controller and failure handling

One background Controller runs per `YUI_HOME`:

```sh
yui controller status
yui controller stop
yui controller restart
```

`controller restart` replaces the Controller process and its scheduler/socket services with the currently installed Yui version. It does not stop or restart managed tmux/Agent sessions.

Its recovery reconciliation runs every 120 seconds by default. Normal durable state changes enqueue a Task, Role, or Operator key and return immediately; keys received in the same fixed 100 ms window trigger one non-overlapping targeted pass. Operator presentation has an independent lane, so a blocked Task workspace operation cannot delay a user question. Periodic Git/worktree work is limited to Tasks with durable Task-mailbox work, while active Role liveness uses one tmux inventory. A Codex turn-complete Hook writes directly to storage without starting or waiting for the Controller, then gives a legal yield/input/completion two seconds to win before closing a forgotten Run. Durable mailboxes freeze the current batch while new signals merge into the next batch; failures release the current batch for recovery. Recommended InputRequest and pending Turn deadlines share one nearest-deadline selector and therefore do not wait for the recovery interval. Explicit `task reconcile` still requests an immediate recovery pass. The retained loop is:

1. prepare active repository workspaces;
2. stop archived Task tmux sessions and clean only clean worktrees;
3. deliver queued Worker Runs;
4. detect exited active Role processes;
5. dispatch pending Leader wakes when the Leader is idle.

Automated input is sent only through tmux. Each pass performs one non-blocking Agent-specific readiness check; a busy startup is retried through a small bounded mailbox timer, while later busy sessions are normally woken by Codex turn-complete events. A pane-local receipt prevents the same Run from being typed twice after a Controller retry.

If a Role process exits before yielding, the Controller fails that Run and running WorkItem and queues the Leader. Recovery failures are exposed through the small compatibility Jobs view:

```sh
yui jobs list
yui jobs retry leader-recovery:<task-id>
yui task reconcile <task-id>
yui task run retry <failed-run-id>
```

`jobs` is not a restored generic queue: it presents durable pending Leader wakes and Leader recovery failures only.

Completion is the reversible execution fence. Archiving is terminal: it fails active Runs, stops the Task's tmux session, and removes each clean Role worktree. Dirty Role worktrees are preserved for deliberate cleanup.

## Management commands

The restored management surface includes:

```sh
yui update
yui agent add|list|show|update|remove
yui role add|list|show|update|remove|bind|enter
yui role session record|replace
yui repository add|list
```

Agent environment bindings store process-environment variable names, never secret values. Adapter-owned lifecycle arguments cannot be overridden through raw arguments.

## Scope

Yui targets one trusted local user on one machine. It intentionally omits Web/API surfaces, distributed coordination, backup/import/export commands, trash/restore, derived indexes, recovery journals, runtime leases, inactivity TTLs, cooldowns, and recurring schedules.

See [ARCHITECTURE.md](./ARCHITECTURE.md) for persistence and scheduling details.

## Development

```sh
npm run build
npm test
npm run lint
```

To make every terminal and managed Agent session use this checkout, reversibly link the user-level `yui` command:

```sh
make link
command -v yui
yui doctor
```

The first `make link` saves the original `yui` entry in the same user-level bin directory and replaces it with a managed symlink to this checkout. A later `make link` from another checkout only moves that managed symlink; the last checkout wins and development links never form a backup chain. Run `make link` and `make unlink` serially—do not invoke them concurrently from multiple environments or checkouts. The launcher defaults `YUI_HOME` to the active checkout's `output/dev/home`; an explicit `YUI_HOME` remains authoritative. Because the command path itself is replaced, other terminals and newly launched Codex/Claude sessions use the same development build without sourcing a shell script. Run `yui controller restart` if an already-running Controller must load the new build. `make unlink` from any checkout using this implementation verifies the shared managed state and restores the one original `yui` entry.

```sh
make unlink
```

## License

[MIT](./LICENSE)
