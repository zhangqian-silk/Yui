<p align="right"><strong>English</strong> | <a href="./ARCHITECTURE.zh-CN.md">简体中文</a></p>

# Yui architecture

Yui is a local control plane and context API for intelligent Agents. Agents own
planning, execution topology, semantic review, acceptance and recovery. Core
owns durable identity, authorization, workspace isolation, data integrity and
bounded effects. It exposes current facts and atomic operations rather than
choosing a workflow for the Agent.

## Responsibilities

| Boundary | Owns | Does not own |
| --- | --- | --- |
| Operator / Leader | User coordination; Task outcome, planning and judgment | Forged runtime receipts or self-granted external authority |
| Task Store | Tasks, Roles, WorkItems, Runs, messages, results, events and resource ownership | Native transcript or inferred Provider activity |
| Context | Authorized bounded reads, immutable event deltas, exact execution snapshots | A second writable Task or delivery acknowledgement |
| Controller | Delivery, observations, Jobs, capability Host and Web listener | Semantic interpretation of Agent prose |
| CapabilityRegistry / InstanceHost | Descriptor resolution, scoped invocation, implementation references and disposal | Task planning, arbitrary plugin privileges or automatic recovery |
| AgentHost / AgentEndpoint / Driver | Native connection, input disposition, exact result correlation and observations | Task acceptance or ownership of a shared Provider daemon |
| Project / Resource | Knowledge, managed Git workspaces, adopted environments and durable artifacts | Permission inferred from a directory name |
| CLI / Web | Shared domain operations and projections | Independent business state or another plugin Host |

One `YUI_HOME` has one authoritative SQLite control-plane Store and one
Controller. Project Knowledge is maintained under the Home; repository material
can be evidence but is not a substitute for maintained Knowledge.

## Intent, collaboration and execution

Task represents one bounded outcome, possibly across multiple Projects. Its
type describes intent and does not prescribe decomposition. A Leader can own
bounded work directly; WorkItems are substantial independently acceptable
requirements with explicit owners.

Task lifecycle is `draft / active / completed / cancelled / archived`.
WorkItem lifecycle is `open / accepted / retired`. Execution, waiting and
failure belong to AgentRuns and runtime observations, not extra WorkItem states.
Only accepted direct dependencies satisfy `dependsOn`; replacement metadata does
not redirect the graph.

A valid Leader Session can read Context and mutate scoped Task facts without
an active AgentRun. Worker and Reviewer actions retain their exact Assignment
and workspace boundaries. Replacing or revoking a Session changes authority;
a transient delivery failure does not grant or revoke unrelated authority.
Released Leaders retain scoped diagnostic reads, not write authority.

Durable Task context and engineering control data have separate purposes.
Requirements, decisions, acceptance and original results must survive outside
native conversations. AgentRun input/result history remains evidence, while its
active index, native delivery state, Host and Session selection only control an
execution attempt. Replacing that execution never completes or deletes the Task.

AgentRun records an explicitly requested execution with a frozen Context and
effective configuration. Native conversation, Goal continuation and ordinary
Leader notifications do not automatically create Runs. Messages can continue
already dispatched work through a new, exactly associated Run without changing
the requirement, captured permissions or workspace.

See [Session and AgentRun](docs/managed-turn-and-session-runtime.md) and
[Task dependencies](docs/task-dag-semantics.md).

## Delivery and results

Explicit dispatch and ordinary notification share native input transport, but
keep different durable owners. The Controller claims a bounded mailbox batch;
AgentHost serializes submission through AgentEndpoint. The Provider binding
records actual acceptance and native correlation. A notification can settle
on acceptance without requiring a final execution report.

Busy with proven non-acceptance preserves the input for a subsequent attempt.
Transport submission alone does not prove acceptance. Unknown effects remain
visible and fenced: no blind resend or inferred success. Explicit replacement
first resolves actual native execution, then discards its engineering occupancy.
Input arriving during a claimed batch remains pending for the next batch.
Context reads do not consume delivery.

An exact terminal transaction persists one original AgentRunResult and a
reference Message. Core validates identity, transport and workspace facts;
it does not parse prose into findings, votes, repair topology or acceptance.
Provider success and semantic success are distinct.

Direct execution uses one main Run. Replicated execution freezes one Assignment
for distinct Producer Lanes. The Leader explicitly chooses terminal original
results and starts one main synthesis Run; selected failed results can be useful
evidence. Core checks provenance, not success counts or consensus. Lanes are not
Candidates or Integration sources.

ReviewRound references a frozen Candidate or Task heads and its exact Reviewer
Run. The original Reviewer output remains on that Run. Review policy and explicit
Task-final contracts govern when review is required; the Leader decides the
meaning of the report. See [result consumption](docs/agent-result-consumption.md).

## Planning, workspaces and resources

