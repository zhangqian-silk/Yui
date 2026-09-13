import { contextContentDigest } from "../context/contextSnapshot.js";
import type { TaskEvent } from "../event/taskEvent.js";
import type { IntegrationAttempt } from "../integration/integrationAttempt.js";
import { publicationExternalKey, type PublicationReference } from "./publicationReference.js";

export const PUBLICATION_ADOPTED_EVENT = "publication.candidate-adopted";

/**
 * An explicit semantic decision over fixed Git endpoints, not an ancestry
 * heuristic or a replacement completion head. Publication metadata/verification
 * successors may retain it only while every intervening local candidate agrees.
 */
export function publicationAdoption(
  publication: PublicationReference,
  completion: TaskEvent | undefined,
  acceptedCommit: string | null,
  events: readonly TaskEvent[],
  publications: readonly PublicationReference[],
  integrations: readonly IntegrationAttempt[]
): Readonly<{ event: TaskEvent | null; reason: string | null }> {
  const unavailable = { event: null, reason: null };
  if (completion === undefined || acceptedCommit === null) return unavailable;
  const lineage = new Set<string>();
  let current: PublicationReference | undefined = publication;
  while (current !== undefined && !lineage.has(current.id)
    && current.taskId === publication.taskId
    && current.projectId === publication.projectId
    && current.externalKind === publication.externalKind
    && publicationExternalKey(current) === publicationExternalKey(publication)
    && current.localCommit === publication.localCommit) {
    lineage.add(current.id);
    current = publications.find(p => p.id === current!.supersedes);
  }
  const event = events.slice().reverse().find(event => {
    const p = event.payload;
    return event.type === PUBLICATION_ADOPTED_EVENT
      && event.taskId === publication.taskId
      && p.completionEventId === completion.id
      && p.acceptedCommit === acceptedCommit
      && p.projectId === publication.projectId
      && p.localCommit === publication.localCommit
      && lineage.has(p.publicationId ?? "");
  });
  if (event === undefined) return unavailable;
  const p = event.payload;
  if (!p.acceptance?.trim()
    || !["user", "operator", "leader"].includes(p.by ?? "")
    || !/^[0-9a-f]{64}$/u.test(p.diffDigest ?? "")
    || !/^[0-9a-f]{40}$/u.test(p.acceptedTree ?? "")
    || !/^[0-9a-f]{40}$/u.test(p.candidateTree ?? "")) {
    return { event: null, reason: `Adoption ${event.id} has incomplete fixed evidence.` };
  }
  if (p.integrationId === undefined) return { event, reason: null };
  const integration = integrations.find(i => i.id === p.integrationId);
  const valid = integration !== undefined && integration.status === "committed"
    && integration.taskId === publication.taskId
    && integration.projectId === publication.projectId
    && integration.afterCommit === publication.localCommit
    && contextContentDigest(integration) === p.integrationDigest;
  return valid ? { event, reason: null } : {
    event: null,
    reason: `Adoption ${event.id} references Integration ${p.integrationId}, whose committed candidate evidence is missing or changed (${integration?.status ?? "missing"}).`
  };
}
