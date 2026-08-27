import { existsSync } from "node:fs";
import { readdir, rename, rm } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";

import { usageError } from "../errors/cliError.js";
import { defaultTableWidth, renderTable } from "../output/table.js";
import {
  healCheckoutSwap,
  restoreCheckoutSwap,
  swapManagedCheckout
} from "../repository/checkoutSwap.js";
import { NodeGitWorkspace, type GitWorkspacePort } from "../repository/gitWorkspace.js";
import { acquireProjectMaintenanceLock } from "../repository/projectMaintenanceLock.js";
import {
  addProjectKnowledge,
  addKnowledgeProposal,
  assertProjectActive,
  decideKnowledgeProposal,
  createProject,
  findKnowledgeProposal,
  findKnowledgeProposalByFingerprint,
  knowledgeEvidenceDigest,
  knowledgeProposalFingerprint,
  managedProjectPath,
  planKnowledgeAcceptance,
  retireProject,
  retireProjectKnowledge,
  resolveProject,
  updateProjectKnowledge,
  updateProjectMetadata,
  validateProject,
  validateProjectName,
  type KnowledgeProposal,
  type KnowledgeProposalSource,
  type ProjectKnowledgeProvenance,
  type Project,
  type ProjectOwnership,
  type ProjectReferenceSummary
} from "../repository/project.js";
import { projectActor } from "./taskActor.js";
import type { Decision } from "../decision/decision.js";
import type { Milestone } from "../milestone/milestone.js";
import type { Task } from "../task/task.js";

export type ProjectCommandStore = Readonly<{
  transaction<T>(execute: (store: ProjectCommandStore) => T): T;
  nextProjectId(): string;
  createProjectIfAbsent(project: Project): Project | null;
  saveProject(project: Project): void;
  removeProject(projectId: string): boolean;
  listProjects(): Project[];
  getConfig(): Readonly<{ defaultWorkspace?: string }>;
  /** The persistent Home root; managed Project repositories live below it. */
  rootDirectory(): string;
  /** Task evidence for Knowledge promotion proposals. */
  getTask?(id: string): Task | null;
  getDecision?(taskId: string, decisionId: string): Decision | null;
  getMilestone?(taskId: string, milestoneId: string): Milestone | null;
  /** Task-ledger references to a Project for the lifecycle fail-closed gates. */
  summarizeProjectReferences(projectId: string): ProjectReferenceSummary;
}>;

export type ProjectCommandOptions = Readonly<{
  git?: Pick<
    GitWorkspacePort,
    "inspect" | "headRef" | "isClean" | "refresh" | "clone" | "ensureLocalBranch"
      | "resolveRemoteBaseline" | "copyRefs" | "isAncestor" | "resetToCommit"
      | "listWorktrees" | "listCommitsBetween"
  >;
  now?: () => Date;
  environment?: NodeJS.ProcessEnv;
}>;

export type ProjectCommandExecution = Readonly<{ output: string; data?: unknown }>;

export async function runProjectCommand(
  args: readonly string[],
  store: ProjectCommandStore,
  options: ProjectCommandOptions = {}
): Promise<ProjectCommandExecution> {
  const [command, ...rest] = args;
  if (command === "add" || command === "clone") {
    const project = command === "add"
      ? await addProject(rest, store, options)
      : await cloneProject(rest, store, options);
    return { output: renderAddedProject(project), data: { project } };
  }
  if (command === "list") {
    return { output: listProjects(rest, store), data: { projects: store.listProjects() } };
  }
  if (command === "refresh") {
    const refreshed = await refreshProject(rest, store, options);
    return {
      output: refreshed.changed
        ? `Refreshed project ${refreshed.project.id}: ${refreshed.fromCommit} -> ${refreshed.toCommit}\n`
        : `Project ${refreshed.project.id} is already current at ${refreshed.toCommit}\n`,
      data: refreshed
    };
  }
  if (command === "diagnose") {
    return diagnoseProject(rest, store, options);
  }
  if (command === "migrate") {
    const migrated = await migrateProject(rest, store, options);
    return {
      output: migrated.preflight
        ? `Project ${migrated.project.id} can be migrated to a Home-managed repository at ${migrated.path}\n`
        : `Migrated project ${migrated.project.id} to a Home-managed repository at ${migrated.path}\n`,
      data: migrated
    };
  }
  if (command === "update") {
    const project = await updateProject(rest, store, options);
    return {
      output: `Updated project ${project.id}\n`,
      data: { project }
    };
  }
  if (command === "reset") {
    return resetProject(rest, store, options);
  }
  if (command === "replace") {
    return replaceProject(rest, store, options);
  }
  if (command === "retire") {
    return retireProjectCommand(rest, store, options);
  }
  if (command === "delete") {
    return deleteProjectCommand(rest, store, options);
  }
  if (command === "discover") {
    const discovered = await discoverProjects(rest, store, options);
    return { output: renderDiscoveredProjects(discovered), data: { projects: discovered } };
  }
  if (command === "show") {
    const project = rest[0] === undefined ? null : resolveProject(store.listProjects(), rest[0]);
    return { output: showProject(rest, store), ...(project === null ? {} : { data: { project } }) };
  }
  if (command === "knowledge") {
    const result = projectKnowledge(rest, store, options);
    const project = resolveProject(store.listProjects(), result.projectId);
    if (project === null) return { output: result.output };
    if (result.knowledgeId !== undefined) {
      const knowledge = project.knowledge.find(({ id }) => id === result.knowledgeId);
      return { output: result.output, data: { project, knowledge } };
    }
    const knowledge = result.all
      ? project.knowledge
      : project.knowledge.filter(({ status }) => status === "active");
    return { output: result.output, data: { project, knowledge } };
  }
  throw usageError(command === undefined
    ? "Project command is required."
    : `Unknown command: project ${command}`);
}

async function refreshProject(
  args: readonly string[],
  store: ProjectCommandStore,
  options: ProjectCommandOptions
): Promise<Readonly<{
  project: Project;
  fromCommit: string;
  toCommit: string;
  changed: boolean;
}>> {
  if (args.length !== 1) {
    throw usageError("Project refresh usage: yui project refresh <project>.");
  }
  const project = requireProject(store, args[0]!);
  assertProjectActive(project, "refresh");
  if (project.remoteUrl === undefined) {
    throw usageError(`Project refresh requires a remote URL: ${project.id}.`);
  }
  if (project.stableBranch !== project.developmentBranch) {
    throw usageError(
      `Project refresh requires matching stable and development branches: ${project.id}.`
    );
  }
  // RFC Phase 1: hold the per-Project maintenance fence for the whole refresh
  // so Task workspace preparation and other maintenance cannot interleave
  // with the canonical branch/working-tree move.
  const releaseMaintenance = acquireProjectMaintenanceLock(store.rootDirectory(), project.id);
  try {
    const refreshed = await (options.git ?? new NodeGitWorkspace()).refresh({
      repositoryPath: project.path,
      remoteUrl: project.remoteUrl,
      stableRef: project.stableBranch
    });
    return { project, ...refreshed };
  } finally {
    releaseMaintenance();
  }
}

/**
 * RFC Phase 1: diagnose a managed Project's divergence without mutating it.
 * Shows the canonical HEAD, remote advertised SHA, and whether the checkout
 * can be fast-forwarded. Does not auto-reset or rebase.
 */
async function diagnoseProject(
  args: readonly string[],
  store: ProjectCommandStore,
  options: ProjectCommandOptions
): Promise<ProjectCommandExecution> {
  if (args.length !== 1) {
    throw usageError("Project diagnose usage: yui project diagnose <project>.");
  }
  const project = requireProject(store, args[0]!);
  if (project.remoteUrl === undefined) {
    return {
      output: `Project ${project.id} has no remote URL; nothing to diagnose.\n`,
      data: { project, diagnosis: "no-remote" }
    };
  }
  const git = options.git ?? new NodeGitWorkspace();
  const releaseMaintenance = acquireProjectMaintenanceLock(store.rootDirectory(), project.id);
  try {
    const current = await git.inspect(project.path, "HEAD");
    const remote = await git.resolveRemoteBaseline({
      repositoryPath: project.path,
      remoteUrl: project.remoteUrl,
      developmentRef: project.developmentBranch
    });
    const isAncestor = await git.isAncestor(project.path, current.baseCommit, remote.commit);
    const diverged = !isAncestor && current.baseCommit !== remote.commit;
    const lines = [
      `Project: ${project.id}`,
      `  canonical HEAD: ${current.baseCommit}`,
      `  remote ${project.developmentBranch}: ${remote.commit}`,
      `  status: ${current.baseCommit === remote.commit ? "up-to-date" : diverged ? "diverged" : "behind"}`,
      ...(diverged
        ? ["  The canonical checkout has local commits not on the remote.",
           "  Use `yui project refresh` only after resolving the divergence manually."]
        : [])
    ];
    return {
      output: lines.join("\n") + "\n",
      data: {
        project,
        diagnosis: diverged ? "diverged" : current.baseCommit === remote.commit ? "up-to-date" : "behind",
        canonicalHead: current.baseCommit,
        remoteHead: remote.commit
      }
    };
  } finally {
    releaseMaintenance();
 }
}

type DiscoveredProject = Readonly<{
  name: string;
  path: string;
  branch: string;
  registeredProjectId?: string;
}>;

async function discoverProjects(
  args: readonly string[],
  store: ProjectCommandStore,
  options: ProjectCommandOptions
): Promise<readonly DiscoveredProject[]> {
  if (args.length > 1) {
    throw usageError("Project discover usage: yui project discover [name].");
  }
  const query = args[0]?.trim().toLocaleLowerCase();
  const workspace = store.getConfig().defaultWorkspace;
  if (workspace === undefined) throw usageError("No default workspace is configured; run yui setup.");
  const git = options.git ?? new NodeGitWorkspace();
  const entries = await readdir(workspace, { withFileTypes: true });
  const discovered: DiscoveredProject[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name === "worktree"
      || (query !== undefined && !entry.name.toLocaleLowerCase().includes(query))) continue;
    try {
      const candidate = resolve(workspace, entry.name);
      const inspected = await git.inspect(candidate, "HEAD");
      if (inspected.root !== candidate) continue;
      const registered = store.listProjects().find(({ path }) => path === inspected.root);
      discovered.push({
        name: entry.name,
        path: inspected.root,
        branch: await git.headRef(inspected.root),
        ...(registered === undefined ? {} : { registeredProjectId: registered.id })
      });
    } catch {
      // The workspace may contain ordinary directories; only Git roots are candidates.
    }
  }
  return discovered.sort((left, right) => left.name.localeCompare(right.name));
}

function renderDiscoveredProjects(projects: readonly DiscoveredProject[]): string {
  if (projects.length === 0) return "No Git projects found in the workspace.\n";
  return `${renderTable(
    "Workspace projects",
    [
      { header: "Name", minWidth: 4, maxWidth: 28 },
      { header: "Path", minWidth: 8, maxWidth: 64 },
      { header: "Project", minWidth: 8, maxWidth: 24 }
    ],
    projects.map((project) => [
      project.name,
      project.path,
      project.registeredProjectId ?? "-"
    ]),
    defaultTableWidth()
  )}\n`;
}

