import {
  createExactInertJsonSnapshot,
  hasExactOwnKeys,
  type InertJsonValue
} from "./inertJson.js";
import {
  decodePortableSemanticPayload,
  type PortableLifecycle,
  type PortablePayloadMetadata,
  type PortableReferenceRequirement,
  type PortableReferenceTarget
} from "./portableSemanticPayload.js";
import { BUILTIN_TOPICS } from "../topic/topic.js";

export const PORTABLE_SNAPSHOT_SCHEMA_VERSION = 3 as const;
export const MAX_PORTABLE_SNAPSHOT_BYTES = 8 * 1024 * 1024;

export type AuthorityPortability = "portable" | "host-bound" | "ephemeral" | "derived";
export type AuthorityKeyShape = "singleton" | "entity" | "task" | "task-entity";
export type AuthorityReferenceCardinality = "none" | "any" | "one" | "one-or-more";
export type AuthorityLifecyclePolicy = "live-only" | "task-lifecycle";

export type AuthorityDescriptor = Readonly<{
  id: string;
  portability: AuthorityPortability;
  portableExport: "include" | "exclude";
  backup: "include" | "exclude";
  keyShape: AuthorityKeyShape;
  singletonKey?: string;
  taskScoped: boolean;
  lifecycle: AuthorityLifecyclePolicy;
  workspaceReferences: AuthorityReferenceCardinality;
  agentReferences: AuthorityReferenceCardinality;
}>;

function authority(
  id: string,
  portability: AuthorityPortability,
  keyShape: AuthorityKeyShape,
  options: {
    backup?: "include" | "exclude";
    singletonKey?: string;
    taskScoped?: boolean;
    lifecycle?: AuthorityLifecyclePolicy;
    workspaceReferences?: AuthorityReferenceCardinality;
    agentReferences?: AuthorityReferenceCardinality;
  } = {}
): AuthorityDescriptor {
  return Object.freeze({
    id,
    portability,
    portableExport: portability === "portable" ? "include" : "exclude",
    backup: options.backup ?? (portability === "portable" || portability === "host-bound" ? "include" : "exclude"),
    keyShape,
    ...(options.singletonKey === undefined ? {} : { singletonKey: options.singletonKey }),
    taskScoped: options.taskScoped ?? false,
    lifecycle: options.lifecycle ?? "live-only",
    workspaceReferences: options.workspaceReferences ?? "none",
    agentReferences: options.agentReferences ?? "none"
  });
}

