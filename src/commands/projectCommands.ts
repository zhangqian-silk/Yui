import { existsSync } from "node:fs";
import { readdir, rm } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";

import { usageError } from "../errors/cliError.js";
import { defaultTableWidth, renderTable } from "../output/table.js";
import { NodeGitWorkspace, type GitWorkspacePort } from "../repository/gitWorkspace.js";
import { acquireProjectMaintenanceLock } from "../repository/projectMaintenanceLock.js";
import {
  addProjectKnowledge,
  createProject,
  managedProjectPath,
  retireProjectKnowledge,
  resolveProject,
  updateProjectKnowledge,
  updateProjectMetadata,
  validateProject,
  validateProjectName,
  type Project,
  type ProjectOwnership
} from "../repository/project.js";

export type ProjectCommandStore = Readonly<{
  transaction<T>(execute: (store: ProjectCommandStore) => T): T;
  nextProjectId(): string;
  createProjectIfAbsent(project: Project): Project | null;
  saveProject(project: Project): void;
  listProjects(): Project[];
  getConfig(): Readonly<{ defaultWorkspace?: string }>;
  /** The persistent Home root; managed Project repositories live below it. */
  rootDirectory(): string;
}>;

export type ProjectCommandOptions = Readonly<{
  git?: Pick<
    GitWorkspacePort,
    "inspect" | "headRef" | "isClean" | "refresh" | "clone" | "ensureLocalBranch"
      | "resolveRemoteBaseline" | "copyRefs"
  >;
  now?: () => Date;
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
  if (project.remoteUrl === undefined) {
    throw usageError(`Project refresh requires a remote URL: ${project.id}.`);
  }
  if (project.stableBranch !== project.developmentBranch) {
    throw usageError(
      `Project refresh requires matching stable and development branches: ${project.id}.`
    );
  }
  const refreshed = await (options.git ?? new NodeGitWorkspace()).refresh({
    repositoryPath: project.path,
    remoteUrl: project.remoteUrl,
    stableRef: project.stableBranch
  });
  return { project, ...refreshed };
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
      const head = await git.clone({
        remoteUrl: project.remoteUrl,
        destination: verifyRoot,
        ...(project.stableBranch === "HEAD" ? {} : { branch: project.stableBranch })
      });
      prepared = true;
      const stable = project.stableBranch === "HEAD"
        ? head
        : await git.inspect(verifyRoot, project.stableBranch);
      if (head.baseCommit !== stable.baseCommit) {
        throw new Error(`Project checkout is not on its stable ref: ${project.stableBranch}.`);
      }
      if (project.developmentBranch !== project.stableBranch) {
        await git.ensureLocalBranch(verifyRoot, project.developmentBranch);
      }
      await assertRemoteBranchesVerified(
        git,
        verifyRoot,
        project.remoteUrl,
        [
          { ref: project.stableBranch, localCommit: head.baseCommit },
          ...(project.developmentBranch === project.stableBranch
            ? []
            : [{
                ref: project.developmentBranch,
                localCommit: (await git.inspect(verifyRoot, project.developmentBranch)).baseCommit
              }])
        ]
      );
      const copyRefs = git.copyRefs;
      if (typeof copyRefs !== "function") {
        throw new Error(`Git workspace cannot preserve local Yui refs for Project: ${project.id}.`);
      }
      await copyRefs.call(git, {
        sourceRepositoryPath: project.path,
        destinationRepositoryPath: verifyRoot,
        patterns: ["refs/heads/yui/", "refs/yui/archive/"]
      });
      if (parsed.preflight) {
        return { project, path: destination, preflight: true };
      }
      const switched = store.transaction((tx) => {
        const latest = requireProject(tx, project.id);
        if (latest.ownership !== "external"
          || latest.path !== project.path
          || latest.remoteUrl !== project.remoteUrl) {
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
 * never deleted.
 */
async function removeUnreferencedClone(
  store: ProjectCommandStore,
  destination: string,
  migratingProjectId: string
): Promise<void> {
  if (!existsSync(destination)) return;
  const registered = store.listProjects().find(({ path }) => path === destination);
  if (registered !== undefined && registered.id !== migratingProjectId) {
    throw new Error(`Managed Project path is already registered: ${destination}.`);
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
      { header: "Ownership", minWidth: 9, maxWidth: 10 },
      { header: "Path", minWidth: 8, maxWidth: 64 },
      { header: "Stable", minWidth: 6, maxWidth: 24 },
      { header: "Development", minWidth: 11, maxWidth: 24 }
    ],
    projects.map((project) => [
      project.id,
      project.name,
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
    `Ownership: ${project.ownership}`,
    `Aliases: ${project.aliases.length === 0 ? "-" : project.aliases.join(", ")}`,
    `Path: ${project.path}`,
    ...(project.remoteUrl === undefined ? [] : [`Remote: ${project.remoteUrl}`]),
    `Stable: ${project.stableBranch}`,
    `Development: ${project.developmentBranch}`,
    `Knowledge: ${project.knowledge.filter(({ status }) => status === "active").length} active`
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
    const added = store.transaction((tx) => {
      const project = requireProject(tx, parsed.positionals[0]!);
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
        "",
        entry.body
      ].join("\n").concat("\n"),
      projectId: project.id,
      knowledgeId: entry.id
    };
  }
  if (command === "update") {
    const usage = "Project knowledge update usage: yui project knowledge update <project> <knowledge> [--title <text>] [--body <text>].";
    const parsed = parseKnowledgeUpdateArguments(rest, usage);
    const updated = store.transaction((tx) => {
      const project = requireProject(tx, parsed.project);
      const next = updateProjectKnowledge(project, parsed.id, {
        ...(parsed.title === undefined ? {} : { title: parsed.title }),
        ...(parsed.body === undefined ? {} : { body: parsed.body })
      }, (options.now ?? (() => new Date()))());
      tx.saveProject(next);
      return next;
    });
    return {
      output: `Updated project knowledge ${parsed.id} in ${updated.id}\n`,
      projectId: updated.id,
      knowledgeId: parsed.id
    };
  }
  if (command === "retire") {
    if (rest.length !== 2) {
      throw usageError("Project knowledge retire usage: yui project knowledge retire <project> <knowledge>.");
    }
    const updated = store.transaction((tx) => {
      const project = requireProject(tx, rest[0]!);
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

function parseKnowledgeUpdateArguments(
  args: readonly string[],
  usage: string
): Readonly<{ project: string; id: string; title?: string; body?: string }> {
  const positionals: string[] = [];
  let title: string | undefined;
  let body: string | undefined;
  for (let index = 0; index < args.length; index += 1) {
    const value = args[index]!;
    if (value === "--title" || value === "--body") {
      const next = args[index + 1];
      if (next === undefined || next.startsWith("--")) throw usageError(`${value} is required. ${usage}`);
      if (value === "--title") {
        if (title !== undefined) throw usageError(`--title may only be provided once. ${usage}`);
        title = requireText(next, value);
      } else {
        if (body !== undefined) throw usageError(`--body may only be provided once. ${usage}`);
        body = requireText(next, value);
      }
      index += 1;
      continue;
    }
    if (value.startsWith("--")) throw usageError(`Unknown option: ${value}. ${usage}`);
    positionals.push(value);
  }
  if (positionals.length !== 2 || (title === undefined && body === undefined)) {
    throw usageError(usage);
  }
  return {
    project: positionals[0]!,
    id: positionals[1]!,
    ...(title === undefined ? {} : { title }),
    ...(body === undefined ? {} : { body })
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
