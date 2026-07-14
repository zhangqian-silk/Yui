import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import {
  createInertDataArray,
  createInertDataObject,
  createInertDataSnapshot,
  parseCanonicalInertData,
  stringifyCanonicalInertData,
  type InertDataEntry,
  type InertDataValue
} from "./inertData.js";
import {
  canonicalStorageOwnerUid,
  isAuthoritativeStorageTarget
} from "./authoritativeStorage.js";
import {
  acquireStableAncestorExclusiveBarrier,
  inspectDirectoryAt,
  linkPreparedFileNoReplace,
  mkdirExactNoReplace,
  publishAnonymousFileNoReplace,
  renameNoReplaceExact,
  releaseStableAncestorBarrier,
  withPinnedRootAt,
  type NativeExactIdentity,
  type NativePinnedRootReader,
  type NativePublicationReceipt,
  type NativeStableAncestorBarrier
} from "./nativeStorageFs.js";

export type DomainTransactionOperation =
  | { type: "write"; target: string; content: string }
  | { type: "delete"; target: string };

type StoredExactIdentity = {
  device: string;
  inode: string;
  birthtimeNs: string;
  uid: string;
  mode: string;
  nlink: string;
};

type StoredJournalReceipt = StoredExactIdentity & {
  path: string;
  sha256: string;
  byteLength: number;
};

type StoredFileState = StoredExactIdentity & {
  kind: "file";
  sha256: string;
  byteLength: number;
};

type StoredDirectoryState = StoredExactIdentity & {
  kind: "directory";
};

type StoredPathState = { kind: "absent" } | StoredFileState | StoredDirectoryState;
type StoredAncestor = { path: string; expected: StoredPathState };

type StoredOperation =
  | {
    type: "write";
    target: string;
    content: string;
    expectedBefore: Extract<StoredPathState, { kind: "absent" | "file" }>;
    desiredAfter: StoredFileState;
    ancestors: StoredAncestor[];
  }
  | {
    type: "mkdir";
    target: string;
    expectedBefore: { kind: "absent" };
    desiredAfter: StoredDirectoryState;
    ancestors: StoredAncestor[];
  }
  | {
    type: "delete";
    target: string;
    expectedBefore: StoredFileState;
    desiredAfter: { kind: "absent" };
    ancestors: StoredAncestor[];
  }
  | {
    type: "rmdir";
    target: string;
    expectedBefore: StoredDirectoryState;
    desiredAfter: { kind: "absent" };
    ancestors: StoredAncestor[];
  };

type StoredPublication = {
  operationIndex: number;
  kind: "file" | "directory";
  publishTarget: string;
  unitName: string;
  retiredName: string | null;
  entry: StoredFileState | StoredDirectoryState;
};

type StoredParentLinkTransition = {
  kind: "mkdir" | "rmdir";
  parent: string;
  target: string;
  before: StoredDirectoryState;
  after: StoredDirectoryState;
};

type DomainTransactionAuthority = "core" | "core+backups";

type DomainTransaction = {
  schemaVersion: 3;
  id: string;
  revision: number;
  previousReceipt: StoredJournalReceipt | null;
  authority: DomainTransactionAuthority;
  phase: "preparing" | "prepared" | "complete";
  generation: string | null;
  stagingParent: StoredDirectoryState | null;
  stagingParentAfter: StoredDirectoryState | null;
  operations: StoredOperation[];
  parentTransitions: StoredParentLinkTransition[];
  publications: StoredPublication[];
  createdAt: string;
};

type SnapshotWrite = {
  schemaVersion: 1;
  id: string;
  target: string;
  content: string;
  createdAt: string;
};

export type DomainTransactionApplyResult = "applied" | "recovered";

export type DomainTransactionFaultInjection = {
  initialAfterOperation?: number;
  recoveryAfterOperation?: number;
  initialAfterWriteStaging?: number;
  recoveryAfterWriteStaging?: number;
  initialAfterWritePrepared?: number;
  recoveryAfterWritePrepared?: number;
  initialAfterRetirement?: number;
  recoveryAfterRetirement?: number;
  failBeforeJournalRead?: boolean;
  failBeforeJournalRemove?: boolean;
};

export class DomainTransactionRecoveryError extends Error {
  constructor(
    readonly transactionId: string,
    readonly initialError: unknown,
    readonly recoveryError: unknown
  ) {
    super(`Domain transaction ${transactionId} could not complete synchronous recovery.`);
    this.name = "DomainTransactionRecoveryError";
  }
}

const DIRECTORY_FLAGS = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW;
const MAX_RECORD_BYTES = 16 * 1024 * 1024;
const FILE_MODE = 0o600;

/**
 * Runs synchronously with the only lock used by authoritative storage.  The
 * descriptor never leaves this closure; callers receive only the native opaque
 * barrier and all file authority remains descriptor-relative in the addon.
 */
export function withExclusiveStorageBarrier<T>(
  rootDir: string,
  callback: (barrier: NativeStableAncestorBarrier) => T
): T {
  const descriptor = openRootDirectory(rootDir);
  let barrier: NativeStableAncestorBarrier | undefined;
  try {
    barrier = acquireStableAncestorExclusiveBarrier(descriptor, descriptorIdentity(descriptor));
    assertExclusiveStorageRootPath(rootDir, barrier);
    const result = callback(barrier);
    rejectThenable(result);
    assertExclusiveStorageRootPath(rootDir, barrier);
    return result;
  } finally {
    if (barrier !== undefined) releaseStableAncestorBarrier(barrier);
    closeSync(descriptor);
  }
}

/**
 * Confirms that the caller-visible storage path still names the exact root
 * acquired by the opaque native barrier.  Writer code must run this check
 * immediately around every pathname-based journal or removal effect.
 */
export function assertExclusiveStorageRootPath(
  rootDir: string,
  barrier: NativeStableAncestorBarrier
): void {
  const expected = inspectRequiredDirectory(barrier, ".");
  let current;
  try {
    current = lstatSync(rootDir, { bigint: true });
  } catch {
    throw new Error("TaskMux storage writer root path identity changed.");
  }
  try {
    canonicalStorageOwnerUid(current);
  } catch {
    throw new Error("TaskMux storage writer root path identity changed.");
  }
  if (!current.isDirectory() || current.isSymbolicLink() ||
      current.dev !== expected.dev || current.ino !== expected.ino ||
      current.birthtimeNs !== expected.birthtimeNs || current.uid !== expected.uid ||
      current.mode !== expected.mode || current.nlink !== expected.nlink) {
    throw new Error("TaskMux storage writer root path identity changed.");
  }
}

export function stageDomainTransaction(
  rootDir: string,
  id: string,
  operations: DomainTransactionOperation[],
  options: { includeBackups?: boolean } = {}
): string {
  return withExclusiveStorageBarrier(rootDir, (barrier) =>
    stageDomainTransactionUnderBarrier(rootDir, barrier, id, operations, options)
  );
}

export function stageDomainTransactionUnderBarrier(
  rootDir: string,
  barrier: NativeStableAncestorBarrier,
  id: string,
  operations: DomainTransactionOperation[],
  options: { includeBackups?: boolean } = {}
): string {
  assertJournalId(id, "domain transaction");
  assertExclusiveStorageRootPath(rootDir, barrier);
  const authority: DomainTransactionAuthority = options.includeBackups === true
    ? "core+backups"
    : "core";
  ensurePrivateDirectoryUnderBarrier(barrier, domainTransactionRelativeDir());
  ensurePrivateDirectoryUnderBarrier(barrier, domainTransactionStagingRelativeDir());
  const requested = snapshotPublicOperations(operations);
  if (requested.length === 0) throw new Error("Domain transaction requires at least one operation.");
  const targets = requested.map((operation) =>
    journalTarget(rootDir, operation.target, authority)
  );
  assertNoOverlappingTargets(targets.map((target) => target.relative));

  const stored = withRootReader(barrier, (reader) => {
    const output: StoredOperation[] = [];
    const declaredMkdirs = new Set<string>();
    for (let index = 0; index < requested.length; index += 1) {
      const operation = requested[index];
      const target = targets[index];
      if (operation.type === "write") {
        const before = readPathState(reader, target.relative);
        if (before.kind !== "absent" && before.kind !== "file") {
          throw new Error("Domain transaction write target must be absent or a regular file.");
        }
        const desiredLogical = fileStateFromBytes(Buffer.from(operation.content, "utf8"));
        if (before.kind === "file" && sameLogicalFileState(before, desiredLogical)) {
          throw new Error("Domain transaction operation requires a state change.");
        }
        const ancestors = captureAncestors(reader, target.relative);
        for (const ancestor of ancestors) {
          if (ancestor.path === "." || ancestor.expected.kind !== "absent" ||
              declaredMkdirs.has(ancestor.path)) {
            continue;
          }
          declaredMkdirs.add(ancestor.path);
          output.push({
            type: "mkdir",
            target: ancestor.path,
            expectedBefore: { kind: "absent" },
            desiredAfter: placeholderDirectoryState(),
            ancestors: captureAncestors(reader, ancestor.path)
          });
        }
        output.push({
          type: "write",
          target: target.relative,
          content: operation.content,
          expectedBefore: before,
          desiredAfter: desiredLogical,
          ancestors
        });
        continue;
      }
      appendDeleteOperations(reader, target.relative, output);
    }
    return output;
  });

  if (stored.length === 0) throw new Error("Domain transaction requires a state change.");
  const transaction: DomainTransaction = {
    schemaVersion: 3,
    id,
    revision: 0,
    previousReceipt: null,
    authority,
    phase: "preparing",
    generation: null,
    stagingParent: null,
    stagingParentAfter: null,
    operations: stored,
    parentTransitions: [],
    publications: [],
    createdAt: new Date().toISOString()
  };
  publishInitialDomainTransaction(barrier, transaction);
  return domainTransactionFile(rootDir, id);
}

export function assertDomainTransactionId(id: string): void {
  assertJournalId(id, "domain transaction");
}

export function commitDomainTransaction(
  rootDir: string,
  id: string,
  operations: DomainTransactionOperation[]
): void {
  withExclusiveStorageBarrier(rootDir, (barrier) => {
    stageDomainTransactionUnderBarrier(rootDir, barrier, id, operations);
    applyStagedDomainTransactionUnderBarrier(rootDir, barrier, id);
  });
}

