/**
 * Immediate Resource registry instrumentation (Issue 10).
 *
 * Every Yui-created workspace/runtime path is registered in the same
 * controlled step that creates it. Discovery remains the authority for
 * historical resources, but these receipts let GC prove ownership for
 * registry-only paths such as `/tmp/yi-*` integration runtimes.
 */

import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";

import type { ManagedWorkspace, ManagedWorkspaceOwner } from "../worktree/managedWorkspace.js";
import type { TaskRuntimeIsolationDescriptor } from "../runtime/taskRuntimeIsolation.js";
import type { ExactTaskRuntimeDescriptor } from "../runtime/exactControlPlane.js";
import { createResourceRegistryStore } from "./resourceRegistryStore.js";
import {
  upsertResourceRecord
} from "./resourceRegistry.js";
import {
  createResourceRecord,
  isReleaseNamespacePath,
  resourceId,
  type ResourceCleanliness,
  type ResourceKind,
  type ResourceOwner,
  type ResourceRecord
} from "./resourceTypes.js";

export class ResourceRegistrar {
  readonly #home: string;
  readonly #now: () => Date;

  constructor(home: string, now: () => Date = () => new Date()) {
    this.#home = resolve(home);
    this.#now = now;
  }

  registerManagedWorkspace(workspace: ManagedWorkspace): void {
    const records: ResourceRecord[] = [];
    const root = resolve(workspace.root);
    if (existsSync(root)
      && !workspace.entries.some((entry) => resolve(entry.path) === root)
      && !isReleaseNamespacePath(this.#home, root)) {
      records.push(this.#record({
        kind: "runtime-artifact",
        path: root,
        owner: ownerFromManagedWorkspace(this.#home, workspace.owner),
        cleanliness: "n/a"
      }));
    }
    for (const entry of workspace.entries) {
      if (entry.access !== "write") continue;
      const path = resolve(entry.path);
      if (!existsSync(path) || isReleaseNamespacePath(this.#home, path)) continue;
      records.push(this.#record({
        kind: "worktree",
        path,
        owner: ownerFromManagedWorkspace(this.#home, workspace.owner, entry.projectId),
        git: readGitWorktreeMetadata(path),
        cleanliness: readGitWorktreeCleanliness(path)
      }));
    }
    this.#save(records);
  }

  registerTaskRuntimeIsolation(descriptor: TaskRuntimeIsolationDescriptor): void {
    const owner = ownerFromManagedWorkspace(this.#home, descriptor.workspace.owner);
    this.#save([
      descriptor.roots.generation,
      descriptor.roots.data,
      descriptor.roots.cache,
      descriptor.roots.temporary
    ].filter((path, index, paths) => paths.indexOf(path) === index && existsSync(path))
      .map((path) => this.#record({
        kind: "runtime-artifact",
        path: resolve(path),
        owner,
        cleanliness: "n/a"
      })));
  }

  registerExactTaskRuntimeDescriptor(
    descriptor: ExactTaskRuntimeDescriptor,
    sourcePath: string
  ): void {
    const path = resolve(sourcePath);
    if (!existsSync(path) || isReleaseNamespacePath(this.#home, path)) return;
    this.#save([this.#record({
      kind: "runtime-artifact",
      path,
      owner: {
        home: this.#home,
        taskId: descriptor.taskId,
        basis: "descriptor"
      },
      cleanliness: "n/a"
    })]);
  }

  registerSessionContext(path: string, owner: ResourceOwner): void {
    const resolved = resolve(path);
    if (!existsSync(resolved) || isReleaseNamespacePath(this.#home, resolved)) return;
    this.#save([this.#record({
      kind: "runtime-artifact",
      path: resolved,
      owner,
      cleanliness: "n/a"
    })]);
  }

  markWorkspaceDeleted(workspace: ManagedWorkspace): void {
    this.markPathsDeleted([
      workspace.root,
      ...workspace.entries.map((entry) => entry.path)
    ]);
  }

  markPathsDeleted(paths: readonly string[]): void {
    const targets = new Set(paths.map((path) => resolve(path)));
    const store = createResourceRegistryStore(this.#home);
    try {
      const state = store.load();
      let next = state;
      const timestamp = this.#now().toISOString();
      for (const record of Object.values(state.records) as ResourceRecord[]) {
        if (!targets.has(record.path) || record.disposition === "deleted") continue;
        next = upsertResourceRecord(next, {
          ...record,
          activeRefs: Object.freeze([]),
          disposition: "deleted",
          blocker: undefined,
          quarantine: undefined,
          cleanupReceipt: {
            removedAt: timestamp,
            method: record.kind === "worktree" ? "git-worktree-remove" : "runtime-cleanup"
          },
          updatedAt: timestamp
        });
      }
      if (next !== state) store.save(next);
    } finally {
      store.close();
    }
  }

  #record(input: Readonly<{
    kind: ResourceKind;
    path: string;
    owner: ResourceOwner;
    git?: ResourceRecord["git"];
    cleanliness: ResourceCleanliness;
  }>): ResourceRecord {
    const timestamp = this.#now();
    const store = createResourceRegistryStore(this.#home);
    let existing: ResourceRecord | undefined;
    try {
      existing = store.load().records[resourceId(input.kind, input.path)];
    } finally {
      store.close();
    }
    return createResourceRecord({
      kind: input.kind,
      path: input.path,
      owner: input.owner,
      ...(input.git === undefined ? {} : { git: input.git }),
      ...(existing?.createdAt === undefined ? {} : { createdAt: existing.createdAt }),
      lastReferencedAt: timestamp.toISOString(),
      cleanliness: input.cleanliness,
      activeRefs: [],
      disposition: "active"
    }, timestamp);
  }

  #save(records: readonly ResourceRecord[]): void {
    if (records.length === 0) return;
    const store = createResourceRegistryStore(this.#home);
    try {
      let state = store.load();
      for (const record of records) state = upsertResourceRecord(state, record);
      store.save(state);
    } finally {
      store.close();
    }
  }
}

