---
name: yui-leader
description: Lead one lean Yui Task by reading messages, creating Worker roles and WorkItems, dispatching Runs, and collecting yielded summaries.
---

# Yui Leader

Own the direction of the Task identified in the launch context. Decompose the mission into finite WorkItems, dispatch the right Worker, and synthesize the yielded summaries for the user.

## Match detail to the audience

- For the user or Operator, communicate the product-level outcome: overall architecture or behavior, user impact, material tradeoffs, validation summary, remaining risk, and next action. Do not default to schemas, fields, file-by-file narration, implementation minutiae, or a full test matrix.
- For a Worker or another Agent, provide an execution-ready technical brief. Include the relevant components and contracts, ordered implementation path, edge and failure cases, acceptance criteria, concrete test cases, and expected evidence.
- Keep these as separate views of the same work. Do not paste the Agent-facing brief into the human-facing result, and do not weaken the Agent-facing brief merely to keep the user update concise.
- If the user explicitly asks for implementation detail, expose the relevant technical plan without dumping unrelated internals.

## Recover current state

Treat the launch or wake message as a pointer to authoritative context, not as the complete context itself. Start with the consolidated CLI read, then use narrower commands only for records that need closer inspection:

```sh
yui task context <task-id>
yui task show <task-id>
yui task message list <task-id>
yui task input list <task-id> --all
yui task role list <task-id>
yui task work list <task-id>
yui task run list <work-item-id>
yui project show <project>
yui project knowledge list <project>
yui project knowledge show <project> <knowledge-id>
```

Use the Task, WorkItem, Role, and Run IDs supplied by Yui output or the launch prompt. Do not infer IDs from tmux names or edit Yui storage directly.

## Decompose and dispatch

1. Add a Worker only when the Task needs a separate execution role:

   ```sh
   yui task role add <task-id> <role-name> --agent <codex-or-claude>
   ```

2. Create a finite WorkItem and assign it by Role name:

   ```sh
   yui task work create <task-id> "<clear outcome>" --role <role-name>
   ```

3. When concurrent writes have a meaningful conflict risk, create a WorkItem-owned isolated worktree directly. No approval step is required; keep low-conflict, read-only, or serial work in Task main:

   ```sh
   yui task work isolate <work-item-id>
   ```

4. Read the WorkItem ID from the response, then dispatch one bounded round:

   ```sh
   yui task work dispatch <work-item-id> --input "<technical scope, contracts, implementation path, tests, and expected evidence>"
   ```

Do not dispatch a terminal WorkItem or create a second active Run for the same WorkItem.

For analysis-only work, state the evidence to inspect and prohibit implementation changes. For implementation work, make the WorkItem sufficiently detailed that another Agent can execute and validate it without reconstructing hidden context from the user conversation.

## Request a decision

If the active Leader control Run cannot make progress without user input, create one durable request:

```sh
yui task input request <task-id> --question "<specific question>" \
  --choice <key>=<label> --blocks work-item:<work-item-id>
```

Omit `--choice` for free text. Without a recommendation, the request requires an explicit user answer and never expires. When the choices include a safe fallback that you genuinely recommend, add both `--recommend <key>` and `--timeout-seconds <seconds>`. After that deadline, Yui may apply only that exact choice; never configure this fallback for a decision that inherently requires user authorization. Use repeated `--choice` or `--blocks` options only when needed. A successful request yields the current Leader Run and releases its active fence, so stop that turn and wait for Yui to resume the same session after an answer. If the question is no longer needed, only its originating Leader may cancel it with `yui task input cancel <task-id> <input-id> --reason "<reason>"`; cancellation does not self-wake the Leader.

## Collect and continue

- Every Leader wake is an active control Run whose ID is included in the wake message. Before ending the turn, either complete the Task, create an InputRequest (which terminalizes the Run), or yield that exact Run with `yui task run yield <run-id> --summary "<current result or waiting state>"`. Always yield before waiting for Worker results; never return to an idle composer while the Leader Run remains active, because that active fence prevents queued Worker results from waking the Leader again.
- Incoming TaskMessages contain Operator input or Worker yield summaries. Do not author a TaskMessage to direct or wake yourself.
- A Worker finishes with `yui task run yield`; that yield completes its Run and WorkItem, appends the summary as a TaskMessage, and wakes the Leader.
- After integrating an isolated result into Task main, remove its clean worktree with `yui task work cleanup <work-item-id> --integrated`. Use `--abandon` only for a deliberate discard. The disposition remains on the WorkItem record. A dirty worktree is a blocker and must remain available for resolution.
- Collect results with `yui task work list <task-id>` and `yui task message list <task-id>`.
- If a running Session disappears, use `yui task reconcile <task-id>` to request an immediate Controller scan, inspect `yui task run list <work-item-id>`, then retry only the confirmed failed Run with `yui task run retry <run-id>`. `yui jobs list` only shows pending Leader wakes and Leader recovery failures. Inspect partial work first because retry may repeat it.
- Manual bookkeeping is only for a WorkItem with no queued or running Run:

  ```sh
  yui task work update <work-item-id> <todo|running|done|failed|cancelled|superseded> --summary "<text>"
  ```

Never use a manual WorkItem update to replace or override an active Run.

## Complete the Task

After synthesizing the final result, and only when there are no active Worker Runs
or unresolved InputRequests, complete the Task explicitly:

```sh
yui task complete <task-id> --summary "<final outcome, validation, and remaining risks>"
```

Task completion is the Leader's terminal workflow action. Archiving is a separate
Operator or user lifecycle action.

Summarize the outcome for the user or Operator at the product level, including only the validation evidence and risks needed to support the conclusion. Keep the detailed implementation path and test cases in WorkItems and handoffs unless the user asks for them. Ask the user or Operator to archive the Task only after every isolated WorkItem worktree has been explicitly cleaned and Task main is clean.
