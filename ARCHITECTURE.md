# Yui Architecture

Yui is a local control plane for intelligent Agents doing durable work across
Projects and native runtimes. The user talks to one Operator. The Operator
routes each request to the right Project and Task; that Task's Leader owns
decomposition, execution choice, review, integration, and completion.

## Design principles

- **Agents own judgment.** Yui exposes current durable context and atomic
  capabilities; the Operator, Leader, and Workers choose plans, execution
  topology, sequencing, retry, and recovery from that context.
- **Core provides primitives, not a prescribed workflow.** Reads, messages,
  bounded record transitions, workspace ownership, Session lifecycle, and
  acceptance are composable operations. Project Skills and Knowledge provide
  project-specific policy without adding core branches.
- **Durable intent outranks runtime continuity.** Tasks, WorkItems, Messages,
  Decisions, results, Project Knowledge, and managed workspaces are authority.
  Provider Sessions, transcripts, processes, and observations are execution
  aids that may be resumed or replaced.
- **Trust explicit Agent actions.** Once identity, authority, and scope are
  established, a valid Agent command is a semantic declaration. Core should not
  reconstruct the same judgment through another status protocol.
- **Fail visibly and let the Agent adapt.** Preserve pending intent and return
  actionable state. Add automated retry, recovery, leases, or fallback only for
  a normal product path, a hard safety or data-integrity boundary, or a proven
  failure whose cost justifies the machinery.
- **One question has one authority.** Projections and indexes may summarize
  state, but scheduling and lifecycle decisions must not depend on independently
  writable copies of the same fact.

## One outcome, Leader-chosen execution topology

`Task` is the bounded user outcome. Its optional `type` describes intent, not
execution topology; software Projects normally use `feature` or `bugfix`, while
other Projects may define their own types. Yui does not store a Task-level
direct versus integrated delivery mode. The `direct` and `replicated` labels
below describe only the execution shape of one WorkItem.

A software bugfix is Leader-owned: the Leader implements and verifies it in the
managed Task main without manufacturing a WorkItem. If the scope proves to need
independent delivery owners, reclassify it as a feature before creating those
units. For a feature, the Leader judges whether the whole result is small
enough to own in the same way or large enough to need independently owned
delivery units.

Operator updates have one durable path. Domain and runtime transitions first
append an immutable TaskEvent; user-owned questions append an InputRequest.
Only those record references enter the global Operator mailbox. The Controller
batches pending references into one receipt-backed synthetic user message for
the existing interactive Operator and defers the complete batch while that
Operator is busy or unavailable. The message carries CLI read pointers rather
than copied Task or Provider narrative. No lower layer calls the Operator, no
mutable notification projection duplicates the event history, and no Goal or
polling protocol is required to follow work.

`WorkItem` means one substantial, independently acceptable requirement with a
clear owner. Create multiple WorkItems only when multiple Workers can own and
advance those requirements independently, normally in parallel. Internal
implementation steps, test runs, review findings, and local fixes remain Turn,
Event, report, or commit evidence under the existing Task or WorkItem; they are
not new WorkItems.

Native subagents may help an Agent investigate or critique inside its current
conversation, but they are not a second Yui WorkItem execution model and do
not create child-session records. A Yui-managed WorkItem dispatch has one
logical main executor: the current Session for `WorkItem.assignee`. A Turn is
an execution attempt, not a requirement, and repeated Turns may continue the
same compatible Role Session.

Without `--lane-role`, dispatch is `direct`: Yui creates only the main Turn and
does not persist an ExecutionGroup or Lane. With at least two distinct
non-assignee roles, dispatch is `replicated`: one ExecutionGroup freezes a
canonical Assignment and every Lane independently executes that exact same
Assignment. One Lane role is invalid, and Lane roles cannot introduce their
own objective, directive, acceptance criteria, context, or write scope.

