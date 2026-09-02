import { isDeepStrictEqual } from "node:util";
import { taskNotFound, usageError } from "../errors/cliError.js";
import type { TaskStore } from "../storage/taskStore.js";
import type { PublicationReference } from "../task/publicationReference.js";
import type { Task } from "../task/task.js";
import {
  projectTaskRemoteDelivery,
  type TaskRemoteDelivery,
  type TaskRemoteDeliveryCandidate
} from "../task/remoteDelivery.js";

export type TaskRemoteDeliveryStore = Pick<
  TaskStore,
  | "listEvents"
  | "listPublicationReferences"
  | "listManagedWorkspaces"
  | "listTurns"
>;

export type TaskRemoteDeliveryProof = Readonly<{
  schemaVersion: 1;
  task: Readonly<Pick<
    Task,
    | "id"
    | "status"
    | "projectBindings"
    | "workspaceIdentity"
    | "completedAt"
    | "retiredAt"
  >>;
  publications: readonly PublicationReference[];
  delivery: TaskRemoteDelivery;
}>;

export function runTaskRemoteDeliveryCommand(
  args: readonly string[],
  store: TaskStore,
  currentCandidate: TaskRemoteDeliveryCandidate | null = null
): { kind: "output"; output: string; data: TaskRemoteDelivery } {
  const usage = "Task remote-delivery usage: yui task remote-delivery <task> [--json].";
  const asJson = args.includes("--json");
  const positionals = args.filter((arg) => arg !== "--json");
  if (positionals.length !== 1 || positionals[0]?.trim().length === 0) {
    throw usageError(usage);
  }
  const taskId = positionals[0]!.trim();
  const data = store.transaction((reader) => {
    const task = reader.getTask(taskId);
    if (task === null) throw taskNotFound(taskId);
    return projectTaskRemoteDeliveryFromStore(reader, task, currentCandidate);
  });
  return {
    kind: "output",
    output: asJson
      ? `${JSON.stringify(data, null, 2)}\n`
      : renderTaskRemoteDelivery(data),
    data
  };
}

export function projectTaskRemoteDeliveryFromStore(
  store: TaskRemoteDeliveryStore,
  task: Task,
  currentCandidate: TaskRemoteDeliveryCandidate | null = null
): TaskRemoteDelivery {
  return projectTaskRemoteDelivery({
    task,
    events: store.listEvents(task.id),
    publications: store.listPublicationReferences(task.id),
    managedWorkspaces: store.listManagedWorkspaces(task.id),
    turns: store.listTurns(task.id),
    currentCandidate
  });
}

export function createTaskRemoteDeliveryProof(
  store: TaskRemoteDeliveryStore,
  task: Task,
  currentCandidate: TaskRemoteDeliveryCandidate | null = null
): TaskRemoteDeliveryProof {
  const publications = store.listPublicationReferences(task.id);
  const delivery = projectTaskRemoteDelivery({
    task,
    events: store.listEvents(task.id),
    publications,
    managedWorkspaces: store.listManagedWorkspaces(task.id),
    turns: store.listTurns(task.id),
    currentCandidate
  });
  return {
    schemaVersion: 1,
    task: taskRemoteDeliveryProofTask(task),
    publications,
    delivery
  };
}

export function assertTaskRemoteDeliveryProof(
  store: TaskRemoteDeliveryStore,
  task: Task,
  proof: TaskRemoteDeliveryProof | undefined,
  options: Readonly<{ forceUnverified?: boolean }> = {}
): TaskRemoteDelivery {
  if (proof === undefined || proof.schemaVersion !== 1) {
    throw usageError(`Task remote-delivery preflight proof is required: ${task.id}.`);
  }
  if (!isDeepStrictEqual(proof.task, taskRemoteDeliveryProofTask(task))) {
    throw usageError(`Task changed after remote-delivery preflight: ${task.id}.`);
  }
  if (!isDeepStrictEqual(
    proof.publications,
    store.listPublicationReferences(task.id)
  )) {
    throw usageError(`Task Publication evidence changed after remote-delivery preflight: ${task.id}.`);
  }
  assertTaskRemoteDeliveryIntegrated(proof.delivery, options);
  return proof.delivery;
}

