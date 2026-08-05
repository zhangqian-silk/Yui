/**
 * The transactional migration engine.
 *
 * The engine is parameterized over the abstract {@link MigrationTarget} and the
 * `latest` supported {@link StorageVersionState}; it never touches a real Home
 * and holds no domain list of derived-state fields. All domain knowledge lives
 * behind the injected `rebuildDerivedState` / `validateCurrentState` boundary,
 * and every step only *declares* its effects.
 *
 * Flow (execute mode):
 *   inspect -> plan (reject on missing step) -> detectLiveRuntime (fail-closed
 *   if active) -> read immutable source -> apply step transforms into a fresh
 *   output -> rebuildDerivedState(effects) -> validateCurrentState() ->
 *   atomicSwitchWithBackup -> structured MigrationReport.
 *
 * Dry-run mode runs the same pipeline through the validation gate, then discards
 * the fresh output and never switches.
 *
 * Invariants: on any failure the source is never switched and stays byte-for-
 * byte unchanged, and — because input is immutable and output is fresh — an
 * interrupted run is safely retriable (delete partial output and re-run). Once
 * the source already equals `latest`, the run is a no-op (`already-current`).
 */

import { planMigration } from "./planner.js";
import type { MigrationRegistry } from "./registry.js";
import { collectEffects, toStepSummary } from "./report.js";
import type {
  DerivedStateSummary,
  MigrationMode,
  MigrationReport,
  MigrationStage,
  MigrationTarget,
  PlannedStep,
  StepSummary,
  StorageVersionState,
  ValidationSummary
} from "./types.js";

export type RunMigrationOptions<Snapshot> = Readonly<{
  registry: MigrationRegistry<Snapshot>;
  target: MigrationTarget<Snapshot>;
  /** The latest supported version state this release understands. */
  latest: StorageVersionState;
  /** `execute` performs the switch; `dry-run` validates then discards. */
  mode: MigrationMode;
}>;

/** Run the transactional migration and return a structured report. Never throws. */
export function runMigration<Snapshot>(
  options: RunMigrationOptions<Snapshot>
): MigrationReport {
  const { registry, target, latest, mode } = options;

  // 1) inspect — read-only.
  const source = target.inspectVersions();

  // 2) plan — a missing adjacent step or a future version fails closed here.
  const plan = planMigration(registry, source, latest);
  if (plan.kind === "blocked") {
    return { outcome: "blocked", mode, source, target: latest, blocker: plan.blocker };
  }
  if (plan.kind === "no-op") {
    return { outcome: "already-current", mode, source, target: latest };
  }

  const stepSummaries: StepSummary[] = plan.steps.map(toStepSummary);
  const effects = collectEffects(plan.steps);

  // 3) detectLiveRuntime — refuse to migrate a target a live runtime is holding.
  const live = target.detectLiveRuntime();
  if (live.active) {
    return {
      outcome: "active-runtime",
      mode,
      source,
      target: latest,
      steps: stepSummaries,
      ...(live.detail ? { detail: live.detail } : {})
    };
  }

  // 4) apply steps to a fresh output; the source is only ever read.
  let stage: MigrationStage = "precondition";
  const applied: StepSummary[] = [];
  try {
    let snapshot = target.readSource();
    for (const planned of plan.steps) {
      stage = "precondition";
      planned.step.preconditions(snapshot);
      stage = "transform";
      const next = planned.step.transform(snapshot);
      assertFreshOutput(next, snapshot, planned);
      snapshot = next;
      applied.push(toStepSummary(planned));
    }

    stage = "write-fresh-output";
    target.writeFreshOutput(snapshot);

    // 5) injected canonical derived-state rebuild over the fresh output.
    stage = "rebuild";
    const derived: DerivedStateSummary = target.rebuildDerivedState(effects);

    // 6) injected canonical validation gate (the real post-migration loader).
    stage = "validate";
    const validation: ValidationSummary = target.validateCurrentState();

    if (mode === "dry-run") {
      // Validate only; never switch. Discard the staged output.
      target.discardFreshOutput();
      return {
        outcome: "dry-run",
        mode: "dry-run",
        source,
        target: latest,
        steps: stepSummaries,
        effects,
        derived,
        validation
      };
    }

    // 7) atomic switch with timestamped backup — the only write to the source.
    stage = "switch";
    const switched = target.atomicSwitchWithBackup();
    return {
      outcome: "migrated",
      mode: "execute",
      source,
      target: latest,
      steps: stepSummaries,
      effects,
      derived,
      validation,
      switch: switched
    };
  } catch (error) {
    return {
      outcome: "failed",
      mode,
      source,
      target: latest,
      stage,
      stepsApplied: applied,
      error: error instanceof Error ? error.message : String(error)
    };
  }
}

/**
 * Defend the pure `immutable-input -> fresh-output` contract: a transform must
 * return a value distinct from its input (never mutate-and-return the source).
 */
function assertFreshOutput<Snapshot>(
  next: Snapshot,
  previous: Snapshot,
  planned: PlannedStep<Snapshot>
): void {
  if (
    next === previous &&
    typeof next === "object" &&
    next !== null
  ) {
    throw new Error(
      `Migration step ${planned.axis}` +
        `${planned.recordKind ? `/${planned.recordKind}` : ""} ` +
        `${planned.fromVersion}->${planned.toVersion} returned its input object; ` +
        "transforms must produce a fresh output."
    );
  }
}
