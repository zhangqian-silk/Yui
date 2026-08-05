/**
 * The upgrade completion receipt — a verifiable, out-of-band marker that a
 * storage switch actually committed.
 *
 * ## Why (the activation-ambiguity problem)
 *
 * `yui update` activates storage by spawning the staged binary's `yui upgrade`.
 * If that child is killed (SIGTERM/OOM) *after* the atomic switch commits but
 * *before* it prints its success JSON, the parent sees empty stdout and cannot
 * tell "nothing happened" from "storage already switched". Treating that as
 * recoverable (source unchanged) is a false claim that can hide a completed
 * migration.
 *
 * The receipt closes that gap: `runStorageUpgrade` writes it the instant the
 * switch commits and clears it only on a clean, fully-verified return. So its
 * presence is a durable "the switch committed but clean completion was not
 * confirmed" signal that the parent can read even when stdout was lost.
 *
 * It lives at a SIBLING path of the Home (`<home>.upgrade-receipt.json`), never
 * inside it, so it survives the switch's `home -> backup` / `staging -> home`
 * renames and is readable by both the child (new binary) and the parent (old
 * binary), which share the same fixed `YUI_HOME` path.
 */

import { existsSync, readFileSync, rmSync, statSync } from "node:fs";
import { basename, dirname, join } from "node:path";

import { writeTextFileAtomically } from "../durableFile.js";

/** A committed-switch receipt. */
export type UpgradeReceipt = Readonly<{
  /** Always true: the atomic switch committed. */
  switched: true;
  /**
   * The logical Home path this receipt is about. A receipt whose `homePath` does
   * not match the Home being probed is from a different target and must not be
   * trusted as evidence of THIS Home's state (P2-6).
   */
  homePath?: string;
  /** The timestamped backup of the pre-switch Home (for manual recovery). */
  backupPath?: string;
  /** Target on-disk layout version the switch produced (for correlation). */
  targetLayoutVersion?: number;
  /** Target aggregate schema version the switch produced (for correlation). */
  targetAggregateVersion?: number;
  /** When the switch committed (ISO 8601). */
  completedAt: string;
}>;

/** The sibling receipt path for a Home. */
export function upgradeReceiptPath(home: string): string {
  return join(dirname(home), `${basename(home)}.upgrade-receipt.json`);
}

/** Write the completion receipt atomically, just after the switch commits. */
export function writeUpgradeReceipt(home: string, receipt: UpgradeReceipt): void {
  writeTextFileAtomically(
    upgradeReceiptPath(home),
    `${JSON.stringify(receipt, null, 2)}\n`
  );
}

/**
 * Read the completion receipt, or `null` when absent/unreadable. A malformed
 * receipt reads as `null`: it is only ever corroborating evidence, and the
 * caller separately inspects the on-disk schema and backup.
 */
export function readUpgradeReceipt(home: string): UpgradeReceipt | null {
  const path = upgradeReceiptPath(home);
  if (!existsSync(path)) return null;
  try {
    const value = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    if (value.switched !== true || typeof value.completedAt !== "string") return null;
    return {
      switched: true,
      completedAt: value.completedAt,
      ...(typeof value.homePath === "string" ? { homePath: value.homePath } : {}),
      ...(typeof value.backupPath === "string" ? { backupPath: value.backupPath } : {}),
      ...(Number.isInteger(value.targetLayoutVersion)
        ? { targetLayoutVersion: value.targetLayoutVersion as number }
        : {}),
      ...(Number.isInteger(value.targetAggregateVersion)
        ? { targetAggregateVersion: value.targetAggregateVersion as number }
        : {})
    };
  } catch {
    return null;
  }
}

/**
 * Why a receipt does (not) correspond to the current on-disk state of a Home.
 * A receipt is only trustworthy evidence of THIS attempt's switch when it
 * correlates; a leftover receipt from a prior attempt, a different Home, or one
 * whose backup was already restored/removed must be re-probed, not reused (P2-6).
 */
