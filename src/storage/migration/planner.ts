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

  // 3) record families — nested inside the aggregate; visit target kinds in
  // sorted order so the plan is deterministic. A target-only family starts at
  // the explicit pre-introduction version 0 and therefore requires a registered
  // `introduction` step. It is not an aggregate transform or an implicit
  // no-op: the record family must pass the same fail-closed delivery gate as
  // every later version transition.
  const targetKinds = Object.keys(target.record).sort();
  for (const recordKind of targetKinds) {
    const sourceEntry = source.record[recordKind];
    const chain = planRecordFamily(
      registry,
      recordKind,
      sourceEntry?.version ?? 0,
      target.record[recordKind].version
    );
    if (chain.kind === "blocked") return { kind: "blocked", blocker: chain.blocker };
    ordered.push(...chain.steps);
  }

  return ordered.length === 0
    ? { kind: "no-op" }
    : {
        kind: "runnable",
        path: ordered.some(({ transition }) => transition === "offline-migration")
          ? "offline-migration"
          : "compatible",
        steps: ordered
      };
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
    const declaration = registry.lookupDeclaration(axis, recordKind, version);
    const registeredStep = registry.lookup(axis, recordKind, version);
    if (declaration === undefined && registeredStep !== undefined) {
      return {
        kind: "blocked",
        blocker: {
          reason: "missing-declaration",
          axis,
          ...(recordKind ? { recordKind } : {}),
          from: version,
          to: version + 1,
          message:
            `No compatible/offline-migration declaration is registered for ` +
            `${label} ${version}->${version + 1}.`,
          action:
            "Declare the adjacent change explicitly; do not infer compatibility from its version."
        }
      };
    }
    if (declaration === undefined) {
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
    const step = declaration.kind === "compatible"
      ? {
          axis,
          ...(recordKind ? { recordKind } : {}),
          fromVersion: version,
          toVersion: version + 1,
          preconditions: declaration.validateSource,
          transform: declaration.normalize,
          declaredEffects: []
        }
      : registeredStep;
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
            "This offline transition cannot run until this release provides its migration step."
        }
      };
    }
    steps.push({
      axis,
      ...(recordKind ? { recordKind } : {}),
      fromVersion: version,
      toVersion: version + 1,
      transition: declaration.kind,
      step
    });
  }
  return { kind: "ok", steps };
}

function axisLabel(axis: MigrationAxis, recordKind: string | undefined): string {
  if (axis === "record") return `record family '${recordKind ?? "?"}'`;
  return axis === "layout" ? "storage layout" : "aggregate schema";
}
