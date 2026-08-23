import { execFile } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { lstat, mkdir, realpath, rm } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { promisify } from "node:util";

const executeFile = promisify(execFile);

export type GitRepositoryInspection = Readonly<{
  root: string;
  gitDirectory: string;
  baseRef: string;
  baseCommit: string;
}>;

export type PreparedGitWorktree = Readonly<{
  path: string;
  branch: string;
  baseCommit: string;
}>;

export type GitWorkspaceRemoval = "removed" | "missing" | "dirty";
export type GitWorkspaceState = "missing" | "clean" | "dirty";
export type GitWorkspaceRefresh = Readonly<{
  fromCommit: string;
  toCommit: string;
  changed: boolean;
}>;

/** A remote branch resolved without changing the caller's checkout. */
export type GitRemoteHead = Readonly<{
  branch: string;
  commit: string;
}>;

/** A local remote-tracking branch that matches a configured Project remote. */
export type GitRemoteTrackingRef = Readonly<{
  remoteName: string;
  remoteUrl: string;
  ref: string;
  commit: string;
}>;

type FetchedGitRemoteHead = GitRemoteHead & Readonly<{
  fetchedRef: string;
}>;

/** A remote development baseline fetched into an isolated temporary ref. */
export type GitRemoteBaseline = Readonly<{
  branch: string;
  commit: string;
}>;

/** A remote baseline merge stopped for an explicit Leader resolution. */
export class RemoteBaselineConflictError extends Error {
  readonly affectedPaths: readonly string[];

  constructor(affectedPaths: readonly string[], message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "RemoteBaselineConflictError";
    this.affectedPaths = [...affectedPaths];
  }
}
export interface GitWorkspacePort {
  inspect(repositoryPath: string, baseRef?: string): Promise<GitRepositoryInspection>;
  /**
   * Atomically assert that a ref still points at the expected commit, using
   * `git update-ref` as a compare-and-swap probe (same old and new value).
   * Throws if the ref moved or does not exist.  This is the linearization
   * point for convergence proofs that must not survive a target advance.
   */
  assertRefAt(repositoryPath: string, ref: string, expectedCommit: string): Promise<void>;
  /** Whether a ref (branch, tag, or other refname) resolves to a commit. */
  refExists(repositoryPath: string, ref: string): Promise<boolean>;
  /** Every ref name matching a `git for-each-ref` pattern. */
  listRefs(repositoryPath: string, pattern: string): Promise<string[]>;
  /** Copy selected local refs and their objects into another repository while
   * preserving any existing equal target and rejecting every collision. */
  copyRefs(input: Readonly<{
    sourceRepositoryPath: string;
    destinationRepositoryPath: string;
    patterns: readonly string[];
  }>): Promise<string[]>;
  /**
   * Preserve a ref under the Home-scoped archive namespace (create-not-exists)
   * and delete the original only if it still points at the archived commit.
   */
  archiveRef(input: Readonly<{
    repositoryPath: string;
    sourceRef: string;
    archiveRef: string;
  }>): Promise<void>;
  /**
   * Fail closed when a live worktree of the repository still has `ref`
   * checked out. `archiveRef` deletes the ref with `update-ref -d`, which
   * bypasses git's worktree-occupancy check, so every same-repo worktree on
   * the exact ref must be gone before the ref may be deleted.
   * `excludeWorktreePath` names the recorded worktree the caller removes as
   * part of the same archive flow; prunable (dead) worktree registrations
   * are ignored.
   */
  assertNoForeignWorktreeOnRef(input: Readonly<{
    repositoryPath: string;
    ref: string;
    excludeWorktreePath?: string;
  }>): Promise<void>;
  isAncestor(
    repositoryPath: string,
    ancestor: string,
    descendant: string
  ): Promise<boolean>;
  /** Exact tree object for a commit. Used when commit ancestry is intentionally
   * insufficient and content identity is the safety boundary. */
  resolveTree(repositoryPath: string, commit: string): Promise<string>;
  /** Resolve the local remote-tracking branch for a configured remote URL. */
  inspectRemoteTracking(input: Readonly<{
    repositoryPath: string;
    remoteUrl: string;
    branch: string;
  }>): Promise<GitRemoteTrackingRef | null>;
  /** The common ancestor of two commits. */
  mergeBase(input: Readonly<{
    repositoryPath: string;
    leftCommit: string;
    rightCommit: string;
  }>): Promise<string>;
  /** Every path changed between two commits. */
  changedFilesBetween(input: Readonly<{
    repositoryPath: string;
    fromCommit: string;
    toCommit: string;
  }>): Promise<string[]>;
  /** Issue 07: exact unified diff text between two commits. */
  diffTextBetween(input: Readonly<{
    repositoryPath: string;
    fromCommit: string;
    toCommit: string;
  }>): Promise<string>;
  /** Issue 07: per-file added/deleted line totals between two commits. */
  diffNumstatBetween(input: Readonly<{
    repositoryPath: string;
    fromCommit: string;
    toCommit: string;
  }>): Promise<{ addedLines: number; deletedLines: number }>;
  headRef(repositoryPath: string): Promise<string>;
  isClean(repositoryPath: string): Promise<boolean>;
  mergeWorktree(input: Readonly<{
    targetPath: string;
    sourceRefs: readonly string[];
  }>): Promise<void>;
  resetWorktree(input: Readonly<{
    targetPath: string;
    expectedHead: string;
    restoreHead: string;
  }>): Promise<void>;
  refresh(input: Readonly<{
    repositoryPath: string;
    remoteUrl: string;
    stableRef: string;
  }>): Promise<GitWorkspaceRefresh>;
  /** Optional because older test doubles and non-delivery callers do not
   * participate in Task completion remote reconciliation. */
  mergeRemoteIntoWorktree?(input: Readonly<{
    repositoryPath: string;
    remoteUrl: string;
    branch: string;
  }>): Promise<GitWorkspaceRefresh>;
  fetchRemoteHeadIntoWorktree?(input: Readonly<{
    repositoryPath: string;
    remoteUrl: string;
    branch: string;
  }>): Promise<GitRemoteHead>;
  resolveRemoteBaseline(input: Readonly<{
    repositoryPath: string;
    remoteUrl: string;
    developmentRef: string;
  }>): Promise<GitRemoteBaseline>;
  clone(input: Readonly<{
    remoteUrl: string;
    destination: string;
    branch?: string;
  }>): Promise<GitRepositoryInspection>;
  ensureLocalBranch(
    repositoryPath: string,
    branch: string
  ): Promise<GitRepositoryInspection>;
  ensureWorktree(input: Readonly<{
    repositoryPath: string;
    container: string;
    /** The Task workspace ref segment (`task-N` or `task-N-<8hex>`). */
    taskSegment: string;
    roleName: string;
    baseRef: string;
  }>): Promise<PreparedGitWorktree>;
  inspectWorktree(input: Readonly<{
    repositoryPath: string;
    container: string;
    taskSegment: string;
    roleName: string;
  }>): Promise<GitWorkspaceState>;
  /** Inspect a durable workspace entry after its Project catalog path changed.
   * The worktree is trusted only when its exact branch/head is retained in the
   * current Project repository. */
  inspectRecordedWorktree(input: Readonly<{
    repositoryPath: string;
    container: string;
    path: string;
    branch: string;
    taskSegment: string;
    roleName: string;
  }>): Promise<GitWorkspaceState>;
  removeWorktree(input: Readonly<{
    repositoryPath: string;
    container: string;
    taskSegment: string;
    roleName: string;
    deleteBranch?: boolean;
  }>): Promise<GitWorkspaceRemoval>;
  /** Remove a stranded worktree whose common-dir no longer matches the
   * Project's current repository (e.g. after a catalog switch). Only for
   * unadopted worktrees that are safe to discard. */
  removeStrandedWorktree(path: string): Promise<GitWorkspaceRemoval>;
  /** Remove the exact clean worktree proven by inspectRecordedWorktree. If
   * the Project moved repositories, delete the obsolete source branch only
   * after the same commit is proven retained in the current repository. */
  removeRecordedWorktree(input: Readonly<{
    repositoryPath: string;
    container: string;
    path: string;
    branch: string;
    retainedRef: string;
    taskSegment: string;
    roleName: string;
  }>): Promise<GitWorkspaceRemoval>;
  ensureIntegrationWorktree(input: Readonly<{
    repositoryPath: string;
    container: string;
    taskSegment: string;
    integrationId: string;
    baseRef: string;
  }>): Promise<PreparedGitWorktree>;
  removeIntegrationWorktree(input: Readonly<{
    repositoryPath: string;
    container: string;
    taskSegment: string;
    integrationId: string;
    discardChanges?: boolean;
  }>): Promise<GitWorkspaceRemoval>;
}

