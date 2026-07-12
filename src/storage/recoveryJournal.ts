import {
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";

type SnapshotWrite = {
  schemaVersion: 1;
  id: string;
  target: string;
  content: string;
  createdAt: string;
};

export type DomainTransactionOperation =
  | { type: "write"; target: string; content: string }
  | { type: "delete"; target: string };

type StoredDomainTransactionOperation =
  | { type: "write"; target: string; content: string }
  | { type: "delete"; target: string };

type DomainTransaction = {
  schemaVersion: 1;
  id: string;
  operations: StoredDomainTransactionOperation[];
  createdAt: string;
};

export type DomainTransactionApplyResult = "applied" | "recovered";

type DomainTransactionFaultInjection = {
  initialAfterOperation?: number;
  recoveryAfterOperation?: number;
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

export function stageSnapshotWrite(
  rootDir: string,
  target: string,
  content: string,
  id = randomUUID()
): string {
  const entry = createSnapshotWrite(rootDir, target, content, id);
  const journalFile = snapshotJournalFile(rootDir, id);
  atomicWriteText(journalFile, `${JSON.stringify(entry, null, 2)}\n`);
  return journalFile;
}

export function writeRecoverableSnapshot(rootDir: string, target: string, content: string): void {
  const journalFile = stageSnapshotWrite(rootDir, target, content);
  atomicWriteText(target, content);
  rmSync(journalFile, { force: true });
}

export function replayPendingSnapshotWrites(rootDir: string): string[] {
  const directory = snapshotJournalDir(rootDir);
  let names: string[];
  try {
    names = readdirSync(directory).filter((name) => name.endsWith(".json")).sort();
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return [];
    }
    throw error;
  }

  return names.map((name) => {
    const journalFile = join(directory, name);
    const entry = parseSnapshotWrite(readFileSync(journalFile, "utf8"), name.slice(0, -5));
    const target = resolveJournalTarget(rootDir, entry.target);
    atomicWriteText(target, entry.content);
    rmSync(journalFile, { force: true });
    return target;
  });
}

export function stageDomainTransaction(
  rootDir: string,
  id: string,
  operations: DomainTransactionOperation[]
): string {
  assertJournalId(id, "domain transaction");
  if (operations.length === 0) {
    throw new Error("Domain transaction requires at least one operation.");
  }
  const entry: DomainTransaction = {
    schemaVersion: 1,
    id,
    operations: operations.map((operation) => ({
      ...operation,
      target: journalTarget(rootDir, operation.target)
    })),
    createdAt: new Date().toISOString()
  };
  const target = domainTransactionFile(rootDir, id);
  atomicWriteText(target, `${JSON.stringify(entry, null, 2)}\n`);
  return target;
}

export function commitDomainTransaction(
  rootDir: string,
  id: string,
  operations: DomainTransactionOperation[]
): void {
  stageDomainTransaction(rootDir, id, operations);
  applyStagedDomainTransaction(rootDir, id);
}

export function applyStagedDomainTransaction(
  rootDir: string,
  id: string,
  faultInjection: DomainTransactionFaultInjection = {}
): DomainTransactionApplyResult {
  assertJournalId(id, "domain transaction");
  const journalFile = domainTransactionFile(rootDir, id);
  let transaction: DomainTransaction;
  try {
    if (faultInjection.failBeforeJournalRead === true) {
      throw new Error("Injected domain transaction journal read failure.");
    }
    transaction = parseDomainTransaction(readFileSync(journalFile, "utf8"), id);
  } catch (error) {
    throw new DomainTransactionRecoveryError(id, error, error);
  }
  let result: DomainTransactionApplyResult = "applied";
  try {
    applyDomainTransaction(rootDir, transaction, "initial", faultInjection);
  } catch (initialError) {
    try {
      applyDomainTransaction(rootDir, transaction, "recovery", faultInjection);
      result = "recovered";
    } catch (recoveryError) {
      throw new DomainTransactionRecoveryError(id, initialError, recoveryError);
    }
  }
  try {
    if (faultInjection.failBeforeJournalRemove === true) {
      throw new Error("Injected domain transaction journal cleanup failure.");
    }
    rmSync(journalFile, { force: true });
  } catch (error) {
    throw new DomainTransactionRecoveryError(id, error, error);
  }
  return result;
}

export function replayPendingDomainTransactions(rootDir: string): string[] {
  const directory = domainTransactionDir(rootDir);
  let names: string[];
  try {
    names = readdirSync(directory).filter((name) => name.endsWith(".json")).sort();
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return [];
    }
    throw error;
  }

  return names.map((name) => {
    const id = name.slice(0, -5);
    const journalFile = join(directory, name);
    applyDomainTransaction(
      rootDir,
      parseDomainTransaction(readFileSync(journalFile, "utf8"), id),
      "replay",
      {}
    );
    rmSync(journalFile, { force: true });
    return id;
  });
}

function createSnapshotWrite(rootDir: string, target: string, content: string, id: string): SnapshotWrite {
  assertJournalId(id, "snapshot write");
  return {
    schemaVersion: 1,
    id,
    target: journalTarget(rootDir, target),
    content,
    createdAt: new Date().toISOString()
  };
}

