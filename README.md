<p align="right"><strong>English</strong> | <a href="./i18n/README.zh-CN.md">简体中文</a></p>

# Yui

Yui is a local control plane for durable Codex and Claude work. It keeps control state and Project knowledge in inspectable JSON, lets tmux own native Agent terminals, and combines reusable Agent Profiles, Leader-context forks, explicit acceptance, and isolated Git worktrees for Project-backed Tasks.

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

`setup` is interactive. It detects installed Agent CLIs, asks which Agents to configure, selects the default and Operator Agent, probes each selected CLI for its current models, then selects model followed by that model's supported reasoning efforts for the Leader and Operator Roles. It also confirms the Project workspace outside Yui home and offers shell-completion setup. The picker includes the native CLI default and a custom-value option. Running setup again preserves existing Tasks, Roles, and the installation's Project workspace while allowing safe configuration changes.

Model and effort are Role settings, so Leader and Operator can use different values even when both use the same Agent CLI. The same runtime picker is used by interactive Role and Agent Profile add/update flows. Explicit `--model` and `--effort` values remain scriptable custom overrides.

Runtime catalogs are refreshed per command and cached under Yui home. If a live probe times out or fails, Yui shows the last cache for the same Agent launch context and clearly marks it as potentially stale; without a matching cache, it offers CLI defaults and custom values. `yui agent capabilities <id>` exposes the same one-pass catalog, including models, model-specific efforts, and other runtime choices such as permissions, search availability, profiles, settings sources, and service tiers.

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

The home contains `schema.json`, the authoritative `state.json`, Project Catalog and knowledge, and Controller discovery files. Stable Project checkouts and managed worktrees live under the configured workspace, outside Yui home. The current storage version is exact and fresh-only; this release does not migrate older formats.

Setup also seeds four reusable Agent Profiles:

```text
worker  explorer  implementer  reviewer
```

Profiles are versioned Worker execution templates backed by one configured Codex Agent. They hold defaults and instructions, but do not own a Session or workspace. Operator and Leader remain runtime Roles.

## Quick start

Bind a Project and create a Draft Task:

```sh
yui project add app /absolute/workspace/app \
  --remote git@example.com:team/app.git --stable main --development develop
yui project update app --alias app-cli --development develop
yui project list

yui task create "Ship CSV export" --project app
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

A Project-backed Task receives its main worktree when it is created at `<workspace>/worktree/<project>/<task-id>/main`. Roles share Task main by default. During execution, the Leader may directly create a WorkItem-owned isolated worktree when concurrent edits have meaningful conflict risk:

```sh
yui task work isolate <work-item-id>
yui task work cleanup <work-item-id> --integrated
```

Use `--abandon` instead of `--integrated` only for a deliberate discard. The disposition remains on the WorkItem record. Dirty worktrees are retained.

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

For bounded work that does not need a persistent, user-owned Session, the Leader can dispatch an Execution Attempt:

```sh
yui task work create <task-id> "Review the implementation" \
  --objective "Return source-backed findings" \
  --accept "Every finding identifies an affected path"
yui task attempt dispatch <work-item-id> --profile reviewer --mode auto --access read

yui task work create <task-id> "Implement the accepted change" \
  --objective "Implement and validate the requested behavior" \
  --accept "Focused tests pass"
yui task attempt dispatch <work-item-id> --profile implementer --mode auto --access write
```

`auto` forks the active Leader thread and fails fast when no compatible Leader thread is available; it never silently creates a root Session. Explicit root Session execution requires both `--mode session` and `--session-reason`.

Attempt dispatch passes stable Yui record references instead of copying the current Brief, decisions, and messages into another snapshot. Workers can read current context through `yui task context` and Project Knowledge commands using the managed `YUI_HOME`, while their Task Role identity remains unset.

Write Attempts use separate worktrees under `<workspace>/worktree/<project>/<task-id>/attempts/<attempt-id>`, so independent work may proceed concurrently even when paths overlap. A successful write emits a ChangeSet. Integration applies it in a candidate worktree, runs the requested checks, and advances the target only if its recorded head still matches:

```sh
yui task integration start <task-id> \
  --change-set <change-set-id> \
  --check "npm test"
```

Integration state stores compact check outcomes and failure diagnoses. Full stdout and stderr are streamed without truncation to `YUI_HOME/artifacts/integration-checks/...`; `task integration show` exposes the relative log path, and `task integration cleanup` removes both the candidate worktree and those logs.

Code or semantic conflicts remain blocked until that Task's Leader records a decision:

```sh
yui task integration resolve <integration-id> \
  --option manual-resolution \
  --rationale "Preserve the public contract while combining both implementations"