/** The small Git boundary used by project registration and Task workspaces. */
export class NodeGitWorkspace implements GitWorkspacePort {
  async resolveTree(repositoryPath: string, commit: string): Promise<string> {
    return gitLine([
      "-C", repositoryPath,
      "rev-parse", "--verify", "--end-of-options", `${commit}^{tree}`
    ]);
  }

  async findCommitWithSameTreeInHistory(input: Readonly<{
    repositoryPath: string;
    sourceCommit: string;
    historyHead: string;
  }>): Promise<string | null> {
    const source = (await this.inspect(input.repositoryPath, input.sourceCommit)).baseCommit;
    const history = (await this.inspect(input.repositoryPath, input.historyHead)).baseCommit;
    if (await this.isAncestor(input.repositoryPath, source, history)) return source;
    const sourceTree = await this.resolveTree(input.repositoryPath, source);
    const pageSize = 1000;
    for (let skip = 0; ; skip += pageSize) {
      const output = await git([
        "-C", input.repositoryPath,
        "log", `--max-count=${pageSize}`, `--skip=${skip}`,
        "--format=%H%x09%T", history
      ]);
      const lines = output.trimEnd().split("\n").filter(Boolean);
      for (const line of lines) {
        const [commit, tree, ...extra] = line.split("\t");
        if (extra.length > 0 || commit === undefined || tree === undefined) {
          throw new Error("Git returned invalid publication history.");
        }
        if (tree === sourceTree) return commit;
      }
      if (lines.length < pageSize) return null;
    }
  }

  /**
   * Whether two commits hold the same tree content on the given paths.
   * An enqueued ChangeSet whose head agrees with the target on every path
   * it touched is already represented there and converges without a new
   * commit, even when other unrelated changes landed in between.
   *
   * The captured paths are literal filenames, so `--literal-pathspecs`
   * disables pathspec magic: a name such as `:(exclude)*` must not exclude
   * every path and fake a converged tree.  It is a global option and
   * therefore must precede the `diff` subcommand.
   */
  async treesAgreeOnPaths(input: Readonly<{
    repositoryPath: string;
    leftCommit: string;
    rightCommit: string;
    paths: readonly string[];
  }>): Promise<boolean> {
    if (input.paths.length === 0) return false;
    return gitSucceeds([
      "-C", input.repositoryPath,
      "--literal-pathspecs",
      "diff", "--quiet",
      input.leftCommit, input.rightCommit,
      "--", ...input.paths
    ]);
  }

  /**
   * Every path changed between two commits.  The integration queue uses this
   * to fence a validated entry: a target advance whose real path delta
   * overlaps the entry's own paths (or whose impact cannot be proven)
   * invalidates the entry's reusable evidence.
   */
  async changedFilesBetween(input: Readonly<{
    repositoryPath: string;
    fromCommit: string;
    toCommit: string;
  }>): Promise<string[]> {
    const output = await git([
      "-C", input.repositoryPath,
      "diff", "--name-only",
      input.fromCommit, input.toCommit
    ]);
    return output.split("\n").map((line) => line.trim()).filter((line) => line.length > 0);
  }

  /** Issue 07: exact unified diff text between two commits. */
  async diffTextBetween(input: Readonly<{
    repositoryPath: string;
    fromCommit: string;
    toCommit: string;
  }>): Promise<string> {
    return git([
      "-C", input.repositoryPath,
      "diff", "--no-color", "--no-ext-diff",
      input.fromCommit, input.toCommit
    ]);
  }

  /** Issue 07: sums `git diff --numstat` added/deleted lines. */
  async diffNumstatBetween(input: Readonly<{
    repositoryPath: string;
    fromCommit: string;
    toCommit: string;
  }>): Promise<{ addedLines: number; deletedLines: number }> {
    const output = await git([
      "-C", input.repositoryPath,
      "diff", "--numstat",
      input.fromCommit, input.toCommit
    ]);
    let addedLines = 0;
    let deletedLines = 0;
    for (const line of output.split("\n")) {
      const trimmed = line.trim();
      if (trimmed.length === 0) continue;
      const [added, deleted] = trimmed.split("\t");
      // Binary files report "-" for both counts; they change the tree and
      // must not be treated as zero-line edits.
      if (added === "-" || deleted === "-") {
        throw new Error("Delta recheck cannot assess a binary diff.");
      }
      const addedCount = Number(added);
      const deletedCount = Number(deleted);
      if (!Number.isInteger(addedCount) || !Number.isInteger(deletedCount)
        || addedCount < 0 || deletedCount < 0) {
        throw new Error("Git returned invalid numstat output.");
      }
      addedLines += addedCount;
      deletedLines += deletedCount;
    }
    return { addedLines, deletedLines };
  }

  /**
   * Files deleted between two commits.  Uses `--diff-filter=D` so a rename
   * reports its source path here (and its destination in `changedFilesBetween`),
   * letting the containment proof verify both sides of a rename.
   */
  async deletedFilesBetween(input: Readonly<{
    repositoryPath: string;
    fromCommit: string;
    toCommit: string;
  }>): Promise<string[]> {
    const output = await git([
      "-C", input.repositoryPath,
      "diff", "--name-only", "--diff-filter=D", "--no-renames",
      input.fromCommit, input.toCommit
    ]);
    return output.split("\n").map((line) => line.trim()).filter((line) => line.length > 0);
  }

  /**
   * Resolve the configured Project branch directly from its remote.  This is
   * deliberately read-only: unlike `refresh`, it never advances the stable
   * Project checkout or changes its refs.
   */
  async resolveRemoteHead(input: Readonly<{
    remoteUrl: string;
    branch: string;
  }>): Promise<GitRemoteHead> {
    const remote = safeRemote(input.remoteUrl);
    const configuredBranch = await safeFetchBranch(input.branch);
    const branch = configuredBranch === "HEAD"
      ? await resolveRemoteHeadBranch(remote)
      : configuredBranch;
    const commit = await resolveRemoteBranchCommit(remote, branch);
    return { branch, commit };
  }

