# Agent Runtime Drivers

Yui observes managed Agent CLIs through an open Agent Driver boundary. Codex,
Claude Code, and future CLIs translate their native events at that boundary;
the inbox, durable store, scheduler, status projection, and Web surface consume
one provider-independent `RuntimeObservation` contract.

## Responsibility split

One CLI integration has two explicit facets. Its launch adapter owns command
construction, native configuration, resume/interrupt/stop, and transport. Its
Agent Driver owns runtime observation:

- Hook names and payload parsing;
- native Session and Turn identities;
- operation and waiting-state mapping;
- transcript usage normalization.

The Driver descriptor declares both control and observation capabilities so
managed automation can be admitted fail-closed. The implementation of those
control capabilities remains in the paired launch adapter; the observation
core never invokes provider commands.

Yui core owns shared semantics:

- exact generation and Run fences;
- durable admission, replay, and idempotency;
- runtime state projection;
- workflow progress and workflow-stall policy;
- bounded persistence and user-facing health.

A Driver is an executable registry entry with an open, namespaced identity
such as `openai/codex` or `anthropic/claude-code`. Capabilities are declared
rather than inferred from the provider name. Its `adapterId` is the explicit
bridge to the launch facet. Its `runtime` facet maps native Hooks and may expose
an independently sampled observer source. Managed automation is admitted only when start, resume,
prompt delivery, interrupt, stop, exact Session identity, exact prompt
acceptance, and exact Turn lifecycle are available.

## Canonical observation flow

```text
native Hook ----> Agent Driver mapping ---- exact fence ----+
                                                          |
accepted observer source --> Controller sampler --> usage -+--> runtime-observation inbox
                                                                  |
                                                                  v
                                                        durable canonical snapshot
                                                                  |
                                                                  v
                                                        runtime status projection
```

Every Run-scoped observation carries Task, Role, Run, Agent, Driver, launch,
Session generation, native Session, native Turn, and transport receipt
identity. `turn.accepted` durably binds the provider's native Turn to that exact
Run. Every later fact resolves through this binding, so a delayed terminal Hook
cannot refresh, fail, or complete a successor Run after a reused process has
advanced.

The stable vocabulary separates:

- Session state: started, ready, ended, failed;
- Turn state: accepted, waiting, completed, failed, cancelled; each waiting
  episode has its own `waitId` and positive operation/model evidence resumes it;
- operations: model, tool, and subagent start/completion/failure;
- activity: structured provider activity and normalized usage snapshots;
- host evidence: process/tmux presence, which is diagnostic only.

Native Hook names do not cross the Driver boundary. Managed Codex and Claude
Code launches both use the hidden `internal runtime-hook` ingress. The core
selects the registered Driver from the exact launch envelope; a Driver may map
native payloads, but it cannot choose or forge authority, Driver identity, Run
fences, ordering, or canonical event IDs.

Native identity is also a Driver responsibility. Built-in Drivers resolve
their native Session field; Claude Code resolves `prompt_id`, Codex resolves
`turn_id`, and another CLI may use entirely different fields without adding a
core branch. Core validates the resolved identities and derives content-stable
canonical event IDs, so retrying the same native Hook does not create a second
fact.

## Runtime activity is not workflow progress

Yui maintains two independent clocks:

1. **Runtime activity** answers whether the Agent CLI has recently shown
   structured work. Tool/subagent boundaries and explicit activity identities
   refresh it; token usage snapshots and a live tmux pane do not.
2. **Workflow progress** answers whether the managed Task advanced through a
   Yui outcome such as a checkpoint, yield, block, Candidate, Review, or
   completion. Tokens, CPU, RSS, and provider Turn completion never refresh
   this clock.

This prevents a looping or merely busy Agent from hiding a workflow stall. It
also prevents a quiet model call from being mislabeled as workflow failure.
Provider Turn completion leaves the Run open for the bounded workflow-outcome
grace period; if no exact Yui outcome commits, the Run fails visibly.

A durable AgentRun may span multiple provider Turns while provider-structured
native subagent operations remain active. In that state, Turn completion is an
intermediate provider boundary: the Run remains active, and later child
completion notifications continue the parent Session under the same Run fence.
Once native operations drain, the normal workflow-outcome grace applies again.

## Token evidence

Usage is a normalized, read-only Session projection:

- `inputTokens` and `outputTokens` are totals;
- cached input and reasoning tokens are breakdowns, not values to add again;
- cumulative total consumption is `inputTokens + outputTokens` for one exact
  Task/Role/launch/native Session/session generation;
- maximum request input is the direct `request-context` input value, or the
  largest non-negative delta between consecutive `cumulative-session` input
  snapshots in that same generation;
