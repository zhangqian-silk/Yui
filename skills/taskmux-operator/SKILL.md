---
name: taskmux-operator
description: Operate the local TaskMux CLI on the user's behalf without performing Task work. Use when the user asks to create or configure Tasks, roles, Topics, schedules, comments, input decisions, sessions, or archival through natural language.
---

# TaskMux Operator

Act as the user's administrative CLI proxy. Use the same practical TaskMux capabilities as the user, but do not accept Leader ownership, execute WorkItems, or dispatch yourself as a worker.

## Handle user input

The complete public input-request surface is `taskmux task input request`, `taskmux task input list`, `taskmux task input show`, `taskmux task input answer`, and `taskmux task input cancel`.

1. Inspect the Global Inbox with `taskmux task input list [<task-id>]` and `taskmux task input show <request-id> [--task <task-id>]`. It is a global query over Task-owned requests, not a second durable inbox.
2. When the user supplies a requested decision, answer it with `taskmux task input answer <request-id> (--choice <key> | --text <text>)`. This records the resolution and queues the exact Leader wakeup; do not manually wake or dispatch the Leader.
3. Only an active Leader task-role session may create or cancel a request with `taskmux task input request` or `taskmux task input cancel`. Never fabricate the exact Leader origin tuple: role, Agent, adapter, session root, native session, and AgentRun.
4. Treat `user-required` as waiting indefinitely for the user. An `offline-recommended` request can persist its recommendation only after continuous confirmed-offline foreground Operator presence; online or unknown presence does not advance a timeout.
5. Use `taskmux task comment` for explicitly chronological information that is not an input request. Do not convert ambiguous information into a request or claim that it is durable Task direction.

Do not describe an unrecorded conversation as official Task context.

## Respect foreground Operator delivery

The foreground Operator is only the active binding with a running matching session in `GlobalRoleSessionSet`; a tmux window without that proof is unknown, not an absent Operator. Each bound Agent has independent configuration and session state, while the Role has one active Agent at a time.

An input delivery is pointer-only: it refers to the Task-owned request and contains no second question or answer body. Its receipt means the foreground transport accepted the notification, not that a user saw or answered it.

## Administer Tasks

- Create and update Tasks, task-local Topics, schedules, and role templates as requested.
- Create independent task roles with `task assign` or `task bind`.
- Create child-role constraints with `task role child`; bind them to an existing parent role and include only descriptive fields.
- Record native session IDs reported by the executor. Replace the Leader session only on explicit irrecoverable-failure handling and always provide a reason.
- Archive or unarchive only when user intent is clear. Do not simulate recurring work by archiving and reopening.

Prefer stable JSON context output for reasoning. Report CLI validation and runtime errors directly instead of hiding them.
