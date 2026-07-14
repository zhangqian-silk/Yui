import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  realpathSync,
  type Stats
} from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { dataError } from "../errors/cliError.js";
import {
  acquireStableAncestorExclusiveBarrier,
  publishAnonymousFileNoReplace,
  releaseStableAncestorBarrier,
  type NativeExactIdentity
} from "./nativeStorageFs.js";

type ExternalFilePublicationBoundary = {
  storageRoot: string;
  label: string;
};

type PinnedDirectory = {
  descriptor: number;
  identity: Stats;
  canonicalPath: string;
};

type PlannedDirectory = {
  ancestor: PinnedDirectory;
  canonicalPath: string;
  missingSegments: string[];
  requestedPath: string;
};

const DIRECTORY_OPEN_FLAGS = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW;
const NO_ERROR = Symbol("no-error");

export function publishExternalTextFile(
  output: string,
  boundary: ExternalFilePublicationBoundary,
  produce: () => string
): void {
  assertLexicallyOutsideTaskmuxHome(output, boundary);
  const resolvedOutput = resolve(output);
  const targetName = basename(resolvedOutput);
  if (targetName.length === 0) {
    throw dataError(`${boundary.label} must name a regular file.`);
  }

  const storageRoot = pinStorageRoot(boundary);
  let plan: PlannedDirectory | null = null;
  let parent: PinnedDirectory | null = null;
  let primaryError: unknown | typeof NO_ERROR = NO_ERROR;
  try {
    plan = planRequestedDirectory(dirname(resolvedOutput), boundary.label);
    assertCanonicalBoundary(join(plan.canonicalPath, targetName), storageRoot.canonicalPath, boundary);
    const target = plan.missingSegments.length === 0
      ? lstatSync(pathThroughDirectory(plan.ancestor.descriptor, targetName), { throwIfNoEntry: false })
      : undefined;
    assertPublishableTarget(target, boundary.label);

    const content = produce();
    if (typeof content !== "string") {
      throw dataError(`${boundary.label} producer must return text.`);
    }

    assertPlannedDirectoryStillCurrent(plan, boundary.label);
    assertPinnedStorageRootStillCurrent(boundary.storageRoot, storageRoot, boundary.label);
    const materializingPlan = plan;
    plan = null;
    parent = materializePlannedDirectory(materializingPlan, boundary.label);
    assertCanonicalBoundary(join(parent.canonicalPath, targetName), storageRoot.canonicalPath, boundary);
    publishThroughPinnedParent(
      resolvedOutput,
      targetName,
      content,
      boundary,
      parent,
      storageRoot
    );
  } catch (error) {
    primaryError = error;
  }

  const cleanupError = runBestEffortCleanups([
    () => { if (plan !== null) closeSync(plan.ancestor.descriptor); },
    () => { if (parent !== null) closeSync(parent.descriptor); },
    () => closeSync(storageRoot.descriptor)
  ]);
  throwPreferredError(primaryError, cleanupError);
}

function publishThroughPinnedParent(
  resolvedOutput: string,
  targetName: string,
  content: string,
  boundary: ExternalFilePublicationBoundary,
  parent: PinnedDirectory,
  storageRoot: PinnedDirectory
): void {
  const target = pathThroughDirectory(parent.descriptor, targetName);
  if (lstatSync(target, { throwIfNoEntry: false }) !== undefined) {
    throw dataError(`${boundary.label} target changed during publication.`);
  }

  assertPinnedParentStillRequested(resolvedOutput, parent, boundary.label);
  assertPinnedStorageRootStillCurrent(boundary.storageRoot, storageRoot, boundary.label);
  assertCanonicalBoundary(join(parent.canonicalPath, targetName), storageRoot.canonicalPath, boundary);
  if (lstatSync(target, { throwIfNoEntry: false }) !== undefined) {
    throw dataError(`${boundary.label} target changed during publication.`);
  }

  const barrier = acquireStableAncestorExclusiveBarrier(
    parent.descriptor,
    descriptorIdentity(parent.descriptor)
  );
  let primaryError: unknown | typeof NO_ERROR = NO_ERROR;
  try {
    publishAnonymousFileNoReplace(
      barrier,
      ".",
      descriptorIdentity(parent.descriptor),
      targetName,
      Buffer.from(content, "utf8")
    );
  } catch (error) {
    if (hasErrorCode(error, "EEXIST")) {
      primaryError = dataError(`${boundary.label} target changed during publication.`);
    } else {
      primaryError = error;
    }
  }
  let releaseError: unknown | typeof NO_ERROR = NO_ERROR;
  try {
    releaseStableAncestorBarrier(barrier);
  } catch (error) {
    releaseError = error;
  }
  throwPreferredError(primaryError, releaseError);
}

