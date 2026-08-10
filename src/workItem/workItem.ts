import {
  normalizedUniqueIdentities,
  normalizedUniqueText,
  requireIdentity,
  requireText,
  requireTimestamp
} from "../domain/validation.js";
import { validateReviewConfig, type ReviewConfig } from "../review/reviewConfig.js";
import {
  taskFinalReviewConfig,
  validateTaskFinalReviewContract,
  type TaskFinalReviewContract
} from "../review/taskFinalReviewContract.js";
import {
  validateManagedWorkspace,
  type ManagedWorkspace
} from "../worktree/managedWorkspace.js";
import { validateTaskRecordReference } from "../task/taskRecordReference.js";

export type WorkItemStatus =
  | "pending"
  | "running"
  | "awaiting_acceptance"
  | "completed"
  | "failed"
  | "retired";

export type WorkItemDisposition = Readonly<{
  schemaVersion: 1;
  by: "leader";
  summary: string;
  retiredAt: string;
  replacementWorkItemId?: string;
}>;

export type WorkItemDispositionInput = Readonly<{
  by: "leader";
  summary: string;
  replacementWorkItemId?: string;
}>;

export type WorkItemWorkspaceDisposition = "integrated" | "abandoned";

/**
 * Optional base-ref overrides used only when a fresh WorkItem Develop
 * workspace is first provisioned. The resolved commit is frozen in the
 * managed workspace entry; this record remains a ref request, not a second
 * capture boundary.
 */
export type WorkItemProjectBaseRef = Readonly<{
  projectId: string;
  baseRef: string;
}>;

export type CandidateGitSnapshot = Readonly<{
  schemaVersion: 1;
  reviewBaseCommit: string;
  projects: readonly Readonly<{
    projectId: string;
    commit: string;
  }>[];
}>;

export type WorkItemCandidate = Readonly<{
  schemaVersion: 2;
  id: string;
  taskId: string;
  workItemId: string;
  sequence: number;
  workItemRevision: number;
  summary: string;
  source:
    | Readonly<{ type: "direct" }>
    | Readonly<{ type: "run"; runId: string }>;
  reviewPolicy?: ReviewConfig;
  taskFinalReviewContract?: TaskFinalReviewContract;
  /** Snapshot of the WorkItem-owned Develop workspace at candidate time. */
  workspace?: ManagedWorkspace;
  gitSnapshot?: CandidateGitSnapshot;
  createdAt: string;
}>;

export type WorkItem = {
  schemaVersion: 6;
  id: string;
  taskId: string;
  title: string;
  objective: string;
  acceptance: readonly string[];
  dependsOn: readonly string[];
  writeProjectIds: readonly string[];
  /** Explicit Git refs for the initial writable WorkItem worktree. */
  baseRefs?: readonly WorkItemProjectBaseRef[];
  revision: number;
  assignee?: string;
  status: WorkItemStatus;
  candidates: readonly WorkItemCandidate[];
  outcome?: string;
  disposition?: WorkItemDisposition;
  workspaceDisposition?: WorkItemWorkspaceDisposition;
  createdAt: string;
  updatedAt: string;
  endedAt?: string;
};

const TERMINAL_STATUSES: readonly WorkItemStatus[] = [
  "completed",
  "failed",
  "retired"
];

export function createWorkItem(
  id: string,
  taskId: string,
  input: Readonly<{
    title: string;
    objective?: string;
    acceptance?: readonly string[];
    dependsOn?: readonly string[];
    assignee?: string;
    writeProjectIds?: readonly string[];
    baseRefs?: readonly WorkItemProjectBaseRef[];
  }>,
  now: Date
): WorkItem {
  const timestamp = now.toISOString();
  return validateWorkItem({
    schemaVersion: 6,
    id: requireIdentity(id, "Work Item id"),
    taskId: requireIdentity(taskId, "Task id"),
    title: requireText(input.title, "Work item title"),
    objective: requireText(input.objective ?? input.title, "Work item objective"),
    acceptance: normalizedUniqueText(input.acceptance ?? [], "Work item acceptance criterion"),
    dependsOn: normalizedUniqueIdentities(input.dependsOn ?? [], "Work item dependency"),
    writeProjectIds: normalizedUniqueIdentities(
      input.writeProjectIds ?? [],
      "Work item writable Project"
    ),
    ...(input.baseRefs === undefined || input.baseRefs.length === 0
      ? {}
      : { baseRefs: normalizeProjectBaseRefs(input.baseRefs) }),
    revision: 1,
    ...(input.assignee === undefined
      ? {}
      : { assignee: requireIdentity(input.assignee, "Work item assignee") }),
    status: "pending",
    candidates: [],
    createdAt: timestamp,
    updatedAt: timestamp
  });
}

