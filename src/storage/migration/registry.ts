/**
 * The central migration registry.
 *
 * Declarations and offline transforms are discoverable strictly by
 * `axis + (recordKind) + fromVersion`. There is no version-magnitude or semver
 * guessing: only an explicitly declared chain of adjacent transitions is
 * usable. A fresh registry is EMPTY, so every older version fails closed until
 * its compatible normalization or offline migration is authored explicitly.
 */

import type {
  CompatibleStep,
  MigrationAxis,
  MigrationStep,
  OfflineMigrationDeclaration,
  StorageTransitionDeclaration
} from "./types.js";

export class MigrationRegistryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MigrationRegistryError";
  }
}

/**
 * Explicit key-field delimiter: the ASCII Unit Separator (U+001F), built with
 * `String.fromCharCode` so this source file stays pure printable ASCII (no raw
 * control byte embedded in the text). The Unit Separator never appears in an
 * `axis` literal, a `recordKind`, or a decimal version, so the three key fields
 * cannot run together and the composite key is unambiguous.
 */
const KEY_SEPARATOR = String.fromCharCode(0x1f);

/**
 * Composite lookup key. The record axis includes its `recordKind`; the layout
 * and aggregate axes use a fixed sentinel so a single map serves all axes.
 */
function stepKey(
  axis: MigrationAxis,
  recordKind: string | undefined,
  fromVersion: number
): string {
  const family = axis === "record" ? requireRecordKind(recordKind) : "-";
  return `${axis}${KEY_SEPARATOR}${family}${KEY_SEPARATOR}${fromVersion}`;
}

function requireRecordKind(recordKind: string | undefined): string {
  if (typeof recordKind !== "string" || recordKind.trim().length === 0) {
    throw new MigrationRegistryError(
      "A record-axis migration step must declare a non-empty recordKind."
    );
  }
  return recordKind;
}

/**
 * A discoverable set of adjacent migration steps. Register at most one step per
 * `(axis, recordKind, fromVersion)`; lookup returns only that exact adjacent
 * step (or `undefined`) — it never infers a step from version ordering.
 */
export class MigrationRegistry<Snapshot = unknown> {
  readonly #steps = new Map<string, MigrationStep<Snapshot>>();
  readonly #declarations = new Map<string, StorageTransitionDeclaration<Snapshot>>();

  /** Backward-compatible spelling: explicitly registers one offline transition and its transform. */
  register(step: MigrationStep<Snapshot>): this {
    this.#validateMigrationStep(step);
    const key = stepKey(step.axis, step.recordKind, step.fromVersion);
    this.#assertDeclarationAvailable(step, key);
    this.#assertStepAvailable(step, key);
    // Publish the declaration and transform together only after every check has
    // passed. A rejected combined registration must not leave a newly-runnable
    // half update behind in the registry.
    this.#declarations.set(key, { ...step, kind: "offline-migration" });
    this.#steps.set(key, step);
    return this;
  }

  /** Explicitly register the declaration and transform for an offline change. */
  registerOfflineMigration(step: MigrationStep<Snapshot>): this {
    return this.register(step);
  }

  /** Declare an offline change. A missing transform remains fail-closed. */
  declareOfflineMigration(declaration: OfflineMigrationDeclaration): this {
    this.#validateCoordinates(declaration);
    this.#registerDeclaration({ ...declaration, kind: "offline-migration" });
    return this;
  }

  /** Declare an online-compatible normalization with deterministic defaults. */
  registerCompatible(step: CompatibleStep<Snapshot>): this {
    const runtimeAxis: unknown = step.axis;
    if (runtimeAxis !== "record") {
      throw new MigrationRegistryError(
        "A compatible transition must use the record axis; layout and aggregate changes require offline migration."
      );
    }
    this.#validateCoordinates(step);
    if (!Array.isArray(step.defaults)
      || step.defaults.length === 0
      || step.defaults.some((value) => typeof value !== "string" || value.trim().length === 0)) {
      throw new MigrationRegistryError(
        "A compatible transition must declare at least one deterministic default or rebuild rule."
      );
    }
    if (typeof step.normalize !== "function" || typeof step.validateSource !== "function") {
      throw new MigrationRegistryError(
        "A compatible transition must provide a strict source validator and normalizer."
      );
    }
    this.#registerDeclaration({ ...step, kind: "compatible" });
    return this;
  }

  /** Register a transform without inferring its operational declaration. */
  registerMigrationStep(step: MigrationStep<Snapshot>): this {
    this.#validateMigrationStep(step);
    const key = stepKey(step.axis, step.recordKind, step.fromVersion);
    this.#assertStepAvailable(step, key);
    this.#steps.set(key, step);
    return this;
  }

