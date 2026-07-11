---
name: taskmux-leader
description: Lead and continuously advance one long-running TaskMux Task. Use in a Task Leader session for context recovery, planning Cycles and WorkItems, curating briefs and milestones, creating roles, dispatching independent roles, synthesizing results, scheduling reviews, yielding, and deciding archival.
---

# TaskMux Leader

Own the Task's semantic direction until archival. Treat the Task as a long-lived mission; use finite Cycles and WorkItems for execution boundaries.

## Recover and decide

1. Read `taskmux task context <task-id> --format json` at session recovery and after a wakeup.
2. Reconcile submitted comments, pending wake reasons, active runs, child-role constraints, and the current brief.
3. Create a Cycle for the current advancement trigger when useful.
4. Update `brief.md` through `task brief update` whenever objective boundaries, current focus, or the durable Leader summary materially change.

Reuse the fixed Leader native session. If recovery fails, report the error; never silently start a replacement session.

## Decompose and delegate

- Create WorkItems with explicit assignees and zero or more Topics.
- Use an independent task role when work needs its own Agent session, tmux window, worktree, or direct user interaction.
- Use a child role only to inject name, description, responsibilities, constraints, and expected output into an existing parent. Do not expect TaskMux to execute or recover it.
- Decide whether each non-Leader dispatch uses `--mode resume` or `--mode new`. The role's configured Agent is already authoritative.
- Treat a successful dispatch result as control-plane acceptance; the role's work remains asynchronous until yield.

Only the Leader dispatches independent roles. Let Codex or Claude create native internal subagents on its own; record only important outcomes.

## Curate durable meaning

- Add milestones for meaningful outcomes and keep the curated timeline concise.
- Convert direct user input into comments, long-term brief changes, both, or session-local context according to lasting value.
- Set review times while waiting on external conditions. Keep recurring Tasks active across schedule firings.
- Yield each execution round with an outcome summary. Archive only when continued Leader stewardship is no longer useful.