export function submitWorkItemCandidate(
  workItem: WorkItem,
  input: Readonly<{
    summary: string;
    source:
      | Readonly<{ type: "direct" }>
      | Readonly<{ type: "run"; runId: string }>;
    reviewPolicy?: ReviewConfig;
    taskFinalReviewContract?: TaskFinalReviewContract;
    workspace?: ManagedWorkspace;
    gitSnapshot?: CandidateGitSnapshot;
  }>,
  now: Date
): WorkItem {
  validateWorkItem(workItem);
  if (workItem.status !== "running") {
    throw new Error(
      `Work Item candidate can only be submitted from running: ${workItem.id}/${workItem.status}.`
    );
  }
  const revision = workItem.revision + 1;
  const sequence = workItem.candidates.length + 1;
  const candidate = validateWorkItemCandidate({
    schemaVersion: 2,
    id: `candidate-${sequence}`,
    taskId: workItem.taskId,
    workItemId: workItem.id,
    sequence,
    workItemRevision: revision,
    summary: input.summary,
    source: input.source,
    ...(input.reviewPolicy === undefined ? {} : { reviewPolicy: input.reviewPolicy }),
    ...(input.taskFinalReviewContract === undefined
      ? {}
      : { taskFinalReviewContract: input.taskFinalReviewContract }),
    ...(input.workspace === undefined ? {} : { workspace: input.workspace }),
    ...(input.gitSnapshot === undefined ? {} : { gitSnapshot: input.gitSnapshot }),
    createdAt: now.toISOString()
  });
  const { outcome: _outcome, endedAt: _endedAt, ...base } = workItem;
  return validateWorkItem({
    ...base,
    status: "awaiting_acceptance",
    candidates: [...workItem.candidates, candidate],
    revision,
    updatedAt: now.toISOString()
  });
}

export function updateWorkItemStatus(
  workItem: WorkItem,
  status: WorkItemStatus,
  now: Date,
  outcome?: string
): WorkItem {
  validateWorkItem(workItem);
  validateStatus(status);
  const alreadyTerminal = isTerminalStatus(workItem.status);
  if (workItem.disposition !== undefined && status !== workItem.status) {
    throw new Error(`Retired Work Item status cannot change: ${workItem.id}.`);
  }
  const closingFailedWork = workItem.status === "failed" && status === "retired";
  if (alreadyTerminal && status !== workItem.status && !closingFailedWork) {
    throw new Error(`Terminal Work Item status cannot change: ${workItem.id}.`);
  }
  const terminal = isTerminalStatus(status);
  const normalizedOutcome = outcome === undefined
    ? undefined
    : requireText(outcome, "Work item outcome");
  if (terminal && normalizedOutcome === undefined) {
    throw new Error(`Work item outcome is required for ${status}.`);
  }
  const timestamp = now.toISOString();
  if (alreadyTerminal && status === workItem.status) {
    return validateWorkItem({
      ...workItem,
      outcome: normalizedOutcome,
      revision: workItem.revision + 1,
      updatedAt: timestamp
    });
  }
  const {
    endedAt: _endedAt,
    outcome: _outcome,
    workspaceDisposition,
    ...base
  } = workItem;
  return validateWorkItem({
    ...base,
    status,
    revision: workItem.revision + 1,
    ...(normalizedOutcome === undefined ? {} : { outcome: normalizedOutcome }),
    // Isolated workspace cleanup remains durable evidence after retirement.
    ...(closingFailedWork && workspaceDisposition !== undefined
      ? { workspaceDisposition }
      : {}),
    updatedAt: timestamp,
    ...(terminal ? { endedAt: timestamp } : {})
  });
}