export function applyStagedDomainTransaction(
  rootDir: string,
  id: string,
  faultInjection: DomainTransactionFaultInjection = {}
): DomainTransactionApplyResult {
  return withExclusiveStorageBarrier(rootDir, (barrier) =>
    applyStagedDomainTransactionUnderBarrier(rootDir, barrier, id, faultInjection)
  );
}

export function applyStagedDomainTransactionUnderBarrier(
  rootDir: string,
  barrier: NativeStableAncestorBarrier,
  id: string,
  faultInjection: DomainTransactionFaultInjection = {}
): DomainTransactionApplyResult {
  assertJournalId(id, "domain transaction");
  let transaction: DomainTransaction;
  try {
    if (faultInjection.failBeforeJournalRead === true) {
      throw new Error("Injected domain transaction journal read failure.");
    }
    transaction = readDomainTransaction(rootDir, id, barrier);
  } catch (error) {
    throw new DomainTransactionRecoveryError(id, error, error);
  }

  let result: DomainTransactionApplyResult = "applied";
  try {
    applyTransaction(rootDir, barrier, transaction, "initial", faultInjection);
  } catch (initialError) {
    try {
      transaction = readDomainTransaction(rootDir, id, barrier);
      applyTransaction(rootDir, barrier, transaction, "recovery", faultInjection);
      result = "recovered";
    } catch (recoveryError) {
      throw new DomainTransactionRecoveryError(id, initialError, recoveryError);
    }
  }
  finalizeTransaction(rootDir, barrier, transaction, faultInjection);
  return result;
}

export function replayPendingDomainTransactions(rootDir: string): string[] {
  return withExclusiveStorageBarrier(rootDir, (barrier) =>
    replayPendingDomainTransactionsUnderBarrier(rootDir, barrier)
  );
}

export function replayPendingDomainTransactionsUnderBarrier(
  rootDir: string,
  barrier: NativeStableAncestorBarrier
): string[] {
  assertExclusiveStorageRootPath(rootDir, barrier);
  const replayed: string[] = [];
  for (const id of listPendingDomainTransactionIds(barrier)) {
    try {
      const transaction = readDomainTransaction(rootDir, id, barrier);
      applyTransaction(rootDir, barrier, transaction, "replay", {});
      finalizeTransaction(rootDir, barrier, transaction, {});
      replayed.push(id);
    } catch (error) {
      if (error instanceof DomainTransactionRecoveryError) throw error;
      throw new DomainTransactionRecoveryError(id, error, error);
    }
  }
  return replayed;
}

export function hasPendingDomainTransactions(rootDir: string): boolean {
  return withExclusiveStorageBarrier(
    rootDir,
    (barrier) => listPendingDomainTransactionIds(barrier).length > 0
  );
}

function applyTransaction(
  rootDir: string,
  barrier: NativeStableAncestorBarrier,
  transaction: DomainTransaction,
  phase: "initial" | "recovery" | "replay",
  faultInjection: DomainTransactionFaultInjection
): void {
  if (transaction.phase === "preparing") {
    prepareTransaction(rootDir, barrier, transaction, phase, faultInjection);
  }
  validatePreparedTransaction(transaction);
  if (transaction.phase === "complete") return;
  const firstUncommitted = preflightTransaction(barrier, transaction);
  let appliedOperationCount = 0;
  for (let index = firstUncommitted; index < transaction.operations.length; index += 1) {
    const operation = transaction.operations[index];
    if (operationCommitState(barrier, transaction, index, operation) === "after") {
      continue;
    }
    applyOperation(rootDir, barrier, transaction, index, operation, phase, faultInjection);
    assertOperationMatchesAfter(barrier, transaction, index, operation);
    appliedOperationCount += 1;
    assertDomainTransactionApplyFailpoint(appliedOperationCount, phase, faultInjection);
  }
}

function prepareTransaction(
  rootDir: string,
  barrier: NativeStableAncestorBarrier,
  transaction: DomainTransaction,
  phase: "initial" | "recovery" | "replay",
  faultInjection: DomainTransactionFaultInjection
): void {
  if (transaction.generation === null) {
    transaction.generation = randomUUID();
    persistDomainTransaction(rootDir, barrier, transaction);
  }
  const stageRelative = preparedGenerationRelative(transaction);
  const stagingDirectory = domainTransactionStagingRelativeDir();
  ensurePrivateDirectoryUnderBarrier(barrier, stagingDirectory);
  if (inspectDirectoryAt(barrier, stageRelative) === undefined) {
    const parent = inspectRequiredDirectory(barrier, stagingDirectory);
    mkdirExactNoReplace(
      barrier,
      stagingDirectory,
      parent,
      basenameOf(stageRelative)
    );
  }

  prepareDirectoryOperations(rootDir, barrier, transaction);
  const publications: StoredPublication[] = [];
  for (let index = 0; index < transaction.operations.length; index += 1) {
    const operation = transaction.operations[index];
    if (operation.type !== "write") continue;
    const unitName = `unit-${index}`;
    const stageParent = inspectRequiredDirectory(barrier, stageRelative);
    const unitPath = `${stageRelative}/${unitName}`;
    let receipt = inspectOptionalReceipt(barrier, unitPath);
    if (receipt === undefined) {
      receipt = publishPreparedFile(barrier, stageRelative, stageParent, unitName, operation.content);
    } else {
      if (!isFileReceipt(receipt)) {
        throw new Error("Prepared transaction unit is not a regular file.");
      }
      const read = withRootReader(barrier, (reader) =>
        reader.readFileExact(unitPath, MAX_RECORD_BYTES)
      );
      if (!sameNativeExactIdentity(read.identity, receipt) ||
          !read.bytes.equals(Buffer.from(operation.content, "utf8"))) {
        throw new Error("Prepared transaction unit changed.");
      }
    }
    const entry = fileStateFromReceipt(receipt, Buffer.from(operation.content, "utf8"));
    operation.desiredAfter = {
      ...entry,
      nlink: String(BigInt(entry.nlink) + 1n)
    };
    publications.push({
      operationIndex: index,
      kind: "file",
      publishTarget: operation.target,
      unitName,
      retiredName: operation.expectedBefore.kind === "file" ? `retired-${index}` : null,
      entry
    });
  }

  const writeCount = publications.filter((publication) => publication.kind === "file").length;
  assertWritePublicationFailpoint(writeCount, "staging", phase, faultInjection);
  transaction.publications = publications;
  transaction.parentTransitions = captureParentTransitions(transaction);
  transaction.stagingParent = directoryStateFromIdentity(inspectRequiredDirectory(barrier, stageRelative));
  transaction.stagingParentAfter = expectedStageParentAfter(transaction);
  transaction.phase = "prepared";
  persistDomainTransaction(rootDir, barrier, transaction);
  assertWritePublicationFailpoint(writeCount, "prepared", phase, faultInjection);
}

function prepareDirectoryOperations(
  rootDir: string,
  barrier: NativeStableAncestorBarrier,
  transaction: DomainTransaction
): void {
  for (let index = 0; index < transaction.operations.length; index += 1) {
    const operation = transaction.operations[index];
    if (operation.type !== "mkdir") continue;
    const current = inspectOptionalReceipt(barrier, operation.target);
    if (current !== undefined) {
      if (!isDirectoryReceipt(current)) {
        throw new Error("Prepared directory target is not a real directory.");
      }
      if (isPhysicalDirectoryState(operation.desiredAfter) &&
          !sameDirectoryWithPermittedLinkCount(current, operation.desiredAfter, transaction, index)) {
        throw new Error("Prepared directory identity changed.");
      }
      operation.desiredAfter = directoryStateFromIdentity(current);
      persistDomainTransaction(rootDir, barrier, transaction);
      continue;
    }
    const parentPath = parentRelativePath(operation.target);
    const expectedParent = expectedParentForOperation(transaction, index, parentPath);
    const created = mkdirExactNoReplace(
      barrier,
      parentPath,
      nativeIdentity(expectedParent),
      basenameOf(operation.target)
    );
    operation.desiredAfter = directoryStateFromIdentity(created);
    persistDomainTransaction(rootDir, barrier, transaction);
  }
}

function preflightTransaction(
  barrier: NativeStableAncestorBarrier,
  transaction: DomainTransaction
): number {
  let firstUncommitted = transaction.operations.length;
  let sawUncommitted = false;
  for (let index = 0; index < transaction.operations.length; index += 1) {
    const operation = transaction.operations[index];
    const state = operationCommitState(barrier, transaction, index, operation);
    if (state === "after") {
      if (sawUncommitted && operation.type !== "mkdir") {
        throw new Error("Domain transaction state is not a monotonic committed prefix.");
      }
      assertOperationMatchesAfter(barrier, transaction, index, operation);
      continue;
    }
    if (!sawUncommitted) {
      firstUncommitted = index;
      sawUncommitted = true;
    }
    if (state === "before" || state === "retired") {
      assertOperationMatchesBefore(barrier, transaction, index, operation);
      continue;
    }
    throw new Error("Domain transaction compare-and-swap precondition changed.");
  }
  return firstUncommitted;
}

function applyOperation(
  rootDir: string,
  barrier: NativeStableAncestorBarrier,
  transaction: DomainTransaction,
  index: number,
  operation: StoredOperation,
  phase: "initial" | "recovery" | "replay",
  faultInjection: DomainTransactionFaultInjection
): void {
  const state = operationCommitState(barrier, transaction, index, operation);
  if (state === "after") return;
  if (state === "mismatch") {
    throw new Error("Domain transaction compare-and-swap precondition changed.");
  }
  if (operation.type === "mkdir") {
    throw new Error("Prepared directory target disappeared before publication.");
  }
  if (operation.type === "write") {
    publishPreparedFileOperation(
      rootDir,
      barrier,
      transaction,
      index,
      operation,
      state,
      phase,
      faultInjection
    );
    return;
  }
  moveDeletedOperation(barrier, transaction, index, operation, phase, faultInjection);
}

