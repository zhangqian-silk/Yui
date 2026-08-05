/**
 * The atomic-switch progress marker — a durable, out-of-band record of where a
 * two-step storage switch is in its lifecycle.
 *
 * ## Why (the partial-switch problem, P1-4)
 *
 * `atomicSwitchWithBackup` promotes a staged Home with two atomic renames on the
 * same filesystem:
 *
 *   1. `home -> backup`   (move the original aside)
 *   2. `staging -> home`  (promote the migrated output into place)
 *
 * The only non-atomic window is *between* those renames. If step 2 fails after
 * step 1 committed, the original Home no longer exists at its path — so a naive
 * "the source Home is unchanged" claim is FALSE. The switch either rolled back
 * (original restored, truly unchanged) or is genuinely interrupted (original at
 * the backup, nothing promoted into `home`).
 *
 * This marker makes the phase durable and readable AFTER the fact, so the
 * orchestrator can tell:
 *  - **not-started** — no marker (or cleared): nothing moved; source unchanged.
 *  - **interrupted** — `phase: "interrupted"`: the original was moved aside and
 *    neither promotion nor rollback completed; recover from the backup.
 *  - **complete**    — the switch cleared its marker after a fully-committed
 *    promotion.
 *
 * It lives at a SIBLING path of the Home (`<home>.upgrade-switch.json`), never
 * inside it, so it survives the `home -> backup` / `staging -> home` renames —
 * exactly like the completion receipt it coordinates with (see
 * `upgradeReceipt.ts`).
 */

import { existsSync, readFileSync, rmSync } from "node:fs";
import { basename, dirname, join } from "node:path";

import { writeTextFileAtomically } from "../durableFile.js";

/**
 * The lifecycle phase of a two-step switch.
 *
 * - `backing-up` — about to move `home -> backup`; nothing has moved yet.
 * - `promoting`  — the original was moved to the backup; about to promote
 *   `staging -> home`. This is the one non-atomic window.
 * - `interrupted`— promotion failed AND the rollback to restore the original
 *   also failed; the switch is in a partially-applied state.
 */
export type SwitchPhase = "backing-up" | "promoting" | "interrupted";

/** A durable switch-progress record. */
export type SwitchProgress = Readonly<{
  phase: SwitchPhase;
  /** The logical Home path being switched. */
  homePath: string;
  /** Where the original Home was (or will be) moved for backup. */
  backupPath: string;
  /** The staged migrated output that (was to) become the new Home. */
  stagingPath: string;
  /** When this phase was recorded (ISO 8601). */
  updatedAt: string;
}>;

/** The sibling switch-progress marker path for a Home. */
export function switchProgressPath(home: string): string {
  return join(dirname(home), `${basename(home)}.upgrade-switch.json`);
}

/** Write the switch-progress marker atomically. */
export function writeSwitchProgress(home: string, progress: SwitchProgress): void {
  writeTextFileAtomically(
    switchProgressPath(home),
    `${JSON.stringify(progress, null, 2)}\n`
  );
}

/**
 * Read the switch-progress marker, or `null` when absent/unreadable/malformed.
 * A marker whose `phase` is not a recognized value reads as `null` — the caller
 * treats an unreadable marker conservatively (it separately inspects the backup
 * and the on-disk Home).
 */
export function readSwitchProgress(home: string): SwitchProgress | null {
  const path = switchProgressPath(home);
  if (!existsSync(path)) return null;
  try {
    const value = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    const phase = value.phase;
    if (phase !== "backing-up" && phase !== "promoting" && phase !== "interrupted") {
      return null;
    }
    if (
      typeof value.homePath !== "string"
      || typeof value.backupPath !== "string"
      || typeof value.stagingPath !== "string"
      || typeof value.updatedAt !== "string"
    ) {
      return null;
    }
    return {
      phase,
      homePath: value.homePath,
      backupPath: value.backupPath,
      stagingPath: value.stagingPath,
      updatedAt: value.updatedAt
    };
  } catch {
    return null;
  }
}

/** Best-effort removal of the switch-progress marker (on rollback / completion). */
export function clearSwitchProgress(home: string): void {
  rmSync(switchProgressPath(home), { force: true });
}
