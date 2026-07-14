import { createHash, randomUUID } from "node:crypto";
import {
  lstatSync,
  mkdirSync,
  readFileSync,
  writeFileSync
} from "node:fs";
import { dirname, join } from "node:path";
import { types as utilTypes } from "node:util";
import { runtimeError } from "../errors/cliError.js";
import {
  executeDomainExclusiveBarrier,
  executeDomainReadSnapshot,
  executeDomainTransaction
} from "../storage/domainTransaction.js";
import {
  parseExactRefEffect,
  parseRepositoryLineageId
} from "./gitCommand.js";
import {
  assertGitRepositoryLineage,
  canonicalExactRefResourceIdentity,
  GitResourceLedger,
  type GitRepositoryLineage
} from "./gitResourceLedger.js";
import {
  assertGitLifecycleClaimActive,
  createGitLifecycleClaim,
  parseGitLifecycleClaim,
  type GitLifecycleClaim
} from "./gitLifecycleClaim.js";
import {
  retireExactRef,
  type ExactRefRetirementFaultInjection,
  type ExactRefRetirementReceipt
} from "./exactRefRetirement.js";

const MAX_OPERATION_BYTES = 256 * 1024;
const OPERATION_FILE_PATTERN = /^([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\.json$/;
const OPERATION_DIRECTORY = "runtime/git-lifecycle/operations";
const EXACT_REF_LEDGER_DIRECTORY = "runtime/git-lifecycle/exact-ref-ledger";

export type GitExactRefLifecycleResource = Readonly<{
  repository: GitRepositoryLineage;
  fullRef: string;
  expectedOid: string;
  canonicalResourceIdentity: string;
  resourceKey: string;
}>;

export type GitExactRefLifecycleOperation = Readonly<{
  schemaVersion: 1;
  kind: "git-exact-ref-retirement-operation";
  operationId: string;
  resource: GitExactRefLifecycleResource;
  phase: "prepared" | "claimed" | "effect-started" | "completed";
  generation: number;
  fencingToken: number;
  claim: GitLifecycleClaim | null;
  receipt: ExactRefRetirementReceipt | null;
}>;

export type GitExactRefLifecycleRecovery = Readonly<{
  operationId: string;
  status: "completed" | "active-lease-skipped" | "not-started-skipped";
}>;

/**
 * Durable lifecycle coordinator for one Git exact-ref deletion. It deliberately
 * has no Task/Role schema dependency: a worker must present the exact durable
 * owner, generation, fencing token, active lease, resource key, and ref witness
 * before it may enter the physical Git port.
 */
export class GitExactRefLifecycleCoordinator {
  constructor(
    readonly rootDir: string,
    private readonly clock: () => Date = () => new Date()
  ) {
    if (typeof rootDir !== "string" || rootDir.length === 0) {
      throw runtimeError("Git lifecycle root is invalid.");
    }
    if (typeof clock !== "function") {
      throw runtimeError("Git lifecycle clock is invalid.");
    }
  }

  prepareExactRefRetirement(input: {
    operationId: string;
    repository: GitRepositoryLineage;
    fullRef: string;
    expectedOid: string;
  }): GitExactRefLifecycleOperation {
    const operationId = parseRepositoryLineageId(input.operationId);
    const resource = createResource(input.repository, input.fullRef, input.expectedOid);
    const existing = this.readOptional(operationId);
    if (existing !== null) {
      assertSameResource(existing.resource, resource);
      return existing;
    }
    return executeDomainTransaction(
      this.rootDir,
      transactionId("prepare", operationId),
      (workingRoot) => {
        const raced = readOperationAt(workingRoot, operationId);
        if (raced !== null) {
          assertSameResource(raced.resource, resource);
          return raced;
        }
        const operation = Object.freeze({
          schemaVersion: 1 as const,
          kind: "git-exact-ref-retirement-operation" as const,
          operationId,
          resource,
          phase: "prepared" as const,
          generation: 0,
          fencingToken: 0,
          claim: null,
          receipt: null
        });
        writeOperationAt(workingRoot, operation);
        return operation;
      }
    );
  }

  get(operationId: string): GitExactRefLifecycleOperation {
    const id = parseRepositoryLineageId(operationId);
    const operation = this.readOptional(id);
    if (operation === null) throw runtimeError("Git exact-ref lifecycle operation was not found.");
    return operation;
  }

  claim(
    operationId: string,
    ownerId: string,
    leaseMs: number
  ): GitLifecycleClaim {
    const id = parseRepositoryLineageId(operationId);
    const owner = parseRepositoryLineageId(ownerId);
    const duration = requireLeaseMs(leaseMs);
    const observed = this.get(id);
    const observedNowMs = this.currentTimeMs();
    if (observed.phase === "completed") {
      throw runtimeError("Completed Git exact-ref lifecycle operations cannot be claimed.");
    }
    if (observed.claim !== null && claimIsActive(observed.claim, observedNowMs)) {
      if (observed.claim.ownerId === owner) return observed.claim;
      throw runtimeError("Git exact-ref lifecycle operation already has an active claim.");
    }
    return executeDomainTransaction(
      this.rootDir,
      transactionId("claim", id),
      (workingRoot) => {
        const current = requireOperationAt(workingRoot, id);
        const nowMs = this.currentTimeMs();
        if (current.phase === "completed") {
          throw runtimeError("Completed Git exact-ref lifecycle operations cannot be claimed.");
        }
        if (current.claim !== null && claimIsActive(current.claim, nowMs)) {
          if (current.claim.ownerId === owner) return current.claim;
          throw runtimeError("Git exact-ref lifecycle operation already has an active claim.");
        }
        const generation = current.generation + 1;
        const fencingToken = Math.max(current.fencingToken + 1, generation + 1);
        const claim = createGitLifecycleClaim({
          operationId: id,
          ownerId: owner,
          generation,
          fencingToken,
          leaseExpiresAt: new Date(nowMs + duration).toISOString()
        });
        const claimed = Object.freeze({
          ...current,
          phase: "claimed" as const,
          generation,
          fencingToken,
          claim,
          receipt: null
        });
        writeOperationAt(workingRoot, claimed);
        return claim;
      }
    );
  }

  begin(
    operationId: string,
    claim: GitLifecycleClaim
  ): GitExactRefLifecycleOperation {
    const id = parseRepositoryLineageId(operationId);
    const expectedClaim = parseGitLifecycleClaim(claim);
    if (expectedClaim.operationId !== id) {
      throw runtimeError("Git lifecycle claim does not name the requested operation.");
    }
    const observed = this.get(id);
    if (observed.phase === "effect-started" && sameClaim(observed.claim, expectedClaim)) {
      assertGitLifecycleClaimActive(expectedClaim, new Date(this.currentTimeMs()));
      return observed;
    }
    return executeDomainTransaction(
      this.rootDir,
      transactionId("begin", id),
      (workingRoot) => {
        const current = requireOperationAt(workingRoot, id);
        const nowMs = this.currentTimeMs();
        assertClaimForOperation(current, expectedClaim, nowMs);
        if (current.phase !== "claimed") {
          throw runtimeError("Git exact-ref lifecycle operation is not ready to begin.");
        }
        const started = Object.freeze({ ...current, phase: "effect-started" as const });
        writeOperationAt(workingRoot, started);
        return started;
      }
    );
  }

  execute(
    operationId: string,
    claim: GitLifecycleClaim,
    options: { faultInjection?: ExactRefRetirementFaultInjection } = {}
  ): ExactRefRetirementReceipt {
    const id = parseRepositoryLineageId(operationId);
    const expectedClaim = parseGitLifecycleClaim(claim);
    if (expectedClaim.operationId !== id) {
      throw runtimeError("Git lifecycle claim does not name the requested operation.");
    }
    const effect = executeDomainExclusiveBarrier(this.rootDir, () => {
      const current = requireOperationAt(this.rootDir, id);
      const nowMs = this.currentTimeMs();
      assertClaimForOperation(current, expectedClaim, nowMs);
      if (current.phase !== "effect-started") {
        throw runtimeError("Git exact-ref lifecycle operation has not started its effect.");
      }
      const repository = assertGitRepositoryLineage(current.resource.repository);
      const ledger = new GitResourceLedger(this.exactRefLedgerRoot());
      const resource = ledger.ensureExactRefResource(repository, current.resource.fullRef);
      if (
        resource.resourceKey !== current.resource.resourceKey ||
        resource.canonicalResourceIdentity !== current.resource.canonicalResourceIdentity ||
        resource.repositoryLineageId !== current.resource.repository.repositoryLineageId
      ) {
        throw runtimeError("Git exact-ref lifecycle resource binding changed before effect.");
      }
      const receipt = retireExactRef({
        ledgerRoot: this.exactRefLedgerRoot(),
        repository,
        operationId: current.operationId,
        fullRef: current.resource.fullRef,
        expectedOid: current.resource.expectedOid,
        faultInjection: options.faultInjection
      });
      assertReceiptForResource(receipt, current);
      return Object.freeze({ operation: current, receipt });
    });
    return this.publishCompletion(effect.operation, expectedClaim, effect.receipt);
  }

  verifyCompleted(operationId: string): ExactRefRetirementReceipt {
    const id = parseRepositoryLineageId(operationId);
    const observed = this.get(id);
    if (observed.phase !== "completed" || observed.receipt === null) {
      throw runtimeError("Git exact-ref lifecycle operation is not completed.");
    }
    return executeDomainExclusiveBarrier(this.rootDir, () => {
      const current = requireOperationAt(this.rootDir, id);
      if (current.phase !== "completed" || current.receipt === null) {
        throw runtimeError("Git exact-ref lifecycle completion changed before verification.");
      }
      assertSameResource(current.resource, observed.resource);
      const repository = assertGitRepositoryLineage(current.resource.repository);
      const receipt = retireExactRef({
        ledgerRoot: this.exactRefLedgerRoot(),
        repository,
        operationId: current.operationId,
        fullRef: current.resource.fullRef,
        expectedOid: current.resource.expectedOid
      });
      assertReceiptForResource(receipt, current);
      if (!sameReceipt(receipt, current.receipt)) {
        throw runtimeError("Git exact-ref lifecycle completion receipt changed.");
      }
      return receipt;
    });
  }

  recover(ownerId: string, leaseMs: number): GitExactRefLifecycleRecovery[] {
    const owner = parseRepositoryLineageId(ownerId);
    const duration = requireLeaseMs(leaseMs);
    const result: GitExactRefLifecycleRecovery[] = [];
    for (const operation of this.list()) {
      if (operation.phase === "completed") {
        this.verifyCompleted(operation.operationId);
        result.push(Object.freeze({ operationId: operation.operationId, status: "completed" }));
        continue;
      }
      if (
        operation.claim !== null &&
        claimIsActive(operation.claim, this.currentTimeMs())
      ) {
        result.push(Object.freeze({
          operationId: operation.operationId,
          status: "active-lease-skipped"
        }));
        continue;
      }
      if (operation.phase !== "effect-started") {
        result.push(Object.freeze({
          operationId: operation.operationId,
          status: "not-started-skipped"
        }));
        continue;
      }
      const claim = this.claim(operation.operationId, owner, duration);
      this.begin(operation.operationId, claim);
      this.execute(operation.operationId, claim);
      result.push(Object.freeze({ operationId: operation.operationId, status: "completed" }));
    }
    return result;
  }

  private publishCompletion(
    expected: GitExactRefLifecycleOperation,
    claim: GitLifecycleClaim,
    receipt: ExactRefRetirementReceipt
  ): ExactRefRetirementReceipt {
    return executeDomainTransaction(
      this.rootDir,
      transactionId("complete", expected.operationId),
      (workingRoot) => {
        const current = requireOperationAt(workingRoot, expected.operationId);
        assertCompletionCas(current, expected, claim, this.currentTimeMs());
        assertReceiptForResource(receipt, current);
        const completed = Object.freeze({
          ...current,
          phase: "completed" as const,
          receipt
        });
        writeOperationAt(workingRoot, completed);
        return receipt;
      }
    );
  }

  private readOptional(operationId: string): GitExactRefLifecycleOperation | null {
    const relativePath = operationRelativePath(operationId);
    return executeDomainReadSnapshot(this.rootDir, (reader) => {
      if (reader === undefined) throw runtimeError("Git lifecycle storage root is unavailable.");
      if (reader.lstat(relativePath) === undefined) return null;
      const read = reader.readFileExact(relativePath, MAX_OPERATION_BYTES);
      return parseOperationContent(read.bytes.toString("utf8"));
    });
  }

  private list(): GitExactRefLifecycleOperation[] {
    return executeDomainReadSnapshot(this.rootDir, (reader) => {
      if (reader === undefined || reader.lstat(OPERATION_DIRECTORY) === undefined) return [];
      const operations: GitExactRefLifecycleOperation[] = [];
      for (const name of [...reader.readdir(OPERATION_DIRECTORY)].sort()) {
        const match = OPERATION_FILE_PATTERN.exec(name);
        if (match === null) throw runtimeError("Git lifecycle operation directory has an invalid entry.");
        const relativePath = `${OPERATION_DIRECTORY}/${name}`;
        const read = reader.readFileExact(relativePath, MAX_OPERATION_BYTES);
        const operation = parseOperationContent(read.bytes.toString("utf8"));
        if (operation.operationId !== match[1]) {
          throw runtimeError("Git lifecycle operation file name does not match its payload.");
        }
        operations.push(operation);
      }
      return operations;
    });
  }

  private exactRefLedgerRoot(): string {
    return join(this.rootDir, ...EXACT_REF_LEDGER_DIRECTORY.split("/"));
  }

  private currentTimeMs(): number {
    return requireTime(this.clock());
  }
}

function createResource(
  repositoryInput: GitRepositoryLineage,
  fullRef: string,
  expectedOid: string
): GitExactRefLifecycleResource {
  const repository = assertGitRepositoryLineage(repositoryInput);
  const effect = parseExactRefEffect({
    kind: "exact-ref-delete",
    objectFormat: repository.objectFormat,
    fullRef,
    expectedOid
  });
  if (effect.kind !== "exact-ref-delete") throw runtimeError("Invalid Git exact-ref lifecycle resource.");
  const canonicalResourceIdentity = canonicalExactRefResourceIdentity(repository, effect.fullRef);
  return Object.freeze({
    repository,
    fullRef: effect.fullRef,
    expectedOid: effect.expectedOid,
    canonicalResourceIdentity,
    resourceKey: sha256(canonicalResourceIdentity)
  });
}

function readOperationAt(rootDir: string, operationId: string): GitExactRefLifecycleOperation | null {
  const path = operationPath(rootDir, operationId);
  const metadata = lstatSync(path, { throwIfNoEntry: false });
  if (metadata === undefined) return null;
  if (metadata.isSymbolicLink() || !metadata.isFile() || metadata.size > MAX_OPERATION_BYTES) {
    throw runtimeError("Git lifecycle operation file is hostile.");
  }
  return parseOperationContent(readFileSync(path, "utf8"));
}

function requireOperationAt(rootDir: string, operationId: string): GitExactRefLifecycleOperation {
  const operation = readOperationAt(rootDir, operationId);
  if (operation === null) throw runtimeError("Git exact-ref lifecycle operation was not found.");
  if (operation.operationId !== operationId) {
    throw runtimeError("Git exact-ref lifecycle operation file identity is invalid.");
  }
  return operation;
}

function writeOperationAt(rootDir: string, operation: GitExactRefLifecycleOperation): void {
  const path = operationPath(rootDir, operation.operationId);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, `${JSON.stringify(operation, null, 2)}\n`, { mode: 0o600 });
}

function operationRelativePath(operationId: string): string {
  return `${OPERATION_DIRECTORY}/${parseRepositoryLineageId(operationId)}.json`;
}

function operationPath(rootDir: string, operationId: string): string {
  return join(rootDir, ...operationRelativePath(operationId).split("/"));
}

function parseOperation(value: unknown): GitExactRefLifecycleOperation {
  const record = exactRecord(value, "Git exact-ref lifecycle operation");
  requireKeys(record, [
    "schemaVersion",
    "kind",
    "operationId",
    "resource",
    "phase",
    "generation",
    "fencingToken",
    "claim",
    "receipt"
  ], "Git exact-ref lifecycle operation");
  if (
    record.schemaVersion !== 1 ||
    record.kind !== "git-exact-ref-retirement-operation" ||
    !["prepared", "claimed", "effect-started", "completed"].includes(record.phase as string) ||
    typeof record.generation !== "number" ||
    !Number.isSafeInteger(record.generation) ||
    record.generation < 0 ||
    typeof record.fencingToken !== "number" ||
    !Number.isSafeInteger(record.fencingToken) ||
    record.fencingToken < 0
  ) {
    throw runtimeError("Invalid Git exact-ref lifecycle operation.");
  }
  const operationId = parseRepositoryLineageId(record.operationId);
  const resource = parseResource(record.resource);
  const claim = record.claim === null ? null : parseGitLifecycleClaim(record.claim);
  const receipt = record.receipt === null ? null : parseReceipt(record.receipt, resource.repository.objectFormat);
  const phase = record.phase as GitExactRefLifecycleOperation["phase"];
  if (
    (phase === "prepared" && (
      claim !== null ||
      receipt !== null ||
      record.generation !== 0 ||
      record.fencingToken !== 0
    )) ||
    (phase === "claimed" && (claim === null || receipt !== null)) ||
    (phase === "effect-started" && (claim === null || receipt !== null)) ||
    (phase === "completed" && (claim === null || receipt === null)) ||
    (claim !== null && (
      claim.operationId !== operationId ||
      claim.generation !== record.generation ||
      claim.fencingToken !== record.fencingToken
    ))
  ) {
    throw runtimeError("Invalid Git exact-ref lifecycle operation state.");
  }
  const operation = Object.freeze({
    schemaVersion: 1 as const,
    kind: "git-exact-ref-retirement-operation" as const,
    operationId,
    resource,
    phase,
    generation: record.generation,
    fencingToken: record.fencingToken,
    claim,
    receipt
  });
  if (receipt !== null) assertReceiptForResource(receipt, operation);
  return operation;
}

function parseOperationContent(content: string): GitExactRefLifecycleOperation {
  try {
    return parseOperation(JSON.parse(content) as unknown);
  } catch (error) {
    if (error instanceof Error && "code" in error) throw error;
    throw runtimeError("Invalid Git exact-ref lifecycle operation.");
  }
}

function parseResource(value: unknown): GitExactRefLifecycleResource {
  const record = exactRecord(value, "Git exact-ref lifecycle resource");
  requireKeys(record, [
    "repository",
    "fullRef",
    "expectedOid",
    "canonicalResourceIdentity",
    "resourceKey"
  ], "Git exact-ref lifecycle resource");
  if (
    typeof record.canonicalResourceIdentity !== "string" ||
    typeof record.resourceKey !== "string" ||
    !/^[0-9a-f]{64}$/.test(record.resourceKey)
  ) {
    throw runtimeError("Invalid Git exact-ref lifecycle resource.");
  }
  const repository = parseRepository(record.repository);
  const resource = createResource(repository, asString(record.fullRef, "Git exact-ref lifecycle resource"), asString(record.expectedOid, "Git exact-ref lifecycle resource"));
  if (
    resource.canonicalResourceIdentity !== record.canonicalResourceIdentity ||
    resource.resourceKey !== record.resourceKey
  ) {
    throw runtimeError("Git exact-ref lifecycle resource binding is invalid.");
  }
  return resource;
}

function parseRepository(value: unknown): GitRepositoryLineage {
  const record = exactRecord(value, "Git exact-ref lifecycle repository");
  requireKeys(record, [
    "schemaVersion",
    "repositoryLineageId",
    "canonicalCommonDir",
    "commonDirDevice",
    "commonDirInode",
    "commonDirBirthtimeNs",
    "objectFormat"
  ], "Git exact-ref lifecycle repository");
  if (
    record.schemaVersion !== 1 ||
    typeof record.canonicalCommonDir !== "string" ||
    typeof record.commonDirDevice !== "string" ||
    typeof record.commonDirInode !== "string" ||
    typeof record.commonDirBirthtimeNs !== "string" ||
    (record.objectFormat !== "sha1" && record.objectFormat !== "sha256")
  ) {
    throw runtimeError("Invalid Git exact-ref lifecycle repository.");
  }
  return assertGitRepositoryLineage(Object.freeze({
    schemaVersion: 1 as const,
    repositoryLineageId: parseRepositoryLineageId(record.repositoryLineageId),
    canonicalCommonDir: record.canonicalCommonDir,
    commonDirDevice: record.commonDirDevice,
    commonDirInode: record.commonDirInode,
    commonDirBirthtimeNs: record.commonDirBirthtimeNs,
    objectFormat: record.objectFormat
  }));
}

function parseReceipt(
  value: unknown,
  objectFormat: GitRepositoryLineage["objectFormat"]
): ExactRefRetirementReceipt {
  const record = exactRecord(value, "Git exact-ref lifecycle receipt");
  requireKeys(record, [
    "schemaVersion",
    "kind",
    "status",
    "operationId",
    "repositoryLineageId",
    "resourceKey",
    "canonicalResourceIdentity",
    "fullRef",
    "expectedOid",
    "reflog",
    "ledgerPath"
  ], "Git exact-ref lifecycle receipt");
  if (
    record.schemaVersion !== 1 ||
    record.kind !== "exact-ref-retirement-receipt" ||
    record.status !== "retired" ||
    typeof record.resourceKey !== "string" ||
    !/^[0-9a-f]{64}$/.test(record.resourceKey) ||
    typeof record.canonicalResourceIdentity !== "string" ||
    typeof record.ledgerPath !== "string"
  ) {
    throw runtimeError("Invalid Git exact-ref lifecycle receipt.");
  }
  const fullRef = asString(record.fullRef, "Git exact-ref lifecycle receipt");
  const expectedOid = asString(record.expectedOid, "Git exact-ref lifecycle receipt");
  const reflog = parseReflog(record.reflog);
  return Object.freeze({
    schemaVersion: 1,
    kind: "exact-ref-retirement-receipt",
    status: "retired",
    operationId: parseRepositoryLineageId(record.operationId),
    repositoryLineageId: parseRepositoryLineageId(record.repositoryLineageId),
    resourceKey: record.resourceKey,
    canonicalResourceIdentity: record.canonicalResourceIdentity,
    fullRef: parseExactRefEffect({
      kind: "exact-ref-delete",
      objectFormat,
      fullRef,
      expectedOid
    }).fullRef,
    expectedOid,
    reflog,
    ledgerPath: record.ledgerPath
  }) as ExactRefRetirementReceipt;
}

function parseReflog(value: unknown): ExactRefRetirementReceipt["reflog"] {
  const record = exactRecord(value, "Git exact-ref lifecycle reflog witness");
  if (record.kind === "absent" && Object.keys(record).length === 1) {
    return Object.freeze({ kind: "absent" });
  }
  requireKeys(record, ["kind", "sha256", "bytes", "device", "inode"], "Git exact-ref lifecycle reflog witness");
  if (
    record.kind !== "present" ||
    typeof record.sha256 !== "string" ||
    !/^[0-9a-f]{64}$/.test(record.sha256) ||
    typeof record.bytes !== "number" ||
    !Number.isSafeInteger(record.bytes) ||
    record.bytes < 0 ||
    typeof record.device !== "string" ||
    typeof record.inode !== "string"
  ) {
    throw runtimeError("Invalid Git exact-ref lifecycle reflog witness.");
  }
  return Object.freeze({
    kind: "present" as const,
    sha256: record.sha256,
    bytes: record.bytes,
    device: record.device,
    inode: record.inode
  });
}

function assertClaimForOperation(
  operation: GitExactRefLifecycleOperation,
  expected: GitLifecycleClaim,
  nowMs: number
): void {
  if (
    operation.claim === null ||
    !sameClaim(operation.claim, expected) ||
    operation.generation !== expected.generation ||
    operation.fencingToken !== expected.fencingToken
  ) {
    throw runtimeError("Git exact-ref lifecycle claim is stale or foreign.");
  }
  assertGitLifecycleClaimActive(expected, new Date(nowMs));
  assertGitRepositoryLineage(operation.resource.repository);
}

function assertCompletionCas(
  current: GitExactRefLifecycleOperation,
  expected: GitExactRefLifecycleOperation,
  claim: GitLifecycleClaim,
  nowMs: number
): void {
  assertClaimForOperation(current, claim, nowMs);
  if (
    current.phase !== "effect-started" ||
    expected.phase !== "effect-started" ||
    !sameClaim(current.claim, claim) ||
    !sameClaim(expected.claim, claim) ||
    current.generation !== expected.generation ||
    current.fencingToken !== expected.fencingToken
  ) {
    throw runtimeError("Git exact-ref lifecycle completion compare-and-swap failed.");
  }
  assertSameResource(current.resource, expected.resource);
}

function assertReceiptForResource(
  receipt: ExactRefRetirementReceipt,
  operation: Pick<GitExactRefLifecycleOperation, "operationId" | "resource">
): void {
  const resource = operation.resource;
  const effect = parseExactRefEffect({
    kind: "exact-ref-delete",
    objectFormat: resource.repository.objectFormat,
    fullRef: receipt.fullRef,
    expectedOid: receipt.expectedOid
  });
  if (
    effect.kind !== "exact-ref-delete" ||
    receipt.operationId !== operation.operationId ||
    receipt.repositoryLineageId !== resource.repository.repositoryLineageId ||
    receipt.resourceKey !== resource.resourceKey ||
    receipt.canonicalResourceIdentity !== resource.canonicalResourceIdentity ||
    receipt.fullRef !== resource.fullRef ||
    receipt.expectedOid !== resource.expectedOid
  ) {
    throw runtimeError("Git exact-ref lifecycle receipt does not match its operation.");
  }
}

function assertSameResource(
  left: GitExactRefLifecycleResource,
  right: GitExactRefLifecycleResource
): void {
  if (
    left.fullRef !== right.fullRef ||
    left.expectedOid !== right.expectedOid ||
    left.canonicalResourceIdentity !== right.canonicalResourceIdentity ||
    left.resourceKey !== right.resourceKey ||
    JSON.stringify(left.repository) !== JSON.stringify(right.repository)
  ) {
    throw runtimeError("Git exact-ref lifecycle resource binding changed.");
  }
}

function sameClaim(left: GitLifecycleClaim | null, right: GitLifecycleClaim | null): boolean {
  return left !== null && right !== null &&
    left.operationId === right.operationId &&
    left.ownerId === right.ownerId &&
    left.generation === right.generation &&
    left.fencingToken === right.fencingToken &&
    left.leaseExpiresAt === right.leaseExpiresAt;
}

function sameReceipt(left: ExactRefRetirementReceipt, right: ExactRefRetirementReceipt): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function claimIsActive(claim: GitLifecycleClaim, nowMs: number): boolean {
  return Date.parse(claim.leaseExpiresAt) > nowMs;
}

function requireTime(value: Date): number {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw runtimeError("Git lifecycle time is invalid.");
  }
  return value.getTime();
}

