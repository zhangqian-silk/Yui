<p align="right"><strong>English</strong> | <a href="./release-workflow.zh-CN.md">简体中文</a></p>

# Authorized release operations

A release workflow is an explicitly chosen, authorized sequence of
external release effects — pull requests, CI confirmation, merges, version
tags, npm publishes, fresh-install smoke tests, CLI updates, Controller
replacements, Project migrations, and post-verification. It is a specialized
external-effect facility, not Yui's Task planning or Agent execution model.
The Agent selects a predeclared plan, and the facility drives that plan
from durable state: every transition is persisted before the next external
call, so a crash, timeout, or revoked grant never leaves the release guessing.

Two task-level record families back it:

- **CapabilityGrant** (`capability-grant-N`) — the authority. A named granter
  scopes a grant to actions, parameter bounds, an expiry, a use count, and an
  irreversibility ceiling.
- **ReleaseWorkflow** (`release-workflow-N`) — the plan and its progress: an
  exact source (repository + pinned commit, optionally an artifact), an
  immutable ordered step plan, and one persisted record per step.

The engine (`src/release/releaseWorkflowEngine.ts`) owns persisted transitions and the workflow lock; the
`yui task workflow` and `yui task grant` commands drive it. Every external
system sits behind `ReleaseWorkflowPorts`
(`src/release/releaseWorkflowPorts.ts`). Disposable SQLite and deterministic
external ports exercise recovery without real GitHub, npm, git, Controller,
or model effects.

## Pre-1.0 contract cleanup

The current development step retires runtime compatibility before the final
1.0 baseline cutover. It does not publish a release or reset storage numbering.
Storage 27→28 normalizes only provable singleton Role dispatch dedupe keys;
the old migration ledger, Messages, Task results and unconfirmed effects remain
unchanged. Ordinary opens require storage 30. Existing Homes advance only through
the explicit upgrade boundary; no runtime dual-reader is added.

This is a breaking pre-1.0 change:

- `message send` uses `--intent`; `--wake-policy` is no longer accepted by the
  CLI or capability API. Draft edits preserve intent.
- Internal command integrations implement `notifyMailboxChanged`; the Task-only
  notification adapter has been removed with its callers updated.
- ACP peers must report `configOptions`; there is no `modes`/`set_mode` path.
- Release recovery requires a pinned Home and installation prefix. Unpinned
  identities remain unknown, and incomplete handover locks remain fenced.
- Development link/unlink requires the current registry. It does not discover
  or adopt older NVM registrations or reconstruct orphan links.
- GC no longer discovers retired deployment layouts or reconstructs removed
  worktrees. Unsupported quarantine evidence is retained, never purged as if
  it were a current move receipt.
- `task activate` consumes an existing request; no request means no resource
  adoption. Request creation, deferred admission and atomic workspace adoption
  remain separate, using the same current boundary.
- `task integration queue` and its state machine are removed. The Agent chooses
  each WorkItem result's order and strategy and calls the atomic Integration
  operations; exact checks, target CAS and completion obligations remain.

Storage 28→29 preserves every former queue payload verbatim in a Task event
`integration.queue-retired`, with its original queue ID, before dropping the
active table. Event IDs advance past both the stored counter and existing
history. This does not accept delivery, generate an Integration or replay work.
Existing Integrations and Jobs stay intact. Inspect `task event list <task>`
and the referenced WorkItem/Integration before deciding what remains to do;
retiring the queue does not settle an unfinished Integration.

Storage 29→30 retires Run-linked wakes into `wake.run-link-retired` Task events
with the complete original payload. Current notification IDs, delivery status
and references remain intact, using wake schema 2; Run termination no longer
consumes notifications. Live Runs, owned retries and unresolved claims referring
to a retiring wake block both preflight and migration. The migration does not
stop execution or fabricate acceptance. Global Session sets use an explicit
`providerBinding: null` when no controlled binding exists.

Additional current boundaries:

- Project/artifact file locks and handover locks require exact process-generation
  evidence. Missing/invalid owners or unreadable OS identity remain fenced;
  age alone never proves a creator exited. No PID-only positive fallback remains.
