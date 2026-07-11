# TaskMux Architecture

This document describes the current architectural contract of TaskMux. It is a maintained system reference, not a roadmap, requirements log, or implementation history.

## Design principles

1. **Local first.** Task data and Agent sessions stay on one machine unless the user explicitly moves them.
2. **One mutation boundary.** The Controller serializes ordinary state changes and owns recovery.
3. **Files are authoritative.** JSON, JSONL, and Markdown contain durable business state; SQLite is derived.
4. **Native Agents remain native.** TaskMux coordinates existing Agent CLIs instead of replacing their session models.
5. **Tasks are long-lived.** Cycles, WorkItems, and AgentRuns provide finite execution boundaries.
6. **Meaning and runtime stay separate.** Task direction is not inferred from tmux windows or process state alone.

## System context

```mermaid
flowchart TB
    User[User] --> CLI[TaskMux CLI]
    User --> Operator[Operator Agent session]
    Operator --> CLI
    CLI -->|authenticated loopback RPC| Controller
    Scheduler --> Controller

    Controller --> Domain[Domain services]
    Controller --> Store[File repository]
    Controller --> Index[(Derived SQLite index)]
    Controller --> Executors[Agent executors]
    Executors --> Tmux[tmux runtime]
    Tmux --> Leader[Leader session]
    Tmux --> Roles[Independent role sessions]

    Store --> Home[(TASKMUX_HOME)]
```

TaskMux has no required remote control plane, database server, or message broker. The CLI remains the public interface; the Controller is local infrastructure.

## Components

| Component | Responsibility |
| --- | --- |
| **CLI** | Parse commands, render human or JSON output, and route ordinary operations to the Controller. |
| **Controller** | Authenticate local RPC, serialize mutations, deduplicate request IDs, run recovery, and refresh derived state. |
| **Domain services** | Apply Task, role, Cycle, WorkItem, schedule, decision, milestone, and session rules. |
| **Scheduler** | Detect scheduled reviews, recurring work, inactivity, expired AgentRuns, and exited tmux windows. |
| **File repository** | Read and write the authoritative local model. |
| **Derived index** | Provide rebuildable Task, role, and WorkItem lookups in SQLite. |
| **Agent executors** | Translate common start, recover, send, interrupt, stop, and status operations into Agent-specific commands. |
| **tmux runtime** | Keep independent native Agent sessions alive and attachable. |
| **System Skills** | Guide Operator, Leader, and Worker behavior without becoming a permission system. |

## Domain model

```mermaid
classDiagram
    Task "1" --> "*" Cycle
    Task "1" --> "*" WorkItem
    Task "1" --> "*" TaskRole
    Task "1" --> "*" Topic
    Task "1" --> "*" Decision
    Task "1" --> "*" Milestone
    Cycle "0..1" --> "*" WorkItem
    WorkItem "0..1" --> "*" AgentRun
    TaskRole "1" --> "*" AgentRun

    class Task {
      id
      title
      archived
      current focus
    }
    class Cycle {
      cause
      summary
      active or ended
    }
    class WorkItem {
      assignee
      topics
      finite status
      outcome
    }
    class AgentRun {
      mode
      input
      active or terminal status
      summary
    }
```

### Task lifecycle

A Task is a durable mission, not a ticket. It has one terminal-like marker: `archived`. Continued progress is represented by Cycles and WorkItems rather than `open`, `active`, and `done` Task states.

### Role model

- **Operator** is a persistent global administrative session. It manages TaskMux through the CLI but does not perform Task work.
- **Leader** is the single fixed Task-local session responsible for direction, decomposition, synthesis, and archival.
- **Independent roles** have their own Agent session, tmux window, AgentRuns, and optional Git worktree.
- **Child roles** contain descriptive constraints for a parent role. They have no TaskMux-managed session, tmux window, worktree, or AgentRun.

Global role templates use copy semantics. Once a role is bound into a Task, later template changes do not mutate the TaskRole.

## Command and transaction flow

```mermaid
sequenceDiagram
    participant CLI
    participant Controller
    participant Journal as Recovery journal
    participant Files as Authoritative files
    participant Index as Derived index

    CLI->>Controller: RPC(method, params, requestId, token)
    Controller->>Journal: Persist request intent
    Controller->>Journal: Stage complete transaction
    Journal->>Files: Apply atomic write/delete set
    Controller->>Journal: Persist RPC result and clear intent
    Controller->>Index: Rebuild derived state
    Controller-->>CLI: Stable result envelope
```