  /**
   * Merge a remote Project baseline into a clean, managed worktree.  The
   * fetch is performed from that worktree and the stable checkout is never
   * touched.  Fast-forward updates are preferred; a diverged baseline gets a
   * deterministic merge commit so the caller can run its normal Integration
   * checks and CAS the target ref.
   */
  async mergeRemoteIntoWorktree(input: Readonly<{
    repositoryPath: string;
    remoteUrl: string;
    branch: string;
  }>): Promise<GitWorkspaceRefresh> {
    const initial = await this.inspect(input.repositoryPath, "HEAD");
    if (!await this.isClean(initial.root)) {
      throw new Error("Managed Task/Integration worktree must be clean before remote merge.");
    }
    const fetched = await this.#fetchRemoteHeadIntoWorktree(input);
    const fetchedCommit = fetched.commit;
    const fetchedRef = fetched.fetchedRef;
    try {
      if (fetchedCommit === initial.baseCommit) {
        return { fromCommit: initial.baseCommit, toCommit: fetchedCommit, changed: false };
      }
      if (await gitSucceeds([
        "-C", initial.root,
        "merge-base", "--is-ancestor", fetchedCommit, initial.baseCommit
      ])) {
        // The Task already contains the current remote baseline.
        return { fromCommit: initial.baseCommit, toCommit: initial.baseCommit, changed: false };
      }
      if (await gitSucceeds([
        "-C", initial.root,
        "merge-base", "--is-ancestor", initial.baseCommit, fetchedCommit
      ])) {
        await git(["-C", initial.root, "merge", "--ff-only", "--no-edit", fetchedRef]);
      } else {
        try {
          await git([
            "-C", initial.root,
            "-c", "user.name=Yui",
            "-c", "user.email=yui@local",
            "merge", "--no-edit", "--no-ff", fetchedRef
          ]);
        } catch (error) {
          const affected = (await git([
            "-C", initial.root,
            "diff", "--name-only", "--diff-filter=U"
          ])).trim().split("\n").filter(Boolean);
          const suffix = affected.length === 0 ? "" : ` (${affected.join(", ")})`;
          throw new RemoteBaselineConflictError(
            affected,
            `Remote baseline merge conflicts in managed worktree${suffix}; resolve it in the Integration workspace.`,
            { cause: error }
          );
        }
      }
      const mergedCommit = (await gitLine([
        "-C", initial.root,
        "rev-parse", "--verify", "--end-of-options", "HEAD^{commit}"
      ])).toLowerCase();
      if (!await this.isClean(initial.root)) {
        throw new Error("Remote baseline merge left the managed worktree dirty.");
      }
      return { fromCommit: initial.baseCommit, toCommit: mergedCommit, changed: true };
    } finally {
      await gitSucceeds(["-C", initial.root, "update-ref", "-d", fetchedRef]);
    }
  }

  /** Fetch a remote branch into a managed worktree without changing HEAD. */
  async fetchRemoteHeadIntoWorktree(input: Readonly<{
    repositoryPath: string;
    remoteUrl: string;
    branch: string;
  }>): Promise<GitRemoteHead> {
    const fetched = await this.#fetchRemoteHeadIntoWorktree(input);
    try {
      return { branch: fetched.branch, commit: fetched.commit };
    } finally {
      await gitSucceeds(["-C", input.repositoryPath, "update-ref", "-d", fetched.fetchedRef]);
    }
  }