- PR head lookup uses one `gh pr list --head ... --state open` query. Only an
  empty, valid array proves absence. Transport errors, malformed identities and
  multiple matches fail without attempting creation.
- Existing Git operations cannot be adopted without the Integration's original
  progress receipt. Preserve their files and diagnose explicitly; current
  receipt-backed conflict/Job continuation remains supported.

Before rollout, settle old executions and use explicit cleanup for unsupported
locks, links or quarantines. Preserve those records until their owner and
disposition are established; the runtime does not choose recovery for them.

The later baseline cutover must first establish a verified bridge/export to the
chosen current format, then replace the old initialization/migration chain with
one clean baseline. Only then remove pre-baseline migrations and their historical
fixtures. Reset the storage baseline once; do not reset it again when tagging
1.0.0. Keep unknown-version rejection, exact process/Host identity checks and
durable audit evidence. Version tags and real migration/publication effects
require their separate release authorization.

## Authorization model

Every (re)submission of a step passes `checkGrant(grant, request, now)`
(`src/grant/capabilityGrant.ts`) **before** the external call. The step kind
is the grant action: a grant lists the step kinds it authorizes, for example
`--action npm-publish --action version-tag`. The decision is fail-closed —
every denial carries a machine-readable reason and stops the run:

| Reason | Meaning |
| --- | --- |
| `grant-missing` | No grant record is bound to the workflow (engine-level). |
| `grant-revoked` | The grant was revoked by an operator. |
| `grant-expired` | The wall clock passed the grant's `expiresAt`. |
| `grant-uses-exhausted` | The grant's `maxUses` has been consumed. |
| `grant-action-not-allowed` | The step kind is not in the grant's actions. |
| `grant-parameter-missing` | A bounded parameter is absent from the step. |
| `grant-parameter-value-not-allowed` | A bounded parameter has an out-of-bounds value. |
| `grant-irreversibility-exceeds-ceiling` | The step is more irreversible than the grant's ceiling. |

Additional rules:

- **One use per authorized submission.** The engine records a grant use
  between the successful decision and the external call, so a `maxUses` grant
  fails closed on the attempt that would exceed it.
- **Irreversible steps need a confirmed prefix.** A step marked
  `irreversible` additionally requires every earlier step to be `succeeded`;
  otherwise the step fails with `prerequisite-not-confirmed` and the run
  stops. This is what keeps an `npm-publish` from running behind a failed PR.
- **Denials are recorded.** When a pending step is denied, the engine starts
  and fails the step with the denial in its log, so `workflow status` shows
  exactly where authorization stopped.
- **Rebinding.** A revoked, expired, or too-narrow grant does not dead-end
  the workflow. Issue a new grant and resume with
  `yui task workflow resume <task> <workflow> --grant <new-grant>`; the plan,
  source, and all confirmed step evidence are immutable across the rebind.

## Stable Task-final Review contract

Compatible CLI package updates and Controller replacements do not change an
active Task's final-review capability. Managed Sessions use the ordinary
`yui` command, compatibility is checked by protocol and storage identity, and
a replacement Leader presents the contract already established by durable Task
evidence. No version-aware Operator action is required.
Candidate and Task-final ReviewRound records must all carry that one contract.
Conflicting records fail closed; there is no rebind event, recovery command, or
second contract state machine.

## Persistent Agent Host compatibility

A running Host keeps its original Endpoint implementation. It records exact
Session/attempt/native-Turn facts in the existing durable Inbox before contacting
the Controller; only the current Controller resolves Run ownership, validates
authority/workspace/lifecycle/history, and commits the result. An Inbox file is
not acceptance. Files are consumed only after commit, so downtime or a lost ACK
does not replay user input or model work.

Startup facts use the exact Run identity from the redeemed launch payload, not
the long-lived Session environment. This preserves pre-adoption evidence even
when the frozen Run workspace differs from the Role's default; later activity
and terminal facts still resolve solely by their own native input identities.

The supported Host boundary is control `yui-agent-host/v5`, event source
`yui-agent-host-events/v1`, and Controller RPC version 4. Hosts advertising
`storage=controller-owned` do not open the Home database, including for process
custody, native account locations, or execution-environment checks. Home 22
declares the additive Inbox source envelope; valid older Inbox v1 facts and
domain history remain readable. Future changes must retain this wire boundary
or reject incompatible live producers before changing storage. CLI wrapper
refresh and a successful new `doctor` are not Host compatibility proofs.

