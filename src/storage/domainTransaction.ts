import {
  closeSync,
  constants,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  rmSync
} from "node:fs";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { types as utilTypes } from "node:util";
import {
  applyStagedDomainTransaction,
  DomainTransactionRecoveryError,
  stageDomainTransaction,
  type DomainTransactionOperation
} from "./recoveryJournal.js";
import {
  acquireStableAncestorExclusiveBarrier,
  acquireStableAncestorSharedBarrier,
  inspectDirectoryDescriptor,
  inspectDirectoryAt,
  releaseStableAncestorBarrier,
  withPinnedRootAt,
  type NativeExactIdentity,
  type NativePinnedRootReader,
  type NativeStableAncestorBarrier
} from "./nativeStorageFs.js";

const AUTHORITATIVE_PATHS = [
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
  "runtime/active-runs"
] as const;

const DIRECTORY_OPEN_FLAGS = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW;
const SHARED_BARRIER_RETRY_MS = 10;
const SHARED_BARRIER_TIMEOUT_MS = 5_000;
const sharedBarrierWaitWord = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT));
const objectGetOwnPropertyDescriptor = Object.getOwnPropertyDescriptor;
const objectGetPrototypeOf = Object.getPrototypeOf;
const isProxy = utilTypes.isProxy;

type NativeRootBarrier = {
  descriptor: number;
  barrier: NativeStableAncestorBarrier;
  rootRelativePath: string;
  rootIdentity: NativeExactIdentity | undefined;
  pathWitnesses: readonly PathWitness[];
};

type AcquiredNativeRootBarrier = {
  plan: {
    descriptor: number;
    ancestorPath: string;
    ancestorIdentity: NativeExactIdentity;
    rootRelativePath: string;
    pathWitnesses: readonly PathWitness[];
  };
  barrier: NativeStableAncestorBarrier;
};

type NodePathIdentity = Readonly<{
  dev: bigint;
  ino: bigint;
  uid: bigint;
  mode: bigint;
  nlink: bigint;
  birthtimeNs: bigint;
}>;

type PathWitness = Readonly<{
  path: string;
  identity: NodePathIdentity | undefined;
  root: boolean;
}>;

export function executeDomainTransaction<T>(
  rootDir: string,
  id: string,
  execute: (workingRoot: string) => T,
  extraOperations: (result: T) => DomainTransactionOperation[] = () => [],
  options: { includeBackups?: boolean; testFailAfterStage?: boolean } = {}
): T {
  return withNativeRootBarrier(rootDir, "exclusive", () => {
    const authoritativePaths = options.includeBackups
      ? [...AUTHORITATIVE_PATHS, "backups"]
      : [...AUTHORITATIVE_PATHS];
    const workingRoot = join(rootDir, "runtime", "domain-workspaces", id);
    rmSync(workingRoot, { recursive: true, force: true });
    mkdirSync(workingRoot, { recursive: true });
    copyAuthoritativeState(rootDir, workingRoot, authoritativePaths);

    try {
      const before = readAuthoritativeFiles(rootDir, authoritativePaths);
      const beforeDirectories = readAuthoritativeDirectories(rootDir, authoritativePaths);
      const result = execute(workingRoot);
      const after = readAuthoritativeFiles(workingRoot, authoritativePaths);
      const afterDirectories = readAuthoritativeDirectories(workingRoot, authoritativePaths);
      const operations = diffAuthoritativeFiles(
        rootDir,
        before,
        after,
        beforeDirectories,
        afterDirectories
      );
      operations.push(...extraOperations(result));
      if (operations.length > 0) {
        stageDomainTransaction(rootDir, id, operations);
        if (
          options.testFailAfterStage === true ||
          (
            process.env.NODE_ENV === "test" &&
            process.env.TASKMUX_TEST_ONLY_DOMAIN_TRANSACTION_FAILPOINT === "after-stage"
          )
        ) {
          const interruption = new Error(`Domain transaction ${id} stopped after staging.`);
          throw new DomainTransactionRecoveryError(id, interruption, interruption);
        }
        applyStagedDomainTransaction(rootDir, id);
      }
      return result;
    } finally {
      rmSync(workingRoot, { recursive: true, force: true });
    }
  });
}

