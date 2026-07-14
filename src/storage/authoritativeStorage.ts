import { sep } from "node:path";

/**
 * The only persisted records that a domain transaction may mutate.
 *
 * Runtime coordination files such as locks, journals, workspaces, logs, and
 * derived indexes deliberately stay outside this namespace.
 */
export const AUTHORITATIVE_STORAGE_PATHS = [
  "config.json",
  "schema.json",
  "agents",
  "roles",
  "tasks",
  "trash",
  "runtime/pending-wakeups",
  "runtime/leader-failures",
  "runtime/operator-notifications",
  "runtime/role-sessions",
  "runtime/native-session-identities.json",
  "runtime/active-runs",
  "runtime/role-runtime-operations",
  "runtime/launch-reservations",
  "runtime/rpc-intents",
  "runtime/rpc-results",
  "runtime/rpc-tombstones.jsonl"
] as const;

const AUTHORITATIVE_DIRECTORY_PATHS = new Set<string>([
  "agents",
  "roles",
  "tasks",
  "trash",
  "runtime/pending-wakeups",
  "runtime/leader-failures",
  "runtime/operator-notifications",
  "runtime/role-sessions",
  "runtime/active-runs",
  "runtime/role-runtime-operations",
  "runtime/launch-reservations",
  "runtime/rpc-intents",
  "runtime/rpc-results"
]);

export function canonicalStorageOwnerUid(stat: { uid: number | bigint }): string {
  const uid = String(BigInt(stat.uid));
  if (!isCanonicalStorageOwnerUid(uid)) {
    throw new Error("Authoritative TaskMux storage has a foreign owner uid.");
  }
  return uid;
}

export function isCanonicalStorageOwnerUid(value: unknown): value is string {
  return typeof value === "string" && /^(?:0|[1-9][0-9]*)$/.test(value) &&
    (typeof process.getuid !== "function" || value === String(process.getuid()));
}

export function authoritativeStoragePaths(includeBackups = false): string[] {
  return includeBackups
    ? [...AUTHORITATIVE_STORAGE_PATHS, "backups"]
    : [...AUTHORITATIVE_STORAGE_PATHS];
}

export function isAuthoritativeStorageTarget(
  relativeTarget: string,
  includeBackups = false
): boolean {
  const target = relativeTarget.split(sep).join("/");
  if (target.length === 0 || target === ".") return false;
  if (includeBackups && (target === "backups" || target.startsWith("backups/"))) {
    return true;
  }
  for (const path of AUTHORITATIVE_STORAGE_PATHS) {
    if (target === path) return true;
    if (AUTHORITATIVE_DIRECTORY_PATHS.has(path) && target.startsWith(`${path}/`)) {
      return true;
    }
  }
  return false;
}
