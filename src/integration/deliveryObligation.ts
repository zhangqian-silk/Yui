import type { IntegrationAttempt } from "./integrationAttempt.js";
import {
  governingWorkItemCandidate,
  type WorkItem
} from "../workItem/workItem.js";

export type WorkItemProjectDelivery = Readonly<{
  workItemId: string;
  projectId: string;
  startCommit: string;
  resultCommit: string;
}>;

/**
 * Resolve the exact Git boundary produced by the Candidate that currently
 * governs a WorkItem. Read-only context Projects are not delivery sources.
 */
export function governingWorkItemDeliveries(
  workItems: readonly WorkItem[]
): readonly WorkItemProjectDelivery[] {
  return workItems.flatMap((item) => {
    const candidate = governingWorkItemCandidate(item);
    if (candidate?.workspace === undefined || candidate.gitSnapshot === undefined) return [];
    const results = new Map(
      candidate.gitSnapshot.projects.map(({ projectId, commit }) => [projectId, commit])
    );
    return candidate.workspace.entries
      .filter(({ access }) => access === "write")
      .map((entry) => {
        const resultCommit = results.get(entry.projectId);
        if (resultCommit === undefined) {
          throw new Error(
            `WorkItem Candidate result is missing Project ${item.id}/${entry.projectId}.`
          );
        }
        return {
          workItemId: item.id,
          projectId: entry.projectId,
          startCommit: entry.baseCommit,
          resultCommit
        };
      });
  });
}

export function workItemDeliverySettled(
  delivery: WorkItemProjectDelivery,
  integrations: readonly IntegrationAttempt[]
): boolean {
  return integrations.some((attempt) => (
    attempt.status === "committed"
    && attempt.projectId === delivery.projectId
    && attempt.source.kind === "work-item"
    && attempt.source.workItemId === delivery.workItemId
    && attempt.source.startCommit === delivery.startCommit
    && attempt.source.resultCommit === delivery.resultCommit
  ));
}

/** Unsettled Integration attempts remain blockers independently of Agent ordering. */
export function integrationAttemptRequiresSettlement(
  attempt: IntegrationAttempt
): boolean {
  return attempt.status === "running"
    || attempt.status === "validating"
    || attempt.status === "blocked"
    || attempt.status === "conflicted";
}
