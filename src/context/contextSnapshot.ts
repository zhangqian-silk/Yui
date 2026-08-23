import { createHash } from "node:crypto";

import {
  normalizedUniqueText,
  optionalText,
  requireIdentity,
  requirePositiveInteger,
  requireText,
  requireTimestamp
} from "../domain/validation.js";

export const CONTEXT_SNAPSHOT_SCHEMA_VERSION = 1 as const;
export const CONTEXT_SNAPSHOT_MAX_RESOURCES = 256;
export const CONTEXT_SNAPSHOT_MAX_RESOURCE_BYTES = 4 * 1024 * 1024;
export const CONTEXT_SNAPSHOT_MAX_BYTES = 8 * 1024 * 1024;
export const CONTEXT_REF_LAYERS = ["L1", "L2", "L3", "L4"] as const;
export const CONTEXT_SNAPSHOT_SCOPES = ["task", "workitem", "stage"] as const;

export type ContextRefLayer = typeof CONTEXT_REF_LAYERS[number];
export type ContextSnapshotScope = typeof CONTEXT_SNAPSHOT_SCOPES[number];

export type ContextRef = Readonly<{
  layer: ContextRefLayer;
  store: string;
  refId: string;
  revision: string;
  digest: string;
  summary?: string;
  evidenceOf?: string;
}>;

export type ContextSnapshotRef = Readonly<{
  schemaVersion: typeof CONTEXT_SNAPSHOT_SCHEMA_VERSION;
  id: string;
  taskId: string;
  scope: ContextSnapshotScope;
  scopeRef?: string;
  sequence: number;
  digest: string;
}>;

export type ContextSnapshotResource = Readonly<{
  ref: ContextRef;
  value: unknown;
}>;

export type ContextSnapshot = ContextSnapshotRef & Readonly<{
  refs: readonly ContextRef[];
  /** Immutable authorized values; mutable stores are never re-read for a frozen Run. */
  resources: readonly ContextSnapshotResource[];
  repoCommit?: string;
  acceptRefs: readonly string[];
  parentRef?: ContextSnapshotRef;
  frozenAt: string;
  frozenBy: "leader" | "controller";
}>;

export type CreateContextSnapshotInput = Readonly<{
  id: string;
  taskId: string;
  scope: ContextSnapshotScope;
  scopeRef?: string;
  sequence: number;
  refs: readonly ContextRef[];
  resources: readonly ContextSnapshotResource[];
  repoCommit?: string;
  acceptRefs: readonly string[];
  parentRef?: ContextSnapshotRef;
  frozenAt: Date;
  frozenBy: "leader" | "controller";
}>;

export function createContextSnapshot(input: CreateContextSnapshotInput): ContextSnapshot {
  const identity = snapshotIdentity(input);
  const refs = normalizeContextRefs(input.refs);
  const resources = normalizeSnapshotResources(input.resources, refs);
  const acceptRefs = Object.freeze(
    [...normalizedUniqueText(input.acceptRefs, "Context Snapshot acceptance reference")]
      .sort((left, right) => left.localeCompare(right))
  );
  const repoCommit = optionalText(input.repoCommit, "Context Snapshot repository commit");
  const parentRef = input.parentRef === undefined
    ? undefined
    : validateContextSnapshotRef(input.parentRef);
  if (parentRef !== undefined) {
    if (parentRef.taskId !== identity.taskId) {
      throw new Error("Context Snapshot parent belongs to another Task.");
    }
    if (parentRef.sequence >= identity.sequence) {
      throw new Error("Context Snapshot parent sequence must precede its child.");
    }
  }
  if (input.frozenBy !== "leader" && input.frozenBy !== "controller") {
    throw new Error("Context Snapshot frozenBy is invalid.");
  }
  const frozenAt = requireTimestamp(input.frozenAt.toISOString(), "Context Snapshot frozenAt");
  const digest = contentDigest({
    taskId: identity.taskId,
    scope: identity.scope,
    ...(identity.scopeRef === undefined ? {} : { scopeRef: identity.scopeRef }),
    sequence: identity.sequence,
    refs,
    resources,
    ...(repoCommit === undefined ? {} : { repoCommit }),
    acceptRefs,
    ...(parentRef === undefined ? {} : { parentRef }),
    frozenAt,
    frozenBy: input.frozenBy
  });
  return Object.freeze({
    schemaVersion: CONTEXT_SNAPSHOT_SCHEMA_VERSION,
    ...identity,
    digest,
    refs,
    resources,
    ...(repoCommit === undefined ? {} : { repoCommit }),
    acceptRefs,
    ...(parentRef === undefined ? {} : { parentRef }),
    frozenAt,
    frozenBy: input.frozenBy
  });
}