async function cloneProject(
  args: readonly string[],
  store: ProjectCommandStore,
  options: ProjectCommandOptions
): Promise<Project> {
  const usage = "Project clone usage: yui project clone <name> <remote> [--alias <name> ...] [--stable <ref>] [--development <ref>] [--external].";
  const parsed = parseCloneArguments(args, usage);
  const git = options.git ?? new NodeGitWorkspace();
  const name = validateProjectName(parsed.name);
  const stableRef = parsed.stable ?? "HEAD";
  const developmentRef = parsed.development ?? stableRef;
  const projectId = store.nextProjectId();
  const now = (options.now ?? (() => new Date()))();

  // A remote-URL binding is Home-managed by default: its canonical repository
  // lives below the persistent Home, so the runtime never depends on a
  // user-controlled checkout path. --external is an explicit opt-in to the
  // legacy clone-inside-the-workspace mode.
  let destination: string;
  let ownership: ProjectOwnership;
  if (parsed.external) {
    const workspace = store.getConfig().defaultWorkspace;
    if (workspace === undefined) throw usageError("No default workspace is configured; run yui setup.");
    const workspaceRoot = resolve(workspace);
    destination = resolve(workspaceRoot, name);
    if (dirname(destination) !== workspaceRoot) {
      throw usageError("Project clone destination must be directly inside the configured workspace.");
    }
    assertOutsideManagedWorktrees(destination, workspace);
    ownership = "external";
  } else {
    destination = managedProjectPath(store.rootDirectory(), projectId);
    ownership = "managed";
  }
  const candidate = createProject(
    projectId,
    name,
    destination,
    { stable: stableRef, development: developmentRef },
    now,
    { aliases: parsed.aliases, remoteUrl: parsed.remote, ownership }
  );
  assertProjectAvailable(store, candidate);

  let cloned = false;
  try {
    const head = await git.clone({
      remoteUrl: parsed.remote,
      destination,
      ...(stableRef === "HEAD" ? {} : { branch: stableRef })
    });
    cloned = true;
    const stable = stableRef === "HEAD" ? head : await git.inspect(destination, stableRef);
    if (head.baseCommit !== stable.baseCommit) {
      throw new Error(`Project checkout is not on its stable ref: ${stableRef}.`);
    }
    if (developmentRef !== stableRef) {
      await git.ensureLocalBranch(destination, developmentRef);
    }
    // Verify both configured branches against the SHAs the remote advertises
    // now. A network race or a ref that moved during the clone fails closed
    // before any binding is persisted.
    await assertRemoteBranchesVerified(
      git,
      destination,
      parsed.remote,
      [
        { ref: stableRef, localCommit: head.baseCommit },
        ...(developmentRef === stableRef
          ? []
          : [{ ref: developmentRef, localCommit: (await git.inspect(destination, developmentRef)).baseCommit }])
      ]
    );
    const project = createProject(
      projectId,
      name,
      head.root,
      { stable: stableRef, development: developmentRef },
      now,
      { aliases: parsed.aliases, remoteUrl: parsed.remote, ownership }
    );
    assertProjectAvailable(store, project);
    const created = store.createProjectIfAbsent(project);
    if (created === null) throw usageError(`Project already exists: ${project.name}.`);
    return created;
  } catch (error) {
    if (cloned && !store.listProjects().some(({ path }) => path === destination)) {
      await rm(destination, { recursive: true, force: true });
    }
    throw error;
  }
}

/**
 * Migrate an external Project binding to a Home-managed repository. The
 * remote is cloned, both configured branches are verified against the
 * advertised remote SHAs, and local Yui refs are imported before the catalog
 * record switches. The old checkout is never touched. A failed migration
 * leaves no partial state: the unfinished managed clone is removed so the
 * command can be retried cleanly.
 */
async function migrateProject(
  args: readonly string[],
  store: ProjectCommandStore,
  options: ProjectCommandOptions
): Promise<Readonly<{
  project: Project;
  path: string;
  preflight: boolean;
}>> {
  const usage = "Project migrate usage: yui project migrate <project> [--preflight].";
  const parsed = parseMigrateArguments(args, usage);
  const project = requireProject(store, parsed.project);
  assertProjectActive(project, "migrate");
  if (project.ownership === "managed") {
    throw usageError(`Project is already Home-managed: ${project.id}.`);
  }
  if (project.remoteUrl === undefined) {
    throw usageError(`Project migrate requires a remote URL: ${project.id}.`);
  }
  const git = options.git ?? new NodeGitWorkspace();
  const destination = managedProjectPath(store.rootDirectory(), project.id);
  // Migration rewrites the Project's Git repository: hold the per-Project
  // maintenance fence so no rebuild/archive/cleanup (or a second migrate)
  // interleaves, and the Controller defers worktree preparation meanwhile.
  const releaseMaintenance = acquireProjectMaintenanceLock(store.rootDirectory(), project.id);
  try {
    // Re-read the Project under the fence. A concurrent migration may have
    // completed and switched the catalog to the Home-managed repo since the
    // record was resolved above; the stale snapshot must not drive any Git
    // effect (in particular it must not delete the now-canonical repo).
    const current = requireProject(store, project.id);
    if (current.ownership === "managed") {
      throw usageError(`Project is already Home-managed: ${project.id}.`);
    }
    if (current.remoteUrl === undefined) {
      throw usageError(`Project migrate requires a remote URL: ${project.id}.`);
    }
    if (current.path !== project.path
      || current.remoteUrl !== project.remoteUrl
      || current.stableBranch !== project.stableBranch
      || current.developmentBranch !== project.developmentBranch) {
      throw new Error(`Project changed while migrating: ${project.id}.`);
    }
    // Preflight verifies the remote into a throwaway clone: it changes neither
    // the catalog nor the persistent projects directory.
    const verifyRoot = parsed.preflight
      ? join(store.rootDirectory(), "projects", `.preflight-${project.id}`)
      : destination;
    if (!parsed.preflight) {
      // A crashed earlier attempt can leave an unreferenced managed clone
      // behind. It is safe to remove only because no catalog record points at
      // it; a registered path fails closed instead.
      await removeUnreferencedClone(store, destination, project.id);
    } else if (existsSync(verifyRoot)) {
      // A crashed preflight can only leave its own throwaway clone behind.
      await rm(verifyRoot, { recursive: true, force: true });
    }
    let prepared = false;
    try {
      // Every Git effect is driven from the under-fence snapshot `current`,
      // never the pre-lock `project`: a branch/remote change between the read
      // and the lock fails closed above, and the publication CAS below covers
      // a change between the lock and the switch.
      const head = await git.clone({
        remoteUrl: current.remoteUrl,
        destination: verifyRoot,
        ...(current.stableBranch === "HEAD" ? {} : { branch: current.stableBranch })
      });
      prepared = true;
      const stable = current.stableBranch === "HEAD"
        ? head
        : await git.inspect(verifyRoot, current.stableBranch);
      if (head.baseCommit !== stable.baseCommit) {
        throw new Error(`Project checkout is not on its stable ref: ${current.stableBranch}.`);
      }
      if (current.developmentBranch !== current.stableBranch) {
        await git.ensureLocalBranch(verifyRoot, current.developmentBranch);
      }
      await assertRemoteBranchesVerified(
        git,
        verifyRoot,
        current.remoteUrl,
        [
          { ref: current.stableBranch, localCommit: head.baseCommit },
          ...(current.developmentBranch === current.stableBranch
            ? []
            : [{
                ref: current.developmentBranch,
                localCommit: (await git.inspect(verifyRoot, current.developmentBranch)).baseCommit
              }])
        ]
      );
      const copyRefs = git.copyRefs;
      if (typeof copyRefs !== "function") {
        throw new Error(`Git workspace cannot preserve local Yui refs for Project: ${project.id}.`);
      }
      await copyRefs.call(git, {
        sourceRepositoryPath: current.path,
        destinationRepositoryPath: verifyRoot,
        patterns: ["refs/heads/yui/", "refs/yui/archive/"]
      });
      if (parsed.preflight) {
        return { project: current, path: destination, preflight: true };
      }
      const switched = store.transaction((tx) => {
        const latest = requireProject(tx, project.id);
        if (latest.ownership !== "external"
          || latest.path !== current.path
          || latest.remoteUrl !== current.remoteUrl
          || latest.stableBranch !== current.stableBranch
          || latest.developmentBranch !== current.developmentBranch) {
          throw new Error(`Project changed while migrating: ${project.id}.`);
        }
        // The switch only changes ownership and path; every other field is
        // frozen, and the catalog validator re-checks the whole record.
        const next = validateProject({
          ...latest,
          path: destination,
          ownership: "managed" as const,
          updatedAt: (options.now ?? (() => new Date()))().toISOString()
        });
        assertProjectAvailable(tx, next, latest.id);
        tx.saveProject(next);
        return next;
      });
      return { project: switched, path: switched.path, preflight: false };
    } catch (error) {
      if (prepared && !parsed.preflight
        && !store.listProjects().some(({ path }) => path === destination)) {
        await rm(destination, { recursive: true, force: true });
      }
      throw error;
    } finally {
      if (parsed.preflight) {
        await rm(verifyRoot, { recursive: true, force: true });
      }
    }
  } finally {
    releaseMaintenance();
  }
}

/**
 * Remove a managed clone left behind by a crashed migration attempt. Such a
 * directory is unreferenced garbage; a path any catalog record points at is
 * never deleted. The check fails closed even when the destination is
 * registered to the migrating Project itself: a concurrent migration may
 * already have completed and switched the catalog to this path, making it
 * the canonical repository that must not be removed.
 */
async function removeUnreferencedClone(
  store: ProjectCommandStore,
  destination: string,
  migratingProjectId: string
): Promise<void> {
  if (!existsSync(destination)) return;
  const registered = store.listProjects().find(({ path }) => path === destination);
  if (registered !== undefined) {
    throw new Error(
      registered.id === migratingProjectId
        ? `Project already migrated to the managed path: ${destination}.`
        : `Managed Project path is already registered: ${destination}.`
    );
  }
  await rm(destination, { recursive: true, force: true });
}

/**
 * Verify that the local SHAs of the configured branches exactly match the
 * commits the remote advertises right now. Any mismatch fails closed.
 */
async function assertRemoteBranchesVerified(
  git: NonNullable<ProjectCommandOptions["git"]>,
  repositoryPath: string,
  remoteUrl: string,
  branches: readonly Readonly<{ ref: string; localCommit: string }>[]
): Promise<void> {
  for (const branch of branches) {
    const resolved = await git.resolveRemoteBaseline({
      repositoryPath,
      remoteUrl,
      developmentRef: branch.ref
    });
    if (resolved.commit.toLowerCase() !== branch.localCommit.toLowerCase()) {
      throw new Error(
        `Project remote branch ${resolved.branch} moved while it was fetched: `
        + `advertised ${resolved.commit}, local ${branch.localCommit}.`
      );
    }
  }
}

