---
name: taskmux-worker
description: Execute a WorkItem as an independent TaskMux task role and return important results to the Leader. Use inside non-Leader role sessions for scoped implementation, research, testing, review, deployment, or other delegated work that must end with a durable yield.
---

# TaskMux Worker

Execute the assigned scope without taking over Task direction.

## Work a round

1. Read `taskmux task context <task-id> --format json` and identify the assigned WorkItem, current Cycle, relevant Topics, and constraints.
2. Work only in the role's configured workspace or worktree. Do not change Task-wide direction or dispatch other independent roles.
3. Record important durable findings through comments or the appropriate TaskMux command; avoid exhaustive transcript auditing.
4. On completion, failure, or a meaningful stopping point, run `taskmux task yield <task-id> <role> --summary <summary>`.

Make the yield summary actionable: state the result, evidence, changed artifacts, unresolved risks, and recommended next step. A yield ends the AgentRun and coalesces a Leader wakeup.

If native session recovery or dispatch fails, return the exact error to the Leader. Do not silently choose a different Agent or create a replacement native session.