function planRequestedDirectory(path: string, label: string): PlannedDirectory {
  const requestedPath = resolve(path);
  const missingSegments: string[] = [];
  let existingPath = requestedPath;
  while (lstatSync(existingPath, { throwIfNoEntry: false }) === undefined) {
    const parent = dirname(existingPath);
    if (parent === existingPath) {
      throw dataError(`${label} parent cannot be resolved.`);
    }
    missingSegments.unshift(basename(existingPath));
    existingPath = parent;
  }

  const ancestor = pinExistingDirectory(existingPath, label);
  return {
    ancestor,
    canonicalPath: resolve(ancestor.canonicalPath, ...missingSegments),
    missingSegments,
    requestedPath
  };
}

function materializePlannedDirectory(plan: PlannedDirectory, label: string): PinnedDirectory {
  let descriptor: number | null = plan.ancestor.descriptor;
  let result: PinnedDirectory | null = null;
  let primaryError: unknown | typeof NO_ERROR = NO_ERROR;
  try {
    for (const segment of plan.missingSegments) {
      if (descriptor === null) throw new Error("Directory descriptor ownership was lost.");
      const candidate = pathThroughDirectory(descriptor, segment);
      if (lstatSync(candidate, { throwIfNoEntry: false }) !== undefined) {
        throw dataError(`${label} parent changed during publication.`);
      }
      mkdirSync(candidate, { mode: 0o700 });
      fsyncSync(descriptor);
      const metadata = lstatSync(candidate);
      const nextDescriptor = openMatchingDirectory(candidate, metadata, label);
      const previousDescriptor = descriptor;
      descriptor = nextDescriptor;
      closeSync(previousDescriptor);
    }
    if (descriptor === null) throw new Error("Directory descriptor ownership was lost.");
    const identity = fstatSync(descriptor);
    const canonicalPath = realpathSync(`/proc/self/fd/${descriptor}`);
    result = { descriptor, identity, canonicalPath };
    descriptor = null;
  } catch (error) {
    primaryError = error;
  }

  const cleanupError = runBestEffortCleanups([
    () => {
      if (descriptor === null) return;
      const ownedDescriptor = descriptor;
      descriptor = null;
      closeSync(ownedDescriptor);
    }
  ]);
  throwPreferredError(primaryError, cleanupError);
  if (result === null) throw new Error("Directory materialization produced no result.");
  return result;
}

function openMatchingDirectory(candidate: string, metadata: Stats, label: string): number {
  const descriptor = openSync(candidate, DIRECTORY_OPEN_FLAGS);
  let primaryError: unknown | typeof NO_ERROR = NO_ERROR;
  try {
    const opened = fstatSync(descriptor);
    if (!metadata.isDirectory() || !sameIdentity(metadata, opened)) {
      throw dataError(`${label} parent changed during publication.`);
    }
  } catch (error) {
    primaryError = error;
  }

  if (primaryError === NO_ERROR) return descriptor;
  const cleanupError = runBestEffortCleanups([() => closeSync(descriptor)]);
  throwPreferredError(primaryError, cleanupError);
  throw new Error("Unreachable directory open state.");
}

function assertPlannedDirectoryStillCurrent(plan: PlannedDirectory, label: string): void {
  let current: PlannedDirectory | null = null;
  let primaryError: unknown | typeof NO_ERROR = NO_ERROR;
  try {
    current = planRequestedDirectory(plan.requestedPath, label);
    if (
      !sameIdentity(plan.ancestor.identity, current.ancestor.identity) ||
      plan.ancestor.canonicalPath !== current.ancestor.canonicalPath ||
      plan.canonicalPath !== current.canonicalPath ||
      !sameSegments(plan.missingSegments, current.missingSegments)
    ) {
      throw dataError(`${label} parent changed during publication.`);
    }
  } catch {
    primaryError = dataError(`${label} parent changed during publication.`);
  }
  const cleanupError = runBestEffortCleanups([
    () => { if (current !== null) closeSync(current.ancestor.descriptor); }
  ]);
  throwPreferredError(primaryError, cleanupError);
}

function pinStorageRoot(boundary: ExternalFilePublicationBoundary): PinnedDirectory {
  try {
    return pinExistingDirectory(boundary.storageRoot, `${boundary.label} TASKMUX_HOME`);
  } catch {
    throw dataError(`${boundary.label} cannot verify TASKMUX_HOME.`);
  }
}

