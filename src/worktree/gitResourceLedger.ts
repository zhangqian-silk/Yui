import {
  closeSync,
  constants,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  statSync,
  unlinkSync,
  writeSync
} from "node:fs";
import { createHash } from "node:crypto";
import { dirname, isAbsolute, join, relative, sep } from "node:path";
import { runtimeError } from "../errors/cliError.js";
import { MAX_AUTHORITATIVE_RECORD_BYTES } from "../storage/storageLimits.js";
import {
  parseFullLocalBranchRef,
  parseGitObjectFormat,
  parseRepositoryLineageId,
  type GitObjectFormat
} from "./gitCommand.js";

const DIRECTORY_OPEN_FLAGS = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW;
const RESOURCE_KEY_PATTERN = /^[0-9a-f]{64}$/;
const OPERATION_FILE_PATTERN = /^([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\.json$/;

/**
 * Exact-ref pending journals live below the authoritative storage root. The
 * native transaction/recovery reader admits a file at its cap, so reserve one
 * byte to make the nested journal invariant strictly below that cap.
 */
export const MAX_EXACT_REF_RETIREMENT_JOURNAL_BYTES = MAX_AUTHORITATIVE_RECORD_BYTES - 1;

export type GitRepositoryLineage = Readonly<{
  schemaVersion: 1;
  repositoryLineageId: string;
  canonicalCommonDir: string;
  commonDirDevice: string;
  commonDirInode: string;
  commonDirBirthtimeNs: string;
  objectFormat: GitObjectFormat;
}>;

export type GitExactRefResource = Readonly<{
  schemaVersion: 1;
  kind: "git-exact-ref-resource";
  repositoryLineageId: string;
  canonicalCommonDir: string;
  commonDirDevice: string;
  commonDirInode: string;
  commonDirBirthtimeNs: string;
  objectFormat: GitObjectFormat;
  fullRef: string;
  canonicalResourceIdentity: string;
  resourceKey: string;
  ledgerPath: string;
}>;

export type ExactRefRetirementLedgerPaths = Readonly<{
  pendingPath: string;
  publishedPath: string;
}>;

export type PendingExactRefRetirementLedgerRecord = Readonly<{
  operationId: string;
  resourceKey: string;
  ledgerPath: string;
  content: string;
}>;

export function createGitRepositoryLineage(input: {
  repositoryLineageId: string;
  commonDir: string;
  objectFormat: GitObjectFormat;
}): GitRepositoryLineage {
  const repositoryLineageId = parseRepositoryLineageId(input.repositoryLineageId);
  const canonicalCommonDir = canonicalDirectory(input.commonDir, "Git common directory");
  assertFilesRefBackend(canonicalCommonDir);
  const identity = directoryIdentity(canonicalCommonDir);
  return Object.freeze({
    schemaVersion: 1,
    repositoryLineageId,
    canonicalCommonDir,
    commonDirDevice: identity.device,
    commonDirInode: identity.inode,
    commonDirBirthtimeNs: identity.birthtimeNs,
    objectFormat: parseGitObjectFormat(input.objectFormat)
  });
}

export function assertGitRepositoryLineage(value: GitRepositoryLineage): GitRepositoryLineage {
  const lineage = parseGitRepositoryLineage(value);
  const canonicalCommonDir = canonicalDirectory(lineage.canonicalCommonDir, "Git common directory");
  assertFilesRefBackend(canonicalCommonDir);
  const identity = directoryIdentity(canonicalCommonDir);
  if (
    canonicalCommonDir !== lineage.canonicalCommonDir ||
    identity.device !== lineage.commonDirDevice ||
    identity.inode !== lineage.commonDirInode ||
    identity.birthtimeNs !== lineage.commonDirBirthtimeNs
  ) {
    throw runtimeError("Git repository lineage identity changed.");
  }
  return lineage;
}

export function canonicalExactRefResourceIdentity(
  repository: GitRepositoryLineage,
  fullRef: string
): string {
  const lineage = parseGitRepositoryLineage(repository);
  return JSON.stringify({
    schemaVersion: 1,
    kind: "git-exact-ref-resource",
    repositoryLineageId: lineage.repositoryLineageId,
    canonicalCommonDir: lineage.canonicalCommonDir,
    commonDirDevice: lineage.commonDirDevice,
    commonDirInode: lineage.commonDirInode,
    commonDirBirthtimeNs: lineage.commonDirBirthtimeNs,
    objectFormat: lineage.objectFormat,
    fullRef: parseFullLocalBranchRef(fullRef)
  });
}

/**
 * Immutable resource records and staged/published exact-ref journals. The
 * caller chooses the ledger root: production lifecycle coordination supplies
 * a TaskMux authoritative working root, while the physical foundation remains
 * independently recoverable for crash tests and offline maintenance.
 */
export class GitResourceLedger {
  readonly ledgerRoot: string;

  constructor(ledgerRoot: string) {
    this.ledgerRoot = ensureDirectory(ledgerRoot, "Git resource ledger");
  }

  ensureExactRefResource(repository: GitRepositoryLineage, fullRef: string): GitExactRefResource {
    const lineage = assertGitRepositoryLineage(repository);
    this.ensureRepositoryLineageBinding(lineage);
    const ref = parseFullLocalBranchRef(fullRef);
    const canonicalResourceIdentity = canonicalExactRefResourceIdentity(lineage, ref);
    const resourceKey = sha256(canonicalResourceIdentity);
    const directory = ensureDirectory(
      join(this.ledgerRoot, "resources", lineage.repositoryLineageId),
      "Git resource ledger"
    );
    const ledgerPath = safeChildPath(directory, `${resourceKey}.json`, "Git resource ledger");
    const expected = Object.freeze({
      schemaVersion: 1 as const,
      kind: "git-exact-ref-resource" as const,
      repositoryLineageId: lineage.repositoryLineageId,
      canonicalCommonDir: lineage.canonicalCommonDir,
      commonDirDevice: lineage.commonDirDevice,
      commonDirInode: lineage.commonDirInode,
      commonDirBirthtimeNs: lineage.commonDirBirthtimeNs,
      objectFormat: lineage.objectFormat,
      fullRef: ref,
      canonicalResourceIdentity,
      resourceKey,
      ledgerPath
    });
    const content = `${JSON.stringify(expected, null, 2)}\n`;
    if (fileExists(ledgerPath)) {
      const existing = parseStoredExactRefResource(readRegularText(ledgerPath, "Git resource ledger"), ledgerPath);
      if (JSON.stringify(existing) !== JSON.stringify(expected)) {
        throw runtimeError("Git resource ledger identity conflict.");
      }
      return existing;
    }
    try {
      writeNewDurableText(ledgerPath, content, "Git resource ledger");
    } catch (error) {
      if (!fileExists(ledgerPath)) throw error;
      const existing = parseStoredExactRefResource(readRegularText(ledgerPath, "Git resource ledger"), ledgerPath);
      if (JSON.stringify(existing) !== JSON.stringify(expected)) {
        throw runtimeError("Git resource ledger identity conflict.");
      }
      return existing;
    }
    return expected;
  }

  exactRefRetirementPaths(resource: GitExactRefResource, operationId: string): ExactRefRetirementLedgerPaths {
    const checked = parseExactRefResource(resource, resource.ledgerPath);
    const id = parseRepositoryLineageId(operationId);
    const pendingRoot = ensureDirectory(
      join(this.ledgerRoot, "pending-exact-ref-retirements", checked.repositoryLineageId, checked.resourceKey),
      "Git exact-ref retirement ledger"
    );
    const publishedRoot = ensureDirectory(
      join(this.ledgerRoot, "retired-exact-refs", checked.repositoryLineageId, checked.resourceKey),
      "Git exact-ref retirement ledger"
    );
    return Object.freeze({
      pendingPath: safeChildPath(pendingRoot, `${id}.json`, "Git exact-ref retirement ledger"),
      publishedPath: safeChildPath(publishedRoot, `${id}.json`, "Git exact-ref retirement ledger")
    });
  }

  stageExactRefRetirement(resource: GitExactRefResource, operationId: string, content: string): ExactRefRetirementLedgerPaths {
    const paths = this.exactRefRetirementPaths(resource, operationId);
    assertExactRefRetirementJournalSize(content);
    writeOrVerify(paths.pendingPath, content, "Git exact-ref retirement journal conflict.");
    return paths;
  }

  publishExactRefRetirement(resource: GitExactRefResource, operationId: string, content: string): ExactRefRetirementLedgerPaths {
    const paths = this.exactRefRetirementPaths(resource, operationId);
    writeOrVerify(paths.publishedPath, content, "Git exact-ref retirement publication conflict.");
    return paths;
  }

  readPublishedExactRefRetirement(resource: GitExactRefResource, operationId: string): string | null {
    const paths = this.exactRefRetirementPaths(resource, operationId);
    return fileExists(paths.publishedPath)
      ? readRegularText(paths.publishedPath, "Git exact-ref retirement ledger")
      : null;
  }

  removeStagedExactRefRetirement(resource: GitExactRefResource, operationId: string, expectedContent: string): void {
    const paths = this.exactRefRetirementPaths(resource, operationId);
    if (!fileExists(paths.pendingPath)) return;
    if (readRegularText(paths.pendingPath, "Git exact-ref retirement ledger") !== expectedContent) {
      throw runtimeError("Git exact-ref retirement journal changed before cleanup.");
    }
    unlinkSync(paths.pendingPath);
    fsyncDirectory(dirname(paths.pendingPath));
  }

  listStagedExactRefRetirements(repository: GitRepositoryLineage): PendingExactRefRetirementLedgerRecord[] {
    const lineage = assertGitRepositoryLineage(repository);
    this.ensureRepositoryLineageBinding(lineage);
    const root = join(this.ledgerRoot, "pending-exact-ref-retirements", lineage.repositoryLineageId);
    if (!fileExists(root)) return [];
    assertDirectory(root, "Git exact-ref retirement ledger");
    const result: PendingExactRefRetirementLedgerRecord[] = [];
    for (const resourceKey of sortedDirectoryNames(root, RESOURCE_KEY_PATTERN, "Git exact-ref retirement ledger")) {
      const directory = safeChildPath(root, resourceKey, "Git exact-ref retirement ledger");
      assertDirectory(directory, "Git exact-ref retirement ledger");
      for (const name of sortedDirectoryNames(directory, OPERATION_FILE_PATTERN, "Git exact-ref retirement ledger")) {
        const match = OPERATION_FILE_PATTERN.exec(name);
        if (match === null) throw runtimeError("Invalid Git exact-ref retirement ledger entry.");
        const ledgerPath = safeChildPath(directory, name, "Git exact-ref retirement ledger");
        result.push(Object.freeze({
          operationId: match[1],
          resourceKey,
          ledgerPath,
          content: readRegularText(ledgerPath, "Git exact-ref retirement ledger")
        }));
      }
    }
    return result;
  }

  private ensureRepositoryLineageBinding(repository: GitRepositoryLineage): void {
    const canonicalRepositoryIdentity = JSON.stringify({
      schemaVersion: 1,
      kind: "git-repository-lineage",
      canonicalCommonDir: repository.canonicalCommonDir,
      commonDirDevice: repository.commonDirDevice,
      commonDirInode: repository.commonDirInode,
      commonDirBirthtimeNs: repository.commonDirBirthtimeNs,
      objectFormat: repository.objectFormat
    });
    const root = ensureDirectory(join(this.ledgerRoot, "repository-lineages"), "Git resource ledger");
    const byRepository = ensureDirectory(join(root, "by-repository"), "Git resource ledger");
    const byLineage = ensureDirectory(join(root, "by-lineage"), "Git resource ledger");
    const repositoryPath = safeChildPath(byRepository, `${sha256(canonicalRepositoryIdentity)}.json`, "Git resource ledger");
    const lineagePath = safeChildPath(byLineage, `${repository.repositoryLineageId}.json`, "Git resource ledger");
    const binding = `${JSON.stringify({
      schemaVersion: 1,
      kind: "git-repository-lineage-binding",
      repositoryLineageId: repository.repositoryLineageId,
      canonicalRepositoryIdentity
    }, null, 2)}\n`;
    writeOrVerify(repositoryPath, binding, "Git repository lineage binding conflict.");
    writeOrVerify(lineagePath, binding, "Git repository lineage binding conflict.");
  }
}

function parseGitRepositoryLineage(value: unknown): GitRepositoryLineage {
  const record = exactRecord(value, "Git repository lineage");
  requireKeys(record, [
    "schemaVersion",
    "repositoryLineageId",
    "canonicalCommonDir",
    "commonDirDevice",
    "commonDirInode",
    "commonDirBirthtimeNs",
    "objectFormat"
  ], "Git repository lineage");
  if (
    record.schemaVersion !== 1 ||
    typeof record.canonicalCommonDir !== "string" ||
    typeof record.commonDirDevice !== "string" ||
    typeof record.commonDirInode !== "string" ||
    typeof record.commonDirBirthtimeNs !== "string"
  ) {
    throw runtimeError("Invalid Git repository lineage.");
  }
  return Object.freeze({
    schemaVersion: 1,
    repositoryLineageId: parseRepositoryLineageId(record.repositoryLineageId),
    canonicalCommonDir: record.canonicalCommonDir,
    commonDirDevice: record.commonDirDevice,
    commonDirInode: record.commonDirInode,
    commonDirBirthtimeNs: record.commonDirBirthtimeNs,
    objectFormat: parseGitObjectFormat(record.objectFormat)
  });
}

function parseExactRefResource(value: unknown, expectedPath: string): GitExactRefResource {
  const record = exactRecord(value, "Git exact-ref resource");
  requireKeys(record, [
    "schemaVersion",
    "kind",
    "repositoryLineageId",
    "canonicalCommonDir",
    "commonDirDevice",
    "commonDirInode",
    "commonDirBirthtimeNs",
    "objectFormat",
    "fullRef",
    "canonicalResourceIdentity",
    "resourceKey",
    "ledgerPath"
  ], "Git exact-ref resource");
  if (
    record.schemaVersion !== 1 ||
    record.kind !== "git-exact-ref-resource" ||
    typeof record.canonicalCommonDir !== "string" ||
    typeof record.commonDirDevice !== "string" ||
    typeof record.commonDirInode !== "string" ||
    typeof record.commonDirBirthtimeNs !== "string" ||
    typeof record.canonicalResourceIdentity !== "string" ||
    typeof record.resourceKey !== "string" ||
    !RESOURCE_KEY_PATTERN.test(record.resourceKey) ||
    record.ledgerPath !== expectedPath
  ) {
    throw runtimeError("Invalid Git exact-ref resource.");
  }
  const resource = Object.freeze({
    schemaVersion: 1 as const,
    kind: "git-exact-ref-resource" as const,
    repositoryLineageId: parseRepositoryLineageId(record.repositoryLineageId),
    canonicalCommonDir: record.canonicalCommonDir,
    commonDirDevice: record.commonDirDevice,
    commonDirInode: record.commonDirInode,
    commonDirBirthtimeNs: record.commonDirBirthtimeNs,
    objectFormat: parseGitObjectFormat(record.objectFormat),
    fullRef: parseFullLocalBranchRef(record.fullRef),
    canonicalResourceIdentity: record.canonicalResourceIdentity,
    resourceKey: record.resourceKey,
    ledgerPath: expectedPath
  });
  const lineage = Object.freeze({
    schemaVersion: 1 as const,
    repositoryLineageId: resource.repositoryLineageId,
    canonicalCommonDir: resource.canonicalCommonDir,
    commonDirDevice: resource.commonDirDevice,
    commonDirInode: resource.commonDirInode,
    commonDirBirthtimeNs: resource.commonDirBirthtimeNs,
    objectFormat: resource.objectFormat
  });
  if (
    resource.canonicalResourceIdentity !== canonicalExactRefResourceIdentity(lineage, resource.fullRef) ||
    resource.resourceKey !== sha256(resource.canonicalResourceIdentity)
  ) {
    throw runtimeError("Git exact-ref resource identity is invalid.");
  }
  return resource;
}

function parseStoredExactRefResource(content: string, expectedPath: string): GitExactRefResource {
  try {
    return parseExactRefResource(JSON.parse(content) as unknown, expectedPath);
  } catch (error) {
    if (error instanceof Error && "code" in error) throw error;
    throw runtimeError("Invalid Git exact-ref resource.");
  }
}

function canonicalDirectory(path: string, label: string): string {
  if (typeof path !== "string" || path.length === 0) throw runtimeError(`${label} is invalid.`);
  const metadata = lstatSync(path, { throwIfNoEntry: false });
  if (metadata === undefined || metadata.isSymbolicLink() || !metadata.isDirectory()) {
    throw runtimeError(`${label} must be an exact directory.`);
  }
  const canonical = realpathSync(path);
  const canonicalMetadata = lstatSync(canonical, { throwIfNoEntry: false });
  if (canonicalMetadata === undefined || canonicalMetadata.isSymbolicLink() || !canonicalMetadata.isDirectory()) {
    throw runtimeError(`${label} must be an exact directory.`);
  }
  return canonical;
}

function assertFilesRefBackend(commonDir: string): void {
  const reftable = lstatSync(join(commonDir, "reftable"), { throwIfNoEntry: false });
  if (reftable !== undefined) {
    throw runtimeError("Git reftable references are not supported by exact-ref retirement.");
  }
}

function directoryIdentity(path: string): { device: string; inode: string; birthtimeNs: string } {
  const metadata = statSync(path, { bigint: true });
  return {
    device: String(metadata.dev),
    inode: String(metadata.ino),
    birthtimeNs: String(metadata.birthtimeNs)
  };
}

function ensureDirectory(path: string, label: string): string {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  assertDirectory(path, label);
  return realpathSync(path);
}

function assertDirectory(path: string, label: string): void {
  const metadata = lstatSync(path, { throwIfNoEntry: false });
  if (metadata === undefined || metadata.isSymbolicLink() || !metadata.isDirectory()) {
    throw runtimeError(`${label} has a hostile directory.`);
  }
}

function safeChildPath(directory: string, child: string, label: string): string {
  if (child.length === 0 || child.includes("/") || child.includes("\\") || child === "." || child === "..") {
    throw runtimeError(`${label} has an invalid path.`);
  }
  const target = join(directory, child);
  const relation = relative(directory, target);
  if (
    relation.length === 0 ||
    relation === ".." ||
    relation.startsWith(`..${sep}`) ||
    isAbsolute(relation)
  ) {
    throw runtimeError(`${label} has an invalid path.`);
  }
  return target;
}

function fileExists(path: string): boolean {
  return lstatSync(path, { throwIfNoEntry: false }) !== undefined;
}

function assertExactRefRetirementJournalSize(content: string): void {
  if (
    typeof content !== "string" ||
    Buffer.byteLength(content, "utf8") > MAX_EXACT_REF_RETIREMENT_JOURNAL_BYTES
  ) {
    throw runtimeError("Git exact-ref retirement journal exceeds the authoritative storage record limit.");
  }
}

function readRegularText(path: string, label: string): string {
  const metadata = lstatSync(path, { throwIfNoEntry: false });
  if (metadata === undefined || metadata.isSymbolicLink() || !metadata.isFile() || metadata.nlink !== 1) {
    throw runtimeError(`${label} is invalid.`);
  }
  if ((metadata.mode & 0o077) !== 0) throw runtimeError(`${label} permissions are invalid.`);
  return readFileSync(path, "utf8");
}

function writeOrVerify(path: string, content: string, conflict: string): void {
  if (fileExists(path)) {
    if (readRegularText(path, "Git resource ledger") !== content) throw runtimeError(conflict);
    return;
  }
  try {
    writeNewDurableText(path, content, "Git resource ledger");
  } catch {
    if (!fileExists(path) || readRegularText(path, "Git resource ledger") !== content) {
      throw runtimeError(conflict);
    }
  }
}

function writeNewDurableText(path: string, content: string, label: string): void {
  const descriptor = openSync(path, "wx", 0o600);
  try {
    const bytes = Buffer.from(content, "utf8");
    let offset = 0;
    while (offset < bytes.length) offset += writeSync(descriptor, bytes, offset);
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
  fsyncDirectory(dirname(path));
  if (readRegularText(path, label) !== content) throw runtimeError(`${label} could not be verified.`);
}

function fsyncDirectory(path: string): void {
  const descriptor = openSync(path, DIRECTORY_OPEN_FLAGS);
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

function sortedDirectoryNames(directory: string, pattern: RegExp, label: string): string[] {
  const names = readdirSync(directory).sort();
  for (const name of names) {
    if (!pattern.test(name)) throw runtimeError(`${label} contains an invalid entry.`);
  }
  return names;
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function exactRecord(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw runtimeError(`Invalid ${label}.`);
  }
  return value as Record<string, unknown>;
}

function requireKeys(record: Record<string, unknown>, expected: readonly string[], label: string): void {
  const actual = Object.keys(record);
  if (actual.length !== expected.length || expected.some((key) => !Object.hasOwn(record, key))) {
    throw runtimeError(`Invalid ${label}.`);
  }
}
