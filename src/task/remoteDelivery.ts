import type { TaskEvent } from "../event/taskEvent.js";
import type { Turn } from "../turn/turn.js";
import type { ManagedWorkspace } from "../worktree/managedWorkspace.js";
import type { PublicationReference } from "./publicationReference.js";
import type { Task } from "./task.js";

export type RemoteDeliveryStatus = "none" | "pending" | "partial" | "merged";
export type RemoteDeliverySource =
  | "current-task-main"
  | "task-completed"
  | "task-archive"
  | "unavailable";
export type ProjectCodeDelivery = "none" | "code" | "unknown";
export type ProjectMergeCoverage =
  | "not-applicable"
  | "head-unavailable"
  | "missing"
  | "missing-local-commit"
  | "stale"
  | "open"
  | "closed"
  | "merged"
  | "verified";

export type TaskRemoteDeliveryCandidate = Readonly<{
  projects: readonly Readonly<{
    projectId: string;
    commit: string;
  }>[];
}>;

export type ProjectRemoteDelivery = Readonly<{
  projectId: string;
  directory: string;
  baseCommit: string | null;
  expectedLocalCommit: string | null;
  codeDelivery: ProjectCodeDelivery;
  publication: PublicationReference | null;
  state: PublicationReference["state"] | null;
  verification: PublicationReference["verification"] | null;
  remoteCommit: string | null;
  coverage: ProjectMergeCoverage;
  merged: boolean;
  verified: boolean;
  reason: string;
}>;

export type TaskRemoteDelivery = Readonly<{
  taskId: string;
  source: RemoteDeliverySource;
  provisional: boolean;
  archiveDisposition: "integrated" | "abandoned" | null;
  status: RemoteDeliveryStatus;
  allMerged: boolean;
  allVerified: boolean;
  totalProjectCount: number;
  codeProjectCount: number;
  mergedProjectCount: number;
  verifiedProjectCount: number;
  integratedCoverageSatisfied: boolean;
  projects: readonly ProjectRemoteDelivery[];
}>;

export type TaskRemoteDeliveryFacts = Readonly<{
  task: Task;
  events: readonly TaskEvent[];
  publications: readonly PublicationReference[];
  managedWorkspaces: readonly ManagedWorkspace[];
  turns: readonly Turn[];
  currentCandidate?: TaskRemoteDeliveryCandidate | null;
}>;

/**
 * One read-only delivery projection over existing Task, workspace, completion,
 * and Publication facts. It never writes a merged flag or queries a provider.
 */
export function projectTaskRemoteDelivery(
  facts: TaskRemoteDeliveryFacts
): TaskRemoteDelivery {
  const expected = expectedDelivery(facts);
  const baseCommits = projectBaseCommits(facts, expected.event);
  const archiveDisposition = latestEvent(
    facts.events,
    "task.archived",
    () => true
  )?.payload.workspaceDisposition;
  const currentPublications = currentPublicationReferences(facts.publications);
  const projects = facts.task.projectBindings.map((binding): ProjectRemoteDelivery => {
    const expectedLocalCommit = expected.commits.get(binding.projectId) ?? null;
    const baseCommit = baseCommits.get(binding.projectId) ?? null;
    const codeDelivery = expectedLocalCommit === null
      ? "unknown"
      : baseCommit === null
        ? "unknown"
        : expectedLocalCommit === baseCommit ? "none" : "code";
    const projectPublications = currentPublications
      .filter((reference) => reference.projectId === binding.projectId);
    const matching = expectedLocalCommit === null
      ? []
      : projectPublications.filter(
        (reference) => reference.localCommit === expectedLocalCommit
      );
    const publication = bestPublication(
      matching.length > 0 ? matching : projectPublications
    );
    const coverage = projectCoverage(codeDelivery, expectedLocalCommit, publication);
    const merged = codeDelivery === "none"
      || (publication !== null
        && expectedLocalCommit !== null
        && publication.localCommit === expectedLocalCommit
        && publication.state === "merged");
    const verified = codeDelivery === "none"
      || (merged && publication?.verification === "verified");
    return {
      projectId: binding.projectId,
      directory: binding.directory,
      baseCommit,
      expectedLocalCommit,
      codeDelivery,
      publication,
      state: publication?.state ?? null,
      verification: publication?.verification ?? null,
      remoteCommit: publication?.remoteCommit ?? null,
      coverage,
      merged,
      verified,
      reason: projectCoverageReason(
        codeDelivery,
        expectedLocalCommit,
        publication,
        coverage
      )
    };
  });
  const codeProjects = projects.filter((project) => project.codeDelivery !== "none");
  const mergedProjectCount = codeProjects.filter((project) => project.merged).length;
  const verifiedProjectCount = codeProjects.filter((project) => project.verified).length;
  const allMerged = codeProjects.every((project) => project.merged);
  const allVerified = codeProjects.every((project) => project.verified);
  const status: RemoteDeliveryStatus = codeProjects.length === 0
    ? "none"
    : allMerged
      ? "merged"
      : mergedProjectCount > 0 ? "partial" : "pending";
  return {
    taskId: facts.task.id,
    source: expected.source,
    provisional: expected.provisional,
    archiveDisposition: archiveDisposition === "integrated"
      || archiveDisposition === "abandoned"
      ? archiveDisposition
      : null,
    status,
    allMerged,
    allVerified,
    totalProjectCount: projects.length,
    codeProjectCount: codeProjects.length,
    mergedProjectCount,
    verifiedProjectCount,
    integratedCoverageSatisfied: allMerged,
    projects
  };
}

