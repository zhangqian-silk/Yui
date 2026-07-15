import {
  parsePortableSnapshotV3,
  snapshotPortableSnapshotV3,
  type AgentRequirement,
  type PortableSemantic,
  type PortableSnapshotV3,
  type WorkspaceBinding
} from "./portableSchema.js";
import { isAbsolute } from "node:path";
import {
  createExactInertJsonSnapshot,
  hasExactOwnKeys,
  type InertJsonValue
} from "./inertJson.js";

export type PortableImportErrorCode =
  | "INVALID_SNAPSHOT"
  | "INVALID_MAPPING"
  | "REQUIREMENT_MISMATCH"
  | "IMPORT_CONFLICT"
  | "IMPORT_DRIFT"
  | "INVALID_TRANSACTION";

export class PortableImportError extends Error {
  readonly code: PortableImportErrorCode;

  constructor(code: PortableImportErrorCode) {
    super(portableImportErrorMessage(code));
    this.name = "PortableImportError";
    this.code = code;
  }
}

export type PortableSemanticIdentity = Readonly<{
  lifecycle: PortableSemantic["lifecycle"];
  authority: string;
  key: string;
}>;

export type PortableWorkspaceBindingMapping = Readonly<{
  schemaVersion: 1;
  sourceBindingId: string;
} & (
  | { targetBindingId: string; targetWorkspacePath?: never }
  | { targetWorkspacePath: string; targetBindingId?: never }
)>;

export type ResolvedPortableWorkspaceBindingMapping = Readonly<{
  schemaVersion: 1;
  sourceBindingId: string;
  targetBindingId: string;
}>;

export type PortableTargetWorkspaceBindingState = Readonly<{
  descriptor: WorkspaceBinding;
  witness: string;
}>;

export interface PortableImportTargetReader {
  /**
   * Adapters with host-local workspace knowledge may turn direct absolute
   * workspace paths into private, transaction-scoped binding IDs. The
   * normalized IDs must be readable by `readWorkspaceBinding` for the life of
   * this target and are never written into a portable manifest.
   */
  resolveWorkspaceMappings?(
    sourceBindings: readonly WorkspaceBinding[],
    mappings: readonly PortableWorkspaceBindingMapping[]
  ): readonly ResolvedPortableWorkspaceBindingMapping[];
  readWorkspaceBinding(bindingId: string): PortableTargetWorkspaceBindingState | null;
  readAgentRequirement(agentId: string): AgentRequirement | null;
  readSemantic(identity: PortableSemanticIdentity): PortableSemantic | null;
}

/**
 * A synchronous capability that is valid only inside the caller's active transaction.
 * `applySemanticBatch` receives the fully validated snapshot plus its semantic create subset.
 * It must stage all host-local and semantic effects atomically, and subsequent reads must observe
 * the staged semantic batch. The caller must roll back every staged mutation when apply throws,
 * and may publish the transaction only after apply returns successfully.
 */
export interface PortableImportTransactionTarget extends PortableImportTargetReader {
  applySemanticBatch(
    records: readonly PortableSemantic[],
    creates: readonly PortableSemantic[]
  ): void;
}

export type PortableImportPlanEntry = Readonly<PortableSemanticIdentity & {
  action: "create" | "no-op" | "conflict";
}>;

export type PortableImportPlan = Readonly<{
  schemaVersion: 1;
  entries: readonly PortableImportPlanEntry[];
}>;

export type PortableImportApplyResult = Readonly<{
  schemaVersion: 1;
  created: number;
  noOp: number;
}>;

type PreparedPortableImport = Readonly<{
  snapshot: PortableSnapshotV3;
  workspaceWitnesses: readonly Readonly<{ bindingId: string; witness: string }>[];
}>;

const PREPARED_IMPORTS = new WeakMap<PortableImportPlan, PreparedPortableImport>();

