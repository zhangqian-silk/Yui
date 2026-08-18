import { createHash, randomBytes } from "node:crypto";
import {
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmdirSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";

import {
  validateManagedWorkspace,
  type ManagedWorkspace,
  type ManagedWorkspaceOwner
} from "../worktree/managedWorkspace.js";
import { ResourceRegistrar } from "../resources/resourceRegistrar.js";

export const YUI_TASK_RUNTIME_ISOLATION_DESCRIPTOR =
  "YUI_TASK_RUNTIME_ISOLATION_DESCRIPTOR";
export const YUI_TASK_RUNTIME_SERVICE_NAMESPACE =
  "YUI_TASK_RUNTIME_SERVICE_NAMESPACE";

export type TaskRuntimeWorkspaceOwner = ManagedWorkspaceOwner;

export type TaskRuntimePortAllocation = Readonly<{
  name: string;
  port: number;
}>;

/** Project Policy supplies declarations; Core only validates and carries them. */
export type TaskRuntimeLaunchPolicy = Readonly<{
  declaredExternalCapabilities?: readonly string[];
  requestedExternalCapabilities?: readonly string[];
  portPreference?: readonly number[];
  portAllocations?: readonly TaskRuntimePortAllocation[];
}>;

export type TaskRuntimeIsolationDescriptor = Readonly<{
  schemaVersion: 1;
  kind: "yui-task-runtime-isolation";
  taskId: string;
  workspace: Readonly<{
    owner: TaskRuntimeWorkspaceOwner;
    root: string;
  }>;
  roots: Readonly<{
    generation: string;
    data: string;
    cache: string;
    temporary: string;
  }>;
  serviceNamespace: string;
  portPreference: readonly number[];
  portAllocations: readonly TaskRuntimePortAllocation[];
  externalCapabilities: Readonly<{
    declared: readonly string[];
    requested: readonly string[];
  }>;
  generation: Readonly<{
    runId?: string;
    launchId: string;
    generationId: string;
  }>;
}>;

export type TaskRuntimeControlBoundary = Readonly<{
  yuiHome: string;
  controllerSocketPath: string;
  tmuxNamespace: string;
  globalInstallPaths?: readonly string[];
}>;

export type TaskRuntimeResourceObservation = Readonly<{
  id: string;
  kind: "directory" | "service" | "port" | "external";
  ownership: "owned" | "unmarked" | "mismatched" | "ambiguous" | "external";
  state: "inactive" | "active" | "unknown";
  descriptorFingerprint?: string;
}>;

export type TaskRuntimeCleanupReason =
  | "failure"
  | "timeout"
  | "interruption"
  | "completion"
  | "reopen";

export type TaskRuntimeIsolationPreparation = Readonly<{
  descriptor: TaskRuntimeIsolationDescriptor;
  fingerprint: string;
  environment: Readonly<Record<string, string>>;
}>;

export type TaskRuntimeIsolationPreflightInput = Readonly<{
  workspace: ManagedWorkspace;
  runId?: string;
  launchId: string;
  generationId: string;
  policy?: TaskRuntimeLaunchPolicy;
  allowExactActive?: boolean;
}>;

export interface TaskRuntimeIsolationPort {
  preflight(input: TaskRuntimeIsolationPreflightInput): TaskRuntimeIsolationPreparation;
  activate(preparation: TaskRuntimeIsolationPreparation): void;
  cleanup(
    preparation: TaskRuntimeIsolationPreparation,
    reason: TaskRuntimeCleanupReason
  ): void;
}

export interface TaskRuntimeLifecycleCleanupPort {
  cleanupTaskLaunch(input: Readonly<{
    taskId: string;
    launchId: string;
    reason: TaskRuntimeCleanupReason;
  }>): "absent" | "cleaned";
}

export type TaskRuntimePathLayout = "hierarchical" | "compact";

export type FileTaskRuntimeIsolationOptions = Readonly<{
  runtimeRoot: string;
  controlPlane: TaskRuntimeControlBoundary;
  pathLayout?: TaskRuntimePathLayout;
  inspectResources?: (
    descriptor: TaskRuntimeIsolationDescriptor
  ) => readonly TaskRuntimeResourceObservation[];
}>;

type TaskRuntimeResourceMarker = Readonly<{
  schemaVersion: 1;
  kind: "yui-task-runtime-resource-owner";
  fingerprint: string;
  descriptor: TaskRuntimeIsolationDescriptor;
}>;

const MARKER_FILE = ".yui-task-runtime-owner.json";

/**
 * One project-neutral implementation owns descriptor construction, preflight,
 * exact generation activation, and exact generation cleanup. It never scans by
 * process name, Role, PID, age, or an ambient Home.
 */
export class FileTaskRuntimeIsolation implements
  TaskRuntimeIsolationPort,
  TaskRuntimeLifecycleCleanupPort {
  readonly #runtimeRoot: string;
  readonly #controlPlane: TaskRuntimeControlBoundary;
  readonly #pathLayout: TaskRuntimePathLayout;
  readonly #inspectResources:
    | ((descriptor: TaskRuntimeIsolationDescriptor) => readonly TaskRuntimeResourceObservation[])
    | undefined;
  #resourceRegistrarValue: ResourceRegistrar | undefined;

  constructor(options: FileTaskRuntimeIsolationOptions) {
    this.#runtimeRoot = canonicalPath(options.runtimeRoot, "Task runtime root");
    this.#controlPlane = normalizeControlBoundary(options.controlPlane);
    this.#pathLayout = taskRuntimePathLayout(options.pathLayout);
    this.#inspectResources = options.inspectResources;
  }

  #resourceRegistrar(): ResourceRegistrar {
    return this.#resourceRegistrarValue ??= new ResourceRegistrar(this.#controlPlane.yuiHome);
  }

  preflight(input: TaskRuntimeIsolationPreflightInput): TaskRuntimeIsolationPreparation {
    const descriptor = createTaskRuntimeIsolationDescriptor({
      ...input,
      runtimeRoot: this.#runtimeRoot,
      pathLayout: this.#pathLayout
    });
    const fingerprint = taskRuntimeIsolationFingerprint(descriptor);
    assertTaskRuntimeIsolationPreflight({
      descriptor,
      workspace: input.workspace,
      runtimeRoot: this.#runtimeRoot,
      pathLayout: this.#pathLayout,
      controlPlane: this.#controlPlane,
      resources: [
        ...inspectGenerationRoot(descriptor, fingerprint),
        ...(this.#inspectResources?.(descriptor) ?? [])
      ],
      allowExactActive: input.allowExactActive === true
    });
    return Object.freeze({
      descriptor,
      fingerprint,
      environment: taskRuntimeIsolationEnvironment(descriptor)
    });
  }

  activate(preparation: TaskRuntimeIsolationPreparation): void {
    const { descriptor, fingerprint } = validatePreparation(preparation);
    const root = descriptor.roots.generation;
    const existing = inspectGenerationRoot(descriptor, fingerprint);
    if (existing.length > 0) {
      const [resource] = existing;
      if (
        resource?.ownership !== "owned"
        || resource.descriptorFingerprint !== fingerprint
      ) {
        throw new Error(`Task runtime generation is not exactly owned: ${root}.`);
      }
      ensureOwnedDirectories(descriptor);
      this.#resourceRegistrar().registerTaskRuntimeIsolation(descriptor);
      return;
    }
    ensureDirectoryChain(this.#runtimeRoot, dirname(root));
    mkdirSync(root, { mode: 0o700 });
    try {
      const marker: TaskRuntimeResourceMarker = {
        schemaVersion: 1,
        kind: "yui-task-runtime-resource-owner",
        fingerprint,
        descriptor
      };
      writeFileSync(join(root, MARKER_FILE), `${JSON.stringify(marker)}\n`, {
        flag: "wx",
        mode: 0o600
      });
      ensureOwnedDirectories(descriptor);
      this.#resourceRegistrar().registerTaskRuntimeIsolation(descriptor);
    } catch (error) {
      const current = inspectGenerationRoot(descriptor, fingerprint);
      if (current[0]?.ownership === "owned") throw error;
      // The directory was created by this exact activation but never acquired
      // its marker. Remove it only while it remains empty; concurrent unmarked
      // content is ambiguous and must be preserved.
      rmdirSync(root);
      throw error;
    }
  }

  cleanup(
    preparation: TaskRuntimeIsolationPreparation,
    reason: TaskRuntimeCleanupReason
  ): void {
    requireCleanupReason(reason);
    const { descriptor, fingerprint } = validatePreparation(preparation);
    const resources = [
      ...inspectGenerationRoot(descriptor, fingerprint),
      ...(this.#inspectResources?.(descriptor) ?? [])
    ];
    if (resources.length === 0) return;
    planTaskRuntimeCleanup(descriptor, reason, resources);
    // Re-read the sole durable marker immediately before deletion. A missing,
    // replaced, symlinked, or mismatched generation is never cleanup authority.
    const current = inspectGenerationRoot(descriptor, fingerprint);
    if (
      current.length !== 1
      || current[0]?.ownership !== "owned"
      || current[0].descriptorFingerprint !== fingerprint
    ) {
      throw new Error("Task runtime resources changed since cleanup preflight.");
    }
    const root = descriptor.roots.generation;
    const claimed = `${root}.cleanup-${randomBytes(16).toString("hex")}`;
    renameSync(root, claimed);
    try {
      const marker = parseMarker(readFileSync(join(claimed, MARKER_FILE), "utf8"));
      if (
        marker.fingerprint !== fingerprint
        || JSON.stringify(marker.descriptor) !== JSON.stringify(descriptor)
      ) {
        throw new Error("Task runtime resources changed during cleanup claim.");
      }
      rmSync(claimed, { recursive: true });
      this.#resourceRegistrar().markPathsDeleted([
        descriptor.roots.generation,
        descriptor.roots.data,
        descriptor.roots.cache,
        descriptor.roots.temporary
      ]);
    } catch (error) {
      // Preserve a claimed-but-unverified resource. Restore its exact path only
      // when no concurrent generation has appeared there; never delete it.
      try {
        renameSync(claimed, root);
      } catch (restoreError) {
        throw new Error(
          "Task runtime cleanup claim could not be verified or restored.",
          { cause: restoreError }
        );
      }
      throw error;
    }
  }

  cleanupTaskLaunch(input: Readonly<{
    taskId: string;
    launchId: string;
    reason: TaskRuntimeCleanupReason;
  }>): "absent" | "cleaned" {
    const taskId = requireIdentity(input.taskId, "Task id");
    const launchId = requireIdentity(input.launchId, "Launch id");
    requireCleanupReason(input.reason);
    const taskRoot = taskRuntimeInventoryRoot(
      this.#runtimeRoot,
      taskId,
      this.#pathLayout
    );
    let entries;
    try {
      const metadata = lstatSync(taskRoot);
      if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
        throw new Error("Task runtime Task root is ambiguous.");
      }
      entries = readdirSync(taskRoot, { withFileTypes: true });
    } catch (error) {
      if (isNodeCode(error, "ENOENT")) return "absent";
      throw error;
    }
    const launchDigest = taskRuntimeLaunchDigest(taskId, launchId, this.#pathLayout);
    const matches: TaskRuntimeIsolationPreparation[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.isSymbolicLink()) {
        throw new Error("Task runtime owner inventory is ambiguous.");
      }
      const generationRoot = join(taskRoot, entry.name, launchDigest);
      let metadata;
      try {
        metadata = lstatSync(generationRoot);
      } catch (error) {
        if (isNodeCode(error, "ENOENT")) continue;
        throw new Error("Task runtime generation inventory is ambiguous.", { cause: error });
      }
      if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
        throw new Error("Task runtime generation inventory is ambiguous.");
      }
      let marker: TaskRuntimeResourceMarker;
      try {
        marker = parseMarker(readFileSync(join(generationRoot, MARKER_FILE), "utf8"));
      } catch (error) {
        throw new Error("Task runtime launch generation is unmarked or invalid.", {
          cause: error
        });
      }
      const descriptor = marker.descriptor;
      const fingerprint = taskRuntimeIsolationFingerprint(descriptor);
      if (
        marker.fingerprint !== fingerprint
        || descriptor.taskId !== taskId
        || descriptor.generation.launchId !== launchId
        || descriptor.roots.generation !== generationRoot
      ) {
        throw new Error("Task runtime launch generation ownership is mismatched.");
      }
      matches.push({
        descriptor,
        fingerprint,
        environment: taskRuntimeIsolationEnvironment(descriptor)
      });
    }
    if (matches.length === 0) return "absent";
    if (matches.length !== 1) {
      throw new Error("Task runtime launch generation ownership is ambiguous.");
    }
    this.cleanup(matches[0]!, input.reason);
    return "cleaned";
  }
}

