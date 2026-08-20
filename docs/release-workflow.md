# Release workflow

A release workflow is an authorized, auditable, recoverable orchestration of
external release effects — pull requests, CI confirmation, merges, version
tags, npm publishes, fresh-install smoke tests, CLI updates, Controller
replacements, Project migrations, and post-verification. Instead of an
operator typing each command by hand, the workflow drives a predeclared plan
from durable state: every transition is persisted before the next external
call, so a crash, timeout, or revoked grant never leaves the release guessing.

Two task-level record families back it:

- **CapabilityGrant** (`capability-grant-N`) — the authority. A named granter
  scopes a grant to actions, parameter bounds, an expiry, a use count, and an
  irreversibility ceiling.
- **ReleaseWorkflow** (`release-workflow-N`) — the plan and its progress: an
  exact source (repository + pinned commit, optionally an artifact), an
  immutable ordered step plan, and one persisted record per step.

The engine (`src/release/releaseWorkflowEngine.ts`) is a pure library; the
`yui task workflow` and `yui task grant` commands drive it. Every external
system sits behind `ReleaseWorkflowPorts`
(`src/release/releaseWorkflowPorts.ts`), so the whole workflow is testable
with deterministic fakes and no real GitHub, npm, git, Controller, or process
side effect.

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
still — it never calls `executeStep` for a step it has marked `unknown`; it
re-queries by the recorded identity instead. The fakes record every key, so
the test suite proves at-most-once execution directly.

## Operator guide

Grant issue and revoke are irreversible-authority operations. They require
the authenticated global Operator session: the command must run inside the
Operator role's launched session, whose env claims are verified against the
durable live session binding. A managed Task Agent cannot self-issue or
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
  --source-artifact yui-0.5.3.tgz@sha512-<base64-integrity> \
  --step pr:pr-create-or-reuse \
  --step publish:npm-publish --step-irreversibility publish=irreversible \
  --step-param publish:tarball=./dist/yui-0.5.3.tgz \
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

The deterministic suite — `test/core/release-workflow-engine.test.js` and
`test/release-workflow-acceptance-e2e.test.js` — drives the engine and the
operator command surface exclusively through `createFakeReleasePorts` against
an isolated temp `YUI_HOME`. It never touches real GitHub, npm, git, the
Controller, or a user home, and it never issues a real grant: the grants in
tests are fake records standing in for operator authority.

Real execution happens only through the `yui` CLI, which wires the real
adapter (`createReleaseWorkflowPorts`). The adapter is a thin shell over
existing atomic operations — `gh`, `npm`, `git`, the CLI update
orchestrator, Controller stop/restart, and `project migrate` — and it runs
only when a human granter has issued an explicit CapabilityGrant that passes
`checkGrant` for each step. The test suite never substitutes for that
authority.

The privileged **Release E2E** tier (install/update/upgrade under an isolated
npm prefix) is separate: it is opt-in (`YUI_ALLOW_RELEASE_E2E=1`), passes the
mandatory isolation preflight, and is never part of core CI or the deterministic
diagnostic suite. See
[docs/testing/test-tiers.md](testing/test-tiers.md).

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
