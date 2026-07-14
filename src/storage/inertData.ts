import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { TextDecoder, TextEncoder, types as utilTypes } from "node:util";

const LIMIT_BRAND: unique symbol = Symbol("TaskMuxInertDataLimits");
const CONTAINER_BRAND: unique symbol = Symbol("TaskMuxInertDataContainer");
const SNAPSHOT_BRAND: unique symbol = Symbol("TaskMuxInertDataSnapshot");

export interface InertDataLimits {
  readonly maxDepth: number;
  readonly maxNodes: number;
  readonly maxArrayLength: number;
  readonly maxObjectKeys: number;
  readonly maxStringBytes: number;
  readonly maxTotalEncodedBytes: number;
  readonly [LIMIT_BRAND]: true;
}

export type InertDataValue = null | boolean | number | string | InertDataArray | InertDataObject;

export interface InertDataArray extends ReadonlyArray<InertDataValue> {
  readonly [CONTAINER_BRAND]: "array";
}

export interface InertDataObject {
  readonly [key: string]: InertDataValue;
  readonly [CONTAINER_BRAND]: "object";
}

export type InertDataEntry = readonly [string, InertDataValue];

export interface InertDataSnapshot {
  readonly value: InertDataValue;
  readonly encodedByteLength: number;
  readonly [SNAPSHOT_BRAND]: true;
}

const MAX_DEPTH = 64;
const MAX_NODES = 100_000;
const MAX_ARRAY_LENGTH = 10_000;
const MAX_OBJECT_KEYS = 10_000;
const MAX_STRING_BYTES = 1_048_576;
const MAX_TOTAL_ENCODED_BYTES = 8_388_608;
const MAX_CANONICAL_NUMBER_CODE_UNITS = 32;
const STRING_CHUNK_CODE_UNITS = 16_384;

const PARSE_FAILURE = Symbol("invalid-canonical-inert-data");
const HEX = "0123456789abcdef";

const SafeSet = Set;
const SafeWeakMap = WeakMap;
const SafeWeakSet = WeakSet;
const safeCreateHash = createHash;
const arrayIsArray = Array.isArray;
const arrayJoin = Function.call.bind(Array.prototype.join) as (target: readonly string[], separator: string) => string;
const arrayPush = Function.call.bind(Array.prototype.push) as <T>(target: T[], ...values: T[]) => number;
const arraySort = Function.call.bind(Array.prototype.sort) as <T>(
  target: T[],
  compare: (left: T, right: T) => number
) => T[];
const jsonParse = JSON.parse;
const bufferFromArrayBuffer = Buffer.from.bind(Buffer) as (
  value: ArrayBuffer,
  byteOffset: number,
  length: number
) => Buffer;
const bufferFromView = Buffer.from.bind(Buffer) as (value: Uint8Array) => Buffer;
const numberFrom = Number;
const numberIsFinite = Number.isFinite;
const numberIsSafeInteger = Number.isSafeInteger;
const numberToString = Function.call.bind(Number.prototype.toString) as (target: number) => string;
const objectCreate = Object.create;
const objectDefineProperty = Object.defineProperty;
const objectFreeze = Object.freeze;
const objectGetOwnPropertyDescriptor = Object.getOwnPropertyDescriptor;
const objectGetPrototypeOf = Object.getPrototypeOf;
const objectHasOwn = Object.hasOwn;
const objectIs = Object.is;
const objectSetPrototypeOf = Object.setPrototypeOf;
const reflectOwnKeys = Reflect.ownKeys;
const setAdd = Function.call.bind(Set.prototype.add) as <T>(target: Set<T>, value: T) => Set<T>;
const setHas = Function.call.bind(Set.prototype.has) as <T>(target: Set<T>, value: T) => boolean;
const stringCharCodeAt = Function.call.bind(String.prototype.charCodeAt) as (target: string, index: number) => number;
const stringSlice = Function.call.bind(String.prototype.slice) as (
  target: string,
  start?: number,
  end?: number
) => string;
const textDecoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
const textEncoder = new TextEncoder();
const textDecoderDecode = Function.call.bind(TextDecoder.prototype.decode) as (
  target: TextDecoder,
  input?: AllowSharedBufferSource
) => string;
const textEncoderEncode = Function.call.bind(TextEncoder.prototype.encode) as (
  target: TextEncoder,
  input?: string
) => Uint8Array;
const utilIsProxy = utilTypes.isProxy;
const utilIsSharedArrayBuffer = utilTypes.isSharedArrayBuffer;
const utilIsUint8Array = utilTypes.isUint8Array;
const weakMapGet = Function.call.bind(WeakMap.prototype.get) as <K extends object, V>(
  target: WeakMap<K, V>,
  key: K
) => V | undefined;
const weakMapSet = Function.call.bind(WeakMap.prototype.set) as <K extends object, V>(
  target: WeakMap<K, V>,
  key: K,
  value: V
) => WeakMap<K, V>;
const weakSetAdd = Function.call.bind(WeakSet.prototype.add) as <T extends object>(
  target: WeakSet<T>,
  value: T
) => WeakSet<T>;
const weakSetHas = Function.call.bind(WeakSet.prototype.has) as <T extends object>(
  target: WeakSet<T>,
  value: T
) => boolean;
const hashPrototype = objectGetPrototypeOf(safeCreateHash("sha256")) as object;
const hashUpdateMethod = objectGetOwnPropertyDescriptor(hashPrototype, "update")?.value;
const hashDigestMethod = objectGetOwnPropertyDescriptor(hashPrototype, "digest")?.value;
if (typeof hashUpdateMethod !== "function" || typeof hashDigestMethod !== "function") {
  throw new Error("Hash intrinsics are unavailable.");
}
const hashUpdate = Function.call.bind(hashUpdateMethod) as (
  target: ReturnType<typeof safeCreateHash>,
  input: Uint8Array
) => ReturnType<typeof safeCreateHash>;
const hashDigest = Function.call.bind(hashDigestMethod) as (
  target: ReturnType<typeof safeCreateHash>,
  encoding: "hex"
) => string;
const typedArrayPrototype = objectGetPrototypeOf(Uint8Array.prototype) as object;
const typedArrayBufferGetter = objectGetOwnPropertyDescriptor(typedArrayPrototype, "buffer")?.get;
const typedArrayByteLengthGetter = objectGetOwnPropertyDescriptor(typedArrayPrototype, "byteLength")?.get;
const typedArrayByteOffsetGetter = objectGetOwnPropertyDescriptor(typedArrayPrototype, "byteOffset")?.get;
if (typedArrayBufferGetter === undefined || typedArrayByteLengthGetter === undefined ||
    typedArrayByteOffsetGetter === undefined) throw new Error("TypedArray intrinsics are unavailable.");
