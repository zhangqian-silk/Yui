/**
 * Generic, pure migration-core vocabulary.
 *
 * This module is deliberately domain-agnostic: it knows about three independent
 * monotonic version axes and how to chain adjacent steps, but it never encodes a
 * list of concrete Yui records, derived-state fields, or reference invariants.
 * Those live behind the injected {@link MigrationTarget} boundary so a new record
 * family can be added without editing the generic engine.
 */

/**
 * The three top-level responsibility axes.
 *
 * - `layout`    — on-disk storage layout (`schema.json`, root `state.json`, locks).
 * - `aggregate` — the authoritative aggregate document schema.
 * - `record`    — a *family* of records; the record axis is a
 *   `recordKind -> { version, path }` map, never a single global scalar.
 */
export type MigrationAxis = "layout" | "aggregate" | "record";

/** Explicit operational class for one adjacent schema change. */
export type StorageTransitionKind = "compatible" | "offline-migration";

/** Per record-family version + where that family's data lives. */
export type RecordAxisEntry = Readonly<{
  version: number;
  path: string;
}>;

/**
 * The version state of a storage target across all three axes. `layout` and
 * `aggregate` are scalars; `record` is a `recordKind -> {version, path}` map so
 * every record family versions independently.
 */
export type StorageVersionState = Readonly<{
  layout: number;
  aggregate: number;
  record: Readonly<Record<string, RecordAxisEntry>>;
}>;

/**
 * A single adjacent, one-directional migration step on one axis.
 *
 * `transform` is a pure, deterministic `immutable-input -> fresh-output`
 * function: it must not mutate its argument and must return a fresh value.
 * `preconditions` is a pure check that the source is valid in its `fromVersion`.
 * `declaredEffects` names the derived/reference-state kinds this step affects;
 * the engine forwards the union of declared effects to the injected
 * `rebuildDerivedState`/`validateCurrentState` boundary and never interprets
 * them itself.
 */
export type MigrationStep<Snapshot = unknown> = Readonly<{
  axis: MigrationAxis;
  /** Required iff `axis === "record"`; identifies the record family. */
  recordKind?: string;
  fromVersion: number;
  /** Must equal `fromVersion + 1`: steps are strictly adjacent and one-way. */
  toVersion: number;
  /**
   * Marks the one explicit boundary that introduces a record family after the
   * persisted baseline. Introduction is the only legal `0 -> 1` transition;
   * ordinary record migrations remain positive-version adjacent steps.
   */
  introduction?: boolean;
  preconditions: (input: Snapshot) => void;
  transform: (input: Snapshot) => Snapshot;
  declaredEffects: readonly string[];
}>;

/**
 * One explicitly-compatible adjacent change. The normalizer is the online
 * loader step: it must use only the declared deterministic defaults and return
 * a fresh current-model snapshot. Layout changes are never compatible.
 */
export type CompatibleStep<Snapshot = unknown> = Readonly<{
  kind?: "compatible";
  axis: "record";
  recordKind?: string;
  fromVersion: number;
  toVersion: number;
  /** Explicitly marks the only legal pre-family transition: record 0->1. */
  introduction?: boolean;
  /** Human-readable defaults/rebuild rules which make the load unambiguous. */
  defaults: readonly string[];
  /** Strict parser for the declared old shape; unknown fields must be rejected. */
  validateSource: (input: Snapshot) => void;
  normalize: (input: Snapshot) => Snapshot;
}>;

/** A declaration which requires a separately-registered offline transform. */
export type OfflineMigrationDeclaration = Readonly<{
  kind?: "offline-migration";
  axis: MigrationAxis;
  recordKind?: string;
  fromVersion: number;
  toVersion: number;
  /** Explicitly marks the only legal pre-family transition: record 0->1. */
  introduction?: boolean;
}>;

export type StorageTransitionDeclaration<Snapshot = unknown> = Readonly<
  | (CompatibleStep<Snapshot> & { kind: "compatible" })
  | (OfflineMigrationDeclaration & { kind: "offline-migration" })
>;

/** A resolved step the planner scheduled, in deterministic execution order. */
export type PlannedStep<Snapshot = unknown> = Readonly<{
  axis: MigrationAxis;
  recordKind?: string;
  fromVersion: number;
  toVersion: number;
  transition: StorageTransitionKind;
  step: MigrationStep<Snapshot>;
}>;