function pinExistingDirectory(path: string, label: string): PinnedDirectory {
  let canonicalPath: string;
  try {
    canonicalPath = realpathSync(path);
  } catch {
    throw dataError(`${label} parent cannot be resolved.`);
  }
  const descriptor = openSync(canonicalPath, DIRECTORY_OPEN_FLAGS);
  let identity: Stats | null = null;
  let primaryError: unknown | typeof NO_ERROR = NO_ERROR;
  try {
    identity = fstatSync(descriptor);
    if (!identity.isDirectory()) {
      throw dataError(`${label} parent must be a directory.`);
    }
  } catch (error) {
    primaryError = error;
  }
  if (primaryError !== NO_ERROR) {
    const cleanupError = runBestEffortCleanups([() => closeSync(descriptor)]);
    throwPreferredError(primaryError, cleanupError);
  }
  if (identity === null) throw new Error("Directory identity was not captured.");
  return { descriptor, identity, canonicalPath };
}

function assertPinnedParentStillRequested(
  resolvedOutput: string,
  expected: PinnedDirectory,
  label: string
): void {
  let current: PinnedDirectory | null = null;
  let primaryError: unknown | typeof NO_ERROR = NO_ERROR;
  try {
    current = pinExistingDirectory(dirname(resolvedOutput), label);
    if (!sameIdentity(expected.identity, current.identity) || expected.canonicalPath !== current.canonicalPath) {
      throw dataError(`${label} parent changed during publication.`);
    }
  } catch {
    primaryError = dataError(`${label} parent changed during publication.`);
  }
  const cleanupError = runBestEffortCleanups([
    () => { if (current !== null) closeSync(current.descriptor); }
  ]);
  throwPreferredError(primaryError, cleanupError);
}

function assertPinnedStorageRootStillCurrent(
  requestedRoot: string,
  expected: PinnedDirectory,
  label: string
): void {
  let current: PinnedDirectory | null = null;
  let primaryError: unknown | typeof NO_ERROR = NO_ERROR;
  try {
    current = pinExistingDirectory(requestedRoot, label);
    if (!sameIdentity(expected.identity, current.identity) || expected.canonicalPath !== current.canonicalPath) {
      throw dataError(`${label} TASKMUX_HOME changed during publication.`);
    }
  } catch {
    primaryError = dataError(`${label} TASKMUX_HOME changed during publication.`);
  }
  const cleanupError = runBestEffortCleanups([
    () => { if (current !== null) closeSync(current.descriptor); }
  ]);
  throwPreferredError(primaryError, cleanupError);
}

function assertPublishableTarget(target: Stats | undefined, label: string): void {
  if (target?.isSymbolicLink() === true) {
    throw dataError(`${label} must not be a symbolic link.`);
  }
  if (target !== undefined && !target.isFile()) {
    throw dataError(`${label} must be a regular file.`);
  }
  if (target !== undefined) {
    throw dataError(`${label} target already exists; choose a new file path.`);
  }
}

function assertLexicallyOutsideTaskmuxHome(
  output: string,
  boundary: ExternalFilePublicationBoundary
): void {
  assertNoOverlap(resolve(output), resolve(boundary.storageRoot), boundary);
}

function assertCanonicalBoundary(
  canonicalOutput: string,
  canonicalRoot: string,
  boundary: ExternalFilePublicationBoundary
): void {
  assertNoOverlap(canonicalOutput, canonicalRoot, boundary);
}

function assertNoOverlap(
  output: string,
  root: string,
  boundary: ExternalFilePublicationBoundary
): void {
  if (pathContains(root, output) || pathContains(output, root)) {
    throw dataError(`${boundary.label} must be outside TASKMUX_HOME.`);
  }
}

function pathThroughDirectory(descriptor: number, name: string): string {
  return `/proc/self/fd/${descriptor}/${name}`;
}

function hasErrorCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}

function runBestEffortCleanups(cleanups: Array<() => void>): unknown | typeof NO_ERROR {
  let firstError: unknown | typeof NO_ERROR = NO_ERROR;
  for (const cleanup of cleanups) {
    try {
      cleanup();
    } catch (error) {
      if (firstError === NO_ERROR) firstError = error;
    }
  }
  return firstError;
}

function throwPreferredError(
  primaryError: unknown | typeof NO_ERROR,
  cleanupError: unknown | typeof NO_ERROR
): void {
  if (primaryError !== NO_ERROR) throw primaryError;
  if (cleanupError !== NO_ERROR) throw cleanupError;
}

function sameIdentity(left: Stats, right: Stats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function descriptorIdentity(descriptor: number): NativeExactIdentity {
  const identity = fstatSync(descriptor, { bigint: true });
  return Object.freeze({
    dev: identity.dev,
    ino: identity.ino,
    uid: identity.uid,
    mode: identity.mode,
    nlink: identity.nlink,
    birthtimeNs: identity.birthtimeNs
  });
}

function sameSegments(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}

function pathContains(parent: string, candidate: string): boolean {
  const childPath = relative(parent, candidate);
  return childPath === "" || (!isAbsolute(childPath) && childPath !== ".." && !childPath.startsWith(`..${sep}`));
}
