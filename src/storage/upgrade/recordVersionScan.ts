/**
 * Pure, read-only extraction of a source Home's per-record-family schema
 * versions, taken straight from the raw `state.json` — never through the strict
 * `parseState`/`FileTaskStore` gate.
 *
 * ## Why this exists (the record-axis wiring)
 *
 * The three storage axes are independent: `layout` and `aggregate` are scalars
 * from `schema.json`, while `record` is a `recordKind -> {version, path}` map
 * because every record family versions on its own axis. The strict loader
 * validates every record against the *current* release's versions, so it throws
 * the moment any record family is even one version behind. Using that loader to
 * decide compatibility conflates "this family is on an older axis" (a version
 * verdict) with "this data is structurally damaged" (`CORRUPTED`) — a real Home
 * whose only difference is an older record family would be misreported as
 * corrupted and blocked from ever migrating.
 *
 * This scanner keeps the record axis genuinely independent: it reads the source
 * versions structurally (JSON only), so a record-only-older Home flows into the
 * planner and is classified `MIGRATABLE` (when a step path exists) or
 * `NEEDS_NEW_VERSION` (fail-closed under the empty registry) — never `CORRUPTED`.
 * `CORRUPTED` is reserved for genuine JSON/structural damage (unparseable
 * `state.json`, a non-object root, a container whose shape is not what the path
 * describes, or a record with a missing/invalid `schemaVersion`).
 *
 * The `path` for each family (from `recordVersions.ts`) is a small locator into
 * `state.json`: segments are `/`-separated after the `state.json#/` prefix, and a
 * `*` segment fans out over every member of the map at that level (so the locator
 * `state.json#/tasks/{star}/workItems` visits the `workItems` map of every task,
 * where `{star}` is a literal `*`).
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { STORAGE_STATE_FILE } from "../taskStore.js";
import type { RecordAxisEntry } from "../migration/index.js";

/** A structural-damage fact discovered while scanning (maps to `CORRUPTED`). */
export type RecordScanCorruption = Readonly<{ corrupted: true; detail: string }>;

/** The scan result: either the extracted source record map, or a corruption. */
export type RecordVersionScan = Readonly<
  | { corruption: RecordScanCorruption }
  | { record: Readonly<Record<string, RecordAxisEntry>> }
>;

/**
 * Extract the source Home's per-family record versions from the raw `state.json`.
 *
 * Rules, per family, evaluated purely (no strict parser):
 *  - family absent or empty on disk  -> already at the latest version (nothing to
 *    migrate for that family);
 *  - every member exactly at latest  -> current;
 *  - any member NEWER than latest     -> report the max (surfaces `future-version`);
 *  - otherwise (some member older)    -> report the min (the oldest member drives
 *    migration; consistent families collapse to that single version).
 *
 * The min/newer-wins rule is deliberately fail-closed: an inconsistent family is
 * never rounded up to "already current", so it always lands on a version verdict
 * the planner can act on rather than being silently skipped.
 *
 * Returns a `corruption` instead when the JSON is unparseable, the root is not an
 * object, a path container is not the shape the locator describes, or a record is
 * missing/has an invalid `schemaVersion`.
 */
export function scanSourceRecordVersions(
  home: string,
  latestRecord: Readonly<Record<string, RecordAxisEntry>>
): RecordVersionScan {
  const statePath = join(home, STORAGE_STATE_FILE);
  if (!existsSync(statePath)) {
    // No state.json yet is an empty, current Home (matches the store's
    // emptyState()): there are no records, so every family is trivially latest.
    return { record: cloneRecord(latestRecord) };
  }

  let root: unknown;
  try {
    root = JSON.parse(readFileSync(statePath, "utf8"));
  } catch (error) {
    return corruption(`state.json is not valid JSON: ${messageOf(error)}`);
  }
  if (!isObject(root)) {
    return corruption("state.json is not a JSON object.");
  }

  const record: Record<string, RecordAxisEntry> = {};
  for (const [kind, entry] of Object.entries(latestRecord)) {
    const scan = scanFamily(root, entry.path, entry.version);
    if ("corruption" in scan) {
      return corruption(`record family '${kind}' (${entry.path}): ${scan.corruption}`);
    }
    record[kind] = { version: scan.version, path: entry.path };
  }
  return { record };
}