export const AUTHORITY_REGISTRY: readonly AuthorityDescriptor[] = Object.freeze([
  authority("config", "portable", "singleton", {
    singletonKey: "config",
    agentReferences: "any"
  }),
  authority("global-role", "portable", "entity", {
    workspaceReferences: "one",
    agentReferences: "one-or-more"
  }),
  authority("task", "portable", "task", { lifecycle: "task-lifecycle" }),
  authority("task-topics", "portable", "task", { taskScoped: true, lifecycle: "task-lifecycle" }),
  authority("task-input-draft", "portable", "task", { taskScoped: true, lifecycle: "task-lifecycle" }),
  authority("input-request-history", "portable", "task-entity", {
    taskScoped: true,
    lifecycle: "task-lifecycle",
    agentReferences: "one"
  }),
  authority("input-resolution", "portable", "task-entity", { taskScoped: true, lifecycle: "task-lifecycle" }),
  authority("task-schedule", "portable", "task", { taskScoped: true, lifecycle: "task-lifecycle" }),
  authority("cycle", "portable", "task-entity", { taskScoped: true, lifecycle: "task-lifecycle" }),
  authority("work-item", "portable", "task-entity", { taskScoped: true, lifecycle: "task-lifecycle" }),
  authority("task-role", "portable", "task-entity", {
    taskScoped: true,
    lifecycle: "task-lifecycle",
    workspaceReferences: "one",
    agentReferences: "one-or-more"
  }),
  authority("child-role", "portable", "task-entity", { taskScoped: true, lifecycle: "task-lifecycle" }),
  authority("agent-run-history", "portable", "task-entity", { taskScoped: true, lifecycle: "task-lifecycle" }),
  authority("task-brief", "portable", "task", { taskScoped: true, lifecycle: "task-lifecycle" }),
  authority("task-topic-summary", "portable", "task", { taskScoped: true, lifecycle: "task-lifecycle" }),
  authority("task-timeline", "portable", "task", { taskScoped: true, lifecycle: "task-lifecycle" }),
  authority("milestone", "portable", "task-entity", { taskScoped: true, lifecycle: "task-lifecycle" }),
  authority("decision", "portable", "task-entity", { taskScoped: true, lifecycle: "task-lifecycle" }),
  authority("comment", "portable", "task-entity", { taskScoped: true, lifecycle: "task-lifecycle" }),
  authority("event", "portable", "task-entity", { taskScoped: true, lifecycle: "task-lifecycle" }),
  authority("transcript", "portable", "task-entity", { taskScoped: true, lifecycle: "task-lifecycle" }),
  authority("configured-skill", "portable", "entity"),

  // The physical config mixes portable pointers with target-host paths. It must be transformed,
  // never copied into a logical export as-is.
  authority("config-storage", "host-bound", "singleton", { singletonKey: "config" }),
  authority("storage-manifest", "host-bound", "singleton", { singletonKey: "schema" }),
  authority("configured-agent", "host-bound", "entity"),
  authority("completion-installation", "host-bound", "entity"),
  authority("role-session-set", "host-bound", "entity"),
  authority("native-session-identity-ledger", "host-bound", "singleton", {
    singletonKey: "native-session-identities"
  }),
  authority("role-worktree", "host-bound", "task-entity", { taskScoped: true }),
  authority("host-workspace", "host-bound", "entity", { backup: "exclude" }),
  authority("backup-manifest", "host-bound", "entity", { backup: "exclude" }),

  authority("pending-wakeup", "ephemeral", "task"),
  authority("input-request", "ephemeral", "task-entity"),
  authority("leader-failure", "ephemeral", "task"),
  authority("operator-notification", "ephemeral", "task-entity"),
  authority("active-agent-run", "ephemeral", "task-entity"),
  authority("role-runtime-operation", "ephemeral", "task-entity"),
  authority("rpc-intent", "ephemeral", "entity"),
  authority("rpc-result", "ephemeral", "entity"),
  authority("rpc-tombstone", "ephemeral", "entity"),
  authority("controller-discovery", "ephemeral", "singleton", { singletonKey: "controller" }),
  authority("controller-lock", "ephemeral", "singleton", { singletonKey: "controller-lock" }),
  authority("controller-socket", "ephemeral", "singleton", { singletonKey: "controller-socket" }),
  authority("domain-transaction", "ephemeral", "entity"),
  authority("domain-workspace", "ephemeral", "entity"),
  authority("backup-staging", "ephemeral", "entity"),

  authority("derived-index", "derived", "singleton", { singletonKey: "index" }),
  authority("controller-log", "derived", "singleton", { singletonKey: "controller-log" }),
  authority("operator-context", "derived", "singleton", { singletonKey: "operator-context" }),
  authority("rendered-cache", "derived", "entity")
]);

const AUTHORITY_BY_ID = new Map(AUTHORITY_REGISTRY.map((entry) => [entry.id, entry]));
const BUILTIN_TOPIC_IDS = new Set(BUILTIN_TOPICS.map((topic) => topic.id));

export function getAuthorityDescriptor(id: string): AuthorityDescriptor | null {
  return AUTHORITY_BY_ID.get(id) ?? null;
}

export type WorkspaceBinding = {
  schemaVersion: 1;
  bindingId: string;
  kind: "default" | "repository" | "named";
  relativeSubpath: string;
  label: string;
};

export type AgentRequirement = {
  schemaVersion: 1;
  agentId: string;
  adapterId: string;
};

export type PortableSemanticReference = {
  lifecycle: PortableLifecycle;
  authority: string;
  key: string;
};

export type PortableSemantic = {
  schemaVersion: 1;
  lifecycle: PortableLifecycle;
  authority: string;
  key: string;
  payload: InertJsonValue;
  workspaceBindingIds: string[];
  agentRequirementIds: string[];
  references: PortableSemanticReference[];
};

export type PortableSnapshotV3 = {
  schemaVersion: typeof PORTABLE_SNAPSHOT_SCHEMA_VERSION;
  exportedAt: string;
  workspaceBindings: WorkspaceBinding[];
  agentRequirements: AgentRequirement[];
  semantic: PortableSemantic[];
};

