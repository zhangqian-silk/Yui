import {
  createExactInertJsonSnapshot,
  DEFAULT_EXACT_INERT_JSON_LIMITS,
  type InertJsonValue
} from "./inertJson.js";
import {
  AUTHORITY_REGISTRY,
  MAX_PORTABLE_SNAPSHOT_BYTES,
  PORTABLE_SNAPSHOT_SCHEMA_VERSION,
  snapshotPortableSnapshotV3,
  type AgentRequirement,
  type AuthorityDescriptor,
  type PortableSemantic,
  type PortableSnapshotV3,
  type WorkspaceBinding
} from "./portableSchema.js";

export const PORTABLE_EXPORT_ERROR_MESSAGE = "Portable export failed.";

/**
 * A synchronous capability over one logical semantic snapshot. Every method must observe the
 * same point-in-time state. The exporter lists authorities once, reads each included authority
 * at most once, and reads both logical dependency catalogs once.
 */
export interface SemanticSnapshotReader {
  listAuthorityIds(): readonly string[];
  readAuthorityRecords(authorityId: string): readonly unknown[];
  readWorkspaceBindings(): readonly unknown[];
  readAgentRequirements(): readonly unknown[];
}

export type RenderedPortableSnapshotV3 = Readonly<{
  snapshot: PortableSnapshotV3;
  manifest: string;
}>;

const REFLECT_APPLY = Reflect.apply;
const ARRAY_IS_ARRAY = Array.isArray;
const ARRAY_SORT = Array.prototype.sort;
const BUFFER_BYTE_LENGTH = Buffer.byteLength;
const JSON_STRINGIFY = JSON.stringify;
const MAP_GET = Map.prototype.get;
const NUMBER_IS_SAFE_INTEGER = Number.isSafeInteger;
const OBJECT_FREEZE = Object.freeze;
const OBJECT_KEYS = Object.keys;
const SET_ADD = Set.prototype.add;
const SET_HAS = Set.prototype.has;
const STRING_CHAR_CODE_AT = String.prototype.charCodeAt;
const STRING_SLICE = String.prototype.slice;

const AUTHORITY_BY_ID = new Map(
  AUTHORITY_REGISTRY.map((descriptor) => [descriptor.id, descriptor])
);
const AUTHORITY_LIST_LIMITS = OBJECT_FREEZE({
  maxDepth: 1,
  maxNodes: AUTHORITY_REGISTRY.length + 1,
  maxStringBytes: AUTHORITY_REGISTRY.reduce(
    (total, descriptor) => total + BUFFER_BYTE_LENGTH(descriptor.id, "utf8"),
    0
  ),
  maxArrayLength: AUTHORITY_REGISTRY.length
});
const CONTROL_JSON_ESCAPES = OBJECT_FREEZE([
  "\\u0000", "\\u0001", "\\u0002", "\\u0003", "\\u0004", "\\u0005", "\\u0006", "\\u0007",
  "\\b", "\\t", "\\n", "\\u000b", "\\f", "\\r", "\\u000e", "\\u000f",
  "\\u0010", "\\u0011", "\\u0012", "\\u0013", "\\u0014", "\\u0015", "\\u0016", "\\u0017",
  "\\u0018", "\\u0019", "\\u001a", "\\u001b", "\\u001c", "\\u001d", "\\u001e", "\\u001f"
]);
const CANONICAL_CHUNK_CODE_UNITS = 4096;
const CANONICAL_FLUSH_CODE_UNITS = 8192;

export function projectPortableSnapshotV3(
  reader: SemanticSnapshotReader,
  exportedAt: string
): PortableSnapshotV3 {
  try {
    return projectPortableSnapshotV3Unsafe(reader, exportedAt);
  } catch {
    throw new Error(PORTABLE_EXPORT_ERROR_MESSAGE);
  }
}

