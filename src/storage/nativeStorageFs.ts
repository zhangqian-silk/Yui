import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  statSync
} from "node:fs";
import { createHash } from "node:crypto";
import { constants as osConstants } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Module } from "node:module";

export type NativeExactIdentity = Readonly<{
  dev: bigint;
  ino: bigint;
  uid: bigint;
  mode: bigint;
  nlink: bigint;
  birthtimeNs: bigint;
}>;

export type NativePublicationReceipt = NativeExactIdentity & Readonly<{
  size: bigint;
}>;

declare const nativeStableAncestorBarrierBrand: unique symbol;
export type NativeStableAncestorBarrier = Readonly<object> & {
  readonly [nativeStableAncestorBarrierBrand]: never;
};

declare const nativePinnedDirectoryBrand: unique symbol;
type NativePinnedDirectory = Readonly<object> & {
  readonly [nativePinnedDirectoryBrand]: never;
};

export type NativePinnedRootReader = Readonly<{
  lstat(relativePath: string): NativePublicationReceipt | undefined;
  readdir(relativePath?: string): readonly string[];
  readFileExact(
    relativePath: string,
    maxBytes: number
  ): Readonly<{ bytes: Buffer; identity: NativePublicationReceipt }>;
}>;

type NativeStorageFsBinding = {
  acquireStableAncestorSharedBarrier(
    descriptor: number,
    expectedIdentity: NativeExactIdentity
  ): NativeStableAncestorBarrier;
  acquireStableAncestorExclusiveBarrier(
    descriptor: number,
    expectedIdentity: NativeExactIdentity
  ): NativeStableAncestorBarrier;
  releaseStableAncestorBarrier(barrier: NativeStableAncestorBarrier): void;
  inspectDirectoryAt(
    barrier: NativeStableAncestorBarrier,
    relativePath: string
  ): NativeExactIdentity | undefined;
  mkdirExactNoReplace(
    barrier: NativeStableAncestorBarrier,
    parentRelativePath: string,
    expectedParent: NativeExactIdentity,
    name: string
  ): NativeExactIdentity;
  openPinnedRootAt(
    barrier: NativeStableAncestorBarrier,
    relativePath: string,
    expectedIdentity: NativeExactIdentity | undefined
  ): NativePinnedDirectory | undefined;
  getPinnedDirectoryIdentity(directory: NativePinnedDirectory): NativeExactIdentity;
  lstatPinnedDirectory(
    directory: NativePinnedDirectory,
    relativePath: string
  ): NativePublicationReceipt | undefined;
  readdirPinnedDirectory(
    directory: NativePinnedDirectory,
    relativePath: string
  ): string[];
  readPinnedFileExact(
    directory: NativePinnedDirectory,
    relativePath: string,
    maxBytes: number
  ): Readonly<{ bytes: Buffer; identity: NativePublicationReceipt }>;
  releasePinnedDirectory(directory: NativePinnedDirectory): void;
  publishAnonymousFileNoReplace(
    barrier: NativeStableAncestorBarrier,
    parentRelativePath: string,
    expectedParent: NativeExactIdentity,
    targetName: string,
    bytes: Buffer
  ): NativePublicationReceipt;
  linkPreparedFileNoReplace(
    barrier: NativeStableAncestorBarrier,
    sourceParentRelativePath: string,
    expectedSourceParent: NativeExactIdentity,
    sourceName: string,
    expectedSource: NativePublicationReceipt,
    targetParentRelativePath: string,
    expectedTargetParent: NativeExactIdentity,
    targetName: string
  ): NativePublicationReceipt;
  renameNoReplaceExact(
    barrier: NativeStableAncestorBarrier,
    sourceParentRelativePath: string,
    expectedSourceParent: NativeExactIdentity,
    sourceName: string,
    expectedSource: NativePublicationReceipt,
    targetParentRelativePath: string,
    expectedTargetParent: NativeExactIdentity,
    targetName: string
  ): NativePublicationReceipt;
};

