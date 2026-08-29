# Managed Run Delivery and Session Recovery

Status: implemented contract

This document defines how Yui admits work to a managed Provider conversation,
observes a running Agent without disturbing it, and authorizes recovery. It is
the implementation design for two related failures exposed by task-58:

1. a new or resumed `AgentRun` could exist without any work having been written
   to the Provider; and
2. elapsed-time and incomplete local observations could be interpreted as a
   dead Session even while the Provider was still making useful progress.

The design refines, rather than replaces, the identity, Turn delivery, and exact
probe contracts in [Managed Provider Runtime](provider-runtime.md). Runtime
activity and workflow progress retain the meanings established by
[Agent Runtime Drivers](agent-runtime-drivers.md).

## Product decision

Yui must intervene in an Agent conversation as little as possible.

- Every managed new or resume Run carries exactly one initial delivery intent.
- Creating the Run and reserving that delivery are one durable admission
  decision; the Provider Turn is created only after the Host binds the exact
  Conversation and Activation.
- Once the Provider accepts a Turn, time alone never authorizes reset,
  replacement, or a new native Session.
- Runtime liveness and workflow progress are observed independently.
- A healthy Agent may work for an arbitrary period without a Yui checkpoint.
- Run recovery and Conversation switching are separate decisions.
- Automatic switching allows a new Conversation only when the original
  Conversation is proven unrecoverable.
- The user, authenticated Operator, or matching Task Leader may explicitly request a
  switch with a required natural-language reason; that request never interrupts
  active work and executes only when a safe boundary and ready work coincide.

Under the default policy, one logical execution continues in one native
Provider Session unless the Provider proves that the Session no longer exists.
An explicit User/Operator/Leader request may intentionally supersede a recoverable
Session, but only at the independent safe switch boundary. A slow, quiet, or
poorly checkpointed execution may become observable to the Operator, but it is
not destroyed merely to make the projection look fresh.

## Incident evidence and design boundary

Task-58 is the motivating trajectory, not a compatibility target for its
historical malformed records.

- Twenty-two Leader recoveries were unaccepted, unpushed resumes. Yui had made
  an `AgentRun`, but the Provider had not received a Turn.
- Several accepted Runs were reset after roughly ten minutes despite later
  evidence of real tool use, repository changes, or a completed commit.
- A comparable Run left alone for about sixteen minutes completed normally.
- Reviewer executions commonly completed after fifteen to twenty-four minutes.
- A later healthy Leader execution in the same task history ran for roughly
  seventy-six minutes before producing its candidate.

These observations rule out a universal ten-, twenty-, or thirty-minute death
threshold. They do not require Yui to repair old task-58 records. Current valid
state gets the contract below; anomalous active state fails closed with a
bounded diagnosis.

## Terms

The authoritative identities remain those in the Provider runtime design:

- **Conversation**: the Provider-native Session that preserves model context.
- **Activation**: one local Provider process attachment to a Conversation.
- **Run**: Yui's attempt to execute one Role assignment.
- **Turn**: one exact Provider input attempt, fenced by its Conversation and
  Activation, together with its delivery outcome.
- **initial delivery intent**: the durable pre-Host obligation that binds a Run,
  exact work references, mailbox reservation, input attempt identity, and launch
  receipt.
- **initial Turn**: the first Provider input created from that intent after the
  Host binds the exact Conversation and Activation.

An initial Turn is analogous to opening or resuming a chat and then sending the
next user message. Starting the process or reopening the conversation is not
enough: the Agent has nothing new to execute until that input is delivered. The
input need not duplicate the whole task. It should guide the Agent to durable
Yui records that it reads through the CLI context API.

## Goals

- Make an empty managed Run structurally and durably impossible.
- Preserve exact-once Provider input delivery across Controller and Host
  failures.
- Make monitoring passive while accepted work is active and non-terminal.
- Separate delayed Yui checkpoints from absence of Provider execution.
- Put destructive Run recovery behind one evidence-based admission decision.
- Put creation of a replacement Conversation behind an independent switch
  decision that ordinary Run recovery cannot bypass.
- Support explicit User/Operator/Leader switch requests without interpreting their
  natural-language reason as machine policy.
- Continue the same Conversation across ordinary Run, review, and repair
  boundaries.
- Produce enough state and diagnostics to explain why recovery is or is not
  allowed.

## Non-goals

- Detecting whether an Agent's reasoning is subjectively good from token rate,
  prose similarity, CPU use, or elapsed time.