/**
 * Records the Leader's explicit disposition as the authoritative terminal
 * fact. Replays of the same decision are idempotent; a different terminal
 * decision can never overwrite the first one.
 */
export function retireWorkItem(
  workItem: WorkItem,
  input: WorkItemDispositionInput,
  now: Date
): WorkItem {
  validateWorkItem(workItem);
  const disposition = normalizeDisposition(input, now);
  if (workItem.disposition !== undefined) {
    if (
      workItem.status === "retired"
      && sameDisposition(workItem.disposition, disposition)
    ) {
      return workItem;
    }
    throw new Error(`Work Item already has an explicit disposition: ${workItem.id}.`);
  }
  if (workItem.status === "completed") {
    throw new Error(`Completed Work Item cannot be retired: ${workItem.id}.`);
  }
  if (isTerminalStatus(workItem.status)
    && workItem.status !== "failed"
    && workItem.status !== "retired") {
    throw new Error(`Terminal Work Item status cannot change: ${workItem.id}.`);
  }
  const timestamp = disposition.retiredAt;
  return validateWorkItem({
    ...workItem,
    status: "retired",
    outcome: disposition.summary,
    disposition,
    revision: workItem.revision + 1,
    updatedAt: timestamp,
    endedAt: timestamp
  });
}

export function retryFailedWorkItem(workItem: WorkItem, now: Date): WorkItem {
  validateWorkItem(workItem);
  if (workItem.status !== "failed") {
    throw new Error(`Work item is not retryable from ${workItem.status}: ${workItem.id}.`);
  }
  if (workItem.workspaceDisposition !== undefined) {
    throw new Error(`Work item workspace is already settled: ${workItem.id}.`);
  }
  const { outcome: _outcome, endedAt: _endedAt, ...base } = workItem;
  return validateWorkItem({
    ...base,
    status: "running",
    revision: workItem.revision + 1,
    updatedAt: now.toISOString()
  });
}

export function recordWorkItemWorkspaceDisposition(
  workItem: WorkItem,
  disposition: WorkItemWorkspaceDisposition,
  now: Date
): WorkItem {
  validateWorkItem(workItem);
  if (!isTerminalStatus(workItem.status)) {
    throw new Error("Only a terminal Work Item can record workspace cleanup.");
  }
  if (workItem.workspaceDisposition !== undefined) {
    if (workItem.workspaceDisposition !== disposition) {
      throw new Error(
        `Work Item workspace is already recorded as ${workItem.workspaceDisposition}.`
      );
    }
    return workItem;
  }
  return validateWorkItem({
    ...workItem,
    workspaceDisposition: disposition,
    revision: workItem.revision + 1,
    updatedAt: now.toISOString()
  });
}