export function createTaskRuntimeIsolationDescriptor(input: Readonly<{
  workspace: ManagedWorkspace;
  runId?: string;
  launchId: string;
  generationId: string;
  runtimeRoot: string;
  pathLayout?: TaskRuntimePathLayout;
  policy?: TaskRuntimeLaunchPolicy;
}>): TaskRuntimeIsolationDescriptor {
  const workspace = validateManagedWorkspace(input.workspace);
  const owner = taskRuntimeWorkspaceOwner(workspace.owner);
  const taskId = requireIdentity(owner.taskId, "Task id");
  const runId = input.runId === undefined
    ? undefined
    : requireIdentity(input.runId, "Run id");
  const launchId = requireIdentity(input.launchId, "Launch id");
  const generationId = requireIdentity(input.generationId, "Generation id");
  const runtimeRoot = canonicalPath(input.runtimeRoot, "Task runtime root");
  const pathLayout = taskRuntimePathLayout(input.pathLayout);
  const generation = taskRuntimeGenerationRoot(
    runtimeRoot,
    taskId,
    owner,
    launchId,
    pathLayout
  );
  const declared = capabilities(
    input.policy?.declaredExternalCapabilities ?? [],
    "Declared external capability"
  );
  const requested = capabilities(
    input.policy?.requestedExternalCapabilities ?? [],
    "Requested external capability"
  );
  const portPreference = ports(input.policy?.portPreference ?? [], "Port preference");
  const portAllocations = allocations(input.policy?.portAllocations ?? []);
  return Object.freeze({
    schemaVersion: 1,
    kind: "yui-task-runtime-isolation",
    taskId,
    workspace: Object.freeze({ owner, root: canonicalPath(workspace.root, "Workspace root") }),
    roots: Object.freeze({
      generation,
      data: join(generation, "data"),
      cache: join(generation, "cache"),
      temporary: join(generation, "tmp")
    }),
    serviceNamespace: taskRuntimeServiceNamespace(
      taskId,
      owner,
      launchId,
      generationId
    ),
    portPreference,
    portAllocations,
    externalCapabilities: Object.freeze({ declared, requested }),
    generation: Object.freeze({
      ...(runId === undefined ? {} : { runId }),
      launchId,
      generationId
    })
  });
}