- Automatically repairing malformed historical Homes or leaked Sessions.
- Guaranteeing that every Provider exposes equally rich activity events.
- Interrupting active work merely to obtain a fresher checkpoint.
- Introducing a second scheduler or a background Session-reaper protocol.
- Automatically interpreting natural-language switch rules or reasons.

## End-to-end flow

```text
durable work becomes ready
          |
          v
Controller admits {Run + initial delivery intent + mailbox reservation}
          |
          v
Host starts or resumes exact Conversation
          |
          v
Host binds Conversation/Activation and obtains durable Turn-begin ack
          |
          v
Host submits exact Provider Turn
          |
          +---- accepted ------> observe without interference
          |
          +---- rejected ------> terminal delivery failure
          |
          +---- unknown -------> preserve unsettled Turn; diagnose, never replay

accepted execution
          |
          +---- Provider activity ---------> remain active
          +---- quiet/poor checkpoints -----> advisory or exact probe only
          +---- terminal observation -------> settle Run
          +---- exact Conversation missing -> independent switch decision
```

## 1. Managed launch admission

### 1.1 Launch requests are a tagged contract

The Controller-to-Host launch type must make omission of the initial delivery
impossible and must not require a Conversation identity before a new one
exists:

```ts
type ManagedLaunch =
  | {
      kind: "new";
      runId: AgentRunId;
      provider: ProviderTarget;
      initialDelivery: InitialDeliveryRequest;
    }
  | {
      kind: "resume";
      runId: AgentRunId;
      conversation: ExistingConversationTarget;
      initialDelivery: InitialDeliveryRequest;
    }
  | {
      kind: "ensure";
      conversation: ExistingConversationTarget;
    };
```

`new` and `resume` are Run-bearing launches and therefore require
`initialDelivery`. `ensure` may attach observation infrastructure to an
existing Conversation, but it creates no Run and carries no work.

An optional boolean such as `carriesInitialTurn`, or an optional delivery field
on a Run-bearing launch, is insufficient. It permits the same impossible state
that task-58 exposed. `InitialDeliveryRequest` is the required launch payload;
it is not a pre-created `ProviderTurn` and does not claim that the Host has
already bound a Provider writer fence.

### 1.2 Durable admission is a serialized, fail-closed sequence

Before asking the Host to launch, Yui crosses three existing durable boundaries:

1. the workflow transaction validates the current Task/Role, creates the
   `AgentRun` with its exact assignment, and enqueues the durable work refs that
   constitute its initial delivery intent;
2. the Controller delivery transaction claims that exact mailbox batch under
   the Run receipt and binds the Role's in-flight Run fence; and
3. the runtime lifecycle transaction reserves the exact launch receipt before
   the first external Host side effect.

These boundaries are intentionally staged because work admission and external
runtime launch occur in different Controller passes. Each stage is durable and
idempotent; a crash resumes the same Run, mailbox receipt, and launch identity.
A queued active Run may exist before the Controller claims it, but it always has
its assignment and pending durable work. No Host launch may occur until all
three boundaries are present, and no claimed work lacks an owning Run.

`InitialDeliveryIntent` names this composed admission invariant; it is not a new
aggregate. The existing Run assignment, mailbox receipt, and launch reservation
preserve the exact attempt identity and reconstructible payload. If a future
implementation cannot preserve that identity, the missing fact must use the
centralized schema-version migration mechanism rather than a compatibility
fallback.

After admission, the existing two-phase Host handshake remains authoritative:

1. the Host starts or resumes and binds the exact Conversation and Activation;
2. the Host asks the Controller to atomically promote the admitted mailbox
   reservation into the input-delivery claim and create the exact
   `ProviderTurn` as `submitting` under that writer fence; and
3. only after the durable acknowledgement does the Host perform the Provider
   write.

The pre-Host admission transaction must not create a `submitting` Turn without
the Conversation/Activation fence. Retrying either phase reuses the same input
attempt and launch receipt.

### 1.3 Delivery remains exact-once

The Host submits the exact admitted Turn and folds one of three outcomes:

| Outcome | Durable meaning | Controller action |
| --- | --- | --- |
| `accepted` | Provider acknowledged the exact Turn | mark acceptance and observe |
| `rejected` | Provider conclusively did not accept it | terminalize delivery; requeue only by a new explicit decision |
| `delivery-unknown` | failure occurred across the acceptance boundary | preserve unsettled Turn and diagnose; never auto-replay |

Process restart, timeout, socket loss, transcript silence, or a missing local
receipt cannot turn `delivery-unknown` into `rejected`. Replaying in that state
could execute the same user intent twice.

### 1.4 Resume means Conversation reuse plus a new Turn

A resume does not mean “start a process and wait.” It means:

1. select an existing Provider Conversation;
2. admit a new Run and its initial delivery intent atomically;
3. bind the resumed Conversation/Activation and durably begin the corresponding
   Turn; and
4. write that Turn to the selected Conversation.

When review or another downstream result arrives while a Leader is active, Yui
only queues durable references. It does not create a future Leader Run. At the
Leader's natural boundary:

- if the current Run can accept another Turn, the result becomes a new Turn in
  the same Conversation according to the Provider runtime contract;
- if a new Run is required, that Run and its initial delivery intent are
  admitted together, then the Host begins the exact Turn after binding;
- only the independent switch decision, currently backed by an exact
  `missing` probe, may select a replacement Conversation.

## 2. Passive execution health

Health is a projection of evidence, not a command to reset the Agent. The
projection has two independent axes.

### 2.1 Runtime liveness

Runtime liveness answers: “Is the Provider execution still doing or capable of
doing work?”

| State | Evidence |
| --- | --- |
| `active` | fresh Provider-native model/tool/subagent/operation activity, or an explicitly active operation |
| `quiet` | accepted execution exists, no terminal evidence, and recent activity is outside the display window |
| `unobservable` | observer/transport cannot currently provide trustworthy evidence |
| `terminal` | exact Provider terminal event, exited Activation with reconciled outcome, or exact missing/broken result |

Tool/model/subagent events and explicit operation identities are activity.
Token snapshots, CPU, RSS, pane existence, transcript mtime, and repeated local
polls are diagnostic evidence only. They never refresh authoritative liveness
and never authorize lifecycle mutation.

### 2.2 Workflow progress

Workflow progress answers: “Has the Agent recently advanced Yui's durable
workflow?”

| State | Evidence |
| --- | --- |
| `progressing` | checkpoint, yield, block, candidate, review result, completion, or another accepted workflow transition |
| `checkpoint-overdue` | runtime may be healthy, but no recent Yui workflow checkpoint |
| `stalled` | no workflow progress over the diagnostic horizon after exclusions for pending input and downstream work |

`stalled` describes the workflow projection. It does not prove that the
Conversation is dead and does not authorize replacement.

### 2.3 Derived user-visible states

The UI and `task next-action` should expose the conjunction rather than flatten
every old timestamp into `needs-attention`:

| Runtime | Workflow | User-visible meaning | Allowed action |
| --- | --- | --- | --- |
| active | progressing | working | observe |
| active | checkpoint-overdue | working without checkpoint | observe; optional cost/advisory |
| active | stalled | working but workflow-stalled | advisory; no reset |
| quiet | progressing | quiet after progress | observe |
| quiet | checkpoint-overdue/stalled | diagnostic suggested | read-only diagnosis/probe |
| unobservable | any | observation degraded | restore observer or exact probe; no replacement from degradation alone |
| terminal | any | execution ended | reconcile, then evaluate recovery admission |

An Agent that is still running and producing non-duplicate Provider activity is
normal, even if it has not emitted a Yui checkpoint. Yui must not interrupt it
to ask whether it is alive.

### 2.4 Time windows change observation, not ownership

Default windows form one observation cadence per accepted, non-terminal Run;
they are operational policy, not death thresholds:

- after 5 minutes without authoritative runtime activity, display `quiet`;
- after 15 minutes without workflow progress, display
  `checkpoint-overdue`/diagnostic information, without Operator wake or reset;
- 30 minutes after the Run's accepted/creation boundary or the preceding
  diagnostic finish, schedule one coalesced read-only exact probe;
- after the first 30-minute point, use 30 minutes as the primary diagnostic
  cadence while the Run remains accepted and non-terminal. Never run more than
  one diagnostic for that Run at a time;
- after any elapsed duration, absent terminal or exact-missing evidence, keep
  ownership and the Conversation unchanged.

The next 30-minute diagnostic eligibility is derived from the latest of the
Run's accepted/creation boundary, its latest durable workflow progress, and its
last durable diagnostic finish time. Runtime activity still determines the
diagnostic result and the 5-minute display layer, but it does not masquerade as
workflow progress or cause a busy runtime to be interrupted.
A diagnostic finish fact records the Run identity, finish time, and `observed`
or `observation-error` outcome. Existing full-reconciliation serialization
coalesces concurrent attempts. If the Controller fails
after the read-only probe but before recording its finish, the same due probe
may run once more after restart; this bounded duplicate observation is safe and
does not justify a lease, a second scheduler, or any lifecycle mutation.
The finish fact uses the existing runtime-observation/Task-event persistence
path; no mutable diagnostic aggregate or new configuration field is introduced.

