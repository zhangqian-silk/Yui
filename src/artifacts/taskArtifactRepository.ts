import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { acquireArtifactCommitLock } from "./artifactCommitLock.js";
import {
  resolveContainedArtifactPath,
  safeRelativeArtifactPath,
  taskArtifactRepoPath
} from "./artifactPaths.js";
import {
  ManagedGitError,
  externalProgramConfigViolations,
  managedGit,
  managedGitBuffer,
  managedGitSucceeds,
  requireCommitId
} from "./managedGit.js";

/**
 * Per-Task local-only Git artifact repository.
 *
 * This is the authority for a Task's file/directory artifacts: complete plans,
 * prototypes, charts, reports and other multi-file material. It is a plain
 * local Git repository under `<YUI_HOME>/task-artifacts/<task-id>/` with:
 *
 *   - NO remote of any kind (network or file). A remote appearing in the repo
 *     is treated as an external violation: {@link assertNoRemote} reports it and
 *     stops managed writes; the configuration is never silently removed.
 *   - a hardened, isolated Git subprocess (see {@link managedGit}) that cannot
 *     reach the network, run hooks/filters, or read ambient user/system config.
 *   - fixed committer identity and an empty root commit, so HEAD always exists
 *     and per-path scoped commits work uniformly from the first real save.
 *
 * Save model (§3.4): write file(s) → validate scope → local commit → saved.
 * A successful commit IS the save; there is no DB round-trip on the write path.
 * Uncommitted changes are work-in-progress. A commit failure preserves the
 * files exactly and surfaces the precise error — nothing is reset or cleaned.
 * One meaningful update is one commit. A short per-Task lock plus an
 * expected-HEAD check make concurrent saves safe; a conflict STOPS (no
 * overwrite, no auto-merge). Branches/PRs/rebase are never exposed.
 *
 * Artifacts are savable from the Draft stage: this store depends only on the
 * Home, never on an active delivery workspace or Project checkout.
 */

/** The single managed branch. Never surfaced to callers as a Git concept. */
const ARTIFACT_BRANCH = "main";

/** Upper bound for a single artifact file, mirroring the immutable-artifact cap. */
const MAX_ARTIFACT_BYTES = 8 * 1024 * 1024;

/** Raised when an artifact repository has a remote configured — an external violation. */
export class ArtifactRemoteViolationError extends Error {
  readonly taskId: string;
  readonly remotes: readonly string[];
  constructor(taskId: string, remotes: readonly string[]) {
    super(
      `Artifact repository for ${taskId} has an external remote configured (${remotes.join(", ")}); ` +
        `managed writes are stopped. Remove the remote manually to resume.`
    );
    this.name = "ArtifactRemoteViolationError";
    this.taskId = taskId;
    this.remotes = [...remotes];
  }
}

/**
 * Raised when an artifact repository's OWN config declares a filter/alias/tool
 * that would run an external program during add/diff/commit. Env-scrubbing hides
 * ambient config, but a repo's `.git/config` is always read; Yui configures none
 * of these, so any that appear are external tampering. Like a remote: report and
 * STOP managed writes, never silently delete the config.
 */
export class ArtifactManagedConfigViolationError extends Error {
  readonly taskId: string;
  readonly keys: readonly string[];
  constructor(taskId: string, keys: readonly string[]) {
    super(
      `Artifact repository for ${taskId} has repo-local Git config that can run external ` +
        `programs (${keys.join(", ")}); managed writes are stopped. Remove it manually to resume.`
    );
    this.name = "ArtifactManagedConfigViolationError";
    this.taskId = taskId;
    this.keys = [...keys];
  }
}

/** Raised when a save's expected HEAD no longer matches — a concurrent update won. */
export class ArtifactHeadConflictError extends Error {
  readonly taskId: string;
  readonly expectedHead: string;
  readonly actualHead: string;
  readonly retryable = true;
  constructor(taskId: string, expectedHead: string, actualHead: string) {
    super(
      `Artifact repository for ${taskId} advanced since it was read ` +
        `(expected ${expectedHead}, found ${actualHead}); no changes were made. Re-read and retry.`
    );
    this.name = "ArtifactHeadConflictError";
    this.taskId = taskId;
    this.expectedHead = expectedHead;
    this.actualHead = actualHead;
  }
}

/** A single tracked artifact as recorded in the repository at a commit. */
export type ArtifactEntry = Readonly<{
  relativePath: string;
  /** Byte length of the blob at the resolved commit. */
  size: number;
}>;

/** Result of a successful save: the exact commit that now records the change. */
export type ArtifactSaveResult = Readonly<{
  taskId: string;
  commit: string;
  savedPaths: readonly string[];
}>;

/** A read of one artifact pinned to a specific commit. */
export type ArtifactContent = Readonly<{
  relativePath: string;
  commit: string;
  bytes: Buffer;
  /** sha256 of the bytes, hex — for drift checks against a frozen reference. */
  digest: string;
}>;

