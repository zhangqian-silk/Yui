# Yui Architecture

Yui is a local control plane for durable work across Projects and native Agent
runtimes. The user talks to one Operator. The Operator routes each request to
the right Project and Task; that Task's Leader owns decomposition, execution
choice, review, integration, and completion.

## One work model

`WorkItem` is the only bounded unit of work. It holds the objective, acceptance
criteria, dependencies, assigned Task Role when applicable, lifecycle, and a
compact reviewed result.

A Leader chooses one of three execution paths for each WorkItem:

1. **Direct**: the Leader executes a roleless WorkItem.
2. **Native subagent**: the Leader creates a child through its current Agent
   conversation. The child inherits the Leader Agent and is not a Yui entity.
3. **Task Role AgentRun**: Yui dispatches a Role-bound WorkItem to a
   Task-managed native Agent Session.

There is no Yui subagent launcher, child-session record, or second bounded-work
model. Direct work and native subagents use the WorkItem lifecycle. Managed
independent execution additionally records an AgentRun.

## Profiles, Roles, and Agents

- `Agent` selects a supported adapter such as Codex or Claude and defines its
  launch context.
- `WorkerProfile` is a versioned, provider-neutral behavior template containing
  instructions, Skills, access expectations, and optional model/effort hints.
- `TaskRole` is a mutable Worker instance inside one Task. Applying a Profile
  copies its portable behavior. Its versioned desired launch configuration is
  next-launch-only. The Role may bind multiple Agents; every binding retains
  independent runtime configuration.
- `AgentRun` records one managed dispatch and an immutable effective snapshot:
  actual Agent, adapter, model, effort, source access, provider permission
  strategy and native options, workspace, Role context, and source desired
  revision. A native Role Session stores the same snapshot; running processes
  are never hot-mutated by later Role edits.
- A `WorkItemCandidate` is the explicit result currently awaiting Leader
  acceptance. It snapshots the WorkItem revision, summary, and either a
  yielded execution Run or a Leader-managed direct source.
- `ReviewRound` records review of one candidate under the same WorkItem and
  references that immutable candidate. It is not another WorkItem.

Adding another Agent requires an explicit adapter implementation. Profiles do
not choose adapters, own Sessions, or carry credentials.

For a native subagent, the Leader must choose and read an explicit
WorkerProfile, using `worker` when no specialist fits. The Leader includes the
Profile instructions, Skills, access boundary, validation expectations, and
supported model/effort hints in the child brief. Task Role Agent bindings are
ignored because the child inherits the Leader Agent. The reviewed WorkItem
summary records the actual Profile revision, inherited or confirmed model and
effort, round, result, and checks.

## Lifecycle and acceptance

Direct and native-subagent work follows:

```text
todo -> running -> done | failed
                -> awaiting Leader decision  (when review is configured)
```

Task Role work follows:

```text
todo -> running -> awaiting Leader review
                      | accept -> done
                      | reject -> failed -> redispatch -> running
```

Worker yield ends the AgentRun and submits its result for review. It never
accepts the WorkItem. The Leader checks semantics, evidence, and Git state,
then accepts or rejects with bounded feedback. A rejected isolated WorkItem
keeps its workspace so the next Run can repair the same result.

An optional global review rule names one existing Global Role and chooses
`always` or `leader`. It is a live default for every Task; each Candidate
snapshots the effective two-field rule when submitted.
Every result awaiting acceptance is stored as an explicit WorkItem candidate.
`always` dispatches a review AgentRun for every candidate, whether it comes
from a yielded execution Run or a Leader-managed direct result; `leader`
leaves every candidate for the Leader to accept directly or review explicitly.
Review Runs complete only their exact ReviewRound, leave the WorkItem awaiting
acceptance, and never trigger another review or append a Candidate. Successful
and failed review attempts both wake the Leader and remain evidence for
judgment, not a machine verdict. The ReviewRound stores its frozen Candidate
base, isolated workspace provenance, terminal checks, and optional diagnostic
commit. The Leader may route that evidence to the original Worker, but Yui
never merges it automatically.