export function planPortableImport(
  raw: string,
  mappings: readonly PortableWorkspaceBindingMapping[],
  target: PortableImportTargetReader,
  options: { maxBytes?: number } = {}
): PortableImportPlan {
  let source: PortableSnapshotV3 | null;
  try {
    source = parsePortableSnapshotV3(raw, options);
  } catch {
    throw portableImportError("INVALID_SNAPSHOT");
  }
  if (source === null) {
    throw portableImportError("INVALID_SNAPSHOT");
  }

  const sourceWorkspaceIds = source.workspaceBindings.map((binding) => binding.bindingId);
  const requestedMappings = validateRequestedMappings(mappings, sourceWorkspaceIds);
  const mappingBySource = validateResolvedMappings(
    resolveWorkspaceMappings(source.workspaceBindings, requestedMappings, target),
    sourceWorkspaceIds
  );
  const sourceBindings = new Map(source.workspaceBindings.map((binding) => [binding.bindingId, binding]));
  const targetBindings = new Map<string, WorkspaceBinding>();
  const workspaceWitnesses: Array<Readonly<{ bindingId: string; witness: string }>> = [];
  for (const sourceBindingId of sourceWorkspaceIds) {
    const mapping = mappingBySource.get(sourceBindingId) as ResolvedPortableWorkspaceBindingMapping;
    const targetStateValue = readPlanningTarget(() => target.readWorkspaceBinding(mapping.targetBindingId));
    if (targetStateValue === null) {
      throw portableImportError("REQUIREMENT_MISMATCH");
    }
    const targetState = snapshotWorkspaceBindingState(targetStateValue);
    const sourceBinding = sourceBindings.get(sourceBindingId);
    if (targetState === null || sourceBinding === undefined ||
        targetState.descriptor.bindingId !== mapping.targetBindingId ||
        targetState.descriptor.kind !== sourceBinding.kind) {
      throw portableImportError("INVALID_MAPPING");
    }
    const targetBinding = targetState.descriptor;
    targetBindings.set(mapping.targetBindingId, targetBinding);
    workspaceWitnesses.push(Object.freeze({
      bindingId: mapping.targetBindingId,
      witness: targetState.witness
    }));
  }

  const agentRequirements: AgentRequirement[] = [];
  for (const expected of source.agentRequirements) {
    const actualValue = readPlanningTarget(() => target.readAgentRequirement(expected.agentId));
    const actual = actualValue === null ? null : snapshotAgentRequirement(actualValue);
    if (actual === null || !sameCanonicalContent(actual, expected)) {
      throw portableImportError("REQUIREMENT_MISMATCH");
    }
    agentRequirements.push(expected);
  }

  const remapped = snapshotPortableSnapshotV3({
    schemaVersion: source.schemaVersion,
    exportedAt: source.exportedAt,
    workspaceBindings: [...targetBindings.values()].sort((left, right) =>
      compareCodeUnit(left.bindingId, right.bindingId)),
    agentRequirements,
    semantic: source.semantic.map((record) => ({
      ...record,
      workspaceBindingIds: record.workspaceBindingIds
        .map((sourceBindingId) => (mappingBySource.get(sourceBindingId) as
          ResolvedPortableWorkspaceBindingMapping).targetBindingId)
        .sort(compareCodeUnit)
    }))
  });
  if (remapped === null) {
    throw portableImportError("INVALID_MAPPING");
  }

  const entries = remapped.semantic.map((record): PortableImportPlanEntry => {
    const identity = semanticIdentity(record);
    const existing = readPlanningTarget(() => target.readSemantic(identity));
    return Object.freeze({
      ...identity,
      action: existing === null
        ? "create"
        : sameCanonicalContent(existing, record) ? "no-op" : "conflict"
    });
  });
  const plan = Object.freeze({
    schemaVersion: 1 as const,
    entries: Object.freeze(entries)
  });
  workspaceWitnesses.sort((left, right) => compareCodeUnit(left.bindingId, right.bindingId));
  PREPARED_IMPORTS.set(plan, Object.freeze({
    snapshot: deepFreeze(remapped),
    workspaceWitnesses: deepFreeze(workspaceWitnesses)
  }));
  return plan;
}

