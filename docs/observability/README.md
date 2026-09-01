# Observability (Issue 11)

Read-only observability for the Yui control plane: runtime/storage identity in
`controller status`, a stable fault classification taxonomy, and an
`execution audit` read-only aggregation command.

All observability features are **read-only**: they never wake a Leader, write
Task state, or change business behavior. Collection failures degrade to
`unsupported`/`unavailable` without affecting the control plane.

## Task execution projection

`task context`, `task list --verbose`, and the Web task detail consume the same
derived execution projection. It adds a read-only Task DAG (`ready`, `blocked`,
dependency edge status, and transitive root causes), WorkItem stage/round and
Lane configuration details, historical Group drilldown, and cost/context
summaries. Costs are the exact token/tool observations Yui can prove plus
bounded wall-clock duration; an unobservable total is marked partial rather
than inferred. Context metrics are snapshot references, serialized byte sizes,
and observed input peaks. Provider compression and marginal-value observations
remain explicitly unavailable until the runtime records those facts, so the UI
never fabricates them.

## AgentRuntime status

`yui task role status <task> <role>` projects the provider-independent Agent
Driver observations documented in [AgentRuntime Drivers](../agentRuntime-drivers.md).
It reports the Driver, current Session/Turn/operation state, recent activity,
waiting reason, and normalized usage. Host presence remains a separate tmux
field: a live pane is not proof that the Agent is actively working.

Five minutes without structured activity changes runtime attention to `quiet`
(or `active-operation-quiet` when an operation is still open). This is a
diagnostic health signal only. Workflow-stall attention uses durable Yui
progress and is not postponed by tokens, tools, CPU, RSS, or Turn completion.

## Feature flag

The new `controller status` identity fields are gated by `YUI_STATUS_IDENTITY`:

- `YUI_STATUS_IDENTITY=0` (or `false`/`off`) — disable the identity section.
- unset or any other value — enabled (default).

The `execution audit` command is always available (it is an explicit read-only
command, not a status field).

## `controller status` identity fields

When enabled, `yui controller status` adds a read-only identity section:

| Field | Source | Notes |
| --- | --- | --- |
| `build.packageVersion` | `package.json` | |
| `build.entryDigest` | SHA-256 of the CLI entry | Detects stale `dist/` |
| `build.entryRealpath` | `fs.realpath` | |
| `build.sourceCommit` | `git rev-parse HEAD` | `unsupported` if not a git repo |
| `build.nodeVersion` | `process.version` | |
| `build.platform` | `process.platform` | |
| `storage.manifestStatus` | `schema.json` | `current`/`uninitialized`/`invalid`/`unsupported` |
| `storage.logicalLayout` | `schema.json.storageVersion` | |
| `storage.aggregateSchemaVersion` | `schema.json.aggregateSchemaVersion` | |
| `storage.configuredBackend` | Current product contract | Always `sqlite` |
| `storage.workerEnabled` | `YUI_STORE_WORKER` override over the current SQLite default | |
| `storage.physicalStateJson` | Old `state.json` existence/size | Evidence only; never authoritative |
| `storage.physicalDatabase` | `yui.db` existence/size/WAL/SHM + `PRAGMA quick_check` | health: `ok`/`corrupt`/`unopenable`/`unsupported` |
| `storage.findings[]` | Exact-contract and physical evidence | contradictions + warnings |
| `storage.healthy` | derived | `true` only when health status is `ok` |
| `runtime.uptimeMs` | Controller process | |
| `runtime.rssBytes` | `process.resourceUsage` | |
| `runtime.droppedInboxEvents` | runtime/inbox-invalid | Count of dropped inbox events |

Startup and status both select the current SQLite Store.

### Storage health classification

Findings have three severities, rolled up into a health status:

| Status | Meaning | Exit code |
| --- | --- | --- |
| `ok` | no findings | 0 |
| `fail` | one or more contradictions | 5 |

#### Contradictions (fail-closed)

| Code | Meaning |
| --- | --- |
| `current-database-missing` | The current manifest exists but `yui.db` is missing |
| `database-unhealthy` | `yui.db` exists but `PRAGMA quick_check` fails (corrupt or unopenable) |
| `unsupported-storage-contract` | The manifest does not exactly match this release |
| `invalid-storage-manifest` | `schema.json` is invalid |

#### Warnings

| Code | Meaning |
| --- | --- |
| `ignored-historical-store` | `state.json` is present but ignored by the current Store |
| `invalid-worker-flag` | `YUI_STORE_WORKER` is not a recognized boolean |

Only `fail` (contradictions) exits 5. Every finding prints with a precise action;
unsupported Homes are preserved and must be inspected with their original Yui
version or replaced by a new Home.

## Fault classification taxonomy

