import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
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
  isAncestor(
    repositoryPath: string,
    ancestor: string,
    descendant: string
  ): Promise<boolean>;
  headRef(repositoryPath: string): Promise<string>;
  isClean(repositoryPath: string): Promise<boolean>;
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
    taskId: string;
    roleName: string;
    baseRef: string;
  }>): Promise<PreparedGitWorktree>;
  inspectWorktree(input: Readonly<{
    repositoryPath: string;
    container: string;
    taskId: string;
    roleName: string;
  }>): Promise<GitWorkspaceState>;
  removeWorktree(input: Readonly<{
    repositoryPath: string;
    container: string;
    taskId: string;
    roleName: string;
    deleteBranch?: boolean;
  }>): Promise<GitWorkspaceRemoval>;
  ensureIntegrationWorktree(input: Readonly<{
    repositoryPath: string;
    container: string;
    taskId: string;
    integrationId: string;
    baseRef: string;
  }>): Promise<PreparedGitWorktree>;
  removeIntegrationWorktree(input: Readonly<{
    repositoryPath: string;
    container: string;
    taskId: string;
    integrationId: string;
  }>): Promise<GitWorkspaceRemoval>;
}

/** The small Git boundary used by project registration and Task workspaces. */
export class NodeGitWorkspace implements GitWorkspacePort {
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
    taskId: string;
    roleName: string;
    baseRef: string;
  }>): Promise<PreparedGitWorktree> {
    return this.#ensureManagedWorktree({
      repositoryPath: input.repositoryPath,
      container: input.container,
      identity: worktreeIdentity(input.taskId, input.roleName),
      baseRef: input.baseRef
    });
  }

  async ensureIntegrationWorktree(input: Readonly<{
    repositoryPath: string;
    container: string;
    taskId: string;
    integrationId: string;
    baseRef: string;
  }>): Promise<PreparedGitWorktree> {
    return this.#ensureManagedWorktree({
      repositoryPath: input.repositoryPath,
      container: input.container,
      identity: integrationWorktreeIdentity(input.taskId, input.integrationId),
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
    taskId: string;
    roleName: string;
    deleteBranch?: boolean;
  }>): Promise<GitWorkspaceRemoval> {
    const state = await this.inspectWorktree(input);
    if (state === "dirty") return state;
    const container = resolve(input.container);
    const identity = worktreeIdentity(input.taskId, input.roleName);
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

  async inspectWorktree(input: Readonly<{
    repositoryPath: string;
    container: string;
    taskId: string;
    roleName: string;
  }>): Promise<GitWorkspaceState> {
    const container = resolve(input.container);
    const path = managedPath(
      container,
      worktreeIdentity(input.taskId, input.roleName).directory
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
    taskId: string;
    integrationId: string;
  }>): Promise<GitWorkspaceRemoval> {
    return this.#removeManagedWorktree({
      repositoryPath: input.repositoryPath,
      container: input.container,
      identity: integrationWorktreeIdentity(input.taskId, input.integrationId)
    });
  }

  async #removeManagedWorktree(input: Readonly<{
    repositoryPath: string;
    container: string;
    identity: Readonly<{ directory: string; branch: string }>;
    expectedBaseCommit?: string;
    allowCommittedChanges?: boolean;
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