export function parseTaskRuntimeIsolationDescriptor(
  serialized: string
): TaskRuntimeIsolationDescriptor {
  let value: unknown;
  try {
    value = JSON.parse(serialized);
  } catch {
    throw new Error("Task runtime isolation descriptor is invalid JSON.");
  }
  if (!isRecord(value) || value.kind !== "yui-task-runtime-isolation") {
    throw new Error(
      `Expected yui-task-runtime-isolation descriptor; found ${
        isRecord(value) && typeof value.kind === "string" ? value.kind : "unknown"
      }.`
    );
  }
  if (value.schemaVersion !== 1) {
    throw new Error("Task runtime isolation descriptor schema version is invalid.");
  }
  const workspace = requireRecord(value.workspace, "Task runtime workspace");
  const roots = requireRecord(value.roots, "Task runtime roots");
  const generation = requireRecord(value.generation, "Task runtime generation");
  const external = requireRecord(
    value.externalCapabilities,
    "Task runtime external capabilities"
  );
  const owner = taskRuntimeWorkspaceOwner(
    requireRecord(workspace.owner, "Task runtime workspace owner") as ManagedWorkspaceOwner
  );
  const descriptor: TaskRuntimeIsolationDescriptor = {
    schemaVersion: 1,
    kind: "yui-task-runtime-isolation",
    taskId: requireIdentity(value.taskId, "Task id"),
    workspace: {
      owner,
      root: canonicalPath(workspace.root, "Workspace root")
    },
    roots: {
      generation: canonicalPath(roots.generation, "Task runtime generation root"),
      data: canonicalPath(roots.data, "Task runtime data root"),
      cache: canonicalPath(roots.cache, "Task runtime cache root"),
      temporary: canonicalPath(roots.temporary, "Task runtime temporary root")
    },
    serviceNamespace: requireIdentity(value.serviceNamespace, "Service namespace"),
    portPreference: ports(value.portPreference, "Port preference"),
    portAllocations: allocations(value.portAllocations),
    externalCapabilities: {
      declared: capabilities(external.declared, "Declared external capability"),
      requested: capabilities(external.requested, "Requested external capability")
    },
    generation: {
      ...(generation.runId === undefined
        ? {}
        : { runId: requireIdentity(generation.runId, "Run id") }),
      launchId: requireIdentity(generation.launchId, "Launch id"),
      generationId: requireIdentity(generation.generationId, "Generation id")
    }
  };
  return Object.freeze(descriptor);
}