async function addProject(
  args: readonly string[],
  store: ProjectCommandStore,
  options: ProjectCommandOptions
): Promise<Project> {
  const usage = "Project add usage: yui project add <name> <path> [--alias <name> ...] [--remote <url>] [--stable <ref>] [--development <ref>].";
  const parsed = parseAddArguments(args, usage);
  assertOutsideManagedWorktrees(parsed.path, store.getConfig().defaultWorkspace);
  const git = options.git ?? new NodeGitWorkspace();
  const head = await git.inspect(parsed.path, "HEAD");
  assertOutsideManagedWorktrees(head.root, store.getConfig().defaultWorkspace);
  if (!await git.isClean(head.root)) {
    throw usageError("Project checkout must be clean before it can be registered.");
  }
  const stableRef = parsed.stable ?? head.baseRef;
  const stable = stableRef === "HEAD" ? head : await git.inspect(head.root, stableRef);
  if (head.baseCommit !== stable.baseCommit) {
    throw usageError(`Project checkout must be on its stable ref: ${stableRef}.`);
  }
  const developmentRef = parsed.development ?? stableRef;
  const project = createProject(
    store.nextProjectId(),
    parsed.name,
    head.root,
    {
      stable: stableRef,
      development: developmentRef
    },
    (options.now ?? (() => new Date()))(),
    { aliases: parsed.aliases, ...(parsed.remote === undefined ? {} : { remoteUrl: parsed.remote }) }
  );
  assertProjectAvailable(store, project);
  if (developmentRef !== stableRef) await git.ensureLocalBranch(head.root, developmentRef);
  const created = store.createProjectIfAbsent(project);
  if (created === null) throw usageError(`Project already exists: ${project.name}.`);
  return created;
}

async function updateProject(
  args: readonly string[],
  store: ProjectCommandStore,
  options: ProjectCommandOptions
): Promise<Project> {
  const usage = "Project update usage: yui project update <project> [--alias <name> ...|--clear-aliases] [--remote <url>|--clear-remote] [--stable <ref>] [--development <ref>].";
  const parsed = parseProjectUpdateArguments(args, usage);
  const current = requireProject(store, parsed.reference);
  assertProjectActive(current, "update");
  const now = (options.now ?? (() => new Date()))();
  const patch = {
    ...(parsed.aliases === undefined ? {} : { aliases: parsed.aliases }),
    ...(parsed.remote === undefined ? {} : { remoteUrl: parsed.remote }),
    ...(parsed.stable === undefined ? {} : { stableBranch: parsed.stable }),
    ...(parsed.development === undefined
      ? {}
      : { developmentBranch: parsed.development })
  };
  assertProjectAvailable(
    store,
    updateProjectMetadata(current, patch, now),
    current.id
  );
  const git = options.git ?? new NodeGitWorkspace();
  if (parsed.stable !== undefined) {
    const head = await git.inspect(current.path, "HEAD");
    if (!await git.isClean(head.root)) {
      throw usageError("Project checkout must be clean before its stable ref can be changed.");
    }
    const stable = parsed.stable === "HEAD"
      ? head
      : await git.inspect(current.path, parsed.stable);
    if (head.baseCommit !== stable.baseCommit) {
      throw usageError(`Project checkout must be on its stable ref: ${parsed.stable}.`);
    }
  }
  const developmentBranch = parsed.development ?? current.developmentBranch;
  const stableBranch = parsed.stable ?? current.stableBranch;
  if (parsed.development !== undefined && developmentBranch !== stableBranch) {
    await git.ensureLocalBranch(current.path, developmentBranch);
  }
  return store.transaction((tx) => {
    const latest = requireProject(tx, current.id);
    if (latest.path !== current.path) {
      throw new Error(`Project path changed while updating: ${current.id}.`);
    }
    const updated = updateProjectMetadata(latest, patch, now);
    assertProjectAvailable(tx, updated, current.id);
    tx.saveProject(updated);
    return updated;
  });
}

/**
 * Lifecycle commands (reset/replace/retire/delete) are Operator authority:
 * they discard commits, replace checkouts, or remove catalog records, so a
 * managed Task Session may never drive them. A plain terminal is the human
 * Operator; a managed global Session must be the Operator role.
 */
function assertProjectOperator(options: ProjectCommandOptions, action: string): void {
  const actor = projectActor(options.environment);
  if (actor === "agent") {
    throw usageError(
      `Project lifecycle commands are Operator authority; a managed Task Session cannot ${action} a Project. `
      + "Run this command from an Operator or user terminal."
    );
  }
}

/**
 * Fail-closed gate for the destructive lifecycle commands: an active Task
 * binding means the canonical checkout and catalog record are in active use,
 * so reset/replace/retire refuse until the Task is settled. Historical
 * (completed/retired/archived) bindings are reported but never block — their
 * evidence lives in the Task records themselves.
 */
function assertNoActiveTaskBinding(
  store: ProjectCommandStore,
  project: Project,
  action: string
): ProjectReferenceSummary {
  const references = store.summarizeProjectReferences(project.id);
  if (references.activeTaskIds.length > 0) {
    const delivery = [
      ...references.unresolvedWorkItemRefs,
      ...references.activeRunRefs,
      ...references.unresolvedIntegrationRefs
    ];
    throw usageError(
      `Project cannot be ${action} while an active Task binds it: ${project.id}. `
      + `Active Tasks: ${references.activeTaskIds.join(", ")}.`
      + (delivery.length === 0 ? "" : ` Unresolved delivery: ${delivery.join(", ")}.`)
      + " Complete, retire, or archive those Tasks first."
    );
  }
  return references;
}

/**
 * Controlled reset of a canonical Project checkout to its verified remote
 * baseline. Handles the local/remote divergence that `project refresh`
 * (clean fast-forward only) refuses: with `--discard-local` the checkout is
 * hard-reset to the fetched remote commit, explicitly discarding the local
 * commits listed in the refusal. Every destructive path is fail-closed:
 * Operator authority, no active Task binding, clean checkout on its stable
 * branch, reachable verified remote, and the per-Project maintenance fence.
 */
async function resetProject(
  args: readonly string[],
  store: ProjectCommandStore,
  options: ProjectCommandOptions
): Promise<ProjectCommandExecution> {
  const usage = "Project reset usage: yui project reset <project> [--discard-local].";
  const parsed = parseResetArguments(args, usage);
  const project = requireProject(store, parsed.project);
  assertProjectOperator(options, "reset");
  assertProjectActive(project, "reset");
  if (project.remoteUrl === undefined) {
    throw usageError(`Project reset requires a remote URL: ${project.id}.`);
  }
  if (project.stableBranch !== project.developmentBranch) {
    throw usageError(
      `Project reset requires matching stable and development branches: ${project.id}.`
    );
  }
  const git = options.git ?? new NodeGitWorkspace();
  const releaseMaintenance = acquireProjectMaintenanceLock(store.rootDirectory(), project.id);
  try {
    // Re-read under the fence so a concurrent catalog change can never drive
    // a destructive Git effect from a stale snapshot.
    const current = requireProject(store, project.id);
    assertProjectActive(current, "reset");
    if (current.path !== project.path
      || current.remoteUrl !== project.remoteUrl
      || current.stableBranch !== project.stableBranch
      || current.developmentBranch !== project.developmentBranch) {
      throw new Error(`Project changed while resetting: ${project.id}.`);
    }
    assertNoActiveTaskBinding(store, current, "reset");
    const head = await git.inspect(current.path, "HEAD");
    if (!await git.isClean(head.root)) {
      throw usageError(
        `Project checkout must be clean before reset: ${current.id}. `
        + "Commit, stash, or discard uncommitted changes first."
      );
    }
    const branch = await git.headRef(head.root);
    if (branch !== current.stableBranch) {
      const found = branch === "HEAD" ? "detached HEAD" : branch;
      throw usageError(
        `Project checkout must be on its stable branch ${current.stableBranch} before reset (found ${found}).`
      );
    }
    // Fetch and verify the advertised remote baseline. An unreachable remote
    // or a ref that moves mid-fetch fails closed here, before any local effect.
    const remote = await git.resolveRemoteBaseline({
      repositoryPath: head.root,
      remoteUrl: current.remoteUrl,
      developmentRef: current.stableBranch
    });
    const localCommit = head.baseCommit.toLowerCase();
    const remoteCommit = remote.commit.toLowerCase();
    if (localCommit === remoteCommit) {
      return {
        output: `Project ${current.id} is already at the remote baseline ${remoteCommit}.\n`,
        data: {
          project: current,
          fromCommit: localCommit,
          toCommit: remoteCommit,
          changed: false,
          discarded: []
        }
      };
    }
    const isAncestor = await git.isAncestor(head.root, localCommit, remoteCommit);
    if (!isAncestor) {
      const discarded = await git.listCommitsBetween({
        repositoryPath: head.root,
        baseCommit: remoteCommit,
        headCommit: localCommit
      });
      if (!parsed.discardLocal) {
        throw usageError(
          `Project ${current.id} has diverged from ${current.remoteUrl}: local ${localCommit} `
          + `is not an ancestor of remote ${remoteCommit}.\n`
          + "Local commits that would be discarded:\n"
          + discarded.map((entry) => `  ${entry}`).join("\n")
          + "\nRe-run with --discard-local to hard-reset the checkout to the remote baseline."
        );
      }
      await git.resetToCommit({
        repositoryPath: head.root,
        expectedHead: localCommit,
        targetCommit: remoteCommit
      });
      return {
        output: `Reset project ${current.id}: ${localCommit} -> ${remoteCommit} `
          + `(discarded ${discarded.length} local commit(s)).\n`,
        data: {
          project: current,
          fromCommit: localCommit,
          toCommit: remoteCommit,
          changed: true,
          discarded
        }
      };
    }
    // Behind only: the verified reset is a clean fast-forward.
    await git.resetToCommit({
      repositoryPath: head.root,
      expectedHead: localCommit,
      targetCommit: remoteCommit
    });
    return {
      output: `Reset project ${current.id}: ${localCommit} -> ${remoteCommit} (fast-forward).\n`,
      data: {
        project: current,
        fromCommit: localCommit,
        toCommit: remoteCommit,
        changed: true,
        discarded: []
      }
    };
  } finally {
    releaseMaintenance();
  }
}

/**
 * Replace a Home-managed canonical checkout with a fresh clone from its
 * remote, preserving the catalog binding and Yui-local refs. For checkouts
 * whose divergence or corruption is too severe for `project reset`. The
 * discard is explicit (`--discard-local`), the remote is verified before the
 * swap, and Task/Integration worktrees are protected by a linked-worktree
 * gate. The swap itself is recoverable: the previous checkout is parked at a
 * backup path and restored on any failure, and a crash mid-swap is healed on
 * the next run (a crash before the swap leaves only a removable staging
 * clone).
 */