/**
 * Why a target cannot be migrated. Carries a precise, actionable reason so
 * callers (doctor/inspect, the engine) can surface an exact next action.
 */
export type MigrationBlocker = Readonly<
  | {
      reason: "future-version";
      axis: MigrationAxis;
      recordKind?: string;
      found: number;
      supported: number;
      message: string;
      action: string;
    }
  | {
      reason: "missing-declaration";
      axis: MigrationAxis;
      recordKind?: string;
      from: number;
      to: number;
      message: string;
      action: string;
    }
  | {
      reason: "missing-step";
      axis: MigrationAxis;
      recordKind?: string;
      from: number;
      to: number;
      message: string;
      action: string;
    }
>;

/**
 * The deterministic outcome of planning a migration.
 * - `no-op`    — every axis is already current.
 * - `runnable` — a complete, ordered, adjacent step chain exists for every axis.
 * - `blocked`  — a future version or a broken/missing step chain; fail-closed.
 */
export type MigrationPlan<Snapshot = unknown> = Readonly<
  | { kind: "no-op" }
  | {
      kind: "runnable";
      /** All-compatible is online; any offline transition selects migration. */
      path: "compatible" | "offline-migration";
      steps: readonly PlannedStep<Snapshot>[];
    }
  | { kind: "blocked"; blocker: MigrationBlocker }
>;

/** A single record family's before/after presence in a target-provided summary. */
export type DerivedStateSummary = Readonly<{
  /** Effect kinds the injected rebuild actually rebuilt (echoed for the report). */
  rebuiltEffects: readonly string[];
  /**
   * Free-form, target-provided detail (e.g. record counts, decision values).
   * The generic engine never reads or interprets this.
   */
  details?: Readonly<Record<string, unknown>>;
}>;

/** One validation check the injected loader gate ran. */
export type ValidationCheck = Readonly<{
  name: string;
  outcome: "passed";
  detail?: string;
}>;

/** Summary of the injected `validateCurrentState` gate (post-migration loader). */
export type ValidationSummary = Readonly<{
  checks: readonly ValidationCheck[];
}>;

/** Whether a live runtime is holding the target (quiesce pre-check). */
export type LiveRuntimeStatus = Readonly<{
  active: boolean;
  detail?: string;
}>;

/**
 * Result of the atomic switch, including the timestamped backup location.
 *
 * A switch is implemented as two atomic renames with one non-atomic window
 * between them (move original aside, then promote the staged output). `status`
 * makes that window observable to callers instead of collapsing it into a bare
 * success:
 *  - `switched`  — the staged output was fully promoted into the Home path.
 *  - `ambiguous` — the original was moved to the backup but promotion did not
 *    complete AND the rollback also failed; the Home is partially switched and
 *    must be recovered from the backup. NEVER report this as "unchanged".
 * When a target implements the switch as a single atomic operation it always
 * returns `switched`; the field defaults to `switched` for back-compatibility.
 */
export type SwitchOutcome = Readonly<{
  status?: "switched" | "ambiguous";
  backupPath?: string;
  detail?: string;
}>;

/**
 * Thrown by a target's `atomicSwitchWithBackup` when the switch is left in a
 * partially-applied, ambiguous state (the original was moved aside but the
 * promotion and its rollback both failed). It carries the exact recovery path so
 * the orchestrator can report a truthful, actionable manual recovery rather than
 * a false "the Home is unchanged".
 */
export class AmbiguousSwitchError extends Error {
  /** The logical Home path that is now partially switched. */
  readonly homePath: string;
  /** Where the original Home currently lives (the recovery source). */
  readonly backupPath: string;
  /** The staged output that was not promoted. */
  readonly stagingPath: string;
  constructor(options: Readonly<{
    homePath: string;
    backupPath: string;
    stagingPath: string;
    detail: string;
  }>) {
    super(options.detail);
    this.name = "AmbiguousSwitchError";
    this.homePath = options.homePath;
    this.backupPath = options.backupPath;
    this.stagingPath = options.stagingPath;
  }
}

