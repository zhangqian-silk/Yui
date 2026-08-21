/**
 * The SQLite-backed {@link MigrationTarget} for record-family migrations on a
 * layout-7 Home (Issue 01 Phase 2).
 *
 * The layout 6 -> 7 target ({@link createSqliteMigrationTarget}) stages a
 * fresh database from `state.json`. Once a Home is at layout 7 its
 * authoritative store is `yui.db`; `state.json` may have been archived by the
 * pseudo-layout-7 repair, so a record-only migration on such a Home cannot
 * read its source from the document. This target closes that gap:
 *
 *  - Snapshot:  `readSource` reads `schema.json` and reconstructs the
 *               state.json-shaped snapshot from `yui.db` via
 *               {@link readStateFromSqlite} (raw payloads, so older record
 *               versions survive with their original `schemaVersion`).
 *  - Stage:     `writeFreshOutput` populates a sidecar `yui.db.staged` from
 *               the (possibly transformed) snapshot; refuses to overwrite an
 *               existing stage.
 *  - Verify:    `validateCurrentState` independently re-reads `yui.db`,
 *               re-derives the expected state through the registered
 *               transforms, and compares per-family checksums against the
 *               staged database.
 *  - Commit:    `atomicSwitchWithBackup` swaps the sidecar into `yui.db` (with
 *               a timestamped backup of the prior database) and advances
 *               `schema.json`'s record-family versions in the same
 *               coordination critical section. The layout version is
 *               unchanged (this target never crosses a layout boundary).
 *
 * The source `yui.db` is retained read-only throughout: it is never
 * overwritten, truncated, or deleted by the migration. This preserves the
 * rollback path (restore the timestamped backup).
 */
