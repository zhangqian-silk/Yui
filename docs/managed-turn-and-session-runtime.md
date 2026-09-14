<p align="right"><strong>English</strong> | <a href="./managed-turn-and-session-runtime.zh-CN.md">简体中文</a></p>

# Session, AgentRun and notifications

## Authority

Task, WorkItem, Message, Decision, Artifact and Project Knowledge preserve
durable work. Session identifies a native conversation and its captured
authority. AgentRun records an explicitly requested execution and original
result. AgentHost is a disposable attachment, not the owner of Task truth.

A current, non-revoked Leader Session can read Context and save scoped Task
facts, including a formal InputRequest, without an active Run. Its exact
Session is the request's origin; an actual Run is included when present.
The question survives that execution ending and remains open until answered
or cancelled. Worker and Reviewer commands retain exact
Assignment checks. Session replacement, Role binding, Task scope and resource
grants are checked at their respective boundaries. An active Run pointer is not
proof that an unrelated command in the same Session came from that Run.

Native chat, Goal continuations and ordinary Leader notifications do not
automatically create Runs. Explicit dispatch loads one exact Run Context Pack.

## Context

```sh
yui task context <task> --json
yui task context delta <task> --after <coreCursor>
yui task context inspect <task> --store <store> --ref <id>
yui task run context <task/run> --json
```

Task Context is a bounded authorized working set with a current core cursor.
Delta pages immutable events through a fixed upper bound; inspect expands a
current record and can require an exact digest. Runtime observations state their
own coverage and do not become another durable snapshot.

Run Context freezes Assignment, source references, effective configuration and
workspace boundaries. A Role edit does not rewrite an existing Assignment.
Reading either Context does not acknowledge input or create execution authority.
Every managed input points to the exact Session Manifest and CLI entry. The
Run Pack is a reference directory: read the relevant requirement and message
bodies before acting, rather than treating a successful load as the deliverable.
Planning Packs expose no Project write scope or Task-completion permission.

Current Task reads also expose untargeted user/Operator messages to the Task's
current Worker and Reviewer Sessions, including requirements added after their
Run snapshot was frozen. Use `task message list/show` or Task Context inspect
to read those original records. This does not rewrite the frozen Assignment or
grant delivery authority. Directed messages, other Roles' results and other
Tasks remain outside the caller's scope unless its Assignment authorizes them.

## Dispatch and notification

An explicit dispatch persists execution intent before native submission.
Ordinary Leader wake instead claims a fixed TaskWake/mailbox batch and submits
a notification through the same Host/Endpoint. Confirmed acceptance consumes
only that batch; later input remains pending. A notification requires no final
execution report and does not force steer into a busy native conversation.

Leader-local edits preserve durable events but do not create self-wakes.
Other sources' input remains durable while the Leader is busy or unavailable.
Operator notifications likewise carry TaskEvent/InputRequest read pointers,
not duplicated Task narrative.
Human input, explicit execution entry and activation failure are delivered
promptly through the existing wake mechanism. Worker results retain their
aggregation window. Busy native input still preserves pending messages.

| Evidence | Disposition |
| --- | --- |
| Busy with proven non-acceptance | Preserve input; a new transport attempt may use the same Session |
| Native acceptance | Never resend; wait for the exact terminal if this is an execution |
| Transport write only | Retain transport evidence; do not claim native acceptance |
| Explicit rejection | Retain the original cause and settle the corresponding admission |
| Unknown acceptance/effect | Retain the attempt and conflicting-resource fences; do not replay or switch Session |

Missing receipt after a crash is not proof of non-acceptance. Structured
`SESSION_BUSY` is evidence; text containing “busy” is not a retry contract.

## Continue existing work

```sh
yui task message send <task> "Continue with the clarified requirement" \
  --to <role> --work-item <work-item>
yui task message handoff <task/message> --to <successor-role>
```

Review clarification uses `--review-round` instead of `--work-item`.
Message retains recipient, work association and owner Run. When the Role is
busy, saving returns without interrupting it. Once it becomes available, a
bounded ordered batch can create a continuation Run atomically associated with
those messages. The existing Assignment, effective permissions, workspace and
unfinished files remain; the snapshot adds authorized messages and the preceding
original result. Duplicate terminals cannot assign the messages twice.

Ownership changes, incompatible Sessions, terminal work and obsolete Review
candidates retain visible nondelivery reasons. Explicit handoff only targets an
already-dispatched successor for the same work. Replicated Producer/synthesis
lineage is not silently rewritten by a message.

Unknown Leader notifications preserve their wake and input window:

```sh
yui task wake show <task> <wake>
yui task wake resolve <task> <wake> --reason <quiescence-evidence>
```

