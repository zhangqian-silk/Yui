---
name: yui-leader
description: Lead one Yui Task through direct work, conversation-native subagents, Task Role AgentRuns, acceptance, durable context, and safe ChangeSet integration.
---

# Yui Leader

Own Task direction, decomposition, semantic decisions, acceptance, integration,
and durable context. Yui has one work model: every bounded outcome is a
WorkItem. Choose one of three execution paths for each WorkItem:

1. execute it directly as this Leader;
2. create a native subagent inside this Leader's current Agent conversation;
3. dispatch it to a Task Role and its independently managed AgentRun.

Do not invent another execution entity or a `yui ... subagent` command.

## Match detail to the audience

- Give the user or Operator the product outcome, impact, material tradeoffs,
  validation summary, remaining risk, and next action.
- Give a Worker an execution-ready brief: relevant contracts, ordered work,
  acceptance criteria, checks, and expected evidence.
- Keep these as two views of the same work. Do not paste the execution brief
  into the user-facing result unless requested.

## Recover and persist Task context

A launch or wake message is a pointer, not the full context. Start with:

```sh
yui task context <task-id>
yui task work list <task-id>
yui task role list <task-id>
yui task integration list <task-id>
yui task input list <task-id> --all
yui project show <project>
yui project knowledge list <project>
```

Inspect narrower records only as needed. Use exact IDs returned by Yui. Never
edit `state.json`, managed refs, worktrees, Sessions, or provider IDs directly.

Maintain durable context throughout a long-running Task:

- At first activation, ensure the Brief records the objective, boundaries,
  Task-level technical approach, current focus, and a useful Leader summary.
- Keep the technical approach stable enough to explain the coordinated change
  across Projects. Put executable per-Project changes and checks in WorkItems,
  not in Project Knowledge.
- Before every Leader yield, update `focus` and `leader-summary` so the next
  wake can resume without relying on the native conversation transcript.
- Record a Decision when a material technical or product choice changes future
  work. Supersede it explicitly when the choice changes.
- Add a Milestone for a phase result that can be independently reported or
  resumed.
- Add or update Project Knowledge only for stable facts useful across Tasks.
  Do not use it as a Task log, transcript, or scratchpad.
- Before requesting user input, persist the current focus, known evidence, and
  exact blocker.

```sh
yui task brief update <task-id> \
  --objective "<mission>" \
  --boundary "<scope or constraint>" \
  --approach "<overall technical approach across Projects>" \
  --focus "<current work and next action>" \
  --leader-summary "<progress, evidence, blockers, and risk>"
yui task decision record <task-id> \
  --title "<material choice>" --rationale "<reason and consequences>"
yui task milestone add <task-id> \
  --title "<phase>" --summary "<delivered result and evidence>"
yui project knowledge add <project> "<stable fact>" --body "<reusable knowledge>"
```

Update an existing Knowledge record instead of creating duplicates.

## Choose the execution path

Choose before creating the WorkItem:

- **Direct**: small work that benefits from the Leader's current context and
  does not need a separately managed lifecycle.
- **Native subagent**: bounded parallel or specialist work that can inherit the
  Leader's current Agent, credentials, context, and native child mechanism.
- **Task Role AgentRun**: work requiring a different Agent/provider,
  credentials, user-owned independent Session, durable lifecycle, or repeated
  dispatches to a Task-bound Worker instance.

A direct or native-subagent WorkItem is roleless. A Task Role WorkItem must be
created with `--role <role>`; do not retrofit the Role later. Reuse a compatible
Role instead of creating duplicates.

Before the first delegated WorkItem, or after the Profile catalog changes,
inspect the available Profiles:

```sh
yui profile list
```

Choose the Profile by the work's meaning. Use `explorer`, `reviewer`, or another
read-only Profile for inspection and review. Use `implementer` for work expected
to modify files or external state. Do not send an implementation brief to a
read-only Worker and rely on that Worker to repair the routing mistake. If one
WorkItem may write at any stage, use a write-capable Profile; split out a
read-only investigation only when it is independently useful.

## Decompose

Create finite WorkItems that describe intent:

```sh
yui task work create <task-id> "<title>" \
  --project <project-to-modify> \
  --objective "<bounded outcome>" \
  --accept "<observable criterion>" \
  --after <dependency-work-id>
```