function ownerFromManagedWorkspace(
  home: string,
  owner: ManagedWorkspaceOwner,
  projectId?: string
): ResourceOwner {
  return {
    home,
    ...(projectId === undefined ? {} : { projectId }),
    taskId: owner.taskId,
    ...(owner.type === "work-item" ? { workItemId: owner.workItemId } : {}),
    ...(owner.type === "review-round" ? { reviewRoundId: owner.reviewRoundId } : {}),
    ...(owner.type === "integration-attempt"
      ? { integrationAttemptId: owner.integrationAttemptId }
      : {}),
    ...(owner.type === "execution-lane" && owner.workItemId !== undefined
      ? { workItemId: owner.workItemId }
      : {}),
    ...(owner.type === "execution-lane" && owner.reviewRoundId !== undefined
      ? { reviewRoundId: owner.reviewRoundId }
      : {}),
    basis: "durable-record"
  };
}

function readGitWorktreeMetadata(path: string): ResourceRecord["git"] {
  const commonDir = execFileSync(
    "git",
    ["-C", path, "rev-parse", "--path-format=absolute", "--git-common-dir"],
    { encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }
  ).trim();
  const repositoryPath = basename(commonDir) === ".git" ? dirname(commonDir) : commonDir;
  let branch: string | undefined;
  try {
    branch = execFileSync(
      "git",
      ["-C", path, "symbolic-ref", "--quiet", "--short", "HEAD"],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }
    ).trim();
  } catch {
    branch = undefined;
  }
  const head = execFileSync(
    "git",
    ["-C", path, "rev-parse", "HEAD^{commit}"],
    { encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }
  ).trim();
  return {
    repositoryPath,
    commonDir,
    ...(branch === undefined || branch === "" ? {} : { branch }),
    head
  };
}

function readGitWorktreeCleanliness(path: string): ResourceCleanliness {
  try {
    const status = execFileSync(
      "git",
      ["-C", path, "status", "--porcelain=v1", "--untracked-files=all"],
      { encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }
    );
    return status.length > 0 ? "dirty" : "clean";
  } catch {
    return "unknown";
  }
}