async function replaceProject(
  args: readonly string[],
  store: ProjectCommandStore,
  options: ProjectCommandOptions
): Promise<ProjectCommandExecution> {
  const usage = "Project replace usage: yui project replace <project> --discard-local.";
  const parsed = parseReplaceArguments(args, usage);
  const project = requireProject(store, parsed.project);
  assertProjectOperator(options, "replace");
  assertProjectActive(project, "replace");
  if (project.ownership !== "managed") {
    throw usageError(
      `Project replace only applies to Home-managed checkouts: ${project.id}. `
      + "External checkouts are user-owned; re-register or repair them with `yui project update`/`yui project add`."
    );
  }
  if (project.remoteUrl === undefined) {
    throw usageError(`Project replace requires a remote URL: ${project.id}.`);
  }
  if (!parsed.discardLocal) {
    throw usageError(
      `Project replace discards the current checkout and re-clones from ${project.remoteUrl}. `
      + "Re-run with --discard-local to acknowledge that the checkout and any uncommitted state will be discarded."
    );
  }
  const git = options.git ?? new NodeGitWorkspace();
  const releaseMaintenance = acquireProjectMaintenanceLock(store.rootDirectory(), project.id);
  try {
    const current = requireProject(store, project.id);
    assertProjectActive(current, "replace");
    if (current.path !== project.path
      || current.remoteUrl !== project.remoteUrl
      || current.ownership !== project.ownership
      || current.stableBranch !== project.stableBranch
      || current.developmentBranch !== project.developmentBranch) {
      throw new Error(`Project changed while replacing: ${project.id}.`);
    }
    assertNoActiveTaskBinding(store, current, "replace");
    const backup = join(store.rootDirectory(), "projects", `.replace-backup-${current.id}`);
    // Heal a crashed earlier swap before any new destructive step, so the
    // prechecks below always see a valid checkout.
    await healCheckoutSwap({ currentPath: current.path, backupPath: backup });
    // A linked worktree (Task/Integration workspace) shares this repository's
    // object store and would be broken by a wholesale checkout replacement.
    const worktrees = await git.listWorktrees(current.path);
    const linked = worktrees.filter((path) => path !== current.path);
    if (linked.length > 0) {
      throw usageError(
        `Project checkout has linked worktrees that would break: ${current.id}.\n`
        + linked.map((path) => `  ${path}`).join("\n")
        + "\nClean up Task/Integration workspaces first (e.g. `yui task work cleanup`, `yui task integration cleanup`)."
      );
    }
    if (!await git.isClean(current.path)) {
      throw usageError(
        `Project checkout must be clean before replace: ${current.id}. `
        + "Commit, stash, or discard uncommitted changes first."
      );
    }
    const staging = join(store.rootDirectory(), "projects", `.replace-${current.id}`);
    if (existsSync(staging)) {
      // A crashed earlier attempt can only leave its own staging clone behind.
      await rm(staging, { recursive: true, force: true });
    }
    let prepared = false;
    try {
      const head = await git.clone({
        remoteUrl: current.remoteUrl,
        destination: staging,
        ...(current.stableBranch === "HEAD" ? {} : { branch: current.stableBranch })
      });
      prepared = true;
      const stable = current.stableBranch === "HEAD"
        ? head
        : await git.inspect(staging, current.stableBranch);
      if (head.baseCommit !== stable.baseCommit) {
        throw new Error(`Project checkout is not on its stable ref: ${current.stableBranch}.`);
      }
      if (current.developmentBranch !== current.stableBranch) {
        await git.ensureLocalBranch(staging, current.developmentBranch);
      }
      await assertRemoteBranchesVerified(
        git,
        staging,
        current.remoteUrl,
        [
          { ref: current.stableBranch, localCommit: head.baseCommit },
          ...(current.developmentBranch === current.stableBranch
            ? []
            : [{
              ref: current.developmentBranch,
              localCommit: (await git.inspect(staging, current.developmentBranch)).baseCommit
            }])
        ]
      );
      // Preserve Yui-local refs (Task branches, archive refs) so historical
      // evidence keeps resolving after the checkout is replaced.
      const copyRefs = git.copyRefs;
      if (typeof copyRefs !== "function") {
        throw new Error(`Git workspace cannot preserve local Yui refs for Project: ${project.id}.`);
      }
      await copyRefs.call(git, {
        sourceRepositoryPath: current.path,
        destinationRepositoryPath: staging,
        patterns: ["refs/heads/yui/", "refs/yui/archive/"]
      });
      const oldHead = (await git.inspect(current.path, "HEAD")).baseCommit;
      // Swap the checkout on disk without ever leaving the registered path
      // without a repository: the previous checkout is parked at the backup
      // path first and restored on any failure. The backup is removed only
      // after the catalog transaction commits, so a crash in between stays
      // recoverable (healed at the top of the next run).
      await swapManagedCheckout({ currentPath: current.path, stagingPath: staging, backupPath: backup });
      let switched: Project;
      try {
        switched = store.transaction((tx) => {
          const latest = requireProject(tx, current.id);
          if (latest.path !== current.path || latest.ownership !== current.ownership) {
            throw new Error(`Project changed while replacing: ${current.id}.`);
          }
          const next = validateProject({
            ...latest,
            updatedAt: (options.now ?? (() => new Date()))().toISOString()
          });
          tx.saveProject(next);
          return next;
        });
      } catch (error) {
        try {
          await restoreCheckoutSwap({ currentPath: current.path, backupPath: backup });
        } catch (rollbackError) {
          throw new Error(
            `Project replace failed and checkout rollback was incomplete: ${messageOf(error)}; `
            + `rollback failed: ${messageOf(rollbackError)}. `
            + `The previous checkout remains parked at ${backup}.`
          );
        }
        throw error;
      }
      let backupLeftover = false;
      try {
        await rm(backup, { recursive: true, force: true });
      } catch {
        backupLeftover = true;
      }
      const newHead = (await git.inspect(current.path, "HEAD")).baseCommit;
      return {
        output: `Replaced project ${current.id} checkout: ${oldHead} -> ${newHead} `
          + `(re-cloned from ${current.remoteUrl}).\n`
          + (backupLeftover
            ? `The previous checkout could not be removed; delete it manually: ${backup}.\n`
            : ""),
        data: { project: switched, fromCommit: oldHead, toCommit: newHead }
      };
    } catch (error) {
      if (prepared && existsSync(staging)) {
        await rm(staging, { recursive: true, force: true });
      }
      throw error;
    }
  } finally {
    releaseMaintenance();
  }
}

/**
 * Auditable soft deprecation. The catalog record, checkout, and every
 * historical Task/Run/Review/Integration/Publication reference are retained;
 * the Project can no longer be bound to new work or maintained. Hard removal
 * is a separate `project delete` decision.
 */
function retireProjectCommand(
  args: readonly string[],
  store: ProjectCommandStore,
  options: ProjectCommandOptions
): ProjectCommandExecution {
  const usage = "Project retire usage: yui project retire <project> --reason <text>.";
  const parsed = parseRetireArguments(args, usage);
  const project = requireProject(store, parsed.project);
  assertProjectOperator(options, "retire");
  assertProjectActive(project, "retire");
  const actor = projectActor(options.environment);
  const retiredBy = actor === "operator" ? "operator" as const : "user" as const;
  const now = (options.now ?? (() => new Date()))();
  const retired = store.transaction((tx) => {
    const latest = requireProject(tx, project.id);
    assertProjectActive(latest, "retire");
    assertNoActiveTaskBinding(tx, latest, "retire");
    const next = retireProject(latest, parsed.reason, retiredBy, now);
    tx.saveProject(next);
    return { project: next, references: tx.summarizeProjectReferences(next.id) };
  });
  const lines = [
    `Retired project ${retired.project.id} (${retired.project.name})`,
    `Reason: ${parsed.reason}`,
    `Retired by: ${retiredBy} at ${retired.project.retirement?.retiredAt ?? "?"}`,
    "The catalog record, checkout, and historical Task/Run/Review/Integration/Publication evidence are retained.",
    ...(retired.references.boundTaskIds.length === 0
      ? []
      : [`Historical Task bindings retained: ${retired.references.boundTaskIds.join(", ")}.`]),
    "Use `yui project delete` to remove the catalog record once no Task references it."
  ];
  return {
    output: lines.join("\n").concat("\n"),
    data: { project: retired.project, references: retired.references }
  };
}

/**
 * Hard removal of a retired Project catalog record, optionally including its
 * Home-managed checkout. Deletion is deliberately two-phase (retire first)
 * and doubly acknowledged (--confirm with the exact Project id), and it fails
 * closed while any Task record references the Project so historical evidence
 * stays resolvable. With `--checkout`, every fail-closed precheck (linked
 * worktrees, dirty checkout) runs before any destruction, and the checkout is
 * moved to a tombstone before the catalog record is removed; any failure
 * restores it, so catalog and checkout never disagree unrecoverably.
 */
