/**
 * The SQLite-backed {@link MigrationTarget} for the layout 6 -> 7 staged
 * migration (task-21 §8, work-item-4).
 *
 * This target is the seam between the generic, domain-free migration engine
 * and the SQLite writer. It stages the migrated state into a sidecar
 * `yui.db.staged` INSIDE the Home (not a sibling copy), verifies the staged
 * database against an independent re-read of `state.json`, and commits by
 * swapping `yui.db.staged` -> `yui.db` and advancing `schema.json` to layout 7
 * in the same coordination critical section.
 *
 * Staged orchestration (§8.2):
 *  - Snapshot:  `readSource` reads `schema.json` + `state.json` read-only.
 *  - Stage:     `writeFreshOutput` populates `yui.db.staged` from the (possibly
 *               transformed) snapshot; refuses to overwrite an existing stage.
 *  - Verify:    `validateCurrentState` independently re-reads `state.json`,
 *               re-derives the expected state through the registered transforms,
 *               and compares per-family checksums against the staged database.
 *  - Commit:    `atomicSwitchWithBackup` swaps the sidecar into `yui.db` (with
 *               a timestamped backup of any prior database) and advances
 *               `schema.json` to layout 7.
 *  - Rollback:  `rollbackSqliteMigration` quarantines `yui.db` and flips
 *               `schema.json` back to layout 6. A layout-6→7 migration retains
 *               `state.json` in place (never touched); a pseudo-layout-7 repair
 *               archived it to `state.json.backup-*`, so rollback restores the
 *               newest backup when `state.json` is absent.
 *
 * The source `state.json` is retained read-only throughout: it is never
 * overwritten, truncated, or deleted by the migration. This preserves the
 * rollback path and the §8.4 invariants (no healthy Session reset, no evidence
 * deleted).
 */
