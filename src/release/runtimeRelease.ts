/**
 * Immutable local runtime releases and Controller handover provenance
 * (Issue 02).
 *
 * A release is a self-contained, content-addressed runtime package unpacked
 * below `runtime/releases/<version>-<package-sha256>/`. The Home's active
 * release pointer (`runtime/active-release.json`) names exactly one release;
 * the stable launcher shim resolves the CLI through that pointer instead of
 * symlinking a development checkout.
 *
 * The Controller writes its provenance to `runtime/runtime-identity.json` on
 * every start, and a versioned handover fence (`runtime/handover-fence.json`)
 * plus receipt (`runtime/handover.json`) make a Controller replacement
 * deterministic and recoverable.
 */

import { createHash, randomBytes, randomUUID } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { dirname, join, resolve } from "node:path";

import { readLinuxProcessStartIdentity } from "../controller/domainIdentity.js";
import { writeTextFileAtomically } from "../storage/durableFile.js";

export const RELEASES_DIRECTORY = "runtime/releases";
export const ACTIVE_RELEASE_POINTER_PATH = "runtime/active-release.json";
export const RUNTIME_IDENTITY_PATH = "runtime/runtime-identity.json";
export const HANDOVER_FENCE_PATH = "runtime/handover-fence.json";
export const HANDOVER_RECEIPT_PATH = "runtime/handover.json";
export const CANDIDATE_DISCOVERY_PATH = "runtime/controller-candidate.json";
export const RELEASE_MANIFEST_FILE = "release-manifest.json";
export const SMOKE_RECEIPT_FILE = "smoke-receipt.json";

export type RuntimeReleaseManifest = Readonly<{
  schemaVersion: 1;
  version: string;
  buildId: string;
  packageDigest: string;
  sourceCommit?: string;
  files: readonly Readonly<{ path: string; sha256: string; bytes: number }>[];
  assembledAt: string;
}>;

export type ActiveReleasePointer = Readonly<{
  schemaVersion: 1;
  /** Release directory name: `<version>-<package-sha256>`. */
  releaseId: string;
  version: string;
  buildId: string;
  packageDigest: string;
  activatedAt: string;
}>;

export type RuntimeIdentityReceipt = Readonly<{
  schemaVersion: 1;
  version: string;
  /** Executable that owns the Controller process (for example `node`). */
  executablePath: string;
  /** Exact launch arguments for that executable, including the Controller entrypoint. */
  args: string[];
  /** Manifest build ID, or `dev` for a non-release (checkout) runtime. */
  buildId: string;
  /** Package SHA-256, or null when the runtime is not an installed release. */
  packageDigest: string | null;
  sourceCommit: string | null;
  cliRealpath: string;
  controllerRealpath: string;
  controllerProtocolVersion: number;
  storageLayoutVersion: number;
  aggregateSchemaVersion: number;
  storageBackend: "file" | "sqlite";
  workerEnabled: boolean;
  pid: number;
  processStartIdentity: string;
  /** `primary` owns the Home; `candidate` is a handover successor. */
  mode: "primary" | "candidate";
  /** True while a candidate cannot promote because the old owner is live. */
  dualOwner: boolean;
  activeRelease: ActiveReleasePointer | null;
  writtenAt: string;
}>;

export type HandoverFencePhase =
  | "fenced"
  | "candidate-ready"
  | "committed"
  | "rolled-back";

export type HandoverOwner = Readonly<{
  pid: number;
  processStartIdentity: string;
  buildId: string;
  version: string;
}>;

export type HandoverFence = Readonly<{
  schemaVersion: 1;
  handoverId: string;
  phase: HandoverFencePhase;
  old: HandoverOwner;
  candidate: HandoverOwner | null;
  fromReleaseId: string | null;
  toReleaseId: string;
  createdAt: string;
  updatedAt: string;
}>;

export type HandoverReceipt = Readonly<{
  schemaVersion: 1;
  handoverId: string;
  outcome: "completed" | "rolled-back" | "dual-owner";
  /** The superseded owner, or null when no Controller was running. */
  old: HandoverOwner | null;
  candidate: HandoverOwner | null;
  previousReleaseId: string | null;
  activatedReleaseId: string;
  startedAt: string;
  completedAt: string;
}>;

