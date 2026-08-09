# Yui Architecture

Yui is a local control plane for durable work across Projects and native Agent
runtimes. The user talks to one Operator. The Operator routes each request to
the right Project and Task; that Task's Leader owns decomposition, execution
choice, review, integration, and completion.

## One work model

`WorkItem` is the only bounded unit of work. It holds the objective, acceptance
criteria, dependencies, assigned Task Role when applicable, lifecycle, and a
compact reviewed result.

A Leader chooses one of three execution paths for each WorkItem:

1. **Direct**: the Leader executes a roleless WorkItem.
2. **Native subagent**: the Leader creates a child through its current Agent
   conversation. The child inherits the Leader Agent and is not a Yui entity.
3. **Task Role AgentRun**: Yui dispatches a Role-bound WorkItem to a
   Task-managed native Agent Session.

There is no Yui subagent launcher, child-session record, or second bounded-work
model. Direct work and native subagents use the WorkItem lifecycle. Managed
independent execution additionally records an AgentRun.

## Profiles, Roles, and Agents

- `Agent` selects a supported adapter such as Codex or Claude and defines its
  launch context.
- `WorkerProfile` is a versioned, provider-neutral behavior template containing
  instructions, Skills, a read/write behavior intent, and optional model/effort hints.
- `TaskRole` is a mutable Worker instance inside one Task. Applying a Profile
  copies its portable behavior. Its versioned desired launch configuration is
  next-launch-only. The Role may bind multiple Agents; every binding retains
  independent runtime configuration.
- `AgentRun` records one managed dispatch and an immutable effective snapshot:
  actual Agent, adapter, model, effort, Profile behavior intent, exact writable
  Projects, provider permission strategy and native options, workspace, Role
  context, and source desired revision. A native Role Session stores the same snapshot; running processes
  are never hot-mutated by later Role edits.
- A `WorkItemCandidate` is the explicit result currently awaiting Leader
  acceptance. It snapshots the WorkItem revision, summary, and either a
  yielded execution Run or a Leader-managed direct source.
- `ReviewRound` records review of one candidate under the same WorkItem and
  references that immutable candidate. It is not another WorkItem.

Adding another Agent requires an explicit adapter implementation. Profiles do
not choose adapters, own Sessions, or carry credentials.

For a native subagent, the Leader must choose and read an explicit
WorkerProfile, using `worker` when no specialist fits. The Leader includes the
Profile instructions, Skills, behavior intent, workspace boundary, validation expectations, and
supported model/effort hints in the child brief. Task Role Agent bindings are
ignored because the child inherits the Leader Agent. The reviewed WorkItem
summary records the actual Profile revision, inherited or confirmed model and
effort, round, result, and checks.

## Lifecycle and acceptance

Direct and native-subagent work follows:

```text
todo -> running -> done | failed
                -> awaiting Leader decision  (when review is configured)
```

Task Role work follows:

```text
todo -> running -> awaiting Leader review
                      | accept -> done
                      | reject -> failed -> redispatch -> running
```

Worker yield ends the AgentRun and submits its result for review. It never
accepts the WorkItem. The Leader checks semantics, evidence, and Git state,
then accepts or rejects with bounded feedback. A rejected isolated WorkItem
keeps its workspace so the next Run can repair the same result.

An optional global review rule names one existing Global Role and chooses
`always` or `leader`. It is a live default for every Task; each Candidate
snapshots the effective two-field rule when submitted.
Every result awaiting acceptance is stored as an explicit WorkItem candidate.
`always` dispatches a review AgentRun for every candidate, whether it comes
from a yielded execution Run or a Leader-managed direct result; `leader`
leaves every candidate for the Leader to accept directly or review explicitly.
Review Runs complete only their exact ReviewRound, leave the WorkItem awaiting
acceptance, and never trigger another review or append a Candidate. Successful
and failed review attempts both wake the Leader and remain evidence for
judgment, not a machine verdict. The ReviewRound stores its frozen Candidate
base, isolated workspace provenance, complete free-form report, optional
structured checks, and optional diagnostic commit. The Leader may route that evidence to the original Worker, but Yui
never merges it automatically.

