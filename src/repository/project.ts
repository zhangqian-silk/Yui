import { resolve } from "node:path";

export type ProjectKnowledge = Readonly<{
  schemaVersion: 1;
  id: string;
  title: string;
  body: string;
  status: "active" | "retired";
  createdAt: string;
  updatedAt: string;
}>;

/** A durable Project Catalog entry maintained by Yui. */
export type Project = Readonly<{
  schemaVersion: 2;
  id: string;
  name: string;
  aliases: readonly string[];
  path: string;
  remoteUrl?: string;
  stableBranch: string;
  developmentBranch: string;
  knowledge: readonly ProjectKnowledge[];
  createdAt: string;
  updatedAt: string;
}>;

export function createProject(
  id: string,
  name: string,
  path: string,
  branches: Readonly<{ stable: string; development: string }>,
  now: Date,
  metadata: Readonly<{ aliases?: readonly string[]; remoteUrl?: string }> = {}
): Project {
  const timestamp = now.toISOString();
  return validateProject({
    schemaVersion: 2,
    id: requireIdentity(id, "Project id"),
    name: validateProjectName(name),
    aliases: normalizeAliases(metadata.aliases ?? [], name),
    path: resolve(requireText(path, "Project path")),
    ...(metadata.remoteUrl === undefined
      ? {}
      : { remoteUrl: requireText(metadata.remoteUrl, "Project remote URL") }),
    stableBranch: requireGitRef(branches.stable, "Project stable branch"),
    developmentBranch: requireGitRef(branches.development, "Project development branch"),
    knowledge: [],
    createdAt: timestamp,
    updatedAt: timestamp
  });
}

export function validateProjectName(value: string): string {
  return requireIdentity(value, "Project name");
}

export function addProjectKnowledge(
  project: Project,
  id: string,
  title: string,
  body: string,
  now: Date
): Project {
  const timestamp = now.toISOString();
  const knowledge: ProjectKnowledge = {
    schemaVersion: 1,
    id: requireIdentity(id, "Project knowledge id"),
    title: requireText(title, "Project knowledge title"),
    body: requireText(body, "Project knowledge body"),
    status: "active",
    createdAt: timestamp,
    updatedAt: timestamp
  };
  if (project.knowledge.some((entry) => entry.id === knowledge.id)) {
    throw new Error(`Project knowledge already exists: ${knowledge.id}.`);
  }
  return validateProject({
    ...project,
    knowledge: [...project.knowledge, knowledge],
    updatedAt: timestamp
  });
}

export function updateProjectMetadata(
  project: Project,
  patch: Readonly<{
    aliases?: readonly string[];
    remoteUrl?: string | null;
    stableBranch?: string;
    developmentBranch?: string;
  }>,
  now: Date
): Project {
  const remoteUrl = patch.remoteUrl === undefined
    ? project.remoteUrl
    : patch.remoteUrl === null
      ? undefined
      : requireText(patch.remoteUrl, "Project remote URL");
  const { remoteUrl: _remoteUrl, ...withoutRemote } = project;
  return validateProject({
    ...withoutRemote,
    aliases: normalizeAliases(patch.aliases ?? project.aliases, project.name),
    ...(remoteUrl === undefined ? {} : { remoteUrl }),
    stableBranch: patch.stableBranch === undefined
      ? project.stableBranch
      : requireGitRef(patch.stableBranch, "Project stable branch"),
    developmentBranch: patch.developmentBranch === undefined
      ? project.developmentBranch
      : requireGitRef(patch.developmentBranch, "Project development branch"),
    updatedAt: now.toISOString()
  });
}

export function updateProjectKnowledge(
  project: Project,
  id: string,
  patch: Readonly<{ title?: string; body?: string }>,
  now: Date
): Project {
  const knowledgeId = requireIdentity(id, "Project knowledge id");
  let found = false;
  const knowledge = project.knowledge.map((entry) => {
    if (entry.id !== knowledgeId) return entry;
    found = true;
    if (entry.status === "retired") {
      throw new Error(`Project knowledge is retired: ${knowledgeId}.`);
    }
    return {
      ...entry,
      title: patch.title === undefined
        ? entry.title
        : requireText(patch.title, "Project knowledge title"),
      body: patch.body === undefined
        ? entry.body
        : requireText(patch.body, "Project knowledge body"),
      updatedAt: now.toISOString()
    };
  });
  if (!found) throw new Error(`Project knowledge not found: ${knowledgeId}.`);
  return validateProject({ ...project, knowledge, updatedAt: now.toISOString() });
}