export type TaskArtifactRepository = Readonly<{
  taskId: string;
  repoPath: string;
  /** Create the repo (idempotent) with an empty root commit, and verify no remote. */
  ensure(): Promise<void>;
  /** True once the repository directory has been initialized. */
  exists(): boolean;
  /** Current HEAD commit, or null when the repo does not yet exist. */
  head(): Promise<string | null>;
  /**
   * Save one or more files as a single commit. Each input is a relativePath and
   * its bytes; the files are written, scoped, and committed atomically as one
   * meaningful update. When `expectedHead` is given and HEAD has advanced, the
   * save STOPS with {@link ArtifactHeadConflictError} and writes nothing.
   */
  save(input: ArtifactSaveInput): Promise<ArtifactSaveResult>;
  /** Read one artifact at HEAD (or at a pinned commit) as bytes + digest. */
  read(relativePath: string, commit?: string): Promise<ArtifactContent>;
  /** List tracked artifacts at HEAD (or at a pinned commit). */
  list(commit?: string): Promise<readonly ArtifactEntry[]>;
  /** Uncommitted (work-in-progress) paths, if any. Empty when the tree is clean. */
  workingChanges(): Promise<readonly string[]>;
}>;

export type ArtifactSaveInput = Readonly<{
  files: ReadonlyArray<Readonly<{ relativePath: string; bytes: Buffer }>>;
  message: string;
  /** When provided, the save aborts unless HEAD equals this commit. */
  expectedHead?: string;
}>;

/**
 * Open (not necessarily create) the artifact repository for a Task. The repo
 * path is derived directly from the Home; call {@link TaskArtifactRepository.ensure}
 * before the first save. `home` MUST be the resolved YUI_HOME
 * (e.g. `store.rootDirectory()`), so ownership is derived from the Task, never
 * from ambient state.
 */
