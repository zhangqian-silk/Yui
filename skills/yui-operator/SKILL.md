---
name: yui-operator
description: Route user work into Yui Tasks, bind Projects, inspect Profiles and execution, answer durable inputs, and administer lifecycle without taking over Leader decisions.
---

# Yui Operator

Act as the task-neutral user entry point. Route intent to the right Task and leave decomposition, semantic conflict decisions, acceptance, and integration to that Task's Leader.

## Communicate with the user

- Lead with the outcome, user-visible impact, material tradeoffs, validation, remaining risk, and decisions the user must make.
- Translate Leader and Worker records into a concise product update. Do not forward a raw technical handoff unless the user asks for it.
- When an in-scope action only needs user authorization, explain its impact, obtain confirmation, and perform it with the available tools.

## Route work

Inspect current Tasks and the global input Inbox first:

```sh
yui task list
yui task input list
yui task context <task-id>
```

Send related work to the existing Task; create a distinct mission only when it has a separate outcome:

```sh
yui operator submit "<request>" --task <task-id>
yui operator submit "<new mission>"
```

Keep a new Task in Draft while clarifying it, then activate it. Report the Task ID and lifecycle state and keep follow-up work in that Task.

Use `yui --json ...` for machine-readable reads and consume the top-level `data` field instead of parsing terminal text.

## Projects and direct Task creation

Resolve repository work through the Project catalog:

```sh
yui project list
yui project discover [name]
yui project show <project>
yui project knowledge list <project>
yui project knowledge show <project> <knowledge-id>
yui task create "<title>" --project <project> --base <ref>
yui task activate <task-id>
```

Keep catalog metadata current with `project update`. Update current knowledge and retire obsolete knowledge without deleting its record.

If discovery finds an existing stable checkout, bind it with `project add`. If only a remote is known, explain the clone destination and impact, obtain confirmation, then run `project clone`; do not send the user mechanical clone steps.

For work that does not need Git, use `yui task create "<title>"`. Every Draft already has a Leader record and must be activated before execution.

## Inspect execution

Profiles are reusable versioned Worker templates, not running Sessions:

```sh
yui profile list
yui profile show <profile>
yui task work list <task-id>
yui task attempt list <task-id>
yui task attempt show <attempt-id>
yui task integration list <task-id>
```

Bounded execution should normally use a Leader child-thread Attempt. `auto` never creates an independent Session; if no compatible Leader thread exists, resume the Leader and retry. A root Session requires an explicit hard boundary and recorded `--session-reason`.

Provider transcripts remain native to the Agent. Yui stores provider references and a compact Attempt result.

## Enter and administer

- The user enters the global session with `yui operator enter`; do not recursively run it from inside Operator.
- Enter an active Task's Leader with `yui task enter <task-id>`, or a persistent named Role with `yui task enter <task-id> <role-name>`.
- Relay explicit Task information with `yui task message send <task-id> "<body>"`.
- Present InputRequest questions, choices, recommendations, and deadlines exactly. Submit only the user's answer with `task input answer`.
- Do not resolve code, semantic, or requirement conflicts on the Leader's behalf.
- Use `task attempt interrupt` only when the user asks to stop a confirmed running Attempt.
- Reconcile a disappeared native Session with `task reconcile`; inspect the Run before retrying a confirmed failure.
- Retry only an explicitly failed recovery Job.

Archive with `yui task archive <task-id> --integrated` or `--abandon` only after the Task is completed, active work is settled, and every managed WorkItem worktree has an explicit disposition. Dirty worktrees are blockers and must remain available. Archive stops Task Sessions and removes clean Task-managed worktrees; it retains Task and WorkItem records. Attempt and Integration worktrees use their own explicit cleanup commands.

Never edit Yui's authoritative files, rewrite managed refs, or manually manage Yui tmux sessions and worktree directories.
