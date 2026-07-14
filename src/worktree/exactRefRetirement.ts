import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  lstatSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeSync
} from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { runtimeError } from "../errors/cliError.js";
import { MAX_AUTHORITATIVE_RECORD_BYTES } from "../storage/storageLimits.js";
import {
  MAX_GIT_REF_BYTES,
  parseExactRefEffect,
  parseFullLocalBranchRef,
  parseRepositoryLineageId
} from "./gitCommand.js";
import {
  assertGitRepositoryLineage,
  GitResourceLedger,
  type GitExactRefResource,
  type GitRepositoryLineage
} from "./gitResourceLedger.js";

// The raw packed-ref reader never admits more than one native-authoritative
// record. The staged journal has a stricter, serialized-size gate in the
// ledger because its base64 payload expands this raw input.
const MAX_PACKED_REFS_BYTES = MAX_AUTHORITATIVE_RECORD_BYTES;
const MAX_LOOSE_REF_BYTES = 256;
const MAX_GIT_HEAD_BYTES = MAX_GIT_REF_BYTES + Buffer.byteLength("ref: \n", "utf8");
const DIRECTORY_OPEN_FLAGS = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW;

export type ExactRefRetirementFaultInjection = Readonly<{
  crashAfterJournalStage?: boolean;
  crashAfterPackedTemporaryWrite?: boolean;
  crashAfterPublication?: boolean;
  afterLocksAcquired?: () => void;
}>;

export type ExactRefRetirementRequest = Readonly<{
  ledgerRoot: string;
  repository: GitRepositoryLineage;
  operationId: string;
  fullRef: string;
  expectedOid: string;
  faultInjection?: ExactRefRetirementFaultInjection;
}>;

type AnchoredFileIdentity = Readonly<{
  dev: string;
  ino: string;
  birthtimeNs: string;
  uid: string;
  mode: string;
  nlink: string;
}>;

type LooseWitness =
  | Readonly<{ kind: "absent" }>
  | Readonly<{ kind: "present"; oid: string; sha256: string; bytes: number; identity: AnchoredFileIdentity }>;

type PackedWitness =
  | Readonly<{ kind: "absent" }>
  | Readonly<{
      kind: "present";
      beforeSha256: string;
      afterSha256: string;
      afterBytesBase64: string;
      beforeBytes: number;
      targetOid: string | null;
      removeStartByte: number | null;
      removeEndByte: number | null;
    }>;

type ReflogWitness =
  | Readonly<{ kind: "absent" }>
  | Readonly<{ kind: "present"; sha256: string; bytes: number; device: string; inode: string }>;

type ExactRefRetirementJournal = Readonly<{
  schemaVersion: 2;
  kind: "exact-ref-retirement";
  status: "prepared";
  operationId: string;
  resource: GitExactRefResource;
  fullRef: string;
  expectedOid: string;
  loose: LooseWitness;
  packed: PackedWitness;
  reflog: ReflogWitness;
}>;

export type ExactRefRetirementReceipt = Readonly<{
  schemaVersion: 1;
  kind: "exact-ref-retirement-receipt";
  status: "retired";
  operationId: string;
  repositoryLineageId: string;
  resourceKey: string;
  canonicalResourceIdentity: string;
  fullRef: string;
  expectedOid: string;
  reflog: ReflogWitness;
  ledgerPath: string;
}>;

type PackedRefEntry = Readonly<{
  oid: string;
  fullRef: string;
  startByte: number;
  endByte: number;
}>;

type PackedRefsSnapshot =
  | Readonly<{ kind: "absent" }>
  | Readonly<{ kind: "present"; bytes: Buffer; sha256: string; entry: PackedRefEntry | null }>;

type ExactRefGitLocks = Readonly<{
  looseLockPath: string;
  packedLockPath: string;
  looseMarker: Buffer;
  packedLockBytes: Buffer;
}>;

class InjectedExactRefRetirementCrash extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InjectedExactRefRetirementCrash";
  }
}

export function retireExactRef(value: ExactRefRetirementRequest): ExactRefRetirementReceipt {
  const request = parseRequest(value);
  const ledger = new GitResourceLedger(request.ledgerRoot);
  const resource = ledger.ensureExactRefResource(request.repository, request.fullRef);
  const paths = ledger.exactRefRetirementPaths(resource, request.operationId);
  const published = ledger.readPublishedExactRefRetirement(resource, request.operationId);
  if (published !== null && !journalExists(paths.pendingPath)) {
    const receipt = parseReceipt(published, paths.publishedPath);
    assertReceiptMatches(receipt, resource, request);
    assertNoSymbolicHeadTargets(request.repository, request.fullRef);
    assertRetiredPostconditions(request.repository, request.fullRef, receipt.reflog);
    return receipt;
  }

  let journal: ExactRefRetirementJournal;
  if (journalExists(paths.pendingPath)) {
    journal = parseJournal(readRegularText(paths.pendingPath, "Git exact-ref retirement journal"));
    assertJournalMatches(journal, resource, request);
  } else {
    journal = inspectNewRetirement(resource, request);
    ledger.stageExactRefRetirement(resource, request.operationId, serializeJournal(journal));
    if (request.faultInjection.crashAfterJournalStage === true) {
      throw injectedCrash("Injected exact-ref retirement crash after journal stage.");
    }
  }
  return finalizeRetirement(ledger, request, resource, journal);
}

export function recoverExactRefRetirements(input: {
  ledgerRoot: string;
  repository: GitRepositoryLineage;
}): ExactRefRetirementReceipt[] {
  const repository = assertGitRepositoryLineage(input.repository);
  const ledger = new GitResourceLedger(input.ledgerRoot);
  const recovered: ExactRefRetirementReceipt[] = [];
  for (const entry of ledger.listStagedExactRefRetirements(repository)) {
    const journal = parseJournal(entry.content);
    if (journal.resource.repositoryLineageId !== repository.repositoryLineageId) {
      throw runtimeError("Exact-ref recovery journal has a foreign repository lineage.");
    }
    const resource = ledger.ensureExactRefResource(repository, journal.fullRef);
    const expected = ledger.exactRefRetirementPaths(resource, journal.operationId);
    if (
      entry.operationId !== journal.operationId ||
      entry.resourceKey !== resource.resourceKey ||
      entry.ledgerPath !== expected.pendingPath
    ) {
      throw runtimeError("Exact-ref recovery journal path does not match its resource identity.");
    }
    const request = parseRequest({
      ledgerRoot: input.ledgerRoot,
      repository,
      operationId: journal.operationId,
      fullRef: journal.fullRef,
      expectedOid: journal.expectedOid
    });
    assertJournalMatches(journal, resource, request);
    recovered.push(finalizeRetirement(ledger, request, resource, journal));
  }
  return recovered;
}

