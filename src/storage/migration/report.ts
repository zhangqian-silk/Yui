/**
 * Pure helpers for building and describing {@link MigrationReport}s.
 *
 * These never perform I/O and never interpret domain data — they only shape the
 * structured evidence the engine emits.
 */

import type {
  MigrationReport,
  PlannedStep,
  StepSummary
} from "./types.js";

/** Reduce a planned step to the concise summary carried in reports. */
export function toStepSummary<Snapshot>(
  planned: PlannedStep<Snapshot>
): StepSummary {
  return {
    axis: planned.axis,
    ...(planned.recordKind ? { recordKind: planned.recordKind } : {}),
    fromVersion: planned.fromVersion,
    toVersion: planned.toVersion,
    declaredEffects: planned.step.declaredEffects
  };
}

/**
 * The de-duplicated union of every planned step's declared effects, in
 * first-seen deterministic order. This is exactly what the engine forwards to
 * the injected `rebuildDerivedState` — the generic core keeps no domain list.
 */
export function collectEffects<Snapshot>(
  steps: readonly PlannedStep<Snapshot>[]
): readonly string[] {
  const seen = new Set<string>();
  const effects: string[] = [];
  for (const planned of steps) {
    for (const effect of planned.step.declaredEffects) {
      if (!seen.has(effect)) {
        seen.add(effect);
        effects.push(effect);
      }
    }
  }
  return effects;
}

/** A short, human-readable one-line description of a report outcome. */
export function describeReport(report: MigrationReport): string {
  switch (report.outcome) {
    case "already-current":
      return "Storage is already at the current version; nothing to migrate.";
    case "blocked":
      return `Migration blocked (${report.blocker.reason}): ${report.blocker.message} ${report.blocker.action}`;
    case "active-runtime":
      return `Migration refused: a live runtime is active${report.detail ? ` (${report.detail})` : ""}.`;
    case "dry-run":
      return `Dry run validated ${report.steps.length} step(s); fresh output discarded, source unchanged.`;
    case "migrated":
      return `Migrated through ${report.steps.length} step(s); source backed up at ${report.switch.backupPath ?? "(unspecified)"}.`;
    case "failed":
      return `Migration failed at ${report.stage}: ${report.error} Source is unchanged; delete any partial output and retry.`;
  }
}