export type SmokeReceipt = Readonly<{
  schemaVersion: 1;
  version: string;
  buildId: string;
  packageDigest: string;
  checks: readonly string[];
  ranAt: string;
}>;

/** `<version>-<package-sha256>` — the immutable release directory name. */
export function releaseDirectoryName(manifest: RuntimeReleaseManifest): string {
  return `${manifest.version}-${manifest.packageDigest}`;
}

export function releasesDirectory(home: string): string {
  return join(resolve(home), RELEASES_DIRECTORY);
}

export function releaseDirectoryFor(home: string, manifest: RuntimeReleaseManifest): string {
  return join(releasesDirectory(home), releaseDirectoryName(manifest));
}

/** Reads and validates a release manifest. Fails closed on any drift. */
export function readReleaseManifest(releaseDir: string): RuntimeReleaseManifest {
  const manifestPath = join(releaseDir, RELEASE_MANIFEST_FILE);
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(manifestPath, "utf8"));
  } catch (error) {
    throw new Error(`Runtime release manifest is unreadable: ${manifestPath}.`, { cause: error });
  }
  return validateManifest(parsed);
}

/**
 * Verifies an installed release against its manifest: every listed file must
 * exist with the exact SHA-256 and byte length, the tree must contain no
 * unlisted files, and the package digest must match. Any drift fails closed.
 */
export function verifyReleaseIntegrity(releaseDir: string): RuntimeReleaseManifest {
  const manifest = readReleaseManifest(releaseDir);
  const actual = listReleaseFiles(releaseDir)
    .map((name) => inventoryFile(releaseDir, name));
  const expected = [...manifest.files].sort(compareFiles);
  if (actual.length !== expected.length) {
    throw new Error(
      `Runtime release file count drifted from its manifest `
        + `(expected ${expected.length}, found ${actual.length}).`
    );
  }
  for (let index = 0; index < expected.length; index += 1) {
    const expectedFile = expected[index];
    const actualFile = actual[index];
    if (
      expectedFile.path !== actualFile.path
      || expectedFile.sha256 !== actualFile.sha256
      || expectedFile.bytes !== actualFile.bytes
    ) {
      throw new Error(`Runtime release content drifted from its manifest: ${expectedFile.path}.`);
    }
  }
  if (computePackageDigest(actual) !== manifest.packageDigest) {
    throw new Error("Runtime release package digest does not match its manifest.");
  }
  return manifest;
}

/**
 * A release directory must be immutable and self-contained: no Git worktree
 * metadata at its root and no symbolic links anywhere below it.
 */
export function assertReleaseIsNotWorktreeOrLinked(releaseDir: string): void {
  const root = resolve(releaseDir);
  for (const marker of [".git", ".gitfile"]) {
    if (existsSync(join(root, marker))) {
      throw new Error(
        `Runtime release directory must not be a Git worktree: ${root} `
          + `(found ${marker}).`
      );
    }
  }
  assertNoSymlinks(root, root);
}

export function readSmokeReceipt(releaseDir: string): SmokeReceipt | null {
  const receiptPath = join(releaseDir, SMOKE_RECEIPT_FILE);
  if (!existsSync(receiptPath)) return null;
  try {
    const parsed = JSON.parse(readFileSync(receiptPath, "utf8")) as SmokeReceipt;
    if (
      parsed === null
      || typeof parsed !== "object"
      || parsed.schemaVersion !== 1
      || typeof parsed.buildId !== "string"
      || typeof parsed.packageDigest !== "string"
    ) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

export function writeSmokeReceipt(releaseDir: string, receipt: SmokeReceipt): void {
  writeTextFileAtomically(
    join(releaseDir, SMOKE_RECEIPT_FILE),
    `${JSON.stringify(receipt, null, 2)}\n`
  );
}

export function readActiveReleasePointer(home: string): ActiveReleasePointer | null {
  const pointerPath = join(resolve(home), ACTIVE_RELEASE_POINTER_PATH);
  if (!existsSync(pointerPath)) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(pointerPath, "utf8"));
  } catch (error) {
    throw new Error(`Active release pointer is unreadable: ${pointerPath}.`, { cause: error });
  }
  return validatePointer(parsed);
}

