# Issue 01 Cross-Issue Handoff

Issues discovered during Issue 01 (authoritative-sqlite-activation) that belong
to other issues' scope. Recorded here so the owning issue can pick them up.

## 1. `blockedFromSwitchAmbiguity` action message assumes file-target semantics

- **Location**: `src/storage/upgrade/upgradeOrchestrator.ts` — `blockedFromSwitchAmbiguous`
- **Problem**: The recovery action is `mv "${backupPath}" "${homePath}"`. For the
  file-document target this is correct (the backup is a directory or `state.json`
  moved to the Home path). For the SQLite target, `backupPath` is a single-file
  backup of `yui.db`; `mv` into the Home directory does not restore it as `yui.db`.
- **Fix direction**: Branch the action message by target type. SQLite recovery
  should be `mv "${backupPath}" "${homePath}/yui.db"`.
- **Owning issue**: Issue 02 (controller-runtime-provenance) or standalone fix.

## 2. Layout-7 + older-aggregate + no-yui.db combined path needs multi-phase sequencing

- **Location**: `src/storage/upgrade/upgradeOrchestrator.ts`
- **Problem**: A Home that is simultaneously layout 7, carries older aggregate
  record versions, and has no `yui.db` needs two phases: (1) pseudo-layout-7
  repair (state.json → SQLite), then (2) record-family migration on the new
  database. The orchestrator does not currently sequence these; this is a
  product decision point.
- **Fix direction**: Add multi-phase sequencing to the orchestrator, or document
  the manual recovery steps for this combined path.
- **Owning issue**: Issue 02 or Issue 05 (scheduler-quiescence).

## 3. `#seedHomeMeta`/`#seedConfig` use `INSERT OR IGNORE`, potentially masking corruption

- **Location**: `src/storage/sqliteStore.ts` — `#seedHomeMeta`, `#seedConfig`
- **Problem**: The `SqliteTaskStore` constructor calls these methods, which use
  `INSERT OR IGNORE` to fill missing `home_meta`/`config` rows. If a migration
  produces a database without a config row, opening the store silently inserts
  the default config, potentially masking migration corruption.
- **Fix direction**: For a migrated database, a missing config row should fail
  closed rather than auto-heal; or at minimum doctor should report the
  auto-heal event.
- **Owning issue**: Issue 02 or standalone fix.

## 4. Flaky test: "pending Task-final recovery safely reuses a retained diagnostic branch"

- **Location**: `test/core/repository-workspace-file-store.test.js`
- **Problem**: Passes when run alone, occasionally fails in the full suite.
  Suspected test-isolation or timing issue; not storage-backend related.
- **Fix direction**: Investigate test ordering and shared-state dependencies.
- **Owning issue**: Test infrastructure (no specific issue doc).
