/**
 * Deterministic repair for a *pseudo-layout-7* Home (Issue 01).
 *
 * A pseudo-layout-7 Home declares layout 7 in `schema.json` but has no `yui.db`;
 * its `state.json` is still the only authoritative copy. The classifier reports
 * this as `NEEDS_STORAGE_REPAIR`. This module rebuilds the SQLite database from
 * the pinned `state.json`, verifies every record family against an independent
 * re-read, promotes the staged database atomically, certifies the switch with a
 * persistent migration receipt, read-backs through a fresh store, and archives
 * `state.json` to a timestamped backup so it can never serve as a writable
 * fallback again.
 *
 * Failure semantics (issue: 最简失败语义):
 *  - staging/verification failure: `state.json` stays authoritative, the staged
 *    database is discarded, the manifest is untouched;
 *  - a stale staged database from a crashed attempt is always rebuilt, never
 *    reused;
 *  - any failure after the atomic promote quarantines the promoted database and
 *    removes the receipt, returning the Home to its exact pre-repair shape;
 *  - the one non-fatal tail is archiving `state.json`: if that rename fails the
 *    database is already promoted, verified, and receipt-certified, and the
 *    result is `blocked` with the exact manual finishing step.
 */

import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";

import { readStorageSchemaManifest } from "../storageSchema.js";
import { STORAGE_STATE_FILE } from "../taskStore.js";
import { SqliteTaskStore } from "../sqliteStore.js";
import type { StorageVersionState } from "../migration/index.js";
import { migrationReceiptPath, writeMigrationReceipt } from "./migrationReceipt.js";
import {
  COMMITTED_DATABASE_FILENAME,
  STAGED_DATABASE_FILENAME,
  computeDbFamilyChecksums,
  populateSqliteFromState,
  verifySqliteChecksums
} from "./sqliteStateMigration.js";

/** The repair stage at which a blocker was produced. */
export type PseudoLayoutRepairStage = "validate" | "switch" | "post-verify";

export type PseudoLayoutRepairOptions = Readonly<{
  home: string;
  latest: StorageVersionState;
  mode: "dry-run" | "execute";
  now?: () => Date;
}>;

export type PseudoLayoutRepairResult = Readonly<
  | {
      outcome: "repaired";
      stateBackupPath: string;
      verifiedFamilies: number;
      sourceRevision: number;
    }
  | {
      outcome: "dry-run";
      verifiedFamilies: number;
      sourceRevision: number;
    }
  | {
      outcome: "blocked";
      stage: PseudoLayoutRepairStage;
      message: string;
      action: string;
    }
>;

/**
 * Run the staged state.json→SQLite repair. Never throws for an expected
 * blocker; a malformed manifest or an unreadable `state.json` is a `blocked`
 * result, not an exception.
 */
