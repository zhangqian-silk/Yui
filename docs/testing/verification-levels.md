# Verification policy

Yui is a single-user local product. Permanent verification protects only the
few happy paths whose failure would make the product unusable; it is not a
historical catalog of every defect or edge case.

## Local development

Use the smallest evidence needed for the current change. TDD tests, repro
scripts, fault injection, and abnormal-data fixtures are temporary development
tools. Remove them when the requirement is complete unless they reveal that a
basic product path is absent from the permanent smoke.

Do not retain dedicated regression tests for malformed data, deletion,
retirement, archive, retry, rollback, recovery, old incidents, or combinatorial
compatibility. Revalidate those behaviors only when a change directly touches
them. This keeps maintenance proportional to current product value instead of
the number of bugs fixed over time.

## Permanent core smoke

`npm test` and `npm run test:core` build the checkout and run the same four
happy-path checks:

1. the packaged CLI starts and exposes setup/update/upgrade/Task commands;
2. one normal SQLite Task and Message survive a reopen;
3. the production migration graph advances a supported aggregate version;
4. the built-in Codex and Claude Drivers are registered.

The test phase should remain below two seconds on a normal development machine;
the TypeScript build is measured separately. Adding a permanent case requires a
product-level primary path, and overlapping coverage must be replaced rather
than accumulated.

## CI and release

`ci.yml` runs the core smoke plus one package-assembly/start check. It does not
run a second lint pass or a broader regression suite. `publish.yml` reuses that
exact gated commit and adds only tag, artifact, install, and provenance checks
that are unique to publishing.

Real Agents, providers, models, paid APIs, shared Homes, and production systems
are never implied by a request to test or validate. They require an explicit
user request for the exact resource and effect boundary.