  async #fetchRemoteHeadIntoWorktree(input: Readonly<{
    repositoryPath: string;
    remoteUrl: string;
    branch: string;
  }>): Promise<FetchedGitRemoteHead> {
    const repositoryPath = (await this.inspect(input.repositoryPath, "HEAD")).root;
    const remote = safeRemote(input.remoteUrl);
    const configuredBranch = await safeFetchBranch(input.branch);
    const branch = configuredBranch === "HEAD"
      ? await resolveRemoteHeadBranch(remote)
      : configuredBranch;
    const fetchedRef = remoteBaselineRef(remote, branch);
    try {
      await git([
        "-C", repositoryPath,
        "fetch", "--no-tags", "--no-write-fetch-head",
        remote,
        `refs/heads/${branch}:${fetchedRef}`
      ]);
      const commit = await resolveFetchedCommit(repositoryPath, fetchedRef);
      return { branch, commit, fetchedRef };
    } catch (error) {
      await gitSucceeds(["-C", repositoryPath, "update-ref", "-d", fetchedRef]);
      throw error;
    }
  }

  async refresh(input: Readonly<{
    repositoryPath: string;
    remoteUrl: string;
    stableRef: string;
  }>): Promise<GitWorkspaceRefresh> {
    const remote = safeRemote(input.remoteUrl);
    const configuredStableRef = await safeFetchBranch(input.stableRef);
    const initial = await this.inspect(input.repositoryPath, "HEAD");
    await this.#assertRefreshCheckout(
      initial.root,
      configuredStableRef,
      initial.baseCommit
    );
    const stableBranch = configuredStableRef === "HEAD"
      ? await resolveRemoteHeadBranch(remote)
      : configuredStableRef;
    if (stableBranch !== configuredStableRef) {
      await this.#assertRefreshCheckout(initial.root, stableBranch, initial.baseCommit);
    }

    const stableRemoteRef = `refs/heads/${stableBranch}`;
    await git(["-C", initial.root, "fetch", "--no-tags", remote, stableRemoteRef]);
    const fetchedCommit = (await gitLine([
      "-C", initial.root,
      "rev-parse", "--verify", "--end-of-options", "FETCH_HEAD^{commit}"
    ])).toLowerCase();

    // The advertised SHA must match what was fetched. A network race, a ref
    // that moved mid-fetch, or any inconsistency fails closed: the stable
    // checkout is never advanced to an unverified commit.
    const advertisedCommit = await resolveRemoteBranchCommit(remote, stableBranch);
    if (fetchedCommit !== advertisedCommit) {
      throw new Error(
        `Project remote stable branch changed while it was fetched: ${stableBranch}.`
      );
    }

    await this.#assertRefreshCheckout(initial.root, stableBranch, initial.baseCommit);
    if (fetchedCommit === initial.baseCommit) {
      return {
        fromCommit: initial.baseCommit,
        toCommit: fetchedCommit,
        changed: false
      };
    }
    if (!await gitSucceeds([
      "-C", initial.root,
      "merge-base", "--is-ancestor", initial.baseCommit, fetchedCommit
    ])) {
      throw new Error(
        `Project checkout cannot be fast-forwarded from ${initial.baseCommit} to ${fetchedCommit}.`
      );
    }

    await git([
      "-C", initial.root,
      "merge", "--ff-only", "--no-edit", fetchedCommit
    ]);
    await this.#assertRefreshCheckout(initial.root, stableBranch, fetchedCommit);
    return {
      fromCommit: initial.baseCommit,
      toCommit: fetchedCommit,
      changed: true
    };
  }

  /**
   * Fetch a Project's configured development branch into a temporary ref and
   * return the commit confirmed by that fetch.  The stable checkout is only
   * inspected; it is never checked out, reset, rebased, or fast-forwarded.
   */
  async resolveRemoteBaseline(input: Readonly<{
    repositoryPath: string;
    remoteUrl: string;
    developmentRef: string;
  }>): Promise<GitRemoteBaseline> {
    const remote = safeRemote(input.remoteUrl);
    const configuredRef = await safeFetchBranch(input.developmentRef);
    const branch = configuredRef === "HEAD"
      ? await resolveRemoteHeadBranch(remote)
      : configuredRef;
    const repository = await this.inspect(input.repositoryPath, "HEAD");
    const temporaryRef = remoteBaselineRef(remote, branch);
    try {
      await git([
        "-C", repository.root,
        "fetch", "--no-tags", "--no-write-fetch-head",
        remote,
        `refs/heads/${branch}:${temporaryRef}`
      ]);
      const fetchedCommit = await gitLine([
        "-C", repository.root,
        "rev-parse", "--verify", "--end-of-options", `${temporaryRef}^{commit}`
      ]);
      const advertisedCommit = await resolveRemoteBranchCommit(remote, branch);
      if (fetchedCommit.toLowerCase() !== advertisedCommit) {
        throw new Error(
          `Project remote development branch changed while it was fetched: ${branch}.`
        );
      }
      return {
        branch,
        commit: fetchedCommit.toLowerCase()
      };
    } finally {
      // A temporary namespace keeps the fetch independent from the stable
      // branch and FETCH_HEAD.  Cleanup is best effort so the original fetch
      // or consistency error remains the actionable diagnosis.
      await gitSucceeds([
        "-C", repository.root,
        "update-ref", "-d", temporaryRef
      ]);
    }
  }

  async clone(input: Readonly<{
    remoteUrl: string;
    destination: string;
    branch?: string;
  }>): Promise<GitRepositoryInspection> {
    const remote = safeRemote(input.remoteUrl);
    const destination = resolve(requireText(input.destination, "Project destination"));
    if (await pathKind(destination) !== undefined) {
      throw new Error(`Project destination already exists: ${destination}.`);
    }
    await canonicalContainer(dirname(destination), true);
    const branch = input.branch === undefined ? undefined : safeRef(input.branch);
    try {
      await git([
        "clone",
        ...(branch === undefined ? [] : ["--branch", branch]),
        "--",
        remote,
        destination
      ]);
    } catch (error) {
      await rm(destination, { recursive: true, force: true });
      throw error;
    }
    return this.inspect(destination, "HEAD");
  }

  async ensureLocalBranch(
    repositoryPath: string,
    branch: string
  ): Promise<GitRepositoryInspection> {
    try {
      return await this.inspect(repositoryPath, branch);
    } catch (originalError) {
      const root = (await this.inspect(repositoryPath, "HEAD")).root;
      const name = safeRef(branch);
      if (!await gitSucceeds(["check-ref-format", "--branch", name])) throw originalError;
      const remoteRef = `refs/remotes/origin/${name}`;
      if (!await gitSucceeds([
        "-C", root, "show-ref", "--verify", "--quiet", remoteRef
      ])) throw originalError;
      await git(["-C", root, "branch", "--", name, remoteRef]);
      return this.inspect(root, name);
    }
  }

  async inspect(repositoryPath: string, baseRef = "HEAD"): Promise<GitRepositoryInspection> {
    const requested = await canonicalDirectory(repositoryPath, "Project");
    const ref = safeRef(baseRef);
    const root = await canonicalDirectory(
      await gitLine(["-C", requested, "rev-parse", "--show-toplevel"]),
      "Project root"
    );
    const gitDirectory = await canonicalDirectory(
      await gitLine([
        "-C", root, "rev-parse", "--path-format=absolute", "--git-common-dir"
      ]),
      "Git common directory"
    );
    const baseCommit = await gitLine([
      "-C", root, "rev-parse", "--verify", "--end-of-options", `${ref}^{commit}`
    ]);
    if (!/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/i.test(baseCommit)) {
      throw new Error("Git returned an invalid base commit.");
    }
    return {
      root,
      gitDirectory,
      baseRef: ref,
      baseCommit: baseCommit.toLowerCase()
    };
  }

  async assertRefAt(
    repositoryPath: string,
    ref: string,
    expectedCommit: string
  ): Promise<void> {
    const root = (await this.inspect(repositoryPath)).root;
    // `git update-ref <ref> <new> <old>` is atomic: it succeeds only when the
    // ref still points at <old>.  Using the same commit for both new and old
    // makes it a pure compare-and-swap probe — the ref does not move, but a
    // concurrent advance between the last read and this call is detected.
    await git([
      "-C", root, "update-ref",
      safeRef(ref),
      expectedCommit,
      expectedCommit
    ]);
  }

  async refExists(repositoryPath: string, ref: string): Promise<boolean> {
    const root = (await this.inspect(repositoryPath)).root;
    return gitSucceeds([
      "-C", root, "rev-parse", "--verify", "--quiet", "--end-of-options",
      `${safeRef(ref)}^{commit}`
    ]);
  }

  async listRefs(repositoryPath: string, pattern: string): Promise<string[]> {
    const root = (await this.inspect(repositoryPath)).root;
    const output = await git([
      "-C", root, "for-each-ref", "--format=%(refname)", "--", safeRef(pattern)
    ]);
    return output.length === 0 ? [] : output.split("\n").map((line) => line.trim())
      .filter((line) => line.length > 0);
  }

  async copyRefs(input: Readonly<{
    sourceRepositoryPath: string;
    destinationRepositoryPath: string;
    patterns: readonly string[];
  }>): Promise<string[]> {
    const source = await this.inspect(input.sourceRepositoryPath);
    const destination = await this.inspect(input.destinationRepositoryPath);
    if (source.gitDirectory === destination.gitDirectory) return [];

    const refs = [...new Set((await Promise.all(
      input.patterns.map((pattern) => this.listRefs(source.root, pattern))
    )).flat())].sort();
    const snapshots = [];
    for (const ref of refs) {
      const name = safeRef(ref);
      const commit = await resolveRefCommit(source.root, name);
      if (await this.refExists(destination.root, name)) {
        const existing = await resolveRefCommit(destination.root, name);
        if (existing !== commit) {
          throw new Error(`Destination ref already exists at a different commit: ${name}.`);
        }
      }
      snapshots.push({ ref: name, commit });
    }

    const importRoot = `refs/yui/migration-import/${randomBytes(16).toString("hex")}`;
    const temporary: Array<Readonly<{ ref: string; commit: string }>> = [];
    try {
      for (const [index, snapshot] of snapshots.entries()) {
        const importedRef = `${importRoot}/${index}`;
        await git([
          "-C", destination.root,
          "fetch", "--no-tags", "--no-write-fetch-head", "--",
          source.root, `${snapshot.ref}:${importedRef}`
        ]);
        const imported = await resolveRefCommit(destination.root, importedRef);
        if (imported !== snapshot.commit) {
          throw new Error(`Imported ref did not preserve its exact commit: ${snapshot.ref}.`);
        }
        temporary.push({ ref: importedRef, commit: imported });
      }

      // Freeze the source snapshots through publication. A moving local ref is
      // never silently copied under an earlier/later identity.
      for (const snapshot of snapshots) {
        if (await resolveRefCommit(source.root, snapshot.ref) !== snapshot.commit) {
          throw new Error(`Source ref changed while it was being copied: ${snapshot.ref}.`);
        }
      }
      for (const snapshot of snapshots) {
        if (await this.refExists(destination.root, snapshot.ref)) {
          if (await resolveRefCommit(destination.root, snapshot.ref) !== snapshot.commit) {
            throw new Error(
              `Destination ref changed while it was being copied: ${snapshot.ref}.`
            );
          }
          continue;
        }
        await git([
          "-C", destination.root,
          "update-ref", "--no-deref", snapshot.ref, snapshot.commit,
          "0".repeat(snapshot.commit.length)
        ]);
      }
      return snapshots.map(({ ref }) => ref);
    } finally {
      for (const entry of temporary) {
        if (await this.refExists(destination.root, entry.ref)) {
          await git([
            "-C", destination.root,
            "update-ref", "-d", "--no-deref", entry.ref, entry.commit
          ]);
        }
      }
    }
  }

  async archiveRef(input: Readonly<{
    repositoryPath: string;
    sourceRef: string;
    archiveRef: string;
  }>): Promise<void> {
    const root = (await this.inspect(input.repositoryPath)).root;
    const source = safeRef(input.sourceRef);
    const target = safeRef(input.archiveRef);
    const commit = (await gitLine([
      "-C", root, "rev-parse", "--verify", "--end-of-options", `${source}^{commit}`
    ])).toLowerCase();
    if (await this.refExists(root, target)) {
      // Resumable: a previous attempt already created the archive ref. Only
      // the same commit may be resumed; a different archive fails closed.
      const archived = (await gitLine([
        "-C", root, "rev-parse", "--verify", "--end-of-options", `${target}^{commit}`
      ])).toLowerCase();
      if (archived !== commit) {
        throw new Error(
          `Archive ref already exists at a different commit: ${target}.`
        );
      }
    } else {
      // Create the archive ref only if it does not exist yet (old value zero).
      await git([
        "-C", root, "update-ref", "--no-deref", target, commit, "0".repeat(commit.length)
      ]);
    }
    // Delete the source only if it still exists and still points at the
    // archived commit; an already-deleted source makes the archive a no-op.
    if (await this.refExists(root, source)) {
      await git([
        "-C", root, "update-ref", "-d", "--no-deref", source, commit
      ]);
    }
  }

  async assertNoForeignWorktreeOnRef(input: Readonly<{
    repositoryPath: string;
    ref: string;
    excludeWorktreePath?: string;
  }>): Promise<void> {
    const root = (await this.inspect(input.repositoryPath)).root;
    const wanted = safeRef(input.ref);
    // The recorded worktree is removed in the same archive flow; it is the
    // only same-repo worktree on the ref that may stay for now. A path that
    // no longer exists cannot match a live worktree.
    const excluded = input.excludeWorktreePath === undefined
      ? undefined
      : await realpath(resolve(input.excludeWorktreePath)).catch(() => undefined);
    const porcelain = await git(["-C", root, "worktree", "list", "--porcelain"]);
    const records: Array<{ path: string; branch?: string; prunable: boolean }> = [];
    let current: { path?: string; branch?: string; prunable: boolean } = { prunable: false };
    for (const line of porcelain.split("\n")) {
      if (line.length === 0) {
        const path = current.path;
        if (path !== undefined) {
          records.push({ path, branch: current.branch, prunable: current.prunable });
        }
        current = { prunable: false };
        continue;
      }
      if (line.startsWith("worktree ")) {
        current.path = line.slice("worktree ".length);
      } else if (line.startsWith("branch ")) {
        current.branch = line.slice("branch ".length);
      } else if (line.startsWith("prunable")) {
        current.prunable = true;
      }
    }
    const lastPath = current.path;
    if (lastPath !== undefined) {
      records.push({ path: lastPath, branch: current.branch, prunable: current.prunable });
    }
    for (const record of records) {
      // A dead registration (its directory is gone) occupies nothing; a
      // worktree on another ref or a detached HEAD does not occupy this one.
      if (record.prunable || record.branch !== wanted) continue;
      // git reports canonical absolute paths; compare canonicals so a
      // symlinked workspace root cannot make the recorded worktree look
      // foreign.
      const canonical = await realpath(record.path).catch(() => record.path);
      if (canonical === excluded) continue;
      throw new Error(
        `Ref ${wanted} is checked out by a worktree outside this Home's management ` +
        `(${record.path}); the archive refuses to delete the ref and strand that worktree.`
      );
    }
  }

  async isAncestor(
    repositoryPath: string,
    ancestor: string,
    descendant: string
  ): Promise<boolean> {
    const root = (await this.inspect(repositoryPath)).root;
    return gitSucceeds([
      "-C", root,
      "merge-base", "--is-ancestor",
      safeRef(ancestor),
      safeRef(descendant)
    ]);
  }

  async inspectRemoteTracking(input: Readonly<{
    repositoryPath: string;
    remoteUrl: string;
    branch: string;
  }>): Promise<GitRemoteTrackingRef | null> {
    const root = (await this.inspect(input.repositoryPath)).root;
    const wantedUrl = requireText(input.remoteUrl, "Project remote URL");
    let output: string;
    try {
      output = await git([
        "-C", root,
        "config", "--get-regexp", "--null",
        "^remote\\..*\\.url$"
      ]);
    } catch {
      return null;
    }
    const records = output.split("\0").filter((record) => record.length > 0);
    const matches: Array<Readonly<{ remoteName: string; url: string }>> = [];
    for (const record of records) {
      const separator = record.indexOf("\n");
      if (separator < 0) continue;
      const key = record.slice(0, separator).trim();
      const url = record.slice(separator + 1).trim();
      const prefix = "remote.";
      const suffix = ".url";
      if (!key.startsWith(prefix) || !key.endsWith(suffix) || url !== wantedUrl) continue;
      matches.push({ remoteName: key.slice(prefix.length, -suffix.length), url });
    }
    if (matches.length !== 1) return null;
    const remoteName = requireText(matches[0]!.remoteName, "Git remote name");
    const branch = await safeFetchBranch(input.branch);
    const ref = `refs/remotes/${remoteName}/${branch}`;
    if (!await gitSucceeds(["check-ref-format", ref])) {
      throw new Error("Git remote tracking ref is invalid.");
    }
    if (!await this.refExists(root, ref)) return null;
    return {
      remoteName,
      remoteUrl: matches[0]!.url,
      ref,
      commit: (await this.inspect(root, ref)).baseCommit
    };
  }

  async mergeBase(input: Readonly<{
    repositoryPath: string;
    leftCommit: string;
    rightCommit: string;
  }>): Promise<string> {
    const root = (await this.inspect(input.repositoryPath)).root;
    return gitLine([
      "-C", root,
      "merge-base",
      safeRef(input.leftCommit),
      safeRef(input.rightCommit)
    ]);
  }

  async headRef(repositoryPath: string): Promise<string> {
    const requested = await canonicalDirectory(repositoryPath, "Project");
    return gitLine(["-C", requested, "rev-parse", "--abbrev-ref", "HEAD"]);
  }

  async isClean(repositoryPath: string): Promise<boolean> {
    const root = (await this.inspect(repositoryPath)).root;
    const status = await git([
      "-C", root, "status", "--porcelain=v1", "--untracked-files=all"
    ]);
    return status.length === 0;
  }

  async mergeWorktree(input: Readonly<{
    targetPath: string;
    sourceRefs: readonly string[];
  }>): Promise<void> {
    const target = await canonicalDirectory(input.targetPath, "Merge target");
    const sources = input.sourceRefs.map((source) => safeRef(source));
    if (sources.length === 0) {
      throw new Error(`Git merge requires at least one source ref: ${target}.`);
    }
    if (!await this.isClean(target)) {
      throw new Error(`Git merge target must be clean: ${target}.`);
    }
    try {
      // Merge all selected Lane heads in one Git transaction.  A conflict in
      // any Lane therefore aborts the complete Candidate materialization
      // instead of leaving an earlier Lane merged into the WorkItem target.
      await git(["-C", target, "merge", "--no-edit", "--no-ff", ...sources]);
    } catch (error) {
      try {
        await git(["-C", target, "merge", "--abort"]);
      } catch (abortError) {
        throw new Error(
          `Git merge failed and conflict cleanup could not be completed for ${target}.`,
          { cause: abortError }
        );
      }
      throw new Error(
        `Git merge failed for ${target} from ${sources.join(", ")}; Candidate materialization was not completed.`,
        { cause: error }
      );
    }
  }

  async resetWorktree(input: Readonly<{
    targetPath: string;
    expectedHead: string;
    restoreHead: string;
  }>): Promise<void> {
    const target = await canonicalDirectory(input.targetPath, "Reset target");
    const expectedHead = safeRef(input.expectedHead);
    const restoreHead = safeRef(input.restoreHead);
    if (!await this.isClean(target)) {
      throw new Error(`Git reset target must be clean: ${target}.`);
    }
    const currentHead = (await this.inspect(target, "HEAD")).baseCommit;
    if (currentHead !== expectedHead) {
      throw new Error(
        `Git reset target changed before compensation: ${target} (${currentHead}).`
      );
    }
    try {
      await git(["-C", target, "reset", "--hard", restoreHead]);
      const restoredHead = (await this.inspect(target, "HEAD")).baseCommit;
      if (restoredHead !== restoreHead || !await this.isClean(target)) {
        throw new Error(`Git reset target did not restore its exact head: ${target}.`);
      }
    } catch (error) {
      throw new Error(
        `Git reset compensation failed for ${target}; Candidate materialization remains retained for diagnosis.`,
        { cause: error }
      );
    }
  }

  async #assertRefreshCheckout(
    repositoryPath: string,
    stableRef: string,
    expectedCommit: string
  ): Promise<void> {
    if (stableRef !== "HEAD") {
      const currentBranch = await this.headRef(repositoryPath);
      if (currentBranch !== stableRef) {
        const found = currentBranch === "HEAD" ? "detached HEAD" : currentBranch;
        throw new Error(
          `Project checkout must be on its stable branch: expected ${stableRef}, found ${found}.`
        );
      }
    }
    const head = await this.inspect(repositoryPath, "HEAD");
    if (head.baseCommit !== expectedCommit) {
      throw new Error("Project checkout changed while it was being refreshed.");
    }
    if (!await this.isClean(head.root)) {
      throw new Error("Project checkout must be clean before it can be refreshed.");
    }
  }

  async ensureWorktree(input: Readonly<{
    repositoryPath: string;
    container: string;
    taskSegment: string;
    roleName: string;
    baseRef: string;
  }>): Promise<PreparedGitWorktree> {
    return this.#ensureManagedWorktree({
      repositoryPath: input.repositoryPath,
      container: input.container,
      identity: worktreeIdentity(input.taskSegment, input.roleName),
      baseRef: input.baseRef
    });
  }

  async ensureIntegrationWorktree(input: Readonly<{
    repositoryPath: string;
    container: string;
    taskSegment: string;
    integrationId: string;
    baseRef: string;
  }>): Promise<PreparedGitWorktree> {
    return this.#ensureManagedWorktree({
      repositoryPath: input.repositoryPath,
      container: input.container,
      identity: integrationWorktreeIdentity(input.taskSegment, input.integrationId),
      baseRef: input.baseRef
    });
  }

  async #ensureManagedWorktree(input: Readonly<{
    repositoryPath: string;
    container: string;
    identity: Readonly<{ directory: string; branch: string }>;
    baseRef: string;
  }>): Promise<PreparedGitWorktree> {
    const container = await canonicalContainer(input.container, true);
    const identity = input.identity;
    const path = managedPath(container, identity.directory);
    const kind = await pathKind(path);
    if (kind === "symlink") throw new Error("Managed worktree path must not be a symbolic link.");

    if (kind === "directory") {
      // A worktree already created before a crash remains usable even if the
      // original base branch/tag is later deleted.
      const project = await this.inspect(input.repositoryPath);
      await assertOwnedWorktree(project, container, path);
      await assertExpectedBranch(path, identity.branch);
      const head = await gitLine([
        "-C", path, "rev-parse", "--verify", "--end-of-options", "HEAD^{commit}"
      ]);
      return { path, branch: identity.branch, baseCommit: head.toLowerCase() };
    }

    const project = await this.inspect(input.repositoryPath, input.baseRef);
    await canonicalContainer(dirname(path), true);

    const branchRef = `refs/heads/${identity.branch}`;
    const branchExists = await gitSucceeds([
      "-C", project.root, "show-ref", "--verify", "--quiet", branchRef
    ]);
    await git(branchExists
      ? ["-C", project.root, "worktree", "add", "--", path, identity.branch]
      : [
          "-C", project.root, "worktree", "add", "-b", identity.branch,
          "--", path, project.baseCommit
        ]);

    await assertOwnedWorktree(project, container, path);
    await assertExpectedBranch(path, identity.branch);
    const head = await gitLine([
      "-C", path, "rev-parse", "--verify", "--end-of-options", "HEAD^{commit}"
    ]);
    return { path, branch: identity.branch, baseCommit: head.toLowerCase() };
  }

  async removeWorktree(input: Readonly<{
    repositoryPath: string;
    container: string;
    taskSegment: string;
    roleName: string;
    deleteBranch?: boolean;
  }>): Promise<GitWorkspaceRemoval> {
    const state = await this.inspectWorktree(input);
    if (state === "dirty") return state;
    const container = resolve(input.container);
    const identity = worktreeIdentity(input.taskSegment, input.roleName);
    const path = managedPath(container, identity.directory);
    const project = await this.inspect(input.repositoryPath);
    if (state === "missing") {
      if (input.deleteBranch === true) {
        await git(["-C", project.root, "worktree", "prune"]);
        await deleteBranchIfPresent(project.root, identity.branch);
      }
      return state;
    }
    await git(["-C", project.root, "worktree", "remove", "--", path]);
    if (input.deleteBranch === true) {
      await deleteBranchIfPresent(project.root, identity.branch);
    }
    return "removed";
  }

  /**
   * Remove a stranded worktree whose Git common-dir no longer matches the
   * Project's current repository (e.g. after a `project migrate` switched the
   * catalog). The normal {@link removeWorktree} path rejects such worktrees
   * via `assertOwnedWorktree`; this fallback inspects and removes through the
   * worktree's own Git identity instead. Only call for unadopted worktrees
   * that are safe to discard (e.g. Lane preparation compensation).
   */
  async removeStrandedWorktree(path: string): Promise<GitWorkspaceRemoval> {
    const kind = await pathKind(path);
    if (kind === undefined) return "missing";
    if (kind === "symlink") throw new Error("Stranded worktree path must not be a symbolic link.");
    // Inspect dirty state through the worktree's own Git, bypassing the
    // Project ownership check that fails after a catalog switch.
    const porcelain = await git(["-C", path, "status", "--porcelain=v1", "--untracked-files=all"]);
    if (porcelain.length > 0) return "dirty";
    try {
      await git(["-C", path, "worktree", "remove", "--force", "--", path]);
    } catch {
      // The worktree's common-dir (old external repo) may itself be gone.
      // Remove the directory directly; the worktree is unadopted.
      await rm(path, { recursive: true, force: true });
    }
    return "removed";
  }

  async inspectRecordedWorktree(input: Readonly<{
    repositoryPath: string;
    container: string;
    path: string;
    branch: string;
    taskSegment: string;
    roleName: string;
  }>): Promise<GitWorkspaceState> {
    const inspected = await inspectExactRecordedWorktree(input);
    return inspected?.state ?? "missing";
  }

  async removeRecordedWorktree(input: Readonly<{
    repositoryPath: string;
    container: string;
    path: string;
    branch: string;
    retainedRef: string;
    taskSegment: string;
    roleName: string;
  }>): Promise<GitWorkspaceRemoval> {
    let inspected: ExactRecordedWorktree | undefined;
    try {
      inspected = await inspectExactRecordedWorktree(input);
    } catch (error) {
      // A deleted external checkout takes the worktree's common dir with it,
      // so every git op against the worktree fails. When the Project
      // repository itself is gone, the worktree's Git identity, HEAD, index,
      // and dirty state can no longer be proven. An extant directory is
      // retained and the caller fails closed with a manual-cleanup diagnosis;
      // only a directory that is also absent is treated as missing.
      return await recordedWorktreeWithoutRepository(input, error);
    }
    if (inspected === undefined) return "missing";
    if (inspected.state === "dirty") return "dirty";
    // Revalidate immediately before asking the worktree's own Git common-dir
    // to remove it. This never relies on the Project catalog's former path.
    const current = await inspectExactRecordedWorktree(input);
    if (current === undefined) return "missing";
    if (current.state === "dirty") return "dirty";
    await retainCommitRef(current.destinationRoot, input.retainedRef, current.head);
    await git(["-C", current.path, "worktree", "remove", "--", current.path]);
    if (await pathKind(current.path) !== undefined) {
      throw new Error(`Recorded managed worktree remained after removal: ${current.path}.`);
    }
    if (current.gitDirectory !== current.destinationGitDirectory) {
      await git([
        `--git-dir=${current.gitDirectory}`,
        "update-ref", "-d", "--no-deref", `refs/heads/${safeRef(input.branch)}`,
        current.head
      ]);
    }
    return "removed";
  }

  async inspectWorktree(input: Readonly<{
    repositoryPath: string;
    container: string;
    taskSegment: string;
    roleName: string;
  }>): Promise<GitWorkspaceState> {
    const container = resolve(input.container);
    const path = managedPath(
      container,
      worktreeIdentity(input.taskSegment, input.roleName).directory
    );
    const kind = await pathKind(path);
    if (kind === undefined) return "missing";
    if (kind === "symlink") throw new Error("Managed worktree path must not be a symbolic link.");

    const canonicalContainerPath = await canonicalContainer(container, false);
    const project = await this.inspect(input.repositoryPath);
    await assertOwnedWorktree(project, canonicalContainerPath, path);
    const porcelain = await git(["-C", path, "status", "--porcelain=v1", "--untracked-files=all"]);
    return porcelain.length > 0 ? "dirty" : "clean";
  }

  async removeIntegrationWorktree(input: Readonly<{
    repositoryPath: string;
    container: string;
    taskSegment: string;
    integrationId: string;
    discardChanges?: boolean;
  }>): Promise<GitWorkspaceRemoval> {
    return this.#removeManagedWorktree({
      repositoryPath: input.repositoryPath,
      container: input.container,
      identity: integrationWorktreeIdentity(input.taskSegment, input.integrationId),
      discardChanges: input.discardChanges
    });
  }

  async #removeManagedWorktree(input: Readonly<{
    repositoryPath: string;
    container: string;
    identity: Readonly<{ directory: string; branch: string }>;
    expectedBaseCommit?: string;
    allowCommittedChanges?: boolean;
    discardChanges?: boolean;
  }>): Promise<GitWorkspaceRemoval> {
    const container = resolve(input.container);
    const path = managedPath(container, input.identity.directory);
    const kind = await pathKind(path);
    if (kind === "symlink") throw new Error("Managed worktree path must not be a symbolic link.");
    const repository = await this.inspect(input.repositoryPath);
    if (kind === "directory") {
      const canonicalContainerPath = await canonicalContainer(container, false);
      await assertOwnedWorktree(repository, canonicalContainerPath, path);
      await assertExpectedBranch(path, input.identity.branch);
      if (input.discardChanges === true) {
        await git(["-C", repository.root, "worktree", "remove", "--force", "--", path]);
      } else {
        const porcelain = await git([
          "-C", path, "status", "--porcelain=v1", "--untracked-files=all"
        ]);
        if (porcelain.length > 0) return "dirty";
        if (
          input.expectedBaseCommit !== undefined
          && input.allowCommittedChanges !== true
        ) {
          const head = await gitLine([
            "-C", path, "rev-parse", "--verify", "--end-of-options", "HEAD^{commit}"
          ]);
          if (head.toLowerCase() !== input.expectedBaseCommit.toLowerCase()) return "dirty";
        }
        await git(["-C", repository.root, "worktree", "remove", "--", path]);
      }
    }
    const branchRef = `refs/heads/${input.identity.branch}`;
    if (await gitSucceeds([
      "-C", repository.root, "show-ref", "--verify", "--quiet", branchRef
    ])) {
      await git(["-C", repository.root, "branch", "-D", "--", input.identity.branch]);
    }
    return kind === "directory" ? "removed" : "missing";
  }
}