function publishPreparedFileOperation(
  rootDir: string,
  barrier: NativeStableAncestorBarrier,
  transaction: DomainTransaction,
  index: number,
  operation: Extract<StoredOperation, { type: "write" }>,
  state: "before" | "retired",
  phase: "initial" | "recovery" | "replay",
  faultInjection: DomainTransactionFaultInjection
): void {
  const publication = publicationForOperation(transaction, index, "file");
  const stageRelative = preparedGenerationRelative(transaction);
  const parentPath = parentRelativePath(operation.target);
  const expectedParent = expectedParentForOperation(transaction, index, parentPath);
  if (state === "before" && operation.expectedBefore.kind === "file") {
    const current = inspectRequiredReceipt(barrier, operation.target);
    if (!filePathMatchesState(
      barrier,
      operation.target,
      operation.expectedBefore
    )) {
      throw new Error("Domain transaction write source changed before retirement.");
    }
    if (publication.retiredName === null) {
      throw new Error("Prepared overwrite retirement is missing.");
    }
    renameNoReplaceExact(
      barrier,
      parentPath,
      nativeIdentity(expectedParent),
      basenameOf(operation.target),
      current,
      stageRelative,
      nativeIdentity(expectedStageParentBeforeOperation(transaction, index)),
      publication.retiredName
    );
    assertRetirementFailpoint(index + 1, phase, faultInjection);
  }
  if (state === "retired") {
    if (operation.expectedBefore.kind !== "file" || publication.retiredName === null) {
      throw new Error("Prepared overwrite retirement is missing.");
    }
    const retiredPath = `${stageRelative}/${publication.retiredName}`;
    if (!filePathMatchesState(barrier, retiredPath, operation.expectedBefore)) {
      throw new Error("Domain transaction retired source changed before publication.");
    }
  }
  const sourcePath = `${stageRelative}/${publication.unitName}`;
  const source = inspectRequiredReceipt(barrier, sourcePath);
  if (!filePathMatchesState(barrier, sourcePath, filePublicationEntry(publication))) {
    throw new Error("Prepared file identity changed.");
  }
  linkPreparedFileNoReplace(
    barrier,
    stageRelative,
    nativeIdentity(expectedStageParentBeforeOperation(transaction, index)),
    publication.unitName,
    source,
    parentPath,
    nativeIdentity(expectedParent),
    basenameOf(operation.target)
  );
}

function moveDeletedOperation(
  barrier: NativeStableAncestorBarrier,
  transaction: DomainTransaction,
  index: number,
  operation: Extract<StoredOperation, { type: "delete" | "rmdir" }>,
  phase: "initial" | "recovery" | "replay",
  faultInjection: DomainTransactionFaultInjection
): void {
  const current = inspectRequiredReceipt(barrier, operation.target);
  const expectedMatches = operation.type === "rmdir"
    ? sameDirectoryWithPermittedLinkCount(
      current,
      operation.expectedBefore,
      transaction,
      index
    )
    : pathMatchesState(barrier, operation.target, current, operation.expectedBefore);
  if (!expectedMatches) {
    throw new Error("Domain transaction delete source changed.");
  }
  const parentPath = parentRelativePath(operation.target);
  renameNoReplaceExact(
    barrier,
    parentPath,
    nativeIdentity(expectedParentForOperation(transaction, index, parentPath)),
    basenameOf(operation.target),
    current,
    preparedGenerationRelative(transaction),
    nativeIdentity(expectedStageParentBeforeOperation(transaction, index)),
    `deleted-${index}`
  );
  assertRetirementFailpoint(index + 1, phase, faultInjection);
}

function operationCommitState(
  barrier: NativeStableAncestorBarrier,
  transaction: DomainTransaction,
  index: number,
  operation: StoredOperation
): "before" | "after" | "retired" | "mismatch" {
  if (operation.type === "write") {
    const publication = publicationForOperation(transaction, index, "file");
    const target = inspectOptionalReceipt(barrier, operation.target);
    const stagePath = `${preparedGenerationRelative(transaction)}/${publication.unitName}`;
    const stage = inspectOptionalReceipt(barrier, stagePath);
    if (target !== undefined && filePathMatchesState(
      barrier,
      operation.target,
      operation.desiredAfter
    )) {
      if (stage !== undefined && !filePathMatchesState(
        barrier,
        stagePath,
        filePublicationEntry(publication),
        true
      )) {
        return "mismatch";
      }
      return "after";
    }
    if (target !== undefined && operation.expectedBefore.kind === "file" &&
        filePathMatchesState(barrier, operation.target, operation.expectedBefore) &&
        stage !== undefined && filePathMatchesState(
          barrier,
          stagePath,
          filePublicationEntry(publication)
        )) {
      return "before";
    }
    if (target === undefined && operation.expectedBefore.kind === "absent" &&
        stage !== undefined && filePathMatchesState(
          barrier,
          stagePath,
          filePublicationEntry(publication)
        )) {
      return "before";
    }
    const retired = publication.retiredName === null
      ? undefined
      : inspectOptionalReceipt(
        barrier,
        `${preparedGenerationRelative(transaction)}/${publication.retiredName}`
      );
    const retiredPath = publication.retiredName === null
      ? undefined
      : `${preparedGenerationRelative(transaction)}/${publication.retiredName}`;
    if (target === undefined && retired !== undefined && operation.expectedBefore.kind === "file" &&
        retiredPath !== undefined &&
        filePathMatchesState(barrier, retiredPath, operation.expectedBefore) &&
        stage !== undefined && filePathMatchesState(
          barrier,
          stagePath,
          filePublicationEntry(publication)
        )) {
      return "retired";
    }
    if (target === undefined && operation.expectedBefore.kind === "file" &&
        publication.retiredName === null && stage !== undefined &&
        filePathMatchesState(barrier, stagePath, filePublicationEntry(publication))) {
      return "retired";
    }
    return "mismatch";
  }
  const current = inspectOptionalReceipt(barrier, operation.target);
  if (operation.type === "mkdir") {
    if (current === undefined) return "before";
    return sameDirectoryWithPermittedLinkCount(current, operation.desiredAfter, transaction, index)
      ? "after"
      : "mismatch";
  }
  if (current === undefined) return "after";
  return operation.type === "rmdir"
    ? sameDirectoryWithPermittedLinkCount(current, operation.expectedBefore, transaction, index)
      ? "before"
      : "mismatch"
    : filePathMatchesState(
      barrier,
      operation.target,
      operation.expectedBefore
    ) ? "before" : "mismatch";
}

function assertOperationMatchesBefore(
  barrier: NativeStableAncestorBarrier,
  transaction: DomainTransaction,
  index: number,
  operation: StoredOperation
): void {
  assertAncestors(barrier, transaction, index, operation, "before");
  const state = operationCommitState(barrier, transaction, index, operation);
  if (state !== "before" && state !== "retired") {
    throw new Error("Domain transaction before-state changed.");
  }
}

function assertOperationMatchesAfter(
  barrier: NativeStableAncestorBarrier,
  transaction: DomainTransaction,
  index: number,
  operation: StoredOperation
): void {
  assertAncestors(barrier, transaction, index, operation, "after");
  const state = operationCommitState(barrier, transaction, index, operation);
  if (state !== "after") throw new Error("Domain transaction desired state was not published exactly.");
}

function assertAncestors(
  barrier: NativeStableAncestorBarrier,
  transaction: DomainTransaction,
  index: number,
  operation: StoredOperation,
  phase: "before" | "after"
): void {
  for (const ancestor of operation.ancestors) {
    const current = inspectOptionalReceipt(barrier, ancestor.path);
    const expected = expectedAncestorState(
      barrier,
      transaction,
      index,
      ancestor.path,
      ancestor.expected,
      phase
    );
    if (expected.kind === "absent") {
      if (current !== undefined) throw new Error("Domain transaction ancestor unexpectedly exists.");
      continue;
    }
    if (expected.kind !== "directory") {
      throw new Error("Domain transaction ancestor is not a directory.");
    }
    if (current === undefined || !sameDirectoryWithPermittedLinkCount(
      current,
      expected,
      transaction,
      index
    )) {
      throw new Error("Domain transaction ancestor identity changed.");
    }
  }
}

function expectedAncestorState(
  barrier: NativeStableAncestorBarrier,
  transaction: DomainTransaction,
  index: number,
  path: string,
  captured: StoredPathState,
  phase: "before" | "after"
): StoredPathState {
  let expected = captured;
  const lastRelevantIndex = phase === "after" ? index : index - 1;
  for (let candidateIndex = 0; candidateIndex <= lastRelevantIndex; candidateIndex += 1) {
    const candidate = transaction.operations[candidateIndex];
    if (candidate === undefined || candidate.target !== path ||
        (candidate.type !== "mkdir" && candidate.type !== "rmdir")) {
      continue;
    }
    if (operationCommitState(barrier, transaction, candidateIndex, candidate) !== "after") {
      continue;
    }
    expected = candidate.desiredAfter;
  }
  return expected;
}

function expectedParentForOperation(
  transaction: DomainTransaction,
  operationIndex: number,
  parentPath: string
): StoredDirectoryState {
  let expected = declaredDirectoryState(transaction, parentPath);
  for (let index = 0; index < transaction.operations.length; index += 1) {
    const operation = transaction.operations[index];
    if (operation === undefined || parentRelativePath(operation.target) !== parentPath) {
      continue;
    }
    if (operation.type === "mkdir" && isPhysicalDirectoryState(operation.desiredAfter)) {
      expected = transitionDirectoryLinkState(expected, operation.type);
      continue;
    }
    if (operation.type === "rmdir" && index < operationIndex) {
      expected = transitionDirectoryLinkState(expected, operation.type);
    }
  }
  return expected;
}

function expectedStageParentBeforeOperation(
  transaction: DomainTransaction,
  operationIndex: number
): StoredDirectoryState {
  if (transaction.stagingParent === null) throw new Error("Prepared transaction has no staging identity.");
  let expected = transaction.stagingParent;
  for (let index = 0; index < operationIndex; index += 1) {
    if (transaction.operations[index]?.type === "rmdir") {
      expected = transitionDirectoryLinkState(expected, "mkdir");
    }
  }
  return expected;
}

function expectedStageParentAfter(transaction: DomainTransaction): StoredDirectoryState {
  return expectedStageParentBeforeOperation(transaction, transaction.operations.length);
}