export function validateContextSnapshot(snapshot: ContextSnapshot): ContextSnapshot {
  if (snapshot.schemaVersion !== CONTEXT_SNAPSHOT_SCHEMA_VERSION) {
    throw new Error("Context Snapshot must use schemaVersion 1.");
  }
  const identity = snapshotIdentity(snapshot);
  const refs = normalizeContextRefs(snapshot.refs);
  if (JSON.stringify(refs) !== JSON.stringify(snapshot.refs)) {
    throw new Error("Context Snapshot refs must use canonical order.");
  }
  const resources = normalizeSnapshotResources(snapshot.resources, refs);
  if (JSON.stringify(resources) !== JSON.stringify(snapshot.resources)) {
    throw new Error("Context Snapshot resources must use canonical ref order.");
  }
  const acceptRefs = Object.freeze(
    [...normalizedUniqueText(snapshot.acceptRefs, "Context Snapshot acceptance reference")]
      .sort((left, right) => left.localeCompare(right))
  );
  if (JSON.stringify(acceptRefs) !== JSON.stringify(snapshot.acceptRefs)) {
    throw new Error("Context Snapshot acceptance refs must use canonical order.");
  }
  const repoCommit = optionalText(snapshot.repoCommit, "Context Snapshot repository commit");
  const parentRef = snapshot.parentRef === undefined
    ? undefined
    : validateContextSnapshotRef(snapshot.parentRef);
  if (parentRef !== undefined
    && (parentRef.taskId !== identity.taskId || parentRef.sequence >= identity.sequence)) {
    throw new Error("Context Snapshot parent is invalid.");
  }
  requireTimestamp(snapshot.frozenAt, "Context Snapshot frozenAt");
  if (snapshot.frozenBy !== "leader" && snapshot.frozenBy !== "controller") {
    throw new Error("Context Snapshot frozenBy is invalid.");
  }
  requireDigest(snapshot.digest, "Context Snapshot digest");
  const expected = contentDigest({
    taskId: identity.taskId,
    scope: identity.scope,
    ...(identity.scopeRef === undefined ? {} : { scopeRef: identity.scopeRef }),
    sequence: identity.sequence,
    refs,
    resources,
    ...(repoCommit === undefined ? {} : { repoCommit }),
    acceptRefs,
    ...(parentRef === undefined ? {} : { parentRef }),
    frozenAt: snapshot.frozenAt,
    frozenBy: snapshot.frozenBy
  });
  if (snapshot.digest !== expected) {
    throw new Error("Context Snapshot digest does not match its content.");
  }
  return snapshot;
}

export function contextSnapshotRef(snapshot: ContextSnapshot): ContextSnapshotRef {
  validateContextSnapshot(snapshot);
  return Object.freeze({
    schemaVersion: CONTEXT_SNAPSHOT_SCHEMA_VERSION,
    id: snapshot.id,
    taskId: snapshot.taskId,
    scope: snapshot.scope,
    ...(snapshot.scopeRef === undefined ? {} : { scopeRef: snapshot.scopeRef }),
    sequence: snapshot.sequence,
    digest: snapshot.digest
  });
}

export function validateContextSnapshotRef(ref: ContextSnapshotRef): ContextSnapshotRef {
  if (ref.schemaVersion !== CONTEXT_SNAPSHOT_SCHEMA_VERSION) {
    throw new Error("Context Snapshot ref must use schemaVersion 1.");
  }
  const identity = snapshotIdentity(ref);
  requireDigest(ref.digest, "Context Snapshot ref digest");
  return Object.freeze({
    schemaVersion: CONTEXT_SNAPSHOT_SCHEMA_VERSION,
    ...identity,
    digest: ref.digest
  });
}

export function contextContentDigest(value: unknown): string {
  return contentDigest(value);
}