The cadence resets in three explicit ways:

- fresh authoritative runtime activity restarts the runtime-idle clock, and
  fresh workflow progress restarts the workflow-progress clock;
- after a diagnostic finishes, whether successfully or with an observation
  error, the next diagnostic is not eligible until 30 minutes later. A failed
  diagnostic therefore cannot create a hot retry loop;
- when the Run completes normally or folds an exact terminal error, cancel its
  cadence. A later Run starts a fresh 5/15/30 sequence.

The existing `runtimeHealth` configuration remains the single configuration
surface: `quietAfterSeconds`, `diagnosticAfterSeconds`, and
`stallAfterSeconds` default to 300, 900, and 1800. The third value is the
workflow-stall horizon and the subsequent read-only diagnostic cadence; it is
not a replacement threshold. Homes with explicit values retain them, so the
default change from 600 to 900 seconds requires no configuration shape or data
migration. Increasing all windows would only delay diagnosis; it would not make
a reset correct.

### 2.5 Loop evidence is advisory

Exact duplicate event replay must be deduplicated and must not count as fresh
activity. A bounded exact cycle such as the same tool name, normalized input,
and outcome repeated without new durable or repository evidence may be reported
as a suspected loop.

Fuzzy text similarity, token consumption, or repeated reasoning phrases are not
safe lifecycle evidence. Suspected loops may trigger an Operator-visible
advisory or cost limit owned by an explicit policy, but they do not call generic
Session reset. A separately authorized interruption follows the exact interrupt
protocol described below.

## 3. Recovery authorization

### 3.1 Recovery and Conversation switching are separate admissions

Every automated recovery path and the existing exact
`yui task run recover <task>/<run>` actions for diagnosis or retry call a
shared Run-recovery admission. That decision may observe, settle, or resume the
current execution; it cannot forget or create a Conversation.

The existing `task role reset` contract is retired rather than routed through a
new gate while retaining its destructive meaning. It must be removed from the
command catalog, next-action recommendations, and Operator/Leader Skills in the
same change. It is not kept as an alias: the word `reset` conflates Run recovery,
interruption, cleanup, and Conversation switching, which this design separates.
For the same reason, `task run recover --action replace-session` is removed;
callers that intentionally want a different Conversation use the independent
`task role session switch` command. Its `terminate` action remains available
only when recovery admission proves an exact terminal/broken Run; stopping an
accepted active execution follows the interrupt protocol in section 3.6 rather
than implying replacement.

Creation of a replacement Conversation is owned by a separate switch decision:

```ts
type RunRecoveryDecision =
  | { allowed: true; action: "observe" | "settle-current" | "resume-current"; evidence: EvidenceRef[] }
  | { allowed: false; blockers: RecoveryBlocker[]; nextDiagnostic?: DiagnosticAction };

type ConversationSwitchBasis =
  | {
      kind: "automatic";
      rule: "current-conversation-unrecoverable";
      evidence: EvidenceRef[];
    }
  | {
      kind: "actor-request";
      actor: "user" | "operator" | "leader";
      requestRef: TaskRecordRef;
      note: string;
    };

type ConversationSwitchDecision =
  | { action: "keep-current"; reason: "conversation-recoverable" }
  | { action: "defer"; blockers: ConversationSwitchBlocker[] }
  | {
      action: "switch";
      basis: ConversationSwitchBasis;
      safetyEvidence: EvidenceRef[];
      readyWork: EvidenceRef[];
    };
```

Both decisions evaluate current durable state under the same Task/Role
serialization used for launch admission. For an actor request, authenticated
User/Operator/Leader identity and the exact request record provide authorization;
the free-text note provides audit context and is never parsed as policy. Only
the `switch` result may reach code that opens a new Provider Conversation.

This is an architectural seam, not a natural-language policy engine. The
automatic path currently has one rule only. User/Operator/Leader judgment uses the
explicit actor-request path. A future automatic rule must be added explicitly
with its own evidence and verification; ordinary recovery, elapsed time, or a
free-text note cannot fall through to Session creation.

Implementation keeps the pure switch evaluator in a dedicated domain module
and routes its `switch` result to one switch executor. Scheduler, recovery,
review, and launch code may request an evaluation, but none of them may open a
replacement Conversation directly. No pluggable registry or persistent policy
configuration is introduced now.

### 3.2 Run-recovery and switch blockers

Destructive Run recovery is rejected while any of these is true:

- the active Run has an accepted, non-terminal Turn;
- a Turn is `submitting` or `delivery-unknown`;
- an operation, continuation, or Activation is authoritatively active;
- claimed mailbox input has not been settled or safely requeued;
- current execution authority is not `none`;
- the only evidence is timeout, checkpoint age, transcript silence, pane/socket
  loss, projection loss, token behavior, or observer degradation.