function captureParentTransitions(transaction: DomainTransaction): StoredParentLinkTransition[] {
  const states = new Map<string, StoredDirectoryState>();
  const transitions: StoredParentLinkTransition[] = [];
  for (let index = 0; index < transaction.operations.length; index += 1) {
    const operation = transaction.operations[index];
    if (operation.type !== "mkdir" && operation.type !== "rmdir") continue;
    const parent = parentRelativePath(operation.target);
    const before = states.get(parent) ?? declaredDirectoryState(transaction, parent);
    const after = transitionDirectoryLinkState(before, operation.type);
    states.set(parent, after);
    transitions.push({ kind: operation.type, parent, target: operation.target, before, after });
  }
  return transitions;
}

function declaredDirectoryState(transaction: DomainTransaction, path: string): StoredDirectoryState {
  const created = transaction.operations.find(
    (operation) => operation.type === "mkdir" && operation.target === path
  );
  if (created?.type === "mkdir" && isPhysicalDirectoryState(created.desiredAfter)) {
    return created.desiredAfter;
  }
  for (const operation of transaction.operations) {
    const ancestor = operation.ancestors.find((candidate) => candidate.path === path);
    if (ancestor?.expected.kind === "directory") return ancestor.expected;
  }
  throw new Error("Domain transaction parent has no exact directory receipt.");
}

function sameDirectoryWithPermittedLinkCount(
  receipt: NativePublicationReceipt,
  expected: StoredDirectoryState,
  transaction: DomainTransaction,
  operationIndex: number
): boolean {
  if (!sameExactIdentityExceptNlink(receipt, expected)) return false;
  const candidates = new Set<string>([expected.nlink]);
  for (const transition of transaction.parentTransitions) {
    if (transition.parent === findDirectoryPathForState(transaction, expected)) {
      candidates.add(transition.before.nlink);
      candidates.add(transition.after.nlink);
    }
  }
  if (operationIndex >= 0) {
    for (const transition of transaction.parentTransitions) {
      if (sameExactIdentityExceptNlink(transition.before, expected)) {
        candidates.add(transition.before.nlink);
        candidates.add(transition.after.nlink);
      }
    }
  }
  return candidates.has(String(receipt.nlink));
}

function findDirectoryPathForState(
  transaction: DomainTransaction,
  expected: StoredDirectoryState
): string | undefined {
  for (const operation of transaction.operations) {
    if (operation.type === "mkdir" && sameExactIdentityExceptNlink(operation.desiredAfter, expected)) {
      return operation.target;
    }
    for (const ancestor of operation.ancestors) {
      if (ancestor.expected.kind === "directory" &&
          sameExactIdentityExceptNlink(ancestor.expected, expected)) {
        return ancestor.path;
      }
    }
  }
  return undefined;
}

function finalizeTransaction(
  rootDir: string,
  barrier: NativeStableAncestorBarrier,
  transaction: DomainTransaction,
  faultInjection: DomainTransactionFaultInjection
): void {
  try {
    assertExclusiveStorageRootPath(rootDir, barrier);
    if (faultInjection.failBeforeJournalRemove === true) {
      throw new Error("Injected domain transaction journal cleanup failure.");
    }
    if (transaction.phase !== "complete") {
      validatePreparedTransaction(transaction);
      transaction.phase = "complete";
      persistDomainTransaction(rootDir, barrier, transaction);
    }
    removeDomainTransactionReceipts(rootDir, barrier, transaction.id);
    assertExclusiveStorageRootPath(rootDir, barrier);
  } catch (error) {
    throw new DomainTransactionRecoveryError(transaction.id, error, error);
  }
}

function publicationForOperation(
  transaction: DomainTransaction,
  operationIndex: number,
  kind: "file" | "directory"
): StoredPublication {
  const publication = transaction.publications.find(
    (candidate) => candidate.operationIndex === operationIndex && candidate.kind === kind
  );
  if (publication === undefined) throw new Error("Prepared transaction publication is missing.");
  return publication;
}

function validatePreparedTransaction(transaction: DomainTransaction): void {
  if ((transaction.phase !== "prepared" && transaction.phase !== "complete") ||
      transaction.generation === null ||
      transaction.stagingParent === null || transaction.stagingParentAfter === null) {
    throw new Error(`Invalid domain transaction: ${transaction.id}.`);
  }
  const expectedPublications = transaction.operations.filter(
    (operation) => operation.type === "write"
  );
  if (transaction.publications.length !== expectedPublications.length) {
    throw new Error(`Invalid domain transaction: ${transaction.id}.`);
  }
  for (const publication of transaction.publications) {
    const operation = transaction.operations[publication.operationIndex];
    if (operation === undefined || publication.publishTarget !== operation.target ||
        publication.kind !== "file" || operation.type !== "write") {
      throw new Error(`Invalid domain transaction: ${transaction.id}.`);
    }
    if (!sameExactIdentityExceptNlink(publication.entry, operation.desiredAfter)) {
      throw new Error(`Invalid domain transaction: ${transaction.id}.`);
    }
  }
  const transitions = captureParentTransitions(transaction);
  if (transitions.length !== transaction.parentTransitions.length ||
      transitions.some((transition, index) => !sameTransition(
        transition,
        transaction.parentTransitions[index]
      ))) {
    throw new Error(`Invalid domain transaction: ${transaction.id}.`);
  }
}

function sameTransition(
  left: StoredParentLinkTransition,
  right: StoredParentLinkTransition | undefined
): boolean {
  return right !== undefined && left.kind === right.kind && left.parent === right.parent &&
    left.target === right.target && sameExactState(left.before, right.before) &&
    sameExactState(left.after, right.after);
}

function appendDeleteOperations(
  reader: NativePinnedRootReader,
  target: string,
  output: StoredOperation[]
): void {
  const state = readPathState(reader, target);
  if (state.kind === "absent") {
    throw new Error("Domain transaction operation requires a state change.");
  }
  if (state.kind === "file") {
    output.push({
      type: "delete",
      target,
      expectedBefore: state,
      desiredAfter: { kind: "absent" },
      ancestors: captureAncestors(reader, target)
    });
    return;
  }
  const files: Array<{ target: string; state: StoredFileState }> = [];
  const directories: Array<{ target: string; state: StoredDirectoryState }> = [];
  collectDeleteTree(reader, target, files, directories);
  for (const file of files) {
    output.push({
      type: "delete",
      target: file.target,
      expectedBefore: file.state,
      desiredAfter: { kind: "absent" },
      ancestors: captureAncestors(reader, file.target)
    });
  }
  for (const directory of directories) {
    output.push({
      type: "rmdir",
      target: directory.target,
      expectedBefore: directory.state,
      desiredAfter: { kind: "absent" },
      ancestors: captureAncestors(reader, directory.target)
    });
  }
}

function collectDeleteTree(
  reader: NativePinnedRootReader,
  target: string,
  files: Array<{ target: string; state: StoredFileState }>,
  directories: Array<{ target: string; state: StoredDirectoryState }>
): void {
  const state = readPathState(reader, target);
  if (state.kind === "file") {
    files.push({ target, state });
    return;
  }
  if (state.kind !== "directory") throw new Error("Domain transaction delete tree changed.");
  for (const name of [...reader.readdir(target)].sort()) {
    collectDeleteTree(reader, `${target}/${name}`, files, directories);
  }
  directories.push({ target, state });
}

function captureAncestors(reader: NativePinnedRootReader, target: string): StoredAncestor[] {
  const result: StoredAncestor[] = [];
  for (const path of ancestorPaths(target)) {
    const state = readPathState(reader, path);
    if (state.kind !== "absent" && state.kind !== "directory") {
      throw new Error("Domain transaction ancestry must contain only real directories.");
    }
    result.push({ path, expected: state });
  }
  return result;
}

function ancestorPaths(target: string): string[] {
  const parent = parentRelativePath(target);
  const result = ["."];
  if (parent === ".") return result;
  let current = "";
  for (const part of parent.split("/")) {
    current = current.length === 0 ? part : `${current}/${part}`;
    result.push(current);
  }
  return result;
}

function readPathState(reader: NativePinnedRootReader, relativePath: string): StoredPathState {
  const receipt = reader.lstat(relativePath);
  if (receipt === undefined) return { kind: "absent" };
  if (isDirectoryReceipt(receipt)) return directoryStateFromIdentity(receipt);
  if (!isFileReceipt(receipt)) throw new Error("Authoritative storage contains an unsupported file type.");
  if (receipt.size > BigInt(MAX_RECORD_BYTES)) {
    throw new Error("Authoritative storage record exceeds the recovery safety limit.");
  }
  const read = reader.readFileExact(relativePath, MAX_RECORD_BYTES);
  if (!sameNativeExactIdentity(read.identity, receipt)) {
    throw new Error("Authoritative storage record changed during pinned read.");
  }
  return fileStateFromReceipt(receipt, read.bytes);
}

function withRootReader<T>(
  barrier: NativeStableAncestorBarrier,
  callback: (reader: NativePinnedRootReader) => T
): T {
  const root = inspectRequiredDirectory(barrier, ".");
  return withPinnedRootAt(barrier, ".", root, (reader) => {
    if (reader === undefined) throw new Error("Authoritative storage root disappeared.");
    return callback(reader);
  });
}

function inspectOptionalReceipt(
  barrier: NativeStableAncestorBarrier,
  relativePath: string
): NativePublicationReceipt | undefined {
  return withRootReader(barrier, (reader) => reader.lstat(relativePath));
}

function inspectRequiredReceipt(
  barrier: NativeStableAncestorBarrier,
  relativePath: string
): NativePublicationReceipt {
  const receipt = inspectOptionalReceipt(barrier, relativePath);
  if (receipt === undefined) throw new Error("Expected authoritative storage path is absent.");
  return receipt;
}

function inspectRequiredDirectory(
  barrier: NativeStableAncestorBarrier,
  relativePath: string
): NativeExactIdentity {
  const receipt = inspectDirectoryAt(barrier, relativePath);
  if (receipt === undefined) throw new Error("Expected authoritative storage directory is absent.");
  canonicalStorageOwnerUid({ uid: receipt.uid });
  return receipt;
}