export type ReceiptCorrelation = Readonly<
  | { corresponds: true; receipt: UpgradeReceipt }
  | { corresponds: false; reason: string; receipt: UpgradeReceipt | null }
>;

/**
 * Validate that a receipt genuinely corresponds to the current Home AND its
 * backup before trusting it for a recovery decision (P2-6 / R3-F6). Existence
 * alone is not correspondence: a receipt is trusted only when it carries the
 * current protocol's correlating fields and its backup is a REAL directory at the
 * exact timestamped-sibling path this Home's switch would have produced. Each
 * rule closes a concrete staleness/impersonation gap:
 *
 *  - **no receipt** — nothing to correlate.
 *  - **missing/foreign homePath** — a legacy receipt without `homePath`, or one
 *    naming a different Home, says nothing trustworthy about THIS Home; the
 *    current protocol always stamps `homePath`, so its absence is a legacy/degraded
 *    marker that must be re-probed, not reused.
 *  - **missing backupPath** — a receipt with no backup path is a degraded/legacy
 *    marker; without the exact backup to correlate against we cannot confirm it,
 *    so we re-probe rather than assert a committed switch.
 *  - **backup not the expected sibling** — a `backupPath` that is not
 *    `<home>.backup-*` in the Home's own parent directory is unrelated evidence
 *    (a copied/foreign receipt); reject it.
 *  - **backup absent or not a directory** — the switch it recorded was already
 *    rolled back/cleaned, or the path is not a real backup dir; re-probe.
 *
 * On any rejection the caller falls back to an explicit "uncertain → re-probe the
 * real on-disk state" rather than deriving a recovery instruction from stale or
 * unrelated evidence.
 */
export function correlateUpgradeReceipt(home: string): ReceiptCorrelation {
  const receipt = readUpgradeReceipt(home);
  if (receipt === null) {
    return { corresponds: false, reason: "no receipt present", receipt: null };
  }
  // The current protocol always records the Home it is about; a receipt without
  // `homePath`, or naming a different Home, is legacy/foreign — never trusted.
  if (receipt.homePath === undefined) {
    return {
      corresponds: false,
      reason: "receipt has no homePath (legacy/degraded marker); re-probing current state",
      receipt
    };
  }
  if (receipt.homePath !== home) {
    return {
      corresponds: false,
      reason: `receipt names a different Home (${receipt.homePath} != ${home})`,
      receipt
    };
  }
  // A trustworthy receipt must carry the exact backup its switch created.
  if (receipt.backupPath === undefined) {
    return {
      corresponds: false,
      reason: "receipt has no backupPath; cannot correlate a committed switch — re-probing",
      receipt
    };
  }
  if (!isExpectedBackupSibling(home, receipt.backupPath)) {
    return {
      corresponds: false,
      reason: `receipt backup ${receipt.backupPath} is not this Home's expected timestamped sibling; unrelated evidence`,
      receipt
    };
  }
  if (!isRealDirectory(receipt.backupPath)) {
    return {
      corresponds: false,
      reason: `receipt backup ${receipt.backupPath} is absent or not a directory (already restored or cleaned)`,
      receipt
    };
  }
  return { corresponds: true, receipt };
}

/**
 * True when `backupPath` is the exact `<home>.backup-<stamp>` sibling in the
 * Home's own parent directory that this Home's atomic switch would produce (see
 * `homeMigrationTarget.atomicSwitchWithBackup`). Rejects any path in a different
 * directory or without the `<basename>.backup-` prefix — i.e. unrelated evidence.
 */
function isExpectedBackupSibling(home: string, backupPath: string): boolean {
  if (dirname(backupPath) !== dirname(home)) return false;
  const prefix = `${basename(home)}.backup-`;
  const name = basename(backupPath);
  return name.startsWith(prefix) && name.length > prefix.length;
}

/** True when `path` exists and is a real directory (not a file/symlink target miss). */
function isRealDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/** Best-effort removal of the receipt (on clean success or before a fresh run). */
export function clearUpgradeReceipt(home: string): void {
  rmSync(upgradeReceiptPath(home), { force: true });
}