Conversation switching has all of those blockers. The automatic path
additionally requires the exact Provider probe to report `missing` and no
active Activation. An explicit actor request may supersede an existing but idle
Conversation by revoking its exact settled Activation in the serialized switch
protocol; it still cannot bypass unsettled work or ambiguous writer ownership.
An unknown delivery or writer boundary always defers the decision.

Retiring `task role reset` closes the current gap where it can terminalize an
accepted active Run and forget the native Session after validating only
Task/Role identity and a reason.

### 3.3 Allowed Run-recovery cases

The exact Provider-native probe has three results:

| Probe result | Meaning | Allowed lifecycle decision |
| --- | --- | --- |
| `exists` | the exact native Conversation ID still exists | observe an active Turn, or resume the same Conversation after obligations settle |
| `missing` | the Provider authoritatively says that exact Conversation ID does not exist | hand exact evidence to the independent switch decision |
| `unknown` | timeout, transport failure, unavailable Host, or insufficient Provider evidence prevents an exact answer | preserve the Conversation identity and retry only a bounded read-only diagnosis |

Local process exit, tmux/socket loss, missing transcript updates, an observer
failure, or elapsed time cannot synthesize `missing`. `unknown` is never treated
as `missing`.

Recovery is admitted only in one of these bounded cases:

1. **Failed before acceptance**: no accepted or unsettled Turn, no active
   operation/Activation/authority, and claimed work can be deterministically
   requeued. The Conversation may be reused if the exact probe says `exists`.
2. **Exact terminal/broken execution**: terminal evidence is folded, every Turn
   is settled, and authority is `none`. Run recovery may resume the original
   Conversation when the exact Provider result permits it.
3. **Exact Conversation missing**: reconcile the old Run and hand the evidence
   to the independent Conversation-switch decision. Run recovery itself does
   not create the replacement.

### 3.4 Independent Conversation-switch decision

The default policy is intentionally narrow: keep using the original
Conversation unless the Provider proves that it cannot be recovered. Under the
current Provider contract, exact `missing` is the only proof of that condition.

Before returning `switch`, Yui rechecks under Task/Role serialization that:

1. the probe targets the current Role generation's exact Provider and native
   Conversation ID, and is newer than the last relevant Activation change;
2. every Activation, operation, and continuation for that Conversation is
   terminal;
3. no Turn is `submitting`, `delivery-unknown`, accepted-and-running, or
   otherwise unsettled;
4. every claimed mailbox input is settled or deterministically requeued;
5. durable writer authority is `none`; and
6. exact pending work is ready to own the replacement Conversation.

If any check fails, replacement is denied even though the probe returned
`missing`. This prevents Yui from replaying an input whose delivery outcome is
still ambiguous or from creating a second writer while the old owner is not
settled.

When every check passes, the switch executor enters one serialized replacement
launch protocol:

1. under Task/Role serialization, revalidate the switch decision, reserve the
   ready work, and admit the new Run, initial delivery intent, and launch
   receipt; the old Conversation remains current;
2. for an explicit request whose persistent old Provider process is idle, the
   Controller first revokes and terminals that exact Activation, then the Host
   performs bounded process detachment; the Conversation identity remains
   current and no Provider Turn is written during detachment;
3. the Host creates the replacement Conversation/Activation without writing a
   Provider Turn;
   the replacement Provider process receives a fresh Task caller key, whose
   durable hash is committed once that process dispatch is observed even when
   the persistent Agent Host itself was reused. An ordinary resume of the same
   live Provider process retains its inherited key;
4. the Controller transaction revalidates the same launch receipt and Role
   generation, then atomically marks the old Conversation superseded and binds
   the replacement as the one current Conversation; and
5. the Host follows the normal durable Turn-begin handshake before writing the
   admitted input.

This is a two-phase external protocol, not one database transaction. Yui does
not intentionally open a replacement without ready work. If the Host creates a
Provider resource and fails before the binding transaction, the old
Conversation stays current and the new launch-scoped resource is a verified
cleanup obligation; it has no admitted Provider Turn. If binding succeeds but
delivery does not, the durable initial delivery intent and exact launch receipt
drive idempotent recovery. Neither case authorizes replay of a
`delivery-unknown` Turn.

If no work is ready, the evaluator returns `defer` with `no-ready-work`. It does
not supersede the current Conversation merely to record that a later switch is
permitted. The automatic path probes again when later work becomes ready; an
actor request remains pending as described below.