export function writeActiveReleasePointer(
  home: string,
  pointer: ActiveReleasePointer
): void {
  validatePointer(pointer);
  writeTextFileAtomically(
    join(resolve(home), ACTIVE_RELEASE_POINTER_PATH),
    `${JSON.stringify(pointer, null, 2)}\n`
  );
}

/**
 * Resolves the Home's active release. Returns null when no pointer exists
 * (legacy/dev Home). Fails closed when the pointer names a release that is
 * missing or drifted.
 */
export function resolveActiveRelease(
  home: string
): { releaseDir: string; manifest: RuntimeReleaseManifest; pointer: ActiveReleasePointer } | null {
  const pointer = readActiveReleasePointer(home);
  if (pointer === null) return null;
  const releaseDir = join(releasesDirectory(home), pointer.releaseId);
  if (!existsSync(releaseDir)) {
    throw new Error(
      `Active release ${pointer.releaseId} is not installed; reinstall it or `
        + "point the active release pointer at an installed release."
    );
  }
  const manifest = verifyReleaseIntegrity(releaseDir);
  if (manifest.packageDigest !== pointer.packageDigest || manifest.buildId !== pointer.buildId) {
    throw new Error(
      `Active release ${pointer.releaseId} does not match its pointer; reinstall the release.`
    );
  }
  return { releaseDir, manifest, pointer };
}

/**
 * Detects the release a running script belongs to by walking up from the
 * script's directory until a release manifest sits next to a `dist/cli.js`.
 * Returns null for a development checkout.
 */
export function detectRunningRelease(
  scriptPath: string
): { releaseDir: string; manifest: RuntimeReleaseManifest } | null {
  let directory = dirname(resolve(scriptPath));
  for (;;) {
    const manifestPath = join(directory, RELEASE_MANIFEST_FILE);
    const cliEntry = join(directory, "dist", "cli.js");
    if (existsSync(manifestPath) && existsSync(cliEntry)) {
      return { releaseDir: directory, manifest: readReleaseManifest(directory) };
    }
    const parent = dirname(directory);
    if (parent === directory) return null;
    directory = parent;
  }
}

export function readRuntimeIdentity(home: string): RuntimeIdentityReceipt | null {
  const identityPath = join(resolve(home), RUNTIME_IDENTITY_PATH);
  if (!existsSync(identityPath)) return null;
  try {
    return validateRuntimeIdentity(JSON.parse(readFileSync(identityPath, "utf8")));
  } catch (error) {
    throw new Error(`Runtime identity receipt is unreadable: ${identityPath}.`, { cause: error });
  }
}

export function writeRuntimeIdentity(home: string, receipt: RuntimeIdentityReceipt): void {
  validateRuntimeIdentity(receipt);
  writeTextFileAtomically(
    join(resolve(home), RUNTIME_IDENTITY_PATH),
    `${JSON.stringify(receipt, null, 2)}\n`
  );
}

export function readHandoverFence(home: string): HandoverFence | null {
  const fencePath = join(resolve(home), HANDOVER_FENCE_PATH);
  if (!existsSync(fencePath)) return null;
  try {
    return validateHandoverFence(JSON.parse(readFileSync(fencePath, "utf8")));
  } catch (error) {
    throw new Error(`Handover fence is unreadable: ${fencePath}.`, { cause: error });
  }
}

export function writeHandoverFence(home: string, fence: HandoverFence): void {
  validateHandoverFence(fence);
  writeTextFileAtomically(
    join(resolve(home), HANDOVER_FENCE_PATH),
    `${JSON.stringify(fence, null, 2)}\n`
  );
}

export function removeHandoverFence(home: string): void {
  rmSync(join(resolve(home), HANDOVER_FENCE_PATH), { force: true });
}