function ensurePrivateDirectoryUnderBarrier(
  barrier: NativeStableAncestorBarrier,
  relativePath: string
): NativeExactIdentity {
  let currentPath = ".";
  let current = inspectRequiredDirectory(barrier, currentPath);
  for (const name of relativePath.split("/")) {
    const nextPath = currentPath === "." ? name : `${currentPath}/${name}`;
    const existing = inspectDirectoryAt(barrier, nextPath);
    if (existing !== undefined) {
      currentPath = nextPath;
      current = existing;
      continue;
    }
    if (inspectOptionalReceipt(barrier, nextPath) !== undefined) {
      throw new Error("Private recovery directory is not a real directory.");
    }
    current = mkdirExactNoReplace(barrier, currentPath, current, name);
    currentPath = nextPath;
  }
  return current;
}

function publishPreparedFile(
  barrier: NativeStableAncestorBarrier,
  parentRelativePath: string,
  expectedParent: NativeExactIdentity,
  name: string,
  content: string
): NativePublicationReceipt {
  const bytes = Buffer.from(content, "utf8");
  return publishAnonymousFileNoReplace(
    barrier,
    parentRelativePath,
    expectedParent,
    name,
    bytes
  );
}

function snapshotPublicOperations(operations: DomainTransactionOperation[]): DomainTransactionOperation[] {
  const snapshot = createInertDataSnapshot(lowerInert(operations));
  if (snapshot === null || !Array.isArray(snapshot.value)) {
    throw new Error("Invalid domain transaction operation.");
  }
  const copied: DomainTransactionOperation[] = [];
  for (let index = 0; index < snapshot.value.length; index += 1) {
    const value = snapshot.value[index];
    if (!isPlainRecord(value) || typeof value.target !== "string") {
      throw new Error("Invalid domain transaction operation.");
    }
    if (value.type === "delete" && exactKeys(value, ["type", "target"])) {
      copied.push({ type: "delete", target: value.target });
    } else if (value.type === "write" && typeof value.content === "string" &&
      exactKeys(value, ["type", "target", "content"])) {
      copied.push({ type: "write", target: value.target, content: value.content });
    } else {
      throw new Error("Invalid domain transaction operation.");
    }
  }
  return copied;
}

function readDomainTransaction(
  rootDir: string,
  id: string,
  barrier: NativeStableAncestorBarrier
): DomainTransaction {
  return loadDomainTransaction(rootDir, id, barrier).transaction;
}

type LoadedDomainTransaction = {
  transaction: DomainTransaction;
  receipt: StoredJournalReceipt;
};

function loadDomainTransaction(
  rootDir: string,
  id: string,
  barrier: NativeStableAncestorBarrier
): LoadedDomainTransaction {
  assertExclusiveStorageRootPath(rootDir, barrier);
  const records = withRootReader(barrier, (reader) => {
    const directory = domainTransactionRelativeDir();
    const entries: Array<LoadedDomainTransaction & { revision: number }> = [];
    for (const name of reader.readdir(directory)) {
      const parsedName = parseDomainTransactionReceiptName(id, name);
      if (parsedName === undefined) continue;
      const relativePath = `${directory}/${name}`;
      const lstat = reader.lstat(relativePath);
      if (lstat === undefined || !isFileReceipt(lstat) || lstat.size > BigInt(MAX_RECORD_BYTES)) {
        throw new Error(`Invalid domain transaction receipt: ${id}.`);
      }
      const read = reader.readFileExact(relativePath, MAX_RECORD_BYTES);
      if (!sameNativeExactIdentity(read.identity, lstat)) {
        throw new Error(`Domain transaction receipt changed during native read: ${id}.`);
      }
      const sha256 = createHash("sha256").update(read.bytes).digest("hex");
      if (parsedName.sha256 !== null && parsedName.sha256 !== sha256) {
        throw new Error(`Invalid domain transaction receipt digest: ${id}.`);
      }
      const snapshot = parseCanonicalInertData(read.bytes);
      if (snapshot === null || !isDomainTransaction(snapshot.value, id)) {
        throw new Error(`Invalid domain transaction: ${id}.`);
      }
      const transaction = cloneDomainTransaction(snapshot.value as unknown as DomainTransaction);
      if (transaction.revision !== parsedName.revision) {
        throw new Error(`Invalid domain transaction receipt revision: ${id}.`);
      }
      entries.push({
        revision: parsedName.revision,
        transaction,
        receipt: journalReceiptFromNative(relativePath, read.identity, read.bytes)
      });
    }
    return entries;
  });
  records.sort((left, right) => left.revision - right.revision);
  if (records.length === 0) throw new Error(`Invalid domain transaction receipt chain: ${id}.`);
  const revisions = new Set<number>();
  for (const record of records) {
    if (revisions.has(record.revision)) {
      throw new Error(`Invalid domain transaction receipt chain: ${id}.`);
    }
    revisions.add(record.revision);
  }
  let previous: LoadedDomainTransaction | undefined;
  let contiguous = records[0]?.revision === 0;
  for (let index = 0; index < records.length; index += 1) {
    const current = records[index];
    if (current === undefined || current.revision !== index ||
        (index > 0 && current.transaction.previousReceipt === null) ||
        (index === 0 && current.transaction.previousReceipt !== null) ||
        (previous !== undefined && !sameJournalReceipt(
          current.transaction.previousReceipt,
          previous.receipt
        ))) {
      contiguous = false;
      break;
    }
    previous = current;
  }
  const latest = records[records.length - 1];
  if (!contiguous) {
    if (latest?.transaction.phase !== "complete") {
      throw new Error(`Invalid domain transaction receipt chain: ${id}.`);
    }
    previous = latest;
  }
  if (previous === undefined) throw new Error(`Invalid domain transaction receipt chain: ${id}.`);
  const transaction = previous.transaction;
  for (const operation of transaction.operations) {
    assertStoredTarget(rootDir, operation.target, transaction.authority);
  }
  assertExclusiveStorageRootPath(rootDir, barrier);
  return previous;
}

function listPendingDomainTransactionIds(
  barrier: NativeStableAncestorBarrier
): string[] {
  const directory = domainTransactionRelativeDir();
  if (inspectDirectoryAt(barrier, directory) === undefined) return [];
  return withRootReader(barrier, (reader) => {
    const ids = new Set<string>();
    for (const name of reader.readdir(directory)) {
      const match = /^([A-Za-z0-9_-]+)\.(?:json|receipt-[0-9]{12}-[a-f0-9]{64}\.json)$/.exec(name);
      if (match?.[1] !== undefined) ids.add(match[1]);
    }
    return [...ids].sort();
  });
}

function removeDomainTransactionReceipts(
  rootDir: string,
  barrier: NativeStableAncestorBarrier,
  id: string
): void {
  const directory = domainTransactionRelativeDir();
  const completeTransaction = loadDomainTransaction(rootDir, id, barrier).transaction;
  if (completeTransaction.phase !== "complete") {
    throw new Error("Domain transaction completion receipt is not terminal.");
  }
  const completeHash = createHash("sha256").update(
    encodeDomainTransaction(completeTransaction)
  ).digest("hex");
  const completeRelative = domainTransactionReceiptRelative(
    id,
    completeTransaction.revision,
    completeHash
  );
  const receipts = withRootReader(barrier, (reader) => {
    const output: Array<{ relativePath: string; receipt: NativePublicationReceipt; revision: number }> = [];
    for (const name of reader.readdir(directory)) {
      const parsed = parseDomainTransactionReceiptName(id, name);
      if (parsed === undefined) continue;
      const relativePath = `${directory}/${name}`;
      const lstat = reader.lstat(relativePath);
      if (lstat === undefined || !isFileReceipt(lstat) || lstat.size > BigInt(MAX_RECORD_BYTES)) {
        throw new Error("Domain transaction receipt changed before cleanup.");
      }
      const read = reader.readFileExact(relativePath, MAX_RECORD_BYTES);
      if (!sameNativeExactIdentity(read.identity, lstat)) {
        throw new Error("Domain transaction receipt changed during cleanup read.");
      }
      if (parsed.sha256 !== null &&
          createHash("sha256").update(read.bytes).digest("hex") !== parsed.sha256) {
        throw new Error("Domain transaction receipt digest changed before cleanup.");
      }
      output.push({ relativePath, receipt: lstat, revision: parsed.revision });
    }
    return output;
  });
  const complete = receipts.find((receipt) => receipt.relativePath === completeRelative);
  if (complete === undefined) {
    throw new Error("Domain transaction completion receipt is missing.");
  }
  const quarantineDirectory = preparedGenerationRelative(completeTransaction);
  const retire = (receipt: { relativePath: string; receipt: NativePublicationReceipt }): void => {
    renameNoReplaceExact(
      barrier,
      directory,
      inspectRequiredDirectory(barrier, directory),
      basenameOf(receipt.relativePath),
      receipt.receipt,
      quarantineDirectory,
      inspectRequiredDirectory(barrier, quarantineDirectory),
      `receipt-quarantine-${randomUUID()}`
    );
  };
  for (const receipt of receipts
    .filter((candidate) => candidate.relativePath !== completeRelative)
    .sort((left, right) => right.revision - left.revision)) {
    retire(receipt);
  }
  // Retire the terminal receipt last so an interrupted cleanup remains
  // restartable. Retired receipts stay in the transaction-private quarantine;
  // no pathname unlink can consume a replacement at the public receipt name.
  retire(complete);
}

function isDomainTransaction(value: unknown, id: string): value is DomainTransaction {
  if (!isPlainRecord(value) || !exactKeys(value, [
    "schemaVersion", "id", "revision", "previousReceipt", "authority", "phase", "generation", "stagingParent",
    "stagingParentAfter", "operations", "parentTransitions", "publications", "createdAt"
  ]) || value.schemaVersion !== 3 || value.id !== id ||
    typeof value.revision !== "number" || !Number.isSafeInteger(value.revision) ||
    value.revision < 0 || !isOptionalJournalReceipt(value.previousReceipt, id, value.revision) ||
    (value.authority !== "core" && value.authority !== "core+backups") ||
    (value.phase !== "preparing" && value.phase !== "prepared" && value.phase !== "complete") ||
    !(value.generation === null ||
      (typeof value.generation === "string" && isCanonicalUuid(value.generation))) ||
    typeof value.createdAt !== "string" || !Array.isArray(value.operations) ||
    !Array.isArray(value.parentTransitions) || !Array.isArray(value.publications) ||
    !isOptionalDirectoryState(value.stagingParent) ||
    !isOptionalDirectoryState(value.stagingParentAfter) ||
    !everyArrayValue(value.operations, isStoredOperation) ||
    !everyArrayValue(value.parentTransitions, isParentTransition) ||
    !everyArrayValue(value.publications, isPublication)) {
    return false;
  }
  if (value.operations.length === 0) return false;
  if (value.phase === "preparing") {
    return value.publications.length === 0 && value.parentTransitions.length === 0 &&
      value.stagingParent === null && value.stagingParentAfter === null;
  }
  return value.generation !== null && value.stagingParent !== null && value.stagingParentAfter !== null;
}

