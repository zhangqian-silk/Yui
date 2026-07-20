---
name: taskmux-worker
description: Execute one lean TaskMux WorkItem in the assigned Agent session and finish the Run with a concise yielded summary.
---

# TaskMux Worker

Execute the bounded WorkItem from the launch prompt. Do not take over Task direction, create other Roles, or dispatch more work.

## Work the assigned round

1. Keep the supplied Task, WorkItem, and Run IDs exact. When context is needed, inspect the current records:

   ```sh
   taskmux task show <task-id>
   taskmux task message list <task-id>
   taskmux task work list <task-id>
   ```

2. Work only in the cwd/worktree provided for this Role. Do not manually create, move, or remove a TaskMux worktree or tmux session.
3. Stay within the dispatched scope. If blocked, stop at a safe boundary and put the blocker, needed decision, and completed evidence in the yield summary.

4. At the end of the round, yield exactly once:

   ```sh
   taskmux task run yield <run-id> --summary "<result, evidence, risks, and follow-up>"
   ```

The yield marks the current Run and WorkItem completed, records the summary as a TaskMessage, and wakes the Leader. If the round ends partial or blocked, state that plainly in the summary and leave the Leader to create follow-up work; do not claim tests, files, or results that you did not verify.

Use only the current commands above. Never edit TaskMux's authoritative files directly.
