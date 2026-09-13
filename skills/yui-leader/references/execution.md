# Active execution

Read this after the [Leader stage entry](../SKILL.md) selects authorized
delivery. These implementation, dispatch, review and acceptance instructions
are not requirements for ending a planning discussion or answering a query.

## Choose the simplest coherent result

Start from the current Task Contract and trace the existing implementation,
ownership and supported operating path before choosing a change. Establish
whether a failure is reachable with the user's actual inputs and configuration;
do not make a test fixture's accidental differences into new product policy.

Choose the lowest total implementation, verification, coordination and
maintenance cost that satisfies the contract. Reuse a coherent responsibility;
redesign a misplaced boundary when that lowers the complete cost. Add a
mechanism only for a demonstrated requirement or hard boundary that existing
primitives cannot satisfy. Derived views must not become competing truth.

Make routine legal choices yourself. Do not ask the user to choose among
implementation patterns, scheduling options, review routing, or recoverable
runtime actions. Create an InputRequest only for a real product choice, new
authority, irreversible external effect, or unavailable external fact.

## Separate the work unit, executor, and concurrency

Honor the user's explicit choice of direct work or delegation. Otherwise make
three independent judgments; Review is a fourth judgment below.

**Does this result need its own management and acceptance boundary?** A WorkItem
is a substantial result worth managing and accepting separately inside the Task.
It need not have a different person, an independent release, or parallel execution.
Use zero WorkItems when the Task already holds one coherent outcome. One WorkItem
can be Leader-owned or hold a justified whole-result managed Assignment and
Candidate. Copying the Task unchanged or displaying progress is not a reason
to create it. Do not split analysis, editing, testing, Review, and ordinary
repairs into phase-shaped WorkItems.

**Who should execute?** Direct Leader execution is the default viable path for
one coupled result when current context, delivery authority, and tools suffice.
A native child can supply bounded specialist attention or parallel investigation
inside this Session when a best-effort result suffices; it creates no Yui identity,
authority, or WorkItem by itself.

Choose a managed Worker only for a concrete benefit that repays requirement
restatement, context reload, startup, waiting, inspection/rework, Integration,
and lifecycle management. Benefits include safely parallel independent results,
a needed capability or execution environment, a genuinely necessary separately
recoverable lifecycle, freeing the Leader for another actual responsibility,
or explicit user delegation. An available Worker, cheaper/different model,
many files, high risk, long duration, or generic maintainability alone is not
enough. Risk can justify independent Review without delegating implementation.
When delegation involves a material tradeoff, leave one sentence of concrete
benefit in the existing Brief; no form, approval, or separate decision record
is needed.

**Should separate units run concurrently?** Multiple WorkItems may run serially
because of a real dependency, or concurrently when their results can advance
independently and the net benefit exceeds coordination and Integration cost.
Neither a single WorkItem nor multiple executors proves parallelism. Keep
coupled changes together.

For example, fix one coupled behavior directly in Task main, even when it touches
many files. Delegate an independent import tool while the Leader implements its
consumer when the two have a stable boundary and useful parallel progress.
Keep two separately accepted stages serial when the second genuinely needs the
first result. Do not wrap a whole Task in an `implementer` WorkItem merely because
that Role exists.

Apply these choices to new work. Do not automatically cancel an existing Worker,
reassign/retire WorkItems, or move workspaces to conform to a new default; preserve
their current ownership and evidence until a justified explicit change.

An ordinary managed dispatch uses the WorkItem assignee; omit `--lane-role`.
Use [replicated execution](replicated-execution.md) only when
independent attempts over the same frozen Assignment repay their coordination
cost. Direct managed execution already provides durable ownership.

## Give Agents outcomes, not premature implementations

Make delegated work decision-complete:

- objective and observable acceptance criteria;
- relevant Task and Project context;
- hard scope, authority, and workspace boundaries;
- known constraints, risks, dependencies, and existing decisions; and
- expected checks and evidence.

Let the receiving Agent choose its implementation plan, internal structure, and
tools unless a particular ordering or mechanism is itself part of the accepted
contract. Do not encode the Leader's speculative design as mandatory Worker
steps.

For Project-backed work, use the Project Skills, Policy, and Knowledge exposed
through current context. Keep repository-specific build, migration, release,
and test rules in that Project-owned layer.

## Inspect execution facts

Use `yui task context <task-id>` and `yui task next-action <task-id>` as
decision support. They expose current facts, exact refs, and legal
alternatives; they do not replace Leader judgment.
An empty WorkItem list does not mean the user requested direct execution.
Honor explicit delegation and independent Review requirements in the user's
messages and Task Brief. Neither `next-action` nor a disabled default review
policy authorizes dropping them to make completion easier.