function parseRequest(value: ExactRefRetirementRequest): {
  ledgerRoot: string;
  repository: GitRepositoryLineage;
  operationId: string;
  fullRef: string;
  expectedOid: string;
  reflog: ReflogWitness;
  faultInjection: ExactRefRetirementFaultInjection;
} {
  if (value === null || typeof value !== "object") throw runtimeError("Invalid exact-ref retirement request.");
  const repository = assertGitRepositoryLineage(value.repository);
  const effect = parseExactRefEffect({
    kind: "exact-ref-delete",
    objectFormat: repository.objectFormat,
    fullRef: value.fullRef,
    expectedOid: value.expectedOid
  });
  if (effect.kind !== "exact-ref-delete" || typeof value.ledgerRoot !== "string" || value.ledgerRoot.length === 0) {
    throw runtimeError("Invalid exact-ref retirement request.");
  }
  return {
    ledgerRoot: value.ledgerRoot,
    repository,
    operationId: parseRepositoryLineageId(value.operationId),
    fullRef: effect.fullRef,
    expectedOid: effect.expectedOid,
    reflog: captureReflogWitness(repository, effect.fullRef),
    faultInjection: parseFaultInjection(value.faultInjection)
  };
}

function parseFaultInjection(value: ExactRefRetirementFaultInjection | undefined): ExactRefRetirementFaultInjection {
  if (value === undefined) return Object.freeze({});
  if (
    value === null ||
    typeof value !== "object" ||
    Object.keys(value).some((key) =>
      !["crashAfterJournalStage", "crashAfterPackedTemporaryWrite", "crashAfterPublication", "afterLocksAcquired"].includes(key)
    ) ||
    [value.crashAfterJournalStage, value.crashAfterPackedTemporaryWrite, value.crashAfterPublication]
      .some((entry) => entry !== undefined && typeof entry !== "boolean") ||
    (value.afterLocksAcquired !== undefined && typeof value.afterLocksAcquired !== "function")
  ) {
    throw runtimeError("Invalid exact-ref retirement fault injection.");
  }
  return Object.freeze({
    crashAfterJournalStage: value.crashAfterJournalStage,
    crashAfterPackedTemporaryWrite: value.crashAfterPackedTemporaryWrite,
    crashAfterPublication: value.crashAfterPublication,
    afterLocksAcquired: value.afterLocksAcquired
  });
}

function inspectNewRetirement(
  resource: GitExactRefResource,
  request: ReturnType<typeof parseRequest>
): ExactRefRetirementJournal {
  assertGitRepositoryLineage(request.repository);
  assertNoSymbolicHeadTargets(request.repository, request.fullRef);
  assertReflogWitness(request.repository, request.fullRef, request.reflog);
  assertNoForeignLocks(request.repository, request.fullRef);
  const loose = captureLooseWitness(request.repository, request.fullRef);
  const packed = capturePackedWitness(request.repository, request.fullRef);
  const visibleOid = loose.kind === "present" ? loose.oid : packed.kind === "present" ? packed.targetOid : null;
  if (visibleOid === null || visibleOid !== request.expectedOid) {
    throw runtimeError("Exact Git ref does not match the expected object id.");
  }
  return Object.freeze({
    schemaVersion: 2,
    kind: "exact-ref-retirement",
    status: "prepared",
    operationId: request.operationId,
    resource,
    fullRef: request.fullRef,
    expectedOid: request.expectedOid,
    loose,
    packed,
    reflog: request.reflog
  });
}

function finalizeRetirement(
  ledger: GitResourceLedger,
  request: ReturnType<typeof parseRequest>,
  resource: GitExactRefResource,
  journal: ExactRefRetirementJournal
): ExactRefRetirementReceipt {
  assertJournalMatches(journal, resource, request);
  const paths = ledger.exactRefRetirementPaths(resource, request.operationId);
  const stagedContent = serializeJournal(journal);
  const published = ledger.readPublishedExactRefRetirement(resource, request.operationId);
  if (published !== null) {
    const receipt = parseReceipt(published, paths.publishedPath);
    assertReceiptMatches(receipt, resource, request);
    if (JSON.stringify(receipt.reflog) !== JSON.stringify(journal.reflog)) {
      throw runtimeError("Exact-ref retirement receipt reflog witness does not match the journal.");
    }
    assertNoSymbolicHeadTargets(request.repository, request.fullRef);
    assertLooseWitnessCompatible(request.repository, request.fullRef, journal.loose);
    const locks = acquireOrAdoptExactRefLocks(request.repository, request.fullRef, journal);
    try {
      assertNoSymbolicHeadTargets(request.repository, request.fullRef);
      assertLooseWitnessCompatible(request.repository, request.fullRef, journal.loose);
      assertRetiredPostconditions(request.repository, request.fullRef, receipt.reflog);
    } finally {
      releaseExactRefLocks(locks);
    }
    ledger.removeStagedExactRefRetirement(resource, request.operationId, stagedContent);
    return receipt;
  }

  let locks: ExactRefGitLocks | null = null;
  let mutated = false;
  try {
    assertNoSymbolicHeadTargets(request.repository, request.fullRef);
    assertLooseWitnessCompatible(request.repository, request.fullRef, journal.loose);
    locks = acquireOrAdoptExactRefLocks(request.repository, request.fullRef, journal);
    request.faultInjection.afterLocksAcquired?.();
    assertGitRepositoryLineage(request.repository);
    assertNoSymbolicHeadTargets(request.repository, request.fullRef);
    assertReflogWitness(request.repository, request.fullRef, journal.reflog);
    assertLooseWitnessCompatible(request.repository, request.fullRef, journal.loose);
    mutated = applyLooseRetirement(request.repository, request.fullRef, journal.loose, locks) || mutated;
    mutated = applyPackedRetirement(request.repository, request.fullRef, journal.packed, locks, request.faultInjection) || mutated;
    assertRetiredPostconditions(request.repository, request.fullRef, journal.reflog);
    const receipt = Object.freeze({
      schemaVersion: 1 as const,
      kind: "exact-ref-retirement-receipt" as const,
      status: "retired" as const,
      operationId: request.operationId,
      repositoryLineageId: resource.repositoryLineageId,
      resourceKey: resource.resourceKey,
      canonicalResourceIdentity: resource.canonicalResourceIdentity,
      fullRef: request.fullRef,
      expectedOid: request.expectedOid,
      reflog: journal.reflog,
      ledgerPath: paths.publishedPath
    });
    ledger.publishExactRefRetirement(resource, request.operationId, serializeReceipt(receipt));
    if (request.faultInjection.crashAfterPublication === true) {
      throw injectedCrash("Injected exact-ref retirement crash after publication.");
    }
    releaseExactRefLocks(locks);
    locks = null;
    ledger.removeStagedExactRefRetirement(resource, request.operationId, stagedContent);
    return receipt;
  } catch (error) {
    if (locks !== null && !mutated && !(error instanceof InjectedExactRefRetirementCrash)) {
      releaseExactRefLocks(locks);
    }
    throw error;
  }
}

