import {
  requireIdentity,
  requireText,
  requireTimestamp
} from "../domain/validation.js";
import { validateTaskRecordReference } from "./taskRecordReference.js";

export const PUBLICATION_REFERENCE_SCHEMA_VERSION = 1 as const;
export const TASK_COMPLETION_PUBLISHED_TREE_AUTHORIZED_EVENT =
  "task.completion-published-tree-authorized";

export type PublicationProvider = "github" | "gitlab";
export type PublicationExternalKind = "pull-request" | "merge-request";
export type PublicationState = "open" | "merged" | "closed";
export type PublicationVerification = "reported" | "verified";
export type PublicationRecordedBy = "user" | "operator" | "leader";
export type PublicationSource = "manual" | "release-workflow" | "integration";

export type PublicationReference = Readonly<{
  schemaVersion: typeof PUBLICATION_REFERENCE_SCHEMA_VERSION;
  id: string;
  taskId: string;
  projectId: string;
  provider: PublicationProvider;
  repository: string;
  externalKind: PublicationExternalKind;
  externalId: string;
  externalUrl?: string;
  title?: string;
  sourceBranch?: string;
  targetBranch?: string;
  localCommit?: string;
  remoteCommit?: string;
  state: PublicationState;
  verification: PublicationVerification;
  evidence?: string;
  supersedes?: string;
  recordedBy: PublicationRecordedBy;
  source: PublicationSource;
  mergedAt?: string;
  createdAt: string;
}>;

export type PublicationReferenceInput = Readonly<{
  projectId: string;
  provider: PublicationProvider;
  repository: string;
  externalKind: PublicationExternalKind;
  externalId: string;
  externalUrl?: string;
  title?: string;
  sourceBranch?: string;
  targetBranch?: string;
  localCommit?: string;
  remoteCommit?: string;
  state?: PublicationState;
  verification?: PublicationVerification;
  evidence?: string;
  supersedes?: string;
  recordedBy?: PublicationRecordedBy;
  source?: PublicationSource;
  mergedAt?: string;
}>;

const PROVIDERS: ReadonlySet<string> = new Set(["github", "gitlab"]);
const EXTERNAL_KINDS: ReadonlySet<string> = new Set(["pull-request", "merge-request"]);
const STATES: ReadonlySet<string> = new Set(["open", "merged", "closed"]);
const VERIFICATIONS: ReadonlySet<string> = new Set(["reported", "verified"]);
const RECORDED_BY: ReadonlySet<string> = new Set(["user", "operator", "leader"]);
const SOURCES: ReadonlySet<string> = new Set(["manual", "release-workflow", "integration"]);
const GIT_SHA = /^[0-9a-f]{40}$/iu;

export function createPublicationReference(
  id: string,
  taskId: string,
  input: PublicationReferenceInput,
  now: Date
): PublicationReference {
  const reference = validateTaskRecordReference({ taskId, localId: id }, "publicationReference");
  return validatePublicationReference({
    schemaVersion: PUBLICATION_REFERENCE_SCHEMA_VERSION,
    id: reference.localId,
    taskId: reference.taskId,
    projectId: requireIdentity(input.projectId, "Publication Project id"),
    provider: requireEnum(input.provider, PROVIDERS, "Publication provider") as PublicationProvider,
    repository: requireText(input.repository, "Publication repository"),
    externalKind: requireEnum(
      input.externalKind,
      EXTERNAL_KINDS,
      "Publication external kind"
    ) as PublicationExternalKind,
    externalId: requireText(input.externalId, "Publication external id"),
    ...(input.externalUrl === undefined ? {} : {
      externalUrl: requireText(input.externalUrl, "Publication external URL")
    }),
    ...(input.title === undefined ? {} : {
      title: requireText(input.title, "Publication title")
    }),
    ...(input.sourceBranch === undefined ? {} : {
      sourceBranch: requireText(input.sourceBranch, "Publication source branch")
    }),
    ...(input.targetBranch === undefined ? {} : {
      targetBranch: requireText(input.targetBranch, "Publication target branch")
    }),
    ...(input.localCommit === undefined ? {} : {
      localCommit: requireCommit(input.localCommit, "Publication local commit")
    }),
    ...(input.remoteCommit === undefined ? {} : {
      remoteCommit: requireCommit(input.remoteCommit, "Publication remote commit")
    }),
    state: requireEnum(
      input.state ?? "open",
      STATES,
      "Publication state"
    ) as PublicationState,
    verification: requireEnum(
      input.verification ?? "reported",
      VERIFICATIONS,
      "Publication verification"
    ) as PublicationVerification,
    ...(input.evidence === undefined ? {} : {
      evidence: requireText(input.evidence, "Publication evidence")
    }),
    ...(input.supersedes === undefined ? {} : {
      supersedes: requireText(input.supersedes, "Publication supersedes id")
    }),
    recordedBy: requireEnum(
      input.recordedBy ?? "user",
      RECORDED_BY,
      "Publication recordedBy"
    ) as PublicationRecordedBy,
    source: requireEnum(
      input.source ?? "manual",
      SOURCES,
      "Publication source"
    ) as PublicationSource,
    ...(input.mergedAt === undefined ? {} : {
      mergedAt: requireTimestamp(input.mergedAt, "Publication mergedAt")
    }),
    createdAt: now.toISOString()
  });
}

