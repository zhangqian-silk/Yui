/**
 * The central migration registry.
 *
 * Steps are discoverable strictly by `axis + (recordKind) + fromVersion`. There
 * is no version-magnitude or semver guessing: only an explicitly registered
 * chain of adjacent steps counts as migratable. A fresh registry is EMPTY — it
 * carries no real historical steps, so any strictly-older real version is
 * fail-closed until an explicit step is registered.
 */

import type { MigrationAxis, MigrationStep } from "./types.js";

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

  /** Register one adjacent, one-directional step. Rejects non-adjacent, wrong-axis, or duplicate steps. */
  register(step: MigrationStep<Snapshot>): this {
    if (step.axis === "record") {
      requireRecordKind(step.recordKind);
    } else if (step.recordKind !== undefined) {
      throw new MigrationRegistryError(
        `A ${step.axis}-axis migration step must not declare a recordKind.`
      );
    }
    if (!Number.isSafeInteger(step.fromVersion) || step.fromVersion < 1) {
      throw new MigrationRegistryError(
        `Migration step fromVersion must be a positive integer: ${String(step.fromVersion)}.`
      );
    }
    if (step.toVersion !== step.fromVersion + 1) {
      throw new MigrationRegistryError(
        `Migration steps must be adjacent and one-directional: ${step.axis}` +
          `${step.recordKind ? `/${step.recordKind}` : ""} ${step.fromVersion}->${step.toVersion} ` +
          `(expected ${step.fromVersion}->${step.fromVersion + 1}).`
      );
    }
    const key = stepKey(step.axis, step.recordKind, step.fromVersion);
    if (this.#steps.has(key)) {
      throw new MigrationRegistryError(
        `A migration step is already registered for ${step.axis}` +
          `${step.recordKind ? `/${step.recordKind}` : ""} ${step.fromVersion}->${step.toVersion}.`
      );
    }
    this.#steps.set(key, step);
    return this;
  }

  /** Look up the exact adjacent step advancing `fromVersion -> fromVersion + 1`. */
  lookup(
    axis: MigrationAxis,
    recordKind: string | undefined,
    fromVersion: number
  ): MigrationStep<Snapshot> | undefined {
    return this.#steps.get(stepKey(axis, recordKind, fromVersion));
  }

  /** Total number of registered steps (0 for an EMPTY registry). */
  get size(): number {
    return this.#steps.size;
  }

  /** True when no steps have been registered. */
  isEmpty(): boolean {
    return this.#steps.size === 0;
  }
}

/**
 * Create a fresh, EMPTY registry. This ships with no real historical steps: the
 * production wiring keeps it empty on purpose so every strictly-older real
 * version is fail-closed (NEEDS_NEW_VERSION) until a step is explicitly added.
 */
export function createEmptyRegistry<
  Snapshot = unknown
>(): MigrationRegistry<Snapshot> {
  return new MigrationRegistry<Snapshot>();
}
