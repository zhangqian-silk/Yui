import { types as utilTypes } from "node:util";

export type InertJsonValue = null | boolean | number | string | InertJsonValue[] | {
  [key: string]: InertJsonValue;
};

export type InertJsonSnapshot = { value: InertJsonValue };

export type InertJsonLimits = Readonly<{
  maxDepth: number;
  maxNodes: number;
  maxStringBytes: number;
  maxArrayLength: number;
}>;

type CloneBudget = {
  limits: InertJsonLimits;
  nodes: number;
  stringBytes: number;
};

export const DEFAULT_EXACT_INERT_JSON_LIMITS: InertJsonLimits = Object.freeze({
  maxDepth: 128,
  maxNodes: 100_000,
  maxStringBytes: 16 * 1024 * 1024,
  maxArrayLength: 100_000
});

const INVALID = Symbol("invalid-inert-json");
const OMIT = Symbol("omit-undefined-property");
const SAFE_ARRAY_PROTOTYPE = createSafeArrayPrototype();
const WELL_FORMED_UTF16 = /^(?:[\u0000-\ud7ff\ue000-\uffff]|[\ud800-\udbff][\udc00-\udfff])*$/;

export function createInertJsonSnapshot(value: unknown): InertJsonSnapshot | null {
  try {
    const snapshot = cloneOwnJsonValue(value, new Set<object>(), false, true, 0);
    return snapshot === INVALID || snapshot === OMIT ? null : { value: snapshot };
  } catch {
    return null;
  }
}

export function createExactInertJsonSnapshot(
  value: unknown,
  limits: InertJsonLimits = DEFAULT_EXACT_INERT_JSON_LIMITS
): InertJsonSnapshot | null {
  try {
    if (!isValidLimits(limits)) return null;
    const budget: CloneBudget = { limits, nodes: 0, stringBytes: 0 };
    const snapshot = cloneOwnJsonValue(value, new Set<object>(), false, false, 0, budget);
    return snapshot === INVALID || snapshot === OMIT ? null : { value: snapshot };
  } catch {
    return null;
  }
}

export function isInertJsonValue(value: unknown): boolean {
  return createInertJsonSnapshot(value) !== null;
}

export function stringifyInertJson(value: unknown, space?: number): string | null {
  const snapshot = createInertJsonSnapshot(value);
  return snapshot === null ? null : stringifyInertJsonSnapshot(snapshot.value, space);
}

export function stringifyInertJsonSnapshot(value: InertJsonValue, space?: number): string {
  return JSON.stringify(value, null, space);
}

export function hasExactOwnKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[] = []
): boolean {
  const keys = Reflect.ownKeys(value);
  for (let index = 0; index < keys.length; index += 1) {
    const key = keys[index];
    if (typeof key !== "string" || (!containsString(required, key) && !containsString(optional, key))) {
      return false;
    }
  }
  for (let index = 0; index < required.length; index += 1) {
    if (!Object.hasOwn(value, required[index])) return false;
  }
  return true;
}

function cloneOwnJsonValue(
  value: unknown,
  ancestors: Set<object>,
  omitUndefined: boolean,
  allowUndefinedPropertyOmission: boolean,
  depth: number,
  budget?: CloneBudget
): InertJsonValue | typeof INVALID | typeof OMIT {
  if (!consumeValueBudget(value, depth, budget)) return INVALID;
  if (value === undefined) return omitUndefined && allowUndefinedPropertyOmission ? OMIT : INVALID;
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    return Number.isFinite(value) && !Object.is(value, -0) ? value : INVALID;
  }
  if (typeof value !== "object" || utilTypes.isProxy(value) || ancestors.has(value)) return INVALID;

  ancestors.add(value);
  try {
    return Array.isArray(value)
      ? cloneOwnJsonArray(value, ancestors, allowUndefinedPropertyOmission, depth, budget)
      : cloneOwnJsonObject(value, ancestors, allowUndefinedPropertyOmission, depth, budget);
  } finally {
    ancestors.delete(value);
  }
}