import { existsSync, readFileSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";

import { writeTextFileAtomically } from "../durableFile.js";
import {
  STORAGE_SCHEMA_FILE,
  type ParsedStorageManifest
} from "../storageSchema.js";
import { planMigration } from "../migration/planner.js";
import type { MigrationRegistry } from "../migration/registry.js";
import {
  AmbiguousSwitchError,
  type DerivedStateSummary,
  type LiveRuntimeStatus,
  type MigrationTarget,
  type StorageVersionState,
  type SwitchOutcome,
  type ValidationSummary
} from "../migration/index.js";
import {
  describeActiveRuntime,
  homeRuntimeIsActive,
  inspectHomeRuntime,
  inspectSourceVersionState,
  inspectSnapshotVersionState,
  type HomeSnapshot
} from "./homeMigrationTarget.js";
import { writeSwitchProgress } from "./switchProgress.js";
import { moveSqliteFileSet, removeSqliteFileSet } from "./sqliteFileSet.js";
import {
  COMMITTED_DATABASE_FILENAME,
  STAGED_DATABASE_FILENAME,
  copySqlitePassthroughState,
  computeDbFamilyChecksums,
  computeStateFamilyChecksums,
  populateSqliteFromState,
  readStateFromSqlite
} from "./sqliteStateMigration.js";

export type SqliteRecordMigrationTargetOptions = Readonly<{
  /** The authoritative source Home (never written until the atomic switch). */
  home: string;
  /** The latest supported version state (scalar axes + current record map). */
  latest: StorageVersionState;
  /** The production registry, used to re-derive expected state in Verify. */
  registry: MigrationRegistry<HomeSnapshot>;
  /** Injected clock for deterministic backup stamps. */
  now?: () => Date;
  /** This process's pid, for foreign-writer detection. */
  callerPid?: number;
  /**
   * Test seam for the promote and rollback renames in the atomic switch.
   * The backup move (committed -> backup) always uses the real rename so a
   * fault that blocks the forward rename blocks the reverse too, driving the
   * genuine ambiguous-switch path. Production never overrides it.
   */
  renameImpl?: (from: string, to: string) => void;
}>;

export type SqliteRecordMigrationTarget = MigrationTarget<HomeSnapshot> & Readonly<{
  /** The sidecar staged database path this target writes/promotes/discards. */
  stagedDbPath: string;
}>;

/** Build the SQLite-backed record-migration target. */
export function createSqliteRecordMigrationTarget(
  options: SqliteRecordMigrationTargetOptions
): SqliteRecordMigrationTarget {
  const home = options.home;
  const latest = options.latest;
  const registry = options.registry;
  const now = options.now ?? (() => new Date());
  const callerPid = options.callerPid ?? process.pid;
  const promoteRename = options.renameImpl ?? renameSync;
  const stagedDbPath = join(home, STAGED_DATABASE_FILENAME);
  const committedDbPath = join(home, COMMITTED_DATABASE_FILENAME);

  // The transformed schema manifest is cached during writeFreshOutput so the
  // switch can advance schema.json without re-reading or re-deriving it.
  let stagedSchemaManifest: Record<string, unknown> | null = null;

  return {
    stagedDbPath,

    inspectVersions(): StorageVersionState {
      const inspected = inspectSourceVersionState(home, latest);
      if ("corruption" in inspected) {
        throw new Error(inspected.corruption.detail);
      }
      return inspected.source;
    },

    detectLiveRuntime(): LiveRuntimeStatus {
      const signals = inspectHomeRuntime(home, callerPid);
      if (!homeRuntimeIsActive(signals)) return { active: false };
      return { active: true, detail: describeActiveRuntime(signals) };
    },

    readSource(): HomeSnapshot {
      const manifestRaw = readFileSync(join(home, STORAGE_SCHEMA_FILE), "utf8");
      const schemaManifest = parseJsonObject(manifestRaw, STORAGE_SCHEMA_FILE);
      const state = readStateFromSqlite(home);
      return Object.freeze({ schemaManifest, state });
    },

    writeFreshOutput(snapshot: HomeSnapshot): void {
      if (existsSync(stagedDbPath)) {
        throw new Error(
          `Refusing to overwrite an existing staged SQLite database: ${stagedDbPath}. ` +
            "Discard it and retry."
        );
      }
      // Cache the transformed manifest for the switch's schema.json advancement.
      // The orchestrator applies the record transforms before calling us, but
      // direct callers (tests, drills) may pass an untransformed snapshot. The
      // record-family versions are re-derived from the latest map so the
      // staged manifest always declares the post-migration versions.
      const recordVersions: Record<string, number> = {};
      for (const [kind, entry] of Object.entries(latest.record)) {
        recordVersions[kind] = entry.version;
      }
      stagedSchemaManifest = {
        ...snapshot.schemaManifest,
        recordVersions,
        updatedAt: now().toISOString()
      };
      populateSqliteFromState(home, snapshot.state ?? {}, STAGED_DATABASE_FILENAME);
      copySqlitePassthroughState(
        home,
        COMMITTED_DATABASE_FILENAME,
        STAGED_DATABASE_FILENAME
      );
    },

    rebuildDerivedState(effects: readonly string[]): DerivedStateSummary {
      // The SQLite database is fully normalised by populateSqliteFromState;
      // there is no separate derived index to rebuild. Echo the declared
      // effects for the report, mirroring the layout 6 -> 7 target.
      return { rebuiltEffects: [...effects] };
    },

    validateCurrentState(): ValidationSummary {
      // Independently re-read yui.db from disk (not the in-memory snapshot
      // used for staging) and re-derive the expected state by applying the
      // registered transforms. This catches staging corruption, a torn read,
      // or a concurrent writer that slipped past the quiesce gate.
      const freshSnapshot = readSourceFresh();
      const expectedState = deriveExpectedState(freshSnapshot);
      if (expectedState !== null) {
        verifyChecksums(expectedState);
      }
      const dbChecksums = computeDbFamilyChecksums(home, STAGED_DATABASE_FILENAME);
      const familyCount = Object.keys(dbChecksums).length;
      return {
        checks: [
          {
            name: "SQLite staged-database checksum verification",
            outcome: "passed",
            detail: `verified ${familyCount} record families against an independent yui.db re-read`
          }
        ]
      };
    },

    atomicSwitchWithBackup(): SwitchOutcome {
      if (!existsSync(stagedDbPath)) {
        throw new Error(`No staged SQLite database to promote: ${stagedDbPath}.`);
      }
      const stamp = now().toISOString().replace(/[:.]/g, "-");
      let backupPath: string | undefined;

      // Phase 1: back up the existing yui.db, then promote the sidecar.
      try {
        if (existsSync(committedDbPath)) {
          backupPath = join(home, `${COMMITTED_DATABASE_FILENAME}.backup-${stamp}`);
          if (existsSync(backupPath)) {
            throw new Error(`Refusing to overwrite an existing database backup: ${backupPath}.`);
          }
          moveSqliteFileSet(committedDbPath, backupPath);
        }
        promoteRename(stagedDbPath, committedDbPath);
        // The staged connection may leave empty WAL/SHM sidecars behind
        // even after a clean close; they are dead once promoted.
        rmSync(`${stagedDbPath}-wal`, { force: true });
        rmSync(`${stagedDbPath}-shm`, { force: true });
      } catch (error) {
        // Pre-promotion failure: restore the original database if we moved it.
        if (backupPath !== undefined && existsSync(backupPath)) {
          try {
            moveSqliteFileSet(backupPath, committedDbPath, promoteRename);
          } catch {
            writeInterruptedMarker(home, backupPath, stagedDbPath, now);
            throw new AmbiguousSwitchError({
              homePath: home,
              backupPath,
              stagingPath: stagedDbPath,
              detail:
                `SQLite switch failed (${messageOf(error)}) and the automatic rollback also failed. ` +
                `The original database is at ${backupPath}; recover manually by renaming it to ${committedDbPath}.`
            });
          }
        }
        throw error;
      }

      // Phase 2: advance schema.json record-family versions in the same
      // critical section. The layout version is unchanged.
      try {
        if (stagedSchemaManifest !== null) {
          writeTextFileAtomically(
            join(home, STORAGE_SCHEMA_FILE),
            `${JSON.stringify(stagedSchemaManifest, null, 2)}\n`
          );
        }
      } catch (error) {
        // The database is promoted but schema.json could not be advanced.
        // Attempt to restore the original database; if that fails, the Home
        // is ambiguous and must be recovered manually.
        try {
          if (backupPath !== undefined && existsSync(backupPath)) {
            removeSqliteFileSet(committedDbPath);
            moveSqliteFileSet(backupPath, committedDbPath, promoteRename);
          } else {
            removeSqliteFileSet(committedDbPath);
          }
        } catch {
          writeInterruptedMarker(home, backupPath ?? committedDbPath, stagedDbPath, now);
          throw new AmbiguousSwitchError({
            homePath: home,
            backupPath: backupPath ?? committedDbPath,
            stagingPath: stagedDbPath,
            detail:
              `SQLite database was promoted but schema.json could not be advanced (${messageOf(error)}), ` +
              `and the automatic rollback also failed. The database is at ${committedDbPath}; ` +
              `recover by advancing schema.json recordVersions or restoring the backup.`
          });
        }
        throw error;
      }

      return {
        status: "switched",
        ...(backupPath === undefined ? {} : { backupPath }),
        detail: `SQLite database promoted to ${committedDbPath} and schema.json record versions advanced.`
      };
    },

    discardFreshOutput(): void {
      rmSync(stagedDbPath, { force: true });
      // Clean up WAL/SHM sidecars if the connection left them.
      rmSync(`${stagedDbPath}-wal`, { force: true });
      rmSync(`${stagedDbPath}-shm`, { force: true });
      stagedSchemaManifest = null;
    }
  };

  // -- helpers ---------------------------------------------------------------

  function readSourceFresh(): HomeSnapshot {
    const manifestRaw = readFileSync(join(home, STORAGE_SCHEMA_FILE), "utf8");
    const schemaManifest = parseJsonObject(manifestRaw, STORAGE_SCHEMA_FILE);
    const state = readStateFromSqlite(home);
    return Object.freeze({ schemaManifest, state });
  }

  /**
   * Re-derive the expected post-migration state by reading the fresh snapshot,
   * planning from its versions to `latest`, and applying every registered
   * step transform. This mirrors the engine's apply phase but starts from an
   * independent disk read.
   */
  function deriveExpectedState(snapshot: HomeSnapshot): Record<string, unknown> | null {
    const inspected = inspectSnapshotVersionState(snapshot, latest);
    if ("corruption" in inspected) {
      throw new Error(inspected.corruption.detail);
    }
    const plan = planMigration(registry, inspected.source, latest);
    if (plan.kind === "blocked") {
      throw new Error(
        `SQLite record migration verification cannot derive expected state: ${plan.blocker.message}`
      );
    }
    if (plan.kind === "no-op") return snapshot.state;
    let current = snapshot;
    for (const planned of plan.steps) {
      planned.step.preconditions(current);
      current = planned.step.transform(current);
    }
    return current.state;
  }

  function verifyChecksums(expectedState: Record<string, unknown>): void {
    const expected = computeStateFamilyChecksums(expectedState);
    const actual = computeDbFamilyChecksums(home, STAGED_DATABASE_FILENAME);
    const families = new Set([...Object.keys(expected), ...Object.keys(actual)]);
    const mismatches: string[] = [];
    for (const family of families) {
      const e = expected[family];
      const a = actual[family];
      if (e === undefined || a === undefined || e.count !== a.count || e.hash !== a.hash) {
        mismatches.push(
          `${family} (expected ${e === undefined ? "absent" : `${e.count}/${e.hash.slice(0, 12)}`}, ` +
          `found ${a === undefined ? "absent" : `${a.count}/${a.hash.slice(0, 12)}`})`
        );
      }
    }
    if (mismatches.length > 0) {
      throw new Error(
        `SQLite record migration checksum mismatch for ${mismatches.length} family/families: ${mismatches.join("; ")}`
      );
    }
  }
}

function parseJsonObject(raw: string, label: string): Record<string, unknown> {
  const value = JSON.parse(raw) as unknown;
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be a JSON object.`);
  }
  return value as Record<string, unknown>;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Persist the durable `interrupted` switch-progress marker for an ambiguous
 * SQLite switch (P1-4): the original database was moved to its timestamped
 * backup and neither the promotion nor its rollback completed. The marker is
 * the honest durable signal — a completion receipt is never written for a
 * switch that did not commit. Best-effort: the backup and on-disk state still
 * recover the Home even if the marker write fails.
 */
function writeInterruptedMarker(
  home: string,
  backupPath: string,
  stagingPath: string,
  now: () => Date
): void {
  try {
    writeSwitchProgress(home, {
      phase: "interrupted",
      homePath: home,
      backupPath,
      stagingPath,
      updatedAt: now().toISOString()
    });
  } catch {
    // Marker best-effort; the backup + on-disk state still recover the Home.
  }
}