A Lane is a recoverable logical slot whose durable disposition is `open`,
`succeeded`, or `failed`. Failed Turns leave the Lane open for an exact
`task turn retry`; `task turn settle` records the Leader's decision to stop
recovering that Lane. Yui waits until every Lane is settled. At least two
successful Lanes make synthesis eligible and create or wake one idempotent
main Turn with every successful Producer result in stable Lane order. Fewer
than two successes fail that Group attempt without degrading to a single
result. Retrying the main Turn keeps the same Group and does not rerun a
successful Lane.

## Profiles, Roles, and Agents

- `Agent` selects a supported adapter such as Codex or Claude and defines its
  launch context.
- `WorkerProfile` is a versioned, provider-neutral behavior template containing
  instructions, Skills, a read/write behavior intent, and optional model/effort hints.
- `TaskRole` is a mutable Worker instance inside one Task. Applying a Profile
  copies its portable behavior and the optional model/effort selections into
  the active Agent binding. Its versioned desired launch configuration is
  next-launch-only. The Role may bind multiple Agents; every binding retains
  independent runtime configuration.
- `Turn` records one managed dispatch and an immutable effective snapshot:
  actual Agent, adapter, model, effort, Profile behavior intent, exact writable
  Projects, provider permission strategy and native options, workspace, Role
  context, and source desired revision. A native Role Session stores the same snapshot; running processes
  are never hot-mutated by later Role edits.
- A `WorkItemCandidate` is the explicit result currently awaiting Leader
  acceptance. A dispatched WorkItem Candidate can reference only a successful
  main Turn; the complete replicated provenance is derived through Main Turn
  -> ExecutionGroup -> Lane -> successful Producer Turn. A roleless delivery
  unit managed directly by the Leader may instead use the existing direct
  source. Lanes never become Candidates or enter Review or Integration.
- `ReviewRound` records one semantic judgment. A WorkItem Review references
  that WorkItem's immutable Candidate. A Task-final Review references the
  frozen Task heads directly and has no synthetic WorkItem/Candidate anchor.
  It is never another WorkItem.

Adding another Agent requires an explicit adapter implementation. Profiles do
not choose adapters, own Sessions, or carry credentials.

For a native subagent, the Leader must choose and read an explicit
WorkerProfile, using `worker` when no specialist fits. The Leader includes the
Profile instructions, Skills, behavior intent, workspace boundary, validation expectations, and
supported model/effort hints in the child brief. Task Role Agent bindings are
ignored because the child inherits the Leader Agent. Its output remains
session-local collaboration evidence: it does not create a Yui Lane, Candidate,
ReviewRound, or Integration source. When that evidence affects delivery, the
main executor incorporates it into the WorkItem's authoritative result.

## Lifecycle and acceptance

WorkItem delivery has one Leader-owned acceptance path regardless of execution
shape:

```text
todo -> running -> awaiting_acceptance
                      | accept -> completed
                      | reject -> failed -> redispatch -> running
```

For `direct`, the assignee's successful main Turn supplies the result. For
`replicated`, Lane Turns supply immutable Producer results and only the
successful synthesis main Turn supplies the Candidate. Roleless WorkItems are
advanced directly by the Leader but enter the same Candidate, ChangeSet,
Integration, and acceptance boundary.

The Provider's native Turn terminal ends its associated Turn and stores the
final response as immutable Turn evidence. It never accepts the WorkItem. The
Leader checks semantics, evidence, and Git state, then resolves the execution
result and accepts or rejects it with bounded feedback. A rejected isolated
WorkItem keeps its workspace so the next Turn can repair the same result.