const typedArrayBuffer = Function.call.bind(typedArrayBufferGetter) as (target: Uint8Array) => ArrayBufferLike;
const typedArrayByteLength = Function.call.bind(typedArrayByteLengthGetter) as (target: Uint8Array) => number;
const typedArrayByteOffset = Function.call.bind(typedArrayByteOffsetGetter) as (target: Uint8Array) => number;

interface SnapshotMetadata {
  readonly canonicalBytes: Buffer;
  readonly canonicalJson: string;
  readonly sha256: string;
}

interface ValueMetrics {
  encodedBytes: number;
  nodes: number;
  containerDepth: number;
  maxArrayLength: number;
  maxObjectKeys: number;
  maxStringBytes: number;
}

interface SemanticStringBudget {
  bytes: number;
  pendingHighSurrogate: boolean;
}

type MutableInertObject = { [key: string]: InertDataValue };

const containerMetrics = new SafeWeakMap<object, Readonly<ValueMetrics>>();
const trustedLimits = new SafeWeakSet<object>();
const snapshotMetadata = new SafeWeakMap<object, SnapshotMetadata>();

export const DEFAULT_INERT_DATA_LIMITS: Readonly<InertDataLimits> = createLimitsUnchecked(
  MAX_DEPTH,
  MAX_NODES,
  MAX_ARRAY_LENGTH,
  MAX_OBJECT_KEYS,
  MAX_STRING_BYTES,
  MAX_TOTAL_ENCODED_BYTES
);

/** Creates an opaque lowering-only budget accepted by every authority API. */
export function createInertDataLimits(
  maxDepth: number,
  maxNodes: number,
  maxArrayLength: number,
  maxObjectKeys: number,
  maxStringBytes: number,
  maxTotalEncodedBytes: number
): InertDataLimits | null {
  if (!validLimit(maxDepth, MAX_DEPTH) || !validLimit(maxNodes, MAX_NODES) ||
      !validLimit(maxArrayLength, MAX_ARRAY_LENGTH) || !validLimit(maxObjectKeys, MAX_OBJECT_KEYS) ||
      !validLimit(maxStringBytes, MAX_STRING_BYTES) ||
      !validLimit(maxTotalEncodedBytes, MAX_TOTAL_ENCODED_BYTES)) return null;
  return createLimitsUnchecked(
    maxDepth,
    maxNodes,
    maxArrayLength,
    maxObjectKeys,
    maxStringBytes,
    maxTotalEncodedBytes
  );
}

/** Builds one branded array from descriptor-safe scalar/branded children. */
export function createInertDataArray(
  items: readonly InertDataValue[],
  limits?: InertDataLimits
): InertDataArray | null {
  try {
    const resolved = resolveLimits(limits);
    if (resolved === null) return null;
    const length = exactSourceArrayLength(items, resolved.maxArrayLength);
    if (length === null) return null;
    const metrics = createContainerMetrics("array", length);
    if (!metricsWithinLimits(metrics, resolved)) return null;
    for (let index = 0; index < length; index += 1) {
      const descriptor = dataElementDescriptor(items, index);
      const childMetrics = descriptor === null
        ? null
        : metricsForTrustedValue(descriptor.value, resolved.maxStringBytes);
      if (childMetrics === null || !accumulateChildMetrics(metrics, childMetrics, resolved)) return null;
    }

    const output = createScratchArray<InertDataValue>();
    for (let index = 0; index < length; index += 1) {
      const descriptor = dataElementDescriptor(items, index);
      if (descriptor === null) return null;
      defineArrayElement(output, index, descriptor.value as InertDataValue);
    }
    const result = objectFreeze(output) as unknown as InertDataArray;
    weakMapSet(containerMetrics, result, freezeMetrics(metrics));
    return result;
  } catch {
    return null;
  }
}