async function deleteBranchIfPresent(repositoryRoot: string, branch: string): Promise<void> {
  const branchRef = `refs/heads/${branch}`;
  if (!await gitSucceeds([
    "-C", repositoryRoot, "show-ref", "--verify", "--quiet", branchRef
  ])) return;
  await git(["-C", repositoryRoot, "branch", "-D", "--", branch]);
}

export function worktreeIdentity(
  taskId: string,
  roleName: string
): Readonly<{ directory: string; branch: string }> {
  const taskKey = safeIdentity(taskId, "Task id");
  const roleKey = safeIdentity(roleName, "Role name");
  return {
    directory: join(taskKey, roleKey),
    branch: `yui/${gitRefSegment(taskKey)}/${gitRefSegment(roleKey)}`
  };
}

export function integrationWorktreeIdentity(
  taskId: string,
  integrationId: string
): Readonly<{ directory: string; branch: string }> {
  const taskKey = safeIdentity(taskId, "Task id");
  const integrationKey = safeIdentity(integrationId, "Integration Attempt id");
  return {
    directory: join(taskKey, "integrations", integrationKey),
    branch: `yui/${gitRefSegment(taskKey)}/integration/${gitRefSegment(integrationKey)}`
  };
}

function gitRefSegment(identity: string): string {
  if (/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(identity)
    && !identity.includes("..")
    && !identity.endsWith(".")
    && !identity.endsWith(".lock")) {
    return identity;
  }
  const digest = createHash("sha256").update(identity).digest("hex").slice(0, 24);
  return `encoded-${digest}`;
}

