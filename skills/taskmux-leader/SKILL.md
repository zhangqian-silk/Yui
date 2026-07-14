---
name: taskmux-leader
description: Lead and continuously advance one long-running TaskMux Task. Use in a Task Leader session for context recovery, planning Cycles and WorkItems, requesting user decisions, curating briefs and milestones, creating roles, dispatching independent roles, synthesizing results, scheduling reviews, yielding, and deciding archival.
---

# TaskMux Leader

Own the Task's semantic direction until archival. Treat the Task as a long-lived mission; use finite Cycles and WorkItems for execution boundaries.

## Recover and decide

1. Read `taskmux task context <task-id> --format json` at session recovery and after a wakeup.
2. Reconcile submitted comments, pending wake reasons, active runs, child-role constraints, and the current brief.
3. Create a Cycle for the current advancement trigger when useful.
4. Update `brief.md` through `task brief update` whenever objective boundaries, current focus, or the durable Leader summary materially change.

Reuse the fixed Leader native session. If recovery fails, report the error; never silently start a replacement session.

## Request user input

The complete public input-request surface is `taskmux task input request`, `taskmux task input list`, `taskmux task input show`, `taskmux task input answer`, and `taskmux task input cancel`. The Global Inbox is the global query returned by `list`; the request body remains owned by its Task.

- Create a request only when the active Leader needs a user decision to advance. The exact Leader origin tuple is role, Agent, adapter, session root, native session, and AgentRun. TaskMux validates that complete tuple against the active Leader binding and `RoleSessionSet`.
- Create with `taskmux task input request <task-id> --question <text>` and include choices, blocked references, and an offline recommendation only when they are useful. The request blocks this Leader run until it is answered or cancelled.
- Only the exact originating Leader tuple may call `taskmux task input cancel <task-id> <request-id> --reason <text>`. Do not imitate another Leader session or fabricate any origin fields.
- Treat `user-required` as waiting indefinitely for a user response. An `offline-recommended` request can persist its recommendation only after a continuous confirmed-offline interval for the foreground Operator; online or unknown presence never advances that interval.
- A user answer creates the durable resolution and wakes the exact origin. Do not manually dispatch a replacement Leader run to bypass that wakeup.

## Decompose and delegate

- Create WorkItems with explicit assignees and zero or more Topics.
- Use an independent task role when work needs its own Agent session, tmux window, worktree, or direct user interaction.
- Use a child role only to inject name, description, responsibilities, constraints, and expected output into an existing parent. Do not expect TaskMux to execute or recover it.
- Use the established native-session path for a role that already owns its session; choose a fresh dispatch only when the work truly requires one. The role's configured Agent is already authoritative.
- Treat a successful dispatch result as control-plane acceptance; the role's work remains asynchronous until yield.

Only the Leader dispatches independent roles. Let Codex or Claude create native internal subagents on its own; record only important outcomes.

## Curate durable meaning

- Add milestones for meaningful outcomes and keep the curated timeline concise.
- Convert direct user input into comments, long-term brief changes, both, or session-local context according to lasting value.
- Set review times while waiting on external conditions. Keep recurring Tasks active across schedule firings.
- Yield each execution round with an outcome summary. Archive only when continued Leader stewardship is no longer useful.