export function snapshotPortableSnapshotV3(value: unknown): PortableSnapshotV3 | null {
  // This is deliberately the only hostile-object traversal. Every later check and the returned
  // value use this detached, descriptor-safe snapshot.
  const inert = createExactInertJsonSnapshot(value)?.value;
  if (!isRecord(inert) || !hasExactOwnKeys(inert, [
    "schemaVersion", "exportedAt", "workspaceBindings", "agentRequirements", "semantic"
  ]) || inert.schemaVersion !== PORTABLE_SNAPSHOT_SCHEMA_VERSION ||
      !isCanonicalInstant(inert.exportedAt) || !Array.isArray(inert.workspaceBindings) ||
      !Array.isArray(inert.agentRequirements) || !Array.isArray(inert.semantic)) {
    return null;
  }

  const workspaceBindings = inert.workspaceBindings;
  const agentRequirements = inert.agentRequirements;
  const semantic = inert.semantic;
  if (!validateWorkspaceBindings(workspaceBindings) ||
      !validateAgentRequirements(agentRequirements) ||
      !validateSemanticRecords(semantic, workspaceBindings, agentRequirements)) {
    return null;
  }
  return inert as unknown as PortableSnapshotV3;
}

export function isPortableSnapshotV3(value: unknown): value is PortableSnapshotV3 {
  return snapshotPortableSnapshotV3(value) !== null;
}

export function parsePortableSnapshotV3(
  raw: string,
  options: { maxBytes?: number } = {}
): PortableSnapshotV3 | null {
  const maxBytes = options.maxBytes ?? MAX_PORTABLE_SNAPSHOT_BYTES;
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0 || maxBytes > MAX_PORTABLE_SNAPSHOT_BYTES ||
      Buffer.byteLength(raw, "utf8") > maxBytes) return null;
  try {
    return snapshotPortableSnapshotV3(JSON.parse(raw) as unknown);
  } catch {
    return null;
  }
}

function validateWorkspaceBindings(values: InertJsonValue[]): boolean {
  const ids = new Set<string>();
  let defaultCount = 0;
  let previousId: string | null = null;
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (!isRecord(value) || !hasExactOwnKeys(value, [
      "schemaVersion", "bindingId", "kind", "relativeSubpath", "label"
    ]) || value.schemaVersion !== 1 || !isCanonicalBindingId(value.bindingId) ||
        (value.kind !== "default" && value.kind !== "repository" && value.kind !== "named") ||
        !isPortableRelativeSubpath(value.relativeSubpath) || !isSafeLabel(value.label)) {
      return false;
    }
    if (value.kind === "default") {
      defaultCount += 1;
      if (value.bindingId !== "default") return false;
    } else if (value.bindingId === "default") {
      return false;
    }
    if (ids.has(value.bindingId) || (previousId !== null && compareCanonical(previousId, value.bindingId) >= 0)) {
      return false;
    }
    ids.add(value.bindingId);
    previousId = value.bindingId;
  }
  return defaultCount <= 1;
}

function validateAgentRequirements(values: InertJsonValue[]): boolean {
  const ids = new Set<string>();
  let previousId: string | null = null;
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (!isRecord(value) || !hasExactOwnKeys(value, ["schemaVersion", "agentId", "adapterId"]) ||
        value.schemaVersion !== 1 || !isCanonicalEntityId(value.agentId) ||
        !isCanonicalAdapterId(value.adapterId) || ids.has(value.agentId) ||
        (previousId !== null && compareCanonical(previousId, value.agentId) >= 0)) {
      return false;
    }
    ids.add(value.agentId);
    previousId = value.agentId;
  }
  return true;
}