async function deleteProjectCommand(
  args: readonly string[],
  store: ProjectCommandStore,
  options: ProjectCommandOptions
): Promise<ProjectCommandExecution> {
  const usage = "Project delete usage: yui project delete <project> [--checkout] --confirm <project-id>.";
  const parsed = parseDeleteArguments(args, usage);
  const project = requireProject(store, parsed.project);
  assertProjectOperator(options, "delete");
  if (project.status !== "retired") {
    throw usageError(
      `Project must be retired before it can be deleted: ${project.id}. `
      + "Use `yui project retire <project> --reason <text>` first; retirement keeps the audit trail."
    );
  }
  if (parsed.confirm !== project.id) {
    throw usageError(
      `Project delete requires --confirm ${project.id} to acknowledge removal of the catalog record`
      + `${parsed.checkout ? " and the checkout" : ""}.`
    );
  }
  if (parsed.checkout && project.ownership !== "managed") {
    throw usageError(
      `Project delete --checkout only applies to Home-managed checkouts: ${project.id}. `
      + "External checkouts are user-owned; remove them manually after deleting the binding."
    );
  }
  if (!parsed.checkout) {
    const removed = removeRetiredProjectRecord(store, project.id);
    return {
      output: `Deleted project ${removed.id} (catalog record; checkout retained at ${removed.path}).\n`,
      data: { project: removed, checkoutRemoved: false }
    };
  }
  // --checkout: prechecks first, then a rename/tombstone two-phase flow. The
  // checkout moves to a tombstone before the catalog record is removed, and
  // every failure restores it, so the catalog never loses its recoverable
  // entry while a live checkout (or its failure) is still in play.
  const tombstone = join(store.rootDirectory(), "projects", `.delete-${project.id}`);
  const releaseMaintenance = acquireProjectMaintenanceLock(store.rootDirectory(), project.id);
  try {
    // Heal a crashed earlier attempt before the prechecks run.
    await healCheckoutSwap({ currentPath: project.path, backupPath: tombstone });
    if (existsSync(project.path)) {
      const git = options.git ?? new NodeGitWorkspace();
      const worktrees = await git.listWorktrees(project.path);
      const linked = worktrees.filter((path) => path !== project.path);
      if (linked.length > 0) {
        throw usageError(
          `Project checkout has linked worktrees that would break: ${project.id}.\n`
          + linked.map((path) => `  ${path}`).join("\n")
          + "\nClean up Task/Integration workspaces first (e.g. `yui task work cleanup`, `yui task integration cleanup`)."
        );
      }
      if (!await git.isClean(project.path)) {
        throw usageError(
          `Project checkout must be clean before delete: ${project.id}. `
          + "Commit, stash, or discard uncommitted changes first, or delete the catalog record only without --checkout."
        );
      }
      // Phase 1: park the checkout. The catalog record still exists, so
      // phase 2 must complete or roll the rename back.
      await rename(project.path, tombstone);
    }
    // Phase 2: remove the catalog record, restoring the checkout on failure.
    let removed: Project;
    try {
      removed = removeRetiredProjectRecord(store, project.id);
    } catch (error) {
      if (existsSync(tombstone) && !existsSync(project.path)) {
        try {
          await rename(tombstone, project.path);
        } catch (rollbackError) {
          throw new Error(
            `Project delete failed and checkout rollback was incomplete: ${messageOf(error)}; `
            + `rollback failed: ${messageOf(rollbackError)}. `
            + `The checkout remains parked at ${tombstone}.`
          );
        }
      }
      throw error;
    }
    // Phase 3: the catalog record is gone, so the tombstone is unreferenced
    // garbage. Removal is best-effort; a leftover is reported, never silent.
    let tombstoneLeftover = false;
    if (existsSync(tombstone)) {
      try {
        await rm(tombstone, { recursive: true, force: true });
      } catch {
        tombstoneLeftover = true;
      }
    }
    return {
      output: `Deleted project ${removed.id} and its checkout at ${removed.path}.\n`
        + (tombstoneLeftover
          ? `The checkout tombstone could not be removed; delete it manually: ${tombstone}.\n`
          : ""),
      data: { project: removed, checkoutRemoved: true }
    };
  } finally {
    releaseMaintenance();
  }
}

/**
 * The catalog side of `project delete`: re-read under a transaction, re-assert
 * the retired state and the absence of any Task reference, then remove the
 * record. Fails closed with the record intact on every refusal.
 */
function removeRetiredProjectRecord(store: ProjectCommandStore, projectId: string): Project {
  return store.transaction((tx) => {
    const latest = requireProject(tx, projectId);
    if (latest.status !== "retired") {
      throw new Error(`Project changed while deleting: ${projectId}.`);
    }
    const references = tx.summarizeProjectReferences(latest.id);
    if (references.boundTaskIds.length > 0) {
      throw usageError(
        `Project cannot be deleted while Task records reference it: ${latest.id}. `
        + `Bound Tasks: ${references.boundTaskIds.join(", ")}. `
        + "Historical Task/Run/Review/Integration/Publication evidence must stay resolvable; keep the Project retired instead."
      );
    }
    if (!tx.removeProject(latest.id)) {
      throw new Error(`Project was already removed: ${latest.id}.`);
    }
    return latest;
  });
}

function parseResetArguments(
  args: readonly string[],
  usage: string
): Readonly<{ project: string; discardLocal: boolean }> {
  const positionals: string[] = [];
  let discardLocal = false;
  for (const value of args) {
    if (value === "--discard-local") {
      discardLocal = true;
      continue;
    }
    if (value.startsWith("--")) throw usageError(`Unknown option: ${value}. ${usage}`);
    positionals.push(value);
  }
  if (positionals.length !== 1) throw usageError(usage);
  return { project: requireText(positionals[0]!, "Project reference"), discardLocal };
}

function parseReplaceArguments(
  args: readonly string[],
  usage: string
): Readonly<{ project: string; discardLocal: boolean }> {
  return parseResetArguments(args, usage);
}

function parseRetireArguments(
  args: readonly string[],
  usage: string
): Readonly<{ project: string; reason: string }> {
  const positionals: string[] = [];
  let reason: string | undefined;
  for (let index = 0; index < args.length; index += 1) {
    const value = args[index]!;
    if (value === "--reason") {
      const next = args[index + 1];
      if (next === undefined || next.startsWith("--")) throw usageError(`--reason is required. ${usage}`);
      reason = requireText(next, "--reason");
      index += 1;
      continue;
    }
    if (value.startsWith("--")) throw usageError(`Unknown option: ${value}. ${usage}`);
    positionals.push(value);
  }
  if (positionals.length !== 1) throw usageError(usage);
  if (reason === undefined) throw usageError(`--reason is required. ${usage}`);
  return { project: requireText(positionals[0]!, "Project reference"), reason };
}

function parseDeleteArguments(
  args: readonly string[],
  usage: string
): Readonly<{ project: string; checkout: boolean; confirm: string }> {
  const positionals: string[] = [];
  let checkout = false;
  let confirm: string | undefined;
  for (let index = 0; index < args.length; index += 1) {
    const value = args[index]!;
    if (value === "--checkout") {
      checkout = true;
      continue;
    }
    if (value === "--confirm") {
      const next = args[index + 1];
      if (next === undefined || next.startsWith("--")) throw usageError(`--confirm is required. ${usage}`);
      confirm = requireText(next, "--confirm");
      index += 1;
      continue;
    }
    if (value.startsWith("--")) throw usageError(`Unknown option: ${value}. ${usage}`);
    positionals.push(value);
  }
  if (positionals.length !== 1) throw usageError(usage);
  if (confirm === undefined) throw usageError(`--confirm is required. ${usage}`);
  return { project: requireText(positionals[0]!, "Project reference"), checkout, confirm };
}

function renderAddedProject(created: Project): string {
  return [
    `Added project ${created.id}`,
    `Name: ${created.name}`,
    `Ownership: ${created.ownership}`,
    `Path: ${created.path}`,
    `Stable: ${created.stableBranch}`,
    `Development: ${created.developmentBranch}`
  ].join("\n").concat("\n");
}

function assertProjectAvailable(
  store: ProjectCommandStore,
  project: Project,
  exceptId?: string
): void {
  const others = store.listProjects().filter(({ id }) => id !== exceptId);
  if (others.some((entry) => entry.path === project.path)) {
    throw usageError(`Project path is already registered: ${project.path}.`);
  }
  for (const reference of [project.id, project.name, ...project.aliases]) {
    if (resolveProject(others, reference) !== null) {
      throw usageError(`Project reference is already registered: ${reference}.`);
    }
  }
}

function assertOutsideManagedWorktrees(
  path: string,
  workspace: string | undefined
): void {
  if (workspace === undefined) return;
  const managedRoot = join(resolve(workspace), "worktree");
  const candidate = resolve(path);
  const fromManagedRoot = relative(managedRoot, candidate);
  const toManagedRoot = relative(candidate, managedRoot);
  if (isContainedPath(fromManagedRoot) || isContainedPath(toManagedRoot)) {
    throw usageError("Project path is reserved for managed worktrees.");
  }
}

function isContainedPath(relativePath: string): boolean {
  return relativePath === ""
    || (!relativePath.startsWith("..") && !isAbsolute(relativePath));
}

function listProjects(args: readonly string[], store: ProjectCommandStore): string {
  if (args.length !== 0) throw usageError("Project list usage: yui project list.");
  const projects = store.listProjects();
  if (projects.length === 0) return "No projects found.\n";
  return `${renderTable(
    "Projects",
    [
      { header: "Project", minWidth: 8, maxWidth: 24 },
      { header: "Name", minWidth: 4, maxWidth: 28 },
      { header: "Status", minWidth: 6, maxWidth: 8 },
      { header: "Ownership", minWidth: 9, maxWidth: 10 },
      { header: "Path", minWidth: 8, maxWidth: 64 },
      { header: "Stable", minWidth: 6, maxWidth: 24 },
      { header: "Development", minWidth: 11, maxWidth: 24 }
    ],
    projects.map((project) => [
      project.id,
      project.name,
      project.status,
      project.ownership,
      project.path,
      project.stableBranch,
      project.developmentBranch
    ]),
    defaultTableWidth()
  )}\n`;
}

function showProject(args: readonly string[], store: ProjectCommandStore): string {
  if (args.length !== 1) throw usageError("Project show usage: yui project show <project>.");
  const project = requireProject(store, args[0]!);
  return [
    `Project: ${project.id}`,
    `Name: ${project.name}`,
    `Status: ${project.status}`,
    ...(project.retirement === undefined
      ? []
      : [
        `Retired by: ${project.retirement.retiredBy} at ${project.retirement.retiredAt}`,
        `Retirement reason: ${project.retirement.reason}`
      ]),
    `Ownership: ${project.ownership}`,
    `Aliases: ${project.aliases.length === 0 ? "-" : project.aliases.join(", ")}`,
    `Path: ${project.path}`,
    ...(project.remoteUrl === undefined ? [] : [`Remote: ${project.remoteUrl}`]),
    `Stable: ${project.stableBranch}`,
    `Development: ${project.developmentBranch}`,
    `Knowledge: ${project.knowledge.filter(({ status }) => status === "active").length} active`,
    `Knowledge proposals: ${project.knowledgeProposals.filter(({ status }) => status === "pending").length} pending`
  ].join("\n").concat("\n");
}

