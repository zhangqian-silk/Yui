import { sep } from "node:path";

export type StoragePathRegistryEntry = Readonly<{
  path: string;
  kind: "file" | "directory";
  transactionAuthority: "core" | "backups" | "operational" | "derived";
  physicalBackup: "include" | "exclude";
}>;

function storagePath(
  path: string,
  kind: StoragePathRegistryEntry["kind"],
  transactionAuthority: StoragePathRegistryEntry["transactionAuthority"],
  physicalBackup: StoragePathRegistryEntry["physicalBackup"]
): StoragePathRegistryEntry {
  return Object.freeze({ path, kind, transactionAuthority, physicalBackup });
}

/**
 * The one physical storage authority registry.
 *
 * A physical backup is a same-host secret snapshot. It includes every core
 * record needed to recover host-bound state, while operational coordination,
 * derived data, transaction staging, and recursive backups stay outside it.
 */
export const STORAGE_PATH_REGISTRY: readonly StoragePathRegistryEntry[] = Object.freeze([
  storagePath("config.json", "file", "core", "include"),
  storagePath("schema.json", "file", "core", "include"),
  storagePath("agents", "directory", "core", "include"),
  storagePath("skills", "directory", "core", "include"),
  storagePath("roles", "directory", "core", "include"),
  storagePath("tasks", "directory", "core", "include"),
  storagePath("trash", "directory", "core", "include"),
  storagePath("runtime/pending-wakeups", "directory", "core", "include"),
  storagePath("runtime/leader-failures", "directory", "core", "include"),
  storagePath("runtime/operator-notifications", "directory", "core", "include"),
  storagePath("runtime/operator-deliveries", "directory", "core", "include"),
  storagePath("runtime/offline-resolution-clocks", "directory", "core", "include"),
  storagePath("runtime/input-resolution-wakeups", "directory", "core", "include"),
  storagePath("runtime/role-sessions", "directory", "core", "include"),
  storagePath("runtime/native-session-identities.json", "file", "core", "include"),
  storagePath("runtime/active-runs", "directory", "core", "include"),
  storagePath("runtime/role-runtime-operations", "directory", "core", "include"),
  storagePath("runtime/git-lifecycle", "directory", "core", "include"),
  storagePath("runtime/launch-reservations", "directory", "core", "include"),
  storagePath("runtime/rpc-intents", "directory", "core", "include"),
  storagePath("runtime/rpc-results", "directory", "core", "include"),
  storagePath("runtime/rpc-tombstones.jsonl", "file", "core", "include"),
  storagePath("backups", "directory", "backups", "exclude"),
  storagePath("runtime/domain-transactions", "directory", "operational", "exclude"),
  storagePath("runtime/domain-staging", "directory", "operational", "exclude"),
  storagePath("runtime/controller.json", "file", "operational", "exclude"),
  storagePath("runtime/controller.lock", "file", "operational", "exclude"),
  storagePath("runtime/controller.sock", "file", "operational", "exclude"),
  storagePath("runtime/logs", "directory", "derived", "exclude"),
  storagePath("runtime/index.sqlite", "file", "derived", "exclude"),
  storagePath("runtime/index.sqlite-wal", "file", "derived", "exclude"),
  storagePath("runtime/index.sqlite-shm", "file", "derived", "exclude"),
  storagePath("workspace", "directory", "operational", "exclude")
]);

export const AUTHORITATIVE_STORAGE_PATHS: readonly string[] = Object.freeze(
  STORAGE_PATH_REGISTRY
    .filter((entry) => entry.transactionAuthority === "core")
    .map((entry) => entry.path)
);

const AUTHORITATIVE_DIRECTORY_PATHS = new Set(
  STORAGE_PATH_REGISTRY
    .filter((entry) => entry.transactionAuthority === "core" && entry.kind === "directory")
    .map((entry) => entry.path)
);

const BACKUP_STORAGE_PATHS = Object.freeze(
  STORAGE_PATH_REGISTRY
    .filter((entry) => entry.physicalBackup === "include")
    .map((entry) => entry.path)
);

const BACKUP_DIRECTORY_PATHS = new Set(
  STORAGE_PATH_REGISTRY
    .filter((entry) => entry.physicalBackup === "include" && entry.kind === "directory")
    .map((entry) => entry.path)
);

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

export function backupAuthoritativeStoragePaths(): string[] {
  return [...BACKUP_STORAGE_PATHS];
}

export function isAuthoritativeStorageTarget(
  relativeTarget: string,
  includeBackups = false
): boolean {
  const target = normalizeStoragePath(relativeTarget);
  if (target.length === 0 || target === ".") return false;
  if (includeBackups && (target === "backups" || target.startsWith("backups/"))) {
    return true;
  }
  return matchesRegisteredPath(target, AUTHORITATIVE_STORAGE_PATHS, AUTHORITATIVE_DIRECTORY_PATHS);
}

export function isBackupAuthoritativeStorageTarget(relativeTarget: string): boolean {
  const target = normalizeStoragePath(relativeTarget);
  return target.length > 0 && target !== "." &&
    matchesRegisteredPath(target, BACKUP_STORAGE_PATHS, BACKUP_DIRECTORY_PATHS);
}

export function isBackupAuthoritativeStorageContainer(relativeTarget: string): boolean {
  const target = normalizeStoragePath(relativeTarget);
  if (target.length === 0 || target === ".") return true;
  return BACKUP_STORAGE_PATHS.some((path) => path === target || path.startsWith(`${target}/`));
}

function matchesRegisteredPath(
  target: string,
  paths: readonly string[],
  directoryPaths: ReadonlySet<string>
): boolean {
  for (const path of paths) {
    if (target === path) return true;
    if (directoryPaths.has(path) && target.startsWith(`${path}/`)) return true;
  }
  return false;
}

function normalizeStoragePath(path: string): string {
  return path.split(sep).join("/");
}