async function assertExpectedBranch(path: string, expected: string): Promise<void> {
  const branch = await gitLine(["-C", path, "symbolic-ref", "--short", "HEAD"]);
  if (branch !== expected) {
    throw new Error(`Managed worktree is on an unexpected branch: ${branch}.`);
  }
}

async function assertOwnedWorktree(
  project: GitRepositoryInspection,
  container: string,
  path: string
): Promise<void> {
  const canonicalPath = await canonicalDirectory(path, "Managed worktree");
  assertContained(container, canonicalPath);
  if (canonicalPath !== path) throw new Error("Managed worktree resolves through a symbolic link.");
  const root = await canonicalDirectory(
    await gitLine(["-C", path, "rev-parse", "--show-toplevel"]),
    "Managed worktree root"
  );
  if (root !== path) throw new Error("Managed worktree root does not match its deterministic path.");
  const common = await canonicalDirectory(
    await gitLine(["-C", path, "rev-parse", "--path-format=absolute", "--git-common-dir"]),
    "Managed Git common directory"
  );
  if (common !== project.gitDirectory) {
    throw new Error("Managed worktree belongs to another project.");
  }
}

type ExactRecordedWorktree = Readonly<{
  path: string;
  gitDirectory: string;
  destinationGitDirectory: string;
  destinationRoot: string;
  head: string;
  state: "clean" | "dirty";
}>;

