import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { parseRepeatable } from "../cli/parseRepeatable.js";
import { contextContentDigest } from "../context/contextSnapshot.js";
import { usageError } from "../errors/cliError.js";
import { createTaskEvent } from "../event/taskEvent.js";
import { NodeGitWorkspace, type GitWorkspacePort } from "../repository/gitWorkspace.js";
import type { TaskStore } from "../storage/taskStore.js";
import { PUBLICATION_ADOPTED_EVENT, publicationAdoption } from "../task/publicationAdoption.js";
import { publicationExternalKey } from "../task/publicationReference.js";
import { commitMap, completionEvent } from "../task/remoteDelivery.js";
import { resolveTaskRecordReference } from "../task/taskRecordReference.js";
import { assertTaskDeliveryAuthority, taskActor } from "../task/taskAuthority.js";

type Options = Readonly<{
  git?: GitWorkspacePort;
  environment?: NodeJS.ProcessEnv;
  now?: () => Date;
}>;

/** Local read -> explicit semantic adoption of those exact bytes. No Git writes,
 * provider reads, completion rewrite or implicit acceptance of Integration. */
export async function runTaskPublicationAdoptCommand(
  args: readonly string[], store: TaskStore, options: Options = {}
) {
  const [command, ...rest] = args;
  const adopt = command === "adopt";
  if (!adopt && command !== "diff") throw usageError("Expected publication diff or adopt.");
  const usage = adopt
    ? "yui task publication adopt <task>/<publication> --reviewed-diff <sha256> --acceptance <text> [--integration <id>]"
    : "yui task publication diff <task>/<publication> [--integration <id>]";
  const parsed = parseRepeatable(rest, new Set(),
    new Set(adopt ? ["--reviewed-diff", "--acceptance", "--integration"] : ["--integration"]), usage);
  if (parsed.positionals.length !== 1) throw usageError(usage);
  const ref = resolveTaskRecordReference(parsed.positionals[0]!, {
    kind: "publicationReference", label: "Publication reference"
  });
  const acceptance = parsed.one.get("--acceptance")?.trim();
  const reviewedDiff = parsed.one.get("--reviewed-diff");
  if (adopt && (!acceptance || !/^[0-9a-f]{64}$/u.test(reviewedDiff ?? ""))) {
    throw usageError(`Adoption requires a reviewed diff digest and explicit acceptance of the full delta. ${usage}`);
  }
  const integrationId = parsed.one.get("--integration");
  const read = (reader: TaskStore) => {
    // The reader addresses only this Task's managed Git objects. Workers and
    // planning Sessions do not acquire publication-adoption authority.
    const actor = adopt
      ? assertTaskDeliveryAuthority(reader, options.environment, ref.taskId)
      : taskActor(options.environment, ref.taskId);
    const task = reader.getTask(ref.taskId);
    if (task === null || task.status !== "completed") {
      throw usageError("Publication candidate adoption/diff requires a completed, unarchived Task.");
    }
    const publication = reader.getPublicationReference(task.id, ref.localId);
    if (publication === null || publication.localCommit === undefined) {
      throw usageError("Publication must record an exact local candidate.");
    }
    const current = reader.findPublicationReferenceByExternalKey(publicationExternalKey(publication));
    if (current?.taskId !== task.id || current.id !== publication.id) {
      throw usageError("Publication is not the current record for its external identity.");
    }
    const completion = task.completedAt === undefined ? undefined
      : completionEvent(reader.listEvents(task.id), task.completedAt);
    const acceptedCommit = commitMap(completion?.payload.projectHeads).get(publication.projectId);
    if (completion === undefined || acceptedCommit === undefined) {
      throw usageError("Exact completion evidence is unavailable; it cannot be inferred or repaired by adoption.");
    }
    const workspace = reader.getTaskWorkspace(task.id);
    const entry = workspace?.entries.find(e => e.projectId === publication.projectId);
    if (workspace?.owner.type !== "task" || workspace.owner.taskId !== task.id
      || entry === undefined
      || !task.projectBindings.some(b => b.projectId === publication.projectId)) {
      throw usageError("The Publication Project has no Task-owned workspace for local Git evidence.");
    }
    const integration = integrationId === undefined ? null
      : reader.getIntegrationAttempt(task.id, integrationId);
    if (integrationId !== undefined && (integration === null
      || integration.status !== "committed"
      || integration.projectId !== publication.projectId
      || integration.afterCommit !== publication.localCommit)) {
      throw usageError("Integration must be this Task/Project's committed exact publication candidate.");
    }
    return { task, publication, completion, acceptedCommit, workspace, entry, integration, actor };
  };
  const facts = store.transaction(read);
  const git = options.git ?? new NodeGitWorkspace();
  const localCommit = facts.publication.localCommit!;
  const [acceptedTree, candidateTree, diff] = await Promise.all([
    git.resolveTree(facts.entry.path, facts.acceptedCommit),
    git.resolveTree(facts.entry.path, localCommit),
    git.diffTextBetween({ repositoryPath: facts.entry.path,
      fromCommit: facts.acceptedCommit, toCommit: localCommit, exact: true })
  ]);
  // Bind both endpoints even when the text diff is empty (equal trees).
  const diffDigest = createHash("sha256").update(JSON.stringify({
    acceptedCommit: facts.acceptedCommit, localCommit, acceptedTree, candidateTree, diff
  })).digest("hex");
  const evidence = {
    projectId: facts.publication.projectId,
    publicationId: facts.publication.id,
    completionEventId: facts.completion.id,
    acceptedCommit: facts.acceptedCommit,
    localCommit, acceptedTree, candidateTree, diffDigest,
    ...(facts.integration === null ? {} : {
      integrationId: facts.integration.id, integrationDigest: contextContentDigest(facts.integration)
    })
  };
  // No async Git/provider work under the transaction; fixed objects cannot move.
  const event = store.transaction(tx => {
    if (!isDeepStrictEqual(read(tx), facts)) {
      throw usageError("Task, Publication or Integration changed while reading candidate evidence.");
    }
    if (!adopt) return null;
    if (reviewedDiff !== diffDigest) {
      throw usageError(`Reviewed diff does not match this candidate. Read publication diff ${ref.taskId}/${ref.localId}.`);
    }
    const existing = publicationAdoption(facts.publication, facts.completion, facts.acceptedCommit,
      tx.listEvents(facts.task.id), tx.listPublicationReferences(facts.task.id),
      tx.listIntegrationAttempts(facts.task.id)).event;
    if (existing !== null && existing.payload.diffDigest === diffDigest
      && existing.payload.acceptance === acceptance
      && existing.payload.integrationId === integrationId) return existing;
    const saved = createTaskEvent(tx.nextEventId(facts.task.id), facts.task.id,
      PUBLICATION_ADOPTED_EVENT, { ...evidence, acceptance: acceptance!, by: facts.actor },
      options.now?.() ?? new Date());
    tx.saveEvent(facts.task.id, saved);
    return saved;
  });
  return {
    output: event === null
      ? `Publication candidate: ${ref.taskId}/${ref.localId}\nAccepted: ${facts.acceptedCommit}\n`
        + `Candidate: ${localCommit}\nReviewed diff digest: ${diffDigest}\n`
        + "Review all removals, additions and conflict resolutions against the original acceptance before adoption.\n"
        + `${diff}\n`
      : `Adopted Publication candidate ${ref.taskId}/${ref.localId} (${event.id}); remote verification remains separate.\n`,
    data: event === null ? { ...evidence, diff } : event
  };
}
