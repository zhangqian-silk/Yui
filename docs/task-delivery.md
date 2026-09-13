<p align="right"><strong>English</strong> | <a href="./task-delivery.zh-CN.md">简体中文</a></p>

# Task delivery and resource lifecycle

## Lifecycle and planning

Task lifecycle is `draft / active / completed / cancelled / archived`. A Draft
stores intent, Project bindings, planning discussion and mutable requirements.
It does not adopt a writable delivery workspace at creation.

Activation validates current Roles, dependencies, Project scope and resources,
prepares physical workspaces, and adopts status/ownership atomically. Failed
preparation leaves the Task Draft with a failed request and a diagnosis delivered
to the Leader. Deferred activation retains the exact intent and waits for native
quiescence, whether requested in a planning Run or subsequent discussion.

Task type describes the requested outcome, not the mandatory executor.
Leader owns bounded work directly or assigns substantial independent WorkItems.
Direct execution has no Group. Replication is explicitly requested for independent
attempts at the same frozen Assignment, followed by Leader-selected synthesis.

## Managed workspaces

Stable Project checkouts are read-only references. Task main is a logical
multi-Project root with per-Project Git worktrees. For one Project, the Agent's
normal cwd is its managed Git root; for multiple Projects, the root and native
additional-directory mechanism expose the explicit Project set.

An isolated WorkItem has independent worktrees for writable Projects and
Task-main context for the others. Write scope is explicit and can only be
expanded by the authorized owner. Review owns a separate frozen workspace and
cannot become a Develop or Integration source.
Acceptance or retirement does not release a WorkItem's durable workspace.
Task-main preparation preserves a Role's retained WorkItem/Review cwd until
explicit cleanup or reassignment. Decision-support reads observe current Git
heads without preparing workspaces or migrating Sessions.

Before launch, actual Git lineage must descend from the recorded base. A reset
outside that lineage is physical drift, not a reason to guess or repair ownership.
An explicitly adopted environment can select a different native cwd while the
managed workspace remains the Git/control ownership record.

## Candidate, Review and Integration

Provider terminal saves the exact original Run result. It does not accept the
WorkItem. The Leader evaluates the result and captures immutable per-Project
ChangeSets for isolated code. The governing Candidate supplies provenance for
Review and Integration; Producers do not independently enter either path.

Integration applies the fixed ChangeSet in a candidate worktree, runs configured
checks, then advances the target only if its head still matches. Conflict,
failed checks, target movement or rejection retain evidence and never advance
the target. The Agent chooses retry or manual resolution within the retained
workspace.

When checks are a DurableJob, the Integration retains that exact jobId while
running. Once the Job settles, `task integration continue <task>/<integration>`
consumes its result and performs the guarded finalization. The direct operation
does not depend on entries in the separate integration queue.

Review follows the applicable Candidate rule or Task-final contract and frozen
heads. The exact main Reviewer Run holds the report; successful execution is
not a semantic pass. Acceptance belongs to the Leader.
An explicit user requirement to delegate or obtain independent Review remains
part of acceptance even if the default review policy is disabled. `next-action`
reports stored facts and alternatives; it cannot weaken the Task Contract or
infer that unrecorded WorkItems mean direct execution was requested.

## Completion and remote delivery

Completion checks the current WorkItems, latest captured/integrated results,
applicable Review contract and exact clean committed Task-main snapshot.
It also refuses completion while a new user/Operator message is still awaiting
Leader delivery. The current native turn must end so the pending notification
can arrive; the Leader then reads the original message and reassesses completion.
This derives from existing Messages and mailbox delivery, not a second
acknowledgement or workflow state.
Terminal workspace cleanup can remain an advisory at completion. Ordinary
archive requires it to be settled; explicitly authorized force archive may
retain unresolved resources as described below. Artifacts selected as results
must be fixed, present and Task-local.

Publication records a remote PR/MR reference. Reported merge, independently
verified merge and exact Task-head coverage are separate facts. Task completion
does not prove any of them. Remote delivery is read from exact publication/head
evidence, not inferred from a title or branch name.

Cancelled intent does not prove the runtime stopped. User/Operator may reopen
cancelled Tasks; Leader may reopen completed Tasks. Reopening requires fresh
explicit input/work selection and never replays previous delivery requests.

## Archive

Archive requires independent user/Operator authorization for an exact completed
or cancelled (retired) Task. Completion alone grants none, and ordinary archive
approval does not authorize force. Select one disposition explicitly:

```sh
yui task archive <task> --integrated
yui task archive <task> --abandon
# Only with explicit force authorization, preserving the chosen disposition:
yui task archive <task> (--integrated|--abandon) --force
```

### Ordinary archive

Active work and inputs must be settled, and managed resources clean and safely
removable. WorkItem results must be integrated or deliberately abandoned;
Review, Lane and Integration resources must be settled. With `--integrated`,
each Project requiring code delivery needs exact merged-head coverage and
verified Publication evidence. `--abandon` records deliberate non-delivery,
not verified merge.

Missing/stale coverage, unresolved execution or dirty worktrees prevent ordinary
archive. Resolve the reported facts before an explicit retry; no implicit reset
or force deletion occurs.

### Explicit force archive

`--force` is not merely a merge-verification override. It commits the archive
and stops new Task scheduling before attempting safe foreground cleanup.
Missing or stale delivery evidence, an unmerged result, unresolved execution
and cleanup failures become warnings with retained resource references, rather
than blocking that archive commit. Authority, eligible lifecycle, exact resource
identity and mandatory audit persistence still fail closed.

Force neither verifies a merge nor accepts work, proves quiescence, discards
dirty data or implies `--abandon`. It preserves the selected disposition and
original Publication/completion evidence. Unverified local commits and resources
that cannot safely be released stay owned and traceable. A cleanup failure does
not roll back archive; late runtime events remain source evidence without
resuming the Task or settling unknown input.

### Read the result before cleanup

`yui task show <task> --json` exposes `data.archive.warnings`,
`data.archive.retainedResources` and `data.archive.cleanupEvents`.
`yui task context <task> --json` retains the original records and events;
`yui task remote-delivery <task> --json` reports delivery separately.
Warnings include historical cleanup attempts; retained references describe
current ownership, not a second cleanup queue.

An archive result with `archived=true` proves archival, not that cleanup fully
succeeded. Even `cleanupFinished` means the foreground pass finished, not that
every resource was removed. Repeating archive reports current facts and does
not replay cleanup. After inspection, use explicit exact-owner resource
operations for safe cleanup; no background retry or broader deletion authority
is implied. Both archive paths preserve Task history and recovery information.
Archived Tasks cannot reopen.

Use each command's `--help` to inspect its exact authority and options before
cleanup; reading a lifecycle document does not authorize an external write.