function everyArrayValue(
  values: readonly unknown[],
  predicate: (value: unknown) => boolean
): boolean {
  for (let index = 0; index < values.length; index += 1) {
    if (!predicate(values[index])) return false;
  }
  return true;
}

function cloneDomainTransaction(transaction: DomainTransaction): DomainTransaction {
  return {
    schemaVersion: 3,
    id: transaction.id,
    revision: transaction.revision,
    previousReceipt: transaction.previousReceipt === null
      ? null
      : cloneJournalReceipt(transaction.previousReceipt),
    authority: transaction.authority,
    phase: transaction.phase,
    generation: transaction.generation,
    stagingParent: transaction.stagingParent === null
      ? null
      : cloneDirectoryState(transaction.stagingParent),
    stagingParentAfter: transaction.stagingParentAfter === null
      ? null
      : cloneDirectoryState(transaction.stagingParentAfter),
    operations: copyArray(transaction.operations).map(cloneStoredOperation),
    parentTransitions: copyArray(transaction.parentTransitions).map((transition) => ({
      kind: transition.kind,
      parent: transition.parent,
      target: transition.target,
      before: cloneDirectoryState(transition.before),
      after: cloneDirectoryState(transition.after)
    })),
    publications: copyArray(transaction.publications).map((publication) => ({
      operationIndex: publication.operationIndex,
      kind: publication.kind,
      publishTarget: publication.publishTarget,
      unitName: publication.unitName,
      retiredName: publication.retiredName,
      entry: publication.entry.kind === "file"
        ? cloneFileState(publication.entry)
        : cloneDirectoryState(publication.entry)
    })),
    createdAt: transaction.createdAt
  };
}

function cloneJournalReceipt(receipt: StoredJournalReceipt): StoredJournalReceipt {
  return {
    path: receipt.path,
    sha256: receipt.sha256,
    byteLength: receipt.byteLength,
    ...cloneExactIdentity(receipt)
  };
}

function cloneStoredOperation(operation: StoredOperation): StoredOperation {
  const ancestors = copyArray(operation.ancestors).map((ancestor) => ({
    path: ancestor.path,
    expected: clonePathState(ancestor.expected)
  }));
  if (operation.type === "write") {
    return {
      type: "write",
      target: operation.target,
      content: operation.content,
      expectedBefore: operation.expectedBefore.kind === "absent"
        ? { kind: "absent" }
        : cloneFileState(operation.expectedBefore),
      desiredAfter: cloneFileState(operation.desiredAfter),
      ancestors
    };
  }
  if (operation.type === "mkdir") {
    return {
      type: "mkdir",
      target: operation.target,
      expectedBefore: { kind: "absent" },
      desiredAfter: cloneDirectoryState(operation.desiredAfter),
      ancestors
    };
  }
  if (operation.type === "delete") {
    return {
      type: "delete",
      target: operation.target,
      expectedBefore: cloneFileState(operation.expectedBefore),
      desiredAfter: { kind: "absent" },
      ancestors
    };
  }
  return {
    type: "rmdir",
    target: operation.target,
    expectedBefore: cloneDirectoryState(operation.expectedBefore),
    desiredAfter: { kind: "absent" },
    ancestors
  };
}

function clonePathState(state: StoredPathState): StoredPathState {
  if (state.kind === "absent") return { kind: "absent" };
  return state.kind === "file" ? cloneFileState(state) : cloneDirectoryState(state);
}

function cloneFileState(state: StoredFileState): StoredFileState {
  return {
    kind: "file",
    sha256: state.sha256,
    byteLength: state.byteLength,
    ...cloneExactIdentity(state)
  };
}

function cloneDirectoryState(state: StoredDirectoryState): StoredDirectoryState {
  return { kind: "directory", ...cloneExactIdentity(state) };
}

function cloneExactIdentity(identity: StoredExactIdentity): StoredExactIdentity {
  return {
    device: identity.device,
    inode: identity.inode,
    birthtimeNs: identity.birthtimeNs,
    uid: identity.uid,
    mode: identity.mode,
    nlink: identity.nlink
  };
}

function copyArray<T>(values: readonly T[]): T[] {
  const copied: T[] = [];
  for (let index = 0; index < values.length; index += 1) {
    copied.push(values[index] as T);
  }
  return copied;
}

function isStoredOperation(value: unknown): value is StoredOperation {
  if (!isPlainRecord(value) || typeof value.target !== "string" ||
      !Array.isArray(value.ancestors) || !everyArrayValue(value.ancestors, isAncestor)) return false;
  if (value.type === "write") {
    return typeof value.content === "string" && exactKeys(value, [
      "type", "target", "content", "expectedBefore", "desiredAfter", "ancestors"
    ]) && isAbsentOrFileState(value.expectedBefore) && isFileState(value.desiredAfter);
  }
  if (value.type === "mkdir") {
    return exactKeys(value, ["type", "target", "expectedBefore", "desiredAfter", "ancestors"]) &&
      isAbsentState(value.expectedBefore) && isDirectoryState(value.desiredAfter);
  }
  if (value.type === "delete") {
    return exactKeys(value, ["type", "target", "expectedBefore", "desiredAfter", "ancestors"]) &&
      isFileState(value.expectedBefore) && isAbsentState(value.desiredAfter);
  }
  return value.type === "rmdir" &&
    exactKeys(value, ["type", "target", "expectedBefore", "desiredAfter", "ancestors"]) &&
    isDirectoryState(value.expectedBefore) && isAbsentState(value.desiredAfter);
}

function isAncestor(value: unknown): value is StoredAncestor {
  return isPlainRecord(value) && exactKeys(value, ["path", "expected"]) &&
    typeof value.path === "string" && isPathState(value.expected);
}

function isPublication(value: unknown): value is StoredPublication {
  if (!isPlainRecord(value)) return false;
  const operationIndex = value.operationIndex;
  const unitName = value.unitName;
  const retiredName = value.retiredName;
  return isPlainRecord(value) && exactKeys(value, [
    "operationIndex", "kind", "publishTarget", "unitName", "retiredName", "entry"
  ]) && typeof operationIndex === "number" && Number.isSafeInteger(operationIndex) &&
    operationIndex >= 0 &&
    (value.kind === "file" || value.kind === "directory") &&
    typeof value.publishTarget === "string" && typeof unitName === "string" &&
    /^[A-Za-z0-9_-]+$/.test(unitName) &&
    (retiredName === null || (typeof retiredName === "string" &&
      /^[A-Za-z0-9_-]+$/.test(retiredName))) &&
    (value.kind === "file" ? isFileState(value.entry) : isDirectoryState(value.entry));
}

function isParentTransition(value: unknown): value is StoredParentLinkTransition {
  return isPlainRecord(value) && exactKeys(value, ["kind", "parent", "target", "before", "after"]) &&
    (value.kind === "mkdir" || value.kind === "rmdir") && typeof value.parent === "string" &&
    typeof value.target === "string" && isDirectoryState(value.before) && isDirectoryState(value.after);
}

function isPathState(value: unknown): value is StoredPathState {
  return isAbsentState(value) || isFileState(value) || isDirectoryState(value);
}

function isAbsentOrFileState(value: unknown): value is Extract<StoredPathState, { kind: "absent" | "file" }> {
  return isAbsentState(value) || isFileState(value);
}

function isOptionalDirectoryState(value: unknown): value is StoredDirectoryState | null {
  return value === null || isDirectoryState(value);
}

function isOptionalJournalReceipt(
  value: unknown,
  id: string,
  revision: number
): value is StoredJournalReceipt | null {
  return revision === 0 ? value === null : isJournalReceipt(value, id, revision - 1);
}

function isJournalReceipt(
  value: unknown,
  id: string,
  revision: number
): value is StoredJournalReceipt {
  if (!isPlainRecord(value) || !exactKeys(value, [
    "path", "sha256", "byteLength", "device", "inode", "birthtimeNs", "uid", "mode", "nlink"
  ]) || typeof value.path !== "string" || typeof value.sha256 !== "string" ||
    !/^[a-f0-9]{64}$/.test(value.sha256) || typeof value.byteLength !== "number" ||
    !Number.isSafeInteger(value.byteLength) || value.byteLength < 0 || !isExactIdentity(value)) {
    return false;
  }
  return value.path === domainTransactionReceiptRelative(id, revision, value.sha256);
}

function isAbsentState(value: unknown): value is { kind: "absent" } {
  return isPlainRecord(value) && exactKeys(value, ["kind"]) && value.kind === "absent";
}

function isFileState(value: unknown): value is StoredFileState {
  if (!isPlainRecord(value)) return false;
  const byteLength = value.byteLength;
  return isPlainRecord(value) && exactKeys(value, [
    "kind", "sha256", "byteLength", "device", "inode", "birthtimeNs", "uid", "mode", "nlink"
  ]) && value.kind === "file" && typeof value.sha256 === "string" &&
    /^[a-f0-9]{64}$/.test(value.sha256) && typeof byteLength === "number" &&
    Number.isSafeInteger(byteLength) && byteLength >= 0 && isExactIdentity(value);
}

function isDirectoryState(value: unknown): value is StoredDirectoryState {
  return isPlainRecord(value) && exactKeys(value, [
    "kind", "device", "inode", "birthtimeNs", "uid", "mode", "nlink"
  ]) && value.kind === "directory" && isExactIdentity(value);
}

function isExactIdentity(value: Record<string, unknown>): value is Record<string, string> {
  return ["device", "inode", "birthtimeNs", "uid", "mode", "nlink"].every((key) =>
    typeof value[key] === "string" && /^(?:0|[1-9][0-9]*)$/.test(value[key] as string)
  );
}

