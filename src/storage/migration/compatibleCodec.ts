import { isDeepStrictEqual } from "node:util";

import { planMigration } from "./planner.js";
import type { MigrationRegistry } from "./registry.js";
import type { StorageVersionState } from "./types.js";

export class StorageCompatibilityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StorageCompatibilityError";
  }
}

export type CompatibleLoadOptions<Snapshot> = Readonly<{
  registry: MigrationRegistry<Snapshot>;
  source: StorageVersionState;
  latest: StorageVersionState;
  snapshot: Snapshot;
  /** Extract versions from the normalized in-memory value, without writing it. */
  inspectVersions: (snapshot: Snapshot) => StorageVersionState;
  /** The strict current-model parser/reference gate. */
  validateCurrent: (snapshot: Snapshot) => void;
}>;

/**
 * Apply an all-compatible declaration chain in memory. This never writes the
 * source. It rejects offline paths, missing declarations/steps, non-fresh
 * normalizers, and output which does not pass the strict current-model gate.
 */
export function loadCompatibleSnapshot<Snapshot>(
  options: CompatibleLoadOptions<Snapshot>
): Snapshot {
  const plan = planMigration(options.registry, options.source, options.latest);
  if (plan.kind === "blocked") {
    throw new StorageCompatibilityError(plan.blocker.message);
  }
  if (plan.kind === "runnable" && plan.path !== "compatible") {
    throw new StorageCompatibilityError(
      "Storage requires an offline migration and cannot be normalized by the compatible loader."
    );
  }

  let current = options.snapshot;
  if (plan.kind === "runnable") {
    for (const planned of plan.steps) {
      planned.step.preconditions(current);
      const next = planned.step.transform(current);
      if (next === current && typeof next === "object" && next !== null) {
        throw new StorageCompatibilityError(
          `Compatible normalizer ${planned.axis}` +
            `${planned.recordKind ? `/${planned.recordKind}` : ""} ` +
            `${planned.fromVersion}->${planned.toVersion} returned its input object.`
        );
      }
      current = next;
    }
  }
  assertCurrentVersions(options.inspectVersions(current), options.latest, "normalized model");
  options.validateCurrent(current);
  return current;
}

export type CurrentWriteOptions<Model, Snapshot> = Readonly<{
  model: Model;
  latest: StorageVersionState;
  encode: (model: Model) => Snapshot;
  inspectVersions: (snapshot: Snapshot) => StorageVersionState;
  validateCurrent: (snapshot: Snapshot) => void;
}>;

/**
 * Encode only the current record contract. There is intentionally no old
 * writer or dual-write branch: a non-current encoding fails before persistence.
 */
export function writeCurrentSnapshot<Model, Snapshot>(
  options: CurrentWriteOptions<Model, Snapshot>
): Snapshot {
  const snapshot = options.encode(options.model);
  assertCurrentVersions(options.inspectVersions(snapshot), options.latest, "writer output");
  options.validateCurrent(snapshot);
  return snapshot;
}

function assertCurrentVersions(
  actual: StorageVersionState,
  latest: StorageVersionState,
  label: string
): void {
  if (!isDeepStrictEqual(actual, latest)) {
    throw new StorageCompatibilityError(
      `Compatible ${label} is not at the current storage versions; old-version writing is forbidden.`
    );
  }
}
