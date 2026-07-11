# TaskMux Agent Task Controller Design

Status: Approved

Date: 2026-07-11

## 1. Purpose

TaskMux will evolve from its current local tmux-backed task board into a
long-running, agent-native task controller. It will turn an open-ended user goal
into a durable, inspectable, resumable stream of work coordinated by a Task
Leader and supported by other roles.

The target remains local-first:

- one user;
- one machine;
- one long-running Controller process;
- the TaskMux CLI as the public interface;
- native tmux sessions for interactive role access;
- Codex, Claude, and future native agent CLIs as execution Agents;
- no remote synchronization of TaskMux data.

The central design principle is:

> The Leader owns the semantic direction of a Task; the Controller owns the
> reliable persistence and execution of the state that roles choose to record.

TaskMux is deliberately trust-oriented. System prompts and Skills guide role
behavior. Engineering constraints protect only essential structural and data
integrity properties; they do not attempt to audit or police every Agent action.

## 2. Current baseline

The existing TypeScript project already provides several parts of the target:

- local JSON and JSONL storage under `TASKMUX_HOME`;
- storage versions, migrations, backups, import, and export;
- configurable Agent/runner commands;
- global role presets copied into task-local roles;
- one tmux session per Task and one window per role;
- an `assistant` system role and a required task-local `leader` role;
- comments, events, transcripts, task context, and a CLI board;
- editable task and role metadata separated from runtime records.

The main changes are evolutionary rather than a separate product:

- rename/reframe the global `assistant` as the Operator;
- add a persistent local Controller and scheduler;
- replace the traditional open/active/done lifecycle with long-lived Tasks and
  an archive marker;
- add Cycles, WorkItems, Milestones, Topics, durable Leader context, schedules,
  pending wakeups, and native session IDs;
- add system Skills and Agent-specific executor adapters;
- make the Leader own the primary workspace and explicitly isolate independent
  roles with Git worktrees.

## 3. First-principles model

A long-running agent task needs three different forms of state:

1. Semantic state: goals, focus, timeline, milestones, decisions, comments, and
   conclusions.
2. Coordination state: schedules, pending wakeups, finite work items, role
   dispatches, and active execution rounds.
3. Runtime state: native Agent session IDs, tmux targets, processes, and local
   logs.

These forms must not be conflated. A tmux window is not a Task, an Agent process
is not a Role, and an Agent saying work is complete is not a durable Task record.

## 4. Terminology and roles

### 4.1 Agent

An Agent is an execution backend such as Codex or Claude. It is not a
TaskMux-created worker instance.

Each Agent adapter knows how to:

- start and recover a native session;
- discover the native session ID;
- inject prompts, Skills, and context;
- send input;
- inspect process state;
- interrupt or stop execution;
- report supported capabilities.

The existing runner registry is the starting point for this executor layer.

### 4.2 Global role template

A GlobalRoleTemplate is reusable role configuration containing some or all of:

- name and description;
- responsibilities and constraints;
- expected output;
- Agent selection;
- system prompt;
- Skills and tools;
- executor configuration.

Operator and Leader templates are pre-created. Users may add templates such as
Reviewer or Researcher.

Templates have copy semantics. Creating a TaskRole from a template copies its
current values. Later template edits or deletion do not affect the TaskRole.

### 4.3 Task role

A TaskRole is an actual role used inside one Task. Operator or Leader may create
it from a global template or from scratch.

Agent selection follows this order:

1. an Agent explicitly supplied for the role;
2. the Agent copied from a template;
3. the single global default Agent.

The resolved Agent is persisted on the TaskRole. Task and Project do not carry
additional default-Agent fields.

### 4.4 Independent role architecture (Multi Agent)

An independent TaskRole has:

- its own native Codex or Claude session;
- its own tmux window;
- its own execution rounds;
- its own Task worktree;
- direct user attach support.

"Multi Agent" describes this architecture; it is not another domain entity.

### 4.5 Child role architecture (Subagent)

A child TaskRole is bound to an existing parent TaskRole and acts only as a
descriptive execution constraint for that parent.

Only necessary descriptive content is injected:

- name;
- description;
- responsibilities;
- constraints;
- expected output.

Its Agent, Skills, tools, executor configuration, and session information are
ignored. It has no TaskMux-managed native session, tmux window, worktree, or
AgentRun. Deleting the parent removes its child-role bindings.

Codex or Claude may also create native internal subagents without any TaskMux
configuration. TaskMux does not create, schedule, recover, or audit them. The
parent role decides which results are important enough to record.