For the automatic path, `exists` returns `keep-current`. `unknown`, or any
unsettled obligation, returns `defer`. Neither result may create a new
Conversation.

### 3.5 Explicit User/Operator/Leader switch requests

User, Operator, or Leader judgment is expressed through an explicit CLI command:

```sh
yui task role session switch <task> <role> --reason "<why a fresh Session is preferable>"
```

The command resolves authority from the managed caller environment:

- a user invoking the CLI may request a switch for a Role in an active Task;
- the global Operator may request a switch for any Role in an active Task;
- the matching Task Leader may request a switch for a Role in its own Task,
  including the Leader Role itself, using the exact current-Turn assertion; and
- Reviewer, Worker, another Task's Leader, and incomplete managed identities
  are rejected.

`--reason` is required, normalized, bounded, and stored for audit. The command
does not parse it to decide whether the reason is good enough. The authenticated
actor made that semantic decision by invoking the command.

The command transaction writes one structured
`conversation-switch-requested` Task Event containing the request identity,
target Role generation, authenticated actor, normalized reason, and request
time. That Event is the authority for the request. The command invokes targeted
Task reconciliation, and later relevant durable state changes cause the normal
Controller reconciliation path to evaluate the unresolved Event again. The
runtime lifecycle mailbox is not a switch-request state machine and gains no
new reason for this feature.

Only one unresolved request is effective for a Role generation. Repeating the
same actor and normalized reason is an idempotent replay. A changed actor or
reason first resolves the previous request as `obsolete`, then records the new
audited request. A terminal `conversation-switch-resolved` Event refers to the
exact request and records either `applied` with the replacement Conversation
evidence or `obsolete`. Pending, applied, and obsolete status is derived from
those Events and is visible through `task role status`; no mutable
request-status aggregate is added.

An actor request never interrupts an accepted Turn:

- while the target Run, Turn, operation, Activation, mailbox claim, or writer
  authority is unsettled, the request remains pending;
- when the target reaches a settled boundary and new work is ready, the switch
  evaluator revalidates the exact bound generation and Provider state;
- `exists` with no active Provider Turn may switch because the actor explicitly
  chose to supersede the recoverable Conversation;
- `missing` may switch after the same safety checks; and
- a Provider-existence probe may be unknown if the exact idle Activation and
  writer boundary are still provable and can be revoked; an unknown delivery
  or writer boundary remains deferred.

If the bound generation changes before application, the request becomes
obsolete and cannot switch the newer generation. If no work is ready at a safe
boundary, the request remains pending and the old Conversation remains current.
When work later becomes ready, application uses the serialized replacement
launch protocol above. The old Conversation becomes superseded and the request
becomes `applied` only in the successful replacement-binding transaction. The
actor reason is available to that Run as a durable context reference, not as
machine policy.

This path supports natural-language User/Operator/Leader judgment without building a
natural-language rule interpreter. Automatically evaluating stored prose such
as “switch when context quality degrades” is outside the current contract; an
User, Operator, or Leader may evaluate that condition and issue the explicit command.

### 3.6 User-authorized interruption is not reset

When a user explicitly chooses to stop active work, Yui uses an exact sequence:

1. record the interrupt intent and target Run/Activation;
2. send the Provider-native interrupt to that exact target;
3. observe or reconcile its terminal outcome;
4. settle Turns, operations, claims, and authority; and
5. admit any later resume as a new Run plus initial delivery intent, followed
   by the normal Host bind and durable Turn-begin handshake.

There is no generic reset or automation-friendly `--force` path that skips
these obligations. Exceptional manual repair of anomalous state is a separate,
explicit maintenance operation with bounded diagnostics.

## 4. Review and mailbox interaction

This runtime document is authoritative for the transport boundary used by
[Review Completion and Result Batching](review-completeness-and-convergence.md):

1. Review completion writes durable ReviewRound and mailbox references only.
2. It never pre-creates a future Leader Run or a new Leader Conversation.
3. An active Leader is not interrupted or steered merely because review
   completed.
4. At a natural boundary, pending review work is delivered as a Turn in the
   same Conversation.
5. If a Run boundary is needed, the new Run and initial delivery intent are
   admitted atomically; the Host begins the Turn only after binding.
6. A ReviewRound change is not evidence that either Leader or Reviewer native
   Session should be replaced.

## 5. Diagnostics and observability

Every launch, health projection, and rejected recovery should be explainable
without reading raw transcripts.

### Required launch evidence

- Task, Role, Run, Conversation, Activation, and Turn identities;
- launch kind (`new`, `resume`, or `ensure`);
- reserved durable work references and, after Turn-begin, their input-delivery
  claim;
