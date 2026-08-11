# Yui test tiers

Yui's own tests are organized into five **explicit, executable tiers**. The goal
is that a reader never has to guess what a test actually did: for every tier you
can tell, up front, whether it creates a Yui/native Session, whether it calls a
real model, and whether it creates a disposable real runtime. Historically many
tests were labelled "E2E" regardless of what they touched; this contract
replaces that ambiguity without retroactively relabelling old tests.

The tier definitions live in
[`test/helpers/testTiers.js`](../../test/helpers/testTiers.js) and are the single
source of truth. The runner is
[`scripts/run-test-tier.mjs`](../../scripts/run-test-tier.mjs)
(`make test-tier T=<tier>` or `npm run test:tier -- <tier>`). The supported
entrypoint always establishes a fresh `src/` → `dist/` build boundary, so it
works on a fresh checkout and cannot silently use a stale artifact (see
[Fresh build boundary](#fresh-build-boundary)). Extra Node test options use the
explicit contract `<tier> -- <extra node --test args>`.

| Tier | Creates Session | Calls real model | Disposable runtime | Isolation preflight | Opt-in |
| --- | --- | --- | --- | --- | --- |
| **Unit** | no | no | no | no | — |
| **Isolated Integration** | yes | no | yes | no | — |
| **Mock Agent Session** | yes | no | yes | no | — |
| **Provider E2E** | yes | **yes** | yes | **required** | `YUI_ALLOW_PROVIDER_E2E=1` |
| **Release E2E** | **no** | **no** | yes | **required** | `YUI_ALLOW_RELEASE_E2E=1` |

- **Unit** — pure logic and file-store tests. No Controller, tmux, Session,
  model, or global-environment side effect.
- **Isolated Integration** — repository integration against a disposable
  `YUI_HOME` and its own Controller/tmux namespace. May start a real detached
  Controller and tmux panes; **never** launches a real model.
- **Mock Agent Session** — creates an observable native Session driven by a
  deterministic local Mock Agent process, exercising real lifecycle/runtime
  seams with no model or network dependency.
- **Provider E2E** — drives a real Codex/Claude provider. This is the **only**
  tier that calls a real model; reserved for provider-specific behavior; gated
  behind opt-in and the isolation preflight.
- **Release E2E** — exercises binary/install/update/upgrade release flows under
  an isolated npm prefix. On its **normal path it creates no Agent Session and
  calls no model** — it verifies packaging/install/upgrade behavior against real
  npm/home/namespace resources. It is nonetheless **privileged**: it stays behind
  an explicit opt-in and must pass the mandatory isolation preflight, precisely
  because it touches those real release resources. It never claims
  provider-native acceptance.

### Privilege is independent of calling a model

Two facts that are easy to conflate are kept separate in the contract:

- **`callsModel`** — does the tier invoke a real provider/model? Only
  **Provider E2E** does.
- **privileged / opt-in** — is the tier gated behind an explicit opt-in env var
  and the isolation preflight? Both **Provider E2E** and **Release E2E** are.

The runner's gate keys on **privilege**, not on `callsModel`: Release E2E is
blocked without `YUI_ALLOW_RELEASE_E2E=1` and its block message honestly says it
"touches real npm/home/namespace release resources" rather than claiming it
"calls a real model".

## Mock transport is not provider acceptance

> **Mock Agent Session transport success does not prove provider-native
> acceptance.**

A Mock Agent Session proves that Yui's launch → session → lifecycle → cleanup
seams work end to end with a real local process. It does **not** prove that a
real Codex or Claude provider would natively accept the same prompt. Only the
Provider E2E tier can record provider-native acceptance; the evidence recorder
enforces this — a Mock or Unit tier that tries to claim a model call or provider
acceptance throws.

## The default suite never launches a real model

`npm test` (and `make test` / `make check`) runs the full **deterministic**
suite — Unit, Isolated Integration, and local Mock Agent Session tests under
`test/` and `test/core/`. It never launches a real model and never touches the
global `yui` binary, a shared `YUI_HOME`, or an existing production Session.

To keep that guarantee even when the suite is launched *from inside* a managed
Yui Session, `npm test` runs with
[`test/helpers/scrubSessionEnv.js`](../../test/helpers/scrubSessionEnv.js)
preloaded (`node --import`). That preamble removes the managed-Session
environment registry exported by production code: shared `YUI_HOME`, Session,
Task, Run and launch identity, exact `YUI_LEADER_ACTION_*` assertions, workspace
projections, and Agent command/base-argument descriptors. The test helper does
not maintain a second name list. A test that touches Home/CLI/Controller/tmux
must create and explicitly supply its own isolated Home. The package and tier
runners clear the opt-out; only a dedicated managed-identity child may set
`YUI_TEST_KEEP_SESSION_ENV=1` for its own process.

The preamble also prepends deterministic refusal shims for bare `codex` and
`claude` commands. A forgotten Mock Agent therefore fails locally instead of
reaching an installed Provider. Tests that exercise a managed Session use
[`installMockProviderCommands`](../../test/helpers/mockProviderCommands.js) to
place an observable, long-running local process under the creator-owned
`YUI_HOME/runtime/bin`, which production launch planning already puts first on
`PATH`. Provider E2E is the sole exemption, and only when selected through its
opted-in runner and mandatory privileged preflight; Release E2E remains blocked
from Provider commands. The default package script clears inherited tier and
privileged-manifest markers, and a tier label without the exact runner-owned
Provider manifest cannot disable the shims.

## Isolation preflight (Provider / Release only)

Before a Provider or Release run touches anything real, it must pass the
blocking preflight in
[`test/helpers/isolationPreflight.js`](../../test/helpers/isolationPreflight.js)
(`assertIsolationReady`). The preflight **fails closed**: every invariant must
be satisfied by an explicit resolved fact, and it rejects — with no guessing or
fallback:

- a bare `yui` resolved through `PATH` (it requires the **absolute**
  checkout-local launcher, `<checkout>/output/dev/bin/yui`, carrying the managed
  marker);
- the `make link` global launcher (a symlink, or any path outside the checkout);
- an **arbitrary absolute parent used as the run root**. The run root is not
  trusted just because it is absolute, and it is not trusted just because a
  directory happens to exist under a temp base. Ownership is **creator-bound**:
  the supported normal path calls `createOwnedRunRoot`, which makes the directory
  with `mkdtemp` and writes a receipt (`.yui-run-owner`) carrying a fresh random
  token; `gatherRunRootOwnership` then reports `ownedByRun: true` only when that
  exact token is presented back. A pre-existing foreign temp directory carries no
  matching receipt, so it is never accepted. The proof is also **physical**, not
  lexical: a symbolic-link run root is rejected outright, and the run root is
  canonicalized (every symlink component resolved) and required to sit strictly
  inside the canonical temp base — so a symlink under a fresh temp base that
  points at the checkout is refused even though it looks nested. YUI_HOME,
  workspace, npm prefix, and tmux namespace are all derived *within that exact
  owned root*, and `assertIsolationReady` runs an extra **physical containment**
  pass (`evaluatePhysicalContainment`) that canonicalizes each derived path's
  existing components, so a derived path whose ancestor symlinks out of the owned
  root is rejected even when it is lexically nested;
- a shared `YUI_HOME` (the checkout dev home, `~/.yui`, or anything outside the
  disposable owned run root);
- the **global** npm prefix (it requires an isolated prefix inside the owned run
  root), and it refuses to run if the global prefix cannot even be resolved;
- a tmux/Controller namespace not derived from the disposable `YUI_HOME`;
- running while an active production Session is observed. This is **fail-closed
  on the evidence itself**: the run must present an explicit
  `activeSessionObservation` with `observed: true` and a real `sessions` array
  (built via `recordActiveSessionObservation`). A missing observation, or one
  whose `observed` flag is not true, is rejected — the preflight never defaults
  missing evidence to an assumed-empty safe list. Only an explicit observation of
  *zero* Sessions passes.

## Structured evidence

Every tier records evidence through
[`test/helpers/testEvidence.js`](../../test/helpers/testEvidence.js). A report
states, explicitly: the tier; whether a Session was created; whether a real
model/provider was called; whether provider-native acceptance was proven; the
absolute binary source; `YUI_HOME` and workspace; runtime-namespace ownership;
the cleanup outcome; and the remaining **verification gaps**. The recorder
refuses to write a claim stronger than the tier allows, so a report can never
quietly overstate what was proven.

The Mock Agent fixture records its report against the real local process it
launched: `binarySource` is the absolute Node executable, the `runtime-launch`
check names the Mock executable plus the production `dist/`
`FileRoleLaunchPlanner`/`TmuxSessionHost` seam, and namespace ownership carries
the disposable Home, tmux server, and creator receipt token. That token is test
evidence, not synthetic production-domain state. Its report also states that no
detached Controller, Provider E2E, or Release E2E run occurred.
Cleanup remains `pending` while any pane/runtime/root exists; it becomes
`success` only after runtime teardown returns and the creator-owned outer root
is confirmed absent. A teardown error is recorded as `error` before it is
re-thrown.

## Provider / Release execution recipe

The Provider and Release manifests live under `test/privileged/`, which is
structurally outside the default `test/*.test.js test/core/*.test.js` selection.
They intentionally remain empty until a real scenario is implemented. Empty
means **not run**, not passed. A non-empty manifest is dispatched only through
`test/privileged/privileged-tier.test.js` and
`test/helpers/privilegedTest.js`; there is no direct privileged test-file path.
The wrapper performs this order:

1. Resolve the checkout and its launcher to absolute paths. The launcher must
   be exactly `<checkout>/output/dev/bin/yui`; never use bare `yui`, `make link`,
   or a global install.
2. Call `createOwnedRunRoot` and derive every mutable path below its
   `canonicalRunRoot`: `runtime-domain/yui-home`, `workspace`, `npm-prefix`, and
   the Home-derived tmux namespace. Do not create those resources yet.
3. Register the runner-owned `node:test` cleanup proxy immediately, before
   observing Sessions or importing/running the scenario. If preflight rejects,
   the proxy removes the exact creator-owned root without evaluating the
   scenario module. Once a scenario has loaded, the proxy first invokes its
   required cleanup and then removes that root. Cleanup evidence stays
   `pending` until the full teardown succeeds; on error it must call
   `recordCleanup("error", ...)` and throw.
4. Through the privileged runner's fixed all-scope Yui runtime inventory,
   observe active Sessions and pass their exact resource identities to
   `recordActiveSessionObservation`. Scenario code cannot provide or replace
   this observer. The returned `sessions` must be an explicitly observed empty
   array; inventory warnings or unavailable observation fail closed. Never
   substitute `[]` because observation was unavailable.
5. Call `assertIsolationReady` with the owned-root proof, absolute local
   launcher, all derived paths, isolated npm prefix, Home-derived tmux server,
   resolved global npm prefix, protected Homes, and the explicit zero-Session
   observation. Call `recorder.recordPreflight(result)`. No setup, Controller,
   provider, npm install, or other side effect may precede this point.
6. Only after preflight, evaluate the scenario module and invoke its `run`
   export. Top-level scenario code is therefore unreachable when preflight
   fails; this is enforced by the runner rather than by a side-effect-free
   import convention. The body may now create the isolated runtime/Home and run
   the bounded scenario. Every launcher invocation remains absolute and
   receives the derived `YUI_HOME`; every npm invocation receives the derived
   prefix/cache.
7. Record only observed facts. Provider E2E may call
   `markModelCalled`/`markProviderAccepted` after native acceptance of the exact
   Run. Release E2E creates no Session on its normal path and can never record
   provider acceptance. Render/persist the final report only after cleanup has
   terminalized.

Register a scenario in its tier-local `manifest.json`:

```json
[{ "name": "bounded provider behavior", "module": "scenario.mjs" }]
```

`scenario.mjs` must export `cleanup(context)` and
`run(testContext, context)`. Active-Session observation belongs to the runner,
not the scenario. The runner registers a cleanup proxy before observation; the
module itself is not loaded, and neither scenario export is reachable, unless
the explicit zero-Session observation and every isolation check pass.

Provider and Release recipes diverge only after this common boundary:

- Provider E2E launches the confirmed provider/model inside the disposable
  runtime, records the exact Session/Run/native acceptance fence, and notes all
  provider behavior it did not verify.
- Release E2E sets both npm prefix and cache below the creator-owned run root,
  installs or upgrades only inside that sandbox, and checks the installed
  absolute binary.
  It must not mutate the user/global npm prefix, global `yui`, shared Home, or
  any existing Session.

## Fail-closed cleanup

The deterministic real-runtime tiers use
[`test/helpers/isolatedRuntime.js`](../../test/helpers/isolatedRuntime.js). Its
`node:test` teardown runs on pass, assertion failure, and cooperative
timeout/cancellation/interruption while the test process can unwind. Cleanup
scans only the exact creator-owned `YUI_HOME`, rejects foreign-Home resources,
and delegates process/pane/artifact removal to Yui's start-identity- and
target-fenced `cleanControllerResource`. The exact Home-derived tmux server is
then stopped and queried for absence; cleanup succeeds only after a final
inventory contains no resource for that Home. Environment overrides cannot
redirect `YUI_HOME` away from the owned root. Home-local Mock Agent processes
carry that exact `YUI_HOME`, so the same fenced inventory and teardown owns
them; deleting a temp directory is never used as a substitute for stopping the
process first.

[`test/helpers/fencedCleanup.js`](../../test/helpers/fencedCleanup.js) is the
reusable selection gate for future drivers that annotate resource records with
their external creator receipt. It requires both the exact token and a matching
`ephemeral-test` marker before delegating to `cleanControllerResource`; it is
not production domain metadata and the isolated runtime does not write it into
Yui state.

No in-process hook can run after an OS hard kill (`SIGKILL`), host/process loss,
or power failure. Those boundaries remain an explicit verification gap, not a
claimed cleanup success. Recovery belongs to an external driver that retained
the exact creator receipt plus owned Home and can invoke the same
identity-fenced inventory/cleanup; this foundation does not add a supervisor,
PID/name/age guessing, or broad temp-directory scan.

The reusable annotated-resource selector is **always** double-gated and has no
escape hatch:

- the caller must supply the exact **non-empty ephemeral-test ownership token**.
  A missing or empty token does not fall back to a weaker rule — the pass
  touches nothing, **and** it is reported as a **failed outcome** (`ok: false`
  via a pass-level error). Registered teardown therefore **fails loudly** rather
  than passing while owned resources leak behind a "successful skip";
- the resource's domain must be exactly `ephemeral-test` **and** its token must
  match the expected token. The domain fence cannot be disabled — there is no
  option to clean an unmarked domain.

Only resources marked `safe`/`review` **and** annotated with the exact
disposable `ephemeral-test` receipt are selected. Unknown, unmarked,
foreign-token, `protected`, and `report-only` resources are left completely alone
— there is no `pkill`, no broad kill, and no name/PID/age matching. Skipping
those resources **with a valid token present** is an intentional, clean outcome
(not a failure). A cleanup error on one resource is remembered but does not
strand the rest of the domain.

## Fresh build boundary

The tier tests import Yui internals from `dist/` (the compiled TypeScript
output). The supported entrypoint (`scripts/run-test-tier.mjs`, i.e.
`make test-tier` / `npm run test:tier`) runs the canonical TypeScript build
exactly once before every non-empty tier via
[`test/helpers/ensureDistBuilt`](../../test/helpers/ensureBuild.js):

- a present `dist/cli.js` is never accepted as freshness evidence;
- `npm run build` must succeed before any tier file is loaded;
- a build spawn/non-zero failure is surfaced and the tier body stays unreachable.

The default `npm test` path owns the same boundary through `pretest`. A raw
`node --test dist/...` invocation bypasses the supported freshness guarantee.
