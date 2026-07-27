---
name: yui-leader
description: Lead one Yui Task through bounded WorkItems, subagent-first Attempts, Task Role Runs, acceptance, and safe ChangeSet integration.
---

# Yui Leader

Own Task direction, decomposition, semantic decisions, acceptance, and integration. Prefer bounded child-thread Attempts. Do not create an independent Session merely because work writes files, needs another model, needs persistence, or benefits from an isolated worktree.

## Match detail to the audience

- Give the user or Operator the product outcome, impact, material tradeoffs, validation summary, remaining risk, and next action.
- Give a Worker or Attempt an execution-ready technical brief: relevant contracts, ordered work, acceptance criteria, checks, and expected evidence.
- Keep these as two views of the same work. Do not paste the execution brief into the user-facing result unless the user asks for it.

## Recover current state

Treat a launch or wake message as a pointer, not the complete context. Start with the consolidated read, then inspect only the narrower records you need:

```sh
yui task context <task-id>
yui task work list <task-id>
yui task attempt list <task-id>
yui task integration list <task-id>
yui task input list <task-id> --all
yui project show <project>
yui project knowledge list <project>
```

Use exact IDs returned by Yui. Never edit `state.json`, managed branches, worktrees, or provider IDs directly.

## Decompose

Create finite WorkItems that describe intent:

```sh
yui task work create <task-id> "<title>" \
  --objective "<bounded outcome>" \
  --accept "<observable criterion>" \
  --after <dependency-work-id>
```

Repeat `--accept` and `--after` only when needed. Dependencies are real ordering constraints. A likely same-file edit is not by itself a dependency: isolated write worktrees may run concurrently and integration handles overlap later.

For analysis-only work, require source evidence and prohibit changes. For implementation work, include enough acceptance detail that another Agent can execute and validate it without reconstructing the user conversation.

## Choose an execution path

Use an ExecutionAttempt for normal bounded delegation:

```sh
yui task attempt dispatch <work-id> \
  --profile <explorer|implementer|reviewer|worker> \
  --mode auto \
  --access <read|write> \
  --input "<scope and evidence required>"
```

`auto` uses a child thread of this Leader and fails fast when no compatible Leader thread is available. Resume the Leader and retry; it never silently creates a root Session. A write Attempt receives an isolated Project worktree and may overlap paths with other write Attempts.

Use `session` only for a hard boundary: sustained direct user control, survival beyond the Leader, independent credentials or permissions, a provider without child-thread support, independently approved irreversible external effects, or an explicit user request. Record the concrete reason:

```sh
yui task attempt dispatch <work-id> --profile <profile> --mode session \
  --session-reason "<hard boundary>"
```

Use a Task Role Run when the work genuinely benefits from a persistent native tmux Role session:

```sh
yui task role add <task-id> <role-name> --agent <codex-or-claude>
yui task work create <task-id> "<outcome>" --role <role-name>
yui task work dispatch <work-id> --input "<execution brief>"
```

For meaningful concurrent-write risk on this Role path, isolate the assigned WorkItem directly:

```sh
yui task work isolate <work-id>
```

Do not dispatch terminal work or create a second active Run for the same WorkItem.

## Integrate and decide

A successful write Attempt returns a ChangeSet. Integrate one or more ChangeSets in a candidate worktree:

```sh
yui task integration start <task-id> \
  --change-set <change-set-id> \
  --check "<validation command>"
```

Yui validates the candidate and advances the target with compare-and-swap. A failed candidate does not advance the target. Deterministic mechanics may be automated; code, semantic, and requirement conflicts require this Leader's complete Task context.

Inspect the candidate and record the decision:

```sh
yui task integration show <integration-id>
yui task integration resolve <integration-id> \
  --option <manual-resolution|reject> \
  --rationale "<intended semantics and evidence>"
```

For manual resolution, edit only the reported candidate worktree, finish the Git conflict, then continue. The checks registered by `integration start` are reused:

```sh
yui task integration continue <integration-id>
```

## Accept, recover, and clean up

Attempt success is not WorkItem completion. Review the result, checks, and integrated ChangeSet before accepting:

```sh
yui task attempt show <attempt-id>
yui task work accept <work-id> --summary "<acceptance evidence>"
```

Reject an insufficient awaiting result so it can be retried:

```sh
yui task work reject <work-id> --summary "<missing acceptance evidence>"
```

After accepted work is integrated and no longer needed for inspection, clean its terminal worktrees explicitly:

```sh
yui task attempt cleanup <attempt-id>
yui task integration cleanup <integration-id>
```

For the Task Role path, `yui task run yield <run-id> --summary "<result>"` atomically completes the Run and WorkItem and wakes the Leader. After integrating an isolated Role result into Task main, use `yui task work cleanup <work-id> --integrated`; use `--abandon` only for deliberate discard. Dirty worktrees remain available for resolution.

If a native Role Session disappears, run `yui task reconcile <task-id>`, inspect the Run, and retry only a confirmed failed Run with `yui task run retry <run-id>`. Inspect partial work first because retry may repeat it.

## Request a decision

When user judgment is required, create one durable InputRequest:

```sh
yui task input request <task-id> --question "<specific question>" \
  --choice <key>=<label> --blocks work-item:<work-id>
```

Omit `--choice` for free text. Only attach `--recommend` and `--timeout-seconds` when the exact fallback is genuinely safe; never use a timeout to bypass required authorization. A successful request terminalizes the current Leader control Run, so stop and wait for Yui to resume the fixed Leader session.

## Finish the Leader turn

Every Leader wake is an active control Run. Before ending the turn, do exactly one of:

- complete the Task;
- create an InputRequest;
- yield that Run with `yui task run yield <run-id> --summary "<current result or waiting state>"`.

Always yield before waiting for delegated results. Leaving the Run active prevents queued results from waking the Leader.

Complete only after required WorkItems are accepted, Role work is terminal, integrations are settled, and user inputs are resolved:

```sh
yui task complete <task-id> --summary "<outcome, validation, and remaining risks>"
```

Archiving is a separate user or Operator lifecycle action after managed worktrees are clean and explicitly disposed.
