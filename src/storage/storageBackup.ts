import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync
} from "node:fs";
import type { Stats } from "node:fs";
import { dirname, join } from "node:path";
import {
  backupAuthoritativeStoragePaths,
  canonicalStorageOwnerUid,
  isBackupAuthoritativeStorageContainer,
  isBackupAuthoritativeStorageTarget
} from "./authoritativeStorage.js";
import { CURRENT_STORAGE_SCHEMA_VERSION } from "./storageSchema.js";

const BACKUP_ID_PATTERN = /^backup-[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}-[0-9]{2}-[0-9]{2}-[0-9]{3}Z$/;
const MAX_PHYSICAL_BACKUP_FILE_BYTES = 64 * 1024 * 1024;

export type StorageBackupResult = {
  id: string;
  path: string;
  createdAt: string;
};

export type StorageRestoreResult = {
  backupId: string;
  rollbackId: string;
};

type StorageBackupManifest = {
  schemaVersion: 1;
  id: string;
  createdAt: string;
  source: string;
};

export function createStorageBackup(rootDir: string, now = new Date()): StorageBackupResult {
  const createdAt = canonicalInstant(now);
  const id = backupId(createdAt);
  const backupRoot = join(rootDir, "backups");
  const backupPath = join(backupRoot, id);
  const pendingPath = join(backupRoot, `.pending-${id}-${process.pid}`);
  if (existsSync(backupPath) || existsSync(pendingPath)) {
    throw new Error(`Backup already exists: ${id}.`);
  }

  mkdirSync(backupRoot, { recursive: true, mode: 0o700 });
  mkdirSync(pendingPath, { mode: 0o700 });

  try {
    for (const path of backupAuthoritativeStoragePaths()) {
      copyOwnedStorageEntry(join(rootDir, path), join(pendingPath, path));
    }
    const manifest: StorageBackupManifest = {
      schemaVersion: 1,
      id,
      createdAt,
      source: rootDir
    };
    writePrivateFile(
      join(pendingPath, "backup.json"),
      Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, "utf8")
    );
    if (process.env.TASKMUX_BACKUP_FAILPOINT === "before-publish") {
      throw new Error(`Backup ${id} stopped before publish.`);
    }
    renameSync(pendingPath, backupPath);
  } catch (error) {
    rmSync(pendingPath, { recursive: true, force: true });
    throw error;
  }

  return { id, path: backupPath, createdAt };
}

/**
 * Applies a preflighted restore only to a transaction-private working root.
 * The caller publishes the resulting diff with the core+backups authority.
 */
export function restoreStorageBackupInWorkingRoot(
  workingRoot: string,
  backupIdValue: string,
  now = new Date()
): StorageRestoreResult {
  assertBackupId(backupIdValue);
  const backupPath = join(workingRoot, "backups", backupIdValue);
  preflightStorageBackup(backupPath, backupIdValue);

  // The rollback snapshot is created before the first destructive mutation.
  const rollback = createStorageBackup(workingRoot, now);
  try {
    replaceAuthoritativeState(workingRoot, backupPath);
  } catch (error) {
    // The working root is private, but restoring it here also makes this helper
    // safe for callers that inspect the failed workspace before discarding it.
    replaceAuthoritativeState(workingRoot, rollback.path);
    throw error;
  }
  return { backupId: backupIdValue, rollbackId: rollback.id };
}

/** Applies a known rollback snapshot inside a fresh private transaction root. */
export function applyStorageRollbackInWorkingRoot(
  workingRoot: string,
  rollbackId: string
): void {
  assertBackupId(rollbackId);
  const rollbackPath = join(workingRoot, "backups", rollbackId);
  preflightStorageBackup(rollbackPath, rollbackId);
  replaceAuthoritativeState(workingRoot, rollbackPath);
}

export function preflightStorageBackup(backupPath: string, expectedId: string): void {
  assertBackupId(expectedId);
  const backupMetadata = requireOwnedEntry(backupPath);
  if (!backupMetadata.isDirectory() || backupMetadata.isSymbolicLink()) {
    throw new Error("Storage backup identity is not one real directory.");
  }
  validateBackupTree(backupPath, ".");
  const manifest = parseBackupManifest(readPrivateText(join(backupPath, "backup.json")));
  if (manifest === null || manifest.id !== expectedId) {
    throw new Error("Storage backup manifest identity is invalid.");
  }
  const schema = parseStorageSchema(readPrivateText(join(backupPath, "schema.json")));
  if (schema !== CURRENT_STORAGE_SCHEMA_VERSION) {
    throw new Error(
      `Storage backup schema ${schema ?? "invalid"} is incompatible with ${CURRENT_STORAGE_SCHEMA_VERSION}.`
    );
  }
}

