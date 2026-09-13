import { taskNotFound, usageError } from "../errors/cliError.js";
import type { TaskStore } from "../storage/taskStore.js";
import {
  type TaskRemoteDelivery,
  type TaskRemoteDeliveryCandidate
} from "../task/remoteDelivery.js";
import { projectTaskRemoteDeliveryFromStore } from "../task/remoteDeliveryService.js";

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
  const data = store.readTransaction((reader) => {
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