export function taskRuntimeIsolationFingerprint(
  descriptor: TaskRuntimeIsolationDescriptor
): string {
  return digest(JSON.stringify(parseTaskRuntimeIsolationDescriptor(
    JSON.stringify(descriptor)
  )));
}

export function taskRuntimeIsolationEnvironment(
  descriptor: TaskRuntimeIsolationDescriptor
): Readonly<Record<string, string>> {
  const validated = parseTaskRuntimeIsolationDescriptor(JSON.stringify(descriptor));
  return Object.freeze({
    TMPDIR: validated.roots.temporary,
    XDG_CACHE_HOME: validated.roots.cache,
    XDG_DATA_HOME: validated.roots.data,
    XDG_STATE_HOME: join(validated.roots.data, "state"),
    XDG_RUNTIME_DIR: join(validated.roots.temporary, "runtime"),
    [YUI_TASK_RUNTIME_SERVICE_NAMESPACE]: validated.serviceNamespace,
    [YUI_TASK_RUNTIME_ISOLATION_DESCRIPTOR]: JSON.stringify(validated)
  });
}

export function assertTaskRuntimeIsolationPreflight(input: Readonly<{
  descriptor: TaskRuntimeIsolationDescriptor;
  workspace: ManagedWorkspace;
  runtimeRoot: string;
  pathLayout?: TaskRuntimePathLayout;
  controlPlane: TaskRuntimeControlBoundary;
  resources?: readonly TaskRuntimeResourceObservation[];
  allowExactActive?: boolean;
}>): TaskRuntimeIsolationDescriptor {
  const descriptor = parseTaskRuntimeIsolationDescriptor(JSON.stringify(input.descriptor));
  const workspace = validateManagedWorkspace(input.workspace);
  const expectedOwner = taskRuntimeWorkspaceOwner(workspace.owner);
  if (
    descriptor.taskId !== expectedOwner.taskId
    || JSON.stringify(descriptor.workspace.owner) !== JSON.stringify(expectedOwner)
    || descriptor.workspace.root !== workspace.root
  ) {
    throw new Error("Task runtime owner or workspace does not match its ManagedWorkspace.");
  }
  const runtimeRoot = canonicalPath(input.runtimeRoot, "Task runtime root");
  const pathLayout = taskRuntimePathLayout(input.pathLayout);
  const expectedGeneration = taskRuntimeGenerationRoot(
    runtimeRoot,
    descriptor.taskId,
    expectedOwner,
    descriptor.generation.launchId,
    pathLayout
  );
  if (
    descriptor.roots.generation !== expectedGeneration
    || descriptor.roots.data !== join(expectedGeneration, "data")
    || descriptor.roots.cache !== join(expectedGeneration, "cache")
    || descriptor.roots.temporary !== join(expectedGeneration, "tmp")
  ) {
    throw new Error(
      "Task runtime roots do not match the exact Task, owner, and launch identity."
    );
  }
  if (descriptor.serviceNamespace !== taskRuntimeServiceNamespace(
    descriptor.taskId,
    expectedOwner,
    descriptor.generation.launchId,
    descriptor.generation.generationId
  )) {
    throw new Error(
      "Task runtime service namespace does not match its exact Task launch generation."
    );
  }
  if (!isWithin(runtimeRoot, descriptor.roots.generation)) {
    throw new Error("Task runtime generation is outside its runtime root.");
  }
  for (const [name, root] of Object.entries(descriptor.roots)) {
    if (name !== "generation" && !isWithin(descriptor.roots.generation, root)) {
      throw new Error(`Task runtime ${name} root is outside its exact generation.`);
    }
  }
  const control = normalizeControlBoundary(input.controlPlane);
  const protectedPaths = [control.yuiHome, ...control.globalInstallPaths];
  for (const root of Object.values(descriptor.roots)) {
    if (protectedPaths.some((path) => pathsOverlap(root, path))) {
      throw new Error("Task runtime roots overlap the control YUI_HOME or a global install path.");
    }
    if (pathsOverlap(root, descriptor.workspace.root)) {
      throw new Error("Task runtime roots must not dirty the managed workspace.");
    }
    if (pathsOverlap(root, control.controllerSocketPath)) {
      throw new Error("Task runtime roots overlap the Controller socket.");
    }
  }
  if (descriptor.serviceNamespace === control.tmuxNamespace) {
    throw new Error("Task runtime service namespace overlaps the Controller tmux namespace.");
  }
  const declared = new Set(descriptor.externalCapabilities.declared);
  const undeclared = descriptor.externalCapabilities.requested.find(
    (capability) => !declared.has(capability)
  );
  if (undeclared !== undefined) {
    throw new Error(`Task runtime external capability is undeclared: ${undeclared}.`);
  }
  const fingerprint = taskRuntimeIsolationFingerprint(descriptor);
  const resourceIds = new Set<string>();
  for (const resource of input.resources ?? []) {
    validateObservation(resource);
    if (resourceIds.has(resource.id)) {
      throw new Error(`Task runtime resource inventory is ambiguous: ${resource.id}.`);
    }
    resourceIds.add(resource.id);
    const exact = resource.ownership === "owned"
      && resource.descriptorFingerprint === fingerprint;
    if (!exact) {
      throw new Error(`Task runtime resource is ambiguous or externally owned: ${resource.id}.`);
    }
    if (
      resource.state === "unknown"
      || (resource.state === "active" && input.allowExactActive !== true)
    ) {
      throw new Error(`Task runtime resource is not safely reusable: ${resource.id}.`);
    }
  }
  return descriptor;
}