function encodeDomainTransaction(transaction: DomainTransaction): string {
  const inert = lowerInert(transaction);
  const snapshot = createInertDataSnapshot(inert);
  const encoded = snapshot === null ? null : stringifyCanonicalInertData(snapshot);
  if (encoded === null) throw new Error("Invalid recovery journal entry.");
  return encoded;
}

function lowerInert(value: unknown): InertDataValue {
  if (value === null || typeof value === "string" || typeof value === "number" ||
      typeof value === "boolean") {
    return value;
  }
  if (Array.isArray(value)) {
    const lowered = createInertDataArray(value.map(lowerInert));
    if (lowered === null) throw new Error("Invalid recovery journal entry.");
    return lowered;
  }
  if (!isPlainRecord(value)) throw new Error("Invalid recovery journal entry.");
  const entries: InertDataEntry[] = Object.keys(value).map((key) => [key, lowerInert(value[key])]);
  const lowered = createInertDataObject(entries);
  if (lowered === null) throw new Error("Invalid recovery journal entry.");
  return lowered;
}

function publishInitialDomainTransaction(
  barrier: NativeStableAncestorBarrier,
  transaction: DomainTransaction
): StoredJournalReceipt {
  if (transaction.revision !== 0 || transaction.previousReceipt !== null) {
    throw new Error("Initial domain transaction receipt is not revision zero.");
  }
  return publishDomainTransactionReceipt(
    barrier,
    transaction.id,
    transaction.revision,
    encodeDomainTransaction(transaction)
  );
}

function persistDomainTransaction(
  rootDir: string,
  barrier: NativeStableAncestorBarrier,
  transaction: DomainTransaction
): void {
  assertExclusiveStorageRootPath(rootDir, barrier);
  const previous = loadDomainTransaction(rootDir, transaction.id, barrier);
  if (previous.transaction.revision !== transaction.revision) {
    throw new Error("Domain transaction receipt revision changed before publication.");
  }
  transaction.revision += 1;
  transaction.previousReceipt = cloneJournalReceipt(previous.receipt);
  publishDomainTransactionReceipt(
    barrier,
    transaction.id,
    transaction.revision,
    encodeDomainTransaction(transaction)
  );
  assertExclusiveStorageRootPath(rootDir, barrier);
}

function publishDomainTransactionReceipt(
  barrier: NativeStableAncestorBarrier,
  id: string,
  revision: number,
  content: string
): StoredJournalReceipt {
  const bytes = Buffer.from(content, "utf8");
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const relativePath = domainTransactionReceiptRelative(id, revision, sha256);
  const parentPath = domainTransactionRelativeDir();
  const parent = inspectRequiredDirectory(barrier, parentPath);
  const receipt = publishAnonymousFileNoReplace(
    barrier,
    parentPath,
    parent,
    basenameOf(relativePath),
    bytes
  );
  return journalReceiptFromNative(relativePath, receipt, bytes);
}

function stageSnapshotWriteEntry(
  rootDir: string,
  target: string,
  content: string,
  id: string
): SnapshotWrite {
  assertJournalId(id, "snapshot write");
  return {
    schemaVersion: 1,
    id,
    target: journalTarget(rootDir, target, "core").relative,
    content,
    createdAt: new Date().toISOString()
  };
}

export function stageSnapshotWrite(
  rootDir: string,
  target: string,
  content: string,
  id = randomUUID()
): string {
  const entry = stageSnapshotWriteEntry(rootDir, target, content, id);
  const journal = snapshotJournalFile(rootDir, id);
  atomicWriteLegacySnapshotText(journal, `${JSON.stringify(entry, null, 2)}\n`);
  return journal;
}

export function writeRecoverableSnapshot(rootDir: string, target: string, content: string): void {
  const journal = stageSnapshotWrite(rootDir, target, content);
  atomicWriteLegacySnapshotText(target, content);
  rmSync(journal, { force: true });
}

export function replayPendingSnapshotWrites(rootDir: string): string[] {
  let names: string[];
  try {
    names = readdirSync(snapshotJournalDir(rootDir)).filter((name) => name.endsWith(".json")).sort();
  } catch (error) {
    if (isFileSystemError(error, "ENOENT")) return [];
    throw error;
  }
  return names.map((name) => {
    const id = name.slice(0, -5);
    const entry = parseSnapshotWrite(readFileSync(join(snapshotJournalDir(rootDir), name), "utf8"), id);
    const target = resolveStoredJournalTarget(rootDir, entry.target, "core");
    atomicWriteLegacySnapshotText(target, entry.content);
    rmSync(join(snapshotJournalDir(rootDir), name), { force: true });
    return target;
  });
}

function parseSnapshotWrite(raw: string, id: string): SnapshotWrite {
  const value = JSON.parse(raw) as unknown;
  if (!isPlainRecord(value) || !exactKeys(value, ["schemaVersion", "id", "target", "content", "createdAt"]) ||
      value.schemaVersion !== 1 || value.id !== id || typeof value.target !== "string" ||
      typeof value.content !== "string" || typeof value.createdAt !== "string") {
    throw new Error(`Invalid recovery journal entry: ${id}.`);
  }
  return value as SnapshotWrite;
}

/**
 * Legacy v1 snapshot compatibility only.  DomainTransaction v3 never calls
 * this pathname-mutating helper; its receipts are immutable native
 * no-replace publications under the exclusive storage barrier.
 */
function atomicWriteLegacySnapshotText(target: string, content: string): void {
  mkdirSync(dirname(target), { recursive: true });
  const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
  let descriptor: number | undefined;
  try {
    descriptor = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, FILE_MODE);
    writeFileSync(descriptor, content, "utf8");
    closeSync(descriptor);
    descriptor = undefined;
    renameSync(temporary, target);
  } catch (error) {
    if (descriptor !== undefined) closeSync(descriptor);
    rmSync(temporary, { force: true });
    throw error;
  }
}

function openRootDirectory(rootDir: string): number {
  const stat = lstatSync(rootDir, { bigint: true });
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error("Authoritative TaskMux storage root must be a real directory.");
  }
  canonicalStorageOwnerUid(stat);
  return openSync(rootDir, DIRECTORY_FLAGS);
}

function descriptorIdentity(descriptor: number): NativeExactIdentity {
  const stat = fstatSync(descriptor, { bigint: true });
  if (!stat.isDirectory()) throw new Error("Storage barrier root is not a directory.");
  canonicalStorageOwnerUid(stat);
  return {
    dev: stat.dev,
    ino: stat.ino,
    uid: stat.uid,
    mode: stat.mode,
    nlink: stat.nlink,
    birthtimeNs: stat.birthtimeNs
  };
}

function fileStateFromBytes(bytes: Buffer): StoredFileState {
  return {
    kind: "file",
    sha256: createHash("sha256").update(bytes).digest("hex"),
    byteLength: bytes.byteLength,
    ...placeholderExactIdentity()
  };
}

function fileStateFromReceipt(receipt: NativePublicationReceipt, bytes: Buffer): StoredFileState {
  return {
    kind: "file",
    sha256: createHash("sha256").update(bytes).digest("hex"),
    byteLength: bytes.byteLength,
    ...exactIdentityFromReceipt(receipt)
  };
}

function directoryStateFromIdentity(identity: NativeExactIdentity): StoredDirectoryState {
  return { kind: "directory", ...exactIdentityFromReceipt(identity) };
}

function placeholderExactIdentity(): StoredExactIdentity {
  return {
    device: "0",
    inode: "0",
    birthtimeNs: "0",
    uid: "0",
    mode: "0",
    nlink: "0"
  };
}

function placeholderDirectoryState(): StoredDirectoryState {
  return { kind: "directory", ...placeholderExactIdentity() };
}

function exactIdentityFromReceipt(identity: NativeExactIdentity): StoredExactIdentity {
  canonicalStorageOwnerUid({ uid: identity.uid });
  return {
    device: String(identity.dev),
    inode: String(identity.ino),
    birthtimeNs: String(identity.birthtimeNs),
    uid: String(identity.uid),
    mode: String(identity.mode),
    nlink: String(identity.nlink)
  };
}

function nativeIdentity(identity: StoredExactIdentity): NativeExactIdentity {
  return {
    dev: BigInt(identity.device),
    ino: BigInt(identity.inode),
    birthtimeNs: BigInt(identity.birthtimeNs),
    uid: BigInt(identity.uid),
    mode: BigInt(identity.mode),
    nlink: BigInt(identity.nlink)
  };
}

function filePublicationEntry(publication: StoredPublication): StoredFileState {
  if (publication.kind !== "file" || publication.entry.kind !== "file") {
    throw new Error("Prepared transaction file publication is invalid.");
  }
  return publication.entry;
}

function sameLogicalFileState(left: StoredFileState, right: StoredFileState): boolean {
  return left.sha256 === right.sha256 && left.byteLength === right.byteLength;
}

function sameExactState(left: StoredPathState, right: StoredPathState): boolean {
  if (left.kind !== right.kind) return false;
  if (left.kind === "absent" || right.kind === "absent") return true;
  if (!sameExactIdentityExceptNlink(left, right) || left.nlink !== right.nlink) return false;
  return left.kind === "directory" || right.kind === "directory" ||
    sameLogicalFileState(left, right);
}

function sameExactIdentity(
  left: NativeExactIdentity | StoredExactIdentity,
  right: StoredExactIdentity
): boolean {
  return sameExactIdentityExceptNlink(left, right) &&
    String(identityNlink(left)) === right.nlink;
}

function sameNativeExactIdentity(
  left: NativeExactIdentity,
  right: NativeExactIdentity
): boolean {
  return left.dev === right.dev && left.ino === right.ino &&
    left.birthtimeNs === right.birthtimeNs && left.uid === right.uid &&
    left.mode === right.mode && left.nlink === right.nlink;
}

function journalReceiptFromNative(
  path: string,
  receipt: NativePublicationReceipt,
  bytes: Buffer
): StoredJournalReceipt {
  return {
    path,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    byteLength: bytes.byteLength,
    ...exactIdentityFromReceipt(receipt)
  };
}