function snapshotIdentity(input: Readonly<{
  id: string;
  taskId: string;
  scope: ContextSnapshotScope;
  scopeRef?: string;
  sequence: number;
}>): Omit<ContextSnapshotRef, "schemaVersion" | "digest"> {
  const id = requireIdentity(input.id, "Context Snapshot id");
  const taskId = requireIdentity(input.taskId, "Context Snapshot Task id");
  if (!CONTEXT_SNAPSHOT_SCOPES.includes(input.scope)) {
    throw new Error("Context Snapshot scope is invalid.");
  }
  const scopeRef = optionalText(input.scopeRef, "Context Snapshot scope ref");
  if (input.scope === "task" && scopeRef !== undefined) {
    throw new Error("A task Context Snapshot cannot carry scopeRef.");
  }
  if (input.scope !== "task" && scopeRef === undefined) {
    throw new Error(`A ${input.scope} Context Snapshot requires scopeRef.`);
  }
  return {
    id,
    taskId,
    scope: input.scope,
    ...(scopeRef === undefined ? {} : { scopeRef }),
    sequence: requirePositiveInteger(input.sequence, "Context Snapshot sequence")
  };
}

function normalizeContextRefs(values: readonly ContextRef[]): readonly ContextRef[] {
  if (!Array.isArray(values)) throw new Error("Context Snapshot refs must be an array.");
  const refs = values.map(validateContextRef).sort((left, right) => (
    contextRefKey(left).localeCompare(contextRefKey(right))
  ));
  const keys = refs.map(contextRefKey);
  if (new Set(keys).size !== keys.length) {
    throw new Error("Context Snapshot refs must be unique.");
  }
  return Object.freeze(refs);
}

function validateContextRef(value: ContextRef): ContextRef {
  if (!CONTEXT_REF_LAYERS.includes(value.layer)) {
    throw new Error("Context ref layer is invalid.");
  }
  const store = requireIdentity(value.store, "Context ref store");
  const refId = requireText(value.refId, "Context ref id");
  const revision = requireText(value.revision, "Context ref revision");
  const digest = requireDigest(value.digest, "Context ref digest");
  const summary = optionalText(value.summary, "Context ref summary");
  const evidenceOf = optionalText(value.evidenceOf, "Context ref evidence target");
  return Object.freeze({
    layer: value.layer,
    store,
    refId,
    revision,
    digest,
    ...(summary === undefined ? {} : { summary }),
    ...(evidenceOf === undefined ? {} : { evidenceOf })
  });
}

function normalizeSnapshotResources(
  values: readonly ContextSnapshotResource[],
  refs: readonly ContextRef[]
): readonly ContextSnapshotResource[] {
  if (!Array.isArray(values)) throw new Error("Context Snapshot resources must be an array.");
  if (values.length > CONTEXT_SNAPSHOT_MAX_RESOURCES) {
    throw new Error(`Context Snapshot exceeds ${CONTEXT_SNAPSHOT_MAX_RESOURCES} resources.`);
  }
  const byRef = new Map(refs.map((ref) => [contextRefKey(ref), ref]));
  const resources = values.map((resource) => {
    if (resource === null || typeof resource !== "object" || Array.isArray(resource)) {
      throw new Error("Context Snapshot resource must be an object.");
    }
    const ref = validateContextRef(resource.ref);
    const exact = byRef.get(contextRefKey(ref));
    if (exact === undefined || contextContentDigest(resource.value) !== ref.digest) {
      throw new Error(`Context Snapshot resource does not match its ref: ${ref.store}/${ref.refId}.`);
    }
    const serialized = JSON.stringify(resource.value);
    if (serialized === undefined) {
      throw new Error("Context Snapshot resource value is not JSON serializable.");
    }
    if (Buffer.byteLength(serialized, "utf8") > CONTEXT_SNAPSHOT_MAX_RESOURCE_BYTES) {
      throw new Error(`Context Snapshot resource exceeds ${CONTEXT_SNAPSHOT_MAX_RESOURCE_BYTES} bytes.`);
    }
    return Object.freeze({ ref: exact, value: resource.value });
  }).sort((left, right) => contextRefKey(left.ref).localeCompare(contextRefKey(right.ref)));
  if (resources.length !== refs.length
    || new Set(resources.map(({ ref }) => contextRefKey(ref))).size !== refs.length) {
    throw new Error("Context Snapshot resources must cover every ref exactly once.");
  }
  if (Buffer.byteLength(JSON.stringify(resources), "utf8") > CONTEXT_SNAPSHOT_MAX_BYTES) {
    throw new Error(`Context Snapshot resources exceed ${CONTEXT_SNAPSHOT_MAX_BYTES} bytes.`);
  }
  return Object.freeze(resources);
}

function contextRefKey(ref: ContextRef): string {
  return [ref.layer, ref.store, ref.refId, ref.revision, ref.digest].join("\0");
}

function requireDigest(value: string, label: string): string {
  if (!/^[0-9a-f]{64}$/u.test(value)) throw new Error(`${label} must be SHA-256 hex.`);
  return value;
}

function contentDigest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}
