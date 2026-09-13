<p align="right"><strong>English</strong> | <a href="./i18n/README.zh-CN.md">简体中文</a></p>

# Yui

[![Core CI](https://github.com/zhangqian-silk/yui/actions/workflows/ci.yml/badge.svg?branch=master)](https://github.com/zhangqian-silk/yui/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
![Node](https://img.shields.io/badge/node-20%20%7C%2022%20%7C%2024-brightgreen.svg)
![Platform](https://img.shields.io/badge/platform-Linux%20x64%20%28glibc%29-blue.svg)
[![PRs welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)](#contributing)

Give your Agents work to carry forward, not just another chat to answer.

Yui is a local control plane for coding Agents. Describe what you want to an
Operator in plain language: it identifies the relevant Project, tells new work
from a follow-up, and turns each request into a Task owned by a Leader that
plans, delegates and brings results and decisions back. Intent, progress and
results live outside any single conversation, so work continues from the Task —
not from terminal windows you juggle or details you have to remember.

**Highlights**

- **Durable by design** — Tasks, decisions and results live in one local SQLite
  store, so work survives crashes and restarts and continues from the Task, not
  a chat log.
- **One conversation, many Tasks** — the Operator turns plain-language requests
  into new Tasks or follow-ups; no ticket IDs or terminal-window juggling.
- **A Leader owns each outcome** — it plans, splits work into WorkItems,
  delegates to Workers and Reviewers, and closes the loop; you can talk to it
  directly anytime.
- **Bring your own Agent** — Codex CLI, Claude Code CLI and ACP peers run behind
  one boundary and stay replaceable without losing the Task.
- **Local-first and private** — everything runs on your machine for one trusted
  user; Web is loopback-only, with read-only views and authenticated user controls.
- **Isolated by default** — repository work happens in managed Git worktrees;
  the stable checkout stays read-only.

> **Status:** pre-1.0 (0.15.x). CLI surfaces and configuration may still change
> between releases; each upgrade migrates valid existing Homes.

[Quick start](#quick-start) · [Working through conversation](#working-through-conversation) · [Architecture](#architecture) · [Design principles](#design-principles)

## Quick start

You need Linux x64 with glibc, Git, tmux, and Node.js `^20.17.0`, `^22.9.0` or
`^24.0.0`. For the simplest setup, have Codex CLI or Claude Code CLI installed
and ready to use with your own account. Yui coordinates those Agents; it does
not supply model access.

For Claude, Yui passes through your authentication environment and native
configuration directory; Claude selects the API key or login method using its
own settings. Replacing a Session does not reset your login or initialization.
Native first-run confirmations may still require your input.

### 1. Install

```sh
npm install -g @zq-silk/yui
```

### 2. Set up, yourself or with an Agent

Run the interactive setup:

```sh
yui setup
```

Or ask the coding Agent you already use:

> Yui is installed. Help me run `yui setup` in an interactive terminal,
> choose an available Agent, and check the result with `yui doctor`.
> Ask me about any account or setup choices you need.

Setup establishes the Operator—the Agent you talk to—and a default Task Leader,
then starts the local Controller. You can begin with those two roles and
configure Workers or Reviewers later. If your Agent cannot operate an interactive
terminal, run setup yourself; it only handles the initial configuration.

### 3. Start a conversation

```sh
yui operator enter
```

Tell the Operator what you want to work on:

> My project is at `/absolute/path/to/app`. Help me add CSV export.
> First clarify the scope, then implement and verify it. Don't publish anything.

The Operator can register the Project and organize the request into a Task.
Its Leader handles planning and execution within your instructions. You can
ask questions, refine the requirement, or bring another request to the same
Operator without learning Task IDs or internal commands.

## Working through conversation

### Let the Agent organize the work

You can bring a mixture of new requests, corrections and questions:

> The CSV export also needs to preserve leading zeros in account numbers.
> Separately, investigate why login is slow. Prioritize the export first.

The Operator uses existing Task context to decide what belongs together and
what deserves an independent Task. It can organize work by Project, type,
priority and tags. A follow-up need not become a new Task, and a Task need not
be split into a WorkItem for every implementation step.

The Leader owns delivery: small work can stay with the Leader; independent
requirements can go to configured Workers; a Reviewer can inspect the result
when appropriate. Agents choose the plan and delegation. The Controller
delivers the scheduled work, observes execution and returns results to the
responsible Agent—without requiring you to relay messages between sessions.

### Configure by asking

Stay in the Operator conversation to change how Yui works:

> Show me the available Agents and models. Suggest a setup for planning,
> implementation and review, then apply it after I confirm.

The Operator reads the actual configuration and supported choices before
making changes. You can ask it to change a model, bind another Agent, adjust
review preferences or explain a setting. It should tell you what changes,
whether it affects future launches or a live Session, and which choices need
your confirmation. You do not need to hand-edit configuration files.

### Pick up where you left off

> What is still active? Which tasks need my decision? Continue the CSV task
> from its saved state and summarize what remains.

Tasks retain requirements, decisions and results independently of the native
chat history. Yui delivers durable updates to the Operator; the Agent can
recover context and continue compatible sessions, or choose a new execution
when necessary. A failed process does not erase the Task, and an uncertain
submission is not silently repeated.

For a visual overview, run `yui web` in another terminal. The local Web view
shows the same tasks and pending questions and lets you send messages, answer
questions and explicitly queue, steer or interrupt Task input. These authenticated
Task controls use the same operations as the CLI; Web is not a separate task system.
See [Web permissions](docs/architecture/capabilities-and-resources.md#cli-and-web)
and [input timing](docs/managed-turn-and-session-runtime.md#input-timing-queue-steer-and-interrupt).

## Architecture

Under the hood, Yui keeps every durable fact in one local SQLite store and lets
Agents act on it through small, explicit operations. Here is the same system
from a few different angles:

- [Product structure](#product-structure) — the durable objects you work with
- [How work flows](#how-work-flows) — the closed loop around a Task
- [User message flow](#user-message-flow) — what happens when you send a message
- [Core modules](#core-modules) — the long-lived runtime pieces
- [Layered design](#layered-design) — responsibilities, top to bottom
- [Lifecycle](#lifecycle) — states a Task and WorkItem move through

### Product structure

What Yui organizes for you — durable objects, not processes:

```text
  Global
   ├─ Operator ── the Agent you converse with; spans all Projects & Tasks
   └─ Projects
       └─ Project ── a managed codebase + its Project Knowledge
           └─ Task ── one bounded outcome you asked for
               ├─ Brief ......... objective · boundaries · approach
               ├─ Roles ......... Leader (owns it) · Workers · Reviewers
               ├─ WorkItems ..... independently acceptable requirements
               │     └─ AgentRun .. one requested execution ─▶ Result
               ├─ Messages ...... durable conversation + Decisions
               └─ Review / Integration ─▶ accepted delivery
```

### How work flows

```text
  You
   │  describe work · answer questions · refine scope
   ▼
  Operator ── reads your intent, then either:
   │            • opens a NEW Task, or
   │            • APPENDS to an existing Task (a follow-up)
   ▼
  Task ── owned by one Leader, who runs the closed loop:
   │
   │   plan ─▶ split into WorkItems ─▶ deliver ─▶ review ─▶ close
   │
   │   each WorkItem is advanced by the Leader itself, or delegated:
   │     ├──▶ Worker     another Agent implements it
   │     └──▶ Reviewer   checks the result before it is accepted
   │
   ▼
  Results and decisions come back to you — and you can talk to the Leader
  directly about a task's details anytime.
```

### User message flow

What happens when you send one message — the Controller only wakes Agents; the
durable record always lives in the store:

```text
  ── Inbound ────────────────────────────────────────────────────────────────
  You ─▶ Operator ─▶ records a Task (new, or a follow-up) + a Message ─▶ yui.db
                                                                           │
                                                       Controller wakes the Leader
                                                                           ▼
  ── Work ───────────────────────────────────────────────────────────────────
  Leader reads Context ─▶ acts itself, or delegates to Workers / Reviewers
                       ─▶ writes results · decisions · messages ─▶ yui.db
                                                                           │
                                                    Controller wakes the Operator
                                                                           ▼
  ── Outbound ───────────────────────────────────────────────────────────────
  yui.db ─▶ Operator reads the updates ─▶ replies to You
```

### Core modules

The long-lived runtime pieces. You only ever talk to the Operator; Agents and
the Controller are what touch the store:

```text
  You
   │  natural-language conversation with the Operator
   │  (you never drive the Controller or the store yourself)
   ▼
  Agent sessions · in tmux
   │  Operator ── the Agent you talk to; routes requests into Tasks
   │  Leader · Workers · Reviewers ── plan, deliver and review the work
   │  each drives a native Agent via AgentHost / AgentEndpoint / Driver:
   │    Codex CLI (App Server) · Claude Code CLI (stream-json) · ACP peers
   │
   │  Agents read Context and make atomic changes (yui operations)
   ▼
  ┌─ yui.db — SQLite (WAL) · single source of truth · one txn per change
  │  Tasks · WorkItems · AgentRuns · Messages · Decisions · Results
  └─ Project Knowledge · configuration
   ▲
   │  reads & records runtime facts; wakes and delivers work to the sessions
   │
  Controller · one per Home
     delivery · Scheduler · jobs · capability host · Web listener
     it moves work and records facts — it never judges an answer

  Agents work in Projects: read-only checkout + isolated worktrees.
  Web (yui web): loopback views + authenticated user controls.
```

### Layered design

Each layer owns one responsibility and exposes small, explicit capabilities —
never a fixed workflow:

```text
  Experience   —  how you interact
    CLI (Operator) · Web (loopback, authenticated) · native Agent sessions
    collect input · show facts · confirm actions · invoke capabilities
        ▼
  Intelligence —  who decides
    Operator: recognize requests, split Tasks
    Leader:   plan · delegate · judge · complete one Task
    Workers · Reviewers   (behavior comes from Roles & Skills)
        ▼
  Capability   —  the atomic operations Yui exposes
    deliver:  Task · WorkItem · Decision · Candidate · Review
    context:  Context · Message · InputRequest · Project Knowledge
    config:   Roles · Agent config · Project · Plugin
    execute:  dispatch · inspect · stop · resources · Artifact
        ▼
  Execution    —  how work actually runs
    AgentHost / AgentEndpoint / Driver, each in a tmux session
    Codex CLI (App Server) · Claude Code CLI (stream-json) · ACP peers
    managed Git worktrees · adopted environments
        ▼
  Kernel       —  durable authority: yui.db (SQLite, WAL)
    storage · identity · permissions · operation facts · instance host

  ▲ plugins extend the Capability layer through the Capability Registry
```

### Lifecycle

Status is one authority per object; execution and waiting are runtime facts, not
extra states:

```text
  Task      draft ─▶ active ─▶ completed ─▶ archived
                        └────▶ cancelled ─▶ archived

  WorkItem  open ─▶ accepted ─▶ retired

  Draft holds planning only; activation adopts a delivery workspace.
  Ordinary archive needs settled work and clean worktrees; it cannot reopen.
```

Explicitly authorized force archive can retain unresolved evidence and unsafe
resources; it does not prove delivery or permission to delete them.
See the [archive contract](docs/task-delivery.md#archive).

## Design principles

### Agents make decisions; Yui makes work durable

Yui is a local control plane and context API, not a fixed workflow engine.
The Operator recognizes and routes requests. A Leader owns each Task's outcome
and chooses planning, delegation, review and recovery. The Controller handles
delivery and runtime facts; it does not decide whether an Agent's answer is
good enough.

Tasks, messages, decisions, original execution results and Project Knowledge
are durable context. Agents read and update that context through small,
scoped CLI operations. Session and process state support execution, but do not
replace the record of what the user asked for.

### Separate the task from the conversation

A Task is the outcome; a WorkItem is an independently acceptable requirement;
a Session is a native conversation; an AgentRun is an explicitly requested
execution. Keeping them separate lets you discuss a Task without starting work,
continue a requirement across executions, and inspect the original result
without confusing “the Agent finished speaking” with “the work was accepted.”

A Draft can hold planning before adopting a delivery workspace. For repository
work, changes happen in managed worktrees rather than the stable Project
checkout. The Leader evaluates results and coordinates review and integration
against the actual scope.

### Keep execution replaceable and authority explicit

Codex CLI, Claude Code CLI and ACP connections—including a Claude Agent SDK
bridge—share an execution boundary while retaining their native capabilities
and conversations. Configured intent and what the running Agent actually reports
are distinct facts; Yui does not pretend every integration behaves identically.

When a Task needs an additional capability, its Leader can create and validate a
Task-local plugin and explicitly activate it within existing authority.
Executable plugins need specific execution grants. Results can be saved
independently of the plugin or Session that produced them.

Yui is designed for one trusted local user. It is not an OS sandbox or a remote
multi-user service. Publishing, granting new access and other external effects
still require the corresponding authority.

## How Yui compares

|  | Chat-only agent | Agent CLI + tmux, by hand | Yui |
| --- | --- | --- | --- |
| Work survives the session | no | your own notes | durable Tasks in one store |
| New request vs. follow-up | you decide | you decide | the Operator routes it |
| Multi-step delegation | manual | manual | Leader → WorkItems → Workers/Reviewers |
| Swap model/agent mid-task | context lost | manual re-setup | replaceable behind one boundary |
| Parallel work isolation | — | you manage branches | managed Git worktrees |
| Where the truth lives | the chat log | scattered | one SQLite source of truth |

## Learn more

The [architecture overview](ARCHITECTURE.md) explains the end-to-end design.
The [documentation map](docs/architecture/README.md) links the current contracts
for configuration, execution, delivery, storage and plugins. Use `yui --help`
when you want to operate the CLI directly.

Yui stores its control-plane data under `~/.yui` by default; `YUI_HOME` selects
another instance. See [storage and upgrades](docs/sqlite-control-plane-design.md)
before moving between builds or updating an existing Home.

## Contributing

Start with [CONTRIBUTING.md](CONTRIBUTING.md) for the full workflow, and please
follow our [Code of Conduct](CODE_OF_CONDUCT.md). In short: in a source
checkout, run `npm ci` and `npm test`. Read
`.agents/skills/develop-yui/SKILL.md` and the
[verification policy](docs/testing/verification-levels.md).
Source builds also need a Linux C compiler and static libc development libraries
for the Claude process owner. Published packages include that executable;
npm users do not need to compile it.

To exercise your checkout, run `make install-local`, then use the absolute
`<checkout>/output/dev/bin/yui` launcher. It defaults to an isolated Home under
that checkout; run its `setup` before stateful use. Do not use the global `yui`
or `make link` to validate local changes. Live-model, paid or shared-resource
tests require an explicit request for those resources.

## Community and support

- Questions, bugs and feature requests: open a
  [GitHub issue](https://github.com/zhangqian-silk/yui/issues).
- Security: see the [security policy](SECURITY.md). Yui targets one trusted
  local user and is not an OS sandbox or a remote service; please report
  sensitive issues privately instead of opening a public issue.

## License

[MIT](LICENSE)