`upgrade`, the staged target's `update` preflight, and release activation inspect
live Host capabilities independently. An old Host without this capability,
including an idle Host or one whose response is unconfirmed, blocks adoption.
Checks are repeated at the existing fenced/quiesced handover boundary before
migration or promotion. No Host is killed, replaced, or reloaded by these checks.
Let existing work settle and preserve original pending input/result evidence;
then an authorized Operator can select a safe Session replacement/cleanup before
retrying. Installing this change cannot repair already-loaded legacy Host code
or collect a terminal that that code never durably emitted.

`task role status`, `task role list`, and `task role session inspect` expose Host
reporting alongside durable Run state. Pending native results or known reporting
failures require attention; they do not mean the Provider failed, the Run ended,
or the work was accepted. The Host's live diagnostics inspect only its own event
file identities and never parse or quarantine another producer's newer payload.

## CLI and Controller release boundary

The global `yui` command is the stable user and managed-Session interface. It
does not follow `runtime/active-release.json` for ordinary commands: that
pointer selects the Controller release, not the CLI package. This keeps CLI,
Operator Session, and Controller replacement compatible without pinning every
command to one immutable build.

A source-checkout or otherwise unverified local CLI is not this published
interface. When `YUI_HOME` already names an active release, such a CLI fails
before opening storage and reports its build/source, the durable Home identity,
and its invocation class. `make install-local` continues to default to the
checkout's isolated `output/dev/home`; explicitly pointing that launcher at a
release-owned Home is rejected.

An explicit `yui release activate <release-id|build-id>` is the one exception.
The global CLI verifies the installed target release and its matching smoke
receipt, then delegates the unchanged activation arguments to that target's
`dist/cli.js`. The target release therefore owns the complete handover protocol
and timeout hierarchy. A no-target activation, help, `--json`, and every other
command remain on the global CLI. Activation does not add another ordinary CLI
routing path.

## Step catalog

The plan is a fixed, predeclared subset of operations. Each plan entry has an
id (unique within the workflow), a kind, optional params, and an optional
irreversibility level (`none` | `reversible` | `irreversible`).

| Kind | External effect | Authoritative identity |
| --- | --- | --- |
| `pr-create-or-reuse` | Creates the release PR, or reuses an open one for the head. | `pull-request` number |
| `ci-confirm` | Reads the CI conclusion for the source ref; succeeds only on `success`. | — |
| `merge` | Merges the named PR (squash by default). | — |
| `version-tag` | Creates and pushes the annotated version tag. | `git-tag` name |
| `npm-publish` | Publishes the tarball to the registry. | `npm-package` version |
| `fresh-install-smoke` | Installs and runs the published package from the registry. | — |
| `cli-update` | Updates the Yui CLI/Controller home via the existing update orchestrator. | `controller-home` |
| `controller-replace` | Stops and restarts the file-task Controller. | — |
| `project-migrate` | Runs the Project migration through the existing project command. | — |
| `post-verify` | Runs an arbitrary verification command. | — |

Steps may reference earlier evidence: a param value of
`$externalId:<step-id>` resolves to the referenced step's confirmed external
id at run time, so a `merge` step can consume the PR number the `pr` step
produced without the operator knowing it in advance. A reference to an
unconfirmed step fails the run rather than guessing.

## Recovery and resume semantics

A run always starts from the **resume cursor**: the first plan step whose
status is not terminal (`succeeded` or `skipped`). There is no "start over" —
confirmed steps are never re-run.

Because every state transition is persisted before the next external call, a
process exit at any point is recoverable: re-invoke `run` (or `resume`) and
the engine continues from the first unconfirmed step. `--max-steps <n>` bounds
a single run; a run that exhausts its budget mid-workflow returns
`budget-exhausted` and the next invocation continues.

In-flight steps are resolved by **authoritative identity query**, never by
blind re-submission:

- A step left `running` or `unknown` is queried first by its recorded
  `externalIdentity`.
  - `exists` → the step reaches `succeeded` **without a second submission**
    (`unknown` is confirmed, `running` is completed).
  - `unknown` → the run stops with outcome `unknown`; the step is never
    re-submitted while its fate is unknowable.
  - `absent` → the effect never landed, so the step is re-attempted (a
    `running` step records the recovery attempt).
- A `running` step **without** an external identity crashed before recording a
  submission result. An irreversible step is queried through the port anyway
  (the adapter consults its durable idempotency store): `exists` confirms the
  step without a second submission, `unknown` stops as `unconfirmed`, and only
  an authoritative `absent` re-attempts the step exactly once. A reversible
  step always falls through and re-attempts under the same idempotency key.
- A timeout **without** an external identity marks the step as `unknown`
  (unconfirmed) so it is never re-submitted blindly; on resume it fails closed
  as `unconfirmed`.
- A `failed` step is retried on the next run; its `attempts` counter and logs
  grow per attempt.

Run outcomes: `succeeded`, `failed`, `unknown`, `unauthorized`,
`unconfirmed`, `budget-exhausted`. Each carries a machine-readable
`stopReason` (for example `unknown:publish`, `unauthorized:grant-revoked`,
`budget-exhausted:verify`) and the list of step ids attempted that run.

## Idempotency key contract

Each step's idempotency key is **predeclared at create time** and never
changes:

```text
<taskId>/<workflowId>/<stepId>
```

The key is passed to every `executeStep` call for that step, including
retries after a confirmed-absent timeout. The port contract requires
`executeStep` to be idempotent under the same key: a retried attempt must not
produce a second side effect. The engine side of the contract is stricter
still — it never blindly calls `executeStep` for an `unknown` step; it first
re-queries by the recorded identity. A deterministic core scenario checks
uncertain-effect queries, confirmed-step reuse and grant exhaustion against
real SQLite. This proves those engine boundaries, not the idempotency of real
external services or every release adapter.

## Operator guide

Session authority is checked against current durable bindings. Telemetry is
grouped by Role/AgentRun, and process owners use PID/start identity. Storage
changes follow the [single explicit upgrade boundary](sqlite-control-plane-design.md);
ordinary commands never rewrite the Home schema.

Grant issue and revoke are irreversible-authority operations. They require
the current registered global Operator conversation. Its native session ID
must match the durable live session binding: Codex commands use `CODEX_THREAD_ID`
when present, otherwise `YUI_NATIVE_SESSION_ID`; Claude uses `YUI_NATIVE_SESSION_ID`.
Host generation and launch-time Agent labels are not caller identity. Resuming
the same conversation through another entry point does not revoke its authority.
An unregistered, replaced, or ended conversation has no such authority.
A managed Task Agent cannot self-issue or
self-revoke a grant, and clearing the child-process environment does not
confer user authority. The recorded granter/revoker is bound to that
Operator session (`operator:<agent-id>`); there is no `--granter`/`--by`
label to spoof.

```sh
# 1. The Operator session issues the authority for the release chain.
yui task grant issue task-15 \
  --action pr-create-or-reuse --action npm-publish --action post-verify \
  --irreversibility-ceiling irreversible

# 2. Create the workflow against an exact source and a predeclared plan.
#    An npm-publish step requires a content-addressed source artifact: the
#    immutable workflow source can never gain one later, so a plan without
#    --source-artifact is rejected at creation.
yui task workflow create task-15 \
  --grant capability-grant-1 \
  --source-repo acme/widget --source-commit abc1234deadbeef0000000000000000000000000 \
  --source-artifact widget-1.0.0.tgz@sha512-<base64-integrity> \
  --step pr:pr-create-or-reuse \
  --step publish:npm-publish --step-irreversibility publish=irreversible \
  --step-param publish:tarball=./dist/widget-1.0.0.tgz \
  --step verify:post-verify --step-param verify:command='yui --version'

# 3. Run (or resume) and inspect.
yui task workflow run    task-15 release-workflow-1
yui task workflow resume task-15 release-workflow-1 [--grant capability-grant-2] [--max-steps 1]
yui task workflow status task-15 release-workflow-1

# 4. Revoke authority at any time; the next step stops unauthorized.
yui task grant revoke task-15 capability-grant-1
```