/**
 * The abstract migration target the transactional engine is parameterized over.
 *
 * The generic core never touches a real Home: `MigrationTarget` is the single
 * seam. `readSource` is read-only and returns an immutable snapshot; every write
 * lands in a fresh output that `writeFreshOutput` refuses to overwrite; the
 * injected `rebuildDerivedState`/`validateCurrentState` own all domain knowledge;
 * `atomicSwitchWithBackup` promotes the fresh output and backs up the original.
 */
export interface MigrationTarget<Snapshot> {
  /** Read-only: the current on-disk versions across all three axes. */
  inspectVersions(): StorageVersionState;
  /** Quiesce pre-check: is a live runtime holding this target? */
  detectLiveRuntime(): LiveRuntimeStatus;
  /** Read-only: an immutable snapshot of the source (never written). */
  readSource(): Snapshot;
  /** Stage the migrated snapshot to a fresh output; MUST refuse to overwrite. */
  writeFreshOutput(snapshot: Snapshot): void;
  /**
   * Injected canonical derived-state rebuild over the staged fresh output.
   * Receives the union of the plan's `declaredEffects`; the engine holds no
   * domain list of its own.
   */
  rebuildDerivedState(effects: readonly string[]): DerivedStateSummary;
  /**
   * Injected canonical validation gate (the real post-migration loader / graph
   * check) over the staged fresh output. Throws on any failure.
   */
  validateCurrentState(): ValidationSummary;
  /** Atomically promote the fresh output, backing up the original with a stamp. */
  atomicSwitchWithBackup(): SwitchOutcome;
  /** Best-effort removal of a fresh output this run staged (dry-run / retry). */
  discardFreshOutput(): void;
}

/** The stage at which a migration failed (for a precise recovery action). */
export type MigrationStage =
  | "precondition"
  | "transform"
  | "write-fresh-output"
  | "rebuild"
  | "validate"
  | "switch";

/** A concise description of a scheduled step, for reports. */
export type StepSummary = Readonly<{
  axis: MigrationAxis;
  recordKind?: string;
  fromVersion: number;
  toVersion: number;
  transition: StorageTransitionKind;
  declaredEffects: readonly string[];
}>;

/**
 * The structured outcome of an engine run. Every variant carries the inspected
 * source and target version states so callers can render an exact picture.
 */
export type MigrationReport = Readonly<
  | {
      outcome: "already-current";
      mode: MigrationMode;
      source: StorageVersionState;
      target: StorageVersionState;
    }
  | {
      outcome: "blocked";
      mode: MigrationMode;
      source: StorageVersionState;
      target: StorageVersionState;
      blocker: MigrationBlocker;
    }
  | {
      outcome: "active-runtime";
      mode: MigrationMode;
      source: StorageVersionState;
      target: StorageVersionState;
      steps: readonly StepSummary[];
      detail?: string;
    }
  | {
      outcome: "dry-run";
      mode: "dry-run";
      source: StorageVersionState;
      target: StorageVersionState;
      steps: readonly StepSummary[];
      effects: readonly string[];
      derived: DerivedStateSummary;
      validation: ValidationSummary;
    }
  | {
      outcome: "migrated";
      mode: "execute";
      source: StorageVersionState;
      target: StorageVersionState;
      steps: readonly StepSummary[];
      effects: readonly string[];
      derived: DerivedStateSummary;
      validation: ValidationSummary;
      switch: SwitchOutcome;
      completedAt?: string;
    }
  | {
      outcome: "failed";
      mode: MigrationMode;
      source: StorageVersionState;
      target: StorageVersionState;
      stage: MigrationStage;
      stepsApplied: readonly StepSummary[];
      error: string;
    }
  /**
   * The atomic switch was left partially applied: the original was moved to the
   * backup but the promotion and its rollback both failed. This is NOT a clean
   * "source unchanged" failure — the caller must recover from the backup. Carries
   * the exact paths for a manual `mv` recovery (P1-4).
   */
  | {
      outcome: "switch-ambiguous";
      mode: MigrationMode;
      source: StorageVersionState;
      target: StorageVersionState;
      steps: readonly StepSummary[];
      /** The logical Home path that is now partially switched. */
      homePath: string;
      /** Where the original Home currently lives (the recovery source). */
      backupPath: string;
      /** The staged output that was not promoted. */
      stagingPath: string;
      error: string;
    }
>;

/** Execute performs the switch; dry-run runs the gate then discards output. */
export type MigrationMode = "execute" | "dry-run";