export function repairPseudoLayout7(
  options: PseudoLayoutRepairOptions
): PseudoLayoutRepairResult {
  const { home, latest, mode } = options;
  const now = options.now ?? (() => new Date());
  const statePath = join(home, STORAGE_STATE_FILE);
  const stagedPath = join(home, STAGED_DATABASE_FILENAME);
  const committedPath = join(home, COMMITTED_DATABASE_FILENAME);

  // 1. Re-verify the preconditions fail-closed; the repair never trusts a
  //    classifier verdict produced by an earlier process.
  let manifest;
  try {
    manifest = readStorageSchemaManifest(home);
  } catch (error) {
    return blocked(
      "validate",
      `The storage manifest could not be read: ${messageOf(error)}`,
      "Restore schema.json from a backup; the repair requires a readable layout-7 manifest."
    );
  }
  if (manifest.storageVersion !== latest.layout) {
    return blocked(
      "validate",
      `Pseudo-layout-7 repair requires a layout-${latest.layout} manifest; found layout ${manifest.storageVersion}.`,
      "Re-run `yui doctor`; this repair only applies to a pseudo-layout-7 Home."
    );
  }
  if (existsSync(committedPath)) {
    return blocked(
      "validate",
      `Refusing to repair: ${COMMITTED_DATABASE_FILENAME} already exists.`,
      "The Home already has a SQLite database. If it is damaged, restore it from a backup; do not rebuild over it."
    );
  }
  if (!existsSync(statePath)) {
    return blocked(
      "validate",
      `Pseudo-layout-7 repair requires a readable ${STORAGE_STATE_FILE}; none exists.`,
      `Restore ${STORAGE_STATE_FILE} from a backup; the repair cannot rebuild a database without its source.`
    );
  }

  // 2. Pin state.json (revision, size, sha256). A document that is not a
  //    strictly readable JSON object fails the repair.
  const pin = pinStateFile(statePath);
  if (pin === null) {
    return blocked(
      "validate",
      `${STORAGE_STATE_FILE} is not a strictly readable JSON object.`,
      "The source document is damaged; restore it from a backup before repairing."
    );
  }

  // 3. A stale staged database from a crashed attempt is rebuilt, never reused.
  discardStaged(stagedPath);

  // 4. Stage: populate yui.db.staged from the pinned document.
  try {
    populateSqliteFromState(home, pin.state, STAGED_DATABASE_FILENAME);
  } catch (error) {
    discardStaged(stagedPath);
    return blocked(
      "validate",
      `Staging the SQLite database failed: ${messageOf(error)}`,
      `${STORAGE_STATE_FILE} remains the authoritative store; the staged database was discarded.`
    );
  }

  // 5. Verify: the pinned bytes must be unchanged (no concurrent writer), and
  //    every record family must match an independent state.json re-read by
  //    count and content checksum.
  try {
    if (sha256(readFileSync(statePath, "utf8")) !== pin.sha256) {
      discardStaged(stagedPath);
      return blocked(
        "validate",
        `${STORAGE_STATE_FILE} changed during the repair; a concurrent writer is active.`,
        "Quiesce all writers and retry; the staged database was discarded and state.json remains authoritative."
      );
    }
    verifySqliteChecksums(pin.state, home, STAGED_DATABASE_FILENAME);
  } catch (error) {
    discardStaged(stagedPath);
    return blocked(
      "validate",
      `Staged database verification failed: ${messageOf(error)}`,
      `${STORAGE_STATE_FILE} remains the authoritative store; the staged database was discarded.`
    );
  }
  const verifiedFamilies = Object.keys(
    computeDbFamilyChecksums(home, STAGED_DATABASE_FILENAME)
  ).length;

  if (mode === "dry-run") {
    discardStaged(stagedPath);
    return { outcome: "dry-run", verifiedFamilies, sourceRevision: pin.revision };
  }

  // 6. Promote: atomic rename staged -> yui.db. From here the database exists;
  //    any failure rolls the promotion back so the Home keeps its pre-repair
  //    shape (manifest 7, no yui.db, state.json authoritative).
  try {
    renameSync(stagedPath, committedPath);
    // The staged connection may leave empty WAL/SHM sidecars behind even
    // after a clean close; they are dead once the main file is promoted.
    rmSync(`${stagedPath}-wal`, { force: true });
    rmSync(`${stagedPath}-shm`, { force: true });
  } catch (error) {
    discardStaged(stagedPath);
    return blocked(
      "switch",
      `Promoting the staged database failed: ${messageOf(error)}`,
      `${STORAGE_STATE_FILE} remains the authoritative store; the staged database was discarded.`
    );
  }

  // 7. Write the persistent migration receipt. A dual-copy Home without a
  //    receipt is a conflict, so a receipt-write failure rolls the promotion
  //    back rather than leaving an uncertified database behind.
  try {
    writeMigrationReceipt(home, {
      kind: "pseudo-layout-7-repair",
      completedAt: now().toISOString(),
      sourceRevision: pin.revision,
      targetLayoutVersion: latest.layout,
      sourceStateSha256: pin.sha256,
      verifiedFamilies
    });
  } catch (error) {
    rollbackPromotion(home, committedPath, now);
    return blocked(
      "post-verify",
      `The database was promoted but the migration receipt could not be written: ${messageOf(error)}`,
      `The promoted database was quarantined and the receipt removed; ${STORAGE_STATE_FILE} remains authoritative. Retry the repair.`
    );
  }

  // 8. Read-back through a fresh store, including revision continuity.
  try {
    const store = new SqliteTaskStore(home);
    try {
      store.getConfig();
      store.listTasks();
      store.listProjects();
      store.listConfiguredAgents();
      store.listWorkMailboxes();
      const dbRevision = store.getRevision();
      if (dbRevision !== pin.revision) {
        throw new Error(
          `revision mismatch: ${STORAGE_STATE_FILE}=${pin.revision} database=${dbRevision}`
        );
      }
    } finally {
      store.close();
    }
  } catch (error) {
    rollbackPromotion(home, committedPath, now);
    return blocked(
      "post-verify",
      `Post-promote read-back failed: ${messageOf(error)}`,
      `The promoted database was quarantined and the receipt removed; ${STORAGE_STATE_FILE} remains authoritative. Retry the repair.`
    );
  }

  // 9. Archive state.json so it can never serve as a writable fallback. The
  //    receipt certifies the dual-copy window, so a failure here leaves a
  //    usable Home: the database is authoritative and the repair is finished by
  //    moving the file manually.
  const stamp = now().toISOString().replace(/[:.]/g, "-");
  const stateBackupPath = join(home, `${STORAGE_STATE_FILE}.backup-${stamp}`);
  try {
    if (existsSync(stateBackupPath)) {
      throw new Error(`refusing to overwrite an existing state backup: ${stateBackupPath}`);
    }
    renameSync(statePath, stateBackupPath);
  } catch (error) {
    return blocked(
      "post-verify",
      `The database was promoted and verified, but ${STORAGE_STATE_FILE} could not be archived: ${messageOf(error)}`,
      `The database is authoritative and the migration receipt certifies it. Move ${STORAGE_STATE_FILE} to ${stateBackupPath} manually to finish the repair.`
    );
  }

  return {
    outcome: "repaired",
    stateBackupPath,
    verifiedFamilies,
    sourceRevision: pin.revision
  };
}

