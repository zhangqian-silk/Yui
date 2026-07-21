---
name: taskmux-leader
description: Lead one lean TaskMux Task by reading messages, creating Worker roles and WorkItems, dispatching Runs, and collecting yielded summaries.
---

# TaskMux Leader

Own the direction of the Task identified in the launch context. Decompose the mission into finite WorkItems, dispatch the right Worker, and synthesize the yielded summaries for the user.

## Recover current state

Use only the public current commands:

```sh
taskmux task show <task-id>
taskmux task message list <task-id>
taskmux task input list <task-id> --all
taskmux task role list <task-id>
taskmux task work list <task-id>
taskmux task run list <work-item-id>
```

Use the Task, WorkItem, Role, and Run IDs supplied by TaskMux output or the launch prompt. Do not infer IDs from tmux names or edit TaskMux storage directly.

## Decompose and dispatch

1. Add a Worker only when the Task needs a separate execution role:

   ```sh
   taskmux task role add <task-id> <role-name> --agent <codex-or-claude>
   ```

2. Create a finite WorkItem and assign it by Role name:

   ```sh
   taskmux task work create <task-id> "<clear outcome>" --role <role-name>
   ```

3. Read the WorkItem ID from the response, then dispatch one bounded round:

   ```sh
   taskmux task work dispatch <work-item-id> --input "<scope, constraints, and expected evidence>"
   ```

Do not dispatch a terminal WorkItem or create a second active Run for the same WorkItem.

## Request a decision

If the active Leader control Run cannot make progress without user input, create one durable request:

```sh
taskmux task input request <task-id> --question "<specific question>" \
  --choice <key>=<label> --blocks work-item:<work-item-id>
```

Omit `--choice` for free text. Without a recommendation, the request requires an explicit user answer and never expires. When the choices include a safe fallback that you genuinely recommend, add both `--recommend <key>` and `--timeout-seconds <seconds>`. After that deadline, TaskMux may apply only that exact choice; never configure this fallback for a decision that inherently requires user authorization. Use repeated `--choice` or `--blocks` options only when needed. A successful request yields the current Leader Run and releases its active fence, so stop that turn and wait for TaskMux to resume the same session after an answer. If the question is no longer needed, only its originating Leader may cancel it with `taskmux task input cancel <task-id> <input-id> --reason "<reason>"`; cancellation does not self-wake the Leader.

## Collect and continue

- Incoming TaskMessages contain Operator input or Worker yield summaries. Do not author a TaskMessage to direct or wake yourself.
- A Worker finishes with `taskmux task run yield`; that yield completes its Run and WorkItem, appends the summary as a TaskMessage, and wakes the Leader.
- Collect results with `taskmux task work list <task-id>` and `taskmux task message list <task-id>`.
- If a running Session disappears, use `taskmux task reconcile <task-id>` to request an immediate Controller scan, inspect `taskmux task run list <work-item-id>`, then retry only the confirmed failed Run with `taskmux task run retry <run-id>`. `taskmux jobs list` only shows pending Leader wakes and Leader recovery failures. Inspect partial work first because retry may repeat it.
- Manual bookkeeping is only for a WorkItem with no queued or running Run:

  ```sh
  taskmux task work update <work-item-id> <todo|running|done|failed> --summary "<text>"
  ```

Never use a manual WorkItem update to replace or override an active Run.

Summarize the outcome, tests or evidence, remaining risks, and next action. Ask the user or Operator to archive the Task when continued Leader work is no longer useful.
