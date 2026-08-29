# Managed Provider Runtime

Yui uses one hybrid runtime for every managed Task Agent. Structured Provider
protocols own control and acknowledgement; tmux and PTY own presentation,
inspection, and explicit human takeover. Terminal bytes are never a managed
control protocol.

This is a breaking runtime boundary. Pre-v6 managed processes are retained as
audit records but invalidated during migration. They are not treated as live
structured Agent Hosts.

## Components

| Component | Responsibility | Must not do |
| --- | --- | --- |
| Controller | Durable scheduling, single-writer CAS, Turn intent and observation folding | Infer Provider acceptance from a pane or transcript |
| Agent Host | Persistent Task Role process, Provider child ownership, fenced structured requests, PTY presentation gateway | Invent or repair durable identity |
| Provider Adapter | Provider-native start/resume/submit/interrupt/probe operations | Read Yui storage or decide recovery policy |
| tmux/PTY | Keep the Agent Host alive, display output, accept human input after takeover | Deliver Controller prompts or prove a Turn was accepted |

The managed data path is:

```text
Mailbox claim + durable Turn(submitting)
               |
               v
Controller -- authority fence --> Agent Host -- structured request --> Provider
               ^                                            |
               |________ exact Provider acknowledgement _____|
                         durable Turn(accepted)
```

The Provider process has piped stdin/stdout/stderr and its own process group.
The Agent Host mirrors output onto its PTY for observation. A human input line
entered after takeover is converted by the Host into the same structured Turn
request used by the Controller.

## Durable identities

The runtime keeps four identities separate:

| Identity | Meaning | Lifetime |
| --- | --- | --- |
| `Run` | One Yui execution contract and audit trail | Until the execution reaches a terminal result |
| `Conversation` | Provider-native resumable thread/session | Can survive many processes and Runs |
| `Activation` | One live Provider process attached to a Conversation | From process start until exit/failure |
| `Turn` | One attempted user input and its Provider execution | From pre-write intent through exact terminal observation |

A `ProviderRuntimeBinding` also stores one authority record:

```text
authority = { epoch, owner: controller|human|none|unknown, holderId? }
```

Every mutation carries the exact epoch, owner, and holder. The Controller
changes authority with durable compare-and-swap. The Agent Host accepts an
idempotent replay or a strictly newer epoch and rejects stale epochs. It may
skip epochs when replaying durable state after a failed Host synchronization;
it may never move backwards.

## Turn delivery contract

Before a Provider write, Yui atomically claims mailbox delivery and records the
Turn as `submitting`. Continuations are fenced before their Host control call;
initial and human Turns use a two-phase Host handshake: open and bind the
Conversation/Activation, obtain the Controller's durable Turn-intent
acknowledgement, then perform the Provider write.

The result is classified as one of:

- `accepted`: the Provider returned an exact native Turn identity, or Claude
  replayed the exact submitted user message for the expected session.
- `rejected`: a definitive negative response before a Provider Turn existed.
- `delivery-unknown`: the write may have happened but no exact acknowledgement
  was observed.

`delivery-unknown` is never retried automatically. A late exact acknowledgement
may reconcile that same attempt to `accepted`; it does not create a second
attempt. Authority cannot transfer while a Turn is `submitting`, `accepted`,
`running`, or `delivery-unknown`.

The launch result carries exactly one initial-Turn outcome: accepted,
delivery-unknown, or rejected. Scheduler preparation preserves that outcome;
it never turns an ambiguous initial write into a launch failure or a second
submission.

## Provider transports

### Codex

Managed Codex uses `codex app-server --stdio` as a persistent JSON-RPC
transport. Yui initializes the server, starts or resumes a thread, reads exact
thread state, and calls `turn/start`. The Run prompt is not placed in argv and
is never injected into a TUI. A successful submission requires a native Turn
ID. A transport failure after `turn/start` is ambiguous and becomes
`delivery-unknown`.

### Claude Code