/** The newest `state.json.backup-*` path in a Home, or `null` when none exists. */
export function latestStateBackupPath(home: string): string | null {
  const entries = listStateBackups(home);
  return entries.length === 0 ? null : entries[entries.length - 1];
}

/** All `state.json.backup-*` paths in a Home, sorted oldest-first. */
export function listStateBackups(home: string): string[] {
  let names: string[];
  try {
    names = readdirSync(home);
  } catch {
    return [];
  }
  return names
    .filter((name) => name.startsWith(`${STORAGE_STATE_FILE}.backup-`))
    .sort()
    .map((name) => join(home, name));
}

// -- helpers ----------------------------------------------------------------

type PinnedState = Readonly<{
  state: Record<string, unknown>;
  revision: number;
  sha256: string;
  size: number;
}>;

function pinStateFile(statePath: string): PinnedState | null {
  let raw: string;
  try {
    raw = readFileSync(statePath, "utf8");
  } catch {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return null;
  }
  const state = parsed as Record<string, unknown>;
  return {
    state,
    revision: typeof state.revision === "number" ? state.revision : 0,
    sha256: createHash("sha256").update(raw, "utf8").digest("hex"),
    size: Buffer.byteLength(raw, "utf8")
  };
}

function sha256(raw: string): string {
  return createHash("sha256").update(raw, "utf8").digest("hex");
}

function discardStaged(stagedPath: string): void {
  rmSync(stagedPath, { force: true });
  rmSync(`${stagedPath}-wal`, { force: true });
  rmSync(`${stagedPath}-shm`, { force: true });
}

function quarantine(committedPath: string, now: () => Date): string {
  const stamp = now().toISOString().replace(/[:.]/g, "-");
  const quarantinePath = `${committedPath}.quarantine-${stamp}`;
  renameSync(committedPath, quarantinePath);
  rmSync(`${committedPath}-wal`, { force: true });
  rmSync(`${committedPath}-shm`, { force: true });
  return quarantinePath;
}

function rollbackPromotion(
  home: string,
  committedPath: string,
  now: () => Date
): void {
  quarantine(committedPath, now);
  rmSync(migrationReceiptPath(home), { force: true });
}

function blocked(
  stage: PseudoLayoutRepairStage,
  message: string,
  action: string
): Extract<PseudoLayoutRepairResult, { outcome: "blocked" }> {
  return { outcome: "blocked", stage, message, action };
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
