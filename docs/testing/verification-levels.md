# Verification levels

Yui separates verification evidence into three levels. Each level adds
evidence the others cannot substitute; running the same suite again at a
different level is not higher confidence, it is duplication.

| Level | Where | What it proves | Runs |
| --- | --- | --- | --- |
| **L1 — change-related targeted evidence** | local development | the changed behavior, under the smallest relevant check | on every change, sized to its risk |
| **L2 — PR global gate** | `ci.yml` on the PR / master exact commit | the whole tree builds, lints, passes the full deterministic suite, and packages, in a hermetic environment | once per exact commit, owned by CI |
| **L3 — release package smoke** | `publish.yml` on the tag | the exact published artifact is installable and runnable across supported Node versions | once per release, on the L2-passing commit |

## L1: risk-based local verification

For ordinary changes, run the smallest check set that can catch the changed
behavior. Do not repeat the full deterministic suite locally for a local fix —
that is L2's job, and CI owns the completion gate.

| Change touches | Minimal local evidence |
| --- | --- |
| pure logic, storage, or parsing in `src/` | the affected Unit test files (or the `unit` tier) |
| Controller / tmux / Session / lifecycle seams | the affected Isolated Integration or Mock Agent Session tests |
| packaging scripts, `skills/`, workflows, `package.json` | `npm run pack:dry-run` + `check-runtime-package-structure.mjs`, plus `test/core/core-package.test.js` |
| docs or Skill prose only | `npm run lint` and the tests that pin that prose |
| anything that changes `dist/` assembly or the bin entry | the package smoke above plus `node scripts/smoke-runtime-package.mjs` against a local install |

When a change spans several rows, run the union of their targeted checks. The
tier runner (`npm run test:tier -- <tier>`, see
[test-tiers.md](./test-tiers.md)) always establishes a fresh build boundary,
so a tier run is safe targeted evidence. Privileged tiers (Provider E2E,
Release E2E) stay opt-in and are never routine local verification.

## L2: the PR gate owns the full suite

`ci.yml` runs exactly once on the exact PR commit through the hermetic gate
runner (`scripts/gate-hermetic.mjs`): install, build, lint, the full
deterministic suite (Unit + Isolated Integration + Mock Agent Session, no real
model), and package structure smoke including the `dist/cli.js` `0755`
assertion. The runner is the L2 executable form — the same command gates a
local checkout, a CI checkout, and any exact SHA:

- **Hermetic environment.** Every run isolates `HOME`, the XDG config/cache/
  data tree, the global git identity (`GIT_CONFIG_GLOBAL`), `TMPDIR`, and the
  npm cache under a fresh root, and replaces `PATH` with the resolved
  node/npm/git/tmux directories followed by the standard system directories.
  The gate cannot silently depend on a developer's `~/.gitconfig`, a global
  npm cache, or a machine-specific `PATH` (a missing `tsc` or a fixture
  reading host config fails the gate instead of corrupting it).
- **Per-SHA gate record.** Each run writes `gate-record.json`: the exact
  commit SHA, the per-step pass/fail results with durations, and the
  environment the steps ran in. CI uploads it as the `gate-record` artifact —
  the durable, per-commit pass/fail evidence. A later PR or release consumes
  the record for that exact SHA instead of re-running the gate; repeating the
  same suite on the same SHA is not higher confidence.
- **Failure baseline.** When the gate fails, re-run with `--base <sha>` (the
  merge base). The runner gates the base in its own hermetic domain, isolated
  from the candidate's so neither side can leave writable state that changes
  the other's result. Classification is at the test-identity level: the `test`
  step streams TAP and the runner parses stable failing-test fingerprints
  (file plus nested test path) from it. A candidate failure is **pre-existing**
  only when its fingerprint is proven present on the base; a fingerprint the
  base does not have is **introduced**, and a base fingerprint the candidate
  no longer has is **fixed**. The other steps carry no comparable identity, so
  a failure on both sides is introduced (fail-closed). The run exits
  non-zero only for introduced failures, so a red base never blocks a change
  that did not cause the failure, and a new failure is never blamed on
  history.

Agents and humans do not re-run the suite to "approve" a change — the gate
record is the completion evidence. A flaky failure is fixed at its source; CI
must not depend on a human reading logs and clicking re-run.

## L3: release reuses the gated exact commit

A release tag must point at a master commit, so the exact commit being
released already passed L2 (branch protection requires the gate on master).
`publish.yml` asserts that link with `git merge-base --is-ancestor` and then
runs only what L2 cannot substitute:

- tag/version identity (`verify:release-tag.mjs`) and npm provenance;
- one assembly from the exact commit, with package structure and tarball
  `0755` assertions;
- a SHA-256 manifest binding the tarball to the commit, re-verified by every
  consumer of the artifact;
- a fresh install and `.bin/yui` execution smoke on Node 20, 22, and 24.

The release never re-runs the deterministic suite or lint. No remote artifact
service or release state machine is involved: GitHub Actions artifacts, the
commit SHA, and the npm pack manifest are the only evidence stores.

## Release regression contracts

Two regressions must fail before a bad artifact publishes:

- **Skill manifest / package structure (PR #109):** the runtime package ships
  exactly the four generic Skills; the count and names are asserted in
  `publish.yml` and pinned by `test/core/core-package.test.js`.
- **Executable CLI (PR #110):** `dist/cli.js` ships as `0755` in the tarball,
  stays executable after a fresh npm install (npm applies the process umask on
  extraction, so the installed mode may be `0700` — the contract is a surviving
  execute bit), and runs through `.bin/yui`. All three are asserted — the pack
  manifest alone is not proof.