An Integration Job's success is not the final target update. For that
notification, read [Integration](integration.md) and continue from its exact
evidence; do not start a duplicate operation. Read that guidance also for an
ordinary Git conflict or an attempt that cannot be reliably resumed.

Before dispatch, Review, Integration, or completion, inspect
`liveTaskState.activeRuns` and `liveTaskState.activeTaskReviews` in the current
Context Pack. They report work in flight but gate nothing by themselves; reason
from each exact binding and frozen candidate instead of treating activity as a
global Task lock.

## Execute the chosen path

### Choose input timing without changing intent

Submission intent (`record`, `discuss`, `develop`) and delivery timing are
different facts. Input controls do not activate a Task, expand an Assignment,
or elevate a planning Session. Keep the submission contract when using `send`;
choose queue, steer or interrupt from the user's intent and current facts:

```sh
yui task message queue <task> "<continuation>" --request-id <id> --to <role> --work-item <work-id>
yui task message steer <task> "<current-turn correction>" --request-id <id> --to leader --expected-target <turn>
yui task role interrupt <task> <role> --expected-target <turn> [--then-message <task/message>] [--request-id <id>]
```

Queue waits for the next legal opportunity. Steer addresses only the exact
current native Turn; Worker/Reviewer steer also needs its existing WorkItem or
ReviewRound. Bare interrupt stores a control request, not a new Message.
`interrupt-requested` is not a terminal or proof that background resources
stopped. Then names an already-saved input and reserves its next opportunity
only within the original Session/writer boundary.

Read `task role session inspect` first. Unsupported and proven-unsubmitted
steer may be composed with interrupt when the user's intent permits stopping;
accepted, pending or unknown steer must not be resent through another action
or request id. Never silently cancel, replace a Session or downgrade to queue.

Global inputs use `role message queue|steer <role>` and `role interrupt <role>`
with their own owner, not a fabricated Task/Run. See
[Runtime](../../yui-runtime/SKILL.md) for scope and controlled-console boundaries.

Managed dispatch freezes the Assignment for its assignee. For ordinary
clarification, feedback or a continuation of that same work, send a Message:

```sh
yui task message send <task> "<clarification or continuation>" --to <role> --work-item <work-id>
yui task message send <task> "<review clarification>" --to <role> --review-round <round-id>
```

Busy execution queues the Message. Its terminal triggers continuation in the
same compatible Session and workspace; do not fabricate a failure, submit an
unfinished Candidate, or change WorkItem status merely to answer a question.
Read Message delivery and the exact resulting AgentRun separately from business
acceptance. A Message never expands scope, applies desired configuration, or
changes a Review's frozen candidate. An ownership change preserves the original
recipient; transfer still-pending input only with explicit `task message handoff`.
Late input to terminal work or an obsolete Review remains visible with a bounded
nondelivery reason. Use the existing formal operation for new scope or Review.

For unknown delivery or Session replacement, read
[runtime recovery](../../yui-runtime/references/recovery.md). Preserve the original
input; do not replay uncertainty or treat it as a global Task lock.

### Direct delivery with zero WorkItems

The current delivery Leader needs no self-dispatched AgentRun or placeholder
WorkItem. Read the full Task requirements and relevant Messages, then implement,
verify, and fix the coherent result in Task main on its managed branch. Commit
and leave it clean. Run focused checks while changing behavior and the required
Project delivery checks on the final result.

Keep the Brief as a current summary, not a replacement for Task requirements.
Preserve changed intent and reasons in Messages/Decisions, substantial documents
in Task artifacts, and code and verification evidence in the actual delivery.
Zero WorkItems reduces coordination records, not requirements or evidence.

Inspect the complete final diff and decide Review separately. If a Task-final
Review is required or adds useful evidence, request it against the clean Task
heads using `yui task review request <task> --role <reviewer>`. No WorkItem is
needed. Consume the original result, fix reachable findings directly in Task
main, and decide whether the changed result needs another Review. Honor immutable
Review contracts and explicit user/Project requirements even if a default is
disabled. Once the outcome and obligations are satisfied, use `task complete`
with the outcome, checks, and remaining risk; a final chat message is not completion.

### Leader-owned WorkItem

Use this only when the result merits separate management/acceptance. Omit
`--role` for direct execution: the Leader owns coordination and performs the
work without a managed executor Assignment. `--role leader` instead selects the
Leader Role as a **managed AgentRun executor**; it is not how to label direct
ownership. Do not self-dispatch merely to gain execution authority.