/** Builds one branded null-prototype object from descriptor-safe `[key, value]` entries. */
export function createInertDataObject(
  entries: readonly InertDataEntry[],
  limits?: InertDataLimits
): InertDataObject | null {
  try {
    const resolved = resolveLimits(limits);
    if (resolved === null) return null;
    const length = exactSourceArrayLength(entries, resolved.maxObjectKeys);
    if (length === null) return null;
    const seen = new SafeSet<string>();
    const metrics = createContainerMetrics("object", length);
    if (!metricsWithinLimits(metrics, resolved)) return null;

    for (let index = 0; index < length; index += 1) {
      const entryDescriptor = dataElementDescriptor(entries, index);
      if (entryDescriptor === null) return null;
      const entry = entryDescriptor.value;
      const entryLength = exactSourceArrayLength(entry, 2);
      if (entryLength !== 2) return null;
      const keyDescriptor = dataElementDescriptor(entry, 0);
      const valueDescriptor = dataElementDescriptor(entry, 1);
      if (keyDescriptor === null || valueDescriptor === null || typeof keyDescriptor.value !== "string") return null;
      const keySizes = stringSizes(keyDescriptor.value, resolved.maxStringBytes);
      const childMetrics = metricsForTrustedValue(valueDescriptor.value, resolved.maxStringBytes);
      if (keySizes === null || setHas(seen, keyDescriptor.value) || childMetrics === null ||
          !accumulateObjectKeyMetrics(metrics, keySizes, resolved) ||
          !accumulateChildMetrics(metrics, childMetrics, resolved)) return null;
      setAdd(seen, keyDescriptor.value);
    }

    const output = objectCreate(null) as MutableInertObject;
    for (let index = 0; index < length; index += 1) {
      const entry = dataElementDescriptor(entries, index)?.value as readonly unknown[];
      const key = dataElementDescriptor(entry, 0)?.value as string;
      const value = dataElementDescriptor(entry, 1)?.value as InertDataValue;
      defineObjectField(output, key, value);
    }
    const result = objectFreeze(output) as unknown as InertDataObject;
    weakMapSet(containerMetrics, result, freezeMetrics(metrics));
    return result;
  } catch {
    return null;
  }
}

/** Creates an opaque canonical snapshot only from a scalar or module-branded container. */
export function createInertDataSnapshot(
  value: InertDataValue,
  limits?: InertDataLimits
): InertDataSnapshot | null {
  try {
    const resolved = resolveLimits(limits);
    if (resolved === null) return null;
    const metrics = metricsForTrustedValue(value, resolved.maxStringBytes);
    if (metrics === null || !metricsWithinLimits(metrics, resolved)) return null;

    const chunks = createScratchArray<string>();
    appendCanonicalJson(value, chunks);
    const canonicalJson = arrayJoin(chunks, "");
    const canonicalBytes = canonicalBytesFromText(canonicalJson);
    return typedArrayByteLength(canonicalBytes) === metrics.encodedBytes
      ? createSnapshotUnchecked(value, canonicalJson, canonicalBytes)
      : null;
  } catch {
    return null;
  }
}

/** Parses only canonical fatal UTF-8 JSON into branded containers under the supplied frame budget. */
export function parseCanonicalInertData(
  bytes: Uint8Array,
  limits?: InertDataLimits
): InertDataSnapshot | null {
  try {
    const resolved = resolveLimits(limits);
    if (resolved === null || bytes === null || typeof bytes !== "object" || utilIsProxy(bytes) ||
        !utilIsUint8Array(bytes)) return null;
    const inputLength = typedArrayByteLength(bytes);
    const inputBuffer = typedArrayBuffer(bytes);
    const inputOffset = typedArrayByteOffset(bytes);
    if (inputLength === 0 || inputLength > resolved.maxTotalEncodedBytes ||
        utilIsSharedArrayBuffer(inputBuffer)) return null;
    const inputView = bufferFromArrayBuffer(inputBuffer as ArrayBuffer, inputOffset, inputLength);
    const copied = bufferFromView(inputView);
    const text = textDecoderDecode(textDecoder, copied);
    const value = new CanonicalJsonParser(text, resolved, inputLength).parse();
    return createSnapshotUnchecked(value, text, copied);
  } catch {
    return null;
  }
}

/** Returns immutable canonical JSON text for a genuine snapshot. */
export function stringifyCanonicalInertData(snapshot: unknown): string | null {
  return snapshotDetails(snapshot)?.canonicalJson ?? null;
}

/** Returns a fresh copy of canonical UTF-8 bytes for a genuine snapshot. */
export function encodeCanonicalInertData(snapshot: unknown): Buffer | null {
  const bytes = snapshotDetails(snapshot)?.canonicalBytes;
  return bytes === undefined ? null : bufferFromView(bytes);
}