Roles describe Agent capability, but they do not own repository workspaces. A
`ManagedWorkspace` is keyed by its durable owner (`Task`, `WorkItem`,
`ReviewRound`, or `IntegrationAttempt`); an AgentRun carries only a launch
snapshot. Review workspaces are fresh writable copies at the Candidate's
frozen commit, so diagnostics cannot redirect Develop or become a ChangeSet
source. Each ReviewRound has an independent lifecycle and explicit cleanup.

Dependencies are enforced at dispatch. A Role cannot have overlapping active
Runs, and terminal Task state fences new messages, dispatches, retries, and
late results until explicitly reopened.

## Project workspaces and integration

Stable Project checkouts are read-only references. Task identity follows one
bounded outcome rather than Project count. A Task binds zero or more Projects,
records an independent base ref for each binding, and owns one workspace root
containing a managed main worktree for each binding. The
`<workspace>/tasks/<task>/main` root is a logical multi-Project container, not a
Git repository. Each Project child (for example
`<workspace>/tasks/<task>/main/yui`) is the supported Git cwd and points to
`<workspace>/worktree/<project>/<task>/main`; Git commands run in that child.
The Leader runs from this root and sees every Project as a peer directory. The active Leader may append a
Project when the same outcome expands; replacing an existing binding is not a
scope-repair mechanism.

A WorkItem can read the full Task workspace but has an explicit Project write
scope. Isolation creates a second root with independent worktrees for writable
Projects and Task-main context for the rest. The managed dispatch and
`yui-worker` Skill name both sets explicitly; the Agent must modify only the
writable set. Provider permission is binding configuration: every managed Role
defaults to `bypass`, while `default` and `configured` preserve provider-native
behavior. Provider permission and Profile access intent do not grant Project
writes. A normal source write requires an exact WorkItem write scope and
matching managed workspace; a review write instead
requires an exact ReviewRound owner and frozen Candidate base. Profiles and
Skills constrain behavior even when provider prompts are bypassed. Provider
permissions remain Session-wide rather than Project-specific, so the durable
workspace owner and exact Project scope remain the authorization boundary.
Scope is monotonic. A Worker cannot expand it directly: it reports the need,
and the Leader either adds Projects to the existing scope, creates another
WorkItem, or adds the Project to the Task.

An isolated result is handled in this order:

1. the Worker yields;
2. the Leader reviews semantics and evidence;
3. Yui captures each writable Project HEAD as an immutable Project ChangeSet;
4. each Project integration applies its latest reviewed ChangeSet in a candidate worktree;
5. configured checks run;
6. compare-and-swap advances the target only if its HEAD is unchanged;
7. the Leader accepts the WorkItem;
8. clean Integration, ReviewRound, and WorkItem resources are explicitly
   removed.

Capture at the same HEAD reuses the existing ChangeSet. A repaired HEAD creates
a new candidate; only the latest reviewed candidate may satisfy acceptance.
An isolated WorkItem cannot be accepted or a Task completed while any writable
Project's latest result is uncaptured or unintegrated. Workspace roots are
multi-Project; ChangeSets and Integration Attempts remain single-Project Git
boundaries.

Conflicts store a compact report and block. The Leader chooses rejection or
manual resolution in the retained candidate worktree. Failed checks, rejected
results, conflicts, target movement, and abandoned work never advance the
target. Full check output is streamed to cleanable artifact files; durable
records retain compact evidence.

## Durable context

Native transcripts remain native to their Agent. Yui persists only the control
and knowledge needed to resume and audit work:

- Task Brief: objective, boundaries, cross-Project technical approach, current
  focus, and Leader summary;
- Decisions: material choices and supersession;
- Milestones: independently useful phase outcomes;
- Project Knowledge: stable facts reusable across Tasks;
- WorkItems, Roles, AgentRuns, Messages, InputRequests, Events, ChangeSets, and
  integration evidence.

