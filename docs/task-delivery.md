<p align="right"><strong>English</strong> | <a href="./task-delivery.zh-CN.md">简体中文</a></p>

# Task delivery and resource lifecycle

## Lifecycle and planning

Task lifecycle is `draft / active / completed / cancelled / archived`. A Draft
stores intent, Project bindings, planning discussion and mutable requirements.
It does not adopt a writable delivery workspace at creation.

Activation requires a durable request with an explicit environment plan:
use `task activation request <task> --request-id <id> --environment <plan>`.
The Controller adopts eligible requests; `task activate <task>` may consume an
existing request in the foreground but never creates implicit activation intent.
Activation validates current Roles, dependencies, Project scope and resources,
prepares physical workspaces, and adopts status/ownership atomically. Failed
preparation leaves the Task Draft with a failed request and a diagnosis delivered
to the Leader. Deferred activation retains the exact intent and waits for native
quiescence, whether requested in a planning Run or subsequent discussion.
Project maintenance contention waits asynchronously before resource adoption.
A lock timeout or cancelled wait preserves the original activation request;
after acquiring the lock, activation rechecks current intent and authority.

Task type describes the requested outcome, not the mandatory executor.
Leader owns bounded work directly or assigns substantial independent WorkItems.
Direct execution has no Group. Replication is explicitly requested for independent
attempts at the same frozen Assignment, followed by Leader-selected synthesis.

Scope overlap is a read-only advisory in `task next-action`, not a text-matching
creation gate. The Leader inspects original requirements and decides whether
work is independent. Request identity, permissions, dependencies, workspace
isolation and acceptance checks remain enforced independently.

## Managed workspaces

Stable Project checkouts are read-only references. Task main is a logical
multi-Project root with independent per-Project Git clones; WorkItem, Review and
Integration worktrees belong to those Task repositories. For one Project, the Agent's
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
WorkItem. The Leader evaluates the result and its immutable per-Project Git
snapshot. Optional ChangeSets supply diff evidence. The governing Candidate supplies provenance for
Review and Integration; Producers do not independently enter either path.

The Agent chooses the order and strategy, then starts one Integration from an
exact WorkItem Candidate. There is no separate ChangeSet integration queue.
Integration applies the fixed source commits in a candidate worktree, runs configured
checks, then advances the target only if its head still matches. Conflict,
failed checks, target movement or rejection retain evidence and never advance
the target. The Agent chooses retry or manual resolution within the retained
workspace.

An existing merge/rebase/cherry-pick without the attempt's own progress receipt
is not adopted from Git markers. Preserve the scene and choose explicit recovery;
normal continuation uses the original receipt and never replays a completed step.

When checks are a DurableJob, the Integration retains that exact jobId while
running. Once the Job settles, `task integration continue <task>/<integration>`
consumes its result and performs the guarded finalization. Existing unsettled
Integrations, including conflicts, remain completion blockers independently of
how the Agent ordered them.

### Verification reuse and explicit reruns

A configured VerificationPlan reuses only complete, successful, log-verified
evidence for the exact Project, commit, plan, toolchain and target/base boundary.
L1 also binds the selected checks, so a different path category cannot borrow
another category's result. A plan with no reusable evidence executes normally.
Plans require `schemaVersion: 1`; there is no `record/reuse/enforce` mode.

Request fresh checks when creating an operation:

```sh
yui task integration start <task> --work-item <id> --strategy ff --rerun-checks
yui task upstream integrate <task> --project <project> --rerun-checks
```

The flag is immutable intent on that Integration, not a global configuration
switch. `continue` consumes the same admitted Job; it cannot turn into a rerun.
Create a new attempt for another execution, and settle any equivalent unfinished
verification first. Rerun affects only cache reuse, never permissions, Job
identity, workspace checks or the final target CAS.
Explicit `--check` commands also request fresh execution. With a plan configured,
they run after its checks; they are neither ignored nor rejected by text matching.
Unstructured checks do not search historical Jobs for a substitute result.

Fresh execution withdraws the old success before starting. Failure is recorded
as failure; interruption or missing logs leave no reusable success. A stale
cache consumer cannot restore an older result. Release lookup considers the
newest recorded matching proof rather than searching past a failure for an
older green result. The cache represents current reusable evidence, not Task
execution history; original Job and Integration records remain separate.

