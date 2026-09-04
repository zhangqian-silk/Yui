# Managed Turn and Session Runtime

Status: implemented contract

## Product decision

Yui preserves durable intent and exposes runtime facts; the responsible Agent
chooses recovery. Core does not own a Provider retry policy, replacement
counter, backoff episode, or recovery state machine.

Each question has one authority:

- Task, WorkItem, Message, Decision, result, Project Knowledge, and managed
  workspace records own durable progress.
- Turn owns one Provider execution boundary: every Provider-visible input and
  the final visible output. It does not copy hidden reasoning or tool traffic.
- Session owns one stable provider-native conversation identity. Its only
  durable lifecycle is `active` or `ended`; `endReason` distinguishes an
  explicit stop from failure.
- Host owns one disposable Yui attachment/process activation for a Role and
  workspace. It is identified by `runtimeGenerationId`, not by Turn.
- Provider Runtime Binding owns one immutable provider input attempt and its accepted, running,
  waiting, completed, failed, cancelled, or uncertain result.

Readiness and busy state are Host/Turn observations. They are not additional
writable Session statuses.

## Execution path

The normal path consists of independent operations:

```text
read facts
  -> start or restore the exact Session
  -> submit one new Turn
  -> observe the exact native Turn receipt and terminal result
```

Starting or restoring a Session never sends input. Submitting a Turn never
creates or silently replaces a Session. A terminal Turn is immutable; any
continuation is another Turn.

The Session is reusable across both Yui-dispatched and direct conversation.
Every input submitted through Yui has `source.type = yui`; its channel records
whether it came from a relayed user message, input response, Task/WorkItem
dispatch, ordinary Leader wake, or forced Leader wake. Input entered directly
in the Provider UI is `user/direct`. Provider-created Goal continuation is
`provider/goal-continuation`. These fields are provenance only: none of them
decides Task or WorkItem completion.

A Turn stores `inputs[]` because a running Provider Turn may receive a forced
Leader wake as a later input. Its terminal `result` stores the Provider's final
visible response unchanged and exact native identity. Missing, empty, invalid,
or oversized response text does not strand the Turn: Yui records the Provider
terminal boundary and fails the Turn as `missing-result` with a bounded
Core-owned diagnostic. Direct Provider Turns are recorded in the same history.
They do not claim a managed execution lane merely because they share the
Session.

## Task truth and Leader responsibility

Worker and Reviewer Turns produce evidence and, where applicable, update their
managed worktree. Their terminal output is stored automatically. A replicated
Producer Turn is non-authoritative evidence for its later main WorkItem or
Reviewer synthesis Turn. Producer terminal never creates a Candidate, Review
result, or acceptance decision, and Turn terminal alone never means that
the WorkItem, Review, or Task is accepted or complete.

The Leader is the only semantic authority that integrates accepted code and
updates WorkItem or Task truth. This also covers Leader-owned execution: the
Leader may perform the work itself in the Task worktree and update the durable
facts before ending its own Turn. A Leader Turn does not self-wake when it ends.

Terminal Worker/Reviewer Turns and other material non-Leader events enter the
Leader wake batch. The first event opens a one-minute aggregation window; new
events join the same window without resetting it. If the Leader is still in an
active Turn after that minute, the batch waits. At ten minutes from the first
event, Yui steers one forced input into that exact active Leader Turn. The input
lists the aggregate, states that it waited ten minutes, includes up to four
exact result-Turn read commands, points to the Wake record for any remainder,
and instructs the Leader to handle the events before resuming its interrupted
work.

Native child continuation reports follow the same ownership boundary. While
their parent Yui Turn is active, `continuation.reported` and
`continuation.settled` are persisted without waking a supervisor because the
parent still owns the result. If the parent Turn is already terminal or absent,
the result is routed once from the original Role to its supervisor and then
uses the ordinary Leader/Operator mailbox aggregation window. A Reviewer
result still completes through the normal Review terminal path rather than a
parallel continuation-specific review path.

## Session Goal

Goal is explicit Session-scoped Provider state and may span multiple Turns. It
is never inferred from a quiet period. Codex exposes the thread Goal API and
Goal notifications; Claude exposes `active_goal`. While a non-Leader Session
Goal is active, an individual Turn terminal is recorded but does not yet wake
the Leader because the Session-level intent is still running. Goal completion,
pause, block, limit, or clear emits the material event that wakes the Leader.
The Leader still decides whether durable Task or WorkItem facts change.

No `yield` command participates in this contract. Agent-to-Agent delivery is
the stored Turn result plus durable wake/event references; the absence of a
special command cannot redefine whether the Provider Turn ended.