Resolve releases the claim after native-effect fences are clear. It neither
replays the notification nor invents acceptance or completion. Independent
Role work and legal local facts are not a Task-wide recovery lock.

Wake status records notification delivery, not Message implementation. For
ordinary Leader notifications, `consumed` means native acceptance. Native Turn
completion and Task delivery need their own runtime evidence and durable results.
A rejected or released wake may remain `dispatched` without an active mailbox claim.
Session replacement preserves queued input for a new wake and current Context;
it does not retroactively mark an old wake accepted. Late receipts cannot settle
the successor's batch. While Session cleanup is pending, new input remains queued.
Inspect the wake, `notification.delivery` events, current mailbox and Session
together; do not require one final response per historical wake.

Current wakes are notification-only. Run completion cannot consume a wake, and
the first notification window starts at Task creation. Retired Run-linked wake
records remain in Task events with their original ID and payload, not as a
second active wake format.

## Input timing: queue, steer and interrupt

Submission intent (`record / discuss / develop`) decides how a requirement is
routed. Input timing decides when an already-authorized input reaches a Role;
it does not activate a Task, expand an Assignment or upgrade planning authority.
Save-only input uses `message send --intent record`; `--wake-policy` is removed.
Draft Message edits change the body only, preserving their original submission
intent. To choose a different action, make a new explicit submission.
The [authenticated Web controls](architecture/capabilities-and-resources.md#cli-and-web)
use the same three operations as the CLI.

| Action | Effect | What it does not prove |
| --- | --- | --- |
| `queue` | Saves a Message for the recipient's next legal opportunity, idempotently by request ID | Reading Context or accepting delivery is not implementation |
| `steer` | Saves a Message and attempts native steering of the exact current Turn | Unsupported, stale or unconfirmed steering is not a queued continuation |
| `interrupt` | Records a control request and asks the Provider to cancel the exact current Turn | A stop request is not a terminal or proof that background resources stopped |

Inspect the Session before selecting a live target:

```sh
yui task role session inspect <task> <role>
yui task message queue <task> "<continuation>" --request-id <id>
yui task message steer <task> "<correction>" --request-id <id> --to leader --expected-target <turn>
yui task role interrupt <task> <role> --expected-target <turn> --request-id <id> [--then-message <task/message>]
```

Ordinary Leader `queue` input omits `--to`. An explicit `--to <role>` (including
`leader`) addresses an existing Assignment and requires `--work-item` or
`--review-round`; a Message cannot establish that Assignment. `steer` still
requires an explicit Role and exact live target.
Reusing a request ID with different content or a different target
is a conflict. `steer` and `interrupt` never silently retarget, replace a Session,
kill a process or fall back to another action. No live managed Turn yields
`NO_ACTIVE_TURN`; stale targets and unsupported control remain explicit outcomes.

Bare interrupt creates no Message. Optional `--then-message` names an already-saved,
eligible input and reserves its next opportunity only after an exact terminal,
within the original Session/writer boundary. It is not a fourth action or a way
to replay accepted, pending or unknown steering. A conclusive non-delivery can
permit an explicit new control choice when the user's intent authorizes it;
uncertainty cannot.

Global Roles use the same three actions with their own owner and Session,
without inventing a Task or Run. The local-user Web surface exposes them through
the shared Global Role handler. The public CLI exposes
`yui role message queue|steer <role> <text>` and `yui role interrupt <role>`.
Queue/steer require `--request-id`; steer/interrupt require `--expected-target`.
These commands retain the caller's existing Session authority; do not fabricate
a Task/Run or borrow the browser's user authority. Configuration remains under
`config role`, lifecycle under `session`. New controlled Global Sessions use the Host console.
A live unmanaged Session is not silently adopted; an explicit Session lifecycle
action is needed first.

## Exact results

The native terminal settles only the matching execution. Known native Turn IDs
must match; a serialized stream may use proven local attempt correlation.
Message UUIDs are not native Turn IDs. Unrelated native chat in the same Session
cannot complete the pending Yui request.

The terminal transaction saves one AgentRunResult and a reference Message.
`resultRef: { type: "agent-run-result", runId: "run-12" }` expands the original
report rather than copying it. Candidate and ReviewRound retain provenance;
Core does not derive semantic acceptance from prose.

Cancellation requests do not prove physical quiescence. Exact terminal evidence
preserves partial output and settles the original execution only. Host exit
does not imply shared Provider or descendant processes have stopped.

## Draft planning and activation

`EffectiveLaunchSnapshot.executionAuthority` captures `planning | delivery`.
It is not recalculated from the Task's current lifecycle. Planning permits
local planning facts, not delivery dispatch, candidate adoption, integration or
delivery workspace Jobs.

The initial Draft planning dispatch creates a planning Run and binds only its
initial message batch. Acceptance or an exact terminal consumes that batch;
failure does not repeatedly recreate the same planning execution. Subsequent ordinary
messages in the existing planning Session remain notifications. Operator submit
and direct Task messages both reach that Session. Draft plan/WorkItem edits
preserve execution history; external edits notify the Leader, while its own
planning edits do not create a self-wake.

New Draft Roles use a Task-specific planning directory under
`<YUI_HOME>/runtime/task-runtimes/planning`, separate from durable control data and delivery trees.
A planning Run can use `task activation request` to persist intent and return an
`afterPlanningRun` reference immediately. Its terminal releases the request for
Controller admission; cancelled intent is not resurrected.
The Leader can also request activation during ordinary discussion without an
AgentRun: the Controller adopts its durable intent once the native input is
settled. No synthetic Run or extra user “continue” is required.

For bound Git Projects, `--environment empty` means no additional environment:
the Projects still receive managed worktrees. `scratch` selects a Task-owned
directory. `local` requires a registered local Resource and its grant; a Project
ID is not a local Resource ID.

`task activate` is foreground adoption of an existing request, not an alternative
way to create activation intent. A request-free Draft is rejected before resource
preparation; the command does not invent an environment plan or request ID.

Resource preparation precedes the atomic adoption of Task status and workspace
ownership. A failed adoption records a failed request and notifies the Leader
with durable facts; it does not repeatedly prepare resources on unchanged
failure. The Leader chooses an explicit retry or corrected request. Successful
activation likewise leaves a delivery notification for the Leader.
Activation never mutates the live Session into delivery authority. A changed
launch must pass the existing Session replacement/environment boundary.
Planning authority is a CLI guarantee, not a hostile-code filesystem sandbox.

## Inspection and lifecycle

```sh
yui task run list <task>
yui task run show <task/run> --json
yui task message show <task/message>
yui task role session inspect <task> <role>
yui task execution start <task>
yui task execution stop <task> --force --reason <reason>
```

Task execution start/stop controls Task admission, not Task acceptance.
Stop first fences new Yui work, then interrupts each exact owned native input
and confirms its terminal before removing the attachment. This also covers
ordinary Leader notifications without Runs. Unknown native state blocks cleanup;
stopping a proxy alone never proves a shared Turn ended. Start preserves durable
progress and admits new input after the old occupancy is settled.
Draft planning can be paused/resumed, and a failed planning Run retries with
planning authority. An authorized user/Operator can stop an idle Draft Session
through `task role session stop`; it need not activate the Task merely to recover.
`task role session new <task> <role> --reason <reason>` persists an explicit
replacement request. Reuse is a preference, not a requirement to prove the old
conversation unrecoverable. The request is legal while an AgentRun is active,
the Session is ended, or previous cleanup is pending. A Leader may also request
its own replacement and end its current turn.

`task role session stop` can also stop a running Role without first changing
its Run status. It retains the native conversation for possible reuse. Pending
Messages remain intent and may start a continuation after the stop; use Task
execution stop when the whole Task must remain paused. For self-replacement,
use the asynchronous `session new` request rather than a synchronous self-stop.

The existing runtime cleanup path stops the exact native execution, closes this
Role's remaining engineering attempts as cancelled, retains Session/Run history
and workspaces, and selects a fresh conversation. Other Roles and Task acceptance
remain unchanged. The Leader receives a new context notification; it decides
which Worker/Reviewer attempts to retry. Pending input references survive the
replacement, including records older than the new notification's time window.

An absent Host does not remove the recovery entry point. Codex can be inspected
and interrupted through a disposable native control connection without starting
a model. Dedicated Claude process custody is persisted independently of the
Host. Real unconfirmed execution still prevents conflicting resource reuse;
cleanup failure is a durable diagnostic routed to the supervisor, not a reason
to invent acceptance or delete the Task. A preallocated ID alone is not proof
a conversation exists.
Codex may retain `systemError` after a failed native Turn. That label alone
neither proves activity nor authorizes cleanup: Yui checks the latest native
Turn's terminal metadata and drains background execution before replacing the
Session. Unknown or still-running native work remains protected.

Released Leaders retain scoped diagnostic reads of their own Task and context,
but cannot mutate it or read another Task. Operator diagnostics and Controller
restart do not first require a healthy Controller; explicit restart can stop
only the exact same-Home process using PID/start identity when RPC is unavailable.
Operator storage diagnosis/upgrade also reaches the dedicated migration entry
without first requiring the Home to already have the target storage version.
Completion, cancellation and archive have distinct authority and resource
boundaries. Storage changes use the single [upgrade contract](sqlite-control-plane-design.md).