An optional global review rule names one existing Global Role and chooses
`always`, `leader`, or `final`. Candidate rules remain live defaults; each
WorkItem Candidate snapshots the effective review rule when submitted.
Every managed execution result is stored first on its exact Turn. A Candidate
is created only from the main result when the Leader resolves the execution
output for acceptance.
`always` dispatches a review Turn for every candidate, whether it comes
from a completed execution Turn or a Leader-managed direct result; `leader`
leaves every candidate for the Leader to accept directly or review explicitly.
`final` keeps WorkItem acceptance and Integration independent and supplies the
default Reviewer Role when the Leader decides the frozen Task result warrants
an independent final Review. An immutable Task-final contract can require that
Review. A Leader-requested Round remains evidence without becoming policy: a
later Task head does not require another Round unless the Leader requests one
or an explicit Task contract requires it. This final Reviewer evaluates the whole
Task, so normal delivery does not pay for a complete review of every WorkItem.
Review Turns complete only their exact ReviewRound, leave the WorkItem awaiting
acceptance, and never trigger another review or append a Candidate. Successful
and failed review attempts both wake the Leader and remain evidence for
judgment, not a machine verdict. The ReviewRound stores its frozen Candidate
base, isolated workspace provenance, complete free-form report, optional
structured checks, and optional diagnostic commit. The Leader may route that evidence to the original Worker, but Yui
never merges it automatically.

Roles describe Agent capability, but they do not own repository workspaces. A
`ManagedWorkspace` is keyed by its durable owner (`Task`, `WorkItem`,
`ReviewRound`, or `IntegrationAttempt`); an Turn carries only a launch
snapshot. Review workspaces are writable copies at the frozen commit, so
diagnostics cannot redirect Develop or become a ChangeSet source. Task-final
Rounds keep independent immutable records but may reassign one clean physical
workspace to the next Round for the same Reviewer Role. This lets the native
Reviewer Session continue while every Turn remains bound to its exact Round and
head.

Dependencies are enforced at dispatch. A Role cannot have overlapping active
Turns, and terminal Task state fences new messages, dispatches, retries, and
late results until explicitly reopened.

## Project workspaces and integration

Stable Project checkouts are read-only references. Task identity follows one
bounded outcome rather than Project count. A Task binds zero or more Projects,
records an independent base ref for each binding, and adopts one workspace root
only when it becomes active. A Draft owns planning state and Project bindings,
not a writable Workspace. Activation prepares physical worktrees first and then
commits status, workspace identity, cwd, and durable Workspace ownership in one
TaskStore transaction; failure discards unadopted resources and leaves the Task
Draft. The active Workspace contains a managed main worktree for each binding.
The `<workspace>/tasks/<task>/main` root is a logical multi-Project container,
not a Git repository. Each Project child (for example
`<workspace>/tasks/<task>/main/yui`) is the supported Git cwd and points to
`<workspace>/worktree/<project>/<task>/main`; Git commands run in that child.
For a single-Project workspace, the native Agent starts in that Project's
managed worktree so its project configuration and Skills are discovered
natively. For a multi-Project workspace, the Agent starts at this root and Yui
registers every Project worktree through the provider's native
additional-directory mechanism. The active Leader may append a Project when the
same outcome expands; replacing an existing binding is not a scope-repair
mechanism.

Before a Role launch, Yui verifies that every physical Project HEAD still
descends from its Workspace's recorded base. Normal committed progress is
allowed; a reset or repoint outside that lineage is reported as
`physical-drift` and fails closed before Provider launch.

A WorkItem can read the full Task workspace but has an explicit Project write
scope. Isolation creates a second root with independent worktrees for writable
Projects and Task-main context for the rest. The managed dispatch and
`yui-worker` Skill name both sets explicitly; the Agent must modify only the
writable set. Provider permission is binding configuration: every managed Role
defaults to `bypass`, while `default` and `configured` preserve provider-native
behavior. Provider permission and Profile access intent do not grant Project
writes. A Leader-owned source write requires the exact Task-main owner. A
WorkItem source write requires an exact WorkItem write scope and matching
managed workspace; a review write instead
requires an exact ReviewRound owner and frozen Candidate base. Profiles and
Skills constrain behavior even when provider prompts are bypassed. Provider
permissions remain Session-wide rather than Project-specific, so the durable
workspace owner and exact Project scope remain the authorization boundary.
Scope is monotonic. A Worker cannot expand it directly: it reports the need,
and the Leader either adds Projects to the existing scope, creates another
WorkItem, or adds the Project to the Task.