export function validateWorkItem(workItem: WorkItem): WorkItem {
  if (workItem.schemaVersion !== 6) throw new Error("WorkItem must use schemaVersion 6.");
  validateTaskRecordReference({ taskId: workItem.taskId, localId: workItem.id }, "workItem");
  requireIdentity(workItem.taskId, "Task id");
  requireText(workItem.title, "Work item title");
  requireText(workItem.objective, "Work item objective");
  normalizedUniqueText(workItem.acceptance, "Work item acceptance criterion");
  const dependsOn = normalizedUniqueIdentities(workItem.dependsOn, "Work item dependency");
  normalizedUniqueIdentities(workItem.writeProjectIds, "Work item writable Project");
  if (workItem.baseRefs !== undefined) {
    const baseRefs = normalizeProjectBaseRefs(workItem.baseRefs);
    const writableProjects = new Set(workItem.writeProjectIds);
    if (baseRefs.some(({ projectId }) => !writableProjects.has(projectId))) {
      throw new Error("Work Item Project base refs must target writable Projects.");
    }
  }
  if (dependsOn.includes(workItem.id)) {
    throw new Error("A Work Item cannot depend on itself.");
  }
  if (!Number.isSafeInteger(workItem.revision) || workItem.revision < 1) {
    throw new Error("Work Item revision must be a positive integer.");
  }
  if (workItem.assignee !== undefined) {
    requireIdentity(workItem.assignee, "Work item assignee");
  }
  validateStatus(workItem.status);
  if (!Array.isArray(workItem.candidates)) {
    throw new Error("Work Item candidates are invalid.");
  }
  const candidateIds = new Set<string>();
  workItem.candidates.forEach((candidate, index) => {
    validateWorkItemCandidate(candidate);
    if (candidate.taskId !== workItem.taskId || candidate.workItemId !== workItem.id) {
      throw new Error("Work Item candidate provenance is invalid.");
    }
    if (candidate.sequence !== index + 1) {
      throw new Error("Work Item candidate sequence is invalid.");
    }
    if (candidateIds.has(candidate.id)) {
      throw new Error(`Work Item candidate is duplicated: ${candidate.id}.`);
    }
    candidateIds.add(candidate.id);
    if (candidate.workItemRevision > workItem.revision) {
      throw new Error("Work Item candidate revision cannot exceed the Work Item revision.");
    }
  });
  const currentCandidate = currentWorkItemCandidate(workItem);
  if (workItem.status === "awaiting_acceptance" && currentCandidate === undefined) {
    throw new Error("A Work Item awaiting acceptance requires a candidate.");
  }
  if (workItem.outcome !== undefined) requireText(workItem.outcome, "Work item outcome");
  requireTimestamp(workItem.createdAt, "Work Item createdAt");
  requireTimestamp(workItem.updatedAt, "Work Item updatedAt");
  const terminal = isTerminalStatus(workItem.status);
  if (terminal) {
    requireText(workItem.outcome ?? "", "Work item outcome");
    requireTimestamp(workItem.endedAt ?? "", "Work Item endedAt");
  } else {
    if (workItem.outcome !== undefined) {
      throw new Error("A non-terminal Work Item cannot have an outcome.");
    }
    if (workItem.endedAt !== undefined) {
      throw new Error("A non-terminal Work Item cannot have endedAt.");
    }
  }
  if (workItem.workspaceDisposition !== undefined) {
    if (!["integrated", "abandoned"].includes(workItem.workspaceDisposition)) {
      throw new Error("Work item workspaceDisposition is invalid.");
    }
    if (!terminal) {
      throw new Error("Only a terminal Work Item can record workspace cleanup.");
    }
  }
  if (workItem.disposition !== undefined) {
    validateDisposition(workItem.disposition);
    if (workItem.status !== "retired") {
      throw new Error("Work Item disposition does not match its status.");
    }
    if (workItem.outcome !== workItem.disposition.summary
      || workItem.endedAt !== workItem.disposition.retiredAt) {
      throw new Error("Work Item disposition does not match its terminal metadata.");
    }
  }
  return workItem;
}