The identity covers declared inputs, not every external service or untracked
environment condition. Use explicit reruns for changing external inputs,
flakiness investigation or a user-requested new check. A plan does not authorize
real-model/paid/shared-resource validation. Reuse never substitutes for Review,
acceptance or publication authority.

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

Completion heads remain the immutable acceptance baseline. A later, authorized
integration may produce a different publication candidate (including a rebase
or merge before a remote squash). Neither ancestry nor a successful Integration
proves that the accepted behavior survived, or accepts additional changes.

For a completed, unarchived Task, record the exact candidate as the Publication's
`localCommit`, then read `task publication diff <task>/<publication>`. This reads
only Task-owned local Git objects and returns the original completion reference,
both commit/tree endpoints, the full diff (including binary changes), and a
digest binding those facts. Review removals, additions and conflict resolutions
against the original requirements. If they preserve the accepted result and all
relevant increments are accepted, use
`task publication adopt <task>/<publication> --reviewed-diff <sha256> --acceptance <text>`.
The acceptance must explain that judgment and its verification/review evidence;
Core checks fixed identity and facts, not the meaning of the code. If an existing
Task Integration produced that exact candidate, pass its local ID with
`--integration <id>` to both commands to bind its committed evidence as well.
This records one Task event, not a new delivery status, Candidate lifecycle,
Git operation, or permission to change completed work.

`task publication verify` remains the explicit, authorized provider read. It
records the remote source head, PR/MR state and merge commit independently of
Task acceptance. A mismatched head or non-merged state is saved as **reported**,
superseding earlier verification; provider errors or mismatched external identity
write nothing. A merged provider observation verifies only that Publication's
exact local candidate. A squash merge needs no fabricated commit ancestry.
Metadata/verification successors preserve adoption only through an uninterrupted
same-candidate Publication lineage. Candidate or referenced Integration changes
cannot silently reuse the decision.

CLI, current Leader Context and Web derive coverage from these same facts, with
no provider reads or evidence writes. They distinguish not delivered, merged
but uncovered, covering merge not verified, partial delivery and verified merge.
Each Project retains its own accepted head, selected candidate, adoption reference
and reason. Unknown historical heads remain unknown; old exact-SHA evidence stays
valid without inventing adoption, and archive never proves remote delivery.

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
each Project requiring code delivery needs a merged, verified Publication
covering its accepted head, either exactly or through valid explicit candidate
adoption. `--abandon` records deliberate non-delivery,
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

`yui task archive-preflight <task> (--integrated|--abandon) [--force] [--json]`
reads current admission, delivery and exact-owner cleanup checks in one report.
It is available before and after archive, including to the Task's authorized
Leader reader. `--force` here only selects the behavior to inspect. It never
archives, prepares workspaces, refreshes Git indexes, stops Sessions, acquires
maintenance locks, fetches remote data, or writes a cleanup plan.

Each blocking/unknown check has a resource, reason code, expected and observed
values, source references and existing inspection/disposition commands. Git
paths outside the authorized Task are redacted. The report distinguishes
missing Candidate workspace, changed workspace identity/metadata/path, missing
frozen commit, moved HEAD, dirty worktree, missing/locked Git registration,
unintegrated result, uncovered delivery, unsettled owner and unknown execution.
Status inspection disables optional index writes and filesystem-monitor hooks.
If a tracked file selects a configured clean/process filter (including an
initialized submodule's), it reports `git-status-requires-filter` as unknown instead of
executing the program or bypassing normalization and guessing clean/dirty.
Historical Candidate paths remain immutable. A path difference, including one
consistent with an earlier layout migration, does not itself prove a safe
relocation: without an exact mapping the check reports the difference and
retains the resource; it does not repair history or weaken commit/owner checks.

Preflight is an observation, not a removal permit. Cleanup reloads the same
checks and Git verifies ownership/dirt again at removal. A Task-main clone's
dependent registrations are expected before child cleanup and must be absent
before clone removal. Archive preserves new dirt even in a failed Integration
workspace; the separate explicit Integration cleanup command keeps its existing
disposable-conflict behavior. A finished force cleanup means the foreground
attempt ended, not that every resource was released. Current retained references
and exact physical runtime evidence remain separate from historical diagnostics.

Use each command's `--help` to inspect its exact authority and options before
cleanup; reading a lifecycle document does not authorize an external write.