- initial delivery attempt and launch receipt identities;
- Turn delivery state and exact Provider receipt when available;
- whether the launch is waiting on Host acceptance, Provider acceptance, or
  reconciliation.

### Required health evidence

- last authoritative runtime-activity kind and time;
- last workflow-progress kind and time;
- observer quality (`healthy`, `degraded`, `unavailable`);
- active operation/continuation identities;
- exact probe result and its freshness;
- derived runtime, workflow, and user-visible states.

### Required recovery and switch evidence

- requested recovery mode and initiator;
- Run-recovery admission decision;
- independent Conversation-switch decision and basis, if any;
- actor, bound Role generation, and natural-language note for an explicit
  switch request;
- every blocking unsettled fact, by identity;
- exact terminal or missing evidence when allowed;
- whether claims were settled or requeued;
- reused or replacement Conversation identity.

Metrics may count quiet Runs, checkpoint-overdue Runs, probe outcomes, rejected
recoveries or switches, and exact replacements. They must not collapse those
into a single “stuck Session” counter.

## 6. Failure handling matrix

| Failure | Correct behavior |
| --- | --- |
| Controller crashes before admission commit | no Run, initial delivery intent, or reservation exists; work remains ready |
| Controller crashes after commit, before Host call | replay the same launch receipt and initial delivery intent |
| Host starts Conversation, then loses response | reconcile the launch receipt, bound identities, and Turn-begin state; do not create another Run |
| Provider acceptance boundary is uncertain | keep `delivery-unknown`; do not replay |
| Observer stops while Provider may run | mark `unobservable`; restore observation or exact-probe |
| tmux pane/socket disappears | treat as local presentation/transport evidence, not Session missing |
| no checkpoint across the 5/15/30-minute cadence while runtime activity continues | show quiet/overdue advisory; preserve execution |
| no visible activity and probe is `unknown` | preserve execution; retry bounded read-only diagnosis |
| exact probe is `missing` but Turn is unsettled | do not replace; reconcile unsettled delivery first |
| exact probe is `missing`, no unsettled work/authority | hand off to the independent switch decision; only `switch` may create the Conversation |
| User/Operator/Leader requests a switch while the target runs | persist the exact-generation Event; do not interrupt; apply only when a settled boundary and ready work coincide |
| actor-requested switch sees an idle `exists` Conversation but no ready work | keep the request pending and the old Conversation current |
| actor-requested switch sees an idle `exists` Conversation with ready work | switch and replacement launch may proceed after safety revalidation |
| replacement Host fails before binding its new Conversation | keep the old Conversation current; retain the same launch intent and verify cleanup of any launch-scoped Provider resource |
| replacement binding succeeds but initial delivery does not settle | preserve the new current Conversation and exact initial delivery state; recover idempotently without reopening another Conversation |
| actor-requested switch has an unknown delivery/writer boundary | keep the request pending; do not switch |
| target generation changes before a pending actor request applies | mark that request obsolete; never apply it to the newer generation |
| review finishes while Leader runs | queue durable result; deliver at natural Turn boundary |

## 7. Implementation plan

Implementation should proceed in this order so every later mutation is guarded
by a stronger earlier contract.

### Phase 1: encode launch invariants

- Replace optional managed initial-delivery fields with the tagged launch union.
- Centralize new/resume admission so the Run intent, exact mailbox claim, and
  launch reservation form one serialized, idempotent pre-Host sequence.
- Preserve the existing Host bind -> durable Turn-begin -> Provider write
  handshake; do not pre-create a `submitting` Turn before binding.
- Reject or diagnose any newly encountered active Run without an initial
  delivery intent.
- Preserve exact delivery outcomes and idempotent Host replay.

Expected primary areas are launch planning, Run/Turn repositories, Host request
types, and launch-result folding. No historical auto-repair path is added.

### Phase 2: separate health projections

- Make runtime-liveness and workflow-progress projections explicit.
- Rename user states so `diagnostic-needed` is not rendered as generic
  execution attention.
- Change the omitted-config defaults to 5/15/30 minutes while retaining explicit
  configured values.
- Coalesce time-based diagnostics by Run, record finish/error evidence, and
  ensure they are read-only.
- Keep token/resource evidence out of lifecycle decisions.

Expected primary areas are runtime projection, stall classification,
next-action rendering, and observability metrics.

### Phase 3: guard all recovery entry points

- Add the shared Run-recovery admission function.
- Route scheduler recovery and exact `task run recover` diagnosis/retry through
  it.