type ExpectedDelivery = Readonly<{
  source: RemoteDeliverySource;
  provisional: boolean;
  commits: ReadonlyMap<string, string>;
  event?: TaskEvent;
}>;

function expectedDelivery(facts: TaskRemoteDeliveryFacts): ExpectedDelivery {
  const { task } = facts;
  if ((task.status === "completed" || task.status === "archived")
    && task.completedAt !== undefined) {
    const event = completionEvent(facts.events, task.completedAt);
    return {
      source: "task-completed",
      provisional: false,
      commits: commitMap(event?.payload.projectHeads),
      ...(event === undefined ? {} : { event })
    };
  }
  if (task.status === "archived") {
    const event = latestEvent(facts.events, "task.archived", (candidate) => (
      candidate.payload.workspaceDisposition === "integrated"
      && candidate.payload.projectHeads !== undefined
    ));
    return {
      source: event === undefined ? "unavailable" : "task-archive",
      provisional: false,
      commits: commitMap(event?.payload.projectHeads),
      ...(event === undefined ? {} : { event })
    };
  }
  if (task.status === "active" || task.status === "retired") {
    return {
      source: "current-task-main",
      provisional: true,
      commits: candidateCommits(facts.currentCandidate)
    };
  }
  return {
    source: "unavailable",
    provisional: false,
    commits: new Map()
  };
}

function completionEvent(
  events: readonly TaskEvent[],
  completedAt: string
): TaskEvent | undefined {
  const exact = latestEvent(events, "task.completed", (event) => (
    event.createdAt === completedAt
  ));
  return exact ?? latestEvent(events, "task.completed", (event) => (
    event.createdAt <= completedAt
  ));
}

function latestEvent(
  events: readonly TaskEvent[],
  type: string,
  predicate: (event: TaskEvent) => boolean
): TaskEvent | undefined {
  return events
    .filter((event) => event.type === type && predicate(event))
    .slice()
    .sort(compareCreated)
    .at(-1);
}

function projectBaseCommits(
  facts: TaskRemoteDeliveryFacts,
  event: TaskEvent | undefined
): ReadonlyMap<string, string> {
  const result = commitMap(event?.payload.projectBases);
  const archived = latestEvent(facts.events, "task.archived", (candidate) => (
    candidate.payload.projectBases !== undefined
  ));
  for (const [projectId, commit] of commitMap(archived?.payload.projectBases)) {
    if (!result.has(projectId)) result.set(projectId, commit);
  }
  const current = facts.managedWorkspaces.find((workspace) => (
    workspace.owner.type === "task"
    && workspace.owner.taskId === facts.task.id
  ));
  for (const entry of current?.entries ?? []) {
    if (!result.has(entry.projectId)) result.set(entry.projectId, entry.baseCommit);
  }
  const taskTurns = facts.turns
    .filter((turn) => (
      turn.workspace?.owner.type === "task"
      && turn.workspace.owner.taskId === facts.task.id
    ))
    .slice()
    .sort(compareCreated);
  for (const turn of taskTurns) {
    for (const entry of turn.workspace?.entries ?? []) {
      if (!result.has(entry.projectId)) result.set(entry.projectId, entry.baseCommit);
    }
  }
  return result;
}