type BindingFailure = {
  kind:
    | "native-stable-ancestor-barrier"
    | "native-anchored-read"
    | "external-publication";
  state: "not-acquired" | "not-opened" | "not-published";
};

const LINUX_O_CLOEXEC = 0o2000000;
const MAX_MANIFEST_BYTES = 4096n;
const MAX_NATIVE_BINARY_BYTES = 16n * 1024n * 1024n;
const REQUIRED_EXPORTS = Object.freeze([
  "acquireStableAncestorSharedBarrier",
  "acquireStableAncestorExclusiveBarrier",
  "releaseStableAncestorBarrier",
  "inspectDirectoryAt",
  "mkdirExactNoReplace",
  "openPinnedRootAt",
  "getPinnedDirectoryIdentity",
  "lstatPinnedDirectory",
  "readdirPinnedDirectory",
  "readPinnedFileExact",
  "releasePinnedDirectory",
  "publishAnonymousFileNoReplace",
  "linkPreparedFileNoReplace",
  "renameNoReplaceExact"
]);

let loadedBinding: NativeStorageFsBinding | undefined;

export function acquireStableAncestorSharedBarrier(
  descriptor: number,
  expectedIdentity: NativeExactIdentity
): NativeStableAncestorBarrier {
  return loadBinding({
    kind: "native-stable-ancestor-barrier",
    state: "not-acquired"
  }).acquireStableAncestorSharedBarrier(descriptor, expectedIdentity);
}

export function acquireStableAncestorExclusiveBarrier(
  descriptor: number,
  expectedIdentity: NativeExactIdentity
): NativeStableAncestorBarrier {
  return loadBinding({
    kind: "native-stable-ancestor-barrier",
    state: "not-acquired"
  }).acquireStableAncestorExclusiveBarrier(descriptor, expectedIdentity);
}

export function releaseStableAncestorBarrier(barrier: NativeStableAncestorBarrier): void {
  loadBinding({
    kind: "native-stable-ancestor-barrier",
    state: "not-acquired"
  }).releaseStableAncestorBarrier(barrier);
}

export function inspectDirectoryAt(
  barrier: NativeStableAncestorBarrier,
  relativePath: string
): NativeExactIdentity | undefined {
  return loadBinding({
    kind: "native-anchored-read",
    state: "not-opened"
  }).inspectDirectoryAt(barrier, relativePath);
}

export function mkdirExactNoReplace(
  barrier: NativeStableAncestorBarrier,
  parentRelativePath: string,
  expectedParent: NativeExactIdentity,
  name: string
): NativeExactIdentity {
  return loadBinding({
    kind: "external-publication",
    state: "not-published"
  }).mkdirExactNoReplace(barrier, parentRelativePath, expectedParent, name);
}

export function withPinnedRootAt<T>(
  barrier: NativeStableAncestorBarrier,
  relativePath: string,
  expectedIdentity: NativeExactIdentity | undefined,
  callback: (
    reader: NativePinnedRootReader | undefined,
    identity: NativeExactIdentity | undefined
  ) => T
): T {
  if (typeof callback !== "function") {
    throw new TypeError("Pinned root callback must be a function.");
  }
  const binding = loadBinding({
    kind: "native-anchored-read",
    state: "not-opened"
  });
  const directory = binding.openPinnedRootAt(barrier, relativePath, expectedIdentity);
  if (directory === undefined) {
    const result = callback(undefined, undefined);
    rejectThenable(result);
    return result;
  }

  let active = true;
  const reader = Object.freeze(Object.assign(Object.create(null), {
    lstat(relative: string): NativePublicationReceipt | undefined {
      assertPinnedReaderActive(active);
      return binding.lstatPinnedDirectory(directory, relative);
    },
    readdir(relative = "."): readonly string[] {
      assertPinnedReaderActive(active);
      return Object.freeze([...binding.readdirPinnedDirectory(directory, relative)]);
    },
    readFileExact(
      relative: string,
      maxBytes: number
    ): Readonly<{ bytes: Buffer; identity: NativePublicationReceipt }> {
      assertPinnedReaderActive(active);
      const result = binding.readPinnedFileExact(directory, relative, maxBytes);
      return Object.freeze({
        bytes: Buffer.from(result.bytes),
        identity: result.identity
      });
    }
  })) as NativePinnedRootReader;

  let result: T | undefined;
  let callbackFailed = false;
  let callbackError: unknown;
  try {
    result = callback(reader, binding.getPinnedDirectoryIdentity(directory));
    rejectThenable(result);
  } catch (error) {
    callbackFailed = true;
    callbackError = error;
  }
  active = false;

  try {
    binding.releasePinnedDirectory(directory);
  } catch (releaseError) {
    if (!callbackFailed) throw releaseError;
  }
  if (callbackFailed) throw callbackError;
  return result as T;
}