export function renderPortableSnapshotV3(
  reader: SemanticSnapshotReader,
  exportedAt: string,
  maxBytes: number = MAX_PORTABLE_SNAPSHOT_BYTES
): RenderedPortableSnapshotV3 {
  if (!NUMBER_IS_SAFE_INTEGER(maxBytes) || maxBytes < 0 || maxBytes > MAX_PORTABLE_SNAPSHOT_BYTES) {
    throw new Error(PORTABLE_EXPORT_ERROR_MESSAGE);
  }
  const snapshot = projectPortableSnapshotV3(reader, exportedAt);
  try {
    const manifest = renderCanonicalJson(snapshot as unknown as InertJsonValue, maxBytes);
    return OBJECT_FREEZE({ snapshot, manifest });
  } catch {
    throw new Error(PORTABLE_EXPORT_ERROR_MESSAGE);
  }
}

function projectPortableSnapshotV3Unsafe(
  reader: SemanticSnapshotReader,
  exportedAt: string
): PortableSnapshotV3 {
  validateExportedAt(exportedAt);
  const authorities = readAuthorityIndex(reader);
  const aggregate = readExportAggregate(reader, authorities);
  const semantic = aggregate.semantic;
  const workspaceIds = new Set<string>();
  const agentIds = new Set<string>();

  for (let index = 0; index < semantic.length; index += 1) {
    const record = semantic[index] as PortableSemantic;
    sortStringArray(record.workspaceBindingIds, workspaceIds);
    sortStringArray(record.agentRequirementIds, agentIds);
    sortReferences(record);
  }
  sortInPlace(semantic, (left, right) => compareCodeUnits(
    semanticIdentity(left),
    semanticIdentity(right)
  ));

  const workspaceBindings = selectWorkspaceBindings(aggregate.workspaceBindings, workspaceIds);
  const agentRequirements = selectAgentRequirements(aggregate.agentRequirements, agentIds);

  const snapshot = snapshotPortableSnapshotV3({
    schemaVersion: PORTABLE_SNAPSHOT_SCHEMA_VERSION,
    exportedAt,
    workspaceBindings,
    agentRequirements,
    semantic
  });
  if (snapshot === null) fail();
  deepFreezeInertJson(snapshot as unknown as InertJsonValue);
  return snapshot;
}

function validateExportedAt(exportedAt: string): void {
  if (snapshotPortableSnapshotV3({
    schemaVersion: PORTABLE_SNAPSHOT_SCHEMA_VERSION,
    exportedAt,
    workspaceBindings: [],
    agentRequirements: [],
    semantic: []
  }) === null) fail();
}

function readAuthorityIndex(
  reader: SemanticSnapshotReader
): readonly { id: string; descriptor: AuthorityDescriptor }[] {
  const values = createExactInertJsonSnapshot(
    reader.listAuthorityIds(),
    AUTHORITY_LIST_LIMITS
  )?.value;
  if (!ARRAY_IS_ARRAY(values)) fail();
  const seen = new Set<string>();
  const result: { id: string; descriptor: AuthorityDescriptor }[] = [];
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (typeof value !== "string" || setHas(seen, value)) fail();
    const descriptor = REFLECT_APPLY(MAP_GET, AUTHORITY_BY_ID, [value]) as AuthorityDescriptor | undefined;
    if (descriptor === undefined) fail();
    setAdd(seen, value);
    result[result.length] = { id: value, descriptor };
  }
  return result;
}