async function inspectExactRecordedWorktree(input: Readonly<{
  repositoryPath: string;
  container: string;
  path: string;
  branch: string;
  taskSegment: string;
  roleName: string;
}>): Promise<ExactRecordedWorktree | undefined> {
  const container = resolve(input.container);
  const identity = worktreeIdentity(input.taskSegment, input.roleName);
  const expectedPath = managedPath(container, identity.directory);
  if (resolve(input.path) !== expectedPath || input.branch !== identity.branch) {
    throw new Error("Recorded managed worktree identity is invalid.");
  }
  const kind = await pathKind(expectedPath);
  if (kind === undefined) return undefined;
  if (kind === "symlink") {
    throw new Error("Recorded managed worktree path must not be a symbolic link.");
  }

  const canonicalContainerPath = await canonicalContainer(container, false);
  const path = await canonicalDirectory(expectedPath, "Recorded managed worktree");
  assertContained(canonicalContainerPath, path);
  if (path !== expectedPath) {
    throw new Error("Recorded managed worktree resolves through a symbolic link.");
  }
  const root = await canonicalDirectory(
    await gitLine(["-C", path, "rev-parse", "--show-toplevel"]),
    "Recorded managed worktree root"
  );
  if (root !== path) {
    throw new Error("Recorded managed worktree root does not match its deterministic path.");
  }
  const branch = await gitLine(["-C", path, "symbolic-ref", "--short", "HEAD"]);
  if (branch !== input.branch) {
    throw new Error(`Recorded managed worktree is on an unexpected branch: ${branch}.`);
  }
  const gitDirectory = await canonicalDirectory(
    await gitLine(["-C", path, "rev-parse", "--path-format=absolute", "--git-common-dir"]),
    "Recorded managed Git common directory"
  );
  const destination = await new NodeGitWorkspace().inspect(input.repositoryPath);
  const head = await resolveRefCommit(path, "HEAD");
  const retained = await resolveRefCommit(destination.root, `refs/heads/${input.branch}`);
  if (retained !== head) {
    throw new Error(
      `Recorded managed worktree is not retained by the current Project: ${input.branch}.`
    );
  }
  const status = await git(["-C", path, "status", "--porcelain=v1", "--untracked-files=all"]);
  return {
    path,
    gitDirectory,
    destinationGitDirectory: destination.gitDirectory,
    destinationRoot: destination.root,
    head,
    state: status.length === 0 ? "clean" : "dirty"
  };
}

async function resolveRefCommit(repositoryPath: string, ref: string): Promise<string> {
  const commit = (await gitLine([
    "-C", repositoryPath,
    "rev-parse", "--verify", "--end-of-options", `${safeRef(ref)}^{commit}`
  ])).toLowerCase();
  if (!isCommit(commit)) throw new Error("Git returned an invalid ref commit.");
  return commit;
}

/**
 * Classify a recorded worktree whose Project repository can no longer be
 * inspected. A deleted external checkout takes the worktree's common dir with
 * it, so the worktree's Git identity, HEAD, index, and dirty/untracked state
 * cannot be proven. An extant directory is retained and the caller fails
 * closed with a bounded manual-cleanup diagnosis; only a directory that is
 * also absent is treated as missing. The exact recorded identity is
 * re-validated so a mismatched path/branch is never classified.
 */