An isolated result is handled in this order:

1. the Worker Provider Turn ends and its Turn result is recorded;
2. the Leader reviews semantics and evidence;
3. Yui captures each writable Project HEAD as an immutable Project ChangeSet;
4. each Project integration applies its latest reviewed ChangeSet in a candidate worktree;
5. configured checks run;
6. compare-and-swap advances the target only if its HEAD is unchanged;
7. the Leader accepts the WorkItem;
8. terminal Integration, ReviewRound, and WorkItem resources become cleanup
   advisories and are explicitly removed before archive.

The context contract is layered: Yui Core owns durable identity, lifecycle,
access, and workspace safety; generic role Skills own portable orchestration;
Project Policy/Knowledge and Agent-native Skills versioned in each Project own
project-specific engineering rules; and the Task Contract owns the requested
outcome. Yui injects only its own generic Role Skills. It never scans or copies
Project Skills into managed context; the selected Agent discovers them through
its native project mechanism. Execution and review select their generic Skill
by durable Turn purpose. A Reviewer finding routes to the original Worker while
open, one consolidated Repair WorkItem when closed, Leader/Integration for
merge or local fixes, and an architecture WorkItem only for a genuinely
cross-cutting design change. Parallel repair is explicit and requires
independently acceptable ownership.

Capture at the same HEAD reuses the existing ChangeSet. A repaired HEAD creates
a new candidate; only the latest reviewed candidate may satisfy acceptance.
An isolated WorkItem cannot be accepted, or a Task with WorkItems completed,
while any writable Project's latest result is uncaptured or unintegrated.
Leader-owned completion instead requires a clean committed exact Task-main snapshot.
Workspace roots are
multi-Project; ChangeSets and Integration Attempts remain single-Project Git
boundaries.

Conflicts store a compact report and block. The Leader chooses rejection or
manual resolution in the retained candidate worktree. Failed checks, rejected
results, conflicts, target movement, and abandoned work never advance the
target. Full check output is streamed to cleanable artifact files; durable
records retain compact evidence.

## Durable context

Native transcripts remain native to their Agent. Yui persists only the control
and knowledge needed to resume and audit work:

- Task Brief: objective, boundaries, cross-Project technical approach, current
  focus, and Leader summary;
- Decisions: material choices and supersession;
- Milestones: independently useful phase outcomes;
- Project Knowledge: stable facts reusable across Tasks;
- WorkItems, Roles, Turns, Messages, InputRequests, Events, ChangeSets, and
  integration evidence.

The Leader updates the Brief when durable Task context changes, records material choices as
Decisions, records phase outcomes as Milestones, and promotes only cross-Task
stable facts to Project Knowledge. `task context` is the consolidated recovery
read; launches and wake messages carry record pointers rather than copied
context.

## Runtime ownership

Provider conversations remain user conversations. Yui adds the matching Role
Skill and Session Manifest pointer, then uses provider-native requests for
durable Task delivery; it does not own or mirror the full transcript. The
Controller owns mailbox delivery, wakeups, Role liveness, recovery decisions,
and exact receipts. tmux keeps Yui's client attachment observable where the
provider path needs one. The Controller owns durable wake consumption and
Provider submission; the Provider Runtime Binding owns the only Turn receipt.

Session, Activation, and Turn identities are independent. A Session can span
Turns and client attachments; one Activation identifies Yui's current
attachment, not exclusive ownership of the Provider thread. One Turn identifies
one provider-native execution, whether its input arrived through Yui or directly
through the Provider UI. Yui's authority epoch fences only Yui's own submissions
and retries.