function validateSemanticRecords(
  values: InertJsonValue[],
  workspaceBindings: InertJsonValue[],
  agentRequirements: InertJsonValue[]
): boolean {
  const workspaceIds = new Set(workspaceBindings.map((value) => (value as Record<string, InertJsonValue>).bindingId as string));
  const agentIds = new Set(agentRequirements.map((value) => (value as Record<string, InertJsonValue>).agentId as string));
  const identities = new Set<string>();
  const taskRoleNames = new Set<string>();
  const taskLifecycles = new Map<string, PortableLifecycle>();
  const metadata = new Map<string, PortablePayloadMetadata>();
  const declaredAgents = new Map(agentRequirements.map((value) => {
    const record = value as Record<string, InertJsonValue>;
    return [record.agentId as string, record.adapterId as string];
  }));
  let previousIdentity: string | null = null;

  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (!isRecord(value) || !hasExactOwnKeys(value, [
      "schemaVersion", "lifecycle", "authority", "key", "payload", "workspaceBindingIds",
      "agentRequirementIds", "references"
    ]) || value.schemaVersion !== 1 || (value.lifecycle !== "live" && value.lifecycle !== "trash") ||
        typeof value.authority !== "string" || typeof value.key !== "string" ||
        !Array.isArray(value.workspaceBindingIds) || !Array.isArray(value.agentRequirementIds) ||
        !Array.isArray(value.references)) {
      return false;
    }
    const descriptor = getAuthorityDescriptor(value.authority);
    if (descriptor === null || descriptor.portableExport !== "include" ||
        !isCanonicalAuthorityKey(descriptor, value.key) ||
        (descriptor.lifecycle === "live-only" && value.lifecycle !== "live") ||
        !validateReferenceIds(value.workspaceBindingIds, workspaceIds, descriptor.workspaceReferences) ||
        !validateReferenceIds(value.agentRequirementIds, agentIds, descriptor.agentReferences) ||
        !validateSemanticReferences(value.references)) {
      return false;
    }
    if (descriptor.lifecycle === "task-lifecycle") {
      const taskId = descriptor.keyShape === "task"
        ? value.key
        : value.key.split("/", 1)[0] as string;
      const previousLifecycle = taskLifecycles.get(taskId);
      if (previousLifecycle !== undefined && previousLifecycle !== value.lifecycle) return false;
      taskLifecycles.set(taskId, value.lifecycle);
    }
    const payloadMetadata = decodePortableSemanticPayload(
      value.authority,
      value.key,
      value.lifecycle,
      value.payload
    );
    if (payloadMetadata === null || !validatePayloadAgentRequirements(
      value.agentRequirementIds,
      payloadMetadata,
      declaredAgents
    )) return false;
    const identity = semanticIdentity(value.lifecycle, value.authority, value.key);
    if (value.authority === "task-role" || value.authority === "child-role") {
      const roleNameIdentity = `${value.lifecycle}\0${value.key}`;
      if (taskRoleNames.has(roleNameIdentity)) return false;
      taskRoleNames.add(roleNameIdentity);
    }
    if (identities.has(identity) ||
        (previousIdentity !== null && compareCanonical(previousIdentity, identity) >= 0)) {
      return false;
    }
    identities.add(identity);
    metadata.set(identity, payloadMetadata);
    previousIdentity = identity;
  }

  for (let index = 0; index < values.length; index += 1) {
    const value = values[index] as Record<string, InertJsonValue>;
    const descriptor = getAuthorityDescriptor(value.authority as string) as AuthorityDescriptor;
    const key = value.key as string;
    const lifecycle = value.lifecycle as PortableLifecycle;
    const references = value.references as InertJsonValue[];
    for (let referenceIndex = 0; referenceIndex < references.length; referenceIndex += 1) {
      const reference = references[referenceIndex] as Record<string, InertJsonValue>;
      if (!identities.has(semanticIdentity(
        reference.lifecycle as PortableLifecycle,
        reference.authority as string,
        reference.key as string
      ))) return false;
    }
    const requirements = [...(metadata.get(semanticIdentity(lifecycle, value.authority as string, key))
      ?.referenceRequirements ?? [])];
    if (descriptor.taskScoped) {
      const taskId = key.split("/", 1)[0] as string;
      requirements.push({ anyOf: [{ lifecycle, authority: "task", key: taskId }] });
    }
    const payloadMetadata = metadata.get(semanticIdentity(lifecycle, value.authority as string, key));
    if (payloadMetadata === undefined || !validateRequiredReferences(
      references,
      requirements,
      optionalPayloadReferenceTargets(lifecycle, payloadMetadata, metadata)
    ) || !validatePayloadRelationships(lifecycle, key, payloadMetadata, metadata, references)) return false;
  }
  return true;
}