Draft contains planning facts and Project bindings, not an adopted delivery
workspace. Its private planning directory is under
`<YUI_HOME>/runtime/task-runtimes/planning`, separate from durable control data
and delivery trees. Planning Sessions capture `planning` authority. The Leader can
persist an activation request during a Run or ordinary discussion and return;
native quiescence releases the intent for current-authority and resource checks.

Activation prepares physical resources before atomically adopting Task status,
workspace identity and ownership. Failure preserves intent and a diagnosis,
notifies the Leader and stops automatic repetition of that failed adoption.
Success notifies the Leader to enter delivery without another user prompt.
Task activation cannot change a live Session's captured authority into
`delivery`; a compatible delivery launch must establish that boundary.

Stable Project checkouts are read-only references. Managed workspace owners are
Task, WorkItem, ReviewRound or IntegrationAttempt, not Role names. Multi-Project
workspaces contain per-Project Git roots. Write scopes and exact Git lineage
are checked where effects occur; a Profile's behavior intent is not a grant.

An isolated result is captured as immutable per-Project ChangeSets and integrated
through a candidate worktree. Checks precede compare-and-swap advancement of the
target head. Conflicts or target movement retain evidence and do not advance it.
The Leader accepts delivery separately.

Resources support immutable content, external-version and receipt artifacts,
plus explicitly marked reference material. Environment prepare, adopt, bind and
release are separate operations. Selection affects future native execution;
active Sessions retain their captured environment. Trusted-local adoption is
not an OS sandbox and release never implies deleting user directories.

## Runtime identity and replacement

Agent execution component, connection plan, native Session, Host attachment and
AgentRun identify different things. Codex CLI uses App Server, Claude Code CLI
uses stream-json, and ACP peers use the ACP connection implementation. Unknown
ACP product identity remains unknown.

Desired Role configuration, frozen effective launch and actual Agent-reported
configuration are separate facts. Requested model or permission is not evidence
that it is currently in effect. ACP configuration is applied and checked through
negotiated options; unsupported axes fail explicitly instead of being guessed.

The Host owns disposable clients, not shared native conversations. Session
implementations are pinned to their actual code boundary. New calls or Sessions
can select a new implementation while old references drain. A timeout or client
exit does not prove descendant resources stopped; unresolved disposal remains
observable rather than being reported as clean.

Session reuse is optional. `task role session new` records replacement intent
in the existing runtime mailbox, including when a Run is active or the prior
Session has already ended. Once its resources stop, Yui cancels the old Role's
engineering attempts, retains history and workspaces, and selects a new Session.
Unprocessed notification references are carried into the successor's context,
not lost behind a time cursor. The Agent chooses whether to retry existing work.
Persistent native connection location and dedicated process custody make recovery
independent of the old Host. A genuinely live/unknown writer remains a resource
boundary, not a reason to withhold diagnosis or erase durable context.

See [Provider runtime](docs/provider-runtime.md) and
[Agent Drivers](docs/agent-runtime-drivers.md).

## Capabilities, plugins and surfaces

Capabilities use authenticated `search / describe / call`. Descriptors declare
schemas, effects, permissions, scope and Provider identity. Ambiguity requires
explicit selection. Nested calls cannot amplify caller authority or effect;
original operation receipts survive a parent failure.

The Registry exposes context, messages, artifacts, environments, plugins and
selected Task/Job operations. Other CLI/Web operations share domain handlers
directly. There is no requirement to route every operation through a plugin.

Validated Task-local plugins preserve explicit enabled intent in the Store and
live instances in InstanceHost. Reading or restarting does not run author code.
Leader management is limited to its Task; executable code still requires exact
Operator-issued grants. Plugin validation is not a security certification.

CLI contributions and controlled Web panels are projections of the Registry.
Web is loopback-only and Controller-owned. Its authenticated local-user controls
share CLI domain operations; query panels remain read-only and cannot borrow
that user authority for mutations or plugin management. See [Plugin SDK](docs/plugin-sdk.md) and
[capabilities and resources](docs/architecture/capabilities-and-resources.md).

## Persistence, completion and operation

The Home has one append-only storage migration chain. Ordinary runtime accepts
only current records. Explicit upgrade backs up and migrates valid supported
Homes; malformed state is diagnosed, not automatically repaired.

Completion freezes the delivery result and checks applicable acceptance,
integration and review contracts. It is distinct from publication, verified
remote merge, physical quiescence and archive. Ordinary archive requires settled
work and clean removable managed resources. Explicitly authorized force archive
can retain unresolved evidence and unsafe resources without claiming delivery or
quiescence. Both preserve Task history and cannot reopen.
See [Task delivery and archive](docs/task-delivery.md#archive).

Runtime health and cost are observations, not semantic verdicts. The Agent reads
exact faults and current intent to choose retry, repair or abandonment. Yui does
not automatically create rescue Workers or select another model.

The [documentation map](docs/architecture/README.md) links current contracts.
The [verification policy](docs/testing/verification-levels.md) separates core
smoke from temporary change-specific and explicitly authorized real-resource
evidence; documentation is not a claim of full production validation.
