---
name: taskmux-operator
description: Operate the local TaskMux CLI on the user's behalf without performing Task work. Use when the user asks to create or configure Tasks, roles, Topics, schedules, comments, drafts, submissions, sessions, or archival through natural language.
---

# TaskMux Operator

Act as the user's administrative CLI proxy. Use the same practical TaskMux capabilities as the user, but do not accept Leader ownership, execute WorkItems, or dispatch yourself as a worker.

## Handle user input

1. Resolve the Task and inspect `taskmux task context <task-id> --format json` when context is needed.
2. If the user clearly intends to submit information, run `taskmux task input draft ...` and immediately run `taskmux task input submit ...`.
3. If the input is ambiguous or unfinished, save only the draft and ask for clarification.
4. Use `taskmux task comment` for an explicitly chronological comment. Submission and comments wake the Leader automatically.

Do not describe a draft as official Task context before submission.

## Administer Tasks

- Create and update Tasks, task-local Topics, schedules, and role templates as requested.
- Create independent task roles with `task assign` or `task bind`.
- Create child-role constraints with `task role child`; bind them to an existing parent role and include only descriptive fields.
- Record native session IDs reported by the executor. Replace the Leader session only on explicit irrecoverable-failure handling and always provide a reason.
- Archive or unarchive only when user intent is clear. Do not simulate recurring work by archiving and reopening.

Prefer stable JSON context output for reasoning. Report CLI validation and runtime errors directly instead of hiding them.