export function planTaskRuntimeCleanup(
  descriptor: TaskRuntimeIsolationDescriptor,
  reason: TaskRuntimeCleanupReason,
  resources: readonly TaskRuntimeResourceObservation[]
): readonly string[] {
  requireCleanupReason(reason);
  const fingerprint = taskRuntimeIsolationFingerprint(descriptor);
  const ids = new Set<string>();
  for (const resource of resources) {
    validateObservation(resource);
    if (ids.has(resource.id)) {
      throw new Error(`Task runtime resource inventory is ambiguous: ${resource.id}.`);
    }
    ids.add(resource.id);
    if (
      resource.ownership !== "owned"
      || resource.descriptorFingerprint !== fingerprint
    ) {
      throw new Error(`Task runtime cleanup refused an unowned resource: ${resource.id}.`);
    }
    if (resource.state !== "inactive") {
      throw new Error(`Task runtime cleanup refused an active or unknown resource: ${resource.id}.`);
    }
  }
  return Object.freeze([...ids].sort());
}

function inspectGenerationRoot(
  descriptor: TaskRuntimeIsolationDescriptor,
  expectedFingerprint: string
): readonly TaskRuntimeResourceObservation[] {
  const root = descriptor.roots.generation;
  let metadata;
  try {
    metadata = lstatSync(root);
  } catch (error) {
    if (isNodeCode(error, "ENOENT")) return [];
    return [{ id: root, kind: "directory", ownership: "ambiguous", state: "unknown" }];
  }
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    return [{ id: root, kind: "directory", ownership: "ambiguous", state: "unknown" }];
  }
  try {
    const markerPath = join(root, MARKER_FILE);
    const markerMetadata = lstatSync(markerPath);
    if (!markerMetadata.isFile() || markerMetadata.isSymbolicLink()) {
      return [{ id: root, kind: "directory", ownership: "unmarked", state: "unknown" }];
    }
    const marker = parseMarker(readFileSync(markerPath, "utf8"));
    const actualFingerprint = taskRuntimeIsolationFingerprint(marker.descriptor);
    const exact = marker.fingerprint === actualFingerprint
      && actualFingerprint === expectedFingerprint
      && JSON.stringify(marker.descriptor) === JSON.stringify(descriptor);
    return [{
      id: root,
      kind: "directory",
      ownership: exact ? "owned" : "mismatched",
      state: exact ? "inactive" : "unknown",
      descriptorFingerprint: actualFingerprint
    }];
  } catch {
    return [{ id: root, kind: "directory", ownership: "unmarked", state: "unknown" }];
  }
}