function readExportAggregate(
  reader: SemanticSnapshotReader,
  authorities: readonly { id: string; descriptor: AuthorityDescriptor }[]
): {
  semantic: PortableSemantic[];
  workspaceBindings: InertJsonValue[];
  agentRequirements: InertJsonValue[];
} {
  const portableAuthorities: { id: string; descriptor: AuthorityDescriptor }[] = [];
  for (let index = 0; index < authorities.length; index += 1) {
    const authority = authorities[index] as { id: string; descriptor: AuthorityDescriptor };
    if (authority.descriptor.portableExport === "include") {
      portableAuthorities[portableAuthorities.length] = authority;
    }
  }
  const recordBuckets: unknown[] = [];
  for (let index = 0; index < portableAuthorities.length; index += 1) {
    const authority = portableAuthorities[index] as { id: string; descriptor: AuthorityDescriptor };
    recordBuckets[recordBuckets.length] = reader.readAuthorityRecords(authority.id);
  }
  const inert = createExactInertJsonSnapshot({
    recordBuckets,
    workspaceBindings: reader.readWorkspaceBindings(),
    agentRequirements: reader.readAgentRequirements()
  }, DEFAULT_EXACT_INERT_JSON_LIMITS)?.value;
  if (!isRecord(inert) || !ARRAY_IS_ARRAY(inert.recordBuckets) ||
      !ARRAY_IS_ARRAY(inert.workspaceBindings) || !ARRAY_IS_ARRAY(inert.agentRequirements) ||
      inert.recordBuckets.length !== portableAuthorities.length) fail();

  const semantic: PortableSemantic[] = [];
  for (let bucketIndex = 0; bucketIndex < inert.recordBuckets.length; bucketIndex += 1) {
    const bucket = inert.recordBuckets[bucketIndex];
    const authority = portableAuthorities[bucketIndex];
    if (!ARRAY_IS_ARRAY(bucket) || authority === undefined) fail();
    for (let recordIndex = 0; recordIndex < bucket.length; recordIndex += 1) {
      const record = bucket[recordIndex];
      if (!isRecord(record) || record.authority !== authority.id) fail();
      semantic[semantic.length] = record as unknown as PortableSemantic;
    }
  }
  return {
    semantic,
    workspaceBindings: inert.workspaceBindings,
    agentRequirements: inert.agentRequirements
  };
}

function selectWorkspaceBindings(
  values: InertJsonValue[],
  referenced: ReadonlySet<string>
): WorkspaceBinding[] {
  const result: WorkspaceBinding[] = [];
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index] as InertJsonValue;
    if (!isRecord(value) || typeof value.bindingId !== "string") fail();
    if (setHas(referenced, value.bindingId)) {
      result[result.length] = value as unknown as WorkspaceBinding;
    }
  }
  sortInPlace(result, (left, right) => compareCodeUnits(left.bindingId, right.bindingId));
  return result;
}

function selectAgentRequirements(
  values: InertJsonValue[],
  referenced: ReadonlySet<string>
): AgentRequirement[] {
  const result: AgentRequirement[] = [];
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index] as InertJsonValue;
    if (!isRecord(value) || typeof value.agentId !== "string") fail();
    if (setHas(referenced, value.agentId)) {
      result[result.length] = value as unknown as AgentRequirement;
    }
  }
  sortInPlace(result, (left, right) => compareCodeUnits(left.agentId, right.agentId));
  return result;
}

function sortStringArray(values: unknown, referenced: Set<string>): void {
  if (!ARRAY_IS_ARRAY(values)) fail();
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (typeof value !== "string") fail();
    setAdd(referenced, value);
  }
  sortInPlace(values, compareCodeUnits);
}

function sortReferences(record: PortableSemantic): void {
  if (!ARRAY_IS_ARRAY(record.references)) fail();
  sortInPlace(record.references, (left, right) => compareCodeUnits(
    referenceIdentity(left),
    referenceIdentity(right)
  ));
}

function semanticIdentity(record: PortableSemantic): string {
  if ((record.lifecycle !== "live" && record.lifecycle !== "trash") ||
      typeof record.authority !== "string" || typeof record.key !== "string") fail();
  return `${record.lifecycle}\0${record.authority}\0${record.key}`;
}

function referenceIdentity(value: unknown): string {
  if (!isRecord(value) || (value.lifecycle !== "live" && value.lifecycle !== "trash") ||
      typeof value.authority !== "string" || typeof value.key !== "string") fail();
  return `${value.lifecycle}\0${value.authority}\0${value.key}`;
}

function setHas<T>(values: ReadonlySet<T>, value: T): boolean {
  return REFLECT_APPLY(SET_HAS, values, [value]) as boolean;
}

function setAdd<T>(values: Set<T>, value: T): void {
  REFLECT_APPLY(SET_ADD, values, [value]);
}

function sortInPlace<T>(values: T[], compare: (left: T, right: T) => number): void {
  REFLECT_APPLY(ARRAY_SORT, values, [compare]);
}

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function renderCanonicalJson(value: InertJsonValue, maxBytes: number): string {
  const writer = new BoundedCanonicalJsonWriter(maxBytes);
  writer.writeValue(value);
  writer.writeAscii("\n");
  return writer.finish();
}

