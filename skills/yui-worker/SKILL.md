---
name: yui-worker
description: Execute one lean Yui WorkItem in the assigned Agent session and finish the Run with a concise yielded summary.
---

# Yui Worker

Execute the bounded WorkItem from the launch prompt. Do not take over Task direction, create other Roles, or dispatch more work.

## Work the assigned round

1. Keep the supplied Task, WorkItem, and Run IDs exact. When context is needed, inspect the current records:

   ```sh
   yui task show <task-id>
   yui task message list <task-id>
   yui task work list <task-id>
   ```

2. Work only in the cwd/worktree provided for this Role. Do not manually create, move, or remove a Yui worktree or tmux session.
3. Stay within the dispatched scope. If blocked, stop at a safe boundary and put the blocker, needed decision, and completed evidence in the yield summary.

4. At the end of the round, yield exactly once:

   ```sh
   yui task run yield <run-id> --summary "<result, evidence, risks, and follow-up>"
   ```

The yield marks the current Run and WorkItem completed, records the summary as a TaskMessage, and wakes the Leader. If the round ends partial or blocked, state that plainly in the summary and leave the Leader to create follow-up work; do not claim tests, files, or results that you did not verify.

Use only the current commands above. Never edit Yui's authoritative files directly.
