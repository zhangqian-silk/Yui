import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync
} from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { runtimeError, usageError } from "../errors/cliError.js";
import type { RoleWorktree } from "./worktree.js";

const TOKEN_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DIGEST_PATTERN = /^[0-9a-f]{64}$/;

export type GitWorktreeCreatePlan = {
  kind: "git-worktree-create";
  roleName: string;
  repositoryRoot: string;
  commonDir: string;
  repositoryFingerprint: string;
  targetPath: string;
  baseOid: string;
  requestedBranch: string;
  temporaryBranch: string;
  ownerToken: string;
  markerPath: string;
};

export type GitWorktreeRemovePlan = {
  kind: "git-worktree-remove";
  roleName: string;
  repositoryRoot: string;
  commonDir: string;
  repositoryFingerprint: string;
  targetPath: string;
  worktreeGitDir: string;
  ownerToken: string;
  branchRef: string;
  headOid: string;
  markerPath: string;
};

type OwnershipMarker = {
  schemaVersion: 1;
  ownerToken: string;
  repositoryFingerprint: string;
  targetPath: string;
};

export class GitWorktreeManager {
  probeCreate(input: {
    roleName: string;
    repository: string;
    path: string;
    branch: string;
    base?: string;
    ownerToken: string;
    taskmuxHome: string;
  }): GitWorktreeCreatePlan {
    const repositoryRoot = this.repositoryRoot(input.repository);
    const commonDir = this.commonDir(repositoryRoot);
    const repositoryFingerprint = fingerprint(commonDir);
    const targetPath = canonicalMissingPath(repositoryRoot, input.path);
    const taskmuxHome = canonicalExistingDirectory(input.taskmuxHome);
    for (const protectedPath of [repositoryRoot, commonDir, taskmuxHome]) {
      if (pathsOverlap(targetPath, protectedPath)) {
        throw usageError(`Worktree path overlaps protected storage: ${targetPath}.`);
      }
    }
    if (existsSync(targetPath)) throw usageError(`Worktree path already exists: ${targetPath}.`);
    const requestedBranch = validateBranch(input.branch);
    const base = input.base?.trim() || "HEAD";
    if (base.startsWith("-")) throw usageError("Worktree base cannot start with '-'.");
    const baseOid = this.git(repositoryRoot, ["rev-parse", "--verify", `${base}^{commit}`]).trim();
    if (!/^[0-9a-f]{40,64}$/.test(baseOid)) throw usageError("Worktree base is not a commit.");
    if (this.gitStatus(repositoryRoot, ["show-ref", "--verify", "--quiet", `refs/heads/${requestedBranch}`]) === 0) {
      throw usageError(`Worktree branch already exists: ${requestedBranch}.`);
    }
    const temporaryBranch = `taskmux-op-${input.ownerToken}`;
    validateBranch(temporaryBranch);
    const markerPath = join(commonDir, "taskmux-worktree-owners", `${input.ownerToken}.json`);
    return {
      kind: "git-worktree-create",
      roleName: input.roleName,
      repositoryRoot,
      commonDir,
      repositoryFingerprint,
      targetPath,
      baseOid,
      requestedBranch,
      temporaryBranch,
      ownerToken: input.ownerToken,
      markerPath
    };
  }