The Leader updates the Brief before every yield, records material choices as
Decisions, records phase outcomes as Milestones, and promotes only cross-Task
stable facts to Project Knowledge. `task context` is the consolidated recovery
read; launches and wake messages carry record pointers rather than copied
context.

## Runtime ownership

tmux owns native Agent terminals. The Controller owns mailbox delivery,
wakeups, Role liveness, reconciliation, and read-only Web observation. Operator
and Leader Sessions are fixed Task/global Roles; Task Worker Sessions are
selected through Role Agent bindings.

Role desired revisions and Run/Session effective snapshots keep configuration
history explicit. Resume compares the complete effective snapshot and
workspace compatibility rather than revision alone. Desired drift is expected
while an old process is running and becomes effective only on a later launch;
control-plane wakes continue through the live Session's actual snapshot, and
fresh replacement archives the stopped snapshot instead of rewriting it.
Mailbox generations, reservations, liveness, native Turn Hooks, and exact yield
remain the control-plane authority; configuration snapshots do not replace any
of those completion fences. Lifecycle code uses structured Hook data, persisted identities, tmux
process state, receipts, and pane fences. It never parses Agent terminal glyphs,
progress text, trust dialogs, or final prose to infer readiness or success.

All durable writes use process locking and atomic replacement. Storage validates
record identity, legal transitions, dependency cycles, cross-record ownership,
immutable Git evidence, and current Controller protocol compatibility. Worktree
cleanup revalidates ownership and fails safely when concurrent state changes;
manual retry is the recovery boundary rather than another durable state
machine.

Storage compatibility is modeled on three independent, monotonic version axes:
`layout` (on-disk `schema.json`, `state.json`, locks), `aggregate` (the
authoritative document), and `record` — a `recordKind -> version` map so each
record family versions on its own. A centralized migration framework
(registry → planner → engine) is generic and domain-free: the engine is
parameterized over an injected `MigrationTarget` and never hardcodes a Yui
record list. Compatibility is decided **only** by explicit registered step
paths, never by version magnitude or semver. The registry ships **empty** in
this release — there are no historical steps — so every strictly-older home is
fail-closed. `doctor`/`upgrade` classify a home as USABLE, MIGRATABLE,
NEEDS_NEW_VERSION (with a `future-version` or `missing-step` reason plus the
incompatible layout/aggregate component), or CORRUPTED — the last only for real
structural/reference damage, never inferred from a version number.

The three axes are genuinely independent, including the record axis. The
scalar `layout`/`aggregate` versions come from `schema.json`; the per-family
`record` versions are extracted **structurally** from the raw `state.json`
(read-only JSON traversal following each family's `recordKind -> {version,path}`
locator), *never* through the strict `FileTaskStore` loader. This matters
because the loader validates every record against the current release and throws
on the first older family — which would misreport a home whose only difference is
an older record family as CORRUPTED and block it from ever migrating. Reading the
record axis structurally keeps a record-only-older home on its version axis: it
plans as MIGRATABLE (with a step path) or NEEDS_NEW_VERSION (fail-closed under the
empty registry), exactly like an older scalar axis. The strict loader is used
only to detect a broken reference graph, and only once **every** axis is already
current (a no-op plan) — the one case where a load failure is genuine corruption
rather than a version mismatch. CORRUPTED is otherwise reserved for real
structural JSON damage: an unparseable `state.json`, a container whose shape does
not match its locator, or a record with a missing/invalid `schemaVersion`.