/** Returns the SHA-256 digest for a genuine snapshot. */
export function digestInertDataSnapshot(snapshot: unknown): string | null {
  return snapshotDetails(snapshot)?.sha256 ?? null;
}

function createLimitsUnchecked(
  maxDepth: number,
  maxNodes: number,
  maxArrayLength: number,
  maxObjectKeys: number,
  maxStringBytes: number,
  maxTotalEncodedBytes: number
): InertDataLimits {
  const limits = objectCreate(null) as Record<PropertyKey, unknown>;
  defineObjectField(limits, "maxDepth", maxDepth);
  defineObjectField(limits, "maxNodes", maxNodes);
  defineObjectField(limits, "maxArrayLength", maxArrayLength);
  defineObjectField(limits, "maxObjectKeys", maxObjectKeys);
  defineObjectField(limits, "maxStringBytes", maxStringBytes);
  defineObjectField(limits, "maxTotalEncodedBytes", maxTotalEncodedBytes);
  weakSetAdd(trustedLimits, limits);
  return objectFreeze(limits) as unknown as InertDataLimits;
}

function resolveLimits(limits: InertDataLimits | undefined): InertDataLimits | null {
  if (limits === undefined) return DEFAULT_INERT_DATA_LIMITS;
  return limits !== null && typeof limits === "object" && weakSetHas(trustedLimits, limits) ? limits : null;
}

function exactSourceArrayLength(value: unknown, maximum: number): number | null {
  if (value === null || typeof value !== "object" || utilIsProxy(value) || !arrayIsArray(value)) return null;
  const lengthDescriptor = objectGetOwnPropertyDescriptor(value, "length");
  if (lengthDescriptor === undefined || !objectHasOwn(lengthDescriptor, "value") ||
      !numberIsSafeInteger(lengthDescriptor.value) || lengthDescriptor.value < 0 ||
      lengthDescriptor.value > maximum) return null;
  const length = lengthDescriptor.value as number;
  const keys = reflectOwnKeys(value);
  if (keys.length !== length + 1 || hasNonStringKey(keys)) return null;
  return length;
}

function dataElementDescriptor(value: unknown, index: number): PropertyDescriptor | null {
  if (value === null || typeof value !== "object" || utilIsProxy(value)) return null;
  const descriptor = objectGetOwnPropertyDescriptor(value, numberToString(index));
  return descriptor !== undefined && objectHasOwn(descriptor, "value") && descriptor.enumerable === true
    ? descriptor
    : null;
}

function metricsForTrustedValue(value: unknown, maxStringBytes: number): Readonly<ValueMetrics> | null {
  if (value === null) return scalarMetrics(4, 0);
  if (typeof value === "boolean") return scalarMetrics(value ? 4 : 5, 0);
  if (typeof value === "number") {
    return numberIsFinite(value) && !objectIs(value, -0)
      ? scalarMetrics(numberToString(value).length, 0)
      : null;
  }
  if (typeof value === "string") {
    const sizes = stringSizes(value, maxStringBytes);
    return sizes === null ? null : scalarMetrics(sizes.canonicalBytes, sizes.rawBytes);
  }
  return typeof value === "object" && value !== null
    ? weakMapGet(containerMetrics, value) ?? null
    : null;
}

function scalarMetrics(encodedBytes: number, maxStringBytes: number): Readonly<ValueMetrics> {
  const metrics = createMutableMetrics();
  metrics.encodedBytes = encodedBytes;
  metrics.nodes = 1;
  metrics.maxStringBytes = maxStringBytes;
  return metrics;
}

function createContainerMetrics(kind: "array" | "object", length: number): ValueMetrics {
  const metrics = createMutableMetrics();
  metrics.encodedBytes = 2 + (length === 0 ? 0 : length - 1);
  metrics.nodes = 1;
  metrics.containerDepth = 1;
  if (kind === "array") metrics.maxArrayLength = length;
  else metrics.maxObjectKeys = length;
  return metrics;
}

function createMutableMetrics(): ValueMetrics {
  const metrics = objectCreate(null) as ValueMetrics;
  metrics.encodedBytes = 0;
  metrics.nodes = 0;
  metrics.containerDepth = 0;
  metrics.maxArrayLength = 0;
  metrics.maxObjectKeys = 0;
  metrics.maxStringBytes = 0;
  return metrics;
}

function accumulateChildMetrics(
  target: ValueMetrics,
  child: Readonly<ValueMetrics>,
  limits: InertDataLimits
): boolean {
  if (child.encodedBytes > limits.maxTotalEncodedBytes - target.encodedBytes ||
      child.nodes > limits.maxNodes - target.nodes) return false;
  target.encodedBytes += child.encodedBytes;
  target.nodes += child.nodes;
  const childDepth = child.containerDepth === 0 ? 1 : child.containerDepth + 1;
  if (childDepth > target.containerDepth) target.containerDepth = childDepth;
  if (child.maxArrayLength > target.maxArrayLength) target.maxArrayLength = child.maxArrayLength;
  if (child.maxObjectKeys > target.maxObjectKeys) target.maxObjectKeys = child.maxObjectKeys;
  if (child.maxStringBytes > target.maxStringBytes) target.maxStringBytes = child.maxStringBytes;
  return metricsWithinLimits(target, limits);
}