export function validateWorkItemCandidate(
  candidate: WorkItemCandidate
): WorkItemCandidate {
  if (typeof candidate !== "object" || candidate === null) {
    throw new Error("Work Item candidate is required.");
  }
  if (candidate.schemaVersion !== 2) {
    throw new Error("Work Item candidate must use schemaVersion 2.");
  }
  requireIdentity(candidate.taskId, "Work Item candidate Task id");
  validateTaskRecordReference({
    taskId: candidate.taskId,
    localId: candidate.workItemId
  }, "workItem");
  if (candidate.id !== `candidate-${candidate.sequence}`) {
    throw new Error("Work Item candidate local id is invalid.");
  }
  if (!Number.isSafeInteger(candidate.sequence) || candidate.sequence < 1) {
    throw new Error("Work Item candidate sequence must be a positive integer.");
  }
  if (!Number.isSafeInteger(candidate.workItemRevision)
    || candidate.workItemRevision < 1) {
    throw new Error("Work Item candidate revision must be a positive integer.");
  }
  requireText(candidate.summary, "Work Item candidate summary");
  if (typeof candidate.source !== "object" || candidate.source === null) {
    throw new Error("Work Item candidate source is required.");
  }
  if (candidate.source.type !== "direct" && candidate.source.type !== "run") {
    throw new Error("Work Item candidate source is invalid.");
  }
  if (candidate.source.type === "run") {
    validateTaskRecordReference({
      taskId: candidate.taskId,
      localId: candidate.source.runId
    }, "agentRun");
  }
  if (candidate.reviewPolicy !== undefined) validateReviewConfig(candidate.reviewPolicy);
  if (candidate.taskFinalReviewContract !== undefined) {
    const contract = validateTaskFinalReviewContract(candidate.taskFinalReviewContract);
    if (contract.taskId !== candidate.taskId) {
      throw new Error("Task final-review contract belongs to another Task.");
    }
    const policy = taskFinalReviewConfig(contract);
    if (candidate.reviewPolicy?.roleName !== policy.roleName
      || candidate.reviewPolicy.trigger !== policy.trigger) {
      throw new Error("Task final-review contract does not match the Candidate review policy.");
    }
  }
  if (candidate.workspace !== undefined) {
    validateManagedWorkspace(candidate.workspace);
    if (candidate.workspace.owner.type !== "work-item"
      || candidate.workspace.owner.taskId !== candidate.taskId
      || candidate.workspace.owner.workItemId !== candidate.workItemId) {
      throw new Error("Work Item candidate must use its WorkItem-owned workspace.");
    }
  }
  if (candidate.gitSnapshot !== undefined) {
    if (candidate.workspace === undefined) {
      throw new Error("Candidate Git snapshot requires a managed workspace.");
    }
    validateCandidateGitSnapshot(candidate.gitSnapshot, candidate.workspace);
  }
  requireTimestamp(candidate.createdAt, "Work Item candidate createdAt");
  return candidate;
}

export function createCandidateGitSnapshot(
  workspace: ManagedWorkspace,
  projects: readonly Readonly<{ projectId: string; commit: string }>[]
): CandidateGitSnapshot {
  validateManagedWorkspace(workspace);
  if (workspace.owner.type !== "work-item") {
    throw new Error("Candidate Git snapshot must come from a WorkItem workspace.");
  }
  if (workspace.entries.length === 0) {
    throw new Error("Candidate Git snapshot requires a Project workspace.");
  }
  const byProject = new Map(projects.map(({ projectId, commit: value }) => [
    requireIdentity(projectId, "Candidate snapshot Project"),
    requireCommit(value, "Candidate snapshot commit")
  ]));
  if (byProject.size !== projects.length) {
    throw new Error("Candidate snapshot Projects are duplicated.");
  }
  const normalized = workspace.entries.map(({ projectId }) => {
    const value = byProject.get(projectId);
    if (value === undefined) {
      throw new Error(`Candidate snapshot Project is missing: ${projectId}.`);
    }
    return { projectId, commit: value };
  });
  if (normalized.length !== byProject.size) {
    throw new Error("Candidate snapshot contains a Project outside its workspace.");
  }
  const primary = workspace.entries.find(({ access }) => access === "write")
    ?? workspace.entries[0]!;
  return {
    schemaVersion: 1,
    reviewBaseCommit: byProject.get(primary.projectId)!,
    projects: normalized
  };
}

function validateCandidateGitSnapshot(
  snapshot: CandidateGitSnapshot,
  workspace: ManagedWorkspace
): void {
  if (snapshot.schemaVersion !== 1) {
    throw new Error("Candidate Git snapshot must use schemaVersion 1.");
  }
  requireCommit(snapshot.reviewBaseCommit, "Candidate review base commit");
  const normalized = createCandidateGitSnapshot(workspace, snapshot.projects);
  if (normalized.reviewBaseCommit !== snapshot.reviewBaseCommit
    || JSON.stringify(normalized.projects) !== JSON.stringify(snapshot.projects)) {
    throw new Error("Candidate Git snapshot does not match its managed workspace.");
  }
}

function requireCommit(value: string, label: string): string {
  const commit = requireText(value, label).toLowerCase();
  if (!/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/u.test(commit)) {
    throw new Error(`${label} is invalid.`);
  }
  return commit;
}

export function currentWorkItemCandidate(
  workItem: WorkItem
): WorkItemCandidate | undefined {
  return workItem.status === "awaiting_acceptance"
    ? workItem.candidates.at(-1)
    : undefined;
}