export function publishAnonymousFileNoReplace(
  barrier: NativeStableAncestorBarrier,
  parentRelativePath: string,
  expectedParent: NativeExactIdentity,
  targetName: string,
  bytes: Buffer
): NativePublicationReceipt {
  return loadBinding({
    kind: "external-publication",
    state: "not-published"
  }).publishAnonymousFileNoReplace(
    barrier,
    parentRelativePath,
    expectedParent,
    targetName,
    bytes
  );
}

export function linkPreparedFileNoReplace(
  barrier: NativeStableAncestorBarrier,
  sourceParentRelativePath: string,
  expectedSourceParent: NativeExactIdentity,
  sourceName: string,
  expectedSource: NativePublicationReceipt,
  targetParentRelativePath: string,
  expectedTargetParent: NativeExactIdentity,
  targetName: string
): NativePublicationReceipt {
  return loadBinding({
    kind: "external-publication",
    state: "not-published"
  }).linkPreparedFileNoReplace(
    barrier,
    sourceParentRelativePath,
    expectedSourceParent,
    sourceName,
    expectedSource,
    targetParentRelativePath,
    expectedTargetParent,
    targetName
  );
}

export function renameNoReplaceExact(
  barrier: NativeStableAncestorBarrier,
  sourceParentRelativePath: string,
  expectedSourceParent: NativeExactIdentity,
  sourceName: string,
  expectedSource: NativePublicationReceipt,
  targetParentRelativePath: string,
  expectedTargetParent: NativeExactIdentity,
  targetName: string
): NativePublicationReceipt {
  return loadBinding({
    kind: "external-publication",
    state: "not-published"
  }).renameNoReplaceExact(
    barrier,
    sourceParentRelativePath,
    expectedSourceParent,
    sourceName,
    expectedSource,
    targetParentRelativePath,
    expectedTargetParent,
    targetName
  );
}

function assertPinnedReaderActive(active: boolean): void {
  if (!active) throw new Error("Pinned root reader is no longer active.");
}

function rejectThenable(value: unknown): void {
  if (
    value !== null &&
    (typeof value === "object" || typeof value === "function") &&
    typeof (value as { then?: unknown }).then === "function"
  ) {
    throw new TypeError("Pinned root callback must complete synchronously.");
  }
}

