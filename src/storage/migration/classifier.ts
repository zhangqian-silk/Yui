/**
 * The pure four-state compatibility classifier.
 *
 * Given the source and target (latest-supported) version states, an EMPTY-or-
 * populated registry, and an optional caller-supplied corruption signal, it
 * returns exactly one verdict:
 *
 * - `USABLE`            — every axis is already at the current version.
 * - `MIGRATABLE`        — strictly older, and every axis has a complete
 *   deterministic adjacent step path.
 * - `NEEDS_NEW_VERSION` — any axis is newer than supported (`future-version`),
 *   or older with a broken/absent step path (`missing-step`). Carries a precise
 *   reason + action. Under an EMPTY registry, any strictly-older version lands
 *   here via `missing-step` — matching the existing fail-closed behavior.
 * - `CORRUPTED`         — only when the caller reports real JSON/structural/
 *   reference-invariant damage. The classifier never infers corruption from
 *   version numbers.
 *
 * There are no baseline/pre-release special cases: compatibility is decided
 * solely by explicit registry step-paths, never by version magnitude or semver.
 */

import { planMigration } from "./planner.js";
import type { MigrationRegistry } from "./registry.js";
import type {
  MigrationBlocker,
  StorageVersionState
} from "./types.js";

/** A caller-detected corruption fact (parse failure, broken reference graph). */
export type CorruptionSignal = Readonly<{
  corrupted: true;
  detail: string;
}>;

export type Classification = Readonly<
  | { verdict: "USABLE" }
  | { verdict: "MIGRATABLE"; stepCount: number }
  | { verdict: "NEEDS_NEW_VERSION"; blocker: MigrationBlocker }
  | { verdict: "CORRUPTED"; detail: string }
>;

/**
 * Classify a storage target. Pure: no I/O, no mutation, deterministic.
 *
 * `corruption` is supplied by the caller when parsing/structural/reference
 * validation has already failed; when present it takes precedence, because a
 * corrupted target's version numbers cannot be trusted.
 */
export function classifyStorage<Snapshot>(
  registry: MigrationRegistry<Snapshot>,
  source: StorageVersionState,
  target: StorageVersionState,
  corruption?: CorruptionSignal
): Classification {
  if (corruption?.corrupted === true) {
    return { verdict: "CORRUPTED", detail: corruption.detail };
  }

  const plan = planMigration(registry, source, target);
  switch (plan.kind) {
    case "no-op":
      return { verdict: "USABLE" };
    case "runnable":
      return { verdict: "MIGRATABLE", stepCount: plan.steps.length };
    case "blocked":
      return { verdict: "NEEDS_NEW_VERSION", blocker: plan.blocker };
  }
}
