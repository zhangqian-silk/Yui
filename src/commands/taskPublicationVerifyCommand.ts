import { isDeepStrictEqual } from "node:util";

import { taskActor } from "./taskActor.js";
import { upsertTaskPublication } from "./taskPublicationCommands.js";
import {
  dataError,
  runtimeError,
  taskNotFound,
  usageError,
  CliError
} from "../errors/cliError.js";
import type { TaskStore } from "../storage/taskStore.js";
import {
  publicationExternalKey,
  type PublicationProvider,
  type PublicationRecordedBy,
  type PublicationReference
} from "../task/publicationReference.js";
import type {
  PublicationVerificationObservation,
  PublicationVerifier
} from "../task/publicationVerification.js";
import type { Task } from "../task/task.js";
import { resolveTaskRecordReference } from "../task/taskRecordReference.js";

export type TaskPublicationVerifyOptions = Readonly<{
  verifiers: Readonly<Partial<Record<PublicationProvider, PublicationVerifier>>>;
  environment?: NodeJS.ProcessEnv;
  now?: () => Date;
}>;

type PublicationVerificationRequest = Readonly<{
  task: TaskVerificationInvariant;
  actor: PublicationRecordedBy;
  publication: PublicationReference;
  expectedLocalCommit: string;
}>;

type TaskVerificationInvariant = Readonly<Pick<
  Task,
  | "id"
  | "status"
  | "projectBindings"
  | "workspaceIdentity"
  | "completedAt"
  | "retiredAt"
>>;

export async function runTaskPublicationVerifyCommand(
  args: readonly string[],
  store: TaskStore,
  options: TaskPublicationVerifyOptions
): Promise<{
  kind: "output";
  output: string;
  data: Readonly<{
    publication: PublicationReference;
    observation: PublicationVerificationObservation;
  }>;
}> {
  const reference = parsePublicationVerificationReference(args);
  const task = store.getTask(reference.taskId);
  if (task === null) throw taskNotFound(reference.taskId);
  if (task.status === "archived") {
    throw usageError(`Archived Task Publication cannot be verified: ${task.id}.`);
  }
  taskActor(options.environment, task.id);
  const request = preparePublicationVerification(
    store,
    reference.taskId,
    reference.localId,
    options.environment
  );
  const verifier = options.verifiers[request.publication.provider];
  if (verifier === undefined) {
    throw usageError(
      `Publication verification is not supported for provider `
      + `${request.publication.provider}.`
    );
  }
  let observation: PublicationVerificationObservation;
  try {
    observation = await verifier.inspect({
      provider: request.publication.provider,
      repository: request.publication.repository,
      externalKind: request.publication.externalKind,
      externalId: request.publication.externalId,
      ...(request.publication.externalUrl === undefined
        ? {}
        : { externalUrl: request.publication.externalUrl }),
      expectedLocalCommit: request.expectedLocalCommit
    });
  } catch (error) {
    if (error instanceof CliError) throw error;
    throw runtimeError(
      `Publication verification failed for ${request.publication.provider}/`
      + `${request.publication.repository}/${request.publication.externalId}: `
      + `${error instanceof Error ? error.message : String(error)}`
    );
  }
  assertVerificationObservation(request, observation);
  const result = commitPublicationVerification(
    store,
    request,
    observation,
    options.now?.() ?? new Date()
  );
  return {
    kind: "output",
    output: result.reference.verification !== "verified"
      ? `Recorded Publication ${result.reference.id}: remote state=${observation.state}; `
        + `head=${observation.headCommit}; local=${request.expectedLocalCommit}. `
        + "Not verified; prior verification is no longer current.\n"
      : result.idempotent
      ? `Publication ${result.reference.id} is already verified for `
        + `${result.reference.repository}#${result.reference.externalId}.\n`
      : `Verified publication ${result.reference.id} for `
        + `${result.reference.repository}#${result.reference.externalId}.\n`,
    data: { publication: result.reference, observation }
  };
}