function applyLooseRetirement(
  repository: GitRepositoryLineage,
  fullRef: string,
  witness: LooseWitness,
  locks: ExactRefGitLocks
): boolean {
  assertOwnedGitLock(locks.looseLockPath, locks.looseMarker);
  const current = captureLooseWitness(repository, fullRef);
  if (witness.kind === "absent") {
    if (current.kind !== "absent") throw runtimeError("Git loose ref changed before retirement.");
    return false;
  }
  if (current.kind === "absent") return false;
  if (
    current.oid !== witness.oid ||
    current.sha256 !== witness.sha256 ||
    current.bytes !== witness.bytes ||
    !sameAnchoredFileIdentity(current.identity, witness.identity)
  ) {
    throw runtimeError("Git loose ref changed before retirement.");
  }
  const path = pathForRef(repository, fullRef);
  unlinkSync(path);
  fsyncDirectory(dirname(path));
  return true;
}

function applyPackedRetirement(
  repository: GitRepositoryLineage,
  fullRef: string,
  witness: PackedWitness,
  locks: ExactRefGitLocks,
  faultInjection: ExactRefRetirementFaultInjection
): boolean {
  assertOwnedGitLock(locks.packedLockPath, locks.packedLockBytes);
  const current = readPackedRefs(repository, fullRef);
  if (witness.kind === "absent") {
    if (current.kind !== "absent") throw runtimeError("Git packed-refs appeared before retirement.");
    return false;
  }
  if (current.kind === "absent") throw runtimeError("Git packed-refs disappeared before retirement.");
  const after = decodeCanonicalBase64(witness.afterBytesBase64, "Git packed-refs journal");
  if (sha256(after) !== witness.afterSha256) throw runtimeError("Git packed-refs journal digest is invalid.");
  if (current.sha256 === witness.afterSha256) {
    assertPackedAfterState(current, fullRef, witness);
    return false;
  }
  if (current.sha256 !== witness.beforeSha256 || current.bytes.length !== witness.beforeBytes) {
    throw runtimeError("Git packed-refs changed before retirement.");
  }
  const entry = current.entry;
  if (
    witness.targetOid === null ||
    entry === null ||
    entry.oid !== witness.targetOid ||
    entry.startByte !== witness.removeStartByte ||
    entry.endByte !== witness.removeEndByte
  ) {
    throw runtimeError("Git packed-refs exact target changed before retirement.");
  }
  const expectedAfter = Buffer.concat([current.bytes.subarray(0, entry.startByte), current.bytes.subarray(entry.endByte)]);
  if (!expectedAfter.equals(after)) throw runtimeError("Git packed-refs byte range changed before retirement.");
  if (faultInjection.crashAfterPackedTemporaryWrite === true) {
    throw injectedCrash("Injected exact-ref retirement crash after packed temporary write.");
  }
  const path = packedRefsPath(repository);
  const beforeRename = readPackedRefs(repository, fullRef);
  if (beforeRename.kind !== "present" || beforeRename.sha256 !== witness.beforeSha256) {
    throw runtimeError("Git packed-refs changed before publication.");
  }
  assertOwnedGitLock(locks.packedLockPath, after);
  renameSync(locks.packedLockPath, path);
  fsyncDirectory(dirname(path));
  const afterRename = readPackedRefs(repository, fullRef);
  if (afterRename.kind !== "present" || afterRename.sha256 !== witness.afterSha256) {
    throw runtimeError("Git packed-refs publication could not be verified.");
  }
  assertPackedAfterState(afterRename, fullRef, witness);
  return true;
}

function assertPackedAfterState(
  current: Exclude<PackedRefsSnapshot, { kind: "absent" }>,
  fullRef: string,
  witness: Exclude<PackedWitness, { kind: "absent" }>
): void {
  if (current.entry !== null && current.entry.fullRef === fullRef) {
    throw runtimeError("Git packed-refs retained the retired exact ref.");
  }
  if (witness.targetOid === null && witness.beforeSha256 !== witness.afterSha256) {
    throw runtimeError("Git packed-refs journal target is invalid.");
  }
}

function assertRetiredPostconditions(repository: GitRepositoryLineage, fullRef: string, reflog: ReflogWitness): void {
  assertGitRepositoryLineage(repository);
  assertReflogWitness(repository, fullRef, reflog);
  if (captureLooseWitness(repository, fullRef).kind !== "absent") {
    throw runtimeError("Git loose ref remained after retirement.");
  }
  const packed = readPackedRefs(repository, fullRef);
  if (packed.kind === "present" && packed.entry !== null) throw runtimeError("Git packed ref remained after retirement.");
}

function captureLooseWitness(repository: GitRepositoryLineage, fullRef: string): LooseWitness {
  const path = pathForRef(repository, fullRef);
  assertParentDirectories(repository.canonicalCommonDir, fullRef.split("/"), "Git loose ref");
  const current = readAnchoredRegularFile(path, "Git loose ref", MAX_LOOSE_REF_BYTES);
  if (current === null) return Object.freeze({ kind: "absent" });
  const oid = parseDirectOid(current.bytes, repository.objectFormat, "Git loose ref");
  return Object.freeze({
    kind: "present",
    oid,
    sha256: sha256(current.bytes),
    bytes: current.bytes.length,
    identity: current.identity
  });
}

function assertLooseWitnessCompatible(
  repository: GitRepositoryLineage,
  fullRef: string,
  witness: LooseWitness
): void {
  const current = captureLooseWitness(repository, fullRef);
  if (witness.kind === "absent") {
    if (current.kind !== "absent") throw runtimeError("Git loose ref changed before retirement.");
    return;
  }
  if (current.kind === "absent") return;
  if (
    current.oid !== witness.oid ||
    current.sha256 !== witness.sha256 ||
    current.bytes !== witness.bytes ||
    !sameAnchoredFileIdentity(current.identity, witness.identity)
  ) {
    throw runtimeError("Git loose ref changed before retirement.");
  }
}