For a writable Project result, create and inspect its WorkItem-owned workspace
before editing. The Leader can work there directly; isolation does not require a
Worker. Task main, WorkItem Develop, and Review workspaces remain distinct owners.

```sh
yui task work create <task> "<separately accepted result>" \
  --project <project> --objective "<outcome>" --accept "<criterion>"
yui task work isolate <work-id>
yui task work update <work-id> running
# Implement and verify in the returned WorkItem workspace; commit and leave it clean.
yui task work update <work-id> done --summary "<result and evidence>"
```

`done` freezes a direct Candidate, not an AgentRun result or acceptance.
Inspect it, then integrate the exact isolated result before acceptance:

```sh
yui task integration start <task> --work-item <work-id> \
  --project <project> --strategy <ff|cherry-pick|merge|manual>
# Inspect the attempt and finish it through Integration's normal checks/continuation.
yui task work accept <work-id> --summary "<decision and evidence>"
```

Read [Integration](integration.md) for checks, continuation, and recovery.
Keep the same unit through ordinary fixes.
A read-only or Gitless result with no writable Projects needs no Git isolation;
submit its actual evidence and accept it explicitly. Existing exact Task-final
metadata-only Candidates retain their contract; do not establish a special Review
contract merely to avoid the ordinary writable WorkItem isolation boundary.

For a native child, pass a bounded brief and applicable Profile constraints
through the provider's child tools. A small investigation needs no synthetic
WorkItem. If the child implements an existing Leader-owned WorkItem, keep that
WorkItem roleless, supply its exact workspace and scope, and mark it running.
Native children inherit only current parent authority and gain no Yui Role,
AgentRun, Session or broader workspace. Their
results are best-effort until Yui externalizes them; use a managed Task Role
when independent durability matters. Inspect the returned result before
submitting `done` or recording failure progress. `done` creates a Candidate;
`work accept` records the separate acceptance. WorkItem responsibility remains
open through execution failure and becomes accepted only on that decision.
A Profile's runtime source applies when
materializing a Task Role, not when launching a native child. The child
inherits the Leader Agent; apply a Profile model or effort only when the native
tool actually supports and confirms that override.

### Managed Task Role

```sh
yui task role add <task-id> <role> --profile <profile>
yui task role show <task-id> <role>
yui task work create <task-id> "<outcome>" --role <role> \
  --project <project> --objective "<bounded outcome>" --accept "<criterion>"
yui task work dispatch <work-id> --input "<decision-complete brief>"
```

Add `--after` only for a real dependency. Likely file overlap is not by itself
a dependency. A Worker may read the complete authorized Task context but may
write only its WorkItem Projects and workspace. Dispatch prepares that isolated
workspace and freezes the Assignment; inspect the completed original AgentRun
result before submitting its exact Candidate, integrating, and accepting.

Profiles carry portable behavior plus either a dynamic Global Worker runtime
source or an explicit Agent with optional model and effort. Applying a Profile
to a Task Role resolves and freezes the complete binding; later Profile or
Global Worker changes do not rewrite that Role. Before dispatch, use
`config profile show` and `task role show` to read the exact behavior, Agent, model,
effort, Profile, and workspace. Do not reconstruct or guess launch
configuration. Use the WorkItem assignee directly unless replicated execution
was deliberately selected.

Managed Task main, WorkItem, ReviewRound, and Integration workspaces have
different owners. Never edit stable Project checkouts, managed refs, Yui state
files, or another owner's workspace. A Task's recorded base is durable; do not
silently replace it merely because its remote branch later moves.

## Extend capabilities within this Task's authority

Use `capability search`, `describe`, and `call` to inspect current tools.
Prefer existing tools, composition or a one-off script when sufficient.
For reusable Task-local capabilities, read [Task plugins](task-plugins.md)
before creation, validation or activation. Plugin management permission does
not grant code execution or broader external effects. Never issue your own
grants, impersonate Operator, or modify the core installation to obtain a tool.

## Validate and make the review judgment

Use the smallest evidence that establishes the accepted behavior and material
boundaries. Do not repeat a successful unchanged check. Run the Project's
complete local delivery validation once on the final candidate when its Policy
requires it.

As part of accepting a WorkItem or completing a Task, decide whether additional
review would add useful evidence:

- inspect directly when the change is clear and existing evidence is enough;
- use one independent Worker, native child, or Reviewer when independent
  inspection materially reduces a reachable risk; or
- rely on an already completed applicable Review.

This is Leader judgment inside the acceptance decision, not a separate record,
checklist, or workflow phase. A managed Reviewer is optional unless the user,
Project or Task Contract requires it. Do not create a
Reviewer Role or ReviewRound for ceremony. Honor an existing Candidate's
snapshotted `always` policy and any immutable Task-final Review contract.
Otherwise choose whether another review adds enough evidence to justify its
cost.

