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
   structured work. Tool/subagent boundaries and positive token deltas refresh
   it. A live tmux pane alone does not.
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

Usage is a cumulative normalized snapshot:

- `inputTokens` and `outputTokens` are totals;
- cached input and reasoning tokens are breakdowns, not values to add again;
- a fresh native Session persists a zero baseline before its first sample, so
  its first positive total proves work performed by that new generation;
- a resumed Session's first cumulative snapshot establishes its baseline and
  proves no new activity by itself;
- only a strictly larger input-plus-output total proves new activity;
- an unchanged or reset counter updates the baseline but does not fabricate
  activity.

Codex snapshots come from the latest structured rollout `token_count`. Claude
Code snapshots are the de-duplicated sum of assistant usage records in its
structured transcript. `turn.accepted` persists only the Driver-owned source
descriptor. A Controller-owned sampler tails that source independently of
Hooks, keeps an opaque per-source cursor, reads bounded increments, and emits
only changed cumulative usage. It never rescans a full transcript on the Hook
path. After Controller restart it restores the latest durable usage and
activity identity before rereading a bounded tail, so historical tokens cannot
be reported as a fresh activity edge.

Claude additionally maps `MessageDisplay` streaming events to explicit model
activity. Codex currently relies on its incremental transcript source because
its Hook surface has no equivalent text-stream event. Missing, unreadable,
truncated, malformed, or lagging sources become explicit `observer.health`
evidence (`healthy`, `degraded`, or `unavailable`) without blocking lifecycle
facts. A future Driver can replace JSONL tailing with an app-server or native
stream while preserving the same source/sample contract and canonical events.

## Bounded durability

`runtime.observation` is a compact state boundary, not an append-only
transcript. The exact Run retains one latest cumulative usage baseline and one
latest confirmed activity boundary; completed operation pairs are removed;
terminal observations clear obsolete operation and waiting snapshots. Detailed
high-volume diagnostics may go to the telemetry sidecar, but Task state retains
only what restart-safe projection needs.

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
