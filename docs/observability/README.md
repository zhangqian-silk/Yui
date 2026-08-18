# Observability (Issue 11)

Read-only observability for the Yui control plane: runtime/storage identity in
`controller status`, a stable fault classification taxonomy, an `execution
audit` read-only aggregation command, a 25-agent SLO benchmark, and a
fault-injection regression matrix.

All observability features are **read-only**: they never wake a Leader, write
Task state, or change business behavior. Collection failures degrade to
`unsupported`/`unavailable` without affecting the control plane.

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
| `storage.configuredBackend` | Home-aware resolver (manifest + `YUI_STORE_BACKEND`) | `file` or `sqlite` |
| `storage.workerEnabled` | Home-aware worker resolver (manifest + `YUI_STORE_WORKER`) | |
| `storage.physicalStateJson` | `state.json` existence/size | |
| `storage.physicalDatabase` | `yui.db` existence/size/WAL/SHM + `PRAGMA quick_check` | health: `ok`/`corrupt`/`unopenable`/`unsupported` |
| `storage.hasMigrationReceipt` | `migration-receipt.json` | certifies the file→db switch |
| `storage.findings[]` | manifest vs physical evidence | contradictions + needs-repair + warnings |
| `storage.healthy` | derived | `true` only when health status is `ok` |
| `runtime.uptimeMs` | Controller process | |
| `runtime.rssBytes` | `process.resourceUsage` | |
| `runtime.droppedInboxEvents` | runtime/inbox-invalid | Count of dropped inbox events |

Backend and worker selection use the same Home-aware resolvers as startup
(`resolveTaskStoreBackendForHome` / `resolveStoreWorkerEnabledForHome`), so
status reports exactly what ordinary startup would open.

### Storage health classification

Findings have three severities, rolled up into a health status:

| Status | Meaning | Exit code |
| --- | --- | --- |
| `ok` | no findings | 0 |
| `degraded` | needs-repair findings only | 0 |
| `fail` | one or more contradictions | 5 |

#### Contradictions (fail-closed)

| Code | Meaning |
| --- | --- |
| `no-authoritative-backend` | Layout 7 with neither `yui.db` nor a readable `state.json` — no authoritative data source |
| `database-unhealthy` | `yui.db` exists but `PRAGMA quick_check` fails (corrupt or unopenable) |
| `dual-copy-conflict` | Both `state.json` and `yui.db` exist without a `migration-receipt.json` — ambiguous authority |
| `backend-sqlite-without-database` | `YUI_STORE_BACKEND=sqlite` forced but no `yui.db` |
| `file-store-missing-state` | File backend (layout < 7) selected but `state.json` missing |

#### Needs-repair (degraded)

| Code | Meaning | Remediation |
| --- | --- | --- |
| `pseudo-layout-7` | Layout 7 without `yui.db` but with a readable `state.json` — the legacy file store is the rebuild source | Run `yui upgrade` to rebuild `yui.db` |

#### Warnings

| Code | Meaning |
| --- | --- |
| `database-present-but-file-backend` | `yui.db` exists but backend is `file` |
| `worker-flag-without-sqlite` | `YUI_STORE_WORKER` set but backend is not `sqlite` |

Only `fail` (contradictions) exits 5; `degraded` Homes stay operational and
exit 0 while pointing at the exact repair command. Every finding prints with a
precise remediation action.

## Fault classification taxonomy

Stable taxonomy for execution failures (`src/observability/faultClassification.ts`):

| Class | Basis | Typical evidence |
| --- | --- | --- |
| `provider-transient` | text-historical | StopFailure 500/504, connection lost, rate limit |
| `policy-denied` | text-historical | policy, permission denied, 403 |
| `session-dead` | text-historical | tmux session exited, pane dead |
| `delivery-yield-uncertain` | text-historical | yield/delivery uncertain |
| `storage-backend-lock` | text-historical | SQLITE_BUSY, lock timeout |
| `scheduler-duplicate-suppressed-wake` | structured | orphan wake reasons |
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
- **runs** — total/active/yielded/failed, failure rate, cumulative duration,
  by-role and by-purpose distribution, fault class counts.
