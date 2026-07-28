# Yui architecture

Yui is a single-user local control plane. `FileTaskStore` owns workflow state, Codex owns native transcripts and turns, and Git owns commits, worktrees, and refs.

## Canonical model

The product and storage use the same names:

- `AgentProfile`: one revisioned Worker execution template. It contains one Codex Agent ID, maximum access, optional model/effort, description, instructions, and Skills.
- `WorkItem`: intent only—objective, acceptance criteria, dependencies, revision, and lifecycle.
- `ExecutionAttempt`: one execution of a WorkItem, including exact input, Profile revision, executor, access, optional Git base, provider IDs, state, and compact result.
- `ChangeSet`: immutable Project, Attempt, base/head commits, branch, and changed paths.
- `IntegrationAttempt`: target ref, expected head, ChangeSets, candidate commit, checks, conflict report, and optional Leader decision.

Attempt results deliberately contain only `summary`, optional `checks`, and an optional `changeSetId`. Full transcripts remain native to Codex. Integration check records keep only the outcome, a compact failure diagnosis, and an optional relative log path; complete command output is streamed to cleanable files under `YUI_HOME/artifacts/integration-checks`.

The built-in Worker Profiles are:

| Profile | Purpose | Maximum access |
| --- | --- | --- |
| `worker` | generic bounded delegated execution | read |
| `explorer` | source-backed inspection | read |
| `implementer` | isolated implementation and validation | write |
| `reviewer` | regression and evidence review | read |

Operator, Leader, and persistent Task Workers remain runtime Roles. Operator and Leader are not AgentProfiles.

## Execution

The normal path is:

```text
Leader -> forked Agent thread
```

`auto` requires a compatible active Leader thread and selects `fork`. The fork copies stored Leader history; the active unfinished turn is not part of the dispatch boundary. Codex App Server does not expose native subagent creation as a client request, so Yui does not label `thread/fork` as a subagent. A root Session is explicit, requires `--mode session`, and must record a non-empty `--session-reason`.

Codex execution uses App Server JSONL:

```text
initialize
  -> thread/fork  (Leader-context fork)
     or thread/start (explicit root Session)
  -> turn/start with cwd, sandbox, the Profile contract, model/effort, and result schema
  -> turn/completed
```

Dispatch validates the selected Profile and Codex Agent, resolves the always-present `yui-worker` Skill plus configured Profile Skills, selects the executor, and only then persists a running Attempt and WorkItem. The first turn repeats the Profile contract so it remains effective even when a fork is loaded cold. The Attempt input contains stable Task, WorkItem, and Project Knowledge read references rather than copied mutable context; its environment receives only the managed `YUI_HOME`, not a forged Task Role identity. The provider reference is attached as soon as `turn/start` returns.

Read access uses a read-only sandbox. Write access uses a workspace-write sandbox rooted at the Attempt worktree. Access may be narrowed but never exceed the Profile maximum.

Attempt states are `running`, `succeeded`, `failed`, and `interrupted`. A failed executor check fails both Attempt and WorkItem. Success moves the WorkItem to `awaiting_acceptance`; only the Leader can accept it.

Interruption is deliberately simple: the CLI best-effort interrupts the provider turn and always terminalizes the local running Attempt. A stuck Integration can likewise be explicitly aborted. There is no recovery daemon or additional recovery state machine.

## Git isolation and integration

Write workspace identity is derived from the Attempt:

```text
<workspace>/worktree/<project>/<task-id>/attempts/<attempt-id>
yui/<task-id>/attempt/<attempt-id>
```

Integration candidates use:

```text
<workspace>/worktree/<project>/<task-id>/integrations/<integration-id>
yui/<task-id>/integration/<integration-id>
```

These workspaces are physical Git facts, not persisted lease records. One checkout has one writer, while separate worktrees may edit the same paths concurrently. Dependencies express semantic ordering, not predicted file overlap.

After a successful write turn, Yui commits remaining changes, verifies that the checkout is still on its managed branch and that HEAD descends from the recorded base, then records a ChangeSet. Integration creates a candidate at `expectedHead`, applies ChangeSet commits in order, runs configured checks, then advances the target with expected-head compare-and-swap. A clean singly checked-out target is fast-forwarded with its HEAD, index, and files kept synchronized.

A conflict stores only affected paths and a summary, then blocks. The Task Leader chooses `manual-resolution` or `reject`. Manual resolution happens in the retained candidate worktree and `integration continue` finishes the cherry-pick, applies remaining commits, validates, and attempts the CAS update. Check stdout and stderr are streamed without truncation to one log per command; success stores no copied output, while failure stores only the exit reason and one complete diagnostic line. Failed checks, conflicts, rejection, aborts, and target movement never advance the target.

## Storage

The development format is layout 6 / aggregate 6 and is fresh-only. Older or newer manifests fail fast; there is no migration or compatibility path.

Every state write uses a process lock and atomic replacement. The store validates record identities, Profile revision references, dependency cycles, cross-record references, immutable records, and legal transitions.

Operator conversation history is stored as lightweight pointers in its global
Role session set. Each entry records the owning Agent/adapter plus a readable
title or preview and an opaque Yui reference; the provider remains the authority
for the transcript and native session ID. When an adapter has not supplied a
title or preview, the human-facing identity combines its provider with a short
stable Yui reference. Only one Operator native process and tmux pane are current
at a time.

The existing tmux mailbox runtime remains the Operator/Leader control loop and the persistent Task Role execution path. AgentRuns belong to that native-session path; ExecutionAttempts are the default for bounded child-thread delegation. Leaders release their active run with:

```sh
yui task run yield <run> --summary "<current result or waiting state>"
```

## Safety invariants

- Every root Session records a reason; `auto` is fork-only.
- Every Attempt retains exact input and an available Profile revision.
- Every Attempt automatically receives `yui-worker`.
- Attempt-backed WorkItem completion requires explicit Leader acceptance.
- A write WorkItem cannot be accepted before its ChangeSet is committed.
- Separate worktrees may overlap paths; the target ref advances only by CAS.
- Conflict semantics belong to the Task Leader.
- Attempt and Integration worktrees, branches, commits, provider Sessions, and Integration check logs are retained for explicit cleanup.