function validateBackupTree(backupRoot: string, relativePath: string): void {
  const absolute = relativePath === "." ? backupRoot : join(backupRoot, relativePath);
  const metadata = requireOwnedEntry(absolute);
  if (metadata.isSymbolicLink()) {
    throw new Error("Storage backup contains a symbolic-link identity.");
  }
  if (metadata.isFile()) {
    if (metadata.nlink !== 1 || metadata.size > MAX_PHYSICAL_BACKUP_FILE_BYTES) {
      throw new Error("Storage backup file identity is invalid.");
    }
    if (relativePath !== "backup.json" && !isBackupAuthoritativeStorageTarget(relativePath)) {
      throw new Error("Storage backup contains a non-authoritative file.");
    }
    return;
  }
  if (!metadata.isDirectory()) {
    throw new Error("Storage backup contains an unsupported entry.");
  }
  if (relativePath !== "." && !isBackupAuthoritativeStorageContainer(relativePath) &&
      !isBackupAuthoritativeStorageTarget(relativePath)) {
    throw new Error("Storage backup contains a non-authoritative directory.");
  }
  for (const name of readdirSync(absolute).sort()) {
    validateBackupTree(backupRoot, relativePath === "." ? name : `${relativePath}/${name}`);
  }
}

function copyOwnedStorageEntry(source: string, target: string): void {
  if (!existsSync(source)) return;
  const metadata = requireOwnedEntry(source);
  if (metadata.isSymbolicLink()) {
    throw new Error("Authoritative storage contains a symbolic-link identity.");
  }
  if (metadata.isDirectory()) {
    mkdirSync(target, { recursive: true, mode: 0o700 });
    for (const name of readdirSync(source).sort()) {
      copyOwnedStorageEntry(join(source, name), join(target, name));
    }
    return;
  }
  // A1 intentionally keeps publication-unit hard links in its private staging
  // area until maintenance retires them. Multiple links are therefore valid
  // for a live authoritative source; the backup itself is always written as a
  // fresh private file and is validated as single-link during preflight.
  if (!metadata.isFile() || metadata.size > MAX_PHYSICAL_BACKUP_FILE_BYTES) {
    throw new Error("Authoritative storage contains an unsupported entry identity.");
  }
  writePrivateFile(target, readFileSync(source));
}

function replaceAuthoritativeState(workingRoot: string, backupPath: string): void {
  for (const path of backupAuthoritativeStoragePaths()) {
    const target = join(workingRoot, path);
    rmSync(target, { recursive: true, force: true });
    copyOwnedStorageEntry(join(backupPath, path), target);
  }
}

function writePrivateFile(path: string, bytes: Buffer): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, bytes, { flag: "wx", mode: 0o600 });
}

function requireOwnedEntry(path: string): Stats {
  const metadata = lstatSync(path);
  canonicalStorageOwnerUid(metadata);
  return metadata;
}

function readPrivateText(path: string): string {
  const metadata = requireOwnedEntry(path);
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1 ||
      metadata.size > MAX_PHYSICAL_BACKUP_FILE_BYTES) {
    throw new Error("Storage backup metadata identity is invalid.");
  }
  return readFileSync(path, "utf8");
}

function parseBackupManifest(raw: string): StorageBackupManifest | null {
  let value: unknown;
  try {
    value = JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
  if (!isRecord(value) || Reflect.ownKeys(value).length !== 4 ||
      value.schemaVersion !== 1 || typeof value.id !== "string" ||
      typeof value.createdAt !== "string" || typeof value.source !== "string" ||
      !BACKUP_ID_PATTERN.test(value.id) || !isCanonicalInstant(value.createdAt) ||
      value.source.length === 0) {
    return null;
  }
  return value as StorageBackupManifest;
}

function parseStorageSchema(raw: string): number | null {
  let value: unknown;
  try {
    value = JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
  if (!isRecord(value) || value.schemaVersion !== 1 ||
      typeof value.storageVersion !== "number" || !Number.isInteger(value.storageVersion)) {
    return null;
  }
  return value.storageVersion;
}

function backupId(createdAt: string): string {
  return `backup-${createdAt.replaceAll(":", "-").replaceAll(".", "-")}`;
}

function assertBackupId(value: string): void {
  if (!BACKUP_ID_PATTERN.test(value)) throw new Error("Storage backup id is invalid.");
}

function canonicalInstant(now: Date): string {
  const value = now.toISOString();
  if (!isCanonicalInstant(value)) throw new Error("Storage backup time is invalid.");
  return value;
}

function isCanonicalInstant(value: string): boolean {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