`yui upgrade` is the transactional storage-migration entry point. Execute mode
places an **admission fence** honored at every authoritative write choke point,
so baseline CLI writers and the Controller (which mutate through the same store)
refuse to begin a new write while an upgrade owns the Home; the fencing process
itself is exempt. Durable runtime-inbox `publish` participates in a separate,
shared sibling coordination boundary: `<home>.upgrade-coordination.lock` lives
outside the Home and serializes the complete inbox write with the final
snapshot/copy/two-step switch. A publish acquires that lock, then checks the
fence and any unresolved `<home>.upgrade-switch.json` marker before its
temp/link/fsync sequence. Upgrade acquires the same lock after Controller drain,
proves both runtime lanes, re-pins under `.state.lock`, stages the complete
Home, and holds the coordination lock through `home -> backup` and
`staging -> home`. A hook that passed admission before the fence therefore either
finishes under the lock and is copied into promoted Home, or waits and receives a
structured `UpgradeFenceError` that permits re-delivery; it cannot be silently
dropped into backup-only storage. With no fence, normal hook behavior is unchanged
apart from this shared serialization point. **Fence acquisition is a single atomic
`O_CREAT|O_EXCL` create** — the kernel guarantees exactly one of any number of
concurrent upgraders wins that create, so there is no check-then-write window in
which two upgraders both believe they acquired; a loser either re-enters (it
already owns the fence), reclaims a *provably-dead* owner's stale fence and
retries, or fails closed for a live/undeterminable owner. **Stale-fence reclaim
is itself atomic (compare-and-delete under a `mkdir` critical section):** the
reclaim re-reads the fence bytes under the lock and deletes *only* the exact
dead-owner bytes it observed, so a racer that slipped a fresh live fence into the
same path between the observe and the delete is never clobbered — closing the
reclaim TOCTOU that could otherwise let two entrants both acquire. **That
critical-section lock is itself crash-recoverable** (mirroring the storage lock's
dead-owner reclaim): it records its owner pid, and a lock left behind by a
crashed holder is reclaimed by a later entrant once its owner is provably dead
(or it is older than a small age bound), so a mid-reclaim crash can never
permanently orphan the lock and strand admission (R2-F4). When a reclaim cannot
be proven complete, `assertHomeWritable` re-verifies and refuses rather than
falsely reporting the home writable, and a dead-owner fence is never left
indefinitely stranding writers. There is no lease or multi-round negotiation.
The coordination lock uses the same bounded crash-recovery rule as other Home
locks: it records an owner PID, waits only a bounded interval, and atomically
renames aside a lock whose owner is provably dead (or whose owner-less directory
is older than the conservative acquisition window). A live or undeterminable
holder fails closed; a switch-progress marker blocks hook admission when the
Home is missing or uninitialized (including a malformed marker), while a stale
marker beside an intact Home is ignored after filesystem corroboration. Lock
ordering is one-way — coordination lock, then `.state.lock`; inbox writers
never acquire `.state.lock` — so the cutover cannot deadlock on a reverse order.
The fence is enforced by every writer built from this release forward (its check
lives in the shared store-commit path); it cannot retroactively bind an
already-installed older binary, so cross-release
concurrency is instead handled by the quiesce step and the recommendation to
stop all Yui activity for the home before upgrading. It then drains the
Controller with the public `controller.stop`/shutdownAndDrain (never a broad
kill, never a TTL or idle heuristic), fails closed if any foreign writer, live
Controller, or held `.state.lock` remains, and proves BOTH durable runtime lanes
empty — the aggregate `state.json` runtime-lifecycle mailboxes AND the durable
runtime inbox `runtime/inbox/*` (authoritative not-yet-applied native-hook
events; per task-1 / message-8 §3, either non-empty is a `drain-incomplete`
blocker). The inbox is proven empty **read-only** (a plain directory scan for
committed `*.json` events, in-progress `.tmp-*` writes, and quarantined
`runtime/inbox-invalid` entries) — never via the inbox's own `list()`, which
would quarantine as a side effect, so the check never mutates the source; an
unreadable inbox directory fails closed. This matters because the no-Controller
/ stale-event path reaches quiesce with inbox entries still on disk, and an
atomic switch must never silently drop them. The read-only quiesce proof is
performed only after acquiring the shared coordination lock; an admitted hook
that was still completing cannot cross that lock, and a hook that waits sees the
fence and fails explicitly. The cutover then re-pins the committed revision
under the write lock after the drain (avoiding a
check-then-migrate race), migrates the immutable source into a fresh staged home,
validates it
through the real `FileTaskStore` loader gate (record parse + reference graph),
then atomically switches into place with a timestamped backup and a post-switch
health check. Any blocked or failed step leaves the authoritative home
byte-for-byte unchanged and reports the exact stage and recovery action;
`--dry-run` runs through the validation gate and discards the
staged output without switching. This release never migrates a real home (the
registry is empty); the machinery is future-facing.