function accumulateObjectKeyMetrics(
  target: ValueMetrics,
  sizes: { rawBytes: number; canonicalBytes: number },
  limits: InertDataLimits
): boolean {
  const amount = sizes.canonicalBytes + 1;
  if (amount > limits.maxTotalEncodedBytes - target.encodedBytes) return false;
  target.encodedBytes += amount;
  if (sizes.rawBytes > target.maxStringBytes) target.maxStringBytes = sizes.rawBytes;
  return metricsWithinLimits(target, limits);
}

function metricsWithinLimits(metrics: Readonly<ValueMetrics>, limits: InertDataLimits): boolean {
  return metrics.encodedBytes <= limits.maxTotalEncodedBytes && metrics.nodes <= limits.maxNodes &&
    metrics.containerDepth <= limits.maxDepth && metrics.maxArrayLength <= limits.maxArrayLength &&
    metrics.maxObjectKeys <= limits.maxObjectKeys && metrics.maxStringBytes <= limits.maxStringBytes;
}

function freezeMetrics(metrics: ValueMetrics): Readonly<ValueMetrics> {
  return objectFreeze(metrics);
}

function appendCanonicalJson(value: InertDataValue, chunks: string[]): void {
  if (value === null) {
    arrayPush(chunks, "null");
    return;
  }
  if (typeof value === "boolean") {
    arrayPush(chunks, value ? "true" : "false");
    return;
  }
  if (typeof value === "number") {
    arrayPush(chunks, numberToString(value));
    return;
  }
  if (typeof value === "string") {
    arrayPush(chunks, quoteCanonicalString(value));
    return;
  }
  if (arrayIsArray(value)) {
    arrayPush(chunks, "[");
    for (let index = 0; index < value.length; index += 1) {
      if (index > 0) arrayPush(chunks, ",");
      const descriptor = objectGetOwnPropertyDescriptor(value, numberToString(index));
      appendCanonicalJson(descriptor?.value as InertDataValue, chunks);
    }
    arrayPush(chunks, "]");
    return;
  }

  const keys = reflectOwnKeys(value) as string[];
  arraySort(keys, compareCodeUnits);
  arrayPush(chunks, "{");
  for (let index = 0; index < keys.length; index += 1) {
    if (index > 0) arrayPush(chunks, ",");
    const key = keys[index] as string;
    arrayPush(chunks, quoteCanonicalString(key), ":");
    const descriptor = objectGetOwnPropertyDescriptor(value, key);
    appendCanonicalJson(descriptor?.value as InertDataValue, chunks);
  }
  arrayPush(chunks, "}");
}

function quoteCanonicalString(value: string): string {
  let chunks: string[] | null = null;
  let pending = "\"";
  let segmentStart = 0;
  for (let index = 0; index < value.length; index += 1) {
    const code = stringCharCodeAt(value, index);
    const escaped = canonicalEscape(code);
    if (escaped === null) continue;
    if (chunks === null) {
      chunks = createScratchArray<string>();
    }
    pending += stringSlice(value, segmentStart, index) + escaped;
    if (pending.length >= STRING_CHUNK_CODE_UNITS) {
      arrayPush(chunks, pending);
      pending = "";
    }
    segmentStart = index + 1;
  }
  if (chunks === null) return `"${value}"`;
  pending += stringSlice(value, segmentStart) + "\"";
  arrayPush(chunks, pending);
  return arrayJoin(chunks, "");
}

function canonicalEscape(code: number): string | null {
  switch (code) {
    case 0x08: return "\\b";
    case 0x09: return "\\t";
    case 0x0a: return "\\n";
    case 0x0c: return "\\f";
    case 0x0d: return "\\r";
    case 0x22: return "\\\"";
    case 0x5c: return "\\\\";
    default:
      return code < 0x20 || (code >= 0xd800 && code <= 0xdfff) ? unicodeEscape(code) : null;
  }
}

function addSemanticCodeUnit(
  budget: SemanticStringBudget,
  code: number,
  maximum: number
): boolean {
  if (budget.pendingHighSurrogate) {
    budget.pendingHighSurrogate = false;
    if (code >= 0xdc00 && code <= 0xdfff) {
      budget.bytes += 4;
      return budget.bytes <= maximum;
    }
    budget.bytes += 3;
    if (budget.bytes > maximum) return false;
  }
  if (code >= 0xd800 && code <= 0xdbff) {
    budget.pendingHighSurrogate = true;
    return true;
  }
  budget.bytes += code >= 0xdc00 && code <= 0xdfff ? 3 : utf8BytesForBmpCodeUnit(code);
  return budget.bytes <= maximum;
}

