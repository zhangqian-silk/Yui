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
Terminal workspace cleanup can remain an advisory at completion, but not at
archive. Artifacts selected as results must be fixed, present and Task-local.

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

Archive is a separate authorized action after active work is settled and
resources are clean and removable. Choose integrated delivery or deliberate
abandonment explicitly. Ordinary integrated archive requires every code Project
to have a merged, verified Publication covering its accepted head, either exactly
or through valid explicit adoption. Insufficient evidence blocks this path;
force remains a separate explicit authorization and never proves coverage.

Managed WorkItem resources must be integrated or deliberately abandoned before
cleanup. Review, Lane and Integration resources must be settled. Dirty worktrees
remain for the Agent to resolve; no implicit reset or force deletion occurs.
Task main branches and durable Task records retain recovery information.
Archived Tasks cannot reopen.

Use each command's `--help` to inspect its exact authority and options before
cleanup; reading a lifecycle document does not authorize an external write.