**Uninitialized home is an actionable blocker, not a no-op.** An
uninitialized home (never `yui setup`) has no storage to migrate. The classifier
reports it as USABLE (nothing is *wrong* with it, so `doctor` may present it
as-is), but the *upgrade* path would otherwise collapse that verdict into a
silent no-op against a home that was never set up. Upgrade therefore returns a
structured `uninitialized` blocker ("run `yui setup`") — never an unclassified
runtime error and never a false success.

**Complete home content preservation contract.** A migration only *transforms*
`schema.json` + `state.json`, but the atomic switch replaces the **whole** home
directory (`home -> backup`, `staging -> home`). Staging that held only those two
files would silently drop everything else the real home persists — `runtime/`
discovery, `runtime/inbox/*` (AUTHORITATIVE, not-yet-applied events), `cache/`,
`artifacts/`. The chosen contract (implemented in `writeFreshOutput`) is that
**staging carries a complete copy of the home**: every other entry (any depth:
dirs, files, symlinks) is copied verbatim, and only `schema.json`/`state.json`
are overwritten with their migrated bytes. So the switch preserves all
authoritative and rebuildable content — and the timestamped backup retains the
original of everything too. The transient `.state.lock` is the one exception: a
lock is per-instance coordination state, never authoritative content, so it is
not promoted into the migrated home. The staging directory is required to live
*outside* the home (an in-home staging layout is refused at construction), so the
copy never excludes a home entry merely because it shares the staging directory's
name — a real home entry named `home.upgrade-staging` is preserved like any other.

**Partial (two-step) switch is reported honestly, never as "unchanged".** The
atomic switch is two renames — `home -> backup`, then `staging -> home` — with one
non-atomic window between them, tracked by a durable sibling progress marker
(`<home>.upgrade-switch.json`) whose phase distinguishes *not-started* /
*backing-up* / *promoting* / *interrupted* / *complete*. The invariant that drives
error handling: **before** the first rename commits the home is intact and any
failure is a clean pre-switch error ("source unchanged", which is true);
**after** it commits, *every* subsequent operation — the post-rename fsync, the
`promoting` marker write, the promote rename, and the post-promote fsync/marker
clear — is phase-aware, so an fsync or marker failure can never escape as a plain
error that the engine would render as "source unchanged". On any pre-promotion
failure the code attempts an automatic rollback (`backup -> home`); when that
succeeds the original is restored and the failure is reported with the home
genuinely unchanged. **Only if the rollback also fails** is the switch left
partially applied: the marker records `interrupted`, the engine surfaces a
distinct `switch-ambiguous` outcome, and the upgrade blocks at a dedicated
`switch-ambiguous` stage that states the home is **not** intact and prints the
exact `mv "<backup>" "<home>"` recovery. A failure of the *post-promotion*
fsync/marker-clear, by contrast, does **not** fail the switch — the new home is
already in place and correct, and those steps are best-effort durability, so a
good migrated home is never rolled back. No completion receipt is written for an
interrupted switch (it did not commit); the `interrupted` marker is the durable
signal.

**Crash-window recovery keys off the marker plus filesystem evidence.** A process
that dies mid-switch leaves a durable marker (`backing-up`, `promoting`, or
`interrupted`), with the original at the backup and the home path missing. `yui
update`'s probe treats a marker of **any** phase as an interrupted switch **only
when the filesystem still corroborates it** — the backup exists AND the home is
missing/uninitialized — and then prints the exact backup-restore path, never a
generic "most likely did not commit, retry/setup" that would send the operator to
re-initialize a missing home. Crucially this evidence gate applies to the
`interrupted` phase too (R2-F3): a stale `interrupted` marker left over after a
manual recovery — the home already restored, or the backup already removed — is
**not** trusted to emit a restore path; the probe ignores the stale marker and
reconciles against the real on-disk state instead. A pre-start marker whose home
is still intact (or that has no usable backup) is likewise not treated as
interrupted: there is nothing to recover.