yui task integration continue <integration-id>
```

Attempt success is not WorkItem completion. The Leader accepts only after reviewing the result, validations, and any ChangeSet integration:

```sh
yui task work accept <work-item-id> --summary "Acceptance criteria met."
```

Use `task work reject` to return an awaiting result for retry and `task work cancel` for obsolete non-running work. Attempt and Integration worktrees and Integration check logs remain available as evidence until explicit cleanup.

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

When the requested outcome is finished, complete the Task to stop automatic Leader wakes without deleting its sessions or Task main worktree:

```sh
yui task complete <task-id> --summary "CSV export shipped and verified"
yui task reopen <task-id>
```

Completed Tasks reject messages, dispatch, enter, retry, and late yields until explicitly reopened, while retaining Task main for inspection or integration. Every isolated WorkItem worktree must be explicitly cleaned as integrated or abandoned before archive; that cleanup also removes its managed branch. Archive requires `--integrated` or `--abandon` to state the Task main outcome and is allowed only after Task main is clean. It removes managed worktrees but retains Task and WorkItem records. The Task main branch is retained as a recovery artifact instead of being silently deleted.
Task lifecycle completion/selection only suggests valid source states: Draft for activate, active for complete, and completed for reopen.

## Sessions and tmux

tmux owns every long-lived interactive Agent process. Before `operator enter`,
`role enter`, or `task enter` attaches, Yui closes readline, leaves raw mode,
pauses its stdin, and synchronously hands the terminal to tmux. The attach uses
the real outer terminal capabilities and a clean alternate screen; mouse
scrolling stays in the Agent pane's 100,000-line tmux history instead of mixing
with the shell or IDE terminal history that preceded the attach. Native Agent
features such as `/model`, slash-command suggestions, full-screen rendering,
and key handling remain available.

tmux fixes a pane's history capacity when that pane is created. Roles created
before this limit was configured keep their earlier capacity; Yui warns on
Terminal attach and in Web so the user can exit and re-enter that Role once to
create a 100,000-line pane while retaining the native Agent conversation.

The first terminal attached to one Operator or Task tmux session is writable.
Additional Terminal or Web viewers attach read-only, preventing two surfaces
from typing into the same Agent at once.

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

1. prepare active Project Task main worktrees;
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

Completion is the reversible execution fence. Archiving is terminal and is accepted only after active work is settled: it stops the Task's tmux session and removes clean managed worktrees. Dirty worktrees keep the Task completed and are preserved for deliberate resolution.

## Local web control room

Run the local control room on the default loopback address:

```sh
yui web
# Yui web control room: http://127.0.0.1:4173
```

Use `--port <port>` or `--host 127.0.0.1|::1|localhost` to change the
listener. Yui rejects non-loopback hosts because the control room exposes Task
metadata, Briefs, Roles, WorkItems, Runs, messages, Decisions, Milestones, and
InputRequests. A random token embedded in the served page protects its write
and terminal endpoints.

The Web surface can answer an open InputRequest through the same durable CLI
mutation used by Terminal users. It can also attach to the existing Operator,
Leader, or Worker tmux pane through a native xterm client. Closing the browser
terminal detaches only that tmux client; the Agent process and conversation
continue running in tmux. The Web surface does not duplicate transcripts or
maintain another session state.

The control room supports English and Simplified Chinese, selecting an initial locale from the browser and remembering manual changes. The theme selector switches between the dark Control Room and light Paper Ledger themes. Both choices are stored only in browser `localStorage`; they do not modify `YUI_HOME`.

## Management commands

The restored management surface includes:

```sh
yui update
yui agent add|list|show|capabilities|update|remove
yui role add|list|show|update|remove|bind|enter
yui role session record|replace
yui project add|clone|update|discover|list|show|knowledge
```

Agent environment bindings store process-environment variable names, never secret values. Adapter-owned lifecycle arguments cannot be overridden through raw arguments.

## Scope

Yui targets one trusted local user on one machine. Its Web/API surface is
loopback-only and intentionally omits remote or multi-user Web access,
distributed coordination, backup/import/export commands, trash/restore,
derived indexes, recovery journals, runtime leases, inactivity TTLs,
cooldowns, and recurring schedules.

See [ARCHITECTURE.md](./ARCHITECTURE.md) for persistence and scheduling details.

## Development

```sh
npm ci
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