function loadBinding(failure: BindingFailure): NativeStorageFsBinding {
  if (loadedBinding !== undefined) return loadedBinding;
  let binaryDescriptor = -1;
  let manifestDescriptor = -1;
  try {
    const binaryPath = resolvePrebuildPath();
    assertPinnedPrebuildPath(binaryPath);
    const manifestPath = join(
      fileURLToPath(new URL("../../prebuilds/", import.meta.url)),
      "manifest.json"
    );
    manifestDescriptor = openPinnedPackageFile(manifestPath, MAX_MANIFEST_BYTES);
    binaryDescriptor = openPinnedPackageFile(binaryPath, MAX_NATIVE_BINARY_BYTES);
    const manifest = readAndValidateManifest(
      manifestDescriptor,
      binaryDescriptor,
      process.arch
    );
    if (manifest.napiVersion !== 8 || Number(process.versions.napi ?? "0") < 8) {
      throw new Error("TaskMux native storage requires N-API 8 or newer.");
    }

    const nativeModule = new Module(binaryPath);
    nativeModule.filename = binaryPath;
    nativeModule.exports = Object.create(null);
    process.dlopen(
      nativeModule,
      `/proc/self/fd/${binaryDescriptor}`,
      osConstants.dlopen.RTLD_NOW | osConstants.dlopen.RTLD_LOCAL
    );
    const candidate = nativeModule.exports as Partial<NativeStorageFsBinding> &
      Record<string, unknown>;
    const actualExports = Reflect.ownKeys(candidate);
    if (actualExports.length !== REQUIRED_EXPORTS.length ||
        !REQUIRED_EXPORTS.every((name) => actualExports.includes(name))) {
      throw new Error("Native storage authority export set does not match its exact ABI.");
    }
    for (const name of REQUIRED_EXPORTS) {
      if (!Object.hasOwn(candidate, name) || typeof candidate[name] !== "function") {
        throw new Error(`Native storage authority is missing its exact ${name} export.`);
      }
    }
    loadedBinding = candidate as NativeStorageFsBinding;
    return loadedBinding;
  } catch (cause) {
    throw unavailableBindingError(
      "Exact native storage authority prebuild is unavailable.",
      failure,
      cause
    );
  } finally {
    if (binaryDescriptor >= 0) closeSync(binaryDescriptor);
    if (manifestDescriptor >= 0) closeSync(manifestDescriptor);
  }
}

function resolvePrebuildPath(): string {
  if (process.platform !== "linux") {
    throw new Error(`Unsupported native storage platform: ${process.platform}.`);
  }
  if (process.arch !== "x64" && process.arch !== "arm64") {
    throw new Error(`Unsupported native storage architecture: ${process.arch}.`);
  }
  const report = process.report?.getReport() as {
    header?: { glibcVersionRuntime?: unknown };
  } | undefined;
  const glibc = report?.header?.glibcVersionRuntime;
  if (typeof glibc !== "string" || glibc.length === 0) {
    throw new Error("TaskMux native storage currently requires Linux glibc.");
  }
  return fileURLToPath(new URL(
    `../../prebuilds/linux-${process.arch}-glibc/napi-v8/taskmux_storage_fs.node`,
    import.meta.url
  ));
}

function assertPinnedPrebuildPath(binaryPath: string): void {
  const packageRoot = fileURLToPath(new URL("../../", import.meta.url));
  const prebuildRoot = join(packageRoot, "prebuilds");
  const tupleRoot = dirname(dirname(binaryPath));
  const napiRoot = dirname(binaryPath);
  for (const path of [prebuildRoot, tupleRoot, napiRoot, binaryPath]) {
    const metadata = lstatSync(path);
    if (metadata.isSymbolicLink()) {
      throw new Error(`Native prebuild path must not contain a symbolic link: ${path}`);
    }
  }
  if (!statSync(prebuildRoot).isDirectory() || !statSync(tupleRoot).isDirectory() ||
      !statSync(napiRoot).isDirectory()) {
    throw new Error("Native prebuild parent must be an exact directory.");
  }
}

function openPinnedPackageFile(path: string, maxBytes: bigint): number {
  const descriptor = openSync(
    path,
    constants.O_RDONLY | constants.O_NOFOLLOW | LINUX_O_CLOEXEC
  );
  try {
    const pathMetadata = lstatSync(path, { bigint: true });
    const openedMetadata = fstatSync(descriptor, { bigint: true });
    const euid = BigInt(process.geteuid?.() ?? -1);
    const ownerAllowed = euid === 0n
      ? openedMetadata.uid === 0n
      : openedMetadata.uid === 0n || openedMetadata.uid === euid;
    if (!pathMetadata.isFile() || !openedMetadata.isFile() ||
        pathMetadata.dev !== openedMetadata.dev ||
        pathMetadata.ino !== openedMetadata.ino ||
        pathMetadata.uid !== openedMetadata.uid ||
        pathMetadata.nlink !== 1n || openedMetadata.nlink !== 1n ||
        !ownerAllowed ||
        (openedMetadata.mode & 0o6000n) !== 0n ||
        (openedMetadata.mode & 0o022n) !== 0n ||
        (openedMetadata.mode & 0o400n) === 0n ||
        openedMetadata.size <= 0n || openedMetadata.size > maxBytes) {
      throw new Error("Native package file must be one exact trusted read-only regular file.");
    }
    return descriptor;
  } catch (error) {
    closeSync(descriptor);
    throw error;
  }
}