/**
 * Runs a synchronous semantic read under the same native stable-ancestor lock
 * used by domain writers. The reader can only access the captured root through
 * the callback-bounded native pinned-root authority.
 */
export function executeDomainReadSnapshot<T>(
  rootDir: string,
  execute: (reader: NativePinnedRootReader | undefined) => T
): T {
  return withNativeRootBarrier(rootDir, "shared", ({
    barrier,
    rootRelativePath,
    rootIdentity,
    pathWitnesses
  }) => {
    let result!: T;
    withPinnedRootAt(barrier, rootRelativePath, rootIdentity, (reader) => {
      result = requireSynchronousDomainReadResult(execute(reader));
      // Never pass user-controlled values to withPinnedRootAt: its public
      // thenable check intentionally uses ordinary property access, whereas
      // TaskMux's semantic boundary must not invoke user getters or proxy traps.
      return undefined;
    });
    if (rootIdentity === undefined && inspectDirectoryAt(barrier, rootRelativePath) !== undefined) {
      throw new Error("TaskMux read snapshot root identity changed.");
    }
    assertReadPathWitnesses(rootDir, pathWitnesses);
    return result;
  });
}

function withNativeRootBarrier<T>(
  rootDir: string,
  mode: "shared" | "exclusive",
  execute: (root: NativeRootBarrier) => T
): T {
  const deadline = mode === "shared" ? Date.now() + SHARED_BARRIER_TIMEOUT_MS : 0;
  while (true) {
    let acquired: AcquiredNativeRootBarrier;
    try {
      acquired = acquireNativeRootBarrier(rootDir, mode);
    } catch (error) {
      if (
        mode !== "shared" ||
        !nativeBarrierWouldBlock(error) ||
        Date.now() >= deadline
      ) {
        throw error;
      }
      Atomics.wait(
        sharedBarrierWaitWord,
        0,
        0,
        Math.min(SHARED_BARRIER_RETRY_MS, Math.max(1, deadline - Date.now()))
      );
      continue;
    }
    return executeWithNativeRootBarrier(acquired, execute);
  }
}

function acquireNativeRootBarrier(
  rootDir: string,
  mode: "shared" | "exclusive"
): AcquiredNativeRootBarrier {
  const plan = planNativeRootBarrier(rootDir);
  let barrier: NativeStableAncestorBarrier | undefined;
  try {
    barrier = mode === "shared"
      ? acquireStableAncestorSharedBarrier(plan.descriptor, plan.ancestorIdentity)
      : acquireStableAncestorExclusiveBarrier(plan.descriptor, plan.ancestorIdentity);
    assertOpenedAncestorMatchesPreOpenWitness(
      plan.ancestorPath,
      plan.ancestorIdentity,
      plan.pathWitnesses[0]
    );
    return { plan, barrier };
  } catch (error) {
    if (barrier !== undefined) {
      try {
        releaseStableAncestorBarrier(barrier);
      } catch {
        // The acquisition failure is authoritative.
      }
    }
    try {
      closeSync(plan.descriptor);
    } catch {
      // The acquisition failure is authoritative.
    }
    throw error;
  }
}

function executeWithNativeRootBarrier<T>(
  { plan, barrier }: AcquiredNativeRootBarrier,
  execute: (root: NativeRootBarrier) => T
): T {
  let primaryError: unknown;
  let hasPrimaryError = false;
  try {
    return execute({
      descriptor: plan.descriptor,
      barrier,
      rootRelativePath: plan.rootRelativePath,
      rootIdentity: inspectDirectoryAt(barrier, plan.rootRelativePath),
      pathWitnesses: plan.pathWitnesses
    });
  } catch (error) {
    hasPrimaryError = true;
    primaryError = error;
    throw error;
  } finally {
    let releaseError: unknown;
    try {
      releaseStableAncestorBarrier(barrier);
    } catch (error) {
      releaseError = error;
    }
    try {
      closeSync(plan.descriptor);
    } catch (error) {
      if (releaseError === undefined) releaseError = error;
    }
    if (!hasPrimaryError && releaseError !== undefined) {
      throw releaseError;
    }
    void primaryError;
  }
}

