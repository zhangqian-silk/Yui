/**
 * Pure, read-only structural scan of raw `state.json`, never through the strict
 * `parseState`/`FileTaskStore` gate. The durable manifest remains authoritative;
 * this scanner supplies member versions and counts so callers can detect
 * manifest/state contradictions without treating an empty locator as current.
 * Older member versions remain version evidence rather than a strict-loader
 * parse failure, while malformed JSON/containers/schemaVersion fields are real
 * `CORRUPTED` evidence.
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

/** Structural member scan plus counts, or a corruption. */
export type RecordVersionScan = Readonly<
  | { corruption: RecordScanCorruption }
  | {
      record: Readonly<Record<string, RecordAxisEntry>>;
      /** Persisted member count per family; zero distinguishes absence from latest data. */
      counts: Readonly<Record<string, number>>;
    }
>;

/**
 * Scan per-family member versions and counts from raw `state.json`.
 *
 * Rules, per family, evaluated purely (no strict parser):
 *  - family absent or empty on disk  -> latest as an internal scan sentinel,
 *    with count zero so the manifest combiner never infers source currency;
 *  - every member at one older/current/newer version -> report that version;
 *  - members carrying different versions             -> corruption.
 *
 * A family is one durable schema boundary, so a manifest cannot make a mixed
 * member set trustworthy by matching either its minimum or maximum. Mixed
 * members are partial-write/corruption evidence, not a migration source version.
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
    // No state.json means zero persisted members. The latest-valued scan entry
    // is only a sentinel; counts preserve absence for the manifest combiner.
    return {
      record: cloneRecord(latestRecord),
      counts: Object.fromEntries(Object.keys(latestRecord).map((kind) => [kind, 0]))
    };
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

  return scanRecordVersionsFromState(root, latestRecord);
}

/** Extract record versions from an already-parsed state snapshot, read-only. */
export function scanRecordVersionsFromState(
  root: unknown,
  latestRecord: Readonly<Record<string, RecordAxisEntry>>
): RecordVersionScan {
  if (!isObject(root)) return corruption("state snapshot is not a JSON object.");

  const record: Record<string, RecordAxisEntry> = {};
  const counts: Record<string, number> = {};
  for (const [kind, entry] of Object.entries(latestRecord)) {
    const scan = scanFamily(root, entry.path, entry.version);
    if ("corruption" in scan) {
      return corruption(`record family '${kind}' (${entry.path}): ${scan.corruption}`);
    }
    record[kind] = { version: scan.version, path: entry.path };
    counts[kind] = scan.count;
  }
  return { record, counts };
}

type FamilyScan = { version: number; count: number } | { corruption: string };

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

  if (count === 0) return { version: latestVersion, count }; // zero-count sentinel only
  if (min !== max) {
    return {
      corruption: `family contains mixed schemaVersion values ${min} and ${max}`
    };
  }
  return { version: min, count };
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