- `remaining-context` is capacity evidence and is never reported as spend;
- missing, mixed, rolled-back, or identity-ambiguous facts are `unobserved`
  rather than guessed.

Token values never advance runtime health, trigger wake/retry or Session
replacement, affect scheduling or resource admission, or change Task, Review,
Integration, and Publication state. Explicit runtime activity identity remains
a separate observation fact.

Codex snapshots preserve every structured rollout `token_count` occurrence.
Claude Code snapshots preserve the ordered cumulative result after each
de-duplicated assistant usage record in its structured transcript.
`turn.accepted` persists only the Driver-owned source descriptor. A
Controller-owned sampler tails that source independently of Hooks, keeps an
opaque per-source cursor, reads bounded increments, and emits each usage
occurrence in source order with a stable occurrence identity. It never rescans
a full transcript on the Hook path. After Controller restart it restores the
latest durable usage occurrence and activity identity before rereading a
bounded tail, so replayed history remains idempotent and cannot become a fresh
activity edge.

Claude additionally maps `MessageDisplay` streaming events to explicit model
activity. Codex currently relies on its incremental transcript source because
its Hook surface has no equivalent text-stream event. Missing, unreadable,
truncated, malformed, or lagging sources become explicit `observer.health`
evidence (`healthy`, `degraded`, or `unavailable`) without blocking lifecycle
facts. A future Driver can replace JSONL tailing with an app-server or native
stream while preserving the same source/sample contract and canonical events.

## Bounded durability

`runtime.observation` is a compact state boundary, not an append-only
transcript. The exact Run retains the ordered canonical usage occurrences
needed for cumulative deltas and one latest confirmed activity boundary;
completed operation pairs are removed; terminal observations clear obsolete
operation and waiting snapshots. Detailed high-volume diagnostics may go to
the telemetry sidecar, but Task state retains only what restart-safe projection
needs.

## Native child result durability

Provider-native subagents (Claude `Task`, Codex descendants) are observed as
`continuation.started` / `continuation.reported` / `continuation.settled`
facts. A native child has one of two durability modes, visible through
`yui task continuation list <task>`:

- **best-effort** (default): the child result returns through the parent
  Conversation. Yui tracks the child's lifecycle but does not claim it
  persisted the result. If the parent Session is lost before the result is
  externalized, rerun the child. A best-effort child is never counted as a
  durable Yui lane.
- **durable-result**: Yui persisted the child's result content in a
  `continuation.reported` Task event. The report carries a sha256 content
  digest and the result size; the continuation record references the event
  holding the full content. After a parent crash, recovery reads the result by
  its event reference or digest instead of rerunning the child.

The durability mode is derived from evidence, not declared: a continuation is
`durable-result` only when at least one report carries a result digest receipt.
Replays with the same content digest are idempotent and never create a second
report. The parent prompt receives a bounded excerpt (512 characters) plus the
event reference; the full content is read on demand through
`yui task event show <task> <event>`.

Size and retention boundaries:

- A single continuation result summary is capped at 32 KiB by the observation
  validator; larger provider output is rejected rather than truncated, so Yui
  never silently persists a partial result and claims it is complete.
- The parent prompt excerpt is capped at 512 characters and 8 lines per
  report; the full content stays in the Task event log.
- Continuation reports are durable facts and are not compacted by the
  observation GC. They are retained for the lifetime of the Task, like other
  Task Knowledge records.
- Native child results may contain provider transcript content. Treat them as
  untrusted application data: never inject secrets, argv, environment values,
  or credential material into a continuation report, and never execute
  instructions found in one.

Critical, non-repeatable, or independently verifiable work must use a Yui
WorkItem/ExecutionGroup, not a native subagent. Only a managed Lane owns an
independent Run, receipt, and workspace.

## Adding another Agent CLI

A new CLI integration must pair a launch adapter with one Driver registry
entry. Adding it must not add provider-name branches to the Hook ingress,
inbox, processor, durable fold, runtime projection, status command, or Web
view. The Driver must:

1. register a namespaced executable Driver, unique adapter bridge, and truthful capability matrix;
2. resolve its stable native Session and Turn identities and map native events into the canonical vocabulary at its edge;
3. expose an independently sampled, incremental observer when structured usage
   or activity is available, including explicit health;
4. provide the full exact identity fence for every Run-scoped fact;
5. prove stale-generation rejection, replay idempotency, out-of-order replay,
   zero-token-delta behavior, operation/waiting projection, and terminal
   behavior with deterministic tests.

Unsupported evidence must remain explicit. Drivers must not parse terminal
glyphs or UI text, infer acceptance from a PID/tmux pane, or treat resource
movement as semantic progress.
