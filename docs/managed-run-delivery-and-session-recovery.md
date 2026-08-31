# Managed Run Delivery and Session Recovery

Status: implemented contract

## Product decision

Yui preserves durable intent and exposes runtime facts; the responsible Agent
chooses recovery. Core does not own a Provider retry policy, replacement
counter, backoff episode, or recovery state machine.

Each question has one authority:

- Task, WorkItem, Message, Decision, result, Project Knowledge, and managed
  workspace records own durable progress.
- AgentRun owns Role scheduling and the current delivery intent.
- Session owns one stable provider-native conversation identity. Its only
  durable lifecycle is `active` or `ended`; `endReason` distinguishes an
  explicit stop from failure.
- Host owns one disposable Yui attachment/process activation for a Role and
  workspace. It is identified by `launchId`, not by AgentRun.
- Turn owns one immutable provider input attempt and its accepted, running,
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

A Host reservation protects only physical Host startup for a Role owner. It
settles as soon as the Host and Session are known. It never belongs to a Run and
never remains held while a Turn executes. Therefore a later Run may reuse the
same live Host and Session. If that Host has stopped, restoring the same Session
creates a new Host activation while retaining the native Session id.

The persisted Run and Turn fences still prevent duplicate input. A
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
| An accepted Turn fails with availability, `429`, capacity, or a recoverable transport error; Session remains usable | Keep Run and Session, restore the same native id if necessary, and submit a new Turn |
| A known Host process is gone; Session remains recoverable | Detach the dead Host before claiming pending work, start one new Host activation, and restore the same native Session id |
| Session preparation otherwise fails, or the Driver rejects input before acceptance | The exact Run fails once; inspect the error, then explicitly retry the failed Run if another attempt is useful |
| Another native Turn is active | Observe or wait; retain pending delivery |
| Input delivery is unknown | Inspect native history; do not blindly replay |
| Driver proves Session missing, ended, expired, or unusable | Settle the exact Run, stop that Role Session/Host, then create the next Run on a new Session |
| Error is unclassified | Read the complete raw error and current facts, then choose explicitly |

The read and stop primitives are:

```sh
yui task event show <task> <agent-error-event>
yui task role session inspect <task> <role>
yui task role session stop <task> <role> --reason "<decision>"
```

Core never redelivers an input that was not accepted merely because a periodic
scheduler pass runs again. A Session preparation failure or explicit Turn
rejection terminalizes the exact Run and routes the error to the responsible
Agent. For a continuation on an already accepted Run, the exact unaccepted
error fact itself fences further scheduler attempts for that Run. This makes
recovery a visible Agent action instead of an implicit launch loop, without a
second writable recovery status. A `delivery-unknown` Run remains fenced until
native history resolves whether the provider accepted it.

An idle `session stop` terminates only the exact Role Host activation and marks
that Session ended. It requires the Agent to settle or retire an active Run
first. The next explicit Run dispatch then starts a new Session. Its Context
Pack includes the prior error event, so the receiving Agent can see the old
Agent/adapter, Run, Host activation, native Session and Turn identities, and
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
