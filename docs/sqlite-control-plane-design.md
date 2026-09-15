<p align="right"><strong>English</strong> | <a href="./sqlite-control-plane-design.zh-CN.md">简体中文</a></p>

# SQLite control-plane storage

Yui has one authoritative product Store: `YUI_HOME/yui.db` in WAL mode. The
highest contiguous, checksummed row in `schema_migrations` is the one Home
storage version accepted by the running release.

## Authority

- `yui.db` owns Tasks, WorkItems, AgentRuns, Messages, Decisions, results, Project
  Knowledge references, managed workspace records, runtime bindings, mailboxes,
  durable events, and configuration.
- Provider Sessions, transcripts, processes, caches, telemetry, and runtime
  observations support execution and diagnosis; they do not replace durable
  Task facts.
- Configuration and diagnostics outside the database do not define another
  storage version or permit rebuilding Task truth heuristically.

## Admission

Ordinary commands open a Home only when all of these are true:

1. `yui.db` exists and its migration ledger is a valid immutable prefix.
2. The ledger head exactly matches the running CLI's current storage version.
3. Current record validation and reference integrity succeed.

An older Home inside the CLI's supported range fails ordinary admission but is
classified as upgradeable. `yui doctor` and `yui upgrade --dry-run` report the
ordered path without changing the Home. Explicit `yui upgrade` is the only
standalone mutation boundary: it quiesces the Controller, backs up `yui.db`,
applies all missing migrations transactionally, and validates the current
model. A newer, below-minimum, incomplete, or malformed Home fails closed.
There is no runtime normalization, repair worker, file-Store fallback, dual
read/write path, or second migration authority.

## Write and concurrency contract

- Each mutation is one SQLite transaction.
- WAL plus `synchronous=FULL` provides the durable commit boundary.
- `home_meta.revision` is the Home-wide CAS/revision used by callers that need
  a frozen read/modify/write boundary.
- Typed columns support indexed identity and status queries; the full validated
  record payload remains the durable domain representation.
- Mailbox claim, exact AgentRun terminalization, active-pointer removal, result
  persistence, and downstream wake creation are transactionally coupled where
  they form one product fact.
- Idempotency keys and unique constraints protect repeatable external-effect
  acknowledgements; they do not form a second workflow state machine.

## AgentRun and Session boundary

An AgentRun is an explicitly requested execution. It records associated visible
inputs and the original result, not hidden reasoning or the full tool trace.
A Provider Session can contain multiple Runs, ordinary native chat and
notifications. Native chat and notifications do not automatically create Runs.
Only an exactly correlated native terminal settles the Run; the Leader remains
the authority for WorkItem and Task acceptance.

## Update behavior

`yui update` stages an exact package and asks that staged binary to classify the
Home as current, migration-ready, or blocked. It then stops the exact
Controller, activates the same package, runs the staged release's complete
migration chain when required, verifies the installed binary and current Home,
and starts the replacement Controller.

Every persistent schema or payload change appends one immutable, contiguous
storage migration. The CLI publishes both `storageVersion` and
`minimumStorageVersion`; every valid Home in that inclusive range can upgrade
directly to the current version without installing intermediate releases.
The current version and migration floor are declared only in
`src/storage/storageVersions.ts` and exposed by CLI identity. Homes below that
floor are not migration inputs and remain untouched.
The target binary's `upgrade --update-preflight` and `--update-apply` result
shapes and parent-owned handover-lock proof remain backward compatible with
every updater released from storage version 1 onward, so an old source CLI can
still drive a much newer target's complete migration chain.

## Unified Home layout

Every Yui self-managed directory lives under the single canonical `YUI_HOME`
(default `~/.yui`; an explicit `YUI_HOME` is honoured verbatim). `YUI_HOME` is
never inferred from the current working directory and never substituted with a
username. `src/storage/homeLayout.ts` is the one authority that derives each
managed root from Home:

| Root | Path | Holds |
|---|---|---|
| Managed worktrees | `<home>/workspaces/tasks/<taskId>/<owner>/<projectDirectory>` | Actual Task/WorkItem/Review/Integration Git directories, addressed by the bound Project directory. Owners are `main`, `work-items/<id>`, `reviews/<id>`, `integrations/<id>` and `execution-lanes/<group>/<lane>`. |
| Read-only context views | Within the same owner directory | Regenerable symlinks to read-only Project context only; writable entries are actual Git directories, not links. |
| Global Role workspace | `<home>/workspaces/global` | Default cwd for Yui-auto-created Global Roles (the `yui setup` Operator/Leader and ad-hoc Global Roles added without an explicit `--workspace`). A plain cwd, not a managed Git workspace. |
| Task provider runtimes | `<home>/runtime/task-runtimes` | Task provider data/cache/tmp; also the planning cwd at `…/planning/<taskId>`. |
| Integration runtimes | `<home>/runtime/integration-runtimes` | The integration check's provider data/cache/tmp (a separate partition from Task runtimes). |
| Update staging | `<home>/runtime/update-staging` | `yui update`'s side-by-side package install (an upgrade artifact). |
| Release workflow scratch | `<home>/runtime/release-workflow` | The release workflow's smoke-install dir and verified publish-snapshot tarball (release artifacts). |
| Storage backups | `<home>/backups` | Pre-upgrade DB backups (the fenced upgrade's rollback anchor). |

Published migrations 1–23 remain unchanged, including Task artifacts in local
Git (19), Integration continuation (20), force-archive evidence (21), and
Controller-owned Host ingress (22), and unified message input control (23).
The two offline layout steps are now 23→24 (`unify-home-layout`) and
24→25 (`collapse-worktree-layout`). Version 24's
`workspaces/worktree` directory is an intermediate layout, not a second live
root at version 25. A single upgrade applies the full pending chain.

Stop this Home's writers and take a backup before upgrading. The layout steps
copy and verify the registered Git trees, repair only the copies' links, and
preserve old sources for manual recovery. Version 25 replaces registered
Task-view symlinks with real writable directories; unrelated Task scratch is
retained. Read-only context remains a view and can be promoted to a writable
worktree when WorkItem scope expands. Do not delete the old sources until the
new layout is verified; a failed upgrade requires manual residue cleanup and
backup recovery, not automatic resume.

Both runtime partitions (`runtime/task-runtimes`, `runtime/integration-runtimes`)
are the ONLY Home subtrees a provider runtime root is allowed to overlap; a
runtime root overlapping any other part of Home (the database, `workspaces/`,
`projects/`) is still rejected by `assertTaskRuntimeIsolationPreflight`, so
unifying the root does not weaken control-data or cross-owner isolation.

`defaultWorkspace` is a user-facing cwd for external Project input only; it is
**not** a second authority for internal managed paths, and is intentionally not
an input to `homeLayout.ts`. A Yui-auto-created Global Role that carries no
user-chosen cwd no longer falls back to it (or to `process.cwd()`): `yui setup`'s
built-in Operator/Leader and `yui config role add` without `--workspace` now default to
the Home-internal `managedGlobalRoleWorkspace(home)` (`<home>/workspaces/global`),
and `setup` no longer fabricates an external Home-sibling `workspace/` — a
`default-workspace` is persisted only if the user configured one. A user who
*names* an external directory (explicit `--workspace`, or a configured
`default-workspace`) keeps external-resource semantics; the outside-Home guard
still applies to it. The "planning/global cwd" that criterion 1 places under Home
is thus both the *disposable runtime cwd Yui materializes itself* — the Draft
planning cwd (`planningRuntimeCwd`, under `runtime/task-runtimes/planning`) — and
the auto-created Global Role cwd above; only an operator's *explicitly named*
external directory stays outside by design.

Only genuine short-path IPC socket ENDPOINTS remain outside Home, and only
because a Unix-domain `sockaddr_un` path has a small fixed length budget that a
deep Home path would exceed. Each is a single socket path, never a data/cache/tmp
root:

- the Controller socket (`/tmp/yui-<uid>/<homeId>.sock`),
- the tmux server socket (`/tmp/tmux-<uid>` via the tmux namespace),
- the Agent Host socket (`/tmp/yui-<uid>/agent-host/…sock`), and
- the integration check's tmux socket dir (`/tmp/yi-<uid>-<digest>`), bound only
  into `TMUX_TMPDIR`.

The integration check's ordinary runtime state is **not** an exception: its
provider data, cache, and temp roots live in the Home partition above
(`runtime/integration-runtimes`); `TMPDIR`/`TMP`/`TEMP` point there, and only
`TMUX_TMPDIR` is redirected to the short `/tmp` socket dir.

## Migration 23 → 24: unify managed paths under Home

Historically the managed worktrees lived under the out-of-Home
`defaultWorkspace` (`<ws>/worktree`, `<ws>/tasks`) and the provider runtimes
under a string-built Home sibling (`<home>.task-runtimes`). The one forward
migration `unify-home-layout` (`src/storage/migrations/unifyHomeLayout.ts`)
brings that content under Home and rewrites the persisted absolute pointers the
runtime dereferences as live, without re-cloning Git content or renaming the
path-independent Git refs. It runs as the migration's `migrateData` step inside
the upgrade transaction, so schema and data advance atomically or roll back
together.

**Exactly one tree is physically relocated: the managed Git worktree tree.** It
is the sole subtree that holds durable, non-regenerable content (committed **and**
uncommitted work), so it alone is copied on disk. Everything else that "moves"
moves only by pointer:

- the per-Task symlink views (`<ws>/tasks`) are regenerable — the pointer is
  rewritten and `ensureWorkspaceView` rebuilds the links at the next launch;
- the provider runtimes (`<home>.task-runtimes`) are disposable — the pointer is
  rewritten and the roots are recreated at the next launch.

The worktree copy is **non-destructive and verified** (see *Recovery and
rollback*): the source is copied (never renamed away), the replica's content
digest is checked against the source, and only a verified replica is atomically
published. The original worktree tree is **preserved** as the rollback anchor;
removing it is a later, authorized, post-restart cleanup step, never part of this
transaction.

The pointer rewrite is **surgical, not a table sweep** — only records the runtime
treats as live launch pointers are touched:

- `managed_workspaces` — the authoritative registry (`path` column, payload
  `root`, every `entries[].path`). Every surviving row is live (dispositioned
  rows are deleted at cleanup).
- active (`status='active'`) `turns` — **both** `run.effective.workspace` (the
  actual OS launch cwd source) and the `run.workspace` mirror, rewritten together
  because `validateRun` requires them to stay identical; a run's
  `.result.systemEvidence.workspaceSnapshot` is frozen Git evidence and is left
  byte-for-byte intact.
- `role_session_sets` / `global_role_session_sets` — each live session's
  `effective.workspace` in the `sessions` map; terminal sessions in `history` are
  preserved.
- `review_rounds` — the mirrored workspace (only while its `managed_workspaces`
  owner row still exists) and each OPEN execution lane; an orphaned mirror or a
  terminal lane is frozen evidence and is preserved.
- `work_items` — each OPEN execution lane inside `executionGroups`; candidate
  snapshots (`work_item_candidates`) are frozen and preserved.
- `task_roles.workspace` — the live launch cwd, including a Draft's planning Role
  under the old runtime sibling (never self-healed until activation).
- `task_records.cwd` — self-heals on the next `prepareTaskWorkspace`, but is
  rewritten defensively to close the stale-read window.

Everything else is preserved on purpose: `context_snapshots`, terminal `turns`
(with their system evidence), terminal sessions, `work_item_candidates`, terminal
execution lanes, terminal `durable_jobs`, `events`, and reports are frozen
history. `resource_registry` is re-discovered from disk; `projects.path` is an
external, user-owned checkout.

The migration is applied **offline** and is **fail-closed and pre-checkable**.
It is run by the standalone `yui upgrade` boundary AFTER the operator has stopped
this Home's Controller, Agent Host, and any execution/Job writers; it does not
orchestrate that shutdown, coordinate an online write-stop, or migrate a live
Session. It keeps only the minimal preconditions it can implement directly:

- It **refuses** if a queued or running `durable_jobs` step is bound to a tree
  about to relocate. A durable Job's runner is detached and could outlive an
  incompletely stopped Controller, so moving that tree would risk an in-flight
  silent move; this is the one residual runtime signal the offline migration
  still guards. Let the Job drain or cancel it, then re-run the upgrade.
  (`active_turns` is steady state, not an in-flight signal, and is deliberately
  not consulted.)
- It **refuses** if a relocation target already exists at all — it is either a
  foreign directory or residue from a failed prior run, and the offline migration
  never adopts a pre-existing target. Confirm the source is intact, then move or
  remove the target and re-run the upgrade.
- Every refusal is surfaced as a **collected, read-only pre-check**: `yui
  upgrade --dry-run` and the updater's `--update-preflight` run the same plan and
  the same blocking conditions execute would throw on, opening the DB read-only
  and reporting each independent blocker as `{reason, detail}` (blocked outcome)
  without mutating the Home — a genuine pre-check, not a best-effort guess.
- A Home already in the unified layout (or a fresh Home with nothing to relocate)
  is a **no-op**.

### Recovery and rollback

The migration keeps **no recovery manifest and no resumable state machine** — it
is a one-time offline transform, not an interruptible online orchestration. The
worktree relocation is **copy → digest-verify → atomic-publish → preserve-source**:

1. the relocation target must not already exist; a pre-existing target is refused
   up front (foreign directory or failed-run residue — never adopted);
2. the source is copied into a same-filesystem staging dir (`<to>.incoming`),
   never renamed away;
3. a content-addressed inventory digest of the replica is compared to the source
   — a mismatch deletes the staging copy and aborts (nothing published, source
   intact);
4. only a verified replica is `rename`d into the final target (atomic on one
   filesystem);
5. the original source tree is left in place as the rollback anchor.

There is **no automatic idempotent recovery**. Because a pre-existing target is
always refused, a run interrupted after a partial publish does not silently
resume or adopt the partial tree on the next attempt: the operator inspects the
preserved source, removes the incomplete target (and any `<to>.incoming`
staging), and re-runs the upgrade from a clean state. The `--dry-run` /
`--update-preflight` pre-check surfaces exactly this `target-conflict` before the
apply transaction is entered, so the residue is reported, not discovered
mid-migration.

After the copy, the worktrees are reconnected. `git worktree repair` chases the
absolute pointer files inside a worktree, so running it on a verbatim copy whose
pointers still address the OLD source would rewrite the OLD source's `.git`
files and corrupt the rollback anchor. The migration therefore **relinks first**:
it deterministically repoints, in the NEW copy only, the two cross-reference
pointer files (a linked worktree's `.git` stub and each
`main/.git/worktrees/<name>/gitdir`) from OLD to NEW, and only THEN runs `git
worktree repair` from each main clone at its new path as a belt-and-braces
reconciliation now confined to the new tree. This keeps the preserved source a
fully independent, working Git: its `.git` is byte-for-byte unchanged and it
still resolves HEAD/index/status after the migration (verified empirically on a
private disposable Home). **A repair failure is fatal** — it aborts the migration
so the transaction rolls back rather than advancing the version over unrepaired
worktrees.

Because the data step runs inside the upgrade transaction, any throw rolls the
schema back to its original version; the fenced upgrade orchestrator additionally takes a
`database.backup()` and restores it on failure. Recovery from a failed run is
**manual, not automatic**: because the source is never removed and the copy is
digest-verified before publish, the preserved source is always intact, so the
operator clears any partial target and re-runs the upgrade. No re-run can lose or
corrupt the original content, but the tool does not itself resume an interrupted
move set.

**Old-source cleanup** is intentionally deferred and out of band: after a
successful upgrade the old external `worktree`, `tasks`, and `<home>.task-runtimes`
roots are left **in place** (not emptied) until an operator-authorized cleanup
removes them. This keeps a full rollback anchor available across the first
restart.

**Rollback limits:** once the Controller restarts against the unified layout and
begins writing new records under Home, restoring the pre-upgrade DB backup no
longer matches the newly written on-disk state. Until that first post-upgrade
write, the preserved old source plus the DB backup are a complete rollback pair;
after it, the supported recovery is forward (the layout is already unified), not a
downgrade to the split layout. Verify an upgrade only on a private, disposable
Home before applying it to a shared environment.