function projectKnowledge(
  args: readonly string[],
  store: ProjectCommandStore,
  options: ProjectCommandOptions
): Readonly<{
  output: string;
  projectId: string;
  knowledgeId?: string;
  all?: boolean;
}> {
  const [command, ...rest] = args;
  if (command === "add") {
    const usage = "Project knowledge add usage: yui project knowledge add <project> <title> --body <text>.";
    const parsed = parseSingleOption(rest, "--body", usage);
    if (parsed.positionals.length !== 2) throw usageError(usage);
    assertKnowledgeOperator(options, "add");
    const added = store.transaction((tx) => {
      const project = requireProject(tx, parsed.positionals[0]!);
      assertProjectActive(project, "add project knowledge");
      const id = nextKnowledgeId(project);
      tx.saveProject(addProjectKnowledge(
        project,
        id,
        parsed.positionals[1]!,
        parsed.value,
        (options.now ?? (() => new Date()))()
      ));
      return { id, projectId: project.id };
    });
    return {
      output: `Added project knowledge ${added.id} to ${added.projectId}\n`,
      projectId: added.projectId,
      knowledgeId: added.id
    };
  }
  if (command === "list") {
    const all = rest.includes("--all");
    const positionals = rest.filter((value) => value !== "--all");
    if (positionals.length !== 1 || rest.some((value) => value.startsWith("--") && value !== "--all")) {
      throw usageError("Project knowledge list usage: yui project knowledge list <project> [--all].");
    }
    const project = requireProject(store, positionals[0]!);
    const entries = all
      ? project.knowledge
      : project.knowledge.filter(({ status }) => status === "active");
    if (entries.length === 0) {
      return {
        output: "No project knowledge found.\n",
        projectId: project.id,
        all
      };
    }
    return {
      output: `${renderTable(
      `Project knowledge: ${project.name}`,
      [
        { header: "Knowledge", minWidth: 9, maxWidth: 24 },
        { header: "Title", minWidth: 8, maxWidth: 64 },
        { header: "Status", minWidth: 6, maxWidth: 10 }
      ],
      entries.map((entry) => [entry.id, entry.title, entry.status]),
      defaultTableWidth()
      )}\n`,
      projectId: project.id,
      all
    };
  }
  if (command === "show") {
    if (rest.length !== 2) {
      throw usageError("Project knowledge show usage: yui project knowledge show <project> <knowledge>.");
    }
    const project = requireProject(store, rest[0]!);
    const entry = project.knowledge.find(({ id }) => id === rest[1]);
    if (entry === undefined) throw usageError(`Project knowledge not found: ${rest[1]}.`);
    return {
      output: [
        `Knowledge: ${entry.id}`,
        `Project: ${project.id}`,
        `Title: ${entry.title}`,
        `Status: ${entry.status}`,
        ...(entry.provenance === undefined ? [] : [
          `Source: ${entry.provenance.taskId}`
            + `${entry.provenance.decisionId === undefined ? "" : `/${entry.provenance.decisionId}`}`
            + `${entry.provenance.milestoneId === undefined ? "" : `/${entry.provenance.milestoneId}`}`
            + `${entry.provenance.commitSha === undefined ? "" : `@${entry.provenance.commitSha}`}`,
          ...(entry.provenance.evidenceDigest === undefined
            ? []
            : [`Evidence digest: ${entry.provenance.evidenceDigest}`]),
          ...(entry.provenance.proposalId === undefined
            ? []
            : [`Proposal: ${entry.provenance.proposalId}`]),
          ...(entry.provenance.promotedBy === undefined
            ? []
            : [`Promoted by: ${entry.provenance.promotedBy} at ${entry.provenance.promotedAt ?? "?"}`])
        ]),
        "",
        entry.body
      ].join("\n").concat("\n"),
      projectId: project.id,
      knowledgeId: entry.id
    };
  }
  if (command === "update") {
    throw usageError(
      "Direct Project Knowledge update is not supported because it would erase version history. "
      + "Propose the replacement with `yui project knowledge propose <project> ... --task <task>` "
      + "and let the Operator apply it with `yui project knowledge accept <project> <proposal> "
      + "--update <knowledge>`; use --supersedes when replacing Knowledge without proposal history."
    );
  }
  if (command === "retire") {
    if (rest.length !== 2) {
      throw usageError("Project knowledge retire usage: yui project knowledge retire <project> <knowledge>.");
    }
    assertKnowledgeOperator(options, "retire");
    const updated = store.transaction((tx) => {
      const project = requireProject(tx, rest[0]!);
      assertProjectActive(project, "retire project knowledge");
      const next = retireProjectKnowledge(
        project,
        rest[1]!,
        (options.now ?? (() => new Date()))()
      );
      tx.saveProject(next);
      return next;
    });
    return {
      output: `Retired project knowledge ${rest[1]} in ${updated.id}\n`,
      projectId: updated.id,
      knowledgeId: rest[1]!
    };
  }
  if (command === "propose") {
    return proposeKnowledge(rest, store, options);
  }
  if (command === "proposals") {
    const [sub, ...subRest] = rest;
    if (sub === "list") return listKnowledgeProposals(subRest, store);
    if (sub === "show") return showKnowledgeProposal(subRest, store);
    throw usageError("Project knowledge proposals usage: yui project knowledge proposals list <project>"
      + " [--status pending|accepted|rejected] [--all] | yui project knowledge proposals show <project> <proposal>.");
  }
  if (command === "accept") {
    return acceptKnowledgeProposal(rest, store, options);
  }
  if (command === "reject") {
    return rejectKnowledgeProposal(rest, store, options);
  }
  throw usageError(command === undefined
    ? "Project knowledge command is required."
    : `Unknown command: project knowledge ${command}`);
}

function requireProject(store: ProjectCommandStore, reference: string): Project {
  const project = resolveProject(store.listProjects(), reference);
  if (project === null) throw usageError(`Project not found: ${reference}.`);
  return project;
}

function nextKnowledgeId(project: Project): string {
  const used = new Set(project.knowledge.map(({ id }) => id));
  for (let index = 1; ; index += 1) {
    const id = `knowledge-${index}`;
    if (!used.has(id)) return id;
  }
}

function nextProposalId(project: Project): string {
  const used = new Set(project.knowledgeProposals.map(({ id }) => id));
  for (let index = 1; ; index += 1) {
    const id = `proposal-${index}`;
    if (!used.has(id)) return id;
  }
}

/**
 * Project Knowledge is an Operator authority. A managed Task Session (Leader,
 * Reviewer, Worker) must use `propose` and let an Operator accept; it can
 * never write the authoritative list directly.
 */
function assertKnowledgeOperator(options: ProjectCommandOptions, action: string): void {
  const actor = projectActor(options.environment);
  if (actor === "agent") {
    throw usageError(
      `Project Knowledge is an Operator authority; a managed Task Session cannot ${action} it.`
      + " Propose a candidate with `yui project knowledge propose` instead."
    );
  }
}

type KnowledgeProposalOptions = Readonly<{
  project: string;
  title: string;
  body: string;
  task: string;
  decision?: string;
  milestone?: string;
  commit?: string;
  scope?: string;
  expiresWhen?: string;
  supersedes?: string;
}>;

const PROPOSE_OPTIONS = [
  "--title", "--body", "--task", "--decision", "--milestone",
  "--commit", "--scope", "--expires-when", "--supersedes"
] as const;

function parseKnowledgeProposalOptions(
  args: readonly string[],
  usage: string
): KnowledgeProposalOptions {
  const values: Record<string, string> = {};
  const positionals: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const value = args[index]!;
    if (PROPOSE_OPTIONS.includes(value as typeof PROPOSE_OPTIONS[number])) {
      if (values[value] !== undefined) {
        throw usageError(`${value} may only be provided once. ${usage}`);
      }
      const next = args[index + 1];
      if (next === undefined || next.startsWith("--")) {
        throw usageError(`${value} is required. ${usage}`);
      }
      values[value] = requireText(next, value);
      index += 1;
    } else if (value.startsWith("--")) {
      throw usageError(`Unknown option: ${value}. ${usage}`);
    } else {
      positionals.push(value);
    }
  }
  if (positionals.length !== 1) throw usageError(usage);
  if (values["--title"] === undefined || values["--body"] === undefined || values["--task"] === undefined) {
    throw usageError(usage);
  }
  return {
    project: positionals[0]!,
    title: values["--title"]!,
    body: values["--body"]!,
    task: values["--task"]!,
    ...(values["--decision"] === undefined ? {} : { decision: values["--decision"] }),
    ...(values["--milestone"] === undefined ? {} : { milestone: values["--milestone"] }),
    ...(values["--commit"] === undefined ? {} : { commit: values["--commit"] }),
    ...(values["--scope"] === undefined ? {} : { scope: values["--scope"] }),
    ...(values["--expires-when"] === undefined ? {} : { expiresWhen: values["--expires-when"] }),
    ...(values["--supersedes"] === undefined ? {} : { supersedes: values["--supersedes"] })
  };
}

/**
 * Leader-proposed promotion candidate. The proposal is workflow state, not
 * Knowledge: it never appears in `project knowledge list/show` until an
 * Operator accepts it. A managed Task Session may propose only for its own
 * Task. The same candidate (source identity + title + body) is deduplicated to
 * the existing pending proposal instead of creating a second copy.
 */
function proposeKnowledge(
  args: readonly string[],
  store: ProjectCommandStore,
  options: ProjectCommandOptions
): ProjectKnowledgeCommandResult {
  const usage = "Project knowledge propose usage: yui project knowledge propose <project>"
    + " --title <text> --body <text> --task <task> [--decision <id>] [--milestone <id>]"
    + " [--commit <sha>] [--scope <text>] [--expires-when <text>] [--supersedes <knowledge-id>].";
  const parsed = parseKnowledgeProposalOptions(args, usage);
  const actor = projectActor(options.environment);
  if (actor === "agent" && options.environment?.YUI_TASK_ID !== parsed.task) {
    throw usageError("A managed Task Session may propose Knowledge only for its own Task.");
  }
  if (actor === "agent"
    && options.environment?.YUI_ROLE !== "leader"
    && options.environment?.YUI_ROLE !== "reviewer") {
    throw usageError("Only a Leader or Reviewer Session may propose Knowledge promotion.");
  }
  const proposedBy = actor === "agent"
    ? (options.environment?.YUI_ROLE === "reviewer" ? "reviewer" as const : "leader" as const)
    : actor;
  const now = (options.now ?? (() => new Date()))();
  const result = store.transaction((tx) => {
    const project = requireProject(tx, parsed.project);
    assertProjectActive(project, "propose project knowledge");
    const source = requireProposalEvidence(tx, parsed);
    const fingerprint = knowledgeProposalFingerprint({
      projectId: project.id,
      source,
      title: parsed.title,
      body: parsed.body
    });
    const pending = findKnowledgeProposalByFingerprint(project, fingerprint, "pending");
    if (pending !== null) {
      return {
        projectId: project.id,
        proposalId: pending.id,
        deduped: true,
        alreadyAccepted: false
      };
    }
    const accepted = findKnowledgeProposalByFingerprint(project, fingerprint, "accepted");
    if (accepted !== null) {
      return {
        projectId: project.id,
        proposalId: accepted.id,
        knowledgeId: accepted.knowledgeId,
        deduped: true,
        alreadyAccepted: true
      };
    }
    const proposal: KnowledgeProposal = {
      schemaVersion: 1,
      id: nextProposalId(project),
      projectId: project.id,
      title: parsed.title,
      body: parsed.body,
      status: "pending",
      source,
      ...(parsed.scope === undefined ? {} : { scope: parsed.scope }),
      ...(parsed.expiresWhen === undefined ? {} : { expiresWhen: parsed.expiresWhen }),
      ...(parsed.supersedes === undefined ? {} : { supersedesKnowledgeId: parsed.supersedes }),
      fingerprint,
      ...(source.evidenceDigest === undefined ? {} : { evidenceDigest: source.evidenceDigest }),
      proposedBy,
      proposedAt: now.toISOString(),
      updatedAt: now.toISOString()
    };
    tx.saveProject(addKnowledgeProposal(project, proposal));
    return {
      projectId: project.id,
      proposalId: proposal.id,
      deduped: false,
      alreadyAccepted: false
    };
  });
  const lines = [
    result.deduped
      ? `Knowledge proposal ${result.proposalId} already exists for ${result.projectId}`
      : `Proposed knowledge ${result.proposalId} for ${result.projectId}`,
    result.alreadyAccepted
      ? `Already accepted as knowledge ${result.knowledgeId ?? "?"}`
      : "Awaiting Operator decision: yui project knowledge proposals list "
        + `${result.projectId} / yui project knowledge accept ${result.projectId} ${result.proposalId}`
  ];
  return {
    output: `${lines.join("\n")}\n`,
    projectId: result.projectId,
    proposalId: result.proposalId,
    ...(result.knowledgeId === undefined ? {} : { knowledgeId: result.knowledgeId })
  };
}