### 4.6 Operator

Each TaskMux home has one persistent Operator role. This is the evolution of the
current global `assistant`: it acts as the user's natural-language CLI proxy and
has the same practical CLI capabilities as the user.

The Operator Skill directs it to manage rather than perform Task work. This is a
prompt-level responsibility boundary, not a complex permission system.

### 4.7 Leader

Every Task has exactly one Leader TaskRole copied from the Leader template. The
Leader owns:

- semantic direction and current focus;
- timeline and milestone curation;
- work decomposition;
- TaskRole creation and configuration when useful;
- worktree preparation;
- dispatch of independent roles;
- synthesis of results;
- the decision to archive the Task.

The Leader uses one fixed native Agent session. Controller wakeups always
recover that session. A permanently broken session is never replaced
automatically; the user or Operator explicitly replaces it while retaining the
old session history.

## 5. Long-lived Task model

### 5.1 Task

A Task is a long-lived mission or workstream, not a traditional ticket. It has
no open/in-progress/done lifecycle and no completion percentage.

A Task maintains:

- long-term objective and boundaries;
- current focus and Leader summary;
- curated timeline;
- milestones and decisions;
- comments and user context;
- Topics;
- schedules and review times;
- Cycles and finite WorkItems;
- TaskRoles;
- archive information.

The only terminal-like marker is `archived`. Before archival, the Leader remains
responsible. Archival stops automatic scheduling but preserves TaskMux data,
role history, native session metadata, and worktrees. The user or Operator may
reactivate the Task.

### 5.2 Cycle

A Cycle is one finite period of Task advancement caused by:

- a recurring schedule;
- a one-off review time;
- a user or Operator submission;
- an asynchronous role result;
- an inactivity check;
- an explicit wake command.

Recurring Tasks create new Cycles rather than being archived and reopened.

### 5.3 WorkItem

A WorkItem is a finite unit inside a Task. It may complete, fail, be cancelled,
or be superseded. It may be assigned to the Leader or an independent TaskRole.

WorkItems provide dependency and execution boundaries without imposing a finite
lifecycle on the parent Task.

### 5.4 Topics

Topics are lightweight, multi-select classification labels, not subtasks,
owners, schedules, or lifecycle states.

The built-in set is:

- `requirements`;
- `architecture`;
- `ui`;
- `implementation`;
- `testing`;
- `deployment`;
- `operations`;
- `security`.

Operator and Leader may create concise custom Topics inside an individual Task.
Custom Topics are not global. Naming guidance favors lowercase English
kebab-case IDs and short noun phrases. The CLI may warn about likely duplicates
without hard-blocking them.

Comments, timeline entries, decisions, milestones, Cycles, WorkItems,
dispatches, and role reports may reference zero or more Topics.

## 6. User interaction

### 6.1 Operator draft and submit

When the user gives existing-Task information to the Operator, it follows two
steps:

1. create or update a mutable TaskInputDraft;
2. submit it as official Task input.

Drafts do not update official context or wake the Leader. Submission creates the
official comment or context addition and creates or merges a Leader wakeup.

The Operator Skill may perform both steps immediately when intent is explicit.
Ambiguous input remains a draft until clarified. No approval subsystem enforces
this convention.

### 6.2 Direct Leader interaction

The user may attach directly to the Leader's native tmux window. Because the
Leader is already active, this does not create another wakeup.

The Leader decides whether the input becomes:

- a chronological Task comment;
- a distilled long-term context update;
- both;
- or session-local information requiring no durable record.

### 6.3 Direct role interaction

The user may attach to any independent TaskRole. TaskMux does not require full
conversation capture. Skills ask roles to register important findings, results,
and context through the CLI.

## 7. Workspace and worktree model

TaskMux data and project files remain physically separate.

Each Task identifies a primary local workspace. The Leader owns and uses that
workspace. Other independent TaskRoles operate in Git worktrees for isolation.

The Leader explicitly decides:

- whether and when to create a worktree;
- the base commit or branch;
- the worktree branch name;
- when to review and integrate changes;
- when a worktree is safe to remove.

TaskMux never automatically merges, commits, pushes, or deletes a dirty
worktree. Removing or archiving a TaskRole does not silently destroy its
worktree. Child roles inherit the parent role's workspace.

## 8. Session and dispatch model

### 8.1 Native sessions

Native executor session IDs belong to independently running TaskRoles.

The Leader always recovers its fixed session. Other independent roles may have
multiple historical sessions. On each dispatch, the Leader explicitly chooses
whether to recover an existing session or start a new one. The role's Agent type
does not change.