**Quiesce fails closed on any undeterminable signal.** The `.state.lock` is
acquired mkdir-first with its `owner` file written a moment later, so a lock
directory that exists but whose owner is missing, empty, non-integer, or
unreadable is *not* proof of "no writer" — it may be a writer mid-acquisition.
Quiesce therefore treats such a lock as **unknown-active** and refuses to proceed
(reporting an `active-runtime` blocker); only a lock whose owner is clearly
readable *and* names a dead PID is reclaimable. A `runtime/controller.json` that
exists but is malformed/unparseable is treated the same way — a live Controller
cannot be ruled out, so it fails closed rather than being read as "no
controller". A lock or discovery file that is provably absent is the only "no
runtime" case.

`yui update` stages the published package side by side (never replacing the live
install first), runs the staged binary's read-only preflight against the home,
and only then migrates storage and promotes the binary, with a new-binary health
check last. **Same-artifact promotion:** the version resolved at stage time is
pinned, and binary activation installs that exact `@zq-silk/yui@<version>` — never
a second bare `@latest` that could resolve to a different build than the one that
passed preflight. **Only a CONCRETE version is accepted** (R3-F1): the resolver
requires a semver-shaped `X.Y.Z` (optional pre-release/build suffix) — a dist-tag
sentinel like `latest`, an empty/malformed value, or a version probe that does
not come back in a valid `{ ok:true, data }` envelope at exit 0 all yield "no
version", and the stage then FAILS closed (the live install is untouched, fully
recoverable) rather than splicing a `latest` sentinel into an activation spec.
**Verify the activated binary:** the post-update health check runs the
*actually-activated* global binary (resolved via `npm prefix -g`), not the
staging path, and **requires** its reported version to be concrete and equal to
the staged version — a missing, unparseable, or mismatched version fails closed
(never skipped), so a build whose identity cannot be positively confirmed is
never trusted.

**A success envelope is required before any outcome is trusted.** Every
interpretation of a spawned staged-binary result first requires a valid
`{ ok: true, data: <object> }` success envelope (R3-F3). The parser guards the
top-level shape *before* reading any field: a body that parses to `null`, an
array, or a primitive (`JSON.parse("null")`/`"[]"`/`"5"` all succeed) is rejected
as no-envelope rather than crashing on a `.ok` access (R4-F1); likewise an
`ok:false` error envelope, a non-object `data`, unparseable output, a kill, or a
transport error is unresolved — preflight treats it as **blocked**, activation as
**ambiguous**, and a version probe as "no version". The `runUpdate` orchestrator
also wraps the preflight/activation port calls so an unexpected throw becomes a
blocked preflight / ambiguous activation, never an uncaught error that could hide
a committed switch. Only then does the outcome/exit consistency rule apply: a
*success-class* outcome (`upgraded`, `already-current`, or a
`dry-run`/`already-current` preflight) is trusted **only when the process also
exited 0**. A contradiction — stdout says `upgraded` but the process exited
non-zero — means the child's own contract was violated mid-flight, so it is
treated as **ambiguous** (activation) or **blocked** (preflight), never a false
success. Blocker-class outcomes are exempt: `yui upgrade` deliberately exits
non-zero (5) for a clean `blocked`, so a non-zero exit there is expected and
consistent. A parseable result with **no** recognized outcome is likewise never
read as success.

**Post-verify parses the doctor machine-readable result before the exit status.**
The post-update health check validates the structured `yui --json doctor` verdict
FIRST, then the exit status (R2-F2) — because `--json doctor` deliberately exits
non-zero on unhealthy storage, so keying off the exit first would reduce a precise
"storage unsupported/corrupted" verdict to a generic "exited with status N".
Storage is healthy only when ALL hold: a valid `{ ok: true, data: { checks,
storage } }` success envelope, **every expected storage check present exactly once
and `ok`** (a missing, duplicated, or malformed check fails closed — the `healthy`
flag is never trusted over the authoritative checks array, R3-F2), a
`storage.blocking` that is **a well-formed array of check-shaped objects** (a
missing field, a non-array value, or a malformed element fails closed rather than
being silently coerced to an empty array, R4-F2), `storage.healthy === true` with
no blocking checks, AND exit 0. A parseable-
but-unhealthy result (typically exit 5) throws a precise, recovery-oriented
blocker; an unparseable, non-success, or self-contradictory envelope (e.g.
`healthy: true` alongside a non-`ok` storage check, or `ok: false`) fails closed —
an unverifiable health check must never pass silently. The `--json` doctor path
additionally exits non-zero when storage is unhealthy, so even a naive exit-code
consumer fails closed; text-mode `doctor` keeps its existing presentation.

