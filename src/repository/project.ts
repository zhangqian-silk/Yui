import { join, resolve } from "node:path";
import { createHash } from "node:crypto";

/**
 * Evidence trail for a Project Knowledge entry that was promoted from a Task
 * conclusion. The body of a Knowledge entry must stand on its own; the
 * provenance only records where the conclusion came from so a later Agent can
 * verify the evidence against the durable Task records.
 */
export type ProjectKnowledgeProvenance = Readonly<{
  /** Source Task that produced the conclusion. */
  taskId: string;
  /** Source Decision within the Task, when the proposal cited one. */
  decisionId?: string;
  /** Source Milestone within the Task, when the proposal cited one. */
  milestoneId?: string;
  /** Commit anchoring the evidence, when the proposal cited one. */
  commitSha?: string;
  /**
   * Digest of the source evidence (Decision rationale, Milestone summary, or
   * Task completion summary) as it was read at promotion time.
   */
  evidenceDigest?: string;
  /**
   * Stable dedup fingerprint of the promoted conclusion (source identity +
   * title + body). Recorded so a repeated proposal can be recognized as an
   * already-promoted duplicate instead of creating a second entry.
   */
  fingerprint?: string;
  /** The proposal that produced (or last updated) this entry. */
  proposalId?: string;
  promotedBy?: "user" | "operator";
  promotedAt?: string;
}>;

export type ProjectKnowledge = Readonly<{
  schemaVersion: 1;
  id: string;
  title: string;
  body: string;
  status: "active" | "retired";
  /** Present only for entries promoted through the Operator approval workflow. */
  provenance?: ProjectKnowledgeProvenance;
  createdAt: string;
  updatedAt: string;
}>;

/**
 * A Leader-proposed candidate for promotion into Project Knowledge. A proposal
 * is workflow state, not Knowledge: it never appears in `project knowledge
 * list/show` results until an Operator explicitly accepts it. The proposal
 * record is retained after decision so the promotion history stays traceable.
 */
export type KnowledgeProposalStatus = "pending" | "accepted" | "rejected";

export type KnowledgeProposalSource = Readonly<{
  /** The Task whose conclusion is being promoted. */
  taskId: string;
  decisionId?: string;
  milestoneId?: string;
  commitSha?: string;
}>;

export type KnowledgeProposal = Readonly<{
  schemaVersion: 1;
  id: string;
  projectId: string;
  title: string;
  /** A self-contained project-level conclusion, not a link to a Task record. */
  body: string;
  status: KnowledgeProposalStatus;
  source: KnowledgeProposalSource;
  /** Applicability scope of the conclusion, when the proposer stated one. */
  scope?: string;
  /** Condition under which the conclusion stops holding, when stated. */
  expiresWhen?: string;
  /** Existing active Knowledge this proposal suggests superseding. */
  supersedesKnowledgeId?: string;
  /**
   * sha256 of the source identity + title + body. Two proposals with the same
   * fingerprint are the same candidate; the second is deduplicated, not stored
   * twice.
   */
  fingerprint: string;
  /** Digest of the cited source evidence as read at proposal time. */
  evidenceDigest?: string;
  proposedBy: "leader" | "reviewer" | "user" | "operator";
  proposedAt: string;
  decidedBy?: "user" | "operator";
  decidedAt?: string;
  decisionReason?: string;
  /** Set on accept: the Knowledge entry created or updated. */
  knowledgeId?: string;
  updatedAt: string;
}>;

/**
 * Who owns the Project's Git repository.
 *
 * - `managed`: Yui owns a canonical repository + stable view inside
 *   `$YUI_HOME/projects/<projectId>`. The runtime never depends on a
 *   user-controlled checkout path.
 * - `external`: a user-owned checkout registered by path. Explicit opt-in only.
 */
export type ProjectOwnership = "managed" | "external";

/** A durable Project Catalog entry maintained by Yui. */
export type Project = Readonly<{
  schemaVersion: 4;
  id: string;
  name: string;
  aliases: readonly string[];
  path: string;
  ownership: ProjectOwnership;
  remoteUrl?: string;
  stableBranch: string;
  developmentBranch: string;
  knowledge: readonly ProjectKnowledge[];
  /**
   * Leader-proposed Knowledge candidates awaiting an Operator decision. The
   * v3->v4 compatible normalizer defaults this to an empty list.
   */
  knowledgeProposals: readonly KnowledgeProposal[];
  createdAt: string;
  updatedAt: string;
}>;