function nativeBarrierWouldBlock(error: unknown): boolean {
  return typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error.code === "EWOULDBLOCK" || error.code === "EAGAIN");
}

function planNativeRootBarrier(rootDir: string): {
  descriptor: number;
  ancestorPath: string;
  ancestorIdentity: NativeExactIdentity;
  rootRelativePath: string;
  pathWitnesses: readonly PathWitness[];
} {
  const root = resolve(rootDir);
  const rootMetadata = lstatSync(root, { throwIfNoEntry: false });
  if (
    rootMetadata !== undefined &&
    (!rootMetadata.isDirectory() || rootMetadata.isSymbolicLink())
  ) {
    throw new Error("TaskMux storage root must be an exact directory.");
  }
  let ancestor = rootMetadata?.isDirectory() === true && !rootMetadata.isSymbolicLink()
    ? root
    : dirname(root);
  const segments = ancestor === root ? ["."] : [basename(root)];
  while (true) {
    const metadata = lstatSync(ancestor, { throwIfNoEntry: false });
    if (metadata !== undefined) {
      if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
        throw new Error("TaskMux storage ancestor must be an exact directory.");
      }
      break;
    }
    const parent = dirname(ancestor);
    if (parent === ancestor) {
      throw new Error("TaskMux storage ancestor cannot be resolved.");
    }
    segments.unshift(basename(ancestor));
    ancestor = parent;
  }
  const pathWitnesses = captureReadPathWitnesses(root, ancestor);
  const descriptor = openSync(ancestor, DIRECTORY_OPEN_FLAGS);
  try {
    return {
      descriptor,
      ancestorPath: ancestor,
      ancestorIdentity: inspectDirectoryDescriptor(descriptor),
      rootRelativePath: segments.join("/"),
      pathWitnesses
    };
  } catch (error) {
    closeSync(descriptor);
    throw error;
  }
}

function assertOpenedAncestorMatchesPreOpenWitness(
  ancestorPath: string,
  nativeIdentity: NativeExactIdentity,
  witness: PathWitness | undefined
): void {
  if (
    witness === undefined ||
    witness.path !== ancestorPath ||
    witness.identity === undefined ||
    witness.identity.dev !== nativeIdentity.dev ||
    witness.identity.ino !== nativeIdentity.ino ||
    witness.identity.uid !== nativeIdentity.uid ||
    witness.identity.mode !== nativeIdentity.mode ||
    witness.identity.nlink !== nativeIdentity.nlink
  ) {
    throw new Error("TaskMux storage path identity changed before Native pin.");
  }
}

function captureReadPathWitnesses(root: string, ancestor: string): readonly PathWitness[] {
  const relativeRoot = relative(ancestor, root);
  const segments = relativeRoot.length === 0 ? [] : relativeRoot.split(sep);
  const paths = [ancestor];
  let current = ancestor;
  for (const segment of segments) {
    current = join(current, segment);
    paths.push(current);
  }
  return Object.freeze(paths.map((path) =>
    Object.freeze({ path, identity: readNodePathIdentity(path), root: path === root })));
}

function assertReadPathWitnesses(rootDir: string, witnesses: readonly PathWitness[]): void {
  for (const witness of witnesses) {
    if (!sameNodePathIdentity(witness.identity, readNodePathIdentity(witness.path))) {
      if (witness.root && witness.identity === undefined) {
        throw new Error("TaskMux read snapshot root identity changed.");
      }
      throw new Error(`TaskMux read snapshot path identity changed: ${rootDir}`);
    }
  }
}

function readNodePathIdentity(path: string): NodePathIdentity | undefined {
  const metadata = lstatSync(path, { bigint: true, throwIfNoEntry: false });
  if (metadata === undefined) {
    return undefined;
  }
  return Object.freeze({
    dev: metadata.dev,
    ino: metadata.ino,
    uid: metadata.uid,
    mode: metadata.mode,
    nlink: metadata.nlink,
    birthtimeNs: metadata.birthtimeNs
  });
}