type NativePrebuildArtifact = {
  platform: string;
  arch: string;
  libc: string;
  napiVersion: number;
  path: string;
  size: string;
  sha256: string;
};

type NativePrebuildManifest = {
  schemaVersion: number;
  sourceCommit: string;
  artifacts: NativePrebuildArtifact[];
};

function readAndValidateManifest(
  manifestDescriptor: number,
  binaryDescriptor: number,
  arch: string
): NativePrebuildArtifact {
  const text = readFileSync(manifestDescriptor, "utf8");
  const parsed = JSON.parse(text) as Partial<NativePrebuildManifest> & Record<string, unknown>;
  if (
    Object.keys(parsed).length !== 3 ||
    parsed.schemaVersion !== 1 ||
    typeof parsed.sourceCommit !== "string" ||
    !/^[0-9a-f]{40}$/.test(parsed.sourceCommit) ||
    !Array.isArray(parsed.artifacts) ||
    JSON.stringify(parsed) !== text
  ) {
    throw new Error("Native prebuild manifest is not one exact canonical record.");
  }
  const expectedPath = `linux-${arch}-glibc/napi-v8/taskmux_storage_fs.node`;
  const artifact = parsed.artifacts.find((candidate): candidate is NativePrebuildArtifact => (
    candidate !== null &&
    typeof candidate === "object" &&
    (candidate as Partial<NativePrebuildArtifact>).platform === "linux" &&
    (candidate as Partial<NativePrebuildArtifact>).arch === arch
  ));
  if (
    artifact === undefined ||
    Object.keys(artifact).length !== 7 ||
    artifact.platform !== "linux" ||
    artifact.arch !== arch ||
    artifact.libc !== "glibc" ||
    artifact.napiVersion !== 8 ||
    artifact.path !== expectedPath ||
    typeof artifact.size !== "string" ||
    !/^[1-9][0-9]*$/.test(artifact.size) ||
    typeof artifact.sha256 !== "string" ||
    !/^[0-9a-f]{64}$/.test(artifact.sha256)
  ) {
    throw new Error("Native prebuild manifest does not describe this exact platform artifact.");
  }
  const binaryMetadata = fstatSync(binaryDescriptor, { bigint: true });
  const bytes = readFileSync(binaryDescriptor);
  if (BigInt(artifact.size) !== binaryMetadata.size || BigInt(bytes.length) !== binaryMetadata.size ||
      createHash("sha256").update(bytes).digest("hex") !== artifact.sha256) {
    throw new Error("Native prebuild bytes do not match their assembly manifest.");
  }
  return artifact;
}

function unavailableBindingError(
  message: string,
  failure: BindingFailure,
  cause?: unknown
): Error {
  const error = new Error(message, cause === undefined ? undefined : { cause }) as Error & {
    kind: string;
    stage: string;
    state: string;
    errno: number;
    code: string;
  };
  Object.defineProperties(error, {
    kind: { configurable: false, enumerable: true, value: failure.kind, writable: false },
    stage: { configurable: false, enumerable: true, value: "load-binding", writable: false },
    state: { configurable: false, enumerable: true, value: failure.state, writable: false },
    errno: { configurable: false, enumerable: true, value: 0, writable: false },
    code: { configurable: false, enumerable: true, value: "ENOTSUP", writable: false }
  });
  return error;
}