async function recordedWorktreeWithoutRepository(
  input: Readonly<{
    repositoryPath: string;
    container: string;
    path: string;
    branch: string;
    taskSegment: string;
    roleName: string;
  }>,
  cause: unknown
): Promise<GitWorkspaceRemoval> {
  if (await pathKind(input.repositoryPath) !== undefined) throw cause;
  const identity = worktreeIdentity(input.taskSegment, input.roleName);
  const expectedPath = managedPath(resolve(input.container), identity.directory);
  if (resolve(input.path) !== expectedPath || input.branch !== identity.branch) {
    throw cause;
  }
  if (await pathKind(expectedPath) === undefined) return "missing";
  throw new Error(
    `Recorded worktree survives its Project repository and needs manual cleanup: ${expectedPath}. `
    + `The Project repository is gone, so the worktree's Git state cannot be verified; `
    + `remove the directory manually once its contents are safe.`
  );
}

async function retainCommitRef(
  repositoryPath: string,
  ref: string,
  commit: string
): Promise<void> {
  const target = safeRef(ref);
  if (await gitSucceeds([
    "-C", repositoryPath,
    "rev-parse", "--verify", "--quiet", "--end-of-options", `${target}^{commit}`
  ])) {
    if (await resolveRefCommit(repositoryPath, target) !== commit) {
      throw new Error(`Retained ref already exists at a different commit: ${target}.`);
    }
    return;
  }
  await git([
    "-C", repositoryPath,
    "update-ref", "--no-deref", target, commit, "0".repeat(commit.length)
  ]);
}

async function canonicalContainer(path: string, create: boolean): Promise<string> {
  const lexical = resolve(path);
  if (create) await mkdir(lexical, { recursive: true, mode: 0o700 });
  const canonical = await canonicalDirectory(lexical, "Worktree container");
  if (canonical !== lexical) throw new Error("Worktree container resolves through a symbolic link.");
  return canonical;
}

async function canonicalDirectory(path: string, label: string): Promise<string> {
  const value = requireText(path, label);
  const canonical = await realpath(isAbsolute(value) ? value : resolve(value));
  return canonical;
}

function managedPath(container: string, directory: string): string {
  const path = join(container, directory);
  assertContained(container, path);
  return path;
}

function assertContained(container: string, path: string): void {
  const child = relative(container, path);
  if (child.length === 0 || child === ".." || child.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) || isAbsolute(child)) {
    throw new Error("Managed worktree path escapes its container.");
  }
}

async function pathKind(path: string): Promise<"directory" | "symlink" | undefined> {
  try {
    const entry = await lstat(path);
    if (entry.isSymbolicLink()) return "symlink";
    if (!entry.isDirectory()) throw new Error("Managed worktree path is not a directory.");
    return "directory";
  } catch (error) {
    if (isErrno(error, "ENOENT")) return undefined;
    throw error;
  }
}

async function git(args: readonly string[]): Promise<string> {
  try {
    const result = await executeFile("git", [...args], {
      encoding: "utf8",
      maxBuffer: 1024 * 1024,
      timeout: 30_000
    });
    return result.stdout;
  } catch (error) {
    const stderr = typeof error === "object" && error !== null && "stderr" in error
      ? String((error as { stderr?: unknown }).stderr).trim()
      : "";
    throw new Error(stderr.length === 0 ? "Git command failed." : `Git command failed: ${stderr}`, {
      cause: error
    });
  }
}

async function gitSucceeds(args: readonly string[]): Promise<boolean> {
  try {
    await git(args);
    return true;
  } catch {
    return false;
  }
}

async function gitLine(args: readonly string[]): Promise<string> {
  const lines = (await git(args)).trimEnd().split("\n");
  if (lines.length !== 1 || lines[0]?.length === 0 || lines[0]?.includes("\0")) {
    throw new Error("Git returned invalid output.");
  }
  return lines[0];
}

function safeIdentity(value: string, label: string): string {
  const identity = requireText(value, label);
  if ([".", "..", "__proto__", "prototype", "constructor"].includes(identity)
    || /[\/\\\0]/.test(identity)) {
    throw new Error(`${label} is invalid.`);
  }
  return identity;
}

function safeRef(value: string): string {
  const ref = requireText(value, "Git base ref");
  if (ref.startsWith("-") || /[\r\n]/.test(ref)) throw new Error("Git base ref is invalid.");
  return ref;
}

async function safeFetchBranch(value: string): Promise<string> {
  const configuredRef = safeRef(value);
  if (configuredRef === "HEAD") return configuredRef;
  const branchPrefix = "refs/heads/";
  const branch = configuredRef.startsWith(branchPrefix)
    ? configuredRef.slice(branchPrefix.length)
    : configuredRef;
  if (!await gitSucceeds(["check-ref-format", "--branch", branch])) {
    throw new Error("Git stable branch is invalid.");
  }
  return branch;
}

async function resolveRemoteHeadBranch(remote: string): Promise<string> {
  let output: string;
  try {
    output = await git(["ls-remote", "--symref", remote, "HEAD"]);
  } catch (error) {
    const detail = error instanceof Error ? error.message : "Git command failed.";
    throw new Error(`Project remote HEAD could not be resolved: ${detail}`, { cause: error });
  }

  const symbolicLines = output.split("\n").filter((line) => line.startsWith("ref: "));
  const prefix = "ref: refs/heads/";
  const suffix = "\tHEAD";
  const symbolic = symbolicLines.length === 1 ? symbolicLines[0]! : "";
  if (!symbolic.startsWith(prefix) || !symbolic.endsWith(suffix)) {
    throw invalidRemoteHead();
  }
  const branch = symbolic.slice(prefix.length, -suffix.length);
  if (branch === "HEAD") throw invalidRemoteHead();
  try {
    return await safeFetchBranch(branch);
  } catch {
    throw invalidRemoteHead();
  }
}

async function resolveRemoteBranchCommit(remote: string, branch: string): Promise<string> {
  const target = `refs/heads/${branch}`;
  let output: string;
  try {
    output = await git(["ls-remote", "--refs", remote, target]);
  } catch (error) {
    const detail = error instanceof Error ? error.message : "Git command failed.";
    throw new Error(
      `Project remote development branch could not be resolved: ${branch}: ${detail}`,
      { cause: error }
    );
  }
  const matches = output
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => line.split(/\s+/u))
    .filter(([commit, ref]) => ref === target && commit !== undefined);
  if (matches.length !== 1) {
    throw new Error(
      `Project remote development branch could not be resolved: ${branch}.`
    );
  }
  const commit = matches[0]![0]!;
  if (!isCommit(commit)) {
    throw new Error(
      `Project remote development branch returned an invalid commit: ${branch}.`
    );
  }
  return commit.toLowerCase();
}

async function resolveFetchedCommit(repositoryPath: string, fetchedRef: string): Promise<string> {
  const commit = (await gitLine([
    "-C", repositoryPath,
    "rev-parse", "--verify", "--end-of-options", `${fetchedRef}^{commit}`
  ])).toLowerCase();
  if (!/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/u.test(commit)) {
    throw new Error("Git returned an invalid fetched remote commit.");
  }
  return commit;
}

function remoteBaselineRef(remote: string, branch: string): string {
  const identity = `${remote}\0${branch}\0${process.pid}\0${Date.now()}\0${Math.random()}`;
  const digest = createHash("sha256").update(identity).digest("hex");
  return `refs/yui/task-baselines/${digest}`;
}

function invalidRemoteHead(): Error {
  return new Error(
    "Project remote HEAD must identify a valid symbolic branch under refs/heads/."
  );
}

function isCommit(value: string): boolean {
  return /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/iu.test(value);
}

function safeRemote(value: string): string {
  const remote = requireText(value, "Git remote URL");
  if (remote.startsWith("-") || /[\r\n]/.test(remote)) {
    throw new Error("Git remote URL is invalid.");
  }
  return remote;
}

function requireText(value: string, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0 || value.includes("\0")) {
    throw new Error(`${label} is required.`);
  }
  return value.trim();
}

function isErrno(value: unknown, code: string): boolean {
  return typeof value === "object" && value !== null && "code" in value
    && (value as { code?: unknown }).code === code;
}