  #validateMigrationStep(step: MigrationStep<Snapshot>): void {
    this.#validateCoordinates(step);
    if (!Array.isArray(step.declaredEffects)
      || typeof step.transform !== "function"
      || typeof step.preconditions !== "function") {
      throw new MigrationRegistryError("A migration step must provide its transform contract.");
    }
  }

  #assertStepAvailable(
    step: Readonly<{
      axis: MigrationAxis;
      recordKind?: string;
      fromVersion: number;
      toVersion: number;
    }>,
    key: string
  ): void {
    if (!this.#steps.has(key)) return;
    throw new MigrationRegistryError(
      `A migration step is already registered for ${step.axis}` +
        `${step.recordKind ? `/${step.recordKind}` : ""} ${step.fromVersion}->${step.toVersion}.`
    );
  }

  #assertDeclarationAvailable(
    declaration: Readonly<{
      axis: MigrationAxis;
      recordKind?: string;
      fromVersion: number;
      toVersion: number;
    }>,
    key: string
  ): void {
    if (!this.#declarations.has(key)) return;
    throw new MigrationRegistryError(
      `A transition is already registered for ${declaration.axis}` +
        `${declaration.recordKind ? `/${declaration.recordKind}` : ""} ` +
        `${declaration.fromVersion}->${declaration.toVersion}.`
    );
  }

  #validateCoordinates(step: Readonly<{
    axis: MigrationAxis;
    recordKind?: string;
    fromVersion: number;
    toVersion: number;
    introduction?: boolean;
  }>): void {
    if (step.axis === "record") {
      requireRecordKind(step.recordKind);
    } else if (step.recordKind !== undefined) {
      throw new MigrationRegistryError(
        `A ${step.axis}-axis transition must not declare a recordKind.`
      );
    }
    if (!Number.isSafeInteger(step.fromVersion) || step.fromVersion < 0) {
      throw new MigrationRegistryError(
        `Transition fromVersion must be a non-negative integer: ${String(step.fromVersion)}.`
      );
    }
    if (step.fromVersion === 0) {
      if (step.axis !== "record" || step.introduction !== true || step.toVersion !== 1) {
        throw new MigrationRegistryError(
          "Only an explicit record-family introduction may use the 0->1 transition."
        );
      }
    } else if (step.introduction === true) {
      throw new MigrationRegistryError(
        "A record-family introduction must be the explicit 0->1 transition."
      );
    }
    if (step.toVersion !== step.fromVersion + 1) {
      throw new MigrationRegistryError(
        `Transitions must be adjacent and one-directional: ${step.axis}` +
          `${step.recordKind ? `/${step.recordKind}` : ""} ${step.fromVersion}->${step.toVersion} ` +
          `(expected ${step.fromVersion}->${step.fromVersion + 1}).`
      );
    }
  }

  #registerDeclaration(declaration: StorageTransitionDeclaration<Snapshot>): void {
    const key = stepKey(
      declaration.axis,
      declaration.recordKind,
      declaration.fromVersion
    );
    this.#assertDeclarationAvailable(declaration, key);
    this.#declarations.set(key, declaration);
  }

  /** Look up the exact adjacent step advancing `fromVersion -> fromVersion + 1`. */
  lookup(
    axis: MigrationAxis,
    recordKind: string | undefined,
    fromVersion: number
  ): MigrationStep<Snapshot> | undefined {
    return this.#steps.get(stepKey(axis, recordKind, fromVersion));
  }

  /** Look up the exact compatible/offline declaration for one adjacent change. */
  lookupDeclaration(
    axis: MigrationAxis,
    recordKind: string | undefined,
    fromVersion: number
  ): StorageTransitionDeclaration<Snapshot> | undefined {
    return this.#declarations.get(stepKey(axis, recordKind, fromVersion));
  }

  /** Total number of declared adjacent transitions (0 for an EMPTY registry). */
  get size(): number {
    return this.#declarations.size;
  }

  /** True when neither declarations nor offline transforms are registered. */
  isEmpty(): boolean {
    return this.#declarations.size === 0 && this.#steps.size === 0;
  }
}

/**
 * Create a fresh, EMPTY registry for isolated planning or callers that
 * authorize no transitions. Production wiring builds its explicit graph in a
 * separate factory.
 */
export function createEmptyRegistry<
  Snapshot = unknown
>(): MigrationRegistry<Snapshot> {
  return new MigrationRegistry<Snapshot>();
}