function parseMarker(serialized: string): TaskRuntimeResourceMarker {
  const value = JSON.parse(serialized) as unknown;
  if (
    !isRecord(value)
    || value.schemaVersion !== 1
    || value.kind !== "yui-task-runtime-resource-owner"
  ) {
    throw new Error("Task runtime resource marker is invalid.");
  }
  return {
    schemaVersion: 1,
    kind: "yui-task-runtime-resource-owner",
    fingerprint: requireDigest(value.fingerprint),
    descriptor: parseTaskRuntimeIsolationDescriptor(JSON.stringify(value.descriptor))
  };
}

function ensureOwnedDirectories(descriptor: TaskRuntimeIsolationDescriptor): void {
  for (const path of [
    descriptor.roots.data,
    descriptor.roots.cache,
    descriptor.roots.temporary,
    join(descriptor.roots.data, "state"),
    join(descriptor.roots.temporary, "runtime")
  ]) {
    ensureDirectoryChain(descriptor.roots.generation, path);
  }
}

function ensureDirectoryChain(boundary: string, target: string): void {
  const root = resolve(boundary);
  const destination = resolve(target);
  if (root !== destination && !isWithin(root, destination)) {
    throw new Error("Task runtime directory escaped its exact ownership boundary.");
  }
  const segments = relative(root, destination).split(/[\\/]/u).filter(Boolean);
  let current = root;
  ensureDirectory(current);
  for (const segment of segments) {
    current = join(current, segment);
    ensureDirectory(current);
  }
}