class BoundedCanonicalJsonWriter {
  private readonly chunks: string[] = [];
  private current = "";
  private bytes = 0;

  constructor(private readonly maxBytes: number) {}

  writeValue(value: InertJsonValue): void {
    if (value === null) {
      this.writeAscii("null");
    } else if (typeof value === "boolean" || typeof value === "number") {
      this.writeAscii(JSON_STRINGIFY(value) as string);
    } else if (typeof value === "string") {
      this.writeString(value);
    } else if (ARRAY_IS_ARRAY(value)) {
      this.writeAscii("[");
      for (let index = 0; index < value.length; index += 1) {
        if (index > 0) this.writeAscii(",");
        this.writeValue(value[index] as InertJsonValue);
      }
      this.writeAscii("]");
    } else {
      this.writeAscii("{");
      const keys = OBJECT_KEYS(value);
      sortInPlace(keys, compareCodeUnits);
      for (let index = 0; index < keys.length; index += 1) {
        const key = keys[index] as string;
        if (index > 0) this.writeAscii(",");
        this.writeString(key);
        this.writeAscii(":");
        this.writeValue(value[key] as InertJsonValue);
      }
      this.writeAscii("}");
    }
  }

  writeAscii(value: string): void {
    this.append(value, value.length);
  }

  finish(): string {
    this.flush();
    let result = "";
    for (let index = 0; index < this.chunks.length; index += 1) {
      result += this.chunks[index] as string;
    }
    return result;
  }

  private writeString(value: string): void {
    this.writeAscii("\"");
    let start = 0;
    let index = 0;
    while (index < value.length) {
      const code = REFLECT_APPLY(STRING_CHAR_CODE_AT, value, [index]) as number;
      const width = code >= 0xd800 && code <= 0xdbff ? 2 : 1;
      const escape = jsonEscape(code);
      if (escape !== null) {
        if (index > start) this.writeUtf8(stringSlice(value, start, index));
        this.writeAscii(escape);
        index += width;
        start = index;
      } else {
        index += width;
        if (index - start >= CANONICAL_CHUNK_CODE_UNITS) {
          this.writeUtf8(stringSlice(value, start, index));
          start = index;
        }
      }
    }
    if (start < value.length) this.writeUtf8(stringSlice(value, start));
    this.writeAscii("\"");
  }

  private writeUtf8(value: string): void {
    this.append(value, BUFFER_BYTE_LENGTH(value, "utf8"));
  }

  private append(value: string, bytes: number): void {
    if (bytes > this.maxBytes - this.bytes) fail();
    this.bytes += bytes;
    this.current += value;
    if (this.current.length >= CANONICAL_FLUSH_CODE_UNITS) this.flush();
  }

  private flush(): void {
    if (this.current.length === 0) return;
    this.chunks[this.chunks.length] = this.current;
    this.current = "";
  }
}

function jsonEscape(code: number): string | null {
  if (code < 0x20) return CONTROL_JSON_ESCAPES[code] as string;
  if (code === 0x22) return "\\\"";
  return code === 0x5c ? "\\\\" : null;
}

function stringSlice(value: string, start: number, end?: number): string {
  return end === undefined
    ? REFLECT_APPLY(STRING_SLICE, value, [start]) as string
    : REFLECT_APPLY(STRING_SLICE, value, [start, end]) as string;
}

function deepFreezeInertJson(value: InertJsonValue): void {
  if (value === null || typeof value !== "object") return;
  if (ARRAY_IS_ARRAY(value)) {
    for (let index = 0; index < value.length; index += 1) {
      deepFreezeInertJson(value[index] as InertJsonValue);
    }
  } else {
    const keys = OBJECT_KEYS(value);
    for (let index = 0; index < keys.length; index += 1) {
      deepFreezeInertJson(value[keys[index] as string] as InertJsonValue);
    }
  }
  OBJECT_FREEZE(value);
}

function isRecord(value: unknown): value is Record<string, InertJsonValue> {
  return typeof value === "object" && value !== null && !ARRAY_IS_ARRAY(value);
}

function fail(): never {
  throw new Error(PORTABLE_EXPORT_ERROR_MESSAGE);
}