export function readHandoverReceipt(home: string): HandoverReceipt | null {
  const receiptPath = join(resolve(home), HANDOVER_RECEIPT_PATH);
  if (!existsSync(receiptPath)) return null;
  try {
    const parsed = JSON.parse(readFileSync(receiptPath, "utf8")) as HandoverReceipt;
    if (
      parsed === null
      || typeof parsed !== "object"
      || parsed.schemaVersion !== 1
      || typeof parsed.handoverId !== "string"
    ) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

export function writeHandoverReceipt(home: string, receipt: HandoverReceipt): void {
  writeTextFileAtomically(
    join(resolve(home), HANDOVER_RECEIPT_PATH),
    `${JSON.stringify(receipt, null, 2)}\n`
  );
}

/** True when the exact process (PID + start identity) is still alive. */
export function isOwnerLive(owner: HandoverOwner): boolean {
  return readLinuxProcessStartIdentity(owner.pid) === owner.processStartIdentity;
}

export function readCandidateDiscovery(
  home: string
): { pid: number; processStartIdentity: string } | null {
  const candidatePath = join(resolve(home), CANDIDATE_DISCOVERY_PATH);
  if (!existsSync(candidatePath)) return null;
  try {
    const parsed = JSON.parse(readFileSync(candidatePath, "utf8")) as {
      pid?: unknown;
      processStartIdentity?: unknown;
    };
    if (
      typeof parsed.pid !== "number"
      || !Number.isSafeInteger(parsed.pid)
      || parsed.pid <= 0
      || typeof parsed.processStartIdentity !== "string"
      || !/^[0-9]{1,32}$/u.test(parsed.processStartIdentity)
    ) {
      return null;
    }
    return { pid: parsed.pid, processStartIdentity: parsed.processStartIdentity };
  } catch {
    return null;
  }
}

export function writeCandidateDiscovery(
  home: string,
  candidate: { pid: number; processStartIdentity: string }
): void {
  writeTextFileAtomically(
    join(resolve(home), CANDIDATE_DISCOVERY_PATH),
    `${JSON.stringify(candidate, null, 2)}\n`
  );
}

export function removeCandidateDiscovery(home: string): void {
  rmSync(join(resolve(home), CANDIDATE_DISCOVERY_PATH), { force: true });
}

/**
 * Short-lived lock protecting one `release activate` orchestration. The
 * Controller's own lifecycle lock is separate; this fence only serializes
 * activators so a crashed activate leaves a recoverable, owner-tagged file.
 */
export type HandoverLock = Readonly<{ release: () => void }>;

export function acquireHandoverLock(home: string): HandoverLock {
  const lockPath = join(resolve(home), "runtime", "handover.lock");
  mkdirSync(dirname(lockPath), { recursive: true, mode: 0o700 });
  const startIdentity = readLinuxProcessStartIdentity(process.pid);
  if (startIdentity === undefined) {
    throw new Error(
      `Cannot read Linux process start identity for activator PID ${process.pid}.`
    );
  }
  const owner = Object.freeze({
    pid: process.pid,
    processStartIdentity: startIdentity,
    token: randomBytes(16).toString("hex"),
    createdAt: new Date().toISOString()
  });
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      writeFileSync(lockPath, `${JSON.stringify(owner)}\n`, { flag: "wx", mode: 0o600 });
      let released = false;
      return {
        release: () => {
          if (released) return;
          released = true;
          try {
            const current = JSON.parse(readFileSync(lockPath, "utf8")) as { token?: unknown };
            if (current.token === owner.token) rmSync(lockPath, { force: true });
          } catch {
            // A damaged lock must not block a future activate; leave it for
            // the stale-lock diagnosis below.
          }
        }
      };
    } catch (error) {
      if (!isEexist(error)) throw error;
    }
    let existing: { pid?: unknown; createdAt?: unknown };
    try {
      existing = JSON.parse(readFileSync(lockPath, "utf8"));
    } catch (error) {
      if (isEnoent(error)) continue;
      throw error;
    }
    if (
      typeof existing.pid === "number"
      && Number.isSafeInteger(existing.pid)
      && existing.pid > 0
      && isHandoverLockLive(existing)
    ) {
      throw new Error(
        `Another Controller handover is already running (owner PID ${existing.pid}, `
          + `createdAt ${String(existing.createdAt)}): ${lockPath}`
      );
    }
    rmSync(lockPath, { force: true });
  }
  throw new Error(
    `Cannot safely acquire the Controller handover lock because its owner changed repeatedly: `
      + lockPath
  );
}