export function retireProjectKnowledge(
  project: Project,
  id: string,
  now: Date
): Project {
  const knowledgeId = requireIdentity(id, "Project knowledge id");
  let found = false;
  const knowledge = project.knowledge.map((entry) => {
    if (entry.id !== knowledgeId) return entry;
    found = true;
    return {
      ...entry,
      status: "retired" as const,
      updatedAt: now.toISOString()
    };
  });
  if (!found) throw new Error(`Project knowledge not found: ${knowledgeId}.`);
  return validateProject({ ...project, knowledge, updatedAt: now.toISOString() });
}

export function resolveProject(
  projects: readonly Project[],
  reference: string
): Project | null {
  const normalized = requireText(reference, "Project reference").toLocaleLowerCase();
  const matches = projects.filter((project) => (
    project.id.toLocaleLowerCase() === normalized
    || project.name.toLocaleLowerCase() === normalized
    || project.aliases.some((alias) => alias.toLocaleLowerCase() === normalized)
  ));
  if (matches.length > 1) throw new Error(`Project reference is ambiguous: ${reference}.`);
  return matches[0] ?? null;
}

export function assertProjectCatalog(
  projects: readonly Project[]
): void {
  const paths = new Map<string, string>();
  const references = new Map<string, string>();
  for (const project of projects) {
    validateProject(project);
    const pathOwner = paths.get(project.path);
    if (pathOwner !== undefined && pathOwner !== project.id) {
      throw new Error(`Project path is already registered: ${project.path}.`);
    }
    paths.set(project.path, project.id);
    for (const reference of [project.id, project.name, ...project.aliases]) {
      const key = reference.toLocaleLowerCase();
      const owner = references.get(key);
      if (owner !== undefined && owner !== project.id) {
        throw new Error(`Project reference is already registered: ${reference}.`);
      }
      references.set(key, project.id);
    }
  }
}

export function validateProject(project: Project): Project {
  if (project.schemaVersion !== 2) {
    throw new Error("Project must use schemaVersion 2.");
  }
  requireIdentity(project.id, "Project id");
  requireIdentity(project.name, "Project name");
  normalizeAliases(project.aliases, project.name);
  const references = new Set<string>();
  for (const reference of [project.id, project.name, ...project.aliases]) {
    const folded = reference.toLocaleLowerCase();
    if (references.has(folded)) {
      throw new Error(`Duplicate Project reference: ${reference}.`);
    }
    references.add(folded);
  }
  if (resolve(requireText(project.path, "Project path")) !== project.path) {
    throw new Error("Project path must be absolute and normalized.");
  }
  if (project.remoteUrl !== undefined) requireText(project.remoteUrl, "Project remote URL");
  requireGitRef(project.stableBranch, "Project stable branch");
  requireGitRef(project.developmentBranch, "Project development branch");
  const knowledgeIds = new Set<string>();
  for (const entry of project.knowledge) {
    if (entry.schemaVersion !== 1) throw new Error("Project knowledge must use schemaVersion 1.");
    requireIdentity(entry.id, "Project knowledge id");
    requireText(entry.title, "Project knowledge title");
    requireText(entry.body, "Project knowledge body");
    if (!["active", "retired"].includes(entry.status)) {
      throw new Error("Project knowledge status is invalid.");
    }
    requireTimestamp(entry.createdAt, "Project knowledge createdAt");
    requireTimestamp(entry.updatedAt, "Project knowledge updatedAt");
    if (knowledgeIds.has(entry.id)) throw new Error(`Duplicate Project knowledge id: ${entry.id}.`);
    knowledgeIds.add(entry.id);
  }
  requireTimestamp(project.createdAt, "Project createdAt");
  requireTimestamp(project.updatedAt, "Project updatedAt");
  return project;
}

function normalizeAliases(values: readonly string[], name: string): readonly string[] {
  const aliases = values.map((value) => requireIdentity(value, "Project alias"));
  const folded = new Set<string>();
  for (const value of [name, ...aliases]) {
    const key = value.toLocaleLowerCase();
    if (folded.has(key)) throw new Error(`Duplicate Project name or alias: ${value}.`);
    folded.add(key);
  }
  return Object.freeze([...aliases]);
}

function requireIdentity(value: string, label: string): string {
  const normalized = requireText(value, label);
  if (["__proto__", "prototype", "constructor", ".", ".."].includes(normalized)
    || /[\/\\\0]/.test(normalized)) {
    throw new Error(`${label} is invalid.`);
  }
  return normalized;
}

function requireGitRef(value: string, label: string): string {
  const ref = requireText(value, label);
  if (ref.startsWith("-") || /[\r\n]/.test(ref)) throw new Error(`${label} is invalid.`);
  return ref;
}

function requireText(value: string, label: string): string {
  if (typeof value !== "string" || value.includes("\0")) throw new Error(`${label} is invalid.`);
  const normalized = value.trim();
  if (normalized.length === 0) throw new Error(`${label} is required.`);
  return normalized;
}

function requireTimestamp(value: string, label: string): void {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) {
    throw new Error(`${label} is invalid.`);
  }
}