- Remove `task role reset` and the `task run recover --action replace-session`
  action, then update every next-action and Skill reference in the same change.
- Add exact blockers for accepted/unsettled/live/owned execution.
- Add the independent Conversation-switch decision and make it the only path to
  replacement Session creation.
- Implement the default automatic `current-conversation-unrecoverable` basis.
- Add `task role session switch ... --reason ...` for user, authenticated
  Operator, and matching Task Leader requests, using structured
  request/resolution Task Events as authority and normal targeted
  reconciliation for reevaluation.
- Apply a switch only with ready work in the serialized replacement launch;
  keep requests pending without superseding the current Conversation otherwise.
- Expose pending/applied/obsolete switch evidence through Role status and teach
  Operator/Leader Skills the command boundary.
- Separate user interruption from Run recovery and Conversation switching.

### Phase 4: integrate review delivery

- Ensure review results enqueue durable references without future-Run creation.
- Deliver them through the same Run/initial-delivery admission and two-phase
  Host Turn handshake when a Run boundary is required.
- Verify Leader and Reviewer Conversation continuity across repair rounds.

## 8. Verification strategy

Verification follows [Yui's verification policy](testing/verification-levels.md).
No real Provider or shared Home is required for this implementation.

Temporary deterministic evidence should cover:

- type/constructor rejection of new/resume without an initial delivery;
- transaction failure at each admission boundary, proving no partial
  Run/reservation;
- Host binding preceding durable `submitting` Turn creation for both new and
  resume launches;
- Controller/Host retry using the same Turn identity;
- `delivery-unknown` never replaying automatically;
- accepted Runs with continuous activity surviving every time window;
- accepted quiet Runs receiving diagnostics but no reset;
- token, pane, socket, and transcript evidence never authorizing replacement;
- recovery and switch rejection for accepted, unsettled, active-operation,
  active-authority, `exists`, and `unknown` cases as applicable;
- absence of `task role reset` and `task run recover --action replace-session`
  from commands, next-action, and Skills;
- Run recovery being unable to create a replacement Conversation;
- the independent switch decision returning `keep-current` for `exists`,
  `defer` for `unknown` or unsettled obligations, and `switch` only for exact
  `missing` with clean obligations and ready work on the automatic path;
- User, Operator, and matching Task Leader authorization for the explicit CLI,
  with Reviewer/Worker/cross-Task/incomplete identities rejected;
- required natural-language reason persistence without parsing it as policy;
- active actor requests deferring without interruption, then applying at the
  next settled boundary that also has ready work;
- actor-requested switching only at an exact idle writer boundary, unknown
  delivery/writer evidence deferring, and a generation change making the
  request obsolete;
- a replacement Conversation inside a reused Agent Host committing its fresh
  Task caller key, while same-Conversation resume does not rotate the live
  process's key;
- an idle request with no work remaining pending without superseding the current
  Conversation or creating an empty Provider Session;
- review completion during active Leader work creating no future Run;
- review delivery at the next boundary reusing the Conversation.

Only a missing seconds-scale primary contract should become permanent core
smoke. Fault-injection matrices and task-58-shaped historical fixtures are
temporary change evidence and are removed after the implementation converges.

## Acceptance criteria

The design is implemented when all of the following are true:

- No managed new/resume Host request can be constructed without an initial
  delivery.
- No committed active managed Run exists without its initial delivery intent.
- No Provider Turn becomes `submitting` before the Host binds its exact
  Conversation and Activation.
- Retrying launch cannot create a second Run or deliver a second Turn.
- Accepted Provider work is never reset solely because a time window elapsed.
- Runtime activity and workflow progress are independently visible.
- Token/resource/transcript/tmux evidence is read-only for lifecycle purposes.
- All normal Run-recovery paths reject accepted, unsettled, or active
  execution and cannot create a replacement Conversation.
- Neither `task role reset` nor `task run recover --action replace-session`
  exists as a destructive recovery or replacement bypass.
- Only the independent Conversation-switch path can create a replacement. Its
  automatic default requires exact `missing` plus no unsettled obligation or
  owner and exact ready work for the replacement launch.
- A user, authenticated Operator, or matching Task Leader can request a switch
  with a durable reason; it is generation-bound, never interrupts active work,
  and cannot bypass an `unknown` Provider boundary or unsettled obligations.
- A switch request without ready work leaves the current Conversation current;
  actual supersession occurs only inside the replacement-binding transaction.
- A switched Provider process can use the protected Task context API even when
  its persistent Agent Host was reused.
- Review delivery cannot pre-create Leader Runs or replace a live Conversation.
- Diagnostics explain both a recovery decision and every reason it was denied.