Mutating request IDs are idempotent. A committed result is returned without reapplying the command. If a process stops after a transaction is staged, Controller startup completes the staged operation before serving requests.

Setup and schema migration remain explicit lifecycle operations. Ordinary CLI, dashboard, Task shell, import, prune, backup, attach-state, and Scheduler mutations share the Controller boundary.

## Dispatch and wakeup flow

```mermaid
flowchart LR
    Trigger[Input / schedule / role result / inactivity] --> Pending[Pending wakeup]
    Pending --> Coalesce[Coalesce reasons]
    Coalesce --> Recover[Recover fixed Leader session]
    Recover --> Cycle[Create advancement Cycle]
    Cycle --> Work[Create or update WorkItems]
    Work --> Dispatch[Dispatch independent role]
    Dispatch --> Run[AgentRun]
    Run --> Yield[Durable yield]
    Yield --> Pending
```

Dispatch returns after the native session accepts the work; execution remains asynchronous. Yield ends the AgentRun, updates any linked WorkItem, and queues one coalesced Leader wakeup.

The Leader session is never silently replaced. Permanent recovery failure pauses Leader wakeups and creates a durable Operator notification until a user explicitly records a replacement session.

## Persistence

The default root is `~/.taskmux`; `TASKMUX_HOME` overrides it.

```text
TASKMUX_HOME/
  config.json
  schema.json
  runners/
  roles/
  tasks/<task-id>/
    info.json
    task.json
    brief.md
    timeline.md
    topic-summaries.md
    comments.jsonl
    events.jsonl
    roles/
    cycles/
    work-items/
    milestones/
    decisions/
  runtime/
    controller.json
    index.sqlite
    domain-transactions/
    recovery-journal/
    role-sessions/
    active-runs/
    pending-wakeups/
    operator-notifications/
    logs/
```

### Authoritative and derived state

- JSON stores structured snapshots and runtime records.
- JSONL stores append-only comments, events, and diagnostics.
- Markdown stores curated semantic context.
- SQLite stores only derived lookup data and may be deleted and rebuilt.

TaskMux does not run a filesystem watcher or a polling loop for direct file edits. Derived state is refreshed at explicit boundaries only:

1. Controller startup;
2. successful Controller command transactions;
3. Scheduler scans.

The supported mutation path is the CLI. Direct file edits are not automatically detected and should not be used when immediate, predictable application is required.

## Agent and tmux boundaries

```mermaid
flowchart TB
    Task --> Session[tmux Task session]
    Session --> LeaderWindow[Leader window]
    Session --> WorkerWindowA[Worker window A]
    Session --> WorkerWindowB[Worker window B]
    Operator --> OperatorSession[separate persistent tmux session]
    WorkerWindowA --> WorktreeA[optional Git worktree A]
    WorkerWindowB --> WorktreeB[optional Git worktree B]
```

One Task maps to one tmux session. Each independent TaskRole maps to one window and native Agent session. When the Leader workspace is a Git repository, independent roles require an explicit TaskMux worktree before dispatch.

Agent-specific command construction stays behind a common executor contract. The Scheduler does not build Codex or Claude commands, the context compiler does not control tmux, and tmux does not interpret Task semantics.

## Scheduling and recovery

The Scheduler handles recurring intervals, one-off review times, inactivity, AgentRun TTLs, and exited role windows. Trigger reasons are persisted and coalesced before the Leader is recovered.

Recovery guarantees focus on durable local state:

- staged snapshot writes are replayed on startup;
- staged multi-file domain transactions converge to their complete write/delete set;
- request intents and cached results prevent duplicate mutations;
- a missing or corrupt SQLite index is rebuilt from files;
- invalid stored records produce explicit diagnostics instead of silent data loss.

## Security boundary

- Controller RPC binds only to `127.0.0.1`.
- Discovery includes a random local token and API version.
- Runtime and credential-bearing files use user-only permissions where applicable.
- TaskMux does not provide multi-user authorization or expose a remote service.

## Non-goals

TaskMux does not currently provide team accounts, remote synchronization, a hosted control plane, a web UI, automatic Git merge or push, full Agent transcript auditing, or TaskMux-managed native subagent runtimes.