### 8.2 Dispatch

Dispatch is synchronous only for the control action:

1. the Leader invokes a CLI dispatch command;
2. the Controller calls the role's Agent adapter;
3. the CLI returns start/recovery success or failure synchronously.

A normal start or recovery failure returns directly to the active Leader. It
does not create a Task event or another Leader wakeup.

After successful dispatch, role work is asynchronous in its tmux window. A
later `yield` records the important result and creates or merges one Leader
wakeup.

### 8.3 AgentRun and yield

An AgentRun represents one active execution round. A live Agent process or tmux
window does not imply an active AgentRun.

System Skills instruct roles to call `yield` when a round ends. If omitted, the
Controller may infer idle state from inactivity and a maximum run TTL. This is
cooperative bookkeeping rather than strict execution auditing.

## 9. Scheduling

The Scheduler combines event-driven wakeups with a periodic safety scan.

Leader wakeup sources include:

- submitted Operator input;
- user comments added through the CLI;
- recurring schedules;
- one-off review times;
- asynchronous independent-role completion or failure;
- explicit wake commands;
- Task inactivity.

Triggers for the same Task are coalesced into one PendingWakeup. Repeated
schedule firings do not create duplicate Cycles. The pending record retains all
merged reasons and relevant context.

The inactivity scanner wakes the Leader when:

- the Task is not archived;
- no AgentRun is active;
- effective inactivity exceeds the Task threshold;
- no review time or cooldown suppresses the wakeup;
- no equivalent wakeup is already pending.

The Leader may set a future review time while waiting for an external condition,
keeping the Task active without repeated wakeups or archival.

The Scheduler never invents work for an independent role. Only the Leader
dispatches such roles.

## 10. CLI and Skills

The CLI remains generic. tmux-launched roles receive environment variables for
the current Task, TaskRole, workspace, and AgentRun so commands can omit repeated
IDs.

Primary command groups cover:

- Operator and global role-template management;
- Task configuration, archive, input, and wake operations;
- TaskRole management and attach;
- timeline, milestone, Cycle, WorkItem, and Topic operations;
- dispatch;
- session operations;
- context retrieval;
- yield.

All commands support stable JSON output for Agent use.

Three system Skills provide workflows without duplicating the CLI:

1. `taskmux-operator`: natural-language administration, draft/submit, Task and
   role management, scheduling, and archival.
2. `taskmux-leader`: context recovery, Task curation, decomposition, TaskRole
   and worktree management, dispatch, synthesis, yield, and archival.
3. `taskmux-worker`: WorkItem execution, important-result registration, and
   yield behavior for independent roles.

Custom role Skills are merged with the applicable system Skill.

## 11. Controller architecture

The runtime consists of one local Controller:

```text
CLI / role processes
        |
        | Loopback HTTP/JSON-RPC
        v
Controller
  |- Command API
  |- Domain services
  |- File repository
  |- Scheduler
  |- Context compiler
  |- Executor tools
  |- Tmux runtime
  `- Rebuildable index
```

The Controller binds only to `127.0.0.1`. A local discovery file contains PID,
port, API version, and a random local token. Requests carry API version and
request ID; mutating requests are idempotent by request ID.

Loopback HTTP leaves room for a local UI, MCP, SSE, or WebSocket adapter while
the CLI remains the only required public interface.

## 12. Executor and tmux boundaries

Executor tools expose a common interface for Codex, Claude, and future Agents:

- start;
- recover;
- send;
- interrupt;
- stop;
- status;
- native session discovery;
- attach metadata;
- capabilities.

The Scheduler never constructs Codex or Claude commands. The Context Compiler
never controls tmux. The Tmux Runtime never interprets Task semantics.

The tmux layout retains the current successful model:

- one tmux session per Task;
- one window per independent TaskRole;
- one separate persistent Operator session;
- no window for child roles.

The CLI locates and enters the native tmux target for role attach.

## 13. Local persistence

All TaskMux data remains local under `TASKMUX_HOME` (`~/.taskmux` by default).
It is not stored inside Task workspaces, does not require Git, and is never
automatically committed, pushed, or synchronized.

The target logical layout extends the existing local schema:

```text
~/.taskmux/
  config.json
  runners/
  roles/                       # global role templates
  operator/
  tasks/<task-id>/
    info.json
    task.json
    brief.md
    timeline.md
    topic-summaries.md
    topics.json
    comments.jsonl
    events.jsonl
    roles/
    milestones/
    cycles/
    work-items/
  runtime/
    controller.json
    index.sqlite
    role-sessions/
    active-runs/
    pending-wakeups/
    tmux.json
    logs/
