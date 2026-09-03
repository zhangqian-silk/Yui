import { isDeepStrictEqual } from "node:util";

import { taskActor } from "./taskActor.js";
import { upsertTaskPublication } from "./taskPublicationCommands.js";
import { projectTaskRemoteDeliveryFromStore } from "./taskRemoteDeliveryCommand.js";
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
import type { TaskRemoteDeliveryCandidate } from "../task/remoteDelivery.js";

export type TaskPublicationVerifyOptions = Readonly<{
  verifiers: Readonly<Partial<Record<PublicationProvider, PublicationVerifier>>>;
  candidateForTask?: (
    taskId: string
  ) => Promise<TaskRemoteDeliveryCandidate | null>;
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
  const initialCandidate = await options.candidateForTask?.(reference.taskId) ?? null;
  const request = preparePublicationVerification(
    store,
    reference.taskId,
    reference.localId,
    initialCandidate,
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
  const finalCandidate = await options.candidateForTask?.(reference.taskId) ?? null;
  const result = commitPublicationVerification(
    store,
    request,
    observation,
    finalCandidate,
    options.now?.() ?? new Date()
  );
  return {
    kind: "output",
    output: result.idempotent
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
  currentCandidate: TaskRemoteDeliveryCandidate | null,
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
    const delivery = projectTaskRemoteDeliveryFromStore(
      reader,
      task,
      currentCandidate
    );
    const project = delivery.projects.find(({ projectId }) => (
      projectId === publication.projectId
    ));
    if (project === undefined) {
      throw usageError(
        `Publication ${publication.id} Project is not bound to Task ${task.id}: `
        + `${publication.projectId}.`
      );
    }
    if (project.expectedLocalCommit === null) {
      throw usageError(
        `Task delivery head is unavailable for Publication ${publication.id}.`
      );
    }
    if (publication.localCommit === undefined) {
      throw usageError(
        `Publication ${publication.id} must record a local commit before verification.`
      );
    }
    if (publication.localCommit !== project.expectedLocalCommit) {
      throw usageError(
        `Publication ${publication.id} local commit ${publication.localCommit} `
        + `does not match Task delivery head ${project.expectedLocalCommit}.`
      );
    }
    return {
      task: taskVerificationInvariant(task),
      actor,
      publication,
      expectedLocalCommit: project.expectedLocalCommit
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
  if (observation.state !== "merged") {
    throw usageError(
      `Remote ${publication.externalKind} ${publication.repository}#`
      + `${publication.externalId} is ${observation.state}, not merged.`
    );
  }
  if (observation.headCommit !== request.expectedLocalCommit) {
    throw usageError(
      `Remote ${publication.externalKind} head ${observation.headCommit} `
      + `does not match Task delivery head ${request.expectedLocalCommit}.`
    );
  }
  if (observation.remoteCommit === undefined) {
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
  currentCandidate: TaskRemoteDeliveryCandidate | null,
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
    const delivery = projectTaskRemoteDeliveryFromStore(
      tx,
      task,
      currentCandidate
    );
    const expectedLocalCommit = delivery.projects.find(({ projectId }) => (
      projectId === request.publication.projectId
    ))?.expectedLocalCommit;
    if (expectedLocalCommit !== request.expectedLocalCommit) {
      throw usageError(
        `Task delivery head changed during Publication verification: `
        + `${request.publication.projectId}@${expectedLocalCommit ?? "unavailable"}.`
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
        remoteCommit: observation.remoteCommit!,
        state: "merged",
        verification: "verified",
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