  applyCreate(plan: GitWorktreeCreatePlan, taskId: string, now: Date): RoleWorktree {
    this.assertRepository(plan.repositoryRoot, plan.commonDir, plan.repositoryFingerprint);
    this.assertMarkerStorage(plan.markerPath, plan.commonDir);
    const marker = this.readMarker(plan.markerPath);
    if (marker !== null) this.assertMarker(marker, plan);
    if (marker !== null && !existsSync(plan.targetPath)) {
      throw runtimeError(`Owned worktree target disappeared after marker creation: ${plan.targetPath}.`);
    }

    if (!existsSync(plan.targetPath)) {
      const temporaryExists = this.gitStatus(
        plan.repositoryRoot,
        ["show-ref", "--verify", "--quiet", `refs/heads/${plan.temporaryBranch}`]
      ) === 0;
      if (!temporaryExists) {
        this.git(plan.repositoryRoot, ["branch", plan.temporaryBranch, plan.baseOid]);
      } else {
        const temporaryOid = this.git(
          plan.repositoryRoot,
          ["rev-parse", "--verify", `refs/heads/${plan.temporaryBranch}^{commit}`]
        ).trim();
        if (temporaryOid !== plan.baseOid) {
          throw runtimeError(`Worktree temporary branch is foreign: ${plan.temporaryBranch}.`);
        }
      }
      this.git(plan.repositoryRoot, ["worktree", "add", plan.targetPath, plan.temporaryBranch]);
    }

    const identity = this.worktreeIdentity(plan.targetPath);
    if (
      identity.repositoryRoot !== plan.targetPath || identity.commonDir !== plan.commonDir ||
      identity.repositoryFingerprint !== plan.repositoryFingerprint
    ) {
      throw runtimeError(`Worktree target is owned by a foreign repository: ${plan.targetPath}.`);
    }
    if (identity.branchRef !== plan.temporaryBranch && identity.branchRef !== plan.requestedBranch) {
      throw runtimeError(`Worktree branch is foreign: ${identity.branchRef}.`);
    }
    if (identity.headOid !== plan.baseOid) {
      throw runtimeError(`Worktree HEAD changed before ownership was finalized: ${plan.targetPath}.`);
    }

    if (marker === null) this.writeMarker(plan);
    if (identity.branchRef === plan.temporaryBranch) {
      this.git(plan.targetPath, ["branch", "-m", plan.requestedBranch]);
    }
    const finalized = this.worktreeIdentity(plan.targetPath);
    if (finalized.branchRef !== plan.requestedBranch || finalized.headOid !== plan.baseOid) {
      throw runtimeError(`Worktree creation could not be confirmed: ${plan.targetPath}.`);
    }
    return {
      schemaVersion: 2,
      taskId,
      roleName: plan.roleName,
      repositoryRoot: plan.repositoryRoot,
      commonDir: plan.commonDir,
      repositoryFingerprint: plan.repositoryFingerprint,
      path: plan.targetPath,
      worktreeGitDir: finalized.worktreeGitDir,
      branchRef: plan.requestedBranch,
      headOid: plan.baseOid,
      ownerToken: plan.ownerToken,
      createdAt: now.toISOString()
    };
  }

  probeRemove(record: RoleWorktree): GitWorktreeRemovePlan {
    const markerPath = join(record.commonDir, "taskmux-worktree-owners", `${record.ownerToken}.json`);
    return {
      kind: "git-worktree-remove",
      roleName: record.roleName,
      repositoryRoot: record.repositoryRoot,
      commonDir: record.commonDir,
      repositoryFingerprint: record.repositoryFingerprint,
      targetPath: record.path,
      worktreeGitDir: record.worktreeGitDir,
      ownerToken: record.ownerToken,
      branchRef: record.branchRef,
      headOid: record.headOid,
      markerPath
    };
  }

  applyRemove(plan: GitWorktreeRemovePlan): void {
    this.assertRepository(plan.repositoryRoot, plan.commonDir, plan.repositoryFingerprint);
    this.assertMarkerStorage(plan.markerPath, plan.commonDir);
    const marker = this.readMarker(plan.markerPath);
    if (!existsSync(plan.targetPath)) {
      if (existsSync(plan.worktreeGitDir)) {
        throw runtimeError(`Worktree path disappeared while Git ownership remains: ${plan.targetPath}.`);
      }
      if (marker !== null) this.assertMarker(marker, plan);
      this.assertMarkerStorage(plan.markerPath, plan.commonDir);
      rmSync(plan.markerPath, { force: true });
      return;
    }
    if (marker === null) throw runtimeError(`Worktree ownership marker is missing: ${plan.targetPath}.`);
    this.assertMarker(marker, plan);
    const identity = this.worktreeIdentity(plan.targetPath);
    if (
      identity.repositoryRoot !== plan.targetPath || identity.commonDir !== plan.commonDir ||
      identity.repositoryFingerprint !== plan.repositoryFingerprint ||
      identity.worktreeGitDir !== plan.worktreeGitDir || identity.branchRef !== plan.branchRef ||
      identity.headOid !== plan.headOid
    ) {
      throw runtimeError(`Worktree identity changed before removal: ${plan.targetPath}.`);
    }
    if (this.git(plan.targetPath, ["status", "--porcelain"]).trim().length > 0) {
      throw usageError(`Worktree has uncommitted changes: ${plan.targetPath}.`);
    }
    this.git(plan.repositoryRoot, ["worktree", "remove", plan.targetPath]);
    if (existsSync(plan.targetPath) || existsSync(plan.worktreeGitDir)) {
      throw runtimeError(`Worktree removal could not be confirmed: ${plan.targetPath}.`);
    }
    this.assertMarkerStorage(plan.markerPath, plan.commonDir);
    rmSync(plan.markerPath, { force: true });
  }