function candidateCommits(
  candidate: TaskRemoteDeliveryCandidate | null | undefined
): ReadonlyMap<string, string> {
  return new Map(
    (candidate?.projects ?? []).map(({ projectId, commit }) => [
      projectId,
      commit.toLowerCase()
    ])
  );
}

function commitMap(value: string | undefined): Map<string, string> {
  const result = new Map<string, string>();
  for (const entry of value?.split(",") ?? []) {
    const separator = entry.indexOf("@");
    if (separator <= 0) continue;
    const projectId = entry.slice(0, separator).trim();
    const commit = entry.slice(separator + 1).trim().toLowerCase();
    if (projectId.length === 0 || !/^[0-9a-f]{40}$/u.test(commit)) continue;
    result.set(projectId, commit);
  }
  return result;
}

function currentPublicationReferences(
  publications: readonly PublicationReference[]
): readonly PublicationReference[] {
  const superseded = new Set(
    publications.flatMap((reference) => (
      reference.supersedes === undefined ? [] : [reference.supersedes]
    ))
  );
  return publications.filter((reference) => !superseded.has(reference.id));
}

function bestPublication(
  publications: readonly PublicationReference[]
): PublicationReference | null {
  return publications
    .slice()
    .sort((left, right) => (
      publicationRank(left) - publicationRank(right)
      || compareCreated(left, right)
    ))
    .at(-1) ?? null;
}

function publicationRank(reference: PublicationReference): number {
  if (reference.state === "merged" && reference.verification === "verified") return 4;
  if (reference.state === "merged") return 3;
  if (reference.state === "open") return 2;
  return 1;
}

function projectCoverage(
  codeDelivery: ProjectCodeDelivery,
  expectedLocalCommit: string | null,
  publication: PublicationReference | null
): ProjectMergeCoverage {
  if (codeDelivery === "none") return "not-applicable";
  if (expectedLocalCommit === null) return "head-unavailable";
  if (publication === null) return "missing";
  if (publication.localCommit === undefined) return "missing-local-commit";
  if (publication.localCommit !== expectedLocalCommit) return "stale";
  if (publication.state === "open") return "open";
  if (publication.state === "closed") return "closed";
  return publication.verification === "verified" ? "verified" : "merged";
}

function projectCoverageReason(
  codeDelivery: ProjectCodeDelivery,
  expectedLocalCommit: string | null,
  publication: PublicationReference | null,
  coverage: ProjectMergeCoverage
): string {
  switch (coverage) {
    case "not-applicable":
      return "Task head equals the managed workspace base; no code delivery is required.";
    case "head-unavailable":
      return "The exact Task delivery head is unavailable, so merge coverage is fail-closed.";
    case "missing":
      return "No current Publication records this Project delivery.";
    case "missing-local-commit":
      return `Publication ${publication!.id} does not record a local commit.`;
    case "stale":
      return `Publication ${publication!.id} covers ${publication!.localCommit}, not the expected Task head ${expectedLocalCommit}.`;
    case "open":
      return `Publication ${publication!.id} covers the Task head but is still open.`;
    case "closed":
      return `Publication ${publication!.id} covers the Task head but is closed without merge.`;
    case "merged":
      return `Publication ${publication!.id} reports the exact Task head as merged.`;
    case "verified":
      return `Publication ${publication!.id} verifies the exact Task head as merged.`;
  }
}

function compareCreated(
  left: Readonly<{ createdAt: string; id: string }>,
  right: Readonly<{ createdAt: string; id: string }>
): number {
  return left.createdAt.localeCompare(right.createdAt)
    || left.id.localeCompare(right.id, undefined, { numeric: true });
}