function readAnchoredRegularFile(
  path: string,
  label: string,
  maximumBytes: number
): Readonly<{ bytes: Buffer; identity: AnchoredFileIdentity }> | null {
  const before = lstatSync(path, { bigint: true, throwIfNoEntry: false });
  if (before === undefined) return null;
  assertAnchorableRegularFile(before, label, maximumBytes);
  const expected = anchoredFileIdentity(before);
  let descriptor: number;
  try {
    descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch {
    throw runtimeError(`${label} has a hostile filesystem state.`);
  }
  let bytes: Buffer;
  try {
    const opened = fstatSync(descriptor, { bigint: true });
    assertAnchorableRegularFile(opened, label, maximumBytes);
    if (!sameAnchoredFileIdentity(anchoredFileIdentity(opened), expected)) {
      throw runtimeError(`${label} changed while opening.`);
    }
    bytes = readFileSync(descriptor);
    const afterRead = fstatSync(descriptor, { bigint: true });
    assertAnchorableRegularFile(afterRead, label, maximumBytes);
    if (
      !sameAnchoredFileIdentity(anchoredFileIdentity(afterRead), expected) ||
      afterRead.size !== BigInt(bytes.length)
    ) {
      throw runtimeError(`${label} changed while reading.`);
    }
  } finally {
    closeSync(descriptor);
  }
  const afterPath = lstatSync(path, { bigint: true, throwIfNoEntry: false });
  if (afterPath === undefined) throw runtimeError(`${label} changed while reading.`);
  assertAnchorableRegularFile(afterPath, label, maximumBytes);
  if (!sameAnchoredFileIdentity(anchoredFileIdentity(afterPath), expected)) {
    throw runtimeError(`${label} changed while reading.`);
  }
  return Object.freeze({ bytes, identity: expected });
}

function assertAnchorableRegularFile(
  metadata: {
    dev: bigint;
    ino: bigint;
    birthtimeNs: bigint;
    uid: bigint;
    mode: bigint;
    nlink: bigint;
    size: bigint;
    isFile(): boolean;
    isSymbolicLink(): boolean;
  },
  label: string,
  maximumBytes: number
): void {
  if (
    metadata.isSymbolicLink() ||
    !metadata.isFile() ||
    metadata.nlink !== 1n ||
    metadata.size > BigInt(maximumBytes) ||
    metadata.dev <= 0n ||
    metadata.ino <= 0n ||
    metadata.birthtimeNs <= 0n
  ) {
    throw runtimeError(`${label} has a hostile filesystem state.`);
  }
}

function anchoredFileIdentity(metadata: {
  dev: bigint;
  ino: bigint;
  birthtimeNs: bigint;
  uid: bigint;
  mode: bigint;
  nlink: bigint;
}): AnchoredFileIdentity {
  return Object.freeze({
    dev: String(metadata.dev),
    ino: String(metadata.ino),
    birthtimeNs: String(metadata.birthtimeNs),
    uid: String(metadata.uid),
    mode: String(metadata.mode),
    nlink: String(metadata.nlink)
  });
}

function sameAnchoredFileIdentity(left: AnchoredFileIdentity, right: AnchoredFileIdentity): boolean {
  return left.dev === right.dev &&
    left.ino === right.ino &&
    left.birthtimeNs === right.birthtimeNs &&
    left.uid === right.uid &&
    left.mode === right.mode &&
    left.nlink === right.nlink;
}

function capturePackedWitness(repository: GitRepositoryLineage, fullRef: string): PackedWitness {
  const packed = readPackedRefs(repository, fullRef);
  if (packed.kind === "absent") return Object.freeze({ kind: "absent" });
  const entry = packed.entry;
  const after = entry === null
    ? Buffer.from(packed.bytes)
    : Buffer.concat([packed.bytes.subarray(0, entry.startByte), packed.bytes.subarray(entry.endByte)]);
  return Object.freeze({
    kind: "present",
    beforeSha256: packed.sha256,
    afterSha256: sha256(after),
    afterBytesBase64: after.toString("base64"),
    beforeBytes: packed.bytes.length,
    targetOid: entry?.oid ?? null,
    removeStartByte: entry?.startByte ?? null,
    removeEndByte: entry?.endByte ?? null
  });
}

function readPackedRefs(repository: GitRepositoryLineage, fullRef: string): PackedRefsSnapshot {
  const path = packedRefsPath(repository);
  const metadata = lstatSync(path, { throwIfNoEntry: false });
  if (metadata === undefined) return Object.freeze({ kind: "absent" });
  if (metadata.isSymbolicLink() || !metadata.isFile() || metadata.nlink !== 1 || metadata.size > MAX_PACKED_REFS_BYTES) {
    throw runtimeError("Git packed-refs has a hostile filesystem state.");
  }
  const bytes = readFileSync(path);
  assertCanonicalUtf8(bytes, "Git packed-refs");
  return Object.freeze({
    kind: "present",
    bytes,
    sha256: sha256(bytes),
    entry: parsePackedEntry(bytes, repository.objectFormat, fullRef)
  });
}

function parsePackedEntry(
  bytes: Buffer,
  objectFormat: GitRepositoryLineage["objectFormat"],
  targetRef: string
): PackedRefEntry | null {
  const oidLength = objectFormat === "sha1" ? 40 : 64;
  let offset = 0;
  let last: PackedRefEntry | null = null;
  let target: PackedRefEntry | null = null;
  while (offset < bytes.length) {
    const newline = bytes.indexOf(0x0a, offset);
    if (newline < 0) throw runtimeError("Git packed-refs has a truncated line.");
    const endByte = newline + 1;
    const line = bytes.subarray(offset, newline);
    if (line.length === 0 || line.includes(0)) throw runtimeError("Git packed-refs contains a malformed line.");
    if (line[0] === 0x23) {
      last = null;
    } else if (line[0] === 0x5e) {
      if (last === null || line.length !== oidLength + 1 || !isLowerHex(line.subarray(1))) {
        throw runtimeError("Git packed-refs contains a malformed peeled line.");
      }
      if (last.fullRef === targetRef) {
        target = Object.freeze({ ...last, endByte });
      }
      last = null;
    } else {
      if (line.length <= oidLength + 1 || line[oidLength] !== 0x20 || !isLowerHex(line.subarray(0, oidLength))) {
        throw runtimeError("Git packed-refs contains a malformed direct line.");
      }
      const fullRef = decodeUtf8(line.subarray(oidLength + 1), "Git packed-refs ref name");
      assertValidPackedRefName(fullRef);
      const entry = Object.freeze({
        oid: line.subarray(0, oidLength).toString("ascii"),
        fullRef,
        startByte: offset,
        endByte
      });
      if (fullRef === targetRef) {
        if (target !== null) throw runtimeError("Git packed-refs has duplicate exact refs.");
        target = entry;
      }
      last = entry;
    }
    offset = endByte;
  }
  return target;
}

function assertValidPackedRefName(value: string): void {
  if (
    !value.startsWith("refs/") ||
    value.includes("\0") ||
    value.includes("\\") ||
    value.includes("..") ||
    value.endsWith("/") ||
    value.includes("//") ||
    value.includes("@{") ||
    /[\u0000-\u001f\u007f ~^:?*[\]]/.test(value)
  ) {
    throw runtimeError(`Git packed-refs has an invalid ref name: ${value}.`);
  }
}

function captureReflogWitness(repository: GitRepositoryLineage, fullRef: string): ReflogWitness {
  const segments = ["logs", ...fullRef.split("/")];
  assertParentDirectories(repository.canonicalCommonDir, segments, "Git reflog");
  const path = join(repository.canonicalCommonDir, ...segments);
  const metadata = lstatSync(path, { throwIfNoEntry: false });
  if (metadata === undefined) return Object.freeze({ kind: "absent" });
  if (metadata.isSymbolicLink() || !metadata.isFile() || metadata.nlink !== 1) {
    throw runtimeError("Git reflog has a hostile filesystem state.");
  }
  const bytes = readFileSync(path);
  const identity = statSync(path, { bigint: true });
  return Object.freeze({
    kind: "present",
    sha256: sha256(bytes),
    bytes: bytes.length,
    device: String(identity.dev),
    inode: String(identity.ino)
  });
}

function assertReflogWitness(repository: GitRepositoryLineage, fullRef: string, witness: ReflogWitness): void {
  const current = captureReflogWitness(repository, fullRef);
  if (JSON.stringify(current) !== JSON.stringify(witness)) {
    throw runtimeError("Git reflog changed or is foreign during exact-ref retirement.");
  }
}

function pathForRef(repository: GitRepositoryLineage, fullRef: string): string {
  return join(repository.canonicalCommonDir, ...parseFullLocalBranchRef(fullRef).split("/"));
}

function packedRefsPath(repository: GitRepositoryLineage): string {
  return join(repository.canonicalCommonDir, "packed-refs");
}

function assertNoForeignLocks(repository: GitRepositoryLineage, fullRef: string): void {
  for (const path of [`${pathForRef(repository, fullRef)}.lock`, `${packedRefsPath(repository)}.lock`]) {
    if (lstatSync(path, { throwIfNoEntry: false }) !== undefined) {
      throw runtimeError("Git exact-ref retirement found a foreign Git lock.");
    }
  }
}

function assertNoSymbolicHeadTargets(repository: GitRepositoryLineage, fullRef: string): void {
  assertGitRepositoryLineage(repository);
  const commonHead = join(repository.canonicalCommonDir, "HEAD");
  assertHeadDoesNotTargetRef(commonHead, "Git common HEAD", repository.objectFormat, fullRef);

  const worktreesPath = join(repository.canonicalCommonDir, "worktrees");
  const worktrees = lstatSync(worktreesPath, { bigint: true, throwIfNoEntry: false });
  if (worktrees === undefined) {
    assertGitRepositoryLineage(repository);
    return;
  }
  assertAnchorableDirectory(worktrees, "Git linked-worktree directory");
  const expectedWorktrees = anchoredFileIdentity(worktrees);
  let names: string[];
  try {
    names = readdirSync(worktreesPath);
  } catch {
    throw runtimeError("Git linked-worktree directory cannot be enumerated.");
  }
  const afterEnumeration = lstatSync(worktreesPath, { bigint: true, throwIfNoEntry: false });
  if (
    afterEnumeration === undefined ||
    !isSameAnchorableDirectory(afterEnumeration, expectedWorktrees)
  ) {
    throw runtimeError("Git linked-worktree directory changed during enumeration.");
  }

  for (const name of names.sort()) {
    if (name.length === 0 || name === "." || name === ".." || name.includes("/") || name.includes("\\")) {
      throw runtimeError("Git linked-worktree directory has an invalid entry.");
    }
    const worktreePath = join(worktreesPath, name);
    const beforeHead = lstatSync(worktreePath, { bigint: true, throwIfNoEntry: false });
    if (beforeHead === undefined) {
      throw runtimeError("Git linked-worktree directory changed during enumeration.");
    }
    assertAnchorableDirectory(beforeHead, "Git linked-worktree entry");
    const expectedWorktree = anchoredFileIdentity(beforeHead);
    assertHeadDoesNotTargetRef(
      join(worktreePath, "HEAD"),
      "Git linked-worktree HEAD",
      repository.objectFormat,
      fullRef
    );
    const afterHead = lstatSync(worktreePath, { bigint: true, throwIfNoEntry: false });
    if (afterHead === undefined || !isSameAnchorableDirectory(afterHead, expectedWorktree)) {
      throw runtimeError("Git linked-worktree entry changed while reading HEAD.");
    }
  }
  assertGitRepositoryLineage(repository);
}

function assertHeadDoesNotTargetRef(
  path: string,
  label: string,
  objectFormat: GitRepositoryLineage["objectFormat"],
  targetRef: string
): void {
  const head = readAnchoredRegularFile(path, label, MAX_GIT_HEAD_BYTES);
  if (head === null) throw runtimeError(`${label} is missing.`);
  const text = decodeUtf8(head.bytes, label);
  if (text.startsWith("ref: ")) {
    if (!text.endsWith("\n") || text.indexOf("\n") !== text.length - 1) {
      throw runtimeError(`${label} is malformed.`);
    }
    let symbolicRef: string;
    try {
      symbolicRef = parseFullLocalBranchRef(text.slice("ref: ".length, -1));
    } catch {
      throw runtimeError(`${label} is malformed.`);
    }
    if (symbolicRef === targetRef) {
      throw runtimeError("Git exact-ref retirement cannot delete a checked-out symbolic HEAD ref.");
    }
    return;
  }
  try {
    parseDirectOid(head.bytes, objectFormat, label);
  } catch {
    throw runtimeError(`${label} is malformed.`);
  }
}

function assertAnchorableDirectory(
  metadata: {
    dev: bigint;
    ino: bigint;
    birthtimeNs: bigint;
    uid: bigint;
    mode: bigint;
    nlink: bigint;
    isDirectory(): boolean;
    isSymbolicLink(): boolean;
  },
  label: string
): void {
  if (
    metadata.isSymbolicLink() ||
    !metadata.isDirectory() ||
    metadata.nlink < 1n ||
    metadata.dev <= 0n ||
    metadata.ino <= 0n ||
    metadata.birthtimeNs <= 0n
  ) {
    throw runtimeError(`${label} has a hostile filesystem state.`);
  }
}

function isSameAnchorableDirectory(
  metadata: {
    dev: bigint;
    ino: bigint;
    birthtimeNs: bigint;
    uid: bigint;
    mode: bigint;
    nlink: bigint;
    isDirectory(): boolean;
    isSymbolicLink(): boolean;
  },
  expected: AnchoredFileIdentity
): boolean {
  try {
    assertAnchorableDirectory(metadata, "Git linked-worktree directory");
  } catch {
    return false;
  }
  return sameAnchoredFileIdentity(anchoredFileIdentity(metadata), expected);
}

function acquireOrAdoptExactRefLocks(
  repository: GitRepositoryLineage,
  fullRef: string,
  journal: ExactRefRetirementJournal
): ExactRefGitLocks {
  const locks = Object.freeze({
    looseLockPath: `${pathForRef(repository, fullRef)}.lock`,
    packedLockPath: `${packedRefsPath(repository)}.lock`,
    looseMarker: Buffer.from(`taskmux-exact-ref-retirement-lock/v1\n${journal.operationId}\n`, "utf8"),
    packedLockBytes: journal.packed.kind === "absent"
      ? Buffer.alloc(0)
      : decodeCanonicalBase64(journal.packed.afterBytesBase64, "Git packed-refs journal")
  });
  assertLockParentDirectory(locks.looseLockPath);
  assertLockParentDirectory(locks.packedLockPath);
  const packed = writeOrVerifyOwnedGitLock(locks.packedLockPath, locks.packedLockBytes);
  try {
    writeOrVerifyOwnedGitLock(locks.looseLockPath, locks.looseMarker);
  } catch (error) {
    if (packed === "created") removeOwnedGitLock(locks.packedLockPath, locks.packedLockBytes, true);
    throw error;
  }
  return locks;
}

function assertLockParentDirectory(path: string): void {
  const metadata = lstatSync(dirname(path), { throwIfNoEntry: false });
  if (metadata === undefined || metadata.isSymbolicLink() || !metadata.isDirectory()) {
    throw runtimeError("Git exact-ref retirement lock parent is hostile or missing.");
  }
}

function writeOrVerifyOwnedGitLock(path: string, bytes: Buffer): "created" | "adopted" {
  const existing = lstatSync(path, { throwIfNoEntry: false });
  if (existing !== undefined) {
    assertOwnedGitLock(path, bytes);
    return "adopted";
  }
  let descriptor: number;
  try {
    descriptor = openSync(path, "wx", 0o600);
  } catch {
    if (lstatSync(path, { throwIfNoEntry: false }) !== undefined) {
      assertOwnedGitLock(path, bytes);
      return "adopted";
    }
    throw runtimeError("Git exact-ref retirement could not acquire a Git lock.");
  }
  try {
    let offset = 0;
    while (offset < bytes.length) offset += writeSync(descriptor, bytes, offset);
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
  fsyncDirectory(dirname(path));
  assertOwnedGitLock(path, bytes);
  return "created";
}

function assertOwnedGitLock(path: string, expected: Buffer): void {
  const metadata = lstatSync(path, { throwIfNoEntry: false });
  if (
    metadata === undefined ||
    metadata.isSymbolicLink() ||
    !metadata.isFile() ||
    metadata.nlink !== 1 ||
    !readFileSync(path).equals(expected)
  ) {
    throw runtimeError("Git exact-ref retirement found a foreign Git lock.");
  }
}

function releaseExactRefLocks(locks: ExactRefGitLocks): void {
  removeOwnedGitLock(locks.packedLockPath, locks.packedLockBytes, true);
  removeOwnedGitLock(locks.looseLockPath, locks.looseMarker, false);
}

function removeOwnedGitLock(path: string, expected: Buffer, allowMissing: boolean): void {
  if (lstatSync(path, { throwIfNoEntry: false }) === undefined) {
    if (allowMissing) return;
    throw runtimeError("Git exact-ref retirement lock disappeared during cleanup.");
  }
  assertOwnedGitLock(path, expected);
  unlinkSync(path);
  fsyncDirectory(dirname(path));
}

function serializeJournal(value: ExactRefRetirementJournal): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function parseJournal(content: string): ExactRefRetirementJournal {
  let value: unknown;
  try {
    value = JSON.parse(content) as unknown;
  } catch {
    throw runtimeError("Invalid exact-ref retirement journal.");
  }
  const record = exactRecord(value, "exact-ref retirement journal");
  requireKeys(record, [
    "schemaVersion", "kind", "status", "operationId", "resource",
    "fullRef", "expectedOid", "loose", "packed", "reflog"
  ], "exact-ref retirement journal");
  if (record.schemaVersion !== 2 || record.kind !== "exact-ref-retirement" || record.status !== "prepared") {
    throw runtimeError("Invalid exact-ref retirement journal.");
  }
  const resource = parseJournalResource(record.resource);
  const effect = parseExactRefEffect({
    kind: "exact-ref-delete",
    objectFormat: resource.objectFormat,
    fullRef: record.fullRef,
    expectedOid: record.expectedOid
  });
  if (effect.kind !== "exact-ref-delete") throw runtimeError("Invalid exact-ref retirement journal.");
  return Object.freeze({
    schemaVersion: 2,
    kind: "exact-ref-retirement",
    status: "prepared",
    operationId: parseRepositoryLineageId(record.operationId),
    resource,
    fullRef: effect.fullRef,
    expectedOid: effect.expectedOid,
    loose: parseLooseWitness(record.loose, resource.objectFormat),
    packed: parsePackedWitness(record.packed, resource.objectFormat),
    reflog: parseReflogWitness(record.reflog)
  });
}

function parseJournalResource(value: unknown): GitExactRefResource {
  const record = exactRecord(value, "exact-ref retirement resource");
  requireKeys(record, [
    "schemaVersion", "kind", "repositoryLineageId", "canonicalCommonDir",
    "commonDirDevice", "commonDirInode", "commonDirBirthtimeNs", "objectFormat",
    "fullRef", "canonicalResourceIdentity", "resourceKey", "ledgerPath"
  ], "exact-ref retirement resource");
  if (
    record.schemaVersion !== 1 ||
    record.kind !== "git-exact-ref-resource" ||
    typeof record.canonicalCommonDir !== "string" ||
    typeof record.commonDirDevice !== "string" ||
    typeof record.commonDirInode !== "string" ||
    typeof record.commonDirBirthtimeNs !== "string" ||
    typeof record.canonicalResourceIdentity !== "string" ||
    typeof record.resourceKey !== "string" ||
    !/^[0-9a-f]{64}$/.test(record.resourceKey) ||
    typeof record.ledgerPath !== "string"
  ) {
    throw runtimeError("Invalid exact-ref retirement resource.");
  }
  return Object.freeze({
    schemaVersion: 1,
    kind: "git-exact-ref-resource",
    repositoryLineageId: parseRepositoryLineageId(record.repositoryLineageId),
    canonicalCommonDir: record.canonicalCommonDir,
    commonDirDevice: record.commonDirDevice,
    commonDirInode: record.commonDirInode,
    commonDirBirthtimeNs: record.commonDirBirthtimeNs,
    objectFormat: record.objectFormat === "sha1" || record.objectFormat === "sha256"
      ? record.objectFormat
      : (() => { throw runtimeError("Invalid exact-ref retirement resource."); })(),
    fullRef: parseFullLocalBranchRef(record.fullRef),
    canonicalResourceIdentity: record.canonicalResourceIdentity,
    resourceKey: record.resourceKey,
    ledgerPath: record.ledgerPath
  });
}

function parseLooseWitness(value: unknown, objectFormat: GitRepositoryLineage["objectFormat"]): LooseWitness {
  const record = exactRecord(value, "exact-ref retirement loose witness");
  if (record.kind === "absent" && Object.keys(record).length === 1) return Object.freeze({ kind: "absent" });
  requireKeys(record, ["kind", "oid", "sha256", "bytes", "identity"], "exact-ref retirement loose witness");
  if (
    record.kind !== "present" ||
    typeof record.sha256 !== "string" ||
    !/^[0-9a-f]{64}$/.test(record.sha256) ||
    typeof record.bytes !== "number" ||
    !Number.isSafeInteger(record.bytes) ||
    record.bytes < 0
  ) {
    throw runtimeError("Invalid exact-ref retirement loose witness.");
  }
  const effect = parseExactRefEffect({
    kind: "exact-ref-delete",
    objectFormat,
    fullRef: "refs/heads/witness",
    expectedOid: record.oid
  });
  if (effect.kind !== "exact-ref-delete") throw runtimeError("Invalid exact-ref retirement loose witness.");
  return Object.freeze({
    kind: "present",
    oid: effect.expectedOid,
    sha256: record.sha256,
    bytes: record.bytes,
    identity: parseAnchoredFileIdentity(record.identity, "exact-ref retirement loose witness")
  });
}

function parseAnchoredFileIdentity(value: unknown, label: string): AnchoredFileIdentity {
  const record = exactRecord(value, label);
  requireKeys(record, ["dev", "ino", "birthtimeNs", "uid", "mode", "nlink"], label);
  if (
    !isCanonicalUnsignedDecimal(record.dev) ||
    !isCanonicalUnsignedDecimal(record.ino) ||
    !isCanonicalUnsignedDecimal(record.birthtimeNs) ||
    !isCanonicalUnsignedDecimal(record.uid) ||
    !isCanonicalUnsignedDecimal(record.mode) ||
    !isCanonicalUnsignedDecimal(record.nlink) ||
    record.dev === "0" ||
    record.ino === "0" ||
    record.birthtimeNs === "0" ||
    record.mode === "0" ||
    record.nlink !== "1"
  ) {
    throw runtimeError(`Invalid ${label}.`);
  }
  return Object.freeze({
    dev: record.dev,
    ino: record.ino,
    birthtimeNs: record.birthtimeNs,
    uid: record.uid,
    mode: record.mode,
    nlink: record.nlink
  });
}

function parsePackedWitness(value: unknown, objectFormat: GitRepositoryLineage["objectFormat"]): PackedWitness {
  const record = exactRecord(value, "exact-ref retirement packed witness");
  if (record.kind === "absent" && Object.keys(record).length === 1) return Object.freeze({ kind: "absent" });
  requireKeys(record, [
    "kind", "beforeSha256", "afterSha256", "afterBytesBase64",
    "beforeBytes", "targetOid", "removeStartByte", "removeEndByte"
  ], "exact-ref retirement packed witness");
  if (
    record.kind !== "present" ||
    typeof record.beforeSha256 !== "string" ||
    typeof record.afterSha256 !== "string" ||
    !/^[0-9a-f]{64}$/.test(record.beforeSha256) ||
    !/^[0-9a-f]{64}$/.test(record.afterSha256) ||
    typeof record.afterBytesBase64 !== "string" ||
    typeof record.beforeBytes !== "number" ||
    !Number.isSafeInteger(record.beforeBytes) ||
    record.beforeBytes < 0 ||
    !(record.targetOid === null || typeof record.targetOid === "string") ||
    !(record.removeStartByte === null || Number.isSafeInteger(record.removeStartByte)) ||
    !(record.removeEndByte === null || Number.isSafeInteger(record.removeEndByte))
  ) {
    throw runtimeError("Invalid exact-ref retirement packed witness.");
  }
  const after = decodeCanonicalBase64(record.afterBytesBase64, "Git packed-refs journal");
  if (after.length > MAX_PACKED_REFS_BYTES || sha256(after) !== record.afterSha256) {
    throw runtimeError("Invalid exact-ref retirement packed witness.");
  }
  if (
    (record.targetOid === null) !== (record.removeStartByte === null) ||
    (record.targetOid === null) !== (record.removeEndByte === null)
  ) {
    throw runtimeError("Invalid exact-ref retirement packed witness.");
  }
  let targetOid: string | null = null;
  if (record.targetOid !== null) {
    const effect = parseExactRefEffect({
      kind: "exact-ref-delete",
      objectFormat,
      fullRef: "refs/heads/witness",
      expectedOid: record.targetOid
    });
    if (effect.kind !== "exact-ref-delete") throw runtimeError("Invalid exact-ref retirement packed witness.");
    targetOid = effect.expectedOid;
  }
  return Object.freeze({
    kind: "present",
    beforeSha256: record.beforeSha256,
    afterSha256: record.afterSha256,
    afterBytesBase64: record.afterBytesBase64,
    beforeBytes: record.beforeBytes,
    targetOid,
    removeStartByte: record.removeStartByte as number | null,
    removeEndByte: record.removeEndByte as number | null
  });
}

function parseReflogWitness(value: unknown): ReflogWitness {
  const record = exactRecord(value, "exact-ref retirement reflog witness");
  if (record.kind === "absent" && Object.keys(record).length === 1) return Object.freeze({ kind: "absent" });
  requireKeys(record, ["kind", "sha256", "bytes", "device", "inode"], "exact-ref retirement reflog witness");
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
    throw runtimeError("Invalid exact-ref retirement reflog witness.");
  }
  return Object.freeze({
    kind: "present",
    sha256: record.sha256,
    bytes: record.bytes,
    device: record.device,
    inode: record.inode
  });
}

function serializeReceipt(value: ExactRefRetirementReceipt): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function parseReceipt(content: string, expectedPath: string): ExactRefRetirementReceipt {
  let value: unknown;
  try {
    value = JSON.parse(content) as unknown;
  } catch {
    throw runtimeError("Invalid exact-ref retirement receipt.");
  }
  const record = exactRecord(value, "exact-ref retirement receipt");
  requireKeys(record, [
    "schemaVersion", "kind", "status", "operationId", "repositoryLineageId",
    "resourceKey", "canonicalResourceIdentity", "fullRef", "expectedOid", "reflog", "ledgerPath"
  ], "exact-ref retirement receipt");
  if (
    record.schemaVersion !== 1 ||
    record.kind !== "exact-ref-retirement-receipt" ||
    record.status !== "retired" ||
    typeof record.resourceKey !== "string" ||
    !/^[0-9a-f]{64}$/.test(record.resourceKey) ||
    typeof record.canonicalResourceIdentity !== "string" ||
    record.ledgerPath !== expectedPath ||
    typeof record.expectedOid !== "string"
  ) {
    throw runtimeError("Invalid exact-ref retirement receipt.");
  }
  return Object.freeze({
    schemaVersion: 1,
    kind: "exact-ref-retirement-receipt",
    status: "retired",
    operationId: parseRepositoryLineageId(record.operationId),
    repositoryLineageId: parseRepositoryLineageId(record.repositoryLineageId),
    resourceKey: record.resourceKey,
    canonicalResourceIdentity: record.canonicalResourceIdentity,
    fullRef: parseFullLocalBranchRef(record.fullRef),
    expectedOid: record.expectedOid,
    reflog: parseReflogWitness(record.reflog),
    ledgerPath: expectedPath
  });
}

function assertJournalMatches(
  journal: ExactRefRetirementJournal,
  resource: GitExactRefResource,
  request: ReturnType<typeof parseRequest>
): void {
  if (
    journal.operationId !== request.operationId ||
    journal.fullRef !== request.fullRef ||
    journal.expectedOid !== request.expectedOid ||
    JSON.stringify(journal.resource) !== JSON.stringify(resource)
  ) {
    throw runtimeError("Exact-ref retirement journal does not match the requested resource.");
  }
  assertGitRepositoryLineage(request.repository);
  if (
    resource.repositoryLineageId !== request.repository.repositoryLineageId ||
    resource.canonicalCommonDir !== request.repository.canonicalCommonDir ||
    resource.commonDirDevice !== request.repository.commonDirDevice ||
    resource.commonDirInode !== request.repository.commonDirInode ||
    resource.commonDirBirthtimeNs !== request.repository.commonDirBirthtimeNs ||
    resource.objectFormat !== request.repository.objectFormat
  ) {
    throw runtimeError("Exact-ref retirement resource has a foreign repository lineage.");
  }
}

function assertReceiptMatches(
  receipt: ExactRefRetirementReceipt,
  resource: GitExactRefResource,
  request: ReturnType<typeof parseRequest>
): void {
  const effect = parseExactRefEffect({
    kind: "exact-ref-delete",
    objectFormat: resource.objectFormat,
    fullRef: receipt.fullRef,
    expectedOid: receipt.expectedOid
  });
  if (
    effect.kind !== "exact-ref-delete" ||
    receipt.operationId !== request.operationId ||
    receipt.repositoryLineageId !== resource.repositoryLineageId ||
    receipt.resourceKey !== resource.resourceKey ||
    receipt.canonicalResourceIdentity !== resource.canonicalResourceIdentity ||
    receipt.fullRef !== request.fullRef ||
    receipt.expectedOid !== request.expectedOid
  ) {
    throw runtimeError("Exact-ref retirement receipt does not match the requested resource.");
  }
}

function journalExists(path: string): boolean {
  return lstatSync(path, { throwIfNoEntry: false }) !== undefined;
}

function readRegularText(path: string, label: string): string {
  const metadata = lstatSync(path, { throwIfNoEntry: false });
  if (metadata === undefined || metadata.isSymbolicLink() || !metadata.isFile() || metadata.nlink !== 1) {
    throw runtimeError(`${label} is invalid.`);
  }
  return readFileSync(path, "utf8");
}

function assertParentDirectories(root: string, segments: readonly string[], label: string): void {
  let current = root;
  for (let index = 0; index < segments.length - 1; index += 1) {
    current = join(current, segments[index]);
    const metadata = lstatSync(current, { throwIfNoEntry: false });
    if (metadata === undefined) return;
    if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
      throw runtimeError(`${label} has a hostile parent directory.`);
    }
  }
}

