/**
 * Persistent Resource registry (Issue 10).
 *
 * The registry lives at `$YUI_HOME/runtime/resource-registry/registry.json`
 * and is GC's own state. It is written atomically and never shares a Home with
 * another session: each Home derives its own registry path.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

import {
  RESOURCE_REGISTRY_SCHEMA_VERSION,
  type ResourceRecord,
  type ResourceRegistryState
} from "./resourceTypes.js";

export const RESOURCE_REGISTRY_DIRECTORY = "resource-registry";
export const RESOURCE_REGISTRY_FILE = "registry.json";
export const RESOURCE_QUARANTINE_DIRECTORY = "quarantine";

export function resourceRegistryPath(home: string): string {
  return join(
    resolve(home),
    "runtime",
    RESOURCE_REGISTRY_DIRECTORY,
    RESOURCE_REGISTRY_FILE
  );
}

export function resourceQuarantineRoot(home: string): string {
  return join(
    resolve(home),
    "runtime",
    RESOURCE_REGISTRY_DIRECTORY,
    RESOURCE_QUARANTINE_DIRECTORY
  );
}

export function emptyResourceRegistry(): ResourceRegistryState {
  return Object.freeze({
    schemaVersion: RESOURCE_REGISTRY_SCHEMA_VERSION,
    records: Object.freeze({})
  });
}

/**
 * Load the registry. A missing or unreadable registry degrades to an empty
 * one: GC must never invent ownership from a corrupt registry, and a fresh
 * Home simply has no records yet.
 */
export function loadResourceRegistry(home: string): ResourceRegistryState {
  const path = resourceRegistryPath(home);
  if (!existsSync(path)) return emptyResourceRegistry();
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return emptyResourceRegistry();
  }
  return parseResourceRegistryState(parsed);
}

export function saveResourceRegistry(
  home: string,
  state: ResourceRegistryState
): void {
  const path = resourceRegistryPath(home);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.tmp-${process.pid}`;
  writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  renameSync(temporary, path);
}

export function upsertResourceRecord(
  state: ResourceRegistryState,
  record: ResourceRecord
): ResourceRegistryState {
  return Object.freeze({
    schemaVersion: RESOURCE_REGISTRY_SCHEMA_VERSION,
    records: Object.freeze({ ...state.records, [record.id]: Object.freeze(record) })
  });
}

export function removeResourceRecord(
  state: ResourceRegistryState,
  id: string
): ResourceRegistryState {
  if (!(id in state.records)) return state;
  const records = { ...state.records };
  delete records[id];
  return Object.freeze({
    schemaVersion: RESOURCE_REGISTRY_SCHEMA_VERSION,
    records: Object.freeze(records)
  });
}

export function listResourceRecords(state: ResourceRegistryState): ResourceRecord[] {
  return Object.values(state.records);
}

function parseResourceRegistryState(value: unknown): ResourceRegistryState {
  if (typeof value !== "object" || value === null) return emptyResourceRegistry();
  const record = value as Record<string, unknown>;
  if (record.schemaVersion !== RESOURCE_REGISTRY_SCHEMA_VERSION) {
    return emptyResourceRegistry();
  }
  if (typeof record.records !== "object" || record.records === null) {
    return emptyResourceRegistry();
  }
  const records: Record<string, ResourceRecord> = {};
  for (const [key, entry] of Object.entries(record.records)) {
    const parsed = parseResourceRecord(entry);
    if (parsed !== undefined && parsed.id === key) records[key] = parsed;
  }
  return Object.freeze({
    schemaVersion: RESOURCE_REGISTRY_SCHEMA_VERSION,
    records: Object.freeze(records)
  });
}

function parseResourceRecord(value: unknown): ResourceRecord | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const record = value as Record<string, unknown>;
  if (record.schemaVersion !== RESOURCE_REGISTRY_SCHEMA_VERSION) return undefined;
  if (typeof record.id !== "string" || typeof record.kind !== "string"
    || typeof record.path !== "string" || typeof record.disposition !== "string"
    || typeof record.updatedAt !== "string") {
    return undefined;
  }
  if (!Number.isFinite(Date.parse(record.updatedAt))) return undefined;
  if (typeof record.owner !== "object" || record.owner === null) return undefined;
  const owner = record.owner as Record<string, unknown>;
  if (typeof owner.home !== "string" || typeof owner.basis !== "string") {
    return undefined;
  }
  return Object.freeze({
    schemaVersion: RESOURCE_REGISTRY_SCHEMA_VERSION,
    id: record.id,
    kind: record.kind as ResourceRecord["kind"],
    path: record.path,
    owner: Object.freeze({ ...owner }) as ResourceRecord["owner"],
    ...(record.git === undefined ? {} : { git: record.git as ResourceRecord["git"] }),
    ...(typeof record.createdAt === "string" ? { createdAt: record.createdAt } : {}),
    ...(typeof record.lastReferencedAt === "string"
      ? { lastReferencedAt: record.lastReferencedAt }
      : {}),
    ...(typeof record.sizeBytes === "number" ? { sizeBytes: record.sizeBytes } : {}),
    cleanliness: (record.cleanliness ?? "unknown") as ResourceRecord["cleanliness"],
    activeRefs: Array.isArray(record.activeRefs)
      ? Object.freeze(record.activeRefs.filter((ref): ref is string => typeof ref === "string"))
      : Object.freeze([]),
    disposition: record.disposition as ResourceRecord["disposition"],
    ...(typeof record.blocker === "string" ? { blocker: record.blocker } : {}),
    ...(record.quarantine === undefined ? {} : { quarantine: record.quarantine as ResourceRecord["quarantine"] }),
    ...(record.cleanupReceipt === undefined
      ? {}
      : { cleanupReceipt: record.cleanupReceipt as ResourceRecord["cleanupReceipt"] }),
    updatedAt: record.updatedAt
  });
}