function sameJournalReceipt(
  left: StoredJournalReceipt | null,
  right: StoredJournalReceipt
): boolean {
  return left !== null && left.path === right.path && left.sha256 === right.sha256 &&
    left.byteLength === right.byteLength && left.device === right.device &&
    left.inode === right.inode && left.birthtimeNs === right.birthtimeNs &&
    left.uid === right.uid && left.mode === right.mode && left.nlink === right.nlink;
}

function sameExactIdentityExceptNlink(
  left: NativeExactIdentity | StoredExactIdentity,
  right: StoredExactIdentity
): boolean {
  return String(identityDevice(left)) === right.device &&
    String(identityInode(left)) === right.inode &&
    String(left.birthtimeNs) === right.birthtimeNs &&
    String(left.uid) === right.uid &&
    String(left.mode) === right.mode;
}

function identityDevice(identity: NativeExactIdentity | StoredExactIdentity): bigint | string {
  return "dev" in identity ? identity.dev : identity.device;
}

function identityInode(identity: NativeExactIdentity | StoredExactIdentity): bigint | string {
  return "ino" in identity ? identity.ino : identity.inode;
}

function identityNlink(identity: NativeExactIdentity | StoredExactIdentity): bigint | string {
  return identity.nlink;
}

function filePathMatchesState(
  barrier: NativeStableAncestorBarrier,
  relativePath: string,
  state: StoredFileState,
  allowNlinkChange = false
): boolean {
  return withRootReader(barrier, (reader) => {
    const before = reader.lstat(relativePath);
    if (before === undefined || !isFileReceipt(before) ||
        !(allowNlinkChange
          ? sameExactIdentityExceptNlink(before, state)
          : sameExactIdentity(before, state)) ||
        before.size !== BigInt(state.byteLength)) {
      return false;
    }
    const read = reader.readFileExact(relativePath, MAX_RECORD_BYTES);
    const after = reader.lstat(relativePath);
    return after !== undefined && isFileReceipt(after) &&
      sameNativeExactIdentity(before, read.identity) &&
      sameNativeExactIdentity(read.identity, after) &&
      read.identity.size === BigInt(state.byteLength) &&
      after.size === BigInt(state.byteLength) &&
      read.bytes.byteLength === state.byteLength &&
      createHash("sha256").update(read.bytes).digest("hex") === state.sha256;
  });
}

function pathMatchesState(
  barrier: NativeStableAncestorBarrier,
  relativePath: string,
  receipt: NativePublicationReceipt,
  state: StoredFileState | StoredDirectoryState
): boolean {
  return state.kind === "file"
    ? filePathMatchesState(barrier, relativePath, state)
    : sameExactIdentity(receipt, state);
}

function isPhysicalDirectoryState(value: StoredPathState): value is StoredDirectoryState {
  return value.kind === "directory" && value.device !== "0";
}

function isDirectoryReceipt(receipt: NativePublicationReceipt): boolean {
  return (receipt.mode & 0o170000n) === 0o040000n;
}

function isFileReceipt(receipt: NativePublicationReceipt): boolean {
  return (receipt.mode & 0o170000n) === 0o100000n;
}

function transitionDirectoryLinkState(
  before: StoredDirectoryState,
  kind: "mkdir" | "rmdir"
): StoredDirectoryState {
  const delta = kind === "mkdir" ? 1n : -1n;
  const nlink = BigInt(before.nlink) + delta;
  if (nlink < 0n) throw new Error("Domain transaction parent link transition underflow.");
  return { ...before, nlink: String(nlink) };
}

function assertDomainTransactionApplyFailpoint(
  count: number,
  phase: "initial" | "recovery" | "replay",
  faultInjection: DomainTransactionFaultInjection
): void {
  const injected = phase === "initial"
    ? faultInjection.initialAfterOperation
    : phase === "recovery" ? faultInjection.recoveryAfterOperation : undefined;
  const environment = process.env.NODE_ENV === "test"
    ? process.env.TASKMUX_TEST_ONLY_DOMAIN_TRANSACTION_FAILPOINT
    : undefined;
  if (injected === count || (phase === "initial" && environment === `after-operation:${count}`) ||
      environment === `after-operation:${count}-always`) {
    throw new Error(`Domain transaction interrupted after operation ${count}.`);
  }
}

function assertWritePublicationFailpoint(
  count: number,
  stage: "staging" | "prepared",
  phase: "initial" | "recovery" | "replay",
  faultInjection: DomainTransactionFaultInjection
): void {
  const injected = phase === "initial"
    ? stage === "staging" ? faultInjection.initialAfterWriteStaging : faultInjection.initialAfterWritePrepared
    : phase === "recovery"
      ? stage === "staging" ? faultInjection.recoveryAfterWriteStaging : faultInjection.recoveryAfterWritePrepared
      : undefined;
  if (injected === count) {
    throw new Error(`Domain transaction interrupted after write ${stage}.`);
  }
}

function assertRetirementFailpoint(
  count: number,
  phase: "initial" | "recovery" | "replay",
  faultInjection: DomainTransactionFaultInjection
): void {
  const injected = phase === "initial"
    ? faultInjection.initialAfterRetirement
    : phase === "recovery" ? faultInjection.recoveryAfterRetirement : undefined;
  if (injected === count) {
    throw new Error(`Domain transaction interrupted after retirement ${count}.`);
  }
}

function journalTarget(
  rootDir: string,
  target: string,
  authority: DomainTransactionAuthority
): { relative: string; resolved: string } {
  const root = resolve(rootDir);
  const resolved = resolve(target);
  const relativeTarget = relative(root, resolved).split(sep).join("/");
  if (relativeTarget.length === 0 || relativeTarget.startsWith("../") || isAbsolute(relativeTarget)) {
    throw new Error("Journal target must be inside TASKMUX_HOME.");
  }
  assertStoredTarget(rootDir, relativeTarget, authority);
  return { relative: relativeTarget, resolved };
}

function resolveStoredJournalTarget(
  rootDir: string,
  target: string,
  authority: DomainTransactionAuthority
): string {
  assertStoredTarget(rootDir, target, authority);
  return join(resolve(rootDir), ...target.split("/"));
}

function assertStoredTarget(
  rootDir: string,
  target: string,
  authority: DomainTransactionAuthority
): void {
  if (target.length === 0 || target.startsWith("/") || target.split("/").some(
    (part) => part.length === 0 || part === "." || part === ".."
  ) || !isAuthoritativeStorageTarget(target, authority === "core+backups")) {
    throw new Error("Domain transaction target is outside authoritative storage.");
  }
  const resolved = resolve(rootDir, ...target.split("/"));
  const underRoot = relative(resolve(rootDir), resolved);
  if (underRoot.length === 0 || underRoot.startsWith("..") || isAbsolute(underRoot)) {
    throw new Error("Domain transaction target is outside TASKMUX_HOME.");
  }
}

function assertNoOverlappingTargets(targets: string[]): void {
  for (let left = 0; left < targets.length; left += 1) {
    for (let right = left + 1; right < targets.length; right += 1) {
      if (targets[left] === targets[right] || targets[left].startsWith(`${targets[right]}/`) ||
          targets[right].startsWith(`${targets[left]}/`)) {
        throw new Error("Domain transaction has duplicate or conflicting targets.");
      }
    }
  }
}

function parentRelativePath(target: string): string {
  const parent = dirname(target).split(sep).join("/");
  return parent === "." ? "." : parent;
}

function basenameOf(target: string): string {
  const parts = target.split("/");
  const name = parts[parts.length - 1];
  if (name === undefined || !/^[^/\\\0]+$/.test(name) || name === "." || name === "..") {
    throw new Error("Domain transaction target has an invalid final component.");
  }
  return name;
}

function domainTransactionRelativeDir(): string {
  return "runtime/domain-transactions";
}

function domainTransactionDir(rootDir: string): string {
  return join(rootDir, "runtime", "domain-transactions");
}

function domainTransactionFile(rootDir: string, id: string): string {
  return join(domainTransactionDir(rootDir), `${id}.json`);
}

function domainTransactionReceiptRelative(
  id: string,
  revision: number,
  sha256: string
): string {
  if (revision === 0) return `${domainTransactionRelativeDir()}/${id}.json`;
  return `${domainTransactionRelativeDir()}/${id}.receipt-${String(revision).padStart(12, "0")}-${sha256}.json`;
}

function parseDomainTransactionReceiptName(
  id: string,
  name: string
): { revision: number; sha256: string | null } | undefined {
  if (name === `${id}.json`) return { revision: 0, sha256: null };
  const match = new RegExp(
    `^${escapeRegularExpression(id)}\\.receipt-([0-9]{12})-([a-f0-9]{64})\\.json$`
  ).exec(name);
  if (match === null) return undefined;
  const revision = Number(match[1]);
  const sha256 = match[2];
  if (!Number.isSafeInteger(revision) || revision < 1 || sha256 === undefined) return undefined;
  return { revision, sha256 };
}

function escapeRegularExpression(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function preparedGenerationRelative(transaction: DomainTransaction): string {
  if (transaction.generation === null) throw new Error("Transaction generation is not declared.");
  return `${domainTransactionStagingRelativeDir()}/${transaction.id}.stage-${transaction.generation}`;
}

function domainTransactionStagingRelativeDir(): string {
  return "runtime/domain-staging";
}

function snapshotJournalDir(rootDir: string): string {
  return join(rootDir, "runtime", "recovery-journal");
}

function snapshotJournalFile(rootDir: string, id: string): string {
  return join(snapshotJournalDir(rootDir), `${id}.json`);
}

function assertJournalId(id: string, kind: string): void {
  if (!/^[A-Za-z0-9_-]+$/.test(id)) throw new Error(`Invalid ${kind} id.`);
}

function isCanonicalUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === null || Object.getPrototypeOf(value) === Object.prototype);
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Reflect.ownKeys(value);
  return actual.length === keys.length && keys.every((key) => {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor !== undefined && "value" in descriptor && descriptor.enumerable === true;
  }) && actual.every((key) => typeof key === "string" && keys.includes(key));
}

function isFileSystemError(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}

function rejectThenable(value: unknown): void {
  if (value !== null && (typeof value === "object" || typeof value === "function") &&
      typeof (value as { then?: unknown }).then === "function") {
    throw new TypeError("Storage barrier callback must complete synchronously.");
  }
}

function unreachable(message: string): never {
  throw new Error(message);
}