```

The implementation plan must reconcile this logical layout with the existing
`TASKMUX_HOME` schema through a versioned migration rather than moving files ad
hoc.

Storage rules:

- JSON stores structured configuration and runtime snapshots;
- Markdown stores human- and Agent-readable semantic content;
- JSONL stores append-only comments and domain events;
- SQLite is a derived, deletable index only;
- no irreplaceable business information exists only in SQLite;
- semantic Task data and runtime session data remain separate.

Writes use complete event payloads plus atomic snapshot replacement. On startup,
the Controller can replay unapplied events and rebuild the SQLite index.

Users may inspect all files. Declarative JSON and Markdown files may be edited;
a watcher reloads valid changes. Invalid files are preserved and reported while
the Controller continues using the last valid configuration.

## 14. Error-handling policy

Errors go to the actor currently able to handle them:

- CLI validation errors return synchronously;
- independent-role start/recovery errors return synchronously to the Leader;
- asynchronous role failures wake the Leader;
- permanent Leader recovery failures pause automatic Task advancement and
  notify the Operator;
- missing worktrees return to the Leader and are not recreated automatically;
- invalid user-edited files are preserved and reported;
- duplicate triggers and request retries are coalesced or deduplicated;
- SQLite loss causes a rebuild rather than Task data loss.

Controller diagnostics live in runtime logs. Ordinary infrastructure errors are
not automatically promoted into the curated Task timeline.

## 15. Core use cases

The design must support these end-to-end journeys:

1. The user talks to the Operator, which creates a new Task through the CLI.
2. Task creation produces a dedicated Leader role and fixed native session;
   later Task information supplied through the Operator follows draft/submit.
3. The Leader maintains context, Topics, timeline, milestones, and finite
   WorkItems across many Cycles.
4. Operator or Leader creates a TaskRole from a template or from scratch.
5. The Leader explicitly prepares a role worktree and dispatches it.
6. Dispatch synchronously reports start/recovery success while work continues
   asynchronously.
7. An independent role yields a result, causing one coalesced Leader wakeup.
8. The user attaches to any independent role's native tmux window.
9. The user gives the active Leader information, which the Leader may record as
   a comment or durable context.
10. A recurring Task advances on schedule without archive/reopen churn.
11. Inactivity wakes a non-archived Task Leader when no role is executing.
12. The Leader archives the Task with a durable summary; the Operator may later
    reactivate it.

## 16. Testing strategy

### 16.1 Domain tests

Cover Task archival, template copy independence, global default Agent
resolution, child-role cascading removal, Topic association, Schedule/review
behavior, trigger coalescing, Operator draft/submit, and semantic content.

### 16.2 Scheduler tests

Use a virtual clock to verify inactivity thresholds, cooldowns, fixed schedule
times, trigger deduplication, AgentRun yield/TTL behavior, and exclusion of
archived Tasks.

### 16.3 Executor contract tests

Every Agent adapter passes the same start, recover, send, status, interrupt,
stop, native-ID, and failure-shape tests. Fake executors are the default; real
Codex and Claude checks are opt-in local smoke tests.

### 16.4 Tmux integration tests

Use an isolated tmux server to verify Task sessions, role windows, attach
targeting, fixed Leader recovery, worktree cwd injection, and role isolation.

### 16.5 Controller integration tests

Use an ephemeral loopback port to verify local token handling, API version
negotiation, request idempotency, restart recovery, event replay, direct file
reload, migration compatibility, and SQLite index rebuild.

### 16.6 End-to-end tests

Cover Operator Task creation, Leader TaskRole and worktree creation, synchronous
dispatch, asynchronous yield, coalesced Leader wakeup, recurring Cycles, direct
Leader input, archival, and reactivation.

## 17. Non-goals

The initial design does not include:

- multi-user accounts or RBAC;
- multi-machine workers;
- remote synchronization of TaskMux data;
- automatic Git commit, merge, push, or dirty-worktree deletion;
- full transcript or tool-call auditing;
- TaskMux-managed native subagent runtimes;
- automatic replacement of a broken Leader session;
- an external message broker or database server;
- arbitrary Task completion percentages or traditional open/closed status.

## 18. Success criteria

The design succeeds when a single user can maintain long-running Tasks in local
files, let a persistent Leader continuously advance them, delegate work to
isolated independent roles, enter any native role session, recover after local
process failures, and understand current state without hidden remote services or
opaque database-only records.