function sameNodePathIdentity(
  left: NodePathIdentity | undefined,
  right: NodePathIdentity | undefined
): boolean {
  return left === undefined || right === undefined
    ? left === right
    : left.dev === right.dev &&
      left.ino === right.ino &&
      left.uid === right.uid &&
      left.mode === right.mode &&
      left.nlink === right.nlink &&
      left.birthtimeNs === right.birthtimeNs;
}

function requireSynchronousDomainReadResult<T>(value: T): T {
  if ((typeof value !== "object" || value === null) && typeof value !== "function") {
    return value;
  }
  let candidate: object | null = value as object;
  while (candidate !== null) {
    if (isProxy(candidate)) throw new Error("TaskMux read snapshot callback must be synchronous.");
    const descriptor = objectGetOwnPropertyDescriptor(candidate, "then");
    if (descriptor !== undefined) {
      if (descriptor.get !== undefined || typeof descriptor.value === "function") {
        throw new Error("TaskMux read snapshot callback must be synchronous.");
      }
      return value;
    }
    candidate = objectGetPrototypeOf(candidate);
  }
  return value;
}

function readAuthoritativeDirectories(rootDir: string, authoritativePaths: string[]): Set<string> {
  const directories = new Set<string>();
  for (const path of authoritativePaths) {
    collectDirectories(rootDir, join(rootDir, path), directories);
  }
  return directories;
}

function collectDirectories(rootDir: string, target: string, directories: Set<string>): void {
  if (!existsSync(target) || !lstatSync(target).isDirectory()) {
    return;
  }
  directories.add(relative(rootDir, target));
  for (const entry of readdirSync(target, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      collectDirectories(rootDir, join(target, entry.name), directories);
    }
  }
}

function copyAuthoritativeState(sourceRoot: string, targetRoot: string, authoritativePaths: string[]): void {
  for (const path of authoritativePaths) {
    const source = join(sourceRoot, path);
    if (!existsSync(source)) {
      continue;
    }
    const target = join(targetRoot, path);
    mkdirSync(dirname(target), { recursive: true });
    cpSync(source, target, { recursive: true });
  }
}

function readAuthoritativeFiles(rootDir: string, authoritativePaths: string[]): Map<string, string> {
  const files = new Map<string, string>();
  for (const path of authoritativePaths) {
    collectFiles(rootDir, join(rootDir, path), files);
  }
  return files;
}

function collectFiles(rootDir: string, target: string, files: Map<string, string>): void {
  if (!existsSync(target)) {
    return;
  }
  if (lstatSync(target).isFile()) {
    files.set(relative(rootDir, target), readFileSync(target, "utf8"));
    return;
  }
  const entries = readdirSync(target, { withFileTypes: true });
  for (const entry of entries) {
    const path = join(target, entry.name);
    if (entry.isDirectory()) {
      collectFiles(rootDir, path, files);
    } else if (entry.isFile()) {
      files.set(relative(rootDir, path), readFileSync(path, "utf8"));
    }
  }
}

function diffAuthoritativeFiles(
  rootDir: string,
  before: Map<string, string>,
  after: Map<string, string>,
  beforeDirectories: Set<string>,
  afterDirectories: Set<string>
): DomainTransactionOperation[] {
  const operations: DomainTransactionOperation[] = [];
  const removedDirectories = [...beforeDirectories]
    .filter((path) => !afterDirectories.has(path))
    .sort((left, right) => left.length - right.length)
    .filter((path, index, paths) => !paths.slice(0, index).some((parent) => path.startsWith(`${parent}/`)));
  for (const path of removedDirectories) {
    operations.push({ type: "delete", target: join(rootDir, path) });
  }
  for (const path of [...before.keys()].sort()) {
    if (!after.has(path) && !removedDirectories.some((directory) => path.startsWith(`${directory}/`))) {
      operations.push({ type: "delete", target: join(rootDir, path) });
    }
  }
  for (const [path, content] of [...after.entries()].sort(([left], [right]) => left.localeCompare(right))) {
    if (before.get(path) !== content) {
      operations.push({ type: "write", target: join(rootDir, path), content });
    }
  }
  return operations;
}