Stable taxonomy for execution failures (`src/observability/faultClassification.ts`):

| Class | Basis | Typical evidence |
| --- | --- | --- |
| `provider-transient` | text-historical | StopFailure 500/504, connection lost, rate limit |
| `policy-denied` | text-historical | policy, permission denied, 403 |
| `session-dead` | text-historical | tmux session exited, pane dead |
| `delivery-uncertain` | text-historical | delivery uncertain |
| `storage-backend-lock` | text-historical | SQLITE_BUSY, lock timeout |
| `review-infra` | structured | ReviewRound failed to execute |
| `review-semantic-negative` | structured | ReviewRound completed with failed checks |
| `integration-environment` | text-historical | tsc: not found, ENOENT |
| `integration-candidate-failure` | structured | Integration check failed |
| `stale-base-target-cas` | structured | Integration conflict |
| `archive-resource-leak` | structured | archived task with live resources |
| `other` | none | unclassified |

Text-derived classifications carry `basis: "text-historical"` so consumers can
distinguish them from structured outcomes. A future capability provider (other
Issues) may supply `StructuredFaultHint` to override text matching.

## `yui execution audit`

Read-only aggregation command. Does not wake a Leader or write Task state.

```
yui execution audit [--task <task-id>] [--since <iso>] [--until <iso>] [--json]
```

Sections:

- **tasks** — total/archived/active counts.
- **runs** — total/active/completed/failed, failure rate, cumulative duration,
  by-role and by-purpose distribution, fault class counts, and structured
  launch-failure phase/kind counts parsed from launch diagnostics.
- **wakes** — Leader Turns and their durable wake reasons.
  `suppressedWakes` counts durable `wake.suppressed` task events: Leader wakes
  coalesced by scheduler single-flight because the Role runtime lifecycle lane
  was busy (Issue 05). The wake stays durable and is retried after the lane
  settles, so a suppression is scheduler backpressure, never a failed Turn.
- **sessions** — generations, broken/stopped, resets, lifecycle events, stop
  failures.
- **reviews** — total/completed/failed, non-semantic infrastructure vs
  semantic-negative; mixed evidence remains ambiguous and fail-closed.
- **integrations** — total/committed/failed, environment failures, gate reuse.
- **publications** — total/merged/verified/open/closed/superseded external
  PR/MR references.
- **events** — total, progress vs semantic, obsolete, message count.
- **workItems** — total/completed/retired.
- **orchestration** — per-Task intent type, Turn/WorkItem counts, full/delta/
  non-semantic Reviews, finding results, Integration attempts/failures/repeated
  identities/evidence reuse, generations before first durable progress,
  publication-to-completion latency, terminal workspaces, and non-blocking
  cost advisories. `--since`/`--until` filters every underlying record family.
- **storage** — state.json/runtime/deployments byte sizes.
- **topLongRunning** — longest-running active/completed Turns with exact refs.

Each section degrades independently: a read failure produces an `error` section
with the error location, without blocking completed sections.

`yui task next-action <task>` shows the same Task-scoped orchestration
advisories alongside its protocol recommendation. It also shows the canonical
active Turn projection with each Turn's purpose and WorkItem/ReviewRound
binding, so Review activity is never presented as delegated implementation.
Advisories are derived from existing records and never write state or block a
legal action. Current
advisories cover direct-path protocol overhead, initial integrated WorkItem
fan-out, unexplained review-repair fan-out, repeated exact Integration checks,
same-Reviewer/same-candidate full Review repetition without new findings, and
the two-generation first-progress advisory threshold. No Review advisory is a
budget or blocks a legal action; the first-progress threshold never chooses
Agent recovery.

## Rollout

1. Ship the read-only status fields behind `YUI_STATUS_IDENTITY` (default on).
2. Establish the production baseline: run `yui controller status` and
   `yui execution audit` against the current Home, confirm consistency with
   manual `ps`/filesystem checks.
3. Classify existing outcomes/receipts using the taxonomy; future structured
   fields plug in via capability providers.
4. If collection overhead exceeds budget, disable high-cost inventory
   gates; the basic identity and audit remain. No business-state rollback is
   needed.

For the multi-Agent quality/cost comparison and staged enablement gates, use
the [T10 evaluation contract](../multi-agent-evaluation.md). It consumes
deterministic mock/replay evidence and keeps `single` as the default; this
observability document does not authorize real Provider or production tests.

## Rollback

- **Status fields**: set `YUI_STATUS_IDENTITY=0`. The identity section is
  removed from `controller status` output; no state is affected.
- **Audit command**: the command is read-only and additive; removing it is a
  code revert, not a state rollback.
No persistent schema, state machine, or business behavior is changed by this
Issue. Rollback is always a config flip or code revert.