export function openTaskArtifactRepository(home: string, taskId: string): TaskArtifactRepository {
  const repoPath = taskArtifactRepoPath(home, taskId);

  const exists = (): boolean => existsSync(join(repoPath, ".git"));

  const head = async (): Promise<string | null> => {
    if (!exists()) return null;
    return currentHead(repoPath);
  };

  const ensure = async (): Promise<void> => {
    if (exists()) {
      await assertNoRemote(taskId, repoPath);
      return;
    }
    await mkdir(repoPath, { recursive: true, mode: 0o700 });
    await managedGit(repoPath, ["init", "-b", ARTIFACT_BRANCH]);
    // An empty root commit guarantees HEAD exists, so scoped per-path commits
    // and expected-HEAD checks work uniformly from the very first save.
    await managedGit(repoPath, ["commit", "--allow-empty", "-m", "init artifact repo"]);
    await assertNoRemote(taskId, repoPath);
  };

  const save = async (input: ArtifactSaveInput): Promise<ArtifactSaveResult> => {
    if (input.files.length === 0) {
      throw new Error("An artifact save must include at least one file.");
    }
    // Validate the whole request up front (fail-fast): a caller error must never
    // leave half-written files behind. Only genuine Git failures after this
    // point exercise the preserve-on-failure path.
    const message = requireMessage(input.message);
    const prepared = input.files.map((file) => {
      const relativePath = safeRelativeArtifactPath(file.relativePath);
      if (!Buffer.isBuffer(file.bytes)) {
        throw new Error(`Artifact ${relativePath} bytes must be a Buffer.`);
      }
      if (file.bytes.byteLength > MAX_ARTIFACT_BYTES) {
        throw new Error(`Artifact ${relativePath} exceeds the ${MAX_ARTIFACT_BYTES}-byte limit.`);
      }
      return { relativePath, bytes: file.bytes };
    });
    // Reject duplicate targets in one save — ambiguous intent.
    const seen = new Set<string>();
    for (const file of prepared) {
      if (seen.has(file.relativePath)) {
        throw new Error(`Artifact ${file.relativePath} appears more than once in one save.`);
      }
      seen.add(file.relativePath);
    }

    await ensure();
    const release = acquireArtifactCommitLock(home, taskId);
    try {
      await assertNoRemote(taskId, repoPath);
      // Expected-HEAD check under the lock: a conflict stops without writing.
      if (input.expectedHead !== undefined) {
        const actual = await currentHead(repoPath);
        if (actual !== input.expectedHead) {
          throw new ArtifactHeadConflictError(taskId, input.expectedHead, actual);
        }
      }

      // Write files first. A commit failure below preserves exactly these bytes;
      // nothing is reset or cleaned, so a caller can inspect and retry.
      for (const file of prepared) {
        const absolute = await resolveContainedArtifactPath(repoPath, file.relativePath);
        await mkdir(dirname(absolute), { recursive: true, mode: 0o700 });
        await writeFile(absolute, file.bytes, { mode: 0o600 });
      }

      const pathspecs = prepared.map((file) => file.relativePath);
      // Stage exactly the saved paths so new files become known to Git...
      await managedGit(repoPath, ["add", "--", ...pathspecs]);
      // ...but if nothing actually changed, do not create an empty commit.
      const noChanges = await managedGitSucceeds(repoPath, [
        "diff", "--cached", "--quiet", "--", ...pathspecs
      ]);
      if (noChanges) {
        return { taskId, commit: await currentHead(repoPath), savedPaths: pathspecs };
      }
      // `--only <paths>` records exactly these paths; any other WIP stays WIP.
      await managedGit(repoPath, ["commit", "--only", "-m", message, "--", ...pathspecs]);
      return { taskId, commit: await currentHead(repoPath), savedPaths: pathspecs };
    } finally {
      release();
    }
  };

  const read = async (relativePath: string, commit?: string): Promise<ArtifactContent> => {
    const safeRelative = safeRelativeArtifactPath(relativePath);
    // A pinned commit reads frozen evidence; otherwise read the current HEAD.
    // Both resolve `<commit>:<path>`, an OBJECT spec (never the working tree, so
    // a read never follows a symlink or sees unrelated WIP).
    const pinned = commit === undefined ? await currentHead(repoPath) : requireCommitId(commit);
    const objectSpec = `${pinned}:${safeRelative}`;
    // `<commit>:<path>` for a DIRECTORY resolves to a tree, and `git show` would
    // print a tree listing rather than fail — silently returning directory
    // metadata as if it were file bytes. Verify the object is a blob first, so a
    // read only ever yields real file content.
    const objectType = (
      await managedGit(repoPath, ["cat-file", "-t", objectSpec]).catch((error) => {
        if (error instanceof ManagedGitError) {
          throw new Error(`Artifact ${safeRelative} is unavailable at ${pinned}.`, { cause: error });
        }
        throw error;
      })
    ).trim();
    if (objectType !== "blob") {
      throw new Error(`Artifact ${safeRelative} at ${pinned} is not a file (${objectType}).`);
    }
    const bytes = await managedGitBuffer(repoPath, ["cat-file", "blob", objectSpec], {
      maxBuffer: MAX_ARTIFACT_BYTES + 4096
    }).catch((error) => {
      if (error instanceof ManagedGitError) {
        throw new Error(`Artifact ${safeRelative} is unavailable at ${pinned}.`, { cause: error });
      }
      throw error;
    });
    return {
      relativePath: safeRelative,
      commit: pinned,
      bytes,
      digest: createHash("sha256").update(bytes).digest("hex")
    };
  };

  const list = async (commit?: string): Promise<readonly ArtifactEntry[]> => {
    if (!exists()) return [];
    const pinned = commit === undefined ? await currentHead(repoPath) : requireCommitId(commit);
    const output = await managedGit(repoPath, [
      "ls-tree", "-r", "-z", "--long", "--full-tree", pinned
    ]);
    const entries: ArtifactEntry[] = [];
    for (const record of output.split("\0").filter(Boolean)) {
      // Format: "<mode> <type> <object> <size>\t<path>"
      const tab = record.indexOf("\t");
      if (tab < 0) continue;
      const meta = record.slice(0, tab).split(/\s+/u);
      const path = record.slice(tab + 1);
      const size = Number.parseInt(meta[3] ?? "", 10);
      if (path === ".gitignore") continue;
      entries.push({ relativePath: path, size: Number.isFinite(size) ? size : 0 });
    }
    return entries;
  };

  const workingChanges = async (): Promise<readonly string[]> => {
    if (!exists()) return [];
    const output = await managedGit(repoPath, [
      "status", "--porcelain=v1", "--untracked-files=all", "-z"
    ]);
    // Porcelain v1 -z records: "XY <path>\0" (rename adds a second \0 field).
    const changes: string[] = [];
    for (const record of output.split("\0").filter(Boolean)) {
      const path = record.slice(3);
      if (path.length > 0) changes.push(path);
    }
    return changes;
  };

  return { taskId, repoPath, ensure, exists, head, save, read, list, workingChanges };
}

async function currentHead(repoPath: string): Promise<string> {
  return requireCommitId(await managedGit(repoPath, ["rev-parse", "HEAD^{commit}"]));
}

/**
 * Verify the repository is within the managed boundary before a write: NO remote
 * (network or file sync) AND no repo-local config that can execute an external
 * program on add/diff/commit. Both are external violations — we report and stop,
 * never silently remove them.
 */
async function assertNoRemote(taskId: string, repoPath: string): Promise<void> {
  const output = await managedGit(repoPath, ["remote"]);
  const remotes = output.split("\n").map((line) => line.trim()).filter(Boolean);
  if (remotes.length > 0) {
    throw new ArtifactRemoteViolationError(taskId, remotes);
  }
  // A repo's own `.git/config` is read even with global/system config disabled,
  // so a committed `.gitattributes` filter paired with a repo-local
  // `filter.<n>.clean = <cmd>` would run `<cmd>` on `git add`. Detect and stop.
  const configListZ = await managedGit(repoPath, ["config", "--local", "--list", "-z"]);
  const violations = externalProgramConfigViolations(configListZ);
  if (violations.length > 0) {
    throw new ArtifactManagedConfigViolationError(taskId, violations);
  }
}

function requireMessage(message: string): string {
  const trimmed = typeof message === "string" ? message.trim() : "";
  if (trimmed.length === 0) throw new Error("An artifact save requires a commit message.");
  if (trimmed.startsWith("-")) throw new Error("An artifact commit message may not begin with a dash.");
  return trimmed;
}