function preparePublicationVerification(
  store: TaskStore,
  taskId: string,
  publicationId: string,
  environment: NodeJS.ProcessEnv | undefined
): PublicationVerificationRequest {
  return store.transaction((reader) => {
    const task = reader.getTask(taskId);
    if (task === null) throw taskNotFound(taskId);
    if (task.status === "archived") {
      throw usageError(`Archived Task Publication cannot be verified: ${task.id}.`);
    }
    const actor = taskActor(environment, task.id);
    const publication = reader.getPublicationReference(task.id, publicationId);
    if (publication === null) {
      throw dataError(`Publication reference not found: ${task.id}/${publicationId}.`);
    }
    const current = reader.findPublicationReferenceByExternalKey(
      publicationExternalKey(publication)
    );
    if (current === null || current.taskId !== task.id || current.id !== publication.id) {
      throw usageError(
        `Publication ${publication.id} is not the current unsuperseded record `
        + `for ${publicationExternalKey(publication)}.`
      );
    }
    const project = task.projectBindings.find(({ projectId }) => (
      projectId === publication.projectId
    ));
    if (project === undefined) {
      throw usageError(
        `Publication ${publication.id} Project is not bound to Task ${task.id}: `
        + `${publication.projectId}.`
      );
    }
    if (publication.localCommit === undefined) {
      throw usageError(
        `Publication ${publication.id} must record a local commit before verification.`
      );
    }
    return {
      task: taskVerificationInvariant(task),
      actor,
      publication,
      expectedLocalCommit: publication.localCommit
    };
  });
}

function assertVerificationObservation(
  request: PublicationVerificationRequest,
  observation: PublicationVerificationObservation
): void {
  const publication = request.publication;
  if (
    observation.provider !== publication.provider
    || observation.repository !== publication.repository
    || observation.externalKind !== publication.externalKind
    || observation.externalId !== publication.externalId
  ) {
    throw usageError(
      `Provider returned mismatched Publication identity for ${publication.id}.`
    );
  }
  if (!/^[0-9a-f]{40}$/u.test(observation.headCommit)) {
    throw usageError("Provider observation requires an exact remote head.");
  }
  if (observation.state === "merged" && observation.remoteCommit === undefined) {
    throw usageError(
      `Merged remote ${publication.externalKind} did not expose a remote commit.`
    );
  }
  if (observation.evidence.trim().length === 0) {
    throw usageError("Provider verification evidence is required.");
  }
}

function commitPublicationVerification(
  store: TaskStore,
  request: PublicationVerificationRequest,
  observation: PublicationVerificationObservation,
  now: Date
): Readonly<{ reference: PublicationReference; idempotent: boolean }> {
  return store.transaction((tx) => {
    const task = tx.getTask(request.task.id);
    if (task === null) throw taskNotFound(request.task.id);
    if (!isDeepStrictEqual(
      taskVerificationInvariant(task),
      request.task
    )) {
      throw usageError(
        `Task changed during Publication verification: ${request.task.id}.`
      );
    }
    const current = tx.findPublicationReferenceByExternalKey(
      publicationExternalKey(request.publication)
    );
    if (current === null
      || current.taskId !== task.id
      || !isDeepStrictEqual(current, request.publication)) {
      throw usageError(
        `Publication evidence changed during verification: `
        + `${task.id}/${request.publication.id}.`
      );
    }
    return upsertTaskPublication(
      tx,
      task,
      {
        projectId: request.publication.projectId,
        provider: request.publication.provider,
        repository: request.publication.repository,
        externalKind: request.publication.externalKind,
        externalId: request.publication.externalId,
        ...(observation.externalUrl === undefined
          ? {}
          : { externalUrl: observation.externalUrl }),
        localCommit: request.expectedLocalCommit,
        headCommit: observation.headCommit,
        ...(observation.remoteCommit === undefined ? {} : { remoteCommit: observation.remoteCommit }),
        state: observation.state,
        verification: observation.state === "merged"
          && observation.headCommit === request.expectedLocalCommit ? "verified" : "reported",
        evidence: observation.evidence,
        ...(observation.mergedAt === undefined
          ? {}
          : { mergedAt: observation.mergedAt })
      },
      request.actor,
      now
    );
  });
}

function parsePublicationVerificationReference(
  args: readonly string[]
): Readonly<{ taskId: string; localId: string }> {
  const usage = "Task publication verify usage: "
    + "yui task publication verify (<task>/<publication-id> | <task> <publication-id>).";
  if (args.length !== 1 && args.length !== 2) throw usageError(usage);
  return resolveTaskRecordReference(
    args.length === 1 ? args[0]! : `${args[0]}/${args[1]}`,
    { kind: "publicationReference", label: "Publication reference" }
  );
}

function taskVerificationInvariant(task: Task): TaskVerificationInvariant {
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