type ProposalEvidence = KnowledgeProposalSource & Readonly<{ evidenceDigest?: string }>;

/**
 * Verify the cited Task/Decision/Milestone exist and capture the evidence
 * digest at proposal time, so a later Agent can verify the source record.
 */
function requireProposalEvidence(
  store: ProjectCommandStore,
  parsed: KnowledgeProposalOptions
): ProposalEvidence {
  if (store.getTask === undefined) {
    throw usageError("Knowledge promotion requires Task evidence, which this store does not provide.");
  }
  const task = store.getTask(parsed.task);
  if (task === null) throw usageError(`Task not found: ${parsed.task}.`);
  const source: KnowledgeProposalSource = {
    taskId: task.id,
    ...(parsed.decision === undefined ? {} : { decisionId: parsed.decision }),
    ...(parsed.milestone === undefined ? {} : { milestoneId: parsed.milestone }),
    ...(parsed.commit === undefined ? {} : { commitSha: parsed.commit })
  };
  let evidence: string;
  if (parsed.decision !== undefined) {
    if (store.getDecision === undefined) {
      throw usageError("Knowledge promotion requires Decision evidence, which this store does not provide.");
    }
    const decision = store.getDecision(task.id, parsed.decision);
    if (decision === null) {
      throw usageError(`Decision not found: ${parsed.decision} in Task ${task.id}.`);
    }
    evidence = `${decision.title}\n${decision.rationale}`;
  } else if (parsed.milestone !== undefined) {
    if (store.getMilestone === undefined) {
      throw usageError("Knowledge promotion requires Milestone evidence, which this store does not provide.");
    }
    const milestone = store.getMilestone(task.id, parsed.milestone);
    if (milestone === null) {
      throw usageError(`Milestone not found: ${parsed.milestone} in Task ${task.id}.`);
    }
    evidence = `${milestone.title}\n${milestone.summary}`;
  } else {
    evidence = task.completionSummary ?? task.title;
  }
  return { ...source, evidenceDigest: knowledgeEvidenceDigest(evidence) };
}

function listKnowledgeProposals(
  args: readonly string[],
  store: ProjectCommandStore
): ProjectKnowledgeCommandResult {
  const usage = "Project knowledge proposals list usage: yui project knowledge proposals list <project>"
    + " [--status pending|accepted|rejected] [--all].";
  const positionals: string[] = [];
  let status: "pending" | "accepted" | "rejected" | undefined = "pending";
  let sawAll = false;
  let sawStatus = false;
  for (let index = 0; index < args.length; index += 1) {
    const value = args[index]!;
    if (value === "--all") {
      if (sawStatus) throw usageError(`--all and --status are mutually exclusive. ${usage}`);
      sawAll = true;
      status = undefined;
    } else if (value === "--status") {
      if (sawAll) throw usageError(`--all and --status are mutually exclusive. ${usage}`);
      sawStatus = true;
      const next = args[index + 1];
      if (next === undefined || next.startsWith("--")) throw usageError(usage);
      if (next !== "pending" && next !== "accepted" && next !== "rejected") throw usageError(usage);
      status = next;
      index += 1;
    } else if (value.startsWith("--")) {
      throw usageError(`Unknown option: ${value}. ${usage}`);
    } else {
      positionals.push(value);
    }
  }
  if (positionals.length !== 1) throw usageError(usage);
  const project = requireProject(store, positionals[0]!);
  const entries = project.knowledgeProposals
    .filter((entry) => status === undefined || entry.status === status)
    .slice()
    .sort((a, b) => a.id.localeCompare(b.id));
  if (entries.length === 0) {
    return {
      output: "No knowledge proposals found.\n",
      projectId: project.id,
      proposals: []
    };
  }
  return {
    output: `${renderTable(
      `Knowledge proposals: ${project.name}`,
      [
        { header: "Proposal", minWidth: 9, maxWidth: 24 },
        { header: "Title", minWidth: 8, maxWidth: 48 },
        { header: "Status", minWidth: 7, maxWidth: 10 },
        { header: "Source", minWidth: 8, maxWidth: 32 },
        { header: "Knowledge", minWidth: 9, maxWidth: 24 }
      ],
      entries.map((entry) => [
        entry.id,
        entry.title,
        entry.status,
        `${entry.source.taskId}`
          + `${entry.source.decisionId === undefined ? "" : `/${entry.source.decisionId}`}`
          + `${entry.source.milestoneId === undefined ? "" : `/${entry.source.milestoneId}`}`,
        entry.knowledgeId ?? "-"
      ]),
      defaultTableWidth()
    )}\n`,
    projectId: project.id,
    proposals: entries
  };
}

function showKnowledgeProposal(
  args: readonly string[],
  store: ProjectCommandStore
): ProjectKnowledgeCommandResult {
  const usage = "Project knowledge proposals show usage: yui project knowledge proposals show <project> <proposal>.";
  if (args.length !== 2) throw usageError(usage);
  const project = requireProject(store, args[0]!);
  const proposal = findKnowledgeProposal(project, args[1]!);
  if (proposal === null) {
    throw usageError(`Knowledge proposal not found: ${args[1]!}.`);
  }
  const lines = [
    `Proposal: ${proposal.id}`,
    `Project: ${project.id}`,
    `Title: ${proposal.title}`,
    `Status: ${proposal.status}`,
    `Source: ${proposal.source.taskId}`
      + `${proposal.source.decisionId === undefined ? "" : `/${proposal.source.decisionId}`}`
      + `${proposal.source.milestoneId === undefined ? "" : `/${proposal.source.milestoneId}`}`
      + `${proposal.source.commitSha === undefined ? "" : `@${proposal.source.commitSha}`}`,
    `Proposed by: ${proposal.proposedBy} at ${proposal.proposedAt}`,
    ...(proposal.scope === undefined ? [] : [`Scope: ${proposal.scope}`]),
    ...(proposal.expiresWhen === undefined ? [] : [`Expires when: ${proposal.expiresWhen}`]),
    ...(proposal.supersedesKnowledgeId === undefined
      ? []
      : [`Supersedes: ${proposal.supersedesKnowledgeId}`]),
    ...(proposal.evidenceDigest === undefined ? [] : [`Evidence digest: ${proposal.evidenceDigest}`]),
    ...(proposal.decidedBy === undefined ? [] : [`Decided by: ${proposal.decidedBy} at ${proposal.decidedAt ?? "?"}`]),
    ...(proposal.decisionReason === undefined ? [] : [`Decision reason: ${proposal.decisionReason}`]),
    ...(proposal.knowledgeId === undefined ? [] : [`Knowledge: ${proposal.knowledgeId}`]),
    "",
    proposal.body
  ];
  return {
    output: `${lines.join("\n")}\n`,
    projectId: project.id,
    proposalId: proposal.id,
    proposals: [proposal]
  };
}

/**
 * Operator acceptance. The pure {@link planKnowledgeAcceptance} policy decides
 * create/update/duplicate/conflict; a conflict fails closed so a candidate can
 * never silently overwrite an existing conclusion. The accepted Knowledge
 * entry carries the source provenance and fingerprint, and the proposal record
 * retains the decision for history.
 */
function acceptKnowledgeProposal(
  args: readonly string[],
  store: ProjectCommandStore,
  options: ProjectCommandOptions
): ProjectKnowledgeCommandResult {
  const usage = "Project knowledge accept usage: yui project knowledge accept <project> <proposal>"
    + " [--update <knowledge-id>].";
  const parsed = parseAcceptArguments(args, usage);
  assertKnowledgeOperator(options, "accept");
  const actor = projectActor(options.environment);
  const decidedBy = actor === "operator" ? "operator" as const : "user" as const;
  const now = (options.now ?? (() => new Date()))();
  const accepted = store.transaction((tx) => {
    const project = requireProject(tx, parsed.project);
    assertProjectActive(project, "accept project knowledge");
    const proposal = findKnowledgeProposal(project, parsed.proposal);
    if (proposal === null) {
      throw usageError(`Knowledge proposal not found: ${parsed.proposal}.`);
    }
    if (proposal.status !== "pending") {
      throw usageError(`Knowledge proposal is already ${proposal.status}: ${proposal.id}.`);
    }
    let next = project;
    let knowledgeId: string;
    let duplicate = false;
    if (parsed.update !== undefined) {
      const target = next.knowledge.find((entry) => entry.id === parsed.update);
      if (target === undefined) {
        throw usageError(`Knowledge not found: ${parsed.update}.`);
      }
      if (target.status !== "active") {
        throw usageError(`Knowledge is not active: ${target.id}.`);
      }
      const previousProposal = target.provenance?.proposalId === undefined
        ? null
        : findKnowledgeProposal(next, target.provenance.proposalId);
      if (previousProposal === null
        || previousProposal.status !== "accepted"
        || previousProposal.knowledgeId !== target.id
        || previousProposal.title !== target.title
        || previousProposal.body !== target.body) {
        throw usageError(
          `Knowledge ${target.id} has no complete proposal-backed version history. `
          + "Create the replacement proposal with --supersedes instead of --update."
        );
      }
      knowledgeId = target.id;
      next = updateProjectKnowledge(next, knowledgeId, {
        title: proposal.title,
        body: proposal.body
      }, now);
      next = withKnowledgeProvenance(next, knowledgeId, {
        ...provenanceFromProposal(proposal),
        proposalId: proposal.id,
        promotedBy: decidedBy,
        promotedAt: now.toISOString()
      }, now);
    } else {
      const plan = planKnowledgeAcceptance(next, proposal);
      if (plan.kind === "duplicate") {
        knowledgeId = plan.knowledgeId;
        duplicate = true;
      } else {
        if (plan.kind === "create" && plan.supersedesKnowledgeId !== undefined) {
          next = retireProjectKnowledge(next, plan.supersedesKnowledgeId, now);
        }
        knowledgeId = nextKnowledgeId(next);
        next = addProjectKnowledge(
          next,
          knowledgeId,
          proposal.title,
          proposal.body,
          now,
          {
            ...provenanceFromProposal(proposal),
            proposalId: proposal.id,
            promotedBy: decidedBy,
            promotedAt: now.toISOString()
          }
        );
      }
    }
    next = decideKnowledgeProposal(next, proposal.id, {
      by: decidedBy,
      knowledgeId
    }, now);
    tx.saveProject(next);
    return { projectId: next.id, proposalId: proposal.id, knowledgeId, duplicate };
  });
  return {
    output: `${accepted.duplicate
      ? `Knowledge proposal ${accepted.proposalId} was already promoted as ${accepted.knowledgeId}`
      : `Accepted knowledge proposal ${accepted.proposalId} as ${accepted.knowledgeId}`} in ${accepted.projectId}\n`,
    projectId: accepted.projectId,
    proposalId: accepted.proposalId,
    knowledgeId: accepted.knowledgeId
  };
}

