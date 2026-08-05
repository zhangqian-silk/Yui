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

import { existsSync, readFileSync, rmSync } from "node:fs";
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
 * Validate that a receipt corresponds to the current Home/backup before trusting
 * it for a recovery decision (P2-6). The correspondence rules, each closing a
 * concrete staleness gap:
 *
 *  - **no receipt** — nothing to correlate.
 *  - **home mismatch** — the receipt names a different `homePath`: it is about a
 *    different target Home (e.g. a copied receipt) and says nothing about this one.
 *  - **backup missing** — the receipt names a `backupPath` that no longer exists:
 *    the switch it recorded was already rolled back (operator restored the
 *    backup) or the backup was cleaned, so it is NOT current evidence of a
 *    committed switch. Re-probe the real on-disk state instead.
 *
 * A receipt WITHOUT a `backupPath` (older/degraded form) can only be weakly
 * corroborated; it corresponds only when its `homePath` matches (or is absent),
 * and the caller must still consult the on-disk schema.
 */
export function correlateUpgradeReceipt(home: string): ReceiptCorrelation {
  const receipt = readUpgradeReceipt(home);
  if (receipt === null) {
    return { corresponds: false, reason: "no receipt present", receipt: null };
  }
  if (receipt.homePath !== undefined && receipt.homePath !== home) {
    return {
      corresponds: false,
      reason: `receipt names a different Home (${receipt.homePath} != ${home})`,
      receipt
    };
  }
  if (receipt.backupPath !== undefined && !existsSync(receipt.backupPath)) {
    return {
      corresponds: false,
      reason: `receipt backup ${receipt.backupPath} no longer exists (already restored or cleaned)`,
      receipt
    };
  }
  return { corresponds: true, receipt };
}

/** Best-effort removal of the receipt (on clean success or before a fresh run). */
export function clearUpgradeReceipt(home: string): void {
  rmSync(upgradeReceiptPath(home), { force: true });
}