export function assertTaskRemoteDeliveryIntegrated(
  delivery: TaskRemoteDelivery,
  options: Readonly<{ forceUnverified?: boolean }> = {}
): void {
  if (!delivery.allMerged) {
    const uncovered = delivery.projects
      .filter((project) => project.codeDelivery !== "none" && !project.merged)
      .map((project) => (
        `${project.projectId}/${project.coverage}`
        + (project.publication === null ? "" : `/${project.publication.id}`)
      ))
      .join(", ");
    throw usageError(
      `Task ${delivery.taskId} is not fully merged into remote delivery: ${
        uncovered || "expected Project heads are unavailable"
      }. Record confirmed current-head evidence with task publication upsert, `
      + "or use task archive --abandon for an intentional non-merge."
    );
  }
  if (delivery.allVerified || options.forceUnverified === true) return;
  const unverified = delivery.projects
    .filter((project) => (
      project.codeDelivery !== "none"
      && project.merged
      && !project.verified
    ))
    .map((project) => (
      `${project.projectId}/${project.coverage}`
      + (project.publication === null ? "" : `/${project.publication.id}`)
    ))
    .join(", ");
  throw usageError(
    `Task ${delivery.taskId} has merged Publication evidence that is not verified: `
    + `${unverified || "verification evidence is unavailable"}. Run task publication verify `
    + "for each Publication, or repeat task archive --integrated --force to explicitly "
    + "override verification. --force never overrides missing, stale, open, or closed merge evidence."
  );
}

export function renderTaskRemoteDelivery(
  delivery: TaskRemoteDelivery,
  indent = ""
): string {
  const source = `${delivery.source}${delivery.provisional ? " (provisional)" : ""}`;
  const lines = [
    `${indent}Remote delivery: ${delivery.status}`,
    `${indent}Expected heads: ${source}`,
    `${indent}All merged: ${delivery.allMerged ? "yes" : "no"}`,
    `${indent}All verified: ${delivery.allVerified ? "yes" : "no"}`,
    `${indent}Code Projects: ${delivery.mergedProjectCount}/${delivery.codeProjectCount} merged; ${delivery.verifiedProjectCount}/${delivery.codeProjectCount} verified`,
    `${indent}Archive --integrated coverage: ${delivery.integratedCoverageSatisfied ? "satisfied" : "blocked"}`,
    ...(delivery.archiveDisposition === null
      ? []
      : [`${indent}Archive disposition: ${delivery.archiveDisposition}`]),
    `${indent}Projects:${delivery.projects.length === 0 ? " none" : ""}`,
    ...delivery.projects.map((project) => (
      `${indent}- ${project.directory} (${project.projectId}): `
      + `expected=${shortCommit(project.expectedLocalCommit)}; `
      + `base=${shortCommit(project.baseCommit)}; `
      + `publication=${project.publication?.id ?? "none"}; `
      + `state=${project.state ?? "none"}; `
      + `verification=${project.verification ?? "none"}; `
      + `remote=${shortCommit(project.remoteCommit)}; `
      + `coverage=${project.coverage}`
    ))
  ];
  return `${lines.join("\n")}\n`;
}

function shortCommit(commit: string | null): string {
  return commit === null ? "unknown" : commit.slice(0, 12);
}

function taskRemoteDeliveryProofTask(
  task: Task
): TaskRemoteDeliveryProof["task"] {
  return {
    id: task.id,
    status: task.status,
    projectBindings: task.projectBindings,
    ...(task.workspaceIdentity === undefined
      ? {}
      : { workspaceIdentity: task.workspaceIdentity }),
    ...(task.completedAt === undefined ? {} : { completedAt: task.completedAt }),
    ...(task.retiredAt === undefined ? {} : { retiredAt: task.retiredAt })
  };
}