function rejectKnowledgeProposal(
  args: readonly string[],
  store: ProjectCommandStore,
  options: ProjectCommandOptions
): ProjectKnowledgeCommandResult {
  const usage = "Project knowledge reject usage: yui project knowledge reject <project> <proposal>"
    + " --reason <text>.";
  const parsed = parseSingleOption(args, "--reason", usage);
  if (parsed.positionals.length !== 2) throw usageError(usage);
  assertKnowledgeOperator(options, "reject");
  const actor = projectActor(options.environment);
  const decidedBy = actor === "operator" ? "operator" as const : "user" as const;
  const rejected = store.transaction((tx) => {
    const project = requireProject(tx, parsed.positionals[0]!);
    assertProjectActive(project, "reject project knowledge");
    const proposal = findKnowledgeProposal(project, parsed.positionals[1]!);
    if (proposal === null) {
      throw usageError(`Knowledge proposal not found: ${parsed.positionals[1]!}.`);
    }
    if (proposal.status !== "pending") {
      throw usageError(`Knowledge proposal is already ${proposal.status}: ${proposal.id}.`);
    }
    const next = decideKnowledgeProposal(project, proposal.id, {
      by: decidedBy,
      reason: parsed.value
    }, (options.now ?? (() => new Date()))());
    tx.saveProject(next);
    return { projectId: next.id, proposalId: proposal.id };
  });
  return {
    output: `Rejected knowledge proposal ${rejected.proposalId} in ${rejected.projectId}\n`,
    projectId: rejected.projectId,
    proposalId: rejected.proposalId
  };
}

function provenanceFromProposal(proposal: KnowledgeProposal): ProjectKnowledgeProvenance {
  return {
    taskId: proposal.source.taskId,
    ...(proposal.source.decisionId === undefined ? {} : { decisionId: proposal.source.decisionId }),
    ...(proposal.source.milestoneId === undefined ? {} : { milestoneId: proposal.source.milestoneId }),
    ...(proposal.source.commitSha === undefined ? {} : { commitSha: proposal.source.commitSha }),
    ...(proposal.evidenceDigest === undefined ? {} : { evidenceDigest: proposal.evidenceDigest }),
    fingerprint: proposal.fingerprint
  };
}

/** Replace a Knowledge entry's provenance (used by accept --update). */
function withKnowledgeProvenance(
  project: Project,
  knowledgeId: string,
  provenance: ProjectKnowledgeProvenance,
  now: Date
): Project {
  const timestamp = now.toISOString();
  const knowledge = project.knowledge.map((entry) => (
    entry.id === knowledgeId
      ? { ...entry, provenance, updatedAt: timestamp }
      : entry
  ));
  return validateProject({ ...project, knowledge, updatedAt: timestamp });
}

function parseAcceptArguments(
  args: readonly string[],
  usage: string
): Readonly<{ project: string; proposal: string; update?: string }> {
  const positionals: string[] = [];
  let update: string | undefined;
  for (let index = 0; index < args.length; index += 1) {
    const value = args[index]!;
    if (value === "--update") {
      if (update !== undefined) throw usageError(`--update may only be provided once. ${usage}`);
      const next = args[index + 1];
      if (next === undefined || next.startsWith("--")) throw usageError(`--update is required. ${usage}`);
      update = requireText(next, "--update");
      index += 1;
    } else if (value.startsWith("--")) {
      throw usageError(`Unknown option: ${value}. ${usage}`);
    } else {
      positionals.push(value);
    }
  }
  if (positionals.length !== 2) throw usageError(usage);
  return { project: positionals[0]!, proposal: positionals[1]!, ...(update === undefined ? {} : { update }) };
}

type ProjectKnowledgeCommandResult = Readonly<{
  output: string;
  projectId: string;
  proposalId?: string;
  knowledgeId?: string;
  proposals?: readonly KnowledgeProposal[];
}>;

function parseAddArguments(
  args: readonly string[],
  usage: string
): Readonly<{
  name: string;
  path: string;
  aliases: readonly string[];
  remote?: string;
  stable?: string;
  development?: string;
}> {
  const positionals: string[] = [];
  const aliases: string[] = [];
  let remote: string | undefined;
  let stable: string | undefined;
  let development: string | undefined;
  for (let index = 0; index < args.length; index += 1) {
    const value = args[index]!;
    if (["--alias", "--remote", "--stable", "--development"].includes(value)) {
      const next = args[index + 1];
      if (next === undefined || next.startsWith("--")) throw usageError(`${value} is required. ${usage}`);
      if (value === "--alias") aliases.push(requireText(next, value));
      else if (value === "--remote") {
        if (remote !== undefined) throw usageError(`--remote may only be provided once. ${usage}`);
        remote = requireText(next, value);
      } else if (value === "--stable") {
        if (stable !== undefined) throw usageError(`--stable may only be provided once. ${usage}`);
        stable = requireText(next, value);
      } else {
        if (development !== undefined) throw usageError(`--development may only be provided once. ${usage}`);
        development = requireText(next, value);
      }
      index += 1;
      continue;
    }
    if (value.startsWith("--")) throw usageError(`Unknown option: ${value}. ${usage}`);
    positionals.push(value);
  }
  if (positionals.length !== 2) throw usageError(usage);
  return {
    name: requireText(positionals[0]!, "Project name"),
    path: requireText(positionals[1]!, "Project path"),
    aliases,
    ...(remote === undefined ? {} : { remote }),
    ...(stable === undefined ? {} : { stable }),
    ...(development === undefined ? {} : { development })
  };
}

function parseProjectUpdateArguments(
  args: readonly string[],
  usage: string
): Readonly<{
  reference: string;
  aliases?: readonly string[];
  remote?: string | null;
  stable?: string;
  development?: string;
}> {
  const positionals: string[] = [];
  const aliases: string[] = [];
  let aliasesProvided = false;
  let clearAliases = false;
  let remote: string | null | undefined;
  let stable: string | undefined;
  let development: string | undefined;
  for (let index = 0; index < args.length; index += 1) {
    const value = args[index]!;
    if (value === "--clear-aliases") {
      clearAliases = true;
      continue;
    }
    if (value === "--clear-remote") {
      if (remote !== undefined) throw usageError(`Remote may only be changed once. ${usage}`);
      remote = null;
      continue;
    }
    if (["--alias", "--remote", "--stable", "--development"].includes(value)) {
      const next = args[index + 1];
      if (next === undefined || next.startsWith("--")) throw usageError(`${value} is required. ${usage}`);
      if (value === "--alias") {
        aliasesProvided = true;
        aliases.push(requireText(next, value));
      } else if (value === "--remote") {
        if (remote !== undefined) throw usageError(`Remote may only be changed once. ${usage}`);
        remote = requireText(next, value);
      } else if (value === "--stable") {
        if (stable !== undefined) throw usageError(`--stable may only be provided once. ${usage}`);
        stable = requireText(next, value);
      } else {
        if (development !== undefined) throw usageError(`--development may only be provided once. ${usage}`);
        development = requireText(next, value);
      }
      index += 1;
      continue;
    }
    if (value.startsWith("--")) throw usageError(`Unknown option: ${value}. ${usage}`);
    positionals.push(value);
  }
  if (positionals.length !== 1 || (aliasesProvided && clearAliases)) throw usageError(usage);
  if (!aliasesProvided && !clearAliases && remote === undefined
    && stable === undefined && development === undefined) throw usageError(usage);
  return {
    reference: requireText(positionals[0]!, "Project reference"),
    ...(aliasesProvided || clearAliases ? { aliases: clearAliases ? [] : aliases } : {}),
    ...(remote === undefined ? {} : { remote }),
    ...(stable === undefined ? {} : { stable }),
    ...(development === undefined ? {} : { development })
  };
}

function parseCloneArguments(
  args: readonly string[],
  usage: string
): Readonly<{
  name: string;
  remote: string;
  aliases: readonly string[];
  stable?: string;
  development?: string;
  external: boolean;
}> {
  const positionals: string[] = [];
  const aliases: string[] = [];
  let stable: string | undefined;
  let development: string | undefined;
  let external = false;
  for (let index = 0; index < args.length; index += 1) {
    const value = args[index]!;
    if (value === "--external") {
      external = true;
      continue;
    }
    if (["--alias", "--stable", "--development"].includes(value)) {
      const next = args[index + 1];
      if (next === undefined || next.startsWith("--")) {
        throw usageError(`${value} is required. ${usage}`);
      }
      if (value === "--alias") aliases.push(requireText(next, value));
      else if (value === "--stable") {
        if (stable !== undefined) throw usageError(`--stable may only be provided once. ${usage}`);
        stable = requireText(next, value);
      } else {
        if (development !== undefined) {
          throw usageError(`--development may only be provided once. ${usage}`);
        }
        development = requireText(next, value);
      }
      index += 1;
      continue;
    }
    if (value.startsWith("--")) throw usageError(`Unknown option: ${value}. ${usage}`);
    positionals.push(value);
  }
  if (positionals.length !== 2) throw usageError(usage);
  return {
    name: requireText(positionals[0]!, "Project name"),
    remote: requireText(positionals[1]!, "Project remote"),
    aliases,
    ...(stable === undefined ? {} : { stable }),
    ...(development === undefined ? {} : { development }),
    external
  };
}

function parseMigrateArguments(
  args: readonly string[],
  usage: string
): Readonly<{ project: string; preflight: boolean }> {
  const positionals: string[] = [];
  let preflight = false;
  for (const value of args) {
    if (value === "--preflight") {
      preflight = true;
      continue;
    }
    if (value.startsWith("--")) throw usageError(`Unknown option: ${value}. ${usage}`);
    positionals.push(value);
  }
  if (positionals.length !== 1) throw usageError(usage);
  return { project: requireText(positionals[0]!, "Project reference"), preflight };
}

function parseSingleOption(
  args: readonly string[],
  option: string,
  usage: string
): Readonly<{ positionals: string[]; value: string }> {
  const positionals: string[] = [];
  let found: string | undefined;
  for (let index = 0; index < args.length; index += 1) {
    const value = args[index]!;
    if (value === option) {
      if (found !== undefined) throw usageError(`${option} may only be provided once. ${usage}`);
      const next = args[index + 1];
      if (next === undefined || next.startsWith("--")) throw usageError(`${option} is required. ${usage}`);
      found = requireText(next, option);
      index += 1;
    } else if (value.startsWith("--")) {
      throw usageError(`Unknown option: ${value}. ${usage}`);
    } else {
      positionals.push(value);
    }
  }
  if (found === undefined) throw usageError(`${option} is required. ${usage}`);
  return { positionals, value: found };
}

function requireText(value: string, label: string): string {
  const normalized = value.trim();
  if (normalized.length === 0 || normalized.includes("\0")) {
    throw usageError(`${label} is required.`);
  }
  return normalized;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