A Host reservation protects only physical Host startup for a Role owner. It
settles as soon as the Host and Session are known. It never belongs to a Turn and
never remains held while a Turn executes. Therefore a later Turn may reuse the
same live Host and Session. If that Host has stopped, restoring the same Session
creates a new Host activation while retaining the native Session id.

`runtimeGenerationId` identifies that exact Host activation/rebind generation.
It is neither a native Session/conversation id nor a Yui or provider Turn id.
Several Turns—including Turns entered directly by the user in the provider
UI—may run in the same runtime generation. A direct user message changes Turn
history, not the runtime generation. Yui changes the generation only when it
establishes a new Host activation boundary; restoring a still-running exact
Host retains its current generation.

Before sending any input through a reused Agent Host, Yui requires the Host to
acknowledge the requested `runtimeGenerationId` and an admissible Host state.
An acknowledgement for another generation, or an otherwise invalid
acknowledgement, is a poisoned activation boundary: Yui sends no input, stops
the exact Role Host when possible, and otherwise leaves a durable owner-cleanup
obligation. It never treats that Host as ready or reusable.

The stable attempt id and Provider Turn fence prevent duplicate input. A
`delivery-unknown` input is not replayed automatically because it may already
exist at the provider. A provider-proven `busy` result is safe to try later
because the requested Turn was not created.

## Standard Agent errors

Every Agent-facing failure becomes one `runtime.agent-error` fact with:

- source and phase;
- provider-neutral category and stable code;
- whether the input was accepted;
- whether the Session is recoverable;
- human-readable message and optional retry-after hint; and
- the complete serialized original exception or provider payload.

Categories are `availability`, `rate-limit`, `transport`, `access`,
`invalid-request`, `context`, `session`, `runtime`, `conflict`, `cancelled`,
and the required fallback `unknown`.

Codex, Claude, and future Drivers recognize their own native failures at the
edge. Core persists and routes the resulting facts; it does not turn a category
into a mandatory action.

## Agent-directed recovery

The ordinary choices are deliberately small:

| Facts | Useful Agent action |
| --- | --- |
| An accepted Turn fails with availability, `429`, capacity, or a recoverable transport error; Session remains usable | Keep the Session, restore the same native id if necessary, and submit a new Turn |
| A known Host process is gone; Session remains recoverable | Detach the dead Host before claiming pending work, start one new Host activation, and restore the same native Session id |
| Session preparation otherwise fails, or the Driver rejects input before acceptance | The exact Turn fails once; inspect the error, then explicitly retry the failed Turn if another attempt is useful |
| Another native Turn is active | Observe or wait; retain pending delivery |
| Input delivery is unknown | Inspect native history; do not blindly replay |
| Driver proves Session missing, ended, expired, or unusable | Settle the exact Turn, stop that Role Session/Host, then create the next Turn on a new Session |
| Error is unclassified | Read the complete raw error and current facts, then choose explicitly |

The read and stop primitives are:

```sh
yui task event show <task> <agent-error-event>
yui task role session inspect <task> <role>
yui task role session stop <task> <role> --reason "<decision>"
```

Core never redelivers an input that was not accepted merely because a periodic
scheduler pass runs again. A Session preparation failure or explicit Turn
rejection terminalizes the exact Turn and routes the error to the responsible
Agent. For a continuation on an already accepted Turn, the exact unaccepted
error fact itself fences further scheduler attempts for that Turn. This makes
recovery a visible Agent action instead of an implicit launch loop, without a
second writable recovery status. A `delivery-unknown` Turn remains fenced until
native history resolves whether the provider accepted it.

An idle `session stop` terminates only the exact Role Host activation and marks
that Session ended. It requires the Agent to settle or retire an active Turn
first. The next explicit Turn dispatch then starts a new Session. Its Context
Pack includes the prior error event, so the receiving Agent can see the old
Agent/adapter, Turn, Host activation, native Session and Provider Turn identities, and
complete raw failure without transcript reconstruction.

There is no fixed number of allowed replacements. Leader or Operator reads the
recent error history and decides whether another fresh Session has positive
value. Repeated fresh-Session failures should be summarized to the user with
the observed evidence and bounded options, not hidden behind an automatic
replacement loop.

## Task completion and fallback

Task completion remains semantic. Runtime identities are retained as audit
evidence and physical resources are cleaned independently.

The global operational fallback is still:

```sh
yui task execution stop <task> --force --reason <text>
yui task execution start <task>
```

This fences the whole Task and is appropriate only when Role-local atomic
recovery cannot establish a trustworthy physical owner. It preserves durable
Task progress and does not attempt to repair or replay a provider transcript.