  private repositoryRoot(path: string): string {
    const root = this.git(path, ["rev-parse", "--show-toplevel"]).trim();
    return canonicalExistingDirectory(root);
  }

  private commonDir(repositoryRoot: string): string {
    const raw = this.git(repositoryRoot, ["rev-parse", "--git-common-dir"]).trim();
    return canonicalExistingDirectory(isAbsolute(raw) ? raw : resolve(repositoryRoot, raw));
  }

  private worktreeIdentity(path: string): {
    repositoryRoot: string;
    commonDir: string;
    repositoryFingerprint: string;
    worktreeGitDir: string;
    branchRef: string;
    headOid: string;
  } {
    const canonicalPath = canonicalExistingDirectory(path);
    if (canonicalPath !== path) throw runtimeError(`Worktree path identity changed: ${path}.`);
    const repositoryRoot = this.repositoryRoot(canonicalPath);
    const commonDir = this.commonDir(repositoryRoot);
    const rawGitDir = this.git(canonicalPath, ["rev-parse", "--git-dir"]).trim();
    const worktreeGitDir = canonicalExistingDirectory(
      isAbsolute(rawGitDir) ? rawGitDir : resolve(canonicalPath, rawGitDir)
    );
    return {
      repositoryRoot,
      commonDir,
      repositoryFingerprint: fingerprint(commonDir),
      worktreeGitDir,
      branchRef: this.git(canonicalPath, ["symbolic-ref", "--short", "HEAD"]).trim(),
      headOid: this.git(canonicalPath, ["rev-parse", "HEAD"]).trim()
    };
  }

  private assertRepository(root: string, commonDir: string, expectedFingerprint: string): void {
    if (this.repositoryRoot(root) !== root || this.commonDir(root) !== commonDir || fingerprint(commonDir) !== expectedFingerprint) {
      throw runtimeError(`Repository identity changed before worktree effect: ${root}.`);
    }
  }

  private readMarker(path: string): OwnershipMarker | null {
    if (!existsSync(path)) return null;
    if (lstatSync(path).isSymbolicLink() || !lstatSync(path).isFile()) {
      throw runtimeError("Invalid worktree ownership marker.");
    }
    let value: unknown;
    try { value = JSON.parse(readFileSync(path, "utf8")) as unknown; } catch {
      throw runtimeError("Invalid worktree ownership marker.");
    }
    if (
      typeof value !== "object" || value === null || Array.isArray(value) ||
      Object.keys(value).length !== 4 ||
      !["schemaVersion", "ownerToken", "repositoryFingerprint", "targetPath"]
        .every((key) => Object.hasOwn(value, key)) ||
      (value as OwnershipMarker).schemaVersion !== 1 ||
      typeof (value as OwnershipMarker).ownerToken !== "string" ||
      !TOKEN_PATTERN.test((value as OwnershipMarker).ownerToken) ||
      typeof (value as OwnershipMarker).repositoryFingerprint !== "string" ||
      !DIGEST_PATTERN.test((value as OwnershipMarker).repositoryFingerprint) ||
      typeof (value as OwnershipMarker).targetPath !== "string" ||
      !isAbsolute((value as OwnershipMarker).targetPath) ||
      resolve((value as OwnershipMarker).targetPath) !== (value as OwnershipMarker).targetPath
    ) throw runtimeError("Invalid worktree ownership marker.");
    return value as OwnershipMarker;
  }