/** The Yui-owned directory holding a managed Project's canonical repository. */
export function managedProjectPath(home: string, projectId: string): string {
  const id = requireIdentity(projectId, "Project id");
  return join(resolve(home), "projects", id);
}

export function createProject(
  id: string,
  name: string,
  path: string,
  branches: Readonly<{ stable: string; development: string }>,
  now: Date,
  metadata: Readonly<{
    aliases?: readonly string[];
    remoteUrl?: string;
    ownership?: ProjectOwnership;
  }> = {}
): Project {
  const timestamp = now.toISOString();
  return validateProject({
    schemaVersion: 4,
    id: requireIdentity(id, "Project id"),
    name: validateProjectName(name),
    aliases: normalizeAliases(metadata.aliases ?? [], name),
    path: resolve(requireText(path, "Project path")),
    ownership: metadata.ownership ?? "external",
    ...(metadata.remoteUrl === undefined
      ? {}
      : { remoteUrl: requireText(metadata.remoteUrl, "Project remote URL") }),
    stableBranch: requireGitRef(branches.stable, "Project stable branch"),
    developmentBranch: requireGitRef(branches.development, "Project development branch"),
    knowledge: [],
    knowledgeProposals: [],
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
  now: Date,
  provenance?: ProjectKnowledgeProvenance
): Project {
  const timestamp = now.toISOString();
  const knowledge: ProjectKnowledge = {
    schemaVersion: 1,
    id: requireIdentity(id, "Project knowledge id"),
    title: requireText(title, "Project knowledge title"),
    body: requireText(body, "Project knowledge body"),
    status: "active",
    ...(provenance === undefined ? {} : { provenance: validateKnowledgeProvenance(provenance) }),
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

/**
 * Stable dedup fingerprint for a promotion candidate. Two proposals with the
 * same source identity, title, and body are the same conclusion regardless of
 * who proposed them or when.
 */
export function knowledgeProposalFingerprint(input: Readonly<{
  projectId: string;
  source: KnowledgeProposalSource;
  title: string;
  body: string;
}>): string {
  const sourceKey = [
    input.projectId,
    input.source.taskId,
    input.source.decisionId ?? "",
    input.source.milestoneId ?? "",
    input.source.commitSha ?? ""
  ].join("|");
  return createHash("sha256")
    .update(`${sourceKey}\u0000${input.title}\u0000${input.body}`)
    .digest("hex");
}

/** Digest of the cited source evidence, so a later Agent can verify it. */
export function knowledgeEvidenceDigest(evidence: string): string {
  return createHash("sha256").update(requireText(evidence, "Knowledge evidence")).digest("hex");
}

export function findKnowledgeProposal(
  project: Project,
  proposalId: string
): KnowledgeProposal | null {
  return project.knowledgeProposals.find(({ id }) => id === proposalId) ?? null;
}

/**
 * Append a validated proposal. The caller is responsible for deduplication:
 * use {@link findKnowledgeProposalByFingerprint} first and reuse the existing
 * pending candidate instead of storing a second copy.
 */
export function addKnowledgeProposal(
  project: Project,
  proposal: KnowledgeProposal
): Project {
  const stored = validateKnowledgeProposal(proposal, project.id);
  if (project.knowledgeProposals.some((entry) => entry.id === stored.id)) {
    throw new Error(`Knowledge proposal already exists: ${stored.id}.`);
  }
  return validateProject({
    ...project,
    knowledgeProposals: [...project.knowledgeProposals, stored],
    updatedAt: stored.proposedAt
  });
}

export function findKnowledgeProposalByFingerprint(
  project: Project,
  fingerprint: string,
  status?: KnowledgeProposalStatus
): KnowledgeProposal | null {
  return project.knowledgeProposals.find((entry) => (
    entry.fingerprint === fingerprint
    && (status === undefined || entry.status === status)
  )) ?? null;
}

export type KnowledgeProposalDecision = Readonly<{
  by: "user" | "operator";
  reason?: string;
  /** Set on accept: the Knowledge entry created or updated. */
  knowledgeId?: string;
}>;

/** Record the Operator decision on a pending proposal. */
export function decideKnowledgeProposal(
  project: Project,
  proposalId: string,
  decision: KnowledgeProposalDecision,
  now: Date
): Project {
  const id = requireIdentity(proposalId, "Knowledge proposal id");
  const timestamp = now.toISOString();
  let found = false;
  const knowledgeProposals = project.knowledgeProposals.map((entry) => {
    if (entry.id !== id) return entry;
    found = true;
    if (entry.status !== "pending") {
      throw new Error(`Knowledge proposal is already ${entry.status}: ${id}.`);
    }
    return {
      ...entry,
      status: decision.knowledgeId === undefined ? "rejected" as const : "accepted" as const,
      decidedBy: decision.by,
      decidedAt: timestamp,
      ...(decision.reason === undefined ? {} : { decisionReason: requireText(decision.reason, "Knowledge proposal decision reason") }),
      ...(decision.knowledgeId === undefined ? {} : { knowledgeId: requireIdentity(decision.knowledgeId, "Knowledge id") }),
      updatedAt: timestamp
    };
  });
  if (!found) throw new Error(`Knowledge proposal not found: ${id}.`);
  return validateProject({ ...project, knowledgeProposals, updatedAt: timestamp });
}

export type KnowledgeAcceptancePlan =
  | { kind: "create"; supersedesKnowledgeId?: string }
  | { kind: "update"; knowledgeId: string }
  | { kind: "duplicate"; knowledgeId: string };

/**
 * Pure acceptance policy. A proposal is a duplicate when an active Knowledge
 * entry already carries its fingerprint. It conflicts when an active entry has
 * the same title but a different conclusion; the Operator must then choose an
 * explicit update, supersede, or reject instead of a silent overwrite.
 */
export function planKnowledgeAcceptance(
  project: Project,
  proposal: KnowledgeProposal
): KnowledgeAcceptancePlan {
  const active = project.knowledge.filter((entry) => entry.status === "active");
  const duplicate = active.find((entry) => entry.provenance?.fingerprint === proposal.fingerprint);
  if (duplicate !== undefined) return { kind: "duplicate", knowledgeId: duplicate.id };
  const conflicting = active.find((entry) => entry.title === proposal.title);
  if (conflicting !== undefined) {
    throw new Error(
      `Knowledge ${conflicting.id} has the same title but a different conclusion.`
      + " Accept with --update to replace its body, or reject the proposal."
    );
  }
  if (proposal.supersedesKnowledgeId !== undefined) {
    const target = project.knowledge.find((entry) => entry.id === proposal.supersedesKnowledgeId);
    if (target === undefined) {
      throw new Error(`Knowledge to supersede not found: ${proposal.supersedesKnowledgeId}.`);
    }
    if (target.status !== "active") {
      throw new Error(`Knowledge to supersede is not active: ${target.id}.`);
    }
  }
  return {
    kind: "create",
    ...(proposal.supersedesKnowledgeId === undefined
      ? {}
      : { supersedesKnowledgeId: proposal.supersedesKnowledgeId })
  };
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
  if (project.schemaVersion !== 4) {
    throw new Error("Project must use schemaVersion 4.");
  }
  requireIdentity(project.id, "Project id");
  requireIdentity(project.name, "Project name");
  normalizeAliases(project.aliases, project.name);
  if (project.ownership !== "managed" && project.ownership !== "external") {
    throw new Error(`Project ownership is invalid: ${String(project.ownership)}.`);
  }
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
    if (entry.provenance !== undefined) {
      validateKnowledgeProvenance(entry.provenance);
    }
    requireTimestamp(entry.createdAt, "Project knowledge createdAt");
    requireTimestamp(entry.updatedAt, "Project knowledge updatedAt");
    if (knowledgeIds.has(entry.id)) throw new Error(`Duplicate Project knowledge id: ${entry.id}.`);
    knowledgeIds.add(entry.id);
  }
  const proposalIds = new Set<string>();
  for (const entry of project.knowledgeProposals) {
    validateKnowledgeProposal(entry, project.id);
    if (proposalIds.has(entry.id)) {
      throw new Error(`Duplicate Knowledge proposal id: ${entry.id}.`);
    }
    proposalIds.add(entry.id);
  }
  requireTimestamp(project.createdAt, "Project createdAt");
  requireTimestamp(project.updatedAt, "Project updatedAt");
  return project;
}

function validateKnowledgeProvenance(provenance: ProjectKnowledgeProvenance): ProjectKnowledgeProvenance {
  requireIdentity(provenance.taskId, "Knowledge provenance task id");
  if (provenance.decisionId !== undefined) {
    requireIdentity(provenance.decisionId, "Knowledge provenance decision id");
  }
  if (provenance.milestoneId !== undefined) {
    requireIdentity(provenance.milestoneId, "Knowledge provenance milestone id");
  }
  if (provenance.commitSha !== undefined) {
    requireText(provenance.commitSha, "Knowledge provenance commit");
  }
  if (provenance.evidenceDigest !== undefined) {
    requireText(provenance.evidenceDigest, "Knowledge provenance evidence digest");
  }
  if (provenance.fingerprint !== undefined) {
    requireText(provenance.fingerprint, "Knowledge provenance fingerprint");
  }
  if (provenance.proposalId !== undefined) {
    requireIdentity(provenance.proposalId, "Knowledge provenance proposal id");
  }
  if (provenance.promotedBy !== undefined
    && provenance.promotedBy !== "user"
    && provenance.promotedBy !== "operator") {
    throw new Error("Knowledge provenance promotedBy is invalid.");
  }
  if (provenance.promotedAt !== undefined) {
    requireTimestamp(provenance.promotedAt, "Knowledge provenance promotedAt");
  }
  return provenance;
}

function validateKnowledgeProposal(
  proposal: KnowledgeProposal,
  projectId: string
): KnowledgeProposal {
  if (proposal.schemaVersion !== 1) {
    throw new Error("Knowledge proposal must use schemaVersion 1.");
  }
  requireIdentity(proposal.id, "Knowledge proposal id");
  if (proposal.projectId !== projectId) {
    throw new Error(`Knowledge proposal belongs to another Project: ${proposal.projectId}.`);
  }
  requireText(proposal.title, "Knowledge proposal title");
  requireText(proposal.body, "Knowledge proposal body");
  if (!["pending", "accepted", "rejected"].includes(proposal.status)) {
    throw new Error("Knowledge proposal status is invalid.");
  }
  requireIdentity(proposal.source.taskId, "Knowledge proposal source task id");
  if (proposal.source.decisionId !== undefined) {
    requireIdentity(proposal.source.decisionId, "Knowledge proposal source decision id");
  }
  if (proposal.source.milestoneId !== undefined) {
    requireIdentity(proposal.source.milestoneId, "Knowledge proposal source milestone id");
  }
  if (proposal.source.commitSha !== undefined) {
    requireText(proposal.source.commitSha, "Knowledge proposal source commit");
  }
  if (proposal.scope !== undefined) requireText(proposal.scope, "Knowledge proposal scope");
  if (proposal.expiresWhen !== undefined) {
    requireText(proposal.expiresWhen, "Knowledge proposal expiry condition");
  }
  if (proposal.supersedesKnowledgeId !== undefined) {
    requireIdentity(proposal.supersedesKnowledgeId, "Knowledge proposal supersedes id");
  }
  requireText(proposal.fingerprint, "Knowledge proposal fingerprint");
  if (proposal.evidenceDigest !== undefined) {
    requireText(proposal.evidenceDigest, "Knowledge proposal evidence digest");
  }
  if (!["leader", "reviewer", "user", "operator"].includes(proposal.proposedBy)) {
    throw new Error("Knowledge proposal proposedBy is invalid.");
  }
  requireTimestamp(proposal.proposedAt, "Knowledge proposal proposedAt");
  if (proposal.decidedBy !== undefined
    && proposal.decidedBy !== "user"
    && proposal.decidedBy !== "operator") {
    throw new Error("Knowledge proposal decidedBy is invalid.");
  }
  if (proposal.decidedAt !== undefined) {
    requireTimestamp(proposal.decidedAt, "Knowledge proposal decidedAt");
  }
  if (proposal.decisionReason !== undefined) {
    requireText(proposal.decisionReason, "Knowledge proposal decision reason");
  }
  if (proposal.knowledgeId !== undefined) {
    requireIdentity(proposal.knowledgeId, "Knowledge proposal knowledge id");
  }
  requireTimestamp(proposal.updatedAt, "Knowledge proposal updatedAt");
  if (proposal.status === "pending" && proposal.decidedAt !== undefined) {
    throw new Error("Pending Knowledge proposal must not carry a decision timestamp.");
  }
  if (proposal.status !== "pending" && proposal.decidedAt === undefined) {
    throw new Error("Decided Knowledge proposal must carry a decision timestamp.");
  }
  if (proposal.status === "accepted" && proposal.knowledgeId === undefined) {
    throw new Error("Accepted Knowledge proposal must reference its Knowledge entry.");
  }
  if (proposal.status !== "accepted" && proposal.knowledgeId !== undefined) {
    throw new Error("Only an accepted Knowledge proposal may reference a Knowledge entry.");
  }
  return proposal;
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