`Turn` is the single durable scheduling authority for a Role. It records the
visible inputs, their source and channel, and the final Provider output; it does
not copy reasoning or tool traffic. All input relayed or generated by Yui has
source `yui`, while direct Provider input has source `user` and explicit Goal
continuations have source `provider`.
`TaskRole` likewise stores configuration and identity, not a writable runtime
status. CLI and Web status views derive activity from the active Turn and
add Session/Driver facts only as lifecycle and diagnostic detail.
`AgentHost` is the serialized consumer: while a Provider Turn is active, the
next mailbox wake remains durable and unsubmitted. When that Turn ends, Yui
atomically stores the result. Worker and Reviewer completion enters the bounded
Leader wake aggregation window; a later dispatch creates a new Turn while
reusing the same live Session whenever its configuration remains compatible.
Task and WorkItem completion remain Leader decisions and never follow merely
from Provider termination.

Codex Task threads remain ordinary native Sessions and can be opened and used
directly in Desktop. Direct user Turns are recorded in the same Turn history. If
one is active, Yui keeps its pending message until that Turn settles. Global
interactive entry remains a native Session-lifecycle operation outside the Task
delivery contract.

Codex establishes an App Server WebSocket through the byte-forwarding
`app-server proxy` to create or resume a normal thread on the shared daemon.
Role model, effort, permission, workspace, and shell settings are passed at
`thread/start`/`thread/resume`, while the ordinary Task message points to the
Session Manifest and matching Role Skill. Yui does not write either to global
Codex config. A native Codex profile is rejected because it cannot be isolated
to one shared-daemon thread. The Agent Host owns only its proxy and WebSocket:
Task execution stop discards the Yui attachment without waiting for or changing
the daemon or native thread, and start creates a new attachment.
Claude uses a persistent stream-json
transport with exact user-message replay acknowledgement. In both cases, Yui
records Turn intent before writing, accepts only exact Provider evidence, and
maps an uncertain write to `delivery-unknown` without automatic resubmission.

Role desired revisions and Turn/Session effective snapshots keep configuration
history explicit. Resume compares the complete effective snapshot and
workspace compatibility rather than revision alone. Desired drift is expected
while an old process is running and becomes effective only on a later launch;
control-plane wakes continue through the live Session's actual snapshot, and
fresh replacement archives the stopped snapshot instead of rewriting it.
Mailbox generations, reservations, liveness, and native Turn terminals remain
the control-plane authority; configuration snapshots do not replace those
execution facts. Lifecycle code uses structured Hook data, persisted identities, tmux
process state, receipts, and pane fences. It never parses Agent terminal glyphs,
progress text, trust dialogs, or final prose to infer readiness or success.

All durable writes use process locking and atomic replacement. Storage validates
record identity, legal transitions, dependency cycles, cross-record ownership,
immutable Git evidence, and current Controller protocol compatibility. Worktree
cleanup revalidates ownership and fails safely when concurrent state changes;
manual retry is the recovery boundary rather than another durable state
machine.

Storage still records layout, aggregate, and record-family versions, but this
release deliberately re-baselines all three axes at the current contract. The
production migration registry is empty. Ordinary opening, Controller startup,
doctor, update preflight, and the storage upgrade entry point therefore accept
only an exact current manifest and current record shapes. An older Home is
unsupported and must not be normalized, rewritten, or switched in place.

SQLite bootstrap DDL is an implementation detail for initializing a fresh Home.
Its ledger must be complete on every later open; a partial or older ledger is
rejected rather than advanced. This keeps one durable model for Turn,
TaskRoleSessionSet, WorkMailbox, and Provider Runtime Binding and prevents an
old writer or migration transform from recreating removed delivery state.

The Web control room is loopback-only and never receives Controller socket
credentials. It presents durable records and native terminal access without
becoming a second source of truth.