type FamilyScan = { version: number } | { corruption: string };

/** Resolve one family's source version from `root` following `path`. */
function scanFamily(
  root: Record<string, unknown>,
  path: string,
  latestVersion: number
): FamilyScan {
  const segments = parseLocator(path);
  if (segments === null) return { corruption: `unrecognized path syntax "${path}"` };

  // Resolve the path to the family's endpoint node(s). A `*` fans out over the
  // members of the map at that level; an absent named key contributes nothing
  // (that branch simply has no records), but a present-but-wrong-typed node is
  // structural damage.
  let nodes: unknown[] = [root];
  for (const segment of segments) {
    const next: unknown[] = [];
    for (const node of nodes) {
      if (segment === "*") {
        if (!isObject(node)) return { corruption: `expected an object to enumerate at "*"` };
        next.push(...Object.values(node));
      } else {
        if (!isObject(node)) return { corruption: `expected an object at "${segment}"` };
        if (!Object.hasOwn(node, segment)) continue; // absent branch: no records here
        next.push(node[segment]);
      }
    }
    nodes = next;
  }

  // Each endpoint is either a single record (it carries `schemaVersion`, e.g.
  // tasks/* (the StoredTask aggregate), tasks/*/task, tasks/*/brief) or a map of records (its values carry
  // `schemaVersion`, e.g. configuredAgents, tasks/*/workItems).
  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;
  let count = 0;
  for (const endpoint of nodes) {
    if (endpoint === null || endpoint === undefined) continue; // e.g. brief: null
    if (!isObject(endpoint)) return { corruption: "family endpoint is not an object" };

    if (typeof endpoint.schemaVersion === "number") {
      const version = readSchemaVersion(endpoint);
      if (version === null) return { corruption: `record has an invalid schemaVersion` };
      min = Math.min(min, version);
      max = Math.max(max, version);
      count += 1;
      continue;
    }

    for (const member of Object.values(endpoint)) {
      if (member === null) continue;
      if (!isObject(member)) return { corruption: "record member is not an object" };
      const version = readSchemaVersion(member);
      if (version === null) return { corruption: "record member has a missing/invalid schemaVersion" };
      min = Math.min(min, version);
      max = Math.max(max, version);
      count += 1;
    }
  }

  if (count === 0) return { version: latestVersion }; // absent/empty => already latest
  if (max > latestVersion) return { version: max }; // a future member wins (fail-closed)
  return { version: min }; // the oldest member drives migration; consistent => single value
}

/** Parse a `state.json#/`-prefixed locator into path segments, or `null`. */
function parseLocator(path: string): string[] | null {
  const prefix = `${STORAGE_STATE_FILE}#/`;
  if (!path.startsWith(prefix)) return null;
  const body = path.slice(prefix.length);
  if (body.length === 0) return null;
  return body.split("/");
}

/** A positive-integer `schemaVersion`, or `null` when missing/invalid. */
function readSchemaVersion(record: Record<string, unknown>): number | null {
  const version = record.schemaVersion;
  if (typeof version !== "number" || !Number.isInteger(version) || version < 1) return null;
  return version;
}

function cloneRecord(
  record: Readonly<Record<string, RecordAxisEntry>>
): Record<string, RecordAxisEntry> {
  const copy: Record<string, RecordAxisEntry> = {};
  for (const [kind, entry] of Object.entries(record)) {
    copy[kind] = { version: entry.version, path: entry.path };
  }
  return copy;
}

function corruption(detail: string): RecordVersionScan {
  return { corruption: { corrupted: true, detail } };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