export function applyPortableImportPlanInTransaction(
  plan: PortableImportPlan,
  target: PortableImportTransactionTarget
): PortableImportApplyResult {
  const provenance = new WeakSet<object>();
  const fail: PortableImportErrorFactory = (code) => portableImportError(code, provenance);
  try {
    return applyInsideTransaction(plan, target, fail);
  } catch (error) {
    if (isCurrentApplyError(error, provenance)) throw error;
    throw fail("INVALID_TRANSACTION");
  }
}

type PortableImportErrorFactory = (code: PortableImportErrorCode) => PortableImportError;

function applyInsideTransaction(
  plan: PortableImportPlan,
  target: PortableImportTransactionTarget,
  fail: PortableImportErrorFactory
): PortableImportApplyResult {
  const prepared = PREPARED_IMPORTS.get(plan);
  if (prepared === undefined) {
    throw fail("INVALID_TRANSACTION");
  }

  const invalidRequirement = !requirementsMatch(prepared, target);

  const creates: PortableSemantic[] = [];
  let noOp = 0;
  let conflict = false;
  let drift = false;
  for (let index = 0; index < prepared.snapshot.semantic.length; index += 1) {
    const record = prepared.snapshot.semantic[index] as PortableSemantic;
    const entry = plan.entries[index] as PortableImportPlanEntry;
    const actual = target.readSemantic(semanticIdentity(record));
    if (entry.action === "conflict") {
      conflict = true;
    } else if (entry.action === "create") {
      if (actual === null) creates.push(record);
      else if (sameCanonicalContent(actual, record)) noOp += 1;
      else conflict = true;
    } else if (actual !== null && sameCanonicalContent(actual, record)) {
      noOp += 1;
    } else {
      drift = true;
    }
  }

  if (invalidRequirement || drift) throw fail("IMPORT_DRIFT");
  if (conflict) throw fail("IMPORT_CONFLICT");
  target.applySemanticBatch(
    Object.freeze([...prepared.snapshot.semantic]),
    Object.freeze([...creates])
  );
  const requirementsStillMatch = requirementsMatch(prepared, target);
  const semanticsStillMatch = allSemanticRecordsMatch(prepared.snapshot.semantic, target);
  if (!requirementsStillMatch || !semanticsStillMatch) {
    throw fail("IMPORT_DRIFT");
  }
  return Object.freeze({ schemaVersion: 1 as const, created: creates.length, noOp });
}

function requirementsMatch(
  prepared: PreparedPortableImport,
  target: PortableImportTargetReader
): boolean {
  try {
    let matches = true;
    for (let index = 0; index < prepared.snapshot.workspaceBindings.length; index += 1) {
      const expected = prepared.snapshot.workspaceBindings[index] as WorkspaceBinding;
      const expectedWitness = prepared.workspaceWitnesses[index];
      const actualValue = target.readWorkspaceBinding(expected.bindingId);
      const actual = actualValue === null ? null : snapshotWorkspaceBindingState(actualValue);
      if (expectedWitness === undefined || actual === null || actual.witness !== expectedWitness.witness ||
          !sameCanonicalContent(actual.descriptor, expected)) matches = false;
    }
    for (const expected of prepared.snapshot.agentRequirements) {
      const actual = target.readAgentRequirement(expected.agentId);
      if (actual === null || !sameCanonicalContent(actual, expected)) matches = false;
    }
    return matches;
  } catch {
    return false;
  }
}

function allSemanticRecordsMatch(
  records: readonly PortableSemantic[],
  target: PortableImportTargetReader
): boolean {
  try {
    let matches = true;
    for (const record of records) {
      const actual = target.readSemantic(semanticIdentity(record));
      if (actual === null || !sameCanonicalContent(actual, record)) matches = false;
    }
    return matches;
  } catch {
    return false;
  }
}

function validateRequestedMappings(
  value: unknown,
  declaredSourceBindingIds: readonly string[]
): readonly PortableWorkspaceBindingMapping[] {
  const inert = createExactInertJsonSnapshot(value)?.value;
  if (!Array.isArray(inert) || inert.length !== declaredSourceBindingIds.length) {
    throw portableImportError("INVALID_MAPPING");
  }
  const declared = new Set(declaredSourceBindingIds);
  const sourceIds = new Set<string>();
  const mappings: PortableWorkspaceBindingMapping[] = [];
  for (const candidate of inert) {
    const mapping = snapshotRequestedMapping(candidate);
    if (mapping === null || !declared.has(mapping.sourceBindingId) ||
        sourceIds.has(mapping.sourceBindingId)) {
      throw portableImportError("INVALID_MAPPING");
    }
    sourceIds.add(mapping.sourceBindingId);
    mappings.push(mapping);
  }
  return Object.freeze(mappings);
}