function ensureDirectory(path: string): void {
  try {
    const metadata = lstatSync(path);
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
      throw new Error(`Task runtime path is not an owned directory: ${path}.`);
    }
  } catch (error) {
    if (!isNodeCode(error, "ENOENT")) throw error;
    mkdirSync(path, { mode: 0o700 });
  }
}

function validatePreparation(
  preparation: TaskRuntimeIsolationPreparation
): TaskRuntimeIsolationPreparation {
  const descriptor = parseTaskRuntimeIsolationDescriptor(
    JSON.stringify(preparation.descriptor)
  );
  const fingerprint = taskRuntimeIsolationFingerprint(descriptor);
  if (preparation.fingerprint !== fingerprint) {
    throw new Error("Task runtime isolation preparation fingerprint changed.");
  }
  return { descriptor, fingerprint, environment: taskRuntimeIsolationEnvironment(descriptor) };
}

function taskRuntimeWorkspaceOwner(owner: ManagedWorkspaceOwner): TaskRuntimeWorkspaceOwner {
  return owner;
}

function taskRuntimeGenerationRoot(
  runtimeRoot: string,
  taskId: string,
  owner: TaskRuntimeWorkspaceOwner,
  launchId: string,
  pathLayout: TaskRuntimePathLayout = "hierarchical"
): string {
  return join(
    taskRuntimeInventoryRoot(runtimeRoot, taskId, pathLayout),
    taskRuntimeOwnerDigest(taskId, owner, pathLayout),
    taskRuntimeLaunchDigest(taskId, launchId, pathLayout)
  );
}

function taskRuntimeInventoryRoot(
  runtimeRoot: string,
  taskId: string,
  pathLayout: TaskRuntimePathLayout
): string {
  return pathLayout === "compact" ? runtimeRoot : join(runtimeRoot, taskId);
}

function taskRuntimeOwnerDigest(
  taskId: string,
  owner: TaskRuntimeWorkspaceOwner,
  pathLayout: TaskRuntimePathLayout
): string {
  return pathLayout === "compact"
    ? digest(JSON.stringify([taskId, owner])).slice(0, 20)
    : digest(JSON.stringify(owner)).slice(0, 24);
}

function taskRuntimeLaunchDigest(
  taskId: string,
  launchId: string,
  pathLayout: TaskRuntimePathLayout
): string {
  return digest(JSON.stringify([taskId, launchId])).slice(
    0,
    pathLayout === "compact" ? 20 : 24
  );
}

function taskRuntimePathLayout(value: TaskRuntimePathLayout | undefined): TaskRuntimePathLayout {
  const pathLayout = value ?? "hierarchical";
  if (pathLayout !== "hierarchical" && pathLayout !== "compact") {
    throw new Error("Task runtime path layout is invalid.");
  }
  return pathLayout;
}

function taskRuntimeServiceNamespace(
  taskId: string,
  owner: TaskRuntimeWorkspaceOwner,
  launchId: string,
  generationId: string
): string {
  return `yui-task-${digest(JSON.stringify([
    taskId,
    owner,
    launchId,
    generationId
  ])).slice(0, 24)}`;
}

function normalizeControlBoundary(
  value: TaskRuntimeControlBoundary
): Required<TaskRuntimeControlBoundary> {
  return Object.freeze({
    yuiHome: canonicalPath(value.yuiHome, "Control YUI_HOME"),
    controllerSocketPath: canonicalPath(
      value.controllerSocketPath,
      "Controller socket path"
    ),
    tmuxNamespace: requireIdentity(value.tmuxNamespace, "Controller tmux namespace"),
    globalInstallPaths: Object.freeze((value.globalInstallPaths ?? []).map(
      (path) => canonicalPath(path, "Global install path")
    ))
  });
}