function cloneOwnJsonArray(
  value: unknown[],
  ancestors: Set<object>,
  allowUndefinedPropertyOmission: boolean,
  depth: number,
  budget?: CloneBudget
): InertJsonValue[] | typeof INVALID {
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Array.prototype && prototype !== SAFE_ARRAY_PROTOTYPE && prototype !== null) return INVALID;
  const keys = Reflect.ownKeys(value);
  const lengthDescriptor = Object.getOwnPropertyDescriptor(value, "length");
  if (
    lengthDescriptor === undefined || !("value" in lengthDescriptor) ||
    typeof lengthDescriptor.value !== "number" ||
    containsNonString(keys) ||
    keys.length !== lengthDescriptor.value + 1 ||
    !containsOnlyArrayKeys(keys)
  ) {
    return INVALID;
  }
  if (budget !== undefined && lengthDescriptor.value > budget.limits.maxArrayLength) return INVALID;

  const snapshot: InertJsonValue[] = [];
  Object.setPrototypeOf(snapshot, SAFE_ARRAY_PROTOTYPE);
  for (let index = 0; index < lengthDescriptor.value; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (descriptor === undefined || !("value" in descriptor) || descriptor.enumerable !== true) {
      return INVALID;
    }
    const item = cloneOwnJsonValue(
      descriptor.value,
      ancestors,
      false,
      allowUndefinedPropertyOmission,
      depth + 1,
      budget
    );
    if (item === INVALID || item === OMIT) return INVALID;
    Object.defineProperty(snapshot, String(index), {
      configurable: true,
      enumerable: true,
      value: item,
      writable: true
    });
  }
  return snapshot;
}

function createSafeArrayPrototype(): object {
  const prototype = Object.create(null) as Record<PropertyKey, unknown>;
  const keys = Reflect.ownKeys(Array.prototype);
  for (let index = 0; index < keys.length; index += 1) {
    const key = keys[index];
    if (key === "toJSON") continue;
    const descriptor = Object.getOwnPropertyDescriptor(Array.prototype, key);
    if (descriptor !== undefined && "value" in descriptor) {
      Object.defineProperty(prototype, key, descriptor);
    }
  }
  return Object.freeze(prototype);
}

function cloneOwnJsonObject(
  value: object,
  ancestors: Set<object>,
  allowUndefinedPropertyOmission: boolean,
  depth: number,
  budget?: CloneBudget
): { [key: string]: InertJsonValue } | typeof INVALID {
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return INVALID;
  const snapshot = Object.create(null) as { [key: string]: InertJsonValue };
  const keys = Reflect.ownKeys(value);
  for (let index = 0; index < keys.length; index += 1) {
    const key = keys[index];
    if (typeof key !== "string") return INVALID;
    if (!consumeStringBytes(key, budget)) return INVALID;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !("value" in descriptor) || descriptor.enumerable !== true) {
      return INVALID;
    }
    const item = cloneOwnJsonValue(
      descriptor.value,
      ancestors,
      true,
      allowUndefinedPropertyOmission,
      depth + 1,
      budget
    );
    if (item === INVALID) return INVALID;
    if (item === OMIT) continue;
    Object.defineProperty(snapshot, key, {
      configurable: true,
      enumerable: true,
      value: item,
      writable: true
    });
  }
  return snapshot;
}

function consumeValueBudget(value: unknown, depth: number, budget?: CloneBudget): boolean {
  if (budget === undefined) return true;
  budget.nodes += 1;
  if (budget.nodes > budget.limits.maxNodes || depth > budget.limits.maxDepth) return false;
  return typeof value !== "string" || consumeStringBytes(value, budget);
}

function consumeStringBytes(value: string, budget?: CloneBudget): boolean {
  if (budget === undefined) return true;
  if (!WELL_FORMED_UTF16.test(value)) return false;
  budget.stringBytes += Buffer.byteLength(value, "utf8");
  return budget.stringBytes <= budget.limits.maxStringBytes;
}

function isValidLimits(value: InertJsonLimits): boolean {
  return [value.maxDepth, value.maxNodes, value.maxStringBytes, value.maxArrayLength].every((limit) =>
    Number.isSafeInteger(limit) && limit >= 0);
}

function containsString(values: readonly string[], target: string): boolean {
  for (let index = 0; index < values.length; index += 1) {
    if (values[index] === target) return true;
  }
  return false;
}

function containsNonString(values: readonly PropertyKey[]): boolean {
  for (let index = 0; index < values.length; index += 1) {
    if (typeof values[index] !== "string") return true;
  }
  return false;
}

function containsOnlyArrayKeys(values: readonly PropertyKey[]): boolean {
  for (let index = 0; index < values.length; index += 1) {
    const key = values[index];
    if (typeof key !== "string" || (key !== "length" && !/^(0|[1-9][0-9]*)$/.test(key))) {
      return false;
    }
  }
  return true;
}