/**
 * A handover lock is live only when its owner process is still the same
 * generation that wrote it. A PID that exists but with a different start
 * identity was reused by an unrelated process, so the lock is stale.
 * Locks written before the start-identity field existed fall back to the
 * PID-exists check for backward compatibility.
 */
function isHandoverLockLive(existing: {
  pid?: unknown;
  processStartIdentity?: unknown;
}): boolean {
  if (
    typeof existing.pid !== "number"
    || !Number.isSafeInteger(existing.pid)
    || existing.pid <= 0
  ) {
    return false;
  }
  const currentIdentity = readLinuxProcessStartIdentity(existing.pid);
  if (currentIdentity === undefined) return false;
  if (typeof existing.processStartIdentity === "string") {
    return currentIdentity === existing.processStartIdentity;
  }
  return true;
}

export function newHandoverId(): string {
  return `handover-${randomUUID()}`;
}

// ---------------------------------------------------------------------------
// Internal helpers

function listReleaseFiles(directory: string, prefix = ""): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const relativeName = prefix.length === 0 ? entry.name : `${prefix}/${entry.name}`;
    if (entry.isDirectory()) {
      files.push(...listReleaseFiles(join(directory, entry.name), relativeName));
      continue;
    }
    if (!entry.isFile() || entry.isSymbolicLink()) {
      throw new Error(`Runtime release tree contains an unsupported entry: ${relativeName}.`);
    }
    if (relativeName === RELEASE_MANIFEST_FILE || relativeName === SMOKE_RECEIPT_FILE) continue;
    files.push(relativeName);
  }
  return files.sort();
}

function inventoryFile(
  releaseDir: string,
  relativePath: string
): { path: string; sha256: string; bytes: number } {
  const absolute = join(releaseDir, relativePath);
  const metadata = lstatSync(absolute);
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw new Error(`Runtime release entry must be one regular file: ${relativePath}.`);
  }
  return {
    path: relativePath,
    sha256: createHash("sha256").update(readFileSync(absolute)).digest("hex"),
    bytes: metadata.size
  };
}

export function computePackageDigest(
  files: readonly Readonly<{ path: string; sha256: string; bytes: number }>[]
): string {
  const hash = createHash("sha256");
  for (const file of [...files].sort(compareFiles)) {
    hash.update(`${file.path}\0${file.sha256}\0${file.bytes}\n`);
  }
  return hash.digest("hex");
}

function assertNoSymlinks(directory: string, root: string): void {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const child = join(directory, entry.name);
    if (entry.isSymbolicLink()) {
      const target = (() => {
        try {
          return readlinkSync(child);
        } catch {
          return "?";
        }
      })();
      throw new Error(
        `Runtime release directory must not contain symbolic links: ${child} -> ${target}.`
      );
    }
    if (entry.isDirectory()) assertNoSymlinks(child, root);
  }
}

function compareFiles(
  left: Readonly<{ path: string }>,
  right: Readonly<{ path: string }>
): number {
  return left.path < right.path ? -1 : left.path > right.path ? 1 : 0;
}