  private writeMarker(plan: GitWorktreeCreatePlan): void {
    this.assertMarkerStorage(plan.markerPath, plan.commonDir, true);
    const marker: OwnershipMarker = {
      schemaVersion: 1,
      ownerToken: plan.ownerToken,
      repositoryFingerprint: plan.repositoryFingerprint,
      targetPath: plan.targetPath
    };
    writeFileSync(plan.markerPath, `${JSON.stringify(marker, null, 2)}\n`, { flag: "wx", mode: 0o600 });
  }

  private assertMarkerStorage(markerPath: string, commonDir: string, create = false): void {
    const expectedDirectory = join(commonDir, "taskmux-worktree-owners");
    if (dirname(markerPath) !== expectedDirectory || canonicalExistingDirectory(commonDir) !== commonDir) {
      throw runtimeError("Invalid worktree ownership marker path.");
    }
    if (!existsSync(expectedDirectory)) {
      if (!create) return;
      mkdirSync(expectedDirectory, { recursive: false, mode: 0o700 });
    }
    const storage = lstatSync(expectedDirectory);
    if (storage.isSymbolicLink()) {
      throw runtimeError("Worktree ownership marker storage cannot be a symbolic link.");
    }
    if (!storage.isDirectory() || realpathSync(expectedDirectory) !== expectedDirectory) {
      throw runtimeError("Invalid worktree ownership marker storage.");
    }
  }

  private assertMarker(marker: OwnershipMarker, plan: {
    ownerToken: string;
    repositoryFingerprint: string;
    targetPath: string;
  }): void {
    if (
      marker.ownerToken !== plan.ownerToken ||
      marker.repositoryFingerprint !== plan.repositoryFingerprint ||
      marker.targetPath !== plan.targetPath
    ) throw runtimeError(`Worktree ownership marker is foreign: ${plan.targetPath}.`);
  }

  protected git(cwd: string, args: string[]): string {
    try {
      return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw usageError(`Git worktree operation failed: ${message}`);
    }
  }

  protected gitStatus(cwd: string, args: string[]): number {
    try {
      execFileSync("git", ["-C", cwd, ...args], { stdio: "ignore" });
      return 0;
    } catch (error) {
      if (typeof error === "object" && error !== null && "status" in error && typeof error.status === "number") {
        return error.status;
      }
      throw error;
    }
  }
}

function canonicalExistingDirectory(path: string): string {
  const target = resolve(path);
  if (lstatSync(target).isSymbolicLink()) throw usageError(`Symbolic links are not allowed: ${target}.`);
  const canonical = realpathSync(target);
  if (!statSync(canonical).isDirectory()) throw usageError(`Expected a directory: ${canonical}.`);
  return canonical;
}

function canonicalMissingPath(repositoryRoot: string, value: string): string {
  const trimmed = value.trim();
  if (trimmed.length === 0) throw usageError("Worktree path is required.");
  const target = resolve(repositoryRoot, trimmed);
  const parent = canonicalExistingDirectory(dirname(target));
  const canonical = join(parent, basename(target));
  if (canonical !== target) throw usageError(`Worktree path is not canonical: ${target}.`);
  return canonical;
}

function validateBranch(value: string): string {
  const branch = value.trim();
  if (branch.length === 0 || branch.startsWith("-")) throw usageError("Worktree branch is invalid.");
  try {
    execFileSync("git", ["check-ref-format", "--branch", branch], { stdio: "ignore" });
  } catch {
    throw usageError(`Worktree branch is invalid: ${branch}.`);
  }
  return branch;
}

function fingerprint(commonDir: string): string {
  const stat = statSync(commonDir);
  return createHash("sha256")
    .update(JSON.stringify({ commonDir, dev: String(stat.dev), ino: String(stat.ino) }))
    .digest("hex");
}

function pathsOverlap(left: string, right: string): boolean {
  const leftToRight = relative(left, right);
  const rightToLeft = relative(right, left);
  return leftToRight === "" || (!leftToRight.startsWith("..") && !isAbsolute(leftToRight)) ||
    (!rightToLeft.startsWith("..") && !isAbsolute(rightToLeft));
}