Use one direct main Reviewer by default. If independent replicas materially
improve evidence, read [replicated execution](replicated-execution.md)
before dispatch or synthesis. Honor required review contracts even when a
cheaper execution path is otherwise available.

When several WorkItems contribute to one outcome, prefer one independent
Task-final Review after their accepted results are integrated over repeating a
complete Review for every WorkItem. Request an earlier WorkItem Review only
when that frozen Candidate has a specific risk that should be resolved before
Integration.

When a Worker or Reviewer result arrives, resolve its exact AgentRun and read the
complete original `AgentRunResult.output` before starting new work or waiting
again. Treat headings or JSON fields only as communication aids; never infer
that Core parsed or accepted them. Decide whether to accept, repair, review
again, retry execution, or ask for a genuinely user-owned decision. Route
reachable issues to the original execution owner. Fix a small Task-main issue
directly; create a Repair WorkItem only when the repair is itself a substantial
independently owned requirement.

A failed ReviewRound is an execution failure, not a repair wave. First read
its Provider retry projection: bounded infrastructure recovery may already own
the successor. Otherwise inspect its exact Round, AgentRun, candidate, Core failure, and
`task next-action` facts, then choose the smallest recovery that preserves the
frozen boundary. Do not invent a retry loop or silently replace the Reviewer
Session. For replicated execution, choose whether to retry a failed Producer,
settle that Lane, or synthesize selected available results. Retry a failed
main synthesis through its exact AgentRun, preserving its selected source snapshot.

## Accept, integrate, and complete

A Worker or Reviewer AgentRun result is evidence, not acceptance. Inspect the
result, diff, checks, and current Candidate before deciding.

If a result is insufficient, reject it with bounded feedback and redispatch
the same WorkItem and Role while scope remains valid. Before accepting isolated
Git changes, read [Integration](integration.md) to capture and
integrate the latest Candidate. Do not edit managed refs or bypass Yui's
compare-and-swap boundary.

After an authorized PR/MR operation, follow
[publication recording](../../yui-runtime/references/publication.md).
External delivery and Task completion remain separate facts.

After a ReviewRound is terminal, the Leader or authorized Operator owns
`task work review cleanup <task>/<round>`. Preserve dirty diagnostic evidence
and resolve it explicitly; do not ask a Reviewer to clean its own runtime
after its final report. Cleanup can remain advisory at completion. Ordinary
archive requires settled resources; explicitly authorized force archive preserves
unresolved resources and diagnostics under the shared
[archive contract](../../yui-runtime/references/publication.md). The Leader
does not gain independent archive authorization.

Complete only when the Task outcome is satisfied, required checks and review
contracts are settled, WorkItems are accepted or deliberately retired, latest
isolated results are integrated, and user inputs are resolved:

```sh
yui task complete <task-id> \
  --summary "<outcome, validation, and remaining risk>"
```

Completion records the exact Project heads. Archive is a separate,
user-authorized Operator action.

If completion reports `pending-user-input`, new user intent has not yet reached
the current notification window. End this native turn so the next notification
can be delivered, then read the original messages and reassess the outcome.
Do not spin on completion, drop messages, or manufacture another Run to proceed.
A current Leader Session can create a formal InputRequest during an ordinary
notification; no active AgentRun is required.

## Finish an active execution turn

Before ending authorized execution:

1. Inspect the wake delta, resolve every referenced Worker or Reviewer AgentRun
   with `yui task run show`, read each original result in full, and make the
   next decision.
2. Persist actual WorkItem lifecycle and material Brief, Decision, Milestone,
   Message, or Knowledge changes.
3. Choose one truthful outcome: continue through an owned native child, complete
   the Task, create a justified InputRequest, or leave the active Task waiting
   for a real durable event.
4. For an explicitly dispatched AgentRun, return its truthful original final
   report with outcome, checks, remaining risk and bounded next action.
   Direct conversation and notifications do not require a separate execution
   report; use the [stage-specific close](../SKILL.md#close-the-current-turn).

Do not claim completion only in prose when durable Task or WorkItem state still
needs updating. Do not poll managed Roles or emit waiting Messages. Managed
results enter a later Leader notification; that notification is not an implicit
AgentRun and requires no separate execution report. An unchanged active Task remains quiet.

Use the shared [runtime recovery](../../yui-runtime/references/recovery.md) contract
for failed execution. Persist successor context before replacing yourself,
then end this turn; engineering cleanup is not discarded Task intent.