function finishSemanticStringBudget(budget: SemanticStringBudget, maximum: number): boolean {
  if (budget.pendingHighSurrogate) {
    budget.pendingHighSurrogate = false;
    budget.bytes += 3;
  }
  return budget.bytes <= maximum;
}

function utf8BytesForBmpCodeUnit(code: number): number {
  return code <= 0x7f ? 1 : code <= 0x7ff ? 2 : 3;
}

function stringSizes(
  value: string,
  maxStringBytes: number
): { rawBytes: number; canonicalBytes: number } | null {
  if (value.length > maxStringBytes) return null;
  let rawBytes = 0;
  let canonicalBytes = 2;
  for (let index = 0; index < value.length; index += 1) {
    const code = stringCharCodeAt(value, index);
    if (code <= 0x7f) rawBytes += 1;
    else if (code <= 0x7ff) rawBytes += 2;
    else if (code >= 0xd800 && code <= 0xdbff && index + 1 < value.length) {
      const next = stringCharCodeAt(value, index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        rawBytes += 4;
        canonicalBytes += 12;
        index += 1;
        if (rawBytes > maxStringBytes) return null;
        continue;
      }
      rawBytes += 3;
    } else rawBytes += 3;
    if (rawBytes > maxStringBytes) return null;

    if (code === 0x22 || code === 0x5c || code === 0x08 || code === 0x09 ||
        code === 0x0a || code === 0x0c || code === 0x0d) canonicalBytes += 2;
    else if (code < 0x20 || (code >= 0xd800 && code <= 0xdfff)) canonicalBytes += 6;
    else if (code <= 0x7f) canonicalBytes += 1;
    else if (code <= 0x7ff) canonicalBytes += 2;
    else canonicalBytes += 3;
  }
  return { rawBytes, canonicalBytes };
}

class CanonicalJsonParser {
  private position = 0;
  private nodes = 0;
  private lastMetrics: Readonly<ValueMetrics> | null = null;
  private lastStringSizes: { rawBytes: number; canonicalBytes: number } | null = null;

  constructor(
    private readonly source: string,
    private readonly limits: InertDataLimits,
    private readonly expectedEncodedBytes: number
  ) {}

  parse(): InertDataValue {
    const value = this.parseValue(0);
    if (this.position !== this.source.length || this.lastMetrics === null ||
        this.lastMetrics.encodedBytes !== this.expectedEncodedBytes ||
        !metricsWithinLimits(this.lastMetrics, this.limits)) this.fail();
    return value;
  }

  private parseValue(depth: number): InertDataValue {
    this.nodes += 1;
    if (this.nodes > this.limits.maxNodes || this.position >= this.source.length) this.fail();
    const code = stringCharCodeAt(this.source, this.position);
    if (code === 0x22) {
      const value = this.parseString();
      const sizes = this.lastStringSizes;
      if (sizes === null) this.fail();
      this.lastMetrics = scalarMetrics(sizes.canonicalBytes, sizes.rawBytes);
      return value;
    }
    if (code === 0x5b) return this.parseArray(depth);
    if (code === 0x7b) return this.parseObject(depth);
    if (code === 0x74) {
      this.consumeLiteral("true");
      this.lastMetrics = scalarMetrics(4, 0);
      return true;
    }
    if (code === 0x66) {
      this.consumeLiteral("false");
      this.lastMetrics = scalarMetrics(5, 0);
      return false;
    }
    if (code === 0x6e) {
      this.consumeLiteral("null");
      this.lastMetrics = scalarMetrics(4, 0);
      return null;
    }
    if (code === 0x2d || (code >= 0x30 && code <= 0x39)) return this.parseNumber();
    return this.fail();
  }

  private parseArray(depth: number): InertDataArray {
    if (depth >= this.limits.maxDepth) this.fail();
    this.position += 1;
    const output = createScratchArray<InertDataValue>();
    const metrics = createContainerMetrics("array", 0);
    if (!metricsWithinLimits(metrics, this.limits)) this.fail();
    if (this.peek(0x5d)) {
      this.position += 1;
      return this.finishParsedContainer(output, metrics) as InertDataArray;
    }
    let length = 0;
    while (true) {
      if (length >= this.limits.maxArrayLength) this.fail();
      if (length > 0 && !this.addStructuralByte(metrics)) this.fail();
      const child = this.parseValue(depth + 1);
      const childMetrics = this.lastMetrics;
      if (childMetrics === null || !accumulateChildMetrics(metrics, childMetrics, this.limits)) this.fail();
      defineArrayElement(output, length, child);
      length += 1;
      metrics.maxArrayLength = length;
      if (this.peek(0x5d)) {
        this.position += 1;
        return this.finishParsedContainer(output, metrics) as InertDataArray;
      }
      if (!this.peek(0x2c)) this.fail();
      this.position += 1;
    }
  }