function validatePayloadRelationships(
  lifecycle: PortableLifecycle,
  key: string,
  current: PortablePayloadMetadata,
  metadata: ReadonlyMap<string, PortablePayloadMetadata>,
  references: readonly InertJsonValue[]
): boolean {
  const pair = current.inputPair;
  if (pair !== undefined && !validateInputPair(lifecycle, key, pair, metadata)) return false;
  const requester = current.inputRequester;
  if (requester !== undefined) {
    const role = metadata.get(semanticIdentity(lifecycle, "task-role", requester.roleKey));
    const run = metadata.get(semanticIdentity(lifecycle, "agent-run-history", requester.agentRunKey));
    const compatibleRun = run?.agentRunRoleName === requester.roleName;
    const hasRunReference = hasSemanticReference(references, {
      lifecycle,
      authority: "agent-run-history",
      key: requester.agentRunKey
    });
    if (role === undefined || !role.agentRequirements.some((requirement) =>
      requirement.agentId === requester.agentId && requirement.adapterId === requester.adapterId) ||
        compatibleRun !== hasRunReference) return false;
  }
  const runWorkItem = current.agentRunWorkItem;
  if (runWorkItem !== undefined) {
    const workItem = metadata.get(semanticIdentity(lifecycle, "work-item", runWorkItem.workItemKey));
    if (workItem?.workItemAssignee !== runWorkItem.roleName) return false;
  }
  const topicScope = current.topicScope;
  if (topicScope !== undefined) {
    const declared = metadata.get(semanticIdentity(
      topicScope.lifecycle,
      "task-topics",
      topicScope.taskId
    ))?.declaredTopicIds ?? [];
    if (topicScope.topicIds.some((topicId) =>
      !BUILTIN_TOPIC_IDS.has(topicId) && !declared.includes(topicId))) return false;
  }
  return true;
}

function optionalPayloadReferenceTargets(
  lifecycle: PortableLifecycle,
  current: PortablePayloadMetadata,
  metadata: ReadonlyMap<string, PortablePayloadMetadata>
): PortableReferenceTarget[] {
  const requester = current.inputRequester;
  if (requester === undefined) return [];
  const run = metadata.get(semanticIdentity(lifecycle, "agent-run-history", requester.agentRunKey));
  return run?.agentRunRoleName === requester.roleName
    ? [{ lifecycle, authority: "agent-run-history", key: requester.agentRunKey }]
    : [];
}

function hasSemanticReference(
  values: readonly InertJsonValue[],
  target: PortableReferenceTarget
): boolean {
  for (const value of values) {
    if (!isRecord(value)) continue;
    if (value.lifecycle === target.lifecycle &&
        value.authority === target.authority &&
        value.key === target.key) return true;
  }
  return false;
}

function validateInputPair(
  lifecycle: PortableLifecycle,
  key: string,
  pair: NonNullable<PortablePayloadMetadata["inputPair"]>,
  metadata: ReadonlyMap<string, PortablePayloadMetadata>
): boolean {
  if (pair.kind === "request") {
    const resolution = metadata.get(semanticIdentity(lifecycle, "input-resolution", pair.resolutionKey))?.inputPair;
    if (resolution === undefined || resolution.kind !== "resolution" || resolution.requestKey !== key ||
        resolution.resolvedAt !== pair.updatedAt ||
        (resolution.answerChoiceKey !== undefined && !pair.choiceKeys.includes(resolution.answerChoiceKey))) return false;
    if (pair.status === "answered") {
      return resolution.source === "user" && resolution.recommendationReason === undefined;
    }
    const recommendation = pair.recommendation;
    return recommendation !== undefined && resolution.source === "offline-recommended" &&
      resolution.answerChoiceKey === recommendation.choiceKey &&
      resolution.answerText === recommendation.choiceLabel &&
      resolution.recommendationReason === recommendation.reason;
  }
  const request = metadata.get(semanticIdentity(lifecycle, "input-request-history", pair.requestKey))?.inputPair;
  return request !== undefined && request.kind === "request" && request.resolutionKey === key;
}

function validateReferenceIds(
  values: InertJsonValue[],
  declared: ReadonlySet<string>,
  cardinality: AuthorityReferenceCardinality
): boolean {
  if (!cardinalityAllows(cardinality, values.length)) return false;
  let previous: string | null = null;
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (typeof value !== "string" || !declared.has(value) ||
        (previous !== null && compareCanonical(previous, value) >= 0)) return false;
    previous = value;
  }
  return true;
}