Dependencies are enforced at dispatch. A Role cannot have overlapping active
Runs, and terminal Task state fences new messages, dispatches, retries, and
late results until explicitly reopened.

## Project workspaces and integration

Stable Project checkouts are read-only references. Task identity follows one
bounded outcome rather than Project count. A Task binds zero or more Projects,
records an independent base ref for each binding, and owns one workspace root
containing a managed main worktree for each binding. The Leader runs from this
root and sees every Project as a peer directory. The active Leader may append a
Project when the same outcome expands; replacing an existing binding is not a
scope-repair mechanism.

A WorkItem can read the full Task workspace but has an explicit Project write
scope. Isolation creates a second root with independent worktrees for writable
Projects and Task-main context for the rest. The managed dispatch and
`yui-worker` Skill name both sets explicitly; the Agent must modify only the
writable set. Provider permission is binding configuration: every managed Role
defaults to `bypass`, while `default` and `configured` preserve provider-native
behavior. It is independent from Yui access. A normal source write requires a
WorkItem write scope and matching managed workspace; a review write instead
requires an exact ReviewRound owner and frozen Candidate base. Profiles and
Skills constrain behavior even when provider prompts are bypassed.
Scope is monotonic. A Worker cannot expand it directly: it reports the need,
and the Leader either adds Projects to the existing scope, creates another
WorkItem, or adds the Project to the Task.

An isolated result is handled in this order:

1. the Worker yields;
2. the Leader reviews semantics and evidence;
3. Yui captures each writable Project HEAD as an immutable Project ChangeSet;
4. each Project integration applies its latest reviewed ChangeSet in a candidate worktree;
5. configured checks run;
6. compare-and-swap advances the target only if its HEAD is unchanged;
7. the Leader accepts the WorkItem;
8. clean integration and WorkItem resources are explicitly removed.

Capture at the same HEAD reuses the existing ChangeSet. A repaired HEAD creates
a new candidate; only the latest reviewed candidate may satisfy acceptance.
An isolated WorkItem cannot be accepted or a Task completed while any writable
Project's latest result is uncaptured or unintegrated. Workspace roots are
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
- WorkItems, Roles, AgentRuns, Messages, InputRequests, Events, ChangeSets, and
  integration evidence.

The Leader updates the Brief before every yield, records material choices as
Decisions, records phase outcomes as Milestones, and promotes only cross-Task
stable facts to Project Knowledge. `task context` is the consolidated recovery
read; launches and wake messages carry record pointers rather than copied
context.

## Runtime ownership

tmux owns native Agent terminals. The Controller owns mailbox delivery,
wakeups, Role liveness, reconciliation, and read-only Web observation. Operator
and Leader Sessions are fixed Task/global Roles; Task Worker Sessions are
selected through Role Agent bindings.

Role desired revisions and Run/Session effective snapshots keep configuration
history explicit. Resume compares the complete effective snapshot and
workspace compatibility rather than revision alone. Desired drift is expected
while an old process is running and becomes effective only on a later launch;
control-plane wakes continue through the live Session's actual snapshot, and
fresh replacement archives the stopped snapshot instead of rewriting it.
Mailbox generations, reservations, liveness, native Turn Hooks, and exact yield
remain the control-plane authority; configuration snapshots do not replace any
of those completion fences.

All durable writes use process locking and atomic replacement. Storage validates
record identity, legal transitions, dependency cycles, cross-record ownership,
immutable Git evidence, and current Controller protocol compatibility. Worktree
cleanup revalidates ownership and fails safely when concurrent state changes;
manual retry is the recovery boundary rather than another durable state
machine.

The Web control room is loopback-only and never receives Controller socket
credentials. It presents durable records and native terminal access without
becoming a second source of truth.
