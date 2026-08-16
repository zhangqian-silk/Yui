export function requireIdentity(value: string, label: string): string {
  const normalized = requireText(value, label);
  if (
    [".", "..", "__proto__", "prototype", "constructor"].includes(normalized)
    || /[\/\\\0]/u.test(normalized)
  ) {
    throw new Error(`${label} is invalid.`);
  }
  return normalized;
}

export function requireText(value: string, label: string): string {
  if (typeof value !== "string" || value.includes("\0")) {
    throw new Error(`${label} is invalid.`);
  }
  const normalized = value.trim();
  if (normalized.length === 0) throw new Error(`${label} is required.`);
  return normalized;
}

export function optionalText(value: string | undefined, label: string): string | undefined {
  return value === undefined ? undefined : requireText(value, label);
}

export function requireTimestamp(value: string, label: string): string {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) {
    throw new Error(`${label} must be an ISO timestamp.`);
  }
  return value;
}

export function requirePositiveInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${label} must be a positive integer.`);
  }
  return value;
}

export function normalizedUniqueText(
  values: readonly string[],
  label: string
): readonly string[] {
  if (!Array.isArray(values)) throw new Error(`${label} must be an array.`);
  const normalized = values.map((value) => requireText(value, label));
  if (new Set(normalized).size !== normalized.length) {
    throw new Error(`${label} must be unique.`);
  }
  return Object.freeze(normalized);
}

export function normalizedUniqueIdentities(
  values: readonly string[],
  label: string
): readonly string[] {
  if (!Array.isArray(values)) throw new Error(`${label} must be an array.`);
  const normalized = values.map((value) => requireIdentity(value, label));
  if (new Set(normalized).size !== normalized.length) {
    throw new Error(`${label} must be unique.`);
  }
  return Object.freeze(normalized);
}

export function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

/**
 * True for a concrete, pinnable package version — a semver-shaped `X.Y.Z` with
 * an optional pre-release/build suffix. Rejects dist-tag sentinels (`latest`,
 * `next`, …), empty/whitespace, and anything not anchored to a numeric
 * `major.minor.patch` so a moving tag can never be frozen into a release plan.
 */
export function isConcreteVersion(value: string): boolean {
  return /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(value.trim());
}
