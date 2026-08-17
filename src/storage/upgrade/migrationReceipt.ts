/**
 * The persistent migration receipt — a durable, in-Home record of the
 * physical-backend transition that produced the current `yui.db`.
 *
 * ## Why (the dual-copy ambiguity problem)
 *
 * A layout-7 Home may legitimately contain both `state.json` and `yui.db`
 * during the narrow switch window, or illegitimately after a crashed/torn
 * transition. Without durable evidence, a reader cannot tell "the SQLite
 * database was just promoted from this exact state.json" from "two
 * authoritative copies drifted apart". The receipt is written only after the
 * staged database is fully verified and atomically promoted, so its presence
 * (correlating the source revision and checksum) certifies the dual-copy state
 * as a fresh, intentional switch rather than a conflict.
 *
 * Unlike the temporary upgrade completion receipt (`<home>.upgrade-receipt.json`,
 * a sibling of the Home used by the update flow), this receipt lives INSIDE the
 * Home at `migration-receipt.json` and persists for the Home's lifetime: it is
 * the physical-backend provenance that `doctor` and the classifier read.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { writeTextFileAtomically } from "../durableFile.js";

/** The kind of physical-backend transition a receipt certifies. */
export type MigrationReceiptKind =
  | "layout6-to-7"
  | "pseudo-layout-7-repair";

/** A persistent record of the transition that produced the current database. */
export type PersistentMigrationReceipt = Readonly<{
  kind: MigrationReceiptKind;
  /** When the transition committed (ISO 8601). */
  completedAt: string;
  /** The committed `state.json` revision the database was built from. */
  sourceRevision: number;
  /** The layout version the transition produced. */
  targetLayoutVersion: number;
  /** sha256 of the source `state.json` bytes the database was verified against. */
  sourceStateSha256: string;
  /** Number of record families verified during the switch. */
  verifiedFamilies: number;
  /** The timestamped `state.json` backup retained for explicit rollback. */
  stateBackupPath?: string;
}>;

/** The persistent receipt path inside a Home. */
export function migrationReceiptPath(home: string): string {
  return join(home, "migration-receipt.json");
}

/** Write the persistent receipt atomically, just after the database promotes. */
export function writeMigrationReceipt(
  home: string,
  receipt: PersistentMigrationReceipt
): void {
  writeTextFileAtomically(
    migrationReceiptPath(home),
    `${JSON.stringify(receipt, null, 2)}\n`
  );
}

/**
 * Read the persistent receipt, or `null` when absent. A malformed or
 * untrustworthy receipt reads as `null`: the receipt is provenance evidence,
 * not an authority, and a Home whose receipt cannot be parsed must fail closed
 * to the dual-copy conflict diagnosis rather than trust a torn write.
 */
export function readMigrationReceipt(home: string): PersistentMigrationReceipt | null {
  const path = migrationReceiptPath(home);
  if (!existsSync(path)) return null;
  try {
    const value = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    if (
      (value.kind !== "layout6-to-7" && value.kind !== "pseudo-layout-7-repair")
      || typeof value.completedAt !== "string"
      || !Number.isInteger(value.sourceRevision)
      || !Number.isInteger(value.targetLayoutVersion)
      || typeof value.sourceStateSha256 !== "string"
      || !Number.isInteger(value.verifiedFamilies)
    ) {
      return null;
    }
    return {
      kind: value.kind,
      completedAt: value.completedAt,
      sourceRevision: value.sourceRevision as number,
      targetLayoutVersion: value.targetLayoutVersion as number,
      sourceStateSha256: value.sourceStateSha256,
      verifiedFamilies: value.verifiedFamilies as number,
      ...(typeof value.stateBackupPath === "string"
        ? { stateBackupPath: value.stateBackupPath }
        : {})
    };
  } catch {
    return null;
  }
}