function validateManifest(value: unknown): RuntimeReleaseManifest {
  if (
    value === null
    || typeof value !== "object"
    || (value as { schemaVersion?: unknown }).schemaVersion !== 1
    || typeof (value as { version?: unknown }).version !== "string"
    || ((value as { version?: unknown }).version as string).length === 0
    || typeof (value as { buildId?: unknown }).buildId !== "string"
    || ((value as { buildId?: unknown }).buildId as string).length === 0
    || typeof (value as { packageDigest?: unknown }).packageDigest !== "string"
    || !/^[a-f0-9]{64}$/u.test((value as { packageDigest?: unknown }).packageDigest as string)
    || !Array.isArray((value as { files?: unknown }).files)
  ) {
    throw new Error("Runtime release manifest is invalid.");
  }
  const manifest = value as RuntimeReleaseManifest;
  for (const file of manifest.files) {
    if (
      file === null
      || typeof file !== "object"
      || typeof file.path !== "string"
      || file.path.length === 0
      || typeof file.sha256 !== "string"
      || !/^[a-f0-9]{64}$/u.test(file.sha256)
      || !Number.isSafeInteger(file.bytes)
      || file.bytes < 0
    ) {
      throw new Error(`Runtime release manifest file entry is invalid: ${JSON.stringify(file)}.`);
    }
  }
  return Object.freeze({
    schemaVersion: 1,
    version: manifest.version,
    buildId: manifest.buildId,
    packageDigest: manifest.packageDigest,
    ...(manifest.sourceCommit === undefined ? {} : { sourceCommit: manifest.sourceCommit }),
    files: Object.freeze(manifest.files.map((file) => Object.freeze({ ...file }))),
    assembledAt: manifest.assembledAt
  });
}

function validatePointer(value: unknown): ActiveReleasePointer {
  if (
    value === null
    || typeof value !== "object"
    || (value as { schemaVersion?: unknown }).schemaVersion !== 1
    || typeof (value as { releaseId?: unknown }).releaseId !== "string"
    || ((value as { releaseId?: unknown }).releaseId as string).length === 0
    || typeof (value as { version?: unknown }).version !== "string"
    || typeof (value as { buildId?: unknown }).buildId !== "string"
    || typeof (value as { packageDigest?: unknown }).packageDigest !== "string"
    || !/^[a-f0-9]{64}$/u.test((value as { packageDigest?: unknown }).packageDigest as string)
    || typeof (value as { activatedAt?: unknown }).activatedAt !== "string"
  ) {
    throw new Error("Active release pointer is invalid.");
  }
  const pointer = value as ActiveReleasePointer;
  return Object.freeze({ ...pointer, schemaVersion: 1 });
}

function validateRuntimeIdentity(value: unknown): RuntimeIdentityReceipt {
  if (
    value === null
    || typeof value !== "object"
    || (value as { schemaVersion?: unknown }).schemaVersion !== 1
    || typeof (value as { version?: unknown }).version !== "string"
    || typeof (value as { executablePath?: unknown }).executablePath !== "string"
    || (value as { executablePath?: unknown }).executablePath === ""
    || !isStringArray((value as { args?: unknown }).args)
    || typeof (value as { buildId?: unknown }).buildId !== "string"
    || typeof (value as { cliRealpath?: unknown }).cliRealpath !== "string"
    || typeof (value as { controllerRealpath?: unknown }).controllerRealpath !== "string"
    || typeof (value as { pid?: unknown }).pid !== "number"
    || typeof (value as { processStartIdentity?: unknown }).processStartIdentity !== "string"
    || ((value as { mode?: unknown }).mode !== "primary"
      && (value as { mode?: unknown }).mode !== "candidate")
    || typeof (value as { dualOwner?: unknown }).dualOwner !== "boolean"
  ) {
    throw new Error("Runtime identity receipt is invalid.");
  }
  return value as RuntimeIdentityReceipt;
}

function validateHandoverFence(value: unknown): HandoverFence {
  if (
    value === null
    || typeof value !== "object"
    || (value as { schemaVersion?: unknown }).schemaVersion !== 1
    || typeof (value as { handoverId?: unknown }).handoverId !== "string"
    || !isHandoverPhase((value as { phase?: unknown }).phase)
  ) {
    throw new Error("Handover fence is invalid.");
  }
  return value as HandoverFence;
}

function isHandoverPhase(value: unknown): value is HandoverFencePhase {
  return value === "fenced"
    || value === "candidate-ready"
    || value === "committed"
    || value === "rolled-back";
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

function isEexist(error: unknown): boolean {
  return isNodeError(error) && error.code === "EEXIST";
}

function isEnoent(error: unknown): boolean {
  return isNodeError(error) && error.code === "ENOENT";
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