**Activation ambiguity.** Storage activation runs in a spawned staged-binary
child. If that child is killed (SIGTERM/OOM) or crashes *after* the atomic switch
commits but *before* it prints its result JSON, the parent cannot tell "nothing
happened" from "storage already switched". This is reported as a distinct
**ambiguous** outcome — never a false "recoverable/unchanged". The switch writes
a durable completion **receipt** at a sibling path (`<home>.upgrade-receipt.json`)
the instant it commits, and clears it only on a clean, fully-verified return; so
its presence proves the switch committed even when stdout was lost. On an
ambiguous result the orchestrator probes the receipt + timestamped backup +
current schema and prints precise manual-recovery steps (verify with `yui doctor`;
restore the named backup with `mv` if needed), and the CLI exits non-zero with a
dedicated code so the ambiguity is never mistaken for success.

**A receipt is only trusted when it genuinely corresponds to the current home
AND its backup.** A leftover receipt from a prior attempt is not unconditional
proof that *this* attempt's switch committed, and existence alone is not
correspondence (R3-F6). Before using a receipt for a recovery decision, the probe
requires the current protocol's correlating fields and a real backup: it is
rejected (the caller re-probes the real on-disk state instead) when it lacks a
`homePath` (a legacy/degraded marker), names a **different home**, lacks a
`backupPath`, names a backup that is **not this home's expected
`<home>.backup-*` timestamped sibling** (unrelated/foreign evidence), or whose
backup is **absent or not a real directory** (already restored or cleaned). A
non-corresponding receipt reads as "not switched" so recovery advice is never
derived from stale, legacy, or unrelated evidence.

**Rollback boundary (narrowed):** this release introduces no
versioned binary pointer or stable launcher and therefore makes no binary+home
dual-resource atomicity claim. It guarantees isolated staging (a
stage/preflight failure leaves binary and home unchanged), a recoverable atomic
storage switch (timestamped backup, restorable until the new version resumes
writes), and no auto-downgrade after writes resume. The single non-atomic window
— storage switched, binary promotion then failing — is surfaced with the exact
backup-restore recovery, and the version-gated axes make the old binary
fail-close on the new home rather than misread it. task-5 delivers this code and
its isolated tests only; it never runs an upgrade against a real home.

**Cross-Task schema scheduling.** Storage schema work is not globally serialized.
Any module or Task may advance a storage version axis (`layout`, `aggregate`, or
a `record` family) on its own isolated branch without waiting for another Task's
schema change to land — branches do not block each other. The cost of that
parallelism is assigned, by design, to whichever branch integrates later: the
later-integrating branch is responsible for rebasing onto the latest project
head, resolving all schema and code conflicts, re-advancing whatever schema
versions and record-version-map entries the rebase requires, rebuilding and
re-validating the real wiring, and fully re-running the isolated migration/upgrade
E2E and its documentation. This rework-and-reconcile duty belongs to the later
integrator; it is a deliberate scheduling trade-off (authorized by the user) that
avoids cross-Task blocking rather than an accident to be repaired ad hoc.
Concretely, this release's record-version map is a snapshot of the record
families on the current baseline, not a frozen set: if another Task later lands a
record-schema change, the integrating branch re-derives the map against the
newest head and re-tests to convergence under the same strategy.

The Web control room is loopback-only and never receives Controller socket
credentials. It presents durable records and native terminal access without
becoming a second source of truth.
