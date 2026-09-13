<p align="right"><strong>English</strong> | <a href="./README.zh-CN.md">简体中文</a></p>

# Runtime observations and diagnostics

Read-only projections help an Agent distinguish durable intent, actual runtime
activity and unknown effects. They do not add a second scheduling or acceptance
authority.

## Inspection

```sh
yui controller status
yui execution audit --task <task-id> --json
yui task next-action <task-id>
yui task role session inspect <task-id> <role>
yui task run show <task-id>/<run-id> --json
```

Controller status exposes the current process and Home identity. Session inspect
separates desired binding, effective launch, actual connection and Agent-reported
configuration. Run inspection exposes original input, disposition, exact result
and diagnostics. A status read does not start another Agent or acknowledge work.

## Meaning of evidence

- Task and WorkItem lifecycle describe intent and acceptance.
- AgentRun lifecycle describes explicitly requested execution.
- Provider acceptance and native activity describe the actual input/connection.
- Host PID, tmux and resource inventory describe process observations.
- Runtime configuration distinguishes requested values from reported values.
- Tokens, durations and orchestration costs are advisory observations.

For a dedicated Claude stream, a main assistant response confirms processing
of the one current local input before its terminal result. Controller and Role
reads therefore show accepted/running once that response arrives. Startup,
echoed user input, child output and repeated old messages do not establish new
acceptance; message UUIDs are never used as native Turn IDs.

Ordinary Leader notifications are TaskWake/mailbox delivery, not Leader Runs.
Role status includes their native admission/activity even when no AgentRun is
open, and shows a retained Session's actual workspace rather than substituting
Task main when its WorkItem is terminal.
Unknown evidence remains unknown; process exit does not prove a shared Provider
stopped, and successful transport does not prove native acceptance.

Engineering control evidence can outlive the attached Session cache. Such a
Role reports retained native input as needing attention, not idle merely because
the cache is empty. Scoped Task/Session inspection remains available for diagnosis.
Replacement and native cleanup failures are durable events routed to the
supervisor, and pending input references remain readable after replacement.

Exact tool start/result events project `tool-active`, while model activity
projects `model-active`; quiet intervals do not imply a hung or finished Agent.
Tool failures are operation outcomes, not automatic Run failures. An owned
Claude execution process dying closes its exact input and marks its Session
failed, even while the supervising Host remains alive. A deliberately stopped
Session with settled native input is idle rather than a false runtime failure.

## Execution audit

`execution audit` aggregates existing Task, Run, wake, Session, Review,
Integration, Publication, event, WorkItem, storage and orchestration evidence.
`--since` and `--until` bound the time window. Sections report their own read
errors without inventing values for missing data.

Fault classification uses Core-owned failure reasons or explicitly identified
Core diagnostic evidence. Agent-authored report prose is not parsed into
verdicts or severity. Native Agent errors retain their original payload and
standard category for the Agent to interpret with current Task context.

Cost and repeated-work advisories do not prevent a legal action, set a Review
budget or choose a recovery topology. `task next-action` is decision support,
not an automatically executed plan.

## Privacy and resource boundary

Telemetry and caches are diagnostic material, not Task truth or a transcript
backup. Do not collect or publish credentials, private environment values or
raw Provider history merely to explain a status.

Start with exact read-only records. Process changes, cancellation, grant updates
and resource cleanup require the relevant explicit action and scope. A generic
diagnostic request does not authorize live-model, shared or production tests.

## Task usage and time

Task overview, Web Task/WorkItem cards and `execution audit` use the same pure
projection of authorized Task events. Reading never samples a Provider or opens
raw transcripts. There is no new metric store, migration, price table or budget
policy. Existing history remains readable.

Each metric has `value`, `status` (`known`, `partial`, `unknown`) and `reasons`.
Unknown is `null`, not zero. A known zero requires actual numeric evidence.
Partial is an observed subtotal, not a complete bill or guaranteed monotonic
lower bound. Coverage names the observed Session identities, source/semantics
and evidence cutoff; it is not a percentage of an unknowable Provider total.
The declared basis is Task-fenced, observed sources only.
JSON consumers read `cost.tokens.value` and `cost.toolCalls.value` with their
status/reasons, replacing the numeric placeholders and observable flags.
`elapsedSeconds` and `executionSeconds` replace the misleading Group-sum
`wallClockSeconds`; this changes a read projection, not persistent storage.

- Request usage reuses the Session reducer: stable request identity, latest
  received revision, input plus output, no extra addition of cache/reasoning
  subsets. Missing boundaries, mixed semantics and cumulative rollback are not
  guessed. Remaining context is capacity, never consumption.
- Replaced Sessions remain in the lifetime view. A nonzero first cumulative
  snapshot is an excluded baseline: it may predate the Task. Later comparable
  increments are partial; one nonzero snapshot alone yields unknown Task usage.
  A zero baseline supports the subsequent counter. JSON also exposes raw
  Session counters separately; they are not additional Task consumption.
- Direct Leader chat can contribute without a Run or WorkItem. WorkItems
  receive only request usage whose revisions share one exact, matching Run
  binding. Cumulative counters are not apportioned. Raw whole-Session totals
  are not exposed as WorkItem usage. Task totals need not equal WorkItem sums.
- Child counters are excluded because the current contract cannot prove they
  are additional to the parent. Child evidence marks coverage partial. Conflicting
  Role ownership of one native counter is unknown, not two independent totals.
- Tool counts deduplicate retained exact native Session/Turn/operation identities,
  including failures. Operation history is compacted, so this is always partial
  when evidence exists and unknown otherwise. Absence never proves zero tools.

**Task elapsed** runs from Task creation (including planning and waiting) to its
recorded completion, retirement or cancellation, or to the read time if active.
An archived Task keeps its original endpoint; missing terminal evidence is
unknown. Group count is irrelevant.

**Observed native execution sum** merges overlapping complete Turn intervals
within one native resource and adds independent parallel resources. Two
independent ten-second intervals can total twenty seconds during ten seconds of
elapsed time. It is not CPU/GPU time. Since Turn history is compacted, this is
partial; missing start/end and live Turns are excluded, never extended indefinitely.
Subsecond precision is retained. WorkItem cards do not substitute Group duration
for either measure.

The audit `usage` section is explicitly **Task lifetime** even when `--since` or
`--until` filters other sections. It does not offer window consumption; filtering
cumulative snapshots first would mislabel historical usage as window usage.
Its existing AgentRun-duration section remains a separately labeled Run metric.

Deterministic fixtures cover the shared reducer and CLI/Web/audit semantics.
They do not establish live Provider completeness. Built-in normalization supports
Codex cumulative and Claude request observations when supplied; this delivery
does not collect real-model billing evidence or assert Provider behavior was
live-tested.