- **wakes** — leader runs with wake reasons, orphan wakes, orphan yield-only.
  `suppressedWakes` is `unsupported`: quiescence suppression (Issue 05) is
  silent by design and writes no durable counter, so the audit cannot report
  a count without guessing.
- **sessions** — generations, broken/stopped, resets, lifecycle events, stop
  failures.
- **reviews** — total/completed/failed, infra vs semantic-negative.
- **integrations** — total/committed/failed, environment failures, gate reuse.
- **events** — total, progress vs semantic, obsolete, message count.
- **workItems** — total/completed/retired.
- **storage** — state.json/runtime/deployments byte sizes.
- **topLongRunning** — longest-running active/yielded runs with exact refs.

Each section degrades independently: a read failure produces an `error` section
with the error location, without blocking completed sections.

## SLO benchmark

`scripts/bench/control-plane-slo.mjs` drives the real file-backed Controller
over its Unix socket under synthetic 25-agent telemetry load.

```
node scripts/bench/control-plane-slo.mjs [--agents 25] [--rounds 3] [--slo]
  [--baseline <path>] [--write-baseline <path>] [--out <path>]
```

Or via Make:

```
make bench-slo              # 25 agents, 3 rounds
make bench-slo ROUNDS=1     # CI short mode
make bench-slo SLO=1        # gate on thresholds
```

### Thresholds (Issue 11 §4)

| Metric | Threshold |
| --- | --- |
| command p99 | < 50 ms |
| event-loop delay max | < 500 ms |
| persistence p99 | < 100 ms |
| command timeouts | 0 |
| semantic events lost | 0 |

`--slo` exits 1 on any violation and prints the comparison. Thresholds are
adjusted only against a stable baseline, never relaxed for a single flaky run.

The benchmark is hermetic: it seeds a fresh disposable temp Home and never
touches the real Yui Home.

## Fault-injection matrix

`test/fault-injection/fault-injection.test.js` (tier: `fault-injection`)
covers 8 scenarios with characterization baselines in
`test/fault-injection/baselines/fault-matrix.json`:

| Scenario | Status | What is verified |
| --- | --- | --- |
| `storage-identity-contradiction` | passing | `collectStorageIdentity` classifies pseudo-layout-7 (needs-repair) vs no-authoritative-backend (fail) |
| `provider-500-then-recover` | passing | StopFailure 500/504 classified as provider-transient |
| `yield-crash-before-commit` | failing | Audit counts yielded-without-deliveredAt uniformly |
| `yield-crash-after-commit` | passing | Audit counts clean yield |
| `pane-dead-provider-alive` | failing | Inventory scanner runs; full attribution in sandbox acceptance |
| `unchanged-scheduler-scan-x100` | passing | 100 signals create no new Leader Runs |
| `handover-candidate-failure` | passing | Stale CAS classified as stale-base-target-cas |
| `archive-live-reference-fail-closed` | failing | Audit surfaces active run on archived task |

Scenarios with status `failing` reproduce the fault but the production fix is
not yet implemented. The baseline documents the gap; update it to `passing`
when the fix lands.

Run with:

```
make test-tier T=fault-injection
```

## Rollout

1. Ship the read-only status fields behind `YUI_STATUS_IDENTITY` (default on).
2. Establish the production baseline: run `yui controller status` and
   `yui execution audit` against the current Home, confirm consistency with
   manual `ps`/filesystem checks.
3. Classify existing outcomes/receipts using the taxonomy; future structured
   fields plug in via capability providers.
4. Gate the SLO benchmark as a release check. Adjust thresholds only against a
   stable baseline.
5. If collection overhead exceeds budget, disable high-cost inventory/fault
   gates; the basic identity and audit remain. No business-state rollback is
   needed.

## Rollback

- **Status fields**: set `YUI_STATUS_IDENTITY=0`. The identity section is
  removed from `controller status` output; no state is affected.
- **Audit command**: the command is read-only and additive; removing it is a
  code revert, not a state rollback.
- **SLO benchmark**: a CI-only script; removing it from the workflow is the
  rollback. No runtime state is involved.
- **Fault-injection tier**: a test-only tier; removing it from the tier
  manifest is the rollback. No runtime state is involved.

No persistent schema, state machine, or business behavior is changed by this
Issue. Rollback is always a config flip or code revert.