`workflow status` renders each step's status, attempt count, and confirmed
external id, so an operator can see exactly where a release stopped and why.

## Real-resource boundary

Real execution happens only through the `yui` CLI, which wires the real
adapter (`createReleaseWorkflowPorts`). The adapter is a thin shell over
existing atomic operations — `gh`, `npm`, `git`, the CLI update orchestrator,
Controller stop/restart, and `project migrate` — and it runs only when a human
granter has issued an explicit CapabilityGrant that passes `checkGrant` for
each step. A local test request never substitutes for that authority.

The tag-triggered `publish.yml` workflow is the only maintained release smoke.
It reuses the exact commit that passed core CI and adds only artifact assembly,
fresh installation, and provenance checks required to publish.

That workflow authenticates through npm Trusted Publishing (OIDC), so the
release identity lives in two places outside the tag: `repository`, `bugs`, and
`homepage` are copied verbatim from the source `package.json` into the published
manifest by `assemble-runtime-package.mjs`, and the package's npm Trusted
Publisher entry names the GitHub owner, repository, workflow file, and
environment. npm compares `repository.url` against the building repository
case-sensitively before accepting provenance. Renaming or transferring the
GitHub repository therefore has to update those URLs and the npm Trusted
Publisher entry together with the rename; otherwise the next tag reaches
`npm publish` and fails there, after the tag and the gated build already
succeeded.

## Adapter security hardening

The real adapter (`createReleaseWorkflowPorts`) applies additional safeguards
beyond the engine's grant checks:

- **Tarball option injection.** An option-looking tarball path (one starting
  with `-`) is rejected before any subprocess — both the `tar -xOf` manifest
  inspection and `npm publish` — sees it, so a crafted path can never be
  interpreted as a flag.
- **Tarball TOCTOU.** After the frozen `source.artifact.integrity` is verified,
  the verified bytes are snapshotted to a workflow-private, read-only temp
  file. Both the `tar -xOf` manifest inspection and `npm publish` read the
  snapshot, never the live tarball path, so a replacement of the original file
  after verification cannot change what is published. The snapshot is removed
  when the step completes.
- **Pinned external commands.** The adapter resolves the external commands it
  shells out to (`gh`, `git`, `npm`, `tar`, `sh`) to absolute paths at
  construction time via `resolveExecutable`, walking the caller's `PATH`
  once. Every subprocess invocation uses the resolved path, so a later `PATH`
  change (or a manipulated working directory) cannot redirect a release effect
  to a different binary. An unresolvable command returns a synthetic failure
  (exit 127) without invoking any binary.
- **Pinned cli-update activation target.** Before the irreversible update
  effect, the adapter persists the exact activation target — the Home plus the
  global npm prefix (`bin/yui`) — to a durable file under the Home
  (`release/cli-update-identity/<idempotency-key>.json`). A hard-exit recovery
  query (a step with no recorded identity) reads this file and invokes that
  pinned target; if the file is absent (the process exited before the
  pre-effect persistence), the query returns `unknown` rather than deriving
  the target from the resume caller's `npm prefix --global` or `PATH`, so a
  different installation in the resume environment cannot attest the step.
- **Controller lifecycle verification.** A `cli-update` recovery query proves
  the replacement Controller actually owns the target Home: it runs
  `yui --json controller status` (with `YUI_HOME` pinned to the recorded Home)
  and requires a `current` controller resource whose `yuiHome` resolves to
  that Home, then `yui --json controller identity` and requires the
  authenticated Controller identity to match the activated artifact: the
  Node.js executable path, the exact Controller entrypoint derived from the
  pinned global binary, and the package version. Binary health alone (doctor,
  `--version`) never confirms the handoff, and any unprovable state returns
  `unknown`. This applies to both the identity-bearing query and the
  hard-exit query (a step with no recorded identity).
- **npm integrity comparison.** An `npm-publish` recovery query does not stop
  at the published version: it fetches `dist.integrity` via
  `npm view <pkg>@<version> dist.integrity` and compares it byte-for-byte with
  the frozen `source.artifact.integrity`. A match confirms the step; the same
  version with different bytes is a conflict and returns `unknown` (never a
  confirmation, never a re-publish); a missing version is `absent`.