function validateObservation(resource: TaskRuntimeResourceObservation): void {
  requireText(resource.id, "Task runtime resource id");
  if (!["directory", "service", "port", "external"].includes(resource.kind)) {
    throw new Error("Task runtime resource kind is invalid.");
  }
  if (!["owned", "unmarked", "mismatched", "ambiguous", "external"].includes(
    resource.ownership
  )) {
    throw new Error("Task runtime resource ownership is invalid.");
  }
  if (!["inactive", "active", "unknown"].includes(resource.state)) {
    throw new Error("Task runtime resource state is invalid.");
  }
  if (resource.descriptorFingerprint !== undefined) {
    requireDigest(resource.descriptorFingerprint);
  }
}

function allocations(value: unknown): readonly TaskRuntimePortAllocation[] {
  if (!Array.isArray(value)) throw new Error("Task runtime port allocations are invalid.");
  const names = new Set<string>();
  const selected = new Set<number>();
  const result = value.map((candidate) => {
    if (!isRecord(candidate)) throw new Error("Task runtime port allocation is invalid.");
    const name = requireIdentity(candidate.name, "Port allocation name");
    const port = requirePort(candidate.port, "Port allocation");
    if (names.has(name) || selected.has(port)) {
      throw new Error("Task runtime port allocations must be unique.");
    }
    names.add(name);
    selected.add(port);
    return Object.freeze({ name, port });
  });
  return Object.freeze(result.sort((left, right) => left.name.localeCompare(right.name)));
}

function ports(value: unknown, label: string): readonly number[] {
  if (!Array.isArray(value)) throw new Error(`${label} is invalid.`);
  const result = value.map((port) => requirePort(port, label));
  if (new Set(result).size !== result.length) throw new Error(`${label} must be unique.`);
  return Object.freeze([...result]);
}

function capabilities(value: unknown, label: string): readonly string[] {
  if (!Array.isArray(value)) throw new Error(`${label} list is invalid.`);
  const result = value.map((item) => requireIdentity(item, label)).sort();
  if (new Set(result).size !== result.length) throw new Error(`${label} must be unique.`);
  return Object.freeze(result);
}

function requirePort(value: unknown, label: string): number {
  if (!Number.isInteger(value) || (value as number) < 1 || (value as number) > 65_535) {
    throw new Error(`${label} is invalid.`);
  }
  return value as number;
}

function requireCleanupReason(value: string): TaskRuntimeCleanupReason {
  if (!["failure", "timeout", "interruption", "completion", "reopen"].includes(value)) {
    throw new Error("Task runtime cleanup reason is invalid.");
  }
  return value as TaskRuntimeCleanupReason;
}

function canonicalPath(value: unknown, label: string): string {
  const path = requireText(value, label);
  if (!isAbsolute(path)) throw new Error(`${label} must be absolute.`);
  return resolve(path);
}

function pathsOverlap(left: string, right: string): boolean {
  return left === right || isWithin(left, right) || isWithin(right, left);
}

function isWithin(parent: string, child: string): boolean {
  const nested = relative(resolve(parent), resolve(child));
  return nested.length > 0 && !nested.startsWith("..") && !isAbsolute(nested);
}

function requireIdentity(value: unknown, label: string): string {
  const identity = requireText(value, label);
  if (
    [".", "..", "__proto__", "prototype", "constructor"].includes(identity)
    || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u.test(identity)
  ) {
    throw new Error(`${label} is invalid.`);
  }
  return identity;
}

function requireText(value: unknown, label: string): string {
  if (
    typeof value !== "string"
    || value.length === 0
    || value.trim() !== value
    || value.includes("\0")
  ) {
    throw new Error(`${label} is invalid.`);
  }
  return value;
}

function requireDigest(value: unknown): string {
  const digestValue = requireText(value, "Task runtime fingerprint");
  if (!/^[a-f0-9]{64}$/u.test(digestValue)) {
    throw new Error("Task runtime fingerprint is invalid.");
  }
  return digestValue;
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) throw new Error(`${label} is invalid.`);
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function isNodeCode(error: unknown, code: string): boolean {
  return typeof error === "object"
    && error !== null
    && "code" in error
    && (error as { code?: unknown }).code === code;
}