export function updateWorkItemWriteProjects(
  workItem: WorkItem,
  writeProjectIds: readonly string[],
  now: Date
): WorkItem {
  validateWorkItem(workItem);
  if (isTerminalStatus(workItem.status)) {
    throw new Error(`Terminal Work Item write scope cannot change: ${workItem.id}.`);
  }
  const normalized = normalizedUniqueIdentities(
    writeProjectIds,
    "Work item writable Project"
  );
  const requested = new Set(normalized);
  const removed = workItem.writeProjectIds.filter((projectId) => !requested.has(projectId));
  if (removed.length > 0) {
    throw new Error(
      `Work Item write scope cannot remove approved Projects: ${removed.join(", ")}.`
    );
  }
  if (
    normalized.length === workItem.writeProjectIds.length
    && workItem.writeProjectIds.every((projectId) => requested.has(projectId))
  ) {
    return workItem;
  }
  return validateWorkItem({
    ...workItem,
    writeProjectIds: normalized,
    revision: workItem.revision + 1,
    updatedAt: now.toISOString()
  });
}

function isTerminalStatus(status: WorkItemStatus): boolean {
  return TERMINAL_STATUSES.includes(status);
}

function validateStatus(status: WorkItemStatus): void {
  if (![
    "pending",
    "running",
    "awaiting_acceptance",
    "completed",
    "failed",
    "retired"
  ].includes(status)) {
    throw new Error(`Work Item status is invalid: ${String(status)}.`);
  }
}

function normalizeProjectBaseRefs(
  baseRefs: readonly WorkItemProjectBaseRef[]
): readonly WorkItemProjectBaseRef[] {
  if (!Array.isArray(baseRefs)) {
    throw new Error("Work Item Project base refs are invalid.");
  }
  const projectIds = new Set<string>();
  return baseRefs.map((entry) => {
    if (typeof entry !== "object" || entry === null) {
      throw new Error("Work Item Project base ref is invalid.");
    }
    const projectId = requireIdentity(entry.projectId, "Work Item Project id");
    if (projectIds.has(projectId)) {
      throw new Error(`Work Item Project base ref is duplicated: ${projectId}.`);
    }
    projectIds.add(projectId);
    const baseRef = requireText(entry.baseRef, "Work Item Project base ref");
    if (baseRef.startsWith("-") || /[\r\n]/u.test(baseRef)) {
      throw new Error("Work Item Project base ref is invalid.");
    }
    return { projectId, baseRef };
  });
}

function normalizeDisposition(
  input: WorkItemDispositionInput,
  now: Date
): WorkItemDisposition {
  if (input.by !== "leader") {
    throw new Error("Only the Task Leader may retire a Work Item.");
  }
  const summary = requireText(input.summary, "Work item disposition summary");
  const replacementWorkItemId = input.replacementWorkItemId;
  if (replacementWorkItemId !== undefined) {
    requireIdentity(replacementWorkItemId, "Replacement Work Item id");
  }
  const result: WorkItemDisposition = {
    schemaVersion: 1,
    by: "leader",
    summary,
    retiredAt: now.toISOString(),
    ...(replacementWorkItemId === undefined ? {} : { replacementWorkItemId })
  };
  return validateDisposition(result);
}

function validateDisposition(disposition: WorkItemDisposition): WorkItemDisposition {
  if (disposition.schemaVersion !== 1) {
    throw new Error("Work Item disposition must use schemaVersion 1.");
  }
  if (disposition.by !== "leader") {
    throw new Error("Work Item disposition actor is invalid.");
  }
  requireText(disposition.summary, "Work item disposition summary");
  requireTimestamp(disposition.retiredAt, "Work Item retiredAt");
  if (disposition.replacementWorkItemId !== undefined) {
    requireIdentity(disposition.replacementWorkItemId, "Replacement Work Item id");
  }
  return disposition;
}

function sameDisposition(
  left: WorkItemDisposition,
  right: WorkItemDisposition
): boolean {
  return left.by === right.by
    && left.summary === right.summary
    && left.replacementWorkItemId === right.replacementWorkItemId;
}