import { existsSync, readFileSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";

import { writeTextFileAtomically } from "../durableFile.js";
import {
  STORAGE_SCHEMA_FILE,
  type ParsedStorageManifest
} from "../storageSchema.js";
import { STORAGE_STATE_FILE } from "../taskStore.js";
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
import {
  COMMITTED_DATABASE_FILENAME,
  STAGED_DATABASE_FILENAME,
  computeDbFamilyChecksums,
  computeStateFamilyChecksums,
  populateSqliteFromState
} from "./sqliteStateMigration.js";
import { latestStateBackupPath } from "./pseudoLayoutRepair.js";
import { migrationReceiptPath, writeMigrationReceipt } from "./migrationReceipt.js";
import { moveSqliteFileSet, removeSqliteFileSet } from "./sqliteFileSet.js";

export type SqliteMigrationTargetOptions = Readonly<{
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
}>;

export type SqliteMigrationTarget = MigrationTarget<HomeSnapshot> & Readonly<{
  /** The sidecar staged database path this target writes/promotes/discards. */
  stagedDbPath: string;
}>;

/** Build the SQLite-backed migration target. */
export function createSqliteMigrationTarget(
  options: SqliteMigrationTargetOptions
): SqliteMigrationTarget {
  const home = options.home;
  const latest = options.latest;
  const registry = options.registry;
  const now = options.now ?? (() => new Date());
  const callerPid = options.callerPid ?? process.pid;
  const stagedDbPath = join(home, STAGED_DATABASE_FILENAME);
  const committedDbPath = join(home, COMMITTED_DATABASE_FILENAME);

  // The transformed schema manifest is cached during writeFreshOutput so the
  // switch can advance schema.json without re-reading or re-deriving it.
  let stagedSchemaManifest: Record<string, unknown> | null = null;
  // The source document's revision and sha256, cached during writeFreshOutput
  // so the switch can certify the dual-copy state with a persistent receipt
  // (Issue 01: a layout-7 Home that retains state.json must carry the receipt
  // that proves yui.db was promoted from that exact document).
  let stagedReceiptSource: { revision: number; sha256: string } | null = null;

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
      const statePath = join(home, STORAGE_STATE_FILE);
      const state = existsSync(statePath)
        ? parseJsonObject(readFileSync(statePath, "utf8"), STORAGE_STATE_FILE)
        : null;
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
      // Ensure the layout version is the latest: the orchestrator applies the
      // 6->7 transform before calling us, but direct callers (tests, drills)
      // may pass an untransformed snapshot. Setting it here is idempotent.
      stagedSchemaManifest = {
        ...snapshot.schemaManifest,
        storageVersion: latest.layout,
        updatedAt: now().toISOString()
      };
      if (snapshot.state !== null) {
        // Hash the actual on-disk bytes (the file is retained read-only
        // throughout the migration), not a re-serialization of the parsed
        // snapshot, so the receipt can be compared against the file itself.
        const stateRaw = readFileSync(join(home, STORAGE_STATE_FILE), "utf8");
        stagedReceiptSource = {
          revision: typeof snapshot.state.revision === "number" ? snapshot.state.revision : 0,
          sha256: createHash("sha256").update(stateRaw, "utf8").digest("hex")
        };
        populateSqliteFromState(home, snapshot.state, STAGED_DATABASE_FILENAME);
      } else {
        // An empty Home (no state.json) still gets a schema-ready database.
        stagedReceiptSource = { revision: 0, sha256: "" };
        populateSqliteFromState(home, {}, STAGED_DATABASE_FILENAME);
      }
    },

    rebuildDerivedState(effects: readonly string[]): DerivedStateSummary {
      // The SQLite database is fully normalised by populateSqliteFromState;
      // there is no separate derived index to rebuild. Echo the declared
      // effects for the report, mirroring the file target.
      return { rebuiltEffects: [...effects] };
    },

    validateCurrentState(): ValidationSummary {
      // Independently re-read state.json from disk (not the in-memory snapshot
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
            detail: `verified ${familyCount} record families against an independent state.json re-read`
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

      // Phase 1: back up any existing yui.db, then promote the sidecar.
      try {
        if (existsSync(committedDbPath)) {
          backupPath = join(home, `${COMMITTED_DATABASE_FILENAME}.backup-${stamp}`);
          if (existsSync(backupPath)) {
            throw new Error(`Refusing to overwrite an existing database backup: ${backupPath}.`);
          }
          moveSqliteFileSet(committedDbPath, backupPath);
        }
        renameSync(stagedDbPath, committedDbPath);
        // The staged connection may leave empty WAL/SHM sidecars behind
        // even after a clean close; they are dead once promoted.
        rmSync(`${stagedDbPath}-wal`, { force: true });
        rmSync(`${stagedDbPath}-shm`, { force: true });
      } catch (error) {
        // Pre-promotion failure: restore the original database if we moved it.
        if (backupPath !== undefined && existsSync(backupPath)) {
          try {
            moveSqliteFileSet(backupPath, committedDbPath);
          } catch {
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

      // Phase 2: advance schema.json to layout 7 in the same critical section.
      try {
        if (stagedSchemaManifest !== null) {
          writeTextFileAtomically(
            join(home, STORAGE_SCHEMA_FILE),
            `${JSON.stringify(stagedSchemaManifest, null, 2)}\n`
          );
        }
        // Certify the dual-copy state (Issue 01): the 6→7 migration retains
        // state.json read-only, so the Home legitimately holds both copies.
        // The persistent receipt is the evidence that lets the classifier and
        // doctor distinguish this certified switch from a drifted conflict.
        if (stagedReceiptSource !== null) {
          const familyCount = Object.keys(
            computeDbFamilyChecksums(home, COMMITTED_DATABASE_FILENAME)
          ).length;
          writeMigrationReceipt(home, {
            kind: "layout6-to-7",
            completedAt: now().toISOString(),
            sourceRevision: stagedReceiptSource.revision,
            targetLayoutVersion: latest.layout,
            sourceStateSha256: stagedReceiptSource.sha256,
            verifiedFamilies: familyCount
          });
        }
      } catch (error) {
        // The database is promoted but schema.json could not be advanced.
        // Attempt to restore the original database; if that fails, the Home
        // is ambiguous and must be recovered manually.
        try {
          if (backupPath !== undefined && existsSync(backupPath)) {
            removeSqliteFileSet(committedDbPath);
            moveSqliteFileSet(backupPath, committedDbPath);
          } else {
            removeSqliteFileSet(committedDbPath);
          }
        } catch {
          throw new AmbiguousSwitchError({
            homePath: home,
            backupPath: backupPath ?? committedDbPath,
            stagingPath: stagedDbPath,
            detail:
              `SQLite database was promoted but schema.json could not be advanced (${messageOf(error)}), ` +
              `and the automatic rollback also failed. The database is at ${committedDbPath}; ` +
              `recover by advancing schema.json storageVersion to ${latest.layout} or restoring the backup.`
          });
        }
        throw error;
      }

      return {
        status: "switched",
        ...(backupPath === undefined ? {} : { backupPath }),
        detail: `SQLite database promoted to ${committedDbPath} and schema.json advanced to layout ${latest.layout}.`
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
    const statePath = join(home, STORAGE_STATE_FILE);
    const state = existsSync(statePath)
      ? parseJsonObject(readFileSync(statePath, "utf8"), STORAGE_STATE_FILE)
      : null;
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
        `SQLite migration verification cannot derive expected state: ${plan.blocker.message}`
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
        `SQLite migration checksum mismatch for ${mismatches.length} family/families: ${mismatches.join("; ")}`
      );
    }
  }
}

/**
 * Roll back a committed layout-7 SQLite migration: quarantine `yui.db` and
 * flip `schema.json` back to layout 6. A layout-6→7 migration retained
 * `state.json` read-only in place, so it is untouched there. A pseudo-layout-7
 * repair archived it to `state.json.backup-*`; when `state.json` is absent the
 * newest backup is restored so the layout-6 File store recovers every
 * pre-switch committed revision. The persistent migration receipt is removed.
 *
 * Returns the quarantine path. Throws if the Home is not at layout 7, has no
 * `yui.db` to quarantine, or has neither `state.json` nor a backup to restore.
 */
export function rollbackSqliteMigration(
  home: string,
  options: { now?: () => Date } = {}
): string {
  const now = options.now ?? (() => new Date());
  const schemaPath = join(home, STORAGE_SCHEMA_FILE);
  const manifest = parseJsonObject(readFileSync(schemaPath, "utf8"), STORAGE_SCHEMA_FILE) as ParsedStorageManifest;
  if (manifest.storageVersion !== 7) {
    throw new Error(
      `Rollback requires a layout-7 Home; found layout ${manifest.storageVersion}.`
    );
  }
  const dbPath = join(home, COMMITTED_DATABASE_FILENAME);
  if (!existsSync(dbPath)) {
    throw new Error(`No SQLite database to quarantine: ${dbPath}.`);
  }
  const stamp = now().toISOString().replace(/[:.]/g, "-");
  const quarantinePath = join(home, `${COMMITTED_DATABASE_FILENAME}.quarantine-${stamp}`);
  if (existsSync(quarantinePath)) {
    throw new Error(`Refusing to overwrite an existing quarantine: ${quarantinePath}.`);
  }
  renameSync(dbPath, quarantinePath);
  // Clean up WAL/SHM sidecars.
  rmSync(`${dbPath}-wal`, { force: true });
  rmSync(`${dbPath}-shm`, { force: true });

  // Restore the file-store authoritative document when the repair archived it.
  const statePath = join(home, STORAGE_STATE_FILE);
  if (!existsSync(statePath)) {
    const backupPath = latestStateBackupPath(home);
    if (backupPath === null) {
      throw new Error(
        `Rollback requires ${STORAGE_STATE_FILE} or a state.json.backup-* archive; neither exists.`
      );
    }
    renameSync(backupPath, statePath);
  }

  // The persistent receipt certified the switch being rolled back.
  rmSync(migrationReceiptPath(home), { force: true });

  // Flip schema.json back to layout 6.
  const rolledBack: Record<string, unknown> = { ...manifest, storageVersion: 6 };
  writeTextFileAtomically(schemaPath, `${JSON.stringify(rolledBack, null, 2)}\n`);
  return quarantinePath;
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