function resolveWorkspaceMappings(
  sourceBindings: readonly WorkspaceBinding[],
  mappings: readonly PortableWorkspaceBindingMapping[],
  target: PortableImportTargetReader
): readonly ResolvedPortableWorkspaceBindingMapping[] {
  try {
    if (target.resolveWorkspaceMappings !== undefined) {
      return target.resolveWorkspaceMappings(sourceBindings, mappings);
    }
    const resolved: ResolvedPortableWorkspaceBindingMapping[] = [];
    for (const mapping of mappings) {
      if (!hasTargetBindingId(mapping)) throw portableImportError("INVALID_MAPPING");
      resolved.push(Object.freeze({
        schemaVersion: 1,
        sourceBindingId: mapping.sourceBindingId,
        targetBindingId: mapping.targetBindingId
      }));
    }
    return Object.freeze(resolved);
  } catch (error) {
    if (error instanceof PortableImportError) throw error;
    throw portableImportError("REQUIREMENT_MISMATCH");
  }
}

function validateResolvedMappings(
  value: unknown,
  declaredSourceBindingIds: readonly string[]
): Map<string, ResolvedPortableWorkspaceBindingMapping> {
  const inert = createExactInertJsonSnapshot(value)?.value;
  if (!Array.isArray(inert) || inert.length !== declaredSourceBindingIds.length) {
    throw portableImportError("INVALID_MAPPING");
  }
  const declared = new Set(declaredSourceBindingIds);
  const sourceIds = new Set<string>();
  const targetIds = new Set<string>();
  const mappings = new Map<string, ResolvedPortableWorkspaceBindingMapping>();
  for (const candidate of inert) {
    if (!isRecord(candidate) || !hasExactOwnKeys(candidate, [
      "schemaVersion", "sourceBindingId", "targetBindingId"
    ]) || candidate.schemaVersion !== 1 || !isCanonicalBindingId(candidate.sourceBindingId) ||
        !isCanonicalBindingId(candidate.targetBindingId) || !declared.has(candidate.sourceBindingId) ||
        sourceIds.has(candidate.sourceBindingId) || targetIds.has(candidate.targetBindingId)) {
      throw portableImportError("INVALID_MAPPING");
    }
    const mapping = Object.freeze({
      schemaVersion: 1 as const,
      sourceBindingId: candidate.sourceBindingId,
      targetBindingId: candidate.targetBindingId
    });
    sourceIds.add(mapping.sourceBindingId);
    targetIds.add(mapping.targetBindingId);
    mappings.set(mapping.sourceBindingId, mapping);
  }
  return mappings;
}

function snapshotRequestedMapping(value: unknown): PortableWorkspaceBindingMapping | null {
  const inert = createExactInertJsonSnapshot(value)?.value;
  if (!isRecord(inert) || inert.schemaVersion !== 1 ||
      !isCanonicalBindingId(inert.sourceBindingId)) {
    return null;
  }
  if (hasExactOwnKeys(inert, ["schemaVersion", "sourceBindingId", "targetBindingId"]) &&
      isCanonicalBindingId(inert.targetBindingId)) {
    return Object.freeze({
      schemaVersion: 1,
      sourceBindingId: inert.sourceBindingId,
      targetBindingId: inert.targetBindingId
    });
  }
  if (hasExactOwnKeys(inert, ["schemaVersion", "sourceBindingId", "targetWorkspacePath"]) &&
      isAbsoluteWorkspacePath(inert.targetWorkspacePath)) {
    return Object.freeze({
      schemaVersion: 1,
      sourceBindingId: inert.sourceBindingId,
      targetWorkspacePath: inert.targetWorkspacePath
    });
  }
  return null;
}