function requireLeaseMs(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > 24 * 60 * 60 * 1000) {
    throw runtimeError("Git lifecycle lease duration is invalid.");
  }
  return value;
}

function transactionId(label: string, operationId: string): string {
  return `git-lifecycle-${label}-${operationId}-${randomUUID()}`;
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function asString(value: unknown, label: string): string {
  if (typeof value !== "string") throw runtimeError(`Invalid ${label}.`);
  return value;
}

function exactRecord(value: unknown, label: string): Record<string, unknown> {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    utilTypes.isProxy(value) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value))
  ) {
    throw runtimeError(`Invalid ${label}.`);
  }
  const record = value as Record<string, unknown>;
  for (const key of Reflect.ownKeys(record)) {
    if (typeof key !== "string") throw runtimeError(`Invalid ${label}.`);
    const descriptor = Object.getOwnPropertyDescriptor(record, key);
    if (descriptor === undefined || !("value" in descriptor) || descriptor.enumerable !== true) {
      throw runtimeError(`Invalid ${label}.`);
    }
  }
  return record;
}

function requireKeys(record: Record<string, unknown>, expected: readonly string[], label: string): void {
  const keys = Object.keys(record);
  if (keys.length !== expected.length || expected.some((key) => !Object.hasOwn(record, key))) {
    throw runtimeError(`Invalid ${label}.`);
  }
}