function cardinalityAllows(cardinality: AuthorityReferenceCardinality, count: number): boolean {
  switch (cardinality) {
    case "none": return count === 0;
    case "any": return true;
    case "one": return count === 1;
    case "one-or-more": return count >= 1;
  }
}

function validateSemanticReferences(values: InertJsonValue[]): boolean {
  let previous: string | null = null;
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (!isRecord(value) || !hasExactOwnKeys(value, ["lifecycle", "authority", "key"]) ||
        (value.lifecycle !== "live" && value.lifecycle !== "trash") ||
        typeof value.authority !== "string" || typeof value.key !== "string") return false;
    const descriptor = getAuthorityDescriptor(value.authority);
    if (descriptor === null || descriptor.portableExport !== "include" ||
        !isCanonicalAuthorityKey(descriptor, value.key)) return false;
    if (descriptor.lifecycle === "live-only" && value.lifecycle !== "live") return false;
    const identity = semanticIdentity(value.lifecycle, value.authority, value.key);
    if (previous !== null && compareCanonical(previous, identity) >= 0) return false;
    previous = identity;
  }
  return true;
}

function validatePayloadAgentRequirements(
  declaredIds: InertJsonValue[],
  metadata: PortablePayloadMetadata,
  declaredAgents: ReadonlyMap<string, string>
): boolean {
  if (declaredIds.length !== metadata.agentRequirements.length) return false;
  for (let index = 0; index < declaredIds.length; index += 1) {
    const declaredId = declaredIds[index];
    const expected = metadata.agentRequirements[index];
    if (typeof declaredId !== "string" || expected === undefined || declaredId !== expected.agentId) return false;
    const actualAdapter = declaredAgents.get(declaredId);
    if (actualAdapter === undefined ||
        (expected.adapterId !== undefined && actualAdapter !== expected.adapterId)) return false;
  }
  return true;
}

function validateRequiredReferences(
  actualValues: InertJsonValue[],
  requirements: readonly PortableReferenceRequirement[],
  optionalTargets: readonly PortableReferenceTarget[] = []
): boolean {
  const actual = new Set<string>();
  for (const value of actualValues) {
    if (!isRecord(value)) return false;
    actual.add(referenceIdentity({
      lifecycle: value.lifecycle as PortableLifecycle,
      authority: value.authority as string,
      key: value.key as string
    }));
  }
  const allowed = new Set<string>();
  for (const requirement of requirements) {
    let matches = 0;
    for (const target of requirement.anyOf) {
      const identity = referenceIdentity(target);
      allowed.add(identity);
      if (actual.has(identity)) matches += 1;
    }
    if (matches !== 1) return false;
  }
  for (const target of optionalTargets) {
    allowed.add(referenceIdentity(target));
  }
  for (const identity of actual) {
    if (!allowed.has(identity)) return false;
  }
  return true;
}

function referenceIdentity(target: PortableReferenceTarget): string {
  return semanticIdentity(target.lifecycle, target.authority, target.key);
}

function isCanonicalAuthorityKey(descriptor: AuthorityDescriptor, key: string): boolean {
  switch (descriptor.keyShape) {
    case "singleton":
      return descriptor.singletonKey === key;
    case "entity":
    case "task":
      return isCanonicalEntityId(key);
    case "task-entity": {
      const segments = key.split("/");
      return segments.length === 2 && segments.every(isCanonicalEntityId);
    }
  }
}

function isCanonicalBindingId(value: unknown): value is string {
  return typeof value === "string" && value.length <= 64 &&
    /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(value);
}

function isCanonicalAdapterId(value: unknown): value is string {
  return typeof value === "string" && value.length <= 128 &&
    /^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/.test(value);
}

function isCanonicalEntityId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 256 &&
    value.trim() === value && value !== "." && value !== ".." &&
    value !== "__proto__" && value !== "prototype" && value !== "constructor" &&
    !/[\/\\\u0000-\u001f\u007f-\u009f\u2028\u2029]/u.test(value) && !/\p{Bidi_Control}/u.test(value);
}

function isPortableRelativeSubpath(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 4096 || value.includes("\\") ||
      value.includes("\0") || value.startsWith("/") || /^[A-Za-z]:/.test(value) ||
      /[\r\n]/.test(value)) return false;
  if (value === "") return true;
  const segments = value.split("/");
  return segments.every((segment) =>
    segment !== "." && segment !== ".." && /^[A-Za-z0-9._-]+$/.test(segment));
}

