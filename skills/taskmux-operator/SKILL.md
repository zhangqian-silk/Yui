---
name: taskmux-operator
description: Use the lean TaskMux Operator to create or route tasks, register repositories, inspect work, enter sessions, and archive finished tasks.
---

# TaskMux Operator

Act as the task-neutral entry point for the user's work. Keep the flow simple: inspect current Tasks, submit the request to the right Task, and leave implementation decisions to that Task's Leader.

## Handle a request

1. Inspect existing work with `taskmux task list`. When a likely match exists, use `taskmux task context <task-id>` first; use the narrower show/list commands only when one collection or record needs closer inspection.
2. Route a request to an existing Task with:

   ```sh
   taskmux operator submit "<request>" --task <task-id>
   ```

3. If the request is a distinct mission, create it directly through the Operator:

   ```sh
   taskmux operator submit "<request>"
   ```

4. Keep the new Task as a Draft while the mission is still being clarified. When it is ready to execute, run `taskmux task activate <task-id>`.
5. Report the resulting Task ID and lifecycle state to the user and keep follow-up work inside that Task.

Use `taskmux --json ...` for non-`enter` commands when stable machine-readable output helps you retain exact IDs.
Structured reads such as `task list`, `task show`, and `task context` return their payload in the top-level `data` field; consume that field directly instead of parsing terminal text from `output`. The `task context` data contains complete records even though its terminal output summarizes long histories.

## Repositories and direct Task creation

For repository-backed work, register the repository first:

```sh
taskmux repository add <name> <absolute-path> --base <ref>
taskmux repository list
taskmux task create "<title>" --repository <repository-id> --base <ref>
taskmux task activate <task-id>
```

For work that does not need Git, use `taskmux task create "<title>"`. Every created Draft already has one Leader record; activate it before entering the Leader or dispatching work.

## Enter and administer

- The user enters the global session with `taskmux operator enter`. Do not recursively run that command from inside the Operator session.
- Activate a ready Draft with `taskmux task activate <task-id>`.
- Enter an active Task's Leader with `taskmux task enter <task-id>`, or a named Worker with `taskmux task enter <task-id> <role-name>`.
- Relay explicit Task-scoped information with `taskmux task message send <task-id> "<body>"`.
- Inspect Workers with `taskmux task role list <task-id>` and queued failures with `taskmux jobs list`.
- Detect a disappeared running Session with `taskmux task reconcile <task-id>`, which requests an immediate Controller scan. Then inspect Run history before using `taskmux task run retry <failed-run-id>`; `taskmux jobs list` only shows pending Leader wakes and Leader recovery failures.
- Retry only an explicitly failed Job with `taskmux jobs retry <job-id>`.
- Archive finished work with `taskmux task archive <task-id>` after confirming that no more Task work is required. Archival stops Task Sessions and removes only a clean managed worktree; a dirty worktree is preserved for deliberate cleanup and Job retry.

Never edit TaskMux's authoritative files directly or manually manage TaskMux tmux sessions and worktree directories.
