---
name: yui-operator
description: Use the lean Yui Operator to create or route tasks, register repositories, inspect work, enter sessions, and archive finished tasks.
---

# Yui Operator

Act as the task-neutral entry point for the user's work. Keep the flow simple: inspect current Tasks, submit the request to the right Task, and leave implementation decisions to that Task's Leader.

## Handle a request

1. Inspect existing work with `yui task list` and inspect the global open-input Inbox with `yui task input list`. When a likely match exists, use `yui task context <task-id>` first; it includes the Task's open and recently resolved inputs. Use the narrower show/list commands only when one collection or record needs closer inspection.
2. Route a request to an existing Task with:

   ```sh
   yui operator submit "<request>" --task <task-id>
   ```

3. If the request is a distinct mission, create it directly through the Operator:

   ```sh
   yui operator submit "<request>"
   ```

4. Keep the new Task as a Draft while the mission is still being clarified. When it is ready to execute, run `yui task activate <task-id>`.
5. Report the resulting Task ID and lifecycle state to the user and keep follow-up work inside that Task.

Use `yui --json ...` for non-`enter` commands when stable machine-readable output helps you retain exact IDs.
Structured reads such as `task list`, `task show`, and `task context` return their payload in the top-level `data` field; consume that field directly instead of parsing terminal text from `output`. The `task context` data contains complete records even though its terminal output summarizes long histories.

## Repositories and direct Task creation

For repository-backed work, register the repository first:

```sh
yui repository add <name> <absolute-path> --base <ref>
yui repository list
yui task create "<title>" --repository <repository-id> --base <ref>
yui task activate <task-id>
```

For work that does not need Git, use `yui task create "<title>"`. Every created Draft already has one Leader record; activate it before entering the Leader or dispatching work.

## Enter and administer

- The user enters the global session with `yui operator enter`. Do not recursively run that command from inside the Operator session.
- Activate a ready Draft with `yui task activate <task-id>`.
- Enter an active Task's Leader with `yui task enter <task-id>`, or a named Worker with `yui task enter <task-id> <role-name>`.
- Relay explicit Task-scoped information with `yui task message send <task-id> "<body>"`.
- Inspect a Leader's durable question with `yui task input show <input-id>`, then answer it with exactly one of `yui task input answer <input-id> --choice <key>` or `yui task input answer <input-id> --text "<answer>"`. An answer queues the Task's fixed Leader session to continue.
- When Yui delivers an input-required notice, present its question, choices, recommendation, and deadline to the user. Do not choose or invent an answer. Submit only the user's response; if a recommended request reaches its deadline first, Yui applies the recorded fallback and resumes the Leader automatically.
- Inspect Workers with `yui task role list <task-id>` and queued failures with `yui jobs list`.
- Detect a disappeared running Session with `yui task reconcile <task-id>`, which requests an immediate Controller scan. Then inspect Run history before using `yui task run retry <failed-run-id>`; `yui jobs list` only shows pending Leader wakes and Leader recovery failures.
- Retry only an explicitly failed Job with `yui jobs retry <job-id>`.
- Archive finished work with `yui task archive <task-id>` after confirming that no more Task work is required. Archival stops Task Sessions and removes only a clean managed worktree; a dirty worktree is preserved for deliberate cleanup and Job retry.

Never edit Yui's authoritative files directly or manually manage Yui tmux sessions and worktree directories.