function parseDomainTransaction(raw: string, expectedId: string): DomainTransaction {
  const value = JSON.parse(raw) as unknown;
  if (
    typeof value !== "object" ||
    value === null ||
    !("schemaVersion" in value) || value.schemaVersion !== 1 ||
    !("id" in value) || value.id !== expectedId ||
    !("operations" in value) || !Array.isArray(value.operations) || value.operations.length === 0 ||
    !("createdAt" in value) || typeof value.createdAt !== "string" ||
    !value.operations.every(isStoredDomainTransactionOperation)
  ) {
    throw new Error(`Invalid domain transaction: ${expectedId}.`);
  }
  return value as DomainTransaction;
}

function isStoredDomainTransactionOperation(value: unknown): value is StoredDomainTransactionOperation {
  if (typeof value !== "object" || value === null || !("type" in value) || !("target" in value)) {
    return false;
  }
  if (typeof value.target !== "string") {
    return false;
  }
  return value.type === "delete" || (
    value.type === "write" && "content" in value && typeof value.content === "string"
  );
}

function applyDomainTransaction(
  rootDir: string,
  transaction: DomainTransaction,
  phase: "initial" | "recovery" | "replay",
  faultInjection: DomainTransactionFaultInjection
): void {
  for (const [index, operation] of transaction.operations.entries()) {
    const target = resolveJournalTarget(rootDir, operation.target);
    if (operation.type === "write") {
      atomicWriteText(target, operation.content);
    } else {
      rmSync(target, { recursive: true, force: true });
    }
    assertDomainTransactionApplyFailpoint(index + 1, phase, faultInjection);
  }
}

function assertDomainTransactionApplyFailpoint(
  operationCount: number,
  phase: "initial" | "recovery" | "replay",
  faultInjection: DomainTransactionFaultInjection
): void {
  const injectedOperation = phase === "initial"
    ? faultInjection.initialAfterOperation
    : phase === "recovery"
      ? faultInjection.recoveryAfterOperation
      : undefined;
  const testFailpoint = process.env.NODE_ENV === "test"
    ? process.env.TASKMUX_TEST_ONLY_DOMAIN_TRANSACTION_FAILPOINT
    : undefined;
  if (
    injectedOperation === operationCount ||
    (phase === "initial" && testFailpoint === `after-operation:${operationCount}`) ||
    testFailpoint === `after-operation:${operationCount}-always`
  ) {
    throw new Error(`Domain transaction interrupted after operation ${operationCount}.`);
  }
}

function assertJournalId(id: string, kind: string): void {
  if (!/^[A-Za-z0-9_-]+$/.test(id)) {
    throw new Error(`Invalid ${kind} id.`);
  }
}

function journalTarget(rootDir: string, target: string): string {
  const normalizedTarget = resolve(target);
  const targetPath = relative(resolve(rootDir), normalizedTarget);
  if (targetPath.length === 0 || targetPath.startsWith("..") || isAbsolute(targetPath)) {
    throw new Error("Journal target must be inside TASKMUX_HOME.");
  }
  return targetPath;
}

function parseSnapshotWrite(raw: string, expectedId: string): SnapshotWrite {
  const value = JSON.parse(raw) as unknown;
  if (
    typeof value !== "object" ||
    value === null ||
    !("schemaVersion" in value) || value.schemaVersion !== 1 ||
    !("id" in value) || value.id !== expectedId ||
    !("target" in value) || typeof value.target !== "string" ||
    !("content" in value) || typeof value.content !== "string" ||
    !("createdAt" in value) || typeof value.createdAt !== "string"
  ) {
    throw new Error(`Invalid recovery journal entry: ${expectedId}.`);
  }
  return value as SnapshotWrite;
}

function resolveJournalTarget(rootDir: string, target: string): string {
  const resolvedRoot = resolve(rootDir);
  const resolvedTarget = resolve(resolvedRoot, target);
  const targetPath = relative(resolvedRoot, resolvedTarget);
  if (targetPath.length === 0 || targetPath.startsWith("..") || isAbsolute(targetPath)) {
    throw new Error("Recovery journal target escapes TASKMUX_HOME.");
  }
  return resolvedTarget;
}

function snapshotJournalDir(rootDir: string): string {
  return join(rootDir, "runtime", "recovery-journal");
}

function snapshotJournalFile(rootDir: string, id: string): string {
  return join(snapshotJournalDir(rootDir), `${id}.json`);
}

function domainTransactionDir(rootDir: string): string {
  return join(rootDir, "runtime", "domain-transactions");
}

function domainTransactionFile(rootDir: string, id: string): string {
  return join(domainTransactionDir(rootDir), `${id}.json`);
}

function atomicWriteText(target: string, content: string): void {
  mkdirSync(dirname(target), { recursive: true });
  const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
  let descriptor: number | null = null;
  try {
    descriptor = openSync(temporary, "wx", 0o600);
    writeFileSync(descriptor, content, { encoding: "utf8" });
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = null;
    renameSync(temporary, target);
  } catch (error) {
    if (descriptor !== null) {
      closeSync(descriptor);
    }
    rmSync(temporary, { force: true });
    throw error;
  }
}
