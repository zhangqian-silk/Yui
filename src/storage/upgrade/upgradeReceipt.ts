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
  /** The timestamped backup of the pre-switch Home (for manual recovery). */
  backupPath?: string;
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
      ...(typeof value.backupPath === "string" ? { backupPath: value.backupPath } : {})
    };
  } catch {
    return null;
  }
}

/** Best-effort removal of the receipt (on clean success or before a fresh run). */
export function clearUpgradeReceipt(home: string): void {
  rmSync(upgradeReceiptPath(home), { force: true });
}