export function publicationExternalKey(reference: PublicationReference): string {
  return `${reference.provider}/${reference.repository}/${reference.externalId}`;
}

export function validatePublicationReference(
  reference: PublicationReference
): PublicationReference {
  if (reference.schemaVersion !== PUBLICATION_REFERENCE_SCHEMA_VERSION) {
    throw new Error("Publication reference must use schemaVersion 1.");
  }
  validateTaskRecordReference(
    { taskId: reference.taskId, localId: reference.id },
    "publicationReference"
  );
  requireIdentity(reference.projectId, "Publication Project id");
  requireEnum(reference.provider, PROVIDERS, "Publication provider");
  requireText(reference.repository, "Publication repository");
  requireEnum(reference.externalKind, EXTERNAL_KINDS, "Publication external kind");
  requireText(reference.externalId, "Publication external id");
  if (reference.externalUrl !== undefined) {
    requireText(reference.externalUrl, "Publication external URL");
  }
  if (reference.title !== undefined) {
    requireText(reference.title, "Publication title");
  }
  if (reference.sourceBranch !== undefined) {
    requireText(reference.sourceBranch, "Publication source branch");
  }
  if (reference.targetBranch !== undefined) {
    requireText(reference.targetBranch, "Publication target branch");
  }
  if (reference.localCommit !== undefined) {
    requireCommit(reference.localCommit, "Publication local commit");
  }
  if (reference.remoteCommit !== undefined) {
    requireCommit(reference.remoteCommit, "Publication remote commit");
  }
  requireEnum(reference.state, STATES, "Publication state");
  requireEnum(reference.verification, VERIFICATIONS, "Publication verification");
  if (reference.verification === "verified"
    && (reference.state !== "merged" || reference.remoteCommit === undefined)) {
    throw new Error("Verified publication requires state merged and a remote commit.");
  }
  if (reference.mergedAt !== undefined && reference.state !== "merged") {
    throw new Error("Publication mergedAt requires state merged.");
  }
  if (reference.evidence !== undefined) {
    requireText(reference.evidence, "Publication evidence");
  }
  if (reference.supersedes !== undefined) {
    requireText(reference.supersedes, "Publication supersedes id");
    if (reference.supersedes === reference.id) {
      throw new Error("Publication reference cannot supersede itself.");
    }
  }
  requireEnum(reference.recordedBy, RECORDED_BY, "Publication recordedBy");
  requireEnum(reference.source, SOURCES, "Publication source");
  requireTimestamp(reference.createdAt, "Publication createdAt");
  return reference;
}

function requireEnum(value: string, allowed: ReadonlySet<string>, label: string): string {
  const normalized = requireText(value, label);
  if (!allowed.has(normalized)) {
    throw new Error(`${label} is invalid: ${normalized}.`);
  }
  return normalized;
}

function requireCommit(value: string, label: string): string {
  const commit = requireText(value, label);
  if (!GIT_SHA.test(commit)) {
    throw new Error(`${label} must be a full 40-character Git SHA.`);
  }
  return commit.toLowerCase();
}
