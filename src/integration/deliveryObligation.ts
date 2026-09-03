import type { ChangeSet } from "./changeSet.js";
import type { IntegrationAttempt } from "./integrationAttempt.js";
import type { IntegrationQueueEntry } from "./integrationQueueEntry.js";
import {
  governingWorkItemCandidate,
  type WorkItem,
  type WorkItemCandidate
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

/**
 * Delivery obligations follow the Candidate that currently governs each
 * WorkItem. Older Candidates and their ChangeSets remain audit evidence, but
 * they do not keep a Task open after a replacement Candidate is accepted.
 */
export function governingChangeSets(
  workItems: readonly WorkItem[],
  changeSets: readonly ChangeSet[]
): readonly ChangeSet[] {
  const selected = new Map<string, ChangeSet>();
  for (const item of workItems) {
    const candidate = governingWorkItemCandidate(item);
    if (candidate === undefined) continue;
    for (const changeSet of changeSets) {
      if (changeSet.workItemId !== item.id) continue;
      const expectedHead = candidateProjectHead(candidate, changeSet.projectId);
      if (expectedHead !== undefined && changeSet.headCommit !== expectedHead) continue;
      const key = `${item.id}\0${changeSet.projectId}`;
      const current = selected.get(key);
      if (current === undefined || compareChangeSets(current, changeSet) < 0) {
        selected.set(key, changeSet);
      }
    }
  }
  return [...selected.values()].sort(compareChangeSets);
}

export function changeSetDeliverySettled(
  changeSet: ChangeSet,
  integrations: readonly IntegrationAttempt[],
  queueEntries: readonly IntegrationQueueEntry[] = []
): boolean {
  if (integrations.some((attempt) => (
    attempt.status === "committed"
    && attempt.projectId === changeSet.projectId
    && attempt.source.kind === "work-item"
    && attempt.source.workItemId === changeSet.workItemId
    && attempt.source.resultCommit === changeSet.headCommit
  ))) return true;
  const latestQueueEntry = queueEntries
    .filter((entry) => entry.changeSetId === changeSet.id)
    .sort(compareQueueEntries)
    .at(-1);
  return latestQueueEntry?.status === "superseded";
}

export function latestGoverningQueueEntries(
  changeSets: readonly ChangeSet[],
  queueEntries: readonly IntegrationQueueEntry[]
): readonly IntegrationQueueEntry[] {
  const governingIds = new Set(changeSets.map(({ id }) => id));
  const latest = new Map<string, IntegrationQueueEntry>();
  for (const entry of queueEntries) {
    if (!governingIds.has(entry.changeSetId)) continue;
    const current = latest.get(entry.changeSetId);
    if (current === undefined || compareQueueEntries(current, entry) < 0) {
      latest.set(entry.changeSetId, entry);
    }
  }
  return [...latest.values()].sort(compareQueueEntries);
}

/**
 * Historical blocked attempts are audit evidence once every ChangeSet they
 * reference has been replaced by a newer governing Candidate. Attempts that
 * may still be writing remain blockers regardless of Candidate history.
 */
export function integrationAttemptRequiresSettlement(
  attempt: IntegrationAttempt
): boolean {
  return attempt.status === "running"
    || attempt.status === "validating"
    || attempt.status === "blocked";
}

function candidateProjectHead(
  candidate: WorkItemCandidate,
  projectId: string
): string | undefined {
  return candidate.gitSnapshot?.projects.find((project) => project.projectId === projectId)?.commit
    ?? candidate.taskMainSnapshot?.projects.find(
      (project) => project.projectId === projectId
    )?.headCommit;
}

function compareChangeSets(left: ChangeSet, right: ChangeSet): number {
  return left.createdAt.localeCompare(right.createdAt)
    || left.id.localeCompare(right.id, undefined, { numeric: true });
}

function compareQueueEntries(
  left: IntegrationQueueEntry,
  right: IntegrationQueueEntry
): number {
  return left.updatedAt.localeCompare(right.updatedAt)
    || left.id.localeCompare(right.id, undefined, { numeric: true });
}