  private parseObject(depth: number): InertDataObject {
    if (depth >= this.limits.maxDepth) this.fail();
    this.position += 1;
    const output = objectCreate(null) as MutableInertObject;
    const metrics = createContainerMetrics("object", 0);
    if (!metricsWithinLimits(metrics, this.limits)) this.fail();
    if (this.peek(0x7d)) {
      this.position += 1;
      return this.finishParsedContainer(output, metrics) as InertDataObject;
    }
    let count = 0;
    let previousKey = "";
    while (true) {
      if (count >= this.limits.maxObjectKeys || !this.peek(0x22)) this.fail();
      if (count > 0 && !this.addStructuralByte(metrics)) this.fail();
      const key = this.parseString();
      const keySizes = this.lastStringSizes;
      if (keySizes === null || (count > 0 && compareCodeUnits(previousKey, key) >= 0) ||
          !accumulateObjectKeyMetrics(metrics, keySizes, this.limits)) this.fail();
      previousKey = key;
      if (!this.peek(0x3a)) this.fail();
      this.position += 1;
      const child = this.parseValue(depth + 1);
      const childMetrics = this.lastMetrics;
      if (childMetrics === null || !accumulateChildMetrics(metrics, childMetrics, this.limits)) this.fail();
      defineObjectField(output, key, child);
      count += 1;
      metrics.maxObjectKeys = count;
      if (this.peek(0x7d)) {
        this.position += 1;
        return this.finishParsedContainer(output, metrics) as InertDataObject;
      }
      if (!this.peek(0x2c)) this.fail();
      this.position += 1;
    }
  }

  private parseString(): string {
    if (!this.peek(0x22)) this.fail();
    const tokenStart = this.position;
    this.position += 1;
    const contentStart = this.position;
    let hasEscape = false;
    let canonicalBytes = 2;
    const semantic = objectCreate(null) as SemanticStringBudget;
    semantic.bytes = 0;
    semantic.pendingHighSurrogate = false;
    while (this.position < this.source.length) {
      const tokenPosition = this.position;
      let code = stringCharCodeAt(this.source, tokenPosition);
      if (code === 0x22) {
        if (!finishSemanticStringBudget(semantic, this.limits.maxStringBytes)) this.fail();
        const value = hasEscape
          ? jsonParse(stringSlice(this.source, tokenStart, tokenPosition + 1))
          : stringSlice(this.source, contentStart, tokenPosition);
        if (typeof value !== "string") this.fail();
        this.lastStringSizes = { rawBytes: semantic.bytes, canonicalBytes };
        this.position += 1;
        return value;
      }
      if (code < 0x20 || (code >= 0xd800 && code <= 0xdfff)) this.fail();
      if (code === 0x5c) {
        hasEscape = true;
        this.position += 1;
        if (this.position >= this.source.length) this.fail();
        code = stringCharCodeAt(this.source, this.position);
        this.position += 1;
        let decodedCode: number;
        switch (code) {
          case 0x22: decodedCode = 0x22; canonicalBytes += 2; break;
          case 0x5c: decodedCode = 0x5c; canonicalBytes += 2; break;
          case 0x62: decodedCode = 0x08; canonicalBytes += 2; break;
          case 0x66: decodedCode = 0x0c; canonicalBytes += 2; break;
          case 0x6e: decodedCode = 0x0a; canonicalBytes += 2; break;
          case 0x72: decodedCode = 0x0d; canonicalBytes += 2; break;
          case 0x74: decodedCode = 0x09; canonicalBytes += 2; break;
          case 0x75: decodedCode = this.parseCanonicalUnicodeEscapeCode(); canonicalBytes += 6; break;
          default: this.fail();
        }
        if (!addSemanticCodeUnit(semantic, decodedCode, this.limits.maxStringBytes)) this.fail();
      } else {
        this.position += 1;
        const bytes = utf8BytesForBmpCodeUnit(code);
        canonicalBytes += bytes;
        if (!addSemanticCodeUnit(semantic, code, this.limits.maxStringBytes)) this.fail();
      }
    }
    return this.fail();
  }

  private parseCanonicalUnicodeEscapeCode(): number {
    if (this.position + 4 > this.source.length) this.fail();
    let code = 0;
    for (let index = 0; index < 4; index += 1) {
      const digit = lowercaseHexValue(stringCharCodeAt(this.source, this.position + index));
      if (digit < 0) this.fail();
      code = (code << 4) | digit;
    }
    this.position += 4;
    if (!isCanonicalUnicodeEscapeCode(code)) this.fail();
    return code;
  }

  private parseNumber(): number {
    const start = this.position;
    if (this.peek(0x2d)) this.advanceNumber(start);
    if (this.peek(0x30)) {
      this.advanceNumber(start);
    } else {
      const first = this.currentCode();
      if (first < 0x31 || first > 0x39) this.fail();
      this.advanceNumber(start);
      while (this.isDigit()) this.advanceNumber(start);
    }
    if (this.peek(0x2e)) {
      this.advanceNumber(start);
      if (!this.isDigit()) this.fail();
      while (this.isDigit()) this.advanceNumber(start);
    }
    if (this.peek(0x65) || this.peek(0x45)) {
      this.advanceNumber(start);
      if (this.peek(0x2b) || this.peek(0x2d)) this.advanceNumber(start);
      if (!this.isDigit()) this.fail();
      while (this.isDigit()) this.advanceNumber(start);
    }
    const token = stringSlice(this.source, start, this.position);
    const value = numberFrom(token);
    if (!numberIsFinite(value) || objectIs(value, -0) || token !== numberToString(value)) this.fail();
    this.lastMetrics = scalarMetrics(token.length, 0);
    return value;
  }