function isSafeLabel(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 256 &&
    value.trim() === value &&
    !/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/u.test(value) && !/\p{Bidi_Control}/u.test(value) &&
    !/[\/\\]/u.test(value) && !/^[^@\s]+@[^:\s]+:/u.test(value) &&
    !/[a-z][a-z0-9+.-]*:\/\/[^/\s]*@/i.test(value);
}

function isCanonicalInstant(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString() === value;
}

function semanticIdentity(lifecycle: PortableLifecycle, authorityId: string, key: string): string {
  return `${lifecycle}\0${authorityId}\0${key}`;
}

function compareCanonical(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function isRecord(value: unknown): value is Record<string, InertJsonValue> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export type BackupEntryKind = "file" | "symbolic-link";
export type BackupStoragePathDecision =
  | { disposition: "include"; authorities: readonly string[] }
  | { disposition: "content-dependent"; authorities: readonly string[] }
  | { disposition: "exclude"; reason: "symbolic-link" | "socket" | "journal" | "index" | "log" | "operational" | "ephemeral" | "derived" | "host-workspace" }
  | { disposition: "unknown" };

export type BackupPathRegistryEntry = Readonly<{
  pattern: RegExp;
  authorities: readonly string[];
  disposition: "include" | "content-dependent";
}>;

function backupPath(pattern: RegExp, authorityIds: string | readonly string[]): BackupPathRegistryEntry {
  const ids = typeof authorityIds === "string" ? [authorityIds] : [...authorityIds];
  if (ids.length === 0 || ids.some((authorityId) => getAuthorityDescriptor(authorityId)?.backup !== "include")) {
    throw new Error(`Backup registry authority is not backup-safe: ${ids.join(", ")}.`);
  }
  ids.sort(compareCanonical);
  return Object.freeze({
    pattern: Object.freeze(pattern),
    authorities: Object.freeze(ids),
    disposition: "include" as const
  });
}

function contentDependentBackupPath(
  pattern: RegExp,
  authorityIds: readonly string[]
): BackupPathRegistryEntry {
  const ids = [...authorityIds];
  if (ids.length < 2 || ids.some((authorityId) => getAuthorityDescriptor(authorityId) === null)) {
    throw new Error(`Content-dependent backup authorities are invalid: ${ids.join(", ")}.`);
  }
  ids.sort(compareCanonical);
  return Object.freeze({
    pattern: Object.freeze(pattern),
    authorities: Object.freeze(ids),
    disposition: "content-dependent" as const
  });
}

const TASK_PREFIX = "(?:tasks|trash/tasks)/[^/]+";

export const BACKUP_PATH_REGISTRY: readonly BackupPathRegistryEntry[] = Object.freeze([
  backupPath(/^config\.json$/, "config-storage"),
  backupPath(/^schema\.json$/, "storage-manifest"),
  backupPath(/^agents\/[^/]+\/agent\.json$/, "configured-agent"),
  backupPath(/^skills\/[^/]+\/SKILL\.md$/, "configured-skill"),
  backupPath(/^roles\/[^/]+\/role\.json$/, "global-role"),
  backupPath(new RegExp(`^${TASK_PREFIX}/(?:task|info)\\.json$`), "task"),
  backupPath(new RegExp(`^${TASK_PREFIX}/topics\\.json$`), "task-topics"),
  backupPath(new RegExp(`^${TASK_PREFIX}/input-draft\\.json$`), "task-input-draft"),
  contentDependentBackupPath(
    new RegExp(`^${TASK_PREFIX}/input-requests/[^/]+\\.json$`),
    ["input-request", "input-request-history"]
  ),
  backupPath(new RegExp(`^${TASK_PREFIX}/input-resolutions/[^/]+\\.json$`), "input-resolution"),
  backupPath(new RegExp(`^${TASK_PREFIX}/schedule\\.json$`), "task-schedule"),
  backupPath(new RegExp(`^${TASK_PREFIX}/cycles/[^/]+\\.json$`), "cycle"),
  backupPath(new RegExp(`^${TASK_PREFIX}/work-items/[^/]+\\.json$`), "work-item"),
  backupPath(new RegExp(`^${TASK_PREFIX}/roles/[^/]+/role\\.json$`), "task-role"),
  backupPath(
    new RegExp(`^${TASK_PREFIX}/roles/[^/]+/info\\.json$`),
    ["child-role", "task-role"]
  ),
  contentDependentBackupPath(
    new RegExp(`^${TASK_PREFIX}/agent-runs/[^/]+\\.json$`),
    ["active-agent-run", "agent-run-history"]
  ),
  backupPath(new RegExp(`^${TASK_PREFIX}/brief\\.md$`), "task-brief"),
  backupPath(new RegExp(`^${TASK_PREFIX}/topic-summaries\\.md$`), "task-topic-summary"),
  backupPath(new RegExp(`^${TASK_PREFIX}/timeline\\.md$`), "task-timeline"),
  backupPath(new RegExp(`^${TASK_PREFIX}/milestones/[^/]+\\.json$`), "milestone"),
  backupPath(new RegExp(`^${TASK_PREFIX}/decisions/[^/]+\\.json$`), "decision"),
  backupPath(new RegExp(`^${TASK_PREFIX}/comments\\.jsonl$`), "comment"),
  backupPath(new RegExp(`^${TASK_PREFIX}/events\\.jsonl$`), "event"),
  backupPath(new RegExp(`^${TASK_PREFIX}/roles/[^/]+/transcript\\.log$`), "transcript"),
  backupPath(new RegExp(`^${TASK_PREFIX}/roles/[^/]+/worktree\\.json$`), "role-worktree"),
  backupPath(/^runtime\/role-sessions\/(?:global\/[^/]+|tasks\/[^/]+\/[^/]+)\.json$/, "role-session-set"),
  backupPath(/^trash\/tasks\/[^/]+\/role-sessions\/[^/]+\.json$/, "role-session-set"),
  backupPath(/^runtime\/native-session-identities\.json$/, "native-session-identity-ledger")
]);

export function classifyBackupStoragePath(
  path: string,
  entryKind: BackupEntryKind = "file"
): BackupStoragePathDecision {
  if (entryKind === "symbolic-link") return { disposition: "exclude", reason: "symbolic-link" };
  if (!isCanonicalStoragePath(path)) return { disposition: "unknown" };

  for (let index = 0; index < BACKUP_PATH_REGISTRY.length; index += 1) {
    const entry = BACKUP_PATH_REGISTRY[index] as BackupPathRegistryEntry;
    if (entry.pattern.test(path)) return {
      disposition: entry.disposition,
      authorities: entry.authorities
    };
  }

  if (/^runtime\/.*(?:\.sock|\.socket)$/.test(path) || path === "runtime/controller.sock") {
    return { disposition: "exclude", reason: "socket" };
  }
  if (/^runtime\/(?:domain-transactions|domain-workspaces)(?:\/|$)/.test(path)) {
    return { disposition: "exclude", reason: "journal" };
  }
  if (/^runtime\/(?:index|domain-transaction-lock)\.sqlite(?:-(?:journal|wal|shm))?$/.test(path)) {
    return { disposition: "exclude", reason: "index" };
  }
  if (/^runtime\/logs(?:\/|$)/.test(path)) return { disposition: "exclude", reason: "log" };
  if (path === "operator/TASKMUX_OPERATOR.md") return { disposition: "exclude", reason: "derived" };
  if (/^workspace(?:\/|$)/.test(path)) return { disposition: "exclude", reason: "host-workspace" };
  if (/^runtime\/(?:controller\.json|controller\.lock)$/.test(path) || /^backups(?:\/|$)/.test(path)) {
    return { disposition: "exclude", reason: "operational" };
  }
  if (/^runtime\/(?:pending-wakeups|leader-failures|operator-notifications|active-runs|role-runtime-operations|rpc-intents|rpc-results)(?:\/|$)/.test(path) ||
      path === "runtime/rpc-tombstones.jsonl") {
    return { disposition: "exclude", reason: "ephemeral" };
  }
  return { disposition: "unknown" };
}

function isCanonicalStoragePath(path: string): boolean {
  if (path.length === 0 || path.startsWith("/") || path.includes("\\") || path.includes("\0") ||
      /^[A-Za-z]:/.test(path)) return false;
  return path.split("/").every((segment) => isCanonicalEntityId(segment));
}
