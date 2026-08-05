/**
 * The cross-axis migration path planner.
 *
 * Given the source and target (latest-supported) {@link StorageVersionState}s and
 * a {@link MigrationRegistry}, it produces a deterministically-ordered plan or a
 * precise fail-closed blocker. It performs no I/O and interprets no domain data.
 *
 * Deterministic order encodes the axis dependency: `layout -> aggregate ->
 * record`. Record families are nested inside the aggregate, so their steps run
 * after the aggregate reaches its target version; record kinds are visited in
 * sorted order and each family's steps ascend by version. Any single missing
 * adjacent step, or any axis whose source is newer than supported, fails closed.
 */

import type { MigrationRegistry } from "./registry.js";
import type {
  MigrationAxis,
  MigrationBlocker,
  MigrationPlan,
  PlannedStep,
  StorageVersionState
} from "./types.js";

type AxisChain<Snapshot> = Readonly<
  | { kind: "ok"; steps: readonly PlannedStep<Snapshot>[] }
  | { kind: "blocked"; blocker: MigrationBlocker }
>;

/**
 * Plan the migration from `source` to `target`.
 *
 * Returns `no-op` when every axis is already current, `runnable` with a fully
 * ordered adjacent step chain, or `blocked` with the first fail-closed reason in
 * deterministic axis order (`layout`, then `aggregate`, then record kinds sorted).
 */
export function planMigration<Snapshot>(
  registry: MigrationRegistry<Snapshot>,
  source: StorageVersionState,
  target: StorageVersionState
): MigrationPlan<Snapshot> {
  const ordered: PlannedStep<Snapshot>[] = [];

  // 1) layout, then 2) aggregate — scalars migrate before any nested record.
  for (const axis of ["layout", "aggregate"] as const) {
    const chain = planScalarAxis(registry, axis, source[axis], target[axis]);
    if (chain.kind === "blocked") return { kind: "blocked", blocker: chain.blocker };
    ordered.push(...chain.steps);
  }

  // 3) record families — nested inside the aggregate; visit kinds in sorted
  // order so the plan is deterministic. Only families present in BOTH source and
  // target are version-advanced here; introducing or removing a family is an
  // aggregate-transform concern owned by the injected rebuild/validate boundary.
  const sharedKinds = Object.keys(target.record)
    .filter((kind) => Object.hasOwn(source.record, kind))
    .sort();
  for (const recordKind of sharedKinds) {
    const chain = planRecordFamily(
      registry,
      recordKind,
      source.record[recordKind].version,
      target.record[recordKind].version
    );
    if (chain.kind === "blocked") return { kind: "blocked", blocker: chain.blocker };
    ordered.push(...chain.steps);
  }

  return ordered.length === 0
    ? { kind: "no-op" }
    : { kind: "runnable", steps: ordered };
}

function planScalarAxis<Snapshot>(
  registry: MigrationRegistry<Snapshot>,
  axis: Extract<MigrationAxis, "layout" | "aggregate">,
  from: number,
  to: number
): AxisChain<Snapshot> {
  return planChain(registry, axis, undefined, from, to);
}

function planRecordFamily<Snapshot>(
  registry: MigrationRegistry<Snapshot>,
  recordKind: string,
  from: number,
  to: number
): AxisChain<Snapshot> {
  return planChain(registry, "record", recordKind, from, to);
}

/**
 * Resolve the adjacent step chain that advances one axis from `from` to `to`.
 * A source newer than supported is `future-version`; a gap with no registered
 * adjacent step is `missing-step`. Both carry a precise reason and action.
 */
function planChain<Snapshot>(
  registry: MigrationRegistry<Snapshot>,
  axis: MigrationAxis,
  recordKind: string | undefined,
  from: number,
  to: number
): AxisChain<Snapshot> {
  const label = axisLabel(axis, recordKind);
  if (from > to) {
    return {
      kind: "blocked",
      blocker: {
        reason: "future-version",
        axis,
        ...(recordKind ? { recordKind } : {}),
        found: from,
        supported: to,
        message: `${label} version ${from} is newer than this release supports (${to}).`,
        action: "Upgrade to a newer Yui release that understands this version."
      }
    };
  }
  const steps: PlannedStep<Snapshot>[] = [];
  for (let version = from; version < to; version += 1) {
    const step = registry.lookup(axis, recordKind, version);
    if (step === undefined) {
      return {
        kind: "blocked",
        blocker: {
          reason: "missing-step",
          axis,
          ...(recordKind ? { recordKind } : {}),
          from: version,
          to: version + 1,
          message: `No migration step is registered for ${label} ${version}->${version + 1}.`,
          action:
            "This version cannot be migrated by this release; a newer release must provide the step."
        }
      };
    }
    steps.push({
      axis,
      ...(recordKind ? { recordKind } : {}),
      fromVersion: version,
      toVersion: version + 1,
      step
    });
  }
  return { kind: "ok", steps };
}

function axisLabel(axis: MigrationAxis, recordKind: string | undefined): string {
  if (axis === "record") return `record family '${recordKind ?? "?"}'`;
  return axis === "layout" ? "storage layout" : "aggregate schema";
}