function fsyncDirectory(path: string): void {
  const descriptor = openSync(path, DIRECTORY_OPEN_FLAGS);
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

function parseDirectOid(bytes: Buffer, objectFormat: GitRepositoryLineage["objectFormat"], label: string): string {
  const length = objectFormat === "sha1" ? 40 : 64;
  if (bytes.length !== length + 1 || bytes[length] !== 0x0a || !isLowerHex(bytes.subarray(0, length))) {
    throw runtimeError(`${label} is not a canonical direct ref.`);
  }
  return bytes.subarray(0, length).toString("ascii");
}

function assertCanonicalUtf8(bytes: Buffer, label: string): void {
  const value = bytes.toString("utf8");
  if (!Buffer.from(value, "utf8").equals(bytes)) throw runtimeError(`${label} is not canonical UTF-8.`);
}

function decodeUtf8(bytes: Buffer, label: string): string {
  const value = bytes.toString("utf8");
  if (!Buffer.from(value, "utf8").equals(bytes)) throw runtimeError(`${label} is not canonical UTF-8.`);
  return value;
}

function isLowerHex(value: Buffer): boolean {
  if (value.length === 0) return false;
  for (const byte of value) {
    if (!((byte >= 0x30 && byte <= 0x39) || (byte >= 0x61 && byte <= 0x66))) return false;
  }
  return true;
}

function isCanonicalUnsignedDecimal(value: unknown): value is string {
  return typeof value === "string" && /^(?:0|[1-9][0-9]*)$/.test(value);
}

function sha256(value: Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function decodeCanonicalBase64(value: unknown, label: string): Buffer {
  if (typeof value !== "string" || !isBase64AlphabetAndPadding(value)) {
    throw runtimeError(`${label} is invalid.`);
  }
  const bytes = Buffer.from(value, "base64");
  if (bytes.toString("base64") !== value) throw runtimeError(`${label} is invalid.`);
  return bytes;
}

function isBase64AlphabetAndPadding(value: string): boolean {
  if (value.length === 0) return true;
  if (value.length % 4 !== 0) return false;
  const padding = value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0;
  const contentLength = value.length - padding;
  if (contentLength === 0 || (padding === 1 && contentLength % 4 !== 3) || (padding === 2 && contentLength % 4 !== 2)) {
    return false;
  }
  for (let index = 0; index < contentLength; index += 1) {
    const code = value.charCodeAt(index);
    if (
      !(
        (code >= 0x41 && code <= 0x5a) ||
        (code >= 0x61 && code <= 0x7a) ||
        (code >= 0x30 && code <= 0x39) ||
        code === 0x2b ||
        code === 0x2f
      )
    ) {
      return false;
    }
  }
  for (let index = contentLength; index < value.length; index += 1) {
    if (value.charCodeAt(index) !== 0x3d) return false;
  }
  return true;
}

function exactRecord(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw runtimeError(`Invalid ${label}.`);
  }
  return value as Record<string, unknown>;
}

function requireKeys(record: Record<string, unknown>, keys: readonly string[], label: string): void {
  if (Object.keys(record).length !== keys.length || keys.some((key) => !Object.hasOwn(record, key))) {
    throw runtimeError(`Invalid ${label}.`);
  }
}

function injectedCrash(message: string): InjectedExactRefRetirementCrash {
  return new InjectedExactRefRetirementCrash(message);
}
