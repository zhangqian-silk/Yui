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
  | "listRuns"
  | "listIntegrationAttempts"
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
    runs: store.listRuns(task.id),
    integrations: store.listIntegrationAttempts(task.id),
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
    runs: store.listRuns(task.id),
    integrations: store.listIntegrationAttempts(task.id),
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
  proof: TaskRemoteDeliveryProof | undefined
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
  // Recheck semantic adoption/Integration facts as well as Publication versions.
  // For provisional cancelled Tasks retain the frozen candidate used at preflight.
  const current = projectTaskRemoteDeliveryFromStore(store, task, {
    projects: proof.delivery.projects.flatMap(p => p.expectedLocalCommit === null
      ? [] : [{ projectId: p.projectId, commit: p.expectedLocalCommit }])
  });
  if (!isDeepStrictEqual(current, proof.delivery)) {
    throw usageError(`Task delivery evidence changed after remote-delivery preflight: ${task.id}.`);
  }
  assertTaskRemoteDeliveryIntegrated(proof.delivery);
  return proof.delivery;
}

export function assertTaskRemoteDeliveryIntegrated(
  delivery: TaskRemoteDelivery
): void {
  if (!delivery.allMerged) {
    const headUnavailable = delivery.projects.filter((project) => (
      project.codeDelivery !== "none"
      && project.coverage === "head-unavailable"
    ));
    if (headUnavailable.length > 0 && delivery.source === "task-completed") {
      throw usageError(
        `Task ${delivery.taskId} has no frozen completion heads for: ${
          headUnavailable.map(({ projectId }) => projectId).join(", ")
        }. Historical acceptance cannot be inferred from a merge or archive.`
      );
    }
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
      }. Inspect each Project reason with task remote-delivery. Record confirmed Publication facts; `
      + "for a changed post-completion candidate, review publication diff and explicitly adopt its acceptance."
    );
  }
  if (delivery.allVerified) return;
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
    + "for each Publication only when the provider read is authorized."
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
      + `candidate=${shortCommit(project.deliveryLocalCommit)}; `
      + `adoption=${project.adoption?.id ?? "none"}; `
      + `base=${shortCommit(project.baseCommit)}; `
      + `publication=${project.publication?.id ?? "none"}; `
      + `state=${project.state ?? "none"}; `
      + `verification=${project.verification ?? "none"}; `
      + `remote=${shortCommit(project.remoteCommit)}; `
      + `coverage=${project.coverage}\n${indent}  ${project.reason}`
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