function hasTargetBindingId(
  value: PortableWorkspaceBindingMapping
): value is Readonly<{
  schemaVersion: 1;
  sourceBindingId: string;
  targetBindingId: string;
  targetWorkspacePath?: never;
}> {
  return typeof value.targetBindingId === "string";
}

function isAbsoluteWorkspacePath(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 512 &&
    !value.includes("\u0000") && isAbsolute(value);
}

function snapshotWorkspaceBinding(value: unknown): WorkspaceBinding | null {
  return snapshotPortableSnapshotV3({
    schemaVersion: 3,
    exportedAt: "1970-01-01T00:00:00.000Z",
    workspaceBindings: [value],
    agentRequirements: [],
    semantic: []
  })?.workspaceBindings[0] ?? null;
}

function snapshotWorkspaceBindingState(value: unknown): PortableTargetWorkspaceBindingState | null {
  const inert = createExactInertJsonSnapshot(value)?.value;
  if (!isRecord(inert) || !hasExactOwnKeys(inert, ["descriptor", "witness"]) ||
      typeof inert.witness !== "string" || inert.witness.length === 0 || inert.witness.length > 1024) {
    return null;
  }
  const descriptor = snapshotWorkspaceBinding(inert.descriptor);
  return descriptor === null ? null : Object.freeze({ descriptor, witness: inert.witness });
}

function snapshotAgentRequirement(value: unknown): AgentRequirement | null {
  return snapshotPortableSnapshotV3({
    schemaVersion: 3,
    exportedAt: "1970-01-01T00:00:00.000Z",
    workspaceBindings: [],
    agentRequirements: [value],
    semantic: []
  })?.agentRequirements[0] ?? null;
}

function semanticIdentity(record: PortableSemantic): PortableSemanticIdentity {
  return Object.freeze({
    lifecycle: record.lifecycle,
    authority: record.authority,
    key: record.key
  });
}

function compareCodeUnit(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function sameCanonicalContent(left: unknown, right: unknown): boolean {
  const leftValue = createExactInertJsonSnapshot(left)?.value;
  const rightValue = createExactInertJsonSnapshot(right)?.value;
  return leftValue !== undefined && rightValue !== undefined &&
    JSON.stringify(canonicalize(leftValue)) === JSON.stringify(canonicalize(rightValue));
}

function canonicalize(value: InertJsonValue): InertJsonValue {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value === null || typeof value !== "object") return value;
  const result: Record<string, InertJsonValue> = Object.create(null);
  for (const key of Object.keys(value).sort(compareCodeUnit)) {
    result[key] = canonicalize(value[key] as InertJsonValue);
  }
  return result;
}

function isCanonicalBindingId(value: unknown): value is string {
  return typeof value === "string" && value.length <= 64 &&
    /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readPlanningTarget<T>(read: () => T): T {
  try {
    return read();
  } catch {
    throw portableImportError("REQUIREMENT_MISMATCH");
  }
}

function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== "object" || Object.isFrozen(value)) return value;
  const record = value as Record<string, unknown>;
  for (const key of Object.keys(record)) deepFreeze(record[key]);
  return Object.freeze(value);
}

function portableImportError(
  code: PortableImportErrorCode,
  provenance?: WeakSet<object>
): PortableImportError {
  const error = new PortableImportError(code);
  provenance?.add(error);
  return Object.freeze(error);
}

function isCurrentApplyError(
  value: unknown,
  provenance: WeakSet<object>
): value is PortableImportError {
  return typeof value === "object" && value !== null && provenance.has(value);
}

function portableImportErrorMessage(code: PortableImportErrorCode): string {
  switch (code) {
    case "INVALID_SNAPSHOT": return "Portable import snapshot is invalid.";
    case "INVALID_MAPPING": return "Portable workspace mapping is invalid.";
    case "REQUIREMENT_MISMATCH": return "Portable import requirements are unavailable.";
    case "IMPORT_CONFLICT": return "Portable import conflicts with target state.";
    case "IMPORT_DRIFT": return "Portable import target changed before apply.";
    case "INVALID_TRANSACTION": return "Portable import transaction is invalid.";
  }
}