Managed Claude uses persistent `--input-format stream-json` and
`--output-format stream-json` with replayed user messages. Yui preallocates the
native session ID, writes one JSON user frame, and accepts the Turn only after
the process replays the same text for that session. A result frame settles the
Turn. Missing replay, timeout, process exit, or uncertain stdin completion is
`delivery-unknown`.

Future Providers implement the same control contract: exact Conversation
probe, fenced Turn submission, exact acceptance identity, terminal observation,
and interruption. A Provider-specific TUI is optional presentation, never the
machine-write path.

## View and takeover

Managed Task Roles expose three commands:

```sh
yui task role view <task> <role>
yui task role takeover <task> <role>
yui task role release <task> <role>
```

`view` attaches read-only to the Agent Host pane and never changes authority.

`takeover` performs a durable Controller-to-human authority CAS, synchronizes
that epoch to the Agent Host, and attaches read-write to the Host PTY. It
requires a live managed Run and a settled Turn boundary. The Provider itself
still receives structured input. Detach automatically releases authority.
`release` remains available without a live Run as an idempotent repair command
for a detached or partially synchronized takeover.

During a handoff, the durable fence and Host fence must both match before any
write. If synchronization fails, this can temporarily leave no valid writer,
but it cannot create two valid writers.

Global Operator and global Role sessions remain native interactive CLIs. Their
entry behavior is outside the managed Task Provider contract.

## Recovery

Provider recovery uses an exact tri-state Conversation probe:

| Probe | Unsettled Turn/input | Decision |
| --- | --- | --- |
| `exists`, active Turn | any | Observe that Turn; do not submit another |
| `exists`, no active Turn | no | Resume the Conversation |
| `exists` | yes/unknown delivery | Require attention; do not resend |
| `missing` | no, Activation ended, authority `none` | Replace with a new Conversation |
| `missing` | yes, or writer still owned | Require attention |
| `unknown` | any | Require attention; replacement is fenced |

Only an exact Provider-native missing response authorizes replacement. Process
death, a missing socket, a dead pane, timeout, transcript silence, or local
projection loss is not missing-Conversation evidence.

Replacement preserves the old Conversation and Activation history, marks the
old session broken, creates a higher Conversation epoch, and starts a new
Activation. It is forbidden while mailbox input or a Turn remains unsettled.

## Observation and crash safety

Structured observations are first appended to the runtime inbox, then applied
synchronously through the Controller. The inbox remains the replay source if
the direct fold is interrupted. Acceptance is durable before the Host reports a
ready Turn to its caller. Terminal observations settle the same native Turn ID
before the Host becomes idle.

Run launch generation and Provider Activation are independent fences. A live
Provider process keeps one Activation ID while the Host rebinds its Conversation
to later Runs. When that process exits, the Host closes that Activation against
the current Run fence; resuming the same Conversation creates a new Activation
and advances authority rather than reusing a process identity.

The Agent Host owns and terminates the exact detached Provider process group.
Provider exit is persisted through the Host outbox before reconciliation. The
Host remains the durable tmux pane owner so a later managed generation can
attach a replacement Provider without replacing the presentation surface.

## Storage cutover

Task Role Session Set schema v6 introduces the structured Provider authority
and Turn contract. The v5-to-v6 migration:

- preserves Tasks, Runs, Session identities, Conversations, and events;
- marks pre-v6 live managed sessions and Activations terminal;
- removes the old writer lease and records authority as `none`;
- resets current Conversation recoverability to `unknown`;
- does not reconnect an old TUI or pre-contract runtime as a structured Host.

An operator must establish a fresh managed generation (or explicitly request a
Conversation switch when required) before those historical Tasks can write again.

## Required invariants

1. There is at most one live Activation per Conversation.
2. There is one durable writer authority and its epoch is monotonic.
3. Every Provider mutation is rejected unless durable and Host fences match.
4. A Turn intent is durable before the Provider write.
5. Provider acceptance is exact and carries a native Turn identity.
6. Ambiguous delivery is never retried automatically.
7. Conversation replacement requires exact `missing` evidence and no unsettled
   input, Turn, Activation, or authority.
8. PTY input is presentation-gateway input after takeover, never direct
   Provider terminal injection.