  private advanceNumber(start: number): void {
    this.position += 1;
    if (this.position - start > MAX_CANONICAL_NUMBER_CODE_UNITS) this.fail();
  }

  private consumeLiteral(value: string): void {
    for (let index = 0; index < value.length; index += 1) {
      if (stringCharCodeAt(this.source, this.position + index) !== stringCharCodeAt(value, index)) this.fail();
    }
    this.position += value.length;
  }

  private isDigit(): boolean {
    const code = this.currentCode();
    return code >= 0x30 && code <= 0x39;
  }

  private currentCode(): number {
    return this.position < this.source.length ? stringCharCodeAt(this.source, this.position) : -1;
  }

  private peek(code: number): boolean {
    return this.position < this.source.length && stringCharCodeAt(this.source, this.position) === code;
  }

  private addStructuralByte(metrics: ValueMetrics): boolean {
    if (metrics.encodedBytes >= this.limits.maxTotalEncodedBytes) return false;
    metrics.encodedBytes += 1;
    return true;
  }

  private finishParsedContainer(
    value: InertDataArray | InertDataObject | InertDataValue[] | MutableInertObject,
    metrics: ValueMetrics
  ): InertDataArray | InertDataObject {
    if (!metricsWithinLimits(metrics, this.limits)) this.fail();
    const result = objectFreeze(value) as InertDataArray | InertDataObject;
    const frozenMetrics = freezeMetrics(metrics);
    weakMapSet(containerMetrics, result, frozenMetrics);
    this.lastMetrics = frozenMetrics;
    return result;
  }

  private fail(): never {
    throw PARSE_FAILURE;
  }
}

function validLimit(value: number, maximum: number): boolean {
  return numberIsSafeInteger(value) && value >= 0 && value <= maximum;
}

function snapshotDetails(snapshot: unknown): SnapshotMetadata | undefined {
  return snapshot !== null && typeof snapshot === "object" ? weakMapGet(snapshotMetadata, snapshot) : undefined;
}

function createScratchArray<T>(): T[] {
  const value: T[] = [];
  objectSetPrototypeOf(value, null);
  return value;
}

function defineArrayElement(target: unknown[], index: number, value: unknown): void {
  objectDefineProperty(target, numberToString(index), dataDescriptor(value));
}

function defineObjectField(target: object, key: PropertyKey, value: unknown): void {
  objectDefineProperty(target, key, dataDescriptor(value));
}

function dataDescriptor(value: unknown): PropertyDescriptor {
  const descriptor = objectCreate(null) as PropertyDescriptor;
  descriptor.configurable = false;
  descriptor.enumerable = true;
  descriptor.value = value;
  descriptor.writable = false;
  return descriptor;
}

function canonicalBytesFromText(value: string): Buffer {
  return bufferFromView(textEncoderEncode(textEncoder, value));
}

function createSnapshotUnchecked(
  value: InertDataValue,
  canonicalJson: string,
  canonicalBytes: Buffer
): InertDataSnapshot {
  const encodedByteLength = typedArrayByteLength(canonicalBytes);
  const result = objectCreate(null) as Record<PropertyKey, unknown>;
  defineObjectField(result, "value", value);
  defineObjectField(result, "encodedByteLength", encodedByteLength);
  const snapshot = objectFreeze(result) as unknown as InertDataSnapshot;
  const hash = safeCreateHash("sha256");
  hashUpdate(hash, canonicalBytes);
  const metadata = objectCreate(null) as Record<string, unknown>;
  defineObjectField(metadata, "canonicalBytes", canonicalBytes);
  defineObjectField(metadata, "canonicalJson", canonicalJson);
  defineObjectField(metadata, "sha256", hashDigest(hash, "hex"));
  weakMapSet(snapshotMetadata, snapshot, objectFreeze(metadata) as unknown as SnapshotMetadata);
  return snapshot;
}

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function hasNonStringKey(keys: readonly PropertyKey[]): boolean {
  for (let index = 0; index < keys.length; index += 1) {
    if (typeof keys[index] !== "string") return true;
  }
  return false;
}

function unicodeEscape(code: number): string {
  return `\\u${HEX[(code >>> 12) & 0xf]}${HEX[(code >>> 8) & 0xf]}${HEX[(code >>> 4) & 0xf]}${HEX[code & 0xf]}`;
}

function lowercaseHexValue(code: number): number {
  if (code >= 0x30 && code <= 0x39) return code - 0x30;
  if (code >= 0x61 && code <= 0x66) return code - 0x61 + 10;
  return -1;
}

function isCanonicalUnicodeEscapeCode(code: number): boolean {
  if (code >= 0xd800 && code <= 0xdfff) return true;
  return code < 0x20 && code !== 0x08 && code !== 0x09 && code !== 0x0a &&
    code !== 0x0c && code !== 0x0d;
}
