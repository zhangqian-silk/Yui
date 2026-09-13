<p align="right"><strong>English</strong> | <a href="./agent-runtime-drivers.zh-CN.md">简体中文</a></p>

# Agent runtime Drivers

AgentEndpoint supplies the common execution boundary. Drivers translate native
events, errors and supported observation sources into `RuntimeObservation`;
Controller, Store, CLI and Web consume that shared contract.

## Responsibilities

The connection implementation owns launch, protocol, prompt delivery, resume and
interrupt. Driver owns native identity extraction, observation capabilities,
event/error mapping and usage normalization. Core owns authority, exact request
correlation, durable folding and projections; Agents choose recovery and judge
semantic progress.

Built-in Driver identities are `openai/codex`, `anthropic/claude-code` and
`acp/agent-client-protocol`. ACP is a protocol Driver, not a product label.
Adding an ACP peer does not require another business-state model.

Capabilities must be stated truthfully. Unknown resume, cancellation, activity
or usage behavior cannot be inferred from a product name.

## Observation path

Native structured facts pass the exact Session/request fence, enter the runtime
inbox, and fold into durable observations and original results. A separately
sampled usage source can feed the same canonical contract. Driver cannot choose
another actor, assign a successor Run, or bypass the fence.

Yui Run identity and Provider native Turn identity are not interchangeable.
An explicitly dispatched Run retains its accepted native correlation; direct
native chat is not another implicit Run. Replay is deduplicated by exact fact
identity, and late events cannot terminalize a successor.

Managed Codex uses App Server events. Claude maps its structured stream and
supported Hook/source payloads. ACP maps protocol Session updates and prompt
responses. Terminal text, trust dialogs and prompt glyphs are not lifecycle facts.

## State and error evidence

Persistent Run lifecycle is `active / completed / failed`. Input disposition,
native waiting/activity, Goal, Session lifecycle and process presence answer
different questions. UI projections must not present a queued request as proof
that the Agent is busy, or a live process as acceptance.

Standard Agent errors preserve source, phase, category, code, input disposition,
Session disposition and the serialized native error. Categories include
availability, rate-limit, transport, access, invalid-request, context, session,
runtime, conflict, cancelled and unknown. A mapping reports evidence, not a
retry policy. Unrecognized errors stay unknown.

Runtime activity and workflow progress use separate evidence. A tool boundary
may show native activity; a durable accepted result shows semantic progress.
Tokens, CPU, RSS and pane presence cannot substitute for either acceptance or
Task completion.

## Usage

Usage is read-only and scoped to the exact native Session. Input/output totals
are distinguished from cache/reasoning breakdowns, request context and remaining
capacity. Stable activity IDs deduplicate request snapshots; cumulative deltas
are used only with valid ordered same-Session evidence.

Missing, partial, mixed or rolled-back observations remain unobserved rather
than guessed. Incremental observers report health and coverage; sampling does
not block lifecycle events. Metrics never trigger model selection, wake, retry,
resource release or acceptance.

[Task usage and time](observability/README.md#task-usage-and-time) reuse this
reducer across historical Sessions. Task-fenced observations are not a billing
completeness guarantee. Native child counters are excluded from parent Session
totals without an explicit non-overlap contract; they are never extra requests.
Raw cumulative Session counters and safely attributable Task increments remain
distinct, and only exact request/Run bindings support WorkItem allocation.

## Native children

Native subagents are collaboration inside a parent conversation, not Yui Roles,
Lanes or independent managed workspace owners. Continuation observations may
record lineage and result references when the Provider exposes them.

Best-effort child results return through the parent. Only a persisted content
receipt justifies `durable-result`; a live child or claimed success does not.
Reported results remain untrusted data. A lost best-effort conversation may
require redoing the work. Choose a managed WorkItem execution when independent
durability and acceptance are needed; replication is a separate choice.

## Integration and validation

A new connection implementation must supply truthful control/observation
capabilities and pair them with exact identity, error and terminal mapping.
Provider-specific protocol details stay at the edge, not in Task planning,
Store semantics or Web business rules.

Change-specific disposable evidence should cover the changed correlation,
permission, cancellation or observation boundary. Keep permanent tests to the
primary paths in the [verification policy](testing/verification-levels.md).
Real Provider/model validation requires explicit authorization and must distinguish
native process evidence from fixture output.
