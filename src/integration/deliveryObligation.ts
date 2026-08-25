import type { ChangeSet } from "./changeSet.js";
import type { IntegrationAttempt } from "./integrationAttempt.js";
import type { IntegrationQueueEntry } from "./integrationQueueEntry.js";
import {
  governingWorkItemCandidate,
  type WorkItem,
  type WorkItemCandidate
} from "../workItem/workItem.js";

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
    attempt.status === "committed" && attempt.changeSetIds.includes(changeSet.id)
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
  attempt: IntegrationAttempt,
  changeSets: readonly ChangeSet[]
): boolean {
  if (attempt.status === "running" || attempt.status === "validating") return true;
  const governingIds = new Set(changeSets.map(({ id }) => id));
  return attempt.changeSetIds.some((id) => governingIds.has(id));
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