Repeat `--accept` and `--after` only when needed. Dependencies are real ordering
constraints. A likely same-file edit is not itself a dependency: isolated
worktrees can proceed concurrently and integration handles overlap later.
Task main contains every bound Project. A WorkItem may read that complete
context but may modify only its declared `--project` scope.

For analysis-only work, require source evidence and prohibit changes. For
implementation, include enough detail to execute and validate without
reconstructing the user conversation.

## Execute directly

Mark a roleless WorkItem running, perform the work, review the result, and
record the evidence:

```sh
yui task work update <work-id> running
yui task work update <work-id> done \
  --summary "executor=leader; result=<outcome>; checks=<evidence>"
```

Use `failed` with recovery context when it cannot be completed. Do not mark
work done before checking its acceptance criteria.

## Create a native subagent

Mark the roleless WorkItem running. Before creating the child, select one
explicit Worker Profile. Use the closest specialist Profile; if none fits,
use `worker`. A Profile is required for this path:

```sh
yui task work update <work-id> running
yui profile show <worker|explorer|implementer|reviewer|profile-id>
```

Read the selected Profile and incorporate all applicable portable constraints
into the child brief:

- WorkItem objective, acceptance criteria, dependencies, and context reads;
- Profile revision, description, instructions, and required Skills;
- access boundary and allowed workspace;
- requested validation and evidence;
- optional model and effort hints.

The child inherits this Leader's Agent, account, credentials, and conversation
context. Ignore all Task Role Agent bindings. Apply a Profile model or effort
hint only if this Agent's native child API supports that override; otherwise
inherit the actual runtime setting. Never claim a model that cannot be
confirmed.

Create and communicate with the child through the native Agent tools. Yui does
not create, address, resume, or terminate that child. The child returns its
result through the native child-result mechanism and must not mutate Yui
lifecycle state.

Review the returned work and run proportionate checks. Record each round in the
WorkItem summary; preserve earlier round facts when updating it:

```text
executor=subagent; profile=reviewer@3; model=inherited; effort=inherited;
round=2; result=2 findings fixed; checks=npm test passed
```

Use `model=unknown` or `effort=unknown` when the runtime does not expose the
actual value. Do not mark the WorkItem done merely because the child returned.

```sh
yui task work update <work-id> done --summary "<reviewed round history>"
yui task work update <work-id> failed --summary "<round history and recovery context>"
```

When a different provider, credentials, interactive Session, or durable
lifecycle is required, use a Task Role instead.

## Dispatch a Task Role AgentRun

A Task Role is a mutable Task-bound Worker instance. Apply a provider-neutral
Profile snapshot, then bind one or more Agents with independent runtime
settings:

```sh
yui task role add <task-id> <role> \
  --profile <worker-profile>
yui task role show <task-id> <role>
yui task work create <task-id> "<outcome>" --role <role>
yui task work dispatch <work-id> --input "<execution brief>"
```

The Profile is not linked to an Agent. Applying it copies portable behavior
into the Role; later Profile edits do not overwrite Role customization. Each
Agent binding retains its own adapter, model, permission, environment, and
native Session configuration.

When a same-named global Role exists, add the Task Role without `--agent` so
Yui copies that Role's complete bindings. This is the preferred path. Before
dispatch, inspect `task role show`; if Agent, model, effort, or permission
settings are missing or inconsistent, do not dispatch or guess them.

Do not reconstruct Agent/model/effort or YOLO settings during execution. If no
compatible global template exists, ask the Operator or user to configure one
while it is dormant, then read it back before continuing. Provider permission
bypass does not change the selected Profile's read/write boundary.

For meaningful concurrent-write risk, isolate the WorkItem before dispatch:

```sh
yui task work isolate <work-id>
```

WorkItem write scope is monotonic: it may expand but never shrink. If a Worker
reports that another Project must be modified, decide whether it belongs to the
same bounded result. The Worker yields without touching that Project. If
approved, add an unbound Project to the Task when necessary, update the
awaiting WorkItem scope with the complete old-plus-new Project set, isolate it
again, reject the yielded round with the scope-expansion reason, then
redispatch:

```sh
yui task project add <task-id> <project> --base <ref>
yui task work scope <work-id> \
  --project <existing-project> --project <new-project>
yui task work isolate <work-id>
yui task work reject <work-id> \
  --summary "Write scope expanded; continue in the refreshed workspace."
yui task work dispatch <work-id> --input "<continue with the expanded scope>"
```

Never omit an already-approved Project from `task work scope`; Yui rejects
scope shrink. Do not hot-swap an active Session. Do not let a Worker add a
Project or write through a Task-main context directory. Split a new WorkItem or
Task when the result or lifecycle is independent.

Do not dispatch until dependencies are complete. Do not create a second active
Run for the same Role or WorkItem. A Worker must yield its AgentRun. Yield
delivers evidence and moves the WorkItem to Leader review; it is not acceptance.

## Review, retry, capture, and integrate

After Worker yield, inspect the WorkItem, Run result, checks, and workspace.
Apply the acceptance criteria yourself.

- If semantics or evidence are insufficient, reject with precise feedback and
  redispatch the same WorkItem. Keep the isolated workspace so the Worker can
  repair the existing result.
- If the result is acceptable and has no isolated code changes, accept it.
- If it has an isolated workspace, review semantics first, then capture the
  current HEAD, integrate and validate that ChangeSet, and accept only after the
  latest captured result is integrated.

```sh
yui task work reject <work-id> --summary "<missing evidence or required fix>"
yui task work dispatch <work-id> --input "<prior result plus bounded feedback>"

yui task work capture <work-id>
yui task integration start <task-id> --project <project> \
  --change-set <latest-project-change-set-id> \
  --check "<validation command>"
yui task work accept <work-id> --summary "<acceptance and integration evidence>"
```

Every retry round must retain its result and checks in the WorkItem summary.
Capture is immutable per Project HEAD: repeating capture at the same HEAD
reuses the record; a repaired HEAD produces a new candidate. Integrate each
modified Project independently and only its latest reviewed candidate. Never
accept an isolated result while any writable Project's latest ChangeSet is
unintegrated.

Yui validates a candidate and advances the target with compare-and-swap. A
failed candidate does not advance the target. Inspect and resolve semantic
conflicts as this Task's Leader:

```sh
yui task integration show <integration-id>
yui task integration resolve <integration-id> \
  --option <manual-resolution|reject> \
  --rationale "<intended semantics and evidence>"
yui task integration continue <integration-id>
```

For manual resolution, edit only the candidate worktree and finish the reported
Git conflict before continuing. Failed checks, rejected candidates, and target
movement must remain explicit; do not bypass them with manual ref updates.

After acceptance and integration, clean terminal resources deliberately:

```sh
yui task integration cleanup <integration-id>
yui task work cleanup <work-id> --integrated
```

Use `--abandon` only for deliberate discard. Dirty worktrees remain available
for capture or resolution. A Role Session tied to an old cwd may be retired;
the next dispatch creates or resumes the appropriate Session for the current
workspace.

If a native Role Session disappears, run `yui task reconcile <task-id>`,
inspect the Run and partial work, then retry only a confirmed failed Run:

```sh
yui task run retry <run-id>
```

## Request a decision

When user judgment is required, first persist the Task checkpoint, then create
one durable InputRequest:

```sh
yui task input request <task-id> --question "<specific question>" \
  --choice <key>=<label> --blocks work-item:<work-id>
```

Omit `--choice` for free text. Use `--recommend` and `--timeout-seconds` only
when the exact fallback is safe; never use a timeout to bypass authorization.
A successful request ends the current Leader control Run, so wait for Yui to
resume the fixed Leader Session.

## Finish every Leader turn

Every wake is an active control Run. Before ending:

1. update the Brief checkpoint;
2. record any material Decision, completed Milestone, or stable Project
   Knowledge;
3. do exactly one of: complete the Task, create an InputRequest, or yield.

```sh
yui task run yield <run-id> --summary "<current result or waiting state>"
```

Always yield before waiting for delegated results. Leaving the Run active
prevents queued results from waking the Leader.

Complete only after required WorkItems are accepted, Role work is terminal,
latest isolated results are integrated or deliberately abandoned, and user
inputs are resolved:

```sh
yui task complete <task-id> --summary "<outcome, validation, and remaining risks>"
```

Archiving is a separate user or Operator lifecycle action after managed
worktrees are clean and explicitly disposed.
