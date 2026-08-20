# Verification levels

Yui is primarily a single-user local product. Its verification policy optimizes
for a fast feedback loop around the few failures that would make the product
unusable. It deliberately does not try to prove the whole repository on every
commit: users can install an earlier version, and a focused fix can be released
quickly when a non-core regression escapes.

| Level | Where | What it proves |
| --- | --- | --- |
| **L1 — targeted evidence** | local development | the behavior changed by this patch works under the smallest relevant test |
| **L2 — core tripwire** | `ci.yml` on PRs and `master` | Yui builds, its core storage/workflow/Agent Driver paths work, and the runtime package has the expected shape |
| **L3 — release smoke** | `publish.yml` on a tag | the exact artifact installs and starts on supported Node versions |

## L1: the change owns its specific risk

Run the smallest tests that exercise the changed behavior. A change outside the
L2 core list must still have targeted local evidence; absence from CI does not
mean the behavior is unimportant.

| Change touches | Minimal local evidence |
| --- | --- |
| pure logic, storage, parsing | affected Unit files |
| Controller, tmux, Session, lifecycle | affected Isolated Integration or Mock Agent Session files |
| package scripts, Skills, workflows | package smoke plus `test/core/core-package.test.js` |
| real Provider protocol | only the explicitly authorized Provider E2E scenario |

`npm test` remains the broad deterministic diagnostic suite. Use it when a
change is unusually cross-cutting or while investigating a regression; it is
not routine completion evidence and is not a merge gate.

## L2: a bounded core tripwire

`ci.yml` uses the disposable GitHub runner directly and has a three-minute hard
timeout. Its normal path should finish well below that limit:

1. `npm ci`, using the Actions npm cache;
2. `npm run test:core`, which builds TypeScript once and runs the explicit,
   serial file list in `scripts/run-core-tests.mjs`;
3. one runtime-package structure and CLI-start smoke.

The selected tests cover the core command framework, Task workflow and
scheduler, durable storage/schema delivery, runtime events, Agent Driver
registration, Codex/Claude observation adapters, and the runtime-status
projection. They do not start tmux Sessions, real Agent CLIs, or real models.

The list is intentionally explicit rather than a directory glob. New tests do
not silently increase CI time. Expanding it requires a product-level reason:
the failure must be both central to basic use and cheap, deterministic, and
local to detect. `npm run lint` is not repeated because `npm run build` already
runs TypeScript checking.

Stale runs for the same PR are cancelled. There are no retries, historical
baseline comparisons, or fresh-clone-within-runner. The GitHub job result is
the gate evidence. A failure is fixed or the change is corrected; a hang is
bounded by the job timeout.

## L3: release-only evidence

A release tag must point to `master`, and `publish.yml` confirms that the exact
SHA has a successful `ci.yml` run. It does not repeat the diagnostic suite and
adds only evidence unique to publishing:

- tag/version identity and npm provenance;
- one assembled tarball whose checksum is shared by all release jobs;
- package contents and executable-bit checks;
- a fresh install and `.bin/yui` start on Node 20, 22, and 24.

## Accepted residual risk

The core tripwire will not catch every regression, platform scheduling issue,
or Provider CLI change. This is intentional. Process-lifecycle, large storage,
full deterministic, Provider, and release-isolation suites remain available as
focused diagnostics. They are run when the affected code or an observed failure
justifies their cost, not on every commit.
