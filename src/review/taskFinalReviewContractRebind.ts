import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { requireIdentity, requireTimestamp } from "../domain/validation.js";
import type { TaskEvent, TaskEventPayload } from "../event/taskEvent.js";
import {
  readActiveReleasePointer,
  readHandoverFence,
  readHandoverReceipt,
  releaseDirectoryName,
  releasesDirectory,
  verifyReleaseIntegrity,
  type RuntimeReleaseManifest
} from "../release/runtimeRelease.js";
import {
  exactControlPlaneDigest,
  parseExactControlPlaneDescriptor,
  type ExactControlPlaneDescriptor
} from "../runtime/exactControlPlane.js";
import {
  createTaskFinalReviewContract,
  sameTaskFinalReviewContract,
  validateTaskFinalReviewContract,
  type TaskFinalReviewContract
} from "./taskFinalReviewContract.js";

export const TASK_FINAL_REVIEW_CONTRACT_REBOUND_EVENT =
  "review.task-final-contract-rebound";

export type TaskFinalReviewReleaseIdentity = Readonly<{
  releaseId: string;
  version: string;
  buildId: string;
  packageDigest: string;
  sourceCommit?: string;
}>;

export type TaskFinalReviewContractRebind = Readonly<{
  schemaVersion: 1;
  taskId: string;
  reviewerRoleName: string;
  fromContract: TaskFinalReviewContract;
  toContract: TaskFinalReviewContract;
  fromRelease: TaskFinalReviewReleaseIdentity;
  toRelease: TaskFinalReviewReleaseIdentity;
  handoverId: string;
  authorizedBy: string;
}>;

export type TaskFinalReviewContractObservation = Readonly<{
  contract: TaskFinalReviewContract;
  createdAt: string;
  source: string;
}>;

export type TaskFinalReviewContractResolution = Readonly<{
  initial: TaskFinalReviewContract;
  effective: TaskFinalReviewContract;
  rebinds: readonly TaskFinalReviewContractRebind[];
}>;

export type TaskFinalReviewContractRebindProof = Readonly<{
  schemaVersion: 1;
  taskId: string;
  fromControlPlaneDigest: string;
  toControlPlaneDigest: string;
  fromRelease: TaskFinalReviewReleaseIdentity;
  toRelease: TaskFinalReviewReleaseIdentity;
  handoverId: string;
}>;

export function createTaskFinalReviewContractRebind(input: Readonly<{
  taskId: string;
  reviewerRoleName: string;
  fromContract: TaskFinalReviewContract;
  toControlPlaneDigest: string;
  fromRelease: TaskFinalReviewReleaseIdentity;
  toRelease: TaskFinalReviewReleaseIdentity;
  handoverId: string;
  authorizedBy: string;
}>): TaskFinalReviewContractRebind {
  const taskId = requireIdentity(input.taskId, "Task final-review rebind Task id");
  const reviewerRoleName = requireIdentity(
    input.reviewerRoleName,
    "Task final-review rebind Reviewer Role"
  );
  const fromContract = validateTaskFinalReviewContract(input.fromContract);
  if (fromContract.taskId !== taskId) {
    throw new Error("Task final-review rebind contract belongs to another Task.");
  }
  if (fromContract.reviewerRoleName !== reviewerRoleName) {
    throw new Error("Task final-review rebind changes the Reviewer identity.");
  }
  const toContract = createTaskFinalReviewContract({
    taskId,
    reviewerRoleName,
    controlPlaneDigest: requireDigest(
      input.toControlPlaneDigest,
      "Task final-review rebind target control-plane digest"
    )
  });
  if (fromContract.controlPlaneDigest === toContract.controlPlaneDigest) {
    throw new Error("Task final-review rebind must change the control-plane digest.");
  }
  const fromRelease = validateReleaseIdentity(input.fromRelease, "source");
  const toRelease = validateReleaseIdentity(input.toRelease, "target");
  if (fromRelease.releaseId === toRelease.releaseId) {
    throw new Error("Task final-review rebind must cross an immutable release handover.");
  }
  return Object.freeze({
    schemaVersion: 1,
    taskId,
    reviewerRoleName,
    fromContract,
    toContract,
    fromRelease,
    toRelease,
    handoverId: requireIdentity(input.handoverId, "Task final-review rebind handover id"),
    authorizedBy: requireText(input.authorizedBy, "Task final-review rebind authorizer")
  });
}

export function taskFinalReviewContractRebindPayload(
  rebind: TaskFinalReviewContractRebind
): TaskEventPayload {
  const validated = createTaskFinalReviewContractRebind({
    ...rebind,
    toControlPlaneDigest: rebind.toContract.controlPlaneDigest
  });
  return {
    schemaVersion: "1",
    taskId: validated.taskId,
    reviewerRoleName: validated.reviewerRoleName,
    fromContractDigest: validated.fromContract.digest,
    toContractDigest: validated.toContract.digest,
    fromControlPlaneDigest: validated.fromContract.controlPlaneDigest,
    toControlPlaneDigest: validated.toContract.controlPlaneDigest,
    fromReleaseId: validated.fromRelease.releaseId,
    fromReleaseVersion: validated.fromRelease.version,
    fromReleaseBuildId: validated.fromRelease.buildId,
    fromReleasePackageDigest: validated.fromRelease.packageDigest,
    ...(validated.fromRelease.sourceCommit === undefined
      ? {}
      : { fromReleaseSourceCommit: validated.fromRelease.sourceCommit }),
    toReleaseId: validated.toRelease.releaseId,
    toReleaseVersion: validated.toRelease.version,
    toReleaseBuildId: validated.toRelease.buildId,
    toReleasePackageDigest: validated.toRelease.packageDigest,
    ...(validated.toRelease.sourceCommit === undefined
      ? {}
      : { toReleaseSourceCommit: validated.toRelease.sourceCommit }),
    handoverId: validated.handoverId,
    authorizedBy: validated.authorizedBy
  };
}

export function taskFinalReviewContractRebindFromEvent(
  event: TaskEvent
): TaskFinalReviewContractRebind {
  if (event.type !== TASK_FINAL_REVIEW_CONTRACT_REBOUND_EVENT) {
    throw new Error(`Task event is not a final-review contract rebind: ${event.id}.`);
  }
  const payload = event.payload;
  if (payload.schemaVersion !== "1") {
    throw new Error(`Task final-review rebind event schema is invalid: ${event.id}.`);
  }
  if (payload.taskId !== event.taskId) {
    throw new Error(`Task final-review rebind event belongs to another Task: ${event.id}.`);
  }
  const fromContract = createTaskFinalReviewContract({
    taskId: payload.taskId,
    reviewerRoleName: payload.reviewerRoleName,
    controlPlaneDigest: payload.fromControlPlaneDigest
  });
  if (fromContract.digest !== payload.fromContractDigest) {
    throw new Error(`Task final-review rebind source digest is invalid: ${event.id}.`);
  }
  const rebind = createTaskFinalReviewContractRebind({
    taskId: payload.taskId,
    reviewerRoleName: payload.reviewerRoleName,
    fromContract,
    toControlPlaneDigest: payload.toControlPlaneDigest,
    fromRelease: releaseIdentityFromPayload(payload, "from"),
    toRelease: releaseIdentityFromPayload(payload, "to"),
    handoverId: payload.handoverId,
    authorizedBy: payload.authorizedBy
  });
  if (rebind.toContract.digest !== payload.toContractDigest) {
    throw new Error(`Task final-review rebind target digest is invalid: ${event.id}.`);
  }
  return rebind;
}

/**
 * Historical Candidate and Review records remain immutable. Rebind events form
 * one append-only chain, and each observation must carry the contract that was
 * effective when it was created. Any fork, reversion, or reordered evidence
 * fails closed instead of being repaired or silently normalized.
 */
export function resolveTaskFinalReviewContract(
  taskId: string,
  observations: readonly TaskFinalReviewContractObservation[],
  events: readonly TaskEvent[]
): TaskFinalReviewContractResolution | undefined {
  const normalizedTaskId = requireIdentity(taskId, "Task final-review contract Task id");
  const orderedObservations = [...observations]
    .map((observation) => ({
      contract: validateTaskFinalReviewContract(observation.contract),
      createdAt: requireTimestamp(observation.createdAt, "Task final-review observation createdAt"),
      source: requireText(observation.source, "Task final-review observation source")
    }))
    .sort(compareCreatedAt);
  const orderedEvents = events
    .filter(({ type }) => type === TASK_FINAL_REVIEW_CONTRACT_REBOUND_EVENT)
    .map((event) => ({
      event,
      createdAt: requireTimestamp(event.createdAt, "Task final-review rebind event createdAt"),
      rebind: taskFinalReviewContractRebindFromEvent(event)
    }))
    .sort((left, right) => compareCreatedAt(left, right)
      || left.event.id.localeCompare(right.event.id, undefined, { numeric: true }));

  if (orderedObservations.length === 0) {
    if (orderedEvents.length > 0) {
      throw new Error(`Task ${normalizedTaskId} has a final-review rebind without a stored contract.`);
    }
    return undefined;
  }
  for (const observation of orderedObservations) {
    if (observation.contract.taskId !== normalizedTaskId) {
      throw new Error(`${observation.source} carries a final-review contract for another Task.`);
    }
  }

  const initial = orderedEvents[0]?.rebind.fromContract ?? orderedObservations[0]!.contract;
  if (initial.taskId !== normalizedTaskId) {
    throw new Error(`Task final-review rebind chain belongs to another Task: ${normalizedTaskId}.`);
  }
  let effective = initial;
  for (const [index, entry] of orderedEvents.entries()) {
    const { rebind } = entry;
    if (!sameTaskFinalReviewContract(effective, rebind.fromContract)) {
      throw new Error(`Task final-review rebind chain forks at ${entry.event.id}.`);
    }
    if (rebind.reviewerRoleName !== initial.reviewerRoleName) {
      throw new Error(`Task final-review rebind changes Reviewer identity at ${entry.event.id}.`);
    }
    const initialContractEstablished = index > 0 || orderedObservations.some((observation) => (
      observation.createdAt < entry.createdAt
      && sameTaskFinalReviewContract(observation.contract, rebind.fromContract)
    ));
    if (!initialContractEstablished) {
      throw new Error(`Task final-review rebind ${entry.event.id} has no established source contract.`);
    }
    effective = rebind.toContract;
  }

  for (const observation of orderedObservations) {
    let expected = initial;
    for (const entry of orderedEvents) {
      if (entry.createdAt > observation.createdAt) break;
      expected = entry.rebind.toContract;
    }
    if (!sameTaskFinalReviewContract(observation.contract, expected)) {
      throw new Error(
        `${observation.source} does not match the effective Task final-review contract at creation.`
      );
    }
  }
  return Object.freeze({
    initial,
    effective,
    rebinds: Object.freeze(orderedEvents.map(({ rebind }) => rebind))
  });
}

/**
 * Builds the immutable release proof while the caller holds the release
 * handover lock. The current exact control descriptor is supplied only by the
 * CLI preflight; caller-provided target identities are checked against it.
 */
export function prepareTaskFinalReviewContractRebindProof(input: Readonly<{
  home: string;
  taskId: string;
  fromControlPlaneDigest: string;
  toControlPlaneDigest: string;
  fromReleaseId: string;
  toReleaseId: string;
  currentControlPlane: ExactControlPlaneDescriptor;
}>): TaskFinalReviewContractRebindProof {
  const home = resolve(input.home);
  const taskId = requireIdentity(input.taskId, "Task final-review rebind Task id");
  const fromControlPlaneDigest = requireDigest(
    input.fromControlPlaneDigest,
    "Task final-review rebind source control-plane digest"
  );
  const toControlPlaneDigest = requireDigest(
    input.toControlPlaneDigest,
    "Task final-review rebind target control-plane digest"
  );
  if (fromControlPlaneDigest === toControlPlaneDigest) {
    throw new Error("Task final-review rebind source and target control planes are identical.");
  }
  if (exactControlPlaneDigest(input.currentControlPlane) !== toControlPlaneDigest) {
    throw new Error("Task final-review rebind target is not the current exact control plane.");
  }
  if (resolve(input.currentControlPlane.yuiHome) !== home) {
    throw new Error("Task final-review rebind target control plane belongs to another Home.");
  }
  const fromReleaseId = requireText(input.fromReleaseId, "Source release id");
  const toReleaseId = requireText(input.toReleaseId, "Target release id");
  if (fromReleaseId === toReleaseId) {
    throw new Error("Task final-review rebind source and target releases are identical.");
  }
  if (readHandoverFence(home) !== null) {
    throw new Error("Task final-review rebind is blocked by an unfinished release handover.");
  }
  const active = readActiveReleasePointer(home);
  if (active === null
    || active.releaseId !== toReleaseId
    || active.buildId !== input.currentControlPlane.buildId
    || active.packageDigest !== input.currentControlPlane.activeReleaseDigest) {
    throw new Error("The active release does not match the requested target release and exact control plane.");
  }

  const sourcePath = join(home, "runtime", "control-plane", `${fromControlPlaneDigest}.json`);
  const sourceControl = parseExactControlPlaneDescriptor(readFileSync(sourcePath, "utf8"));
  if (exactControlPlaneDigest(sourceControl) !== fromControlPlaneDigest) {
    throw new Error("Task final-review rebind source control-plane descriptor digest is invalid.");
  }
  if (resolve(sourceControl.yuiHome) !== home) {
    throw new Error("Task final-review rebind source control plane belongs to another Home.");
  }
  const fromRelease = installedReleaseIdentity(home, fromReleaseId, sourceControl, "source");
  const toRelease = installedReleaseIdentity(
    home,
    toReleaseId,
    input.currentControlPlane,
    "target"
  );
  const handover = readHandoverReceipt(home);
  if (handover === null
    || handover.outcome !== "completed"
    || handover.previousReleaseId !== fromReleaseId
    || handover.activatedReleaseId !== toReleaseId
    || typeof handover.handoverId !== "string"
    || handover.handoverId.length === 0) {
    throw new Error(
      "Task final-review rebind requires the exact completed release handover from source to target."
    );
  }
  return Object.freeze({
    schemaVersion: 1,
    taskId,
    fromControlPlaneDigest,
    toControlPlaneDigest,
    fromRelease,
    toRelease,
    handoverId: handover.handoverId
  });
}

function installedReleaseIdentity(
  home: string,
  releaseId: string,
  control: ExactControlPlaneDescriptor,
  label: "source" | "target"
): TaskFinalReviewReleaseIdentity {
  if (control.buildId === undefined || control.activeReleaseDigest === undefined) {
    throw new Error(`Task final-review rebind ${label} control plane is not an immutable release.`);
  }
  let manifest: RuntimeReleaseManifest;
  try {
    manifest = verifyReleaseIntegrity(join(releasesDirectory(home), releaseId));
  } catch (error) {
    throw new Error(
      `Task final-review rebind ${label} release is unknown or invalid: ${releaseId}.`,
      { cause: error }
    );
  }
  if (releaseDirectoryName(manifest) !== releaseId
    || manifest.buildId !== control.buildId
    || manifest.packageDigest !== control.activeReleaseDigest) {
    throw new Error(`Task final-review rebind ${label} release does not match its control plane.`);
  }
  return validateReleaseIdentity({
    releaseId,
    version: manifest.version,
    buildId: manifest.buildId,
    packageDigest: manifest.packageDigest,
    ...(manifest.sourceCommit === undefined ? {} : { sourceCommit: manifest.sourceCommit })
  }, label);
}

function releaseIdentityFromPayload(
  payload: TaskEventPayload,
  prefix: "from" | "to"
): TaskFinalReviewReleaseIdentity {
  const title = prefix === "from" ? "From" : "To";
  return validateReleaseIdentity({
    releaseId: payload[`${prefix}ReleaseId`],
    version: payload[`${prefix}ReleaseVersion`],
    buildId: payload[`${prefix}ReleaseBuildId`],
    packageDigest: payload[`${prefix}ReleasePackageDigest`],
    ...(payload[`${prefix}ReleaseSourceCommit`] === undefined
      ? {}
      : { sourceCommit: payload[`${prefix}ReleaseSourceCommit`] })
  }, title);
}

function validateReleaseIdentity(
  value: TaskFinalReviewReleaseIdentity,
  label: string
): TaskFinalReviewReleaseIdentity {
  return Object.freeze({
    releaseId: requireText(value.releaseId, `Task final-review rebind ${label} release id`),
    version: requireText(value.version, `Task final-review rebind ${label} release version`),
    buildId: requireText(value.buildId, `Task final-review rebind ${label} release build id`),
    packageDigest: requireDigest(
      value.packageDigest,
      `Task final-review rebind ${label} release package digest`
    ),
    ...(value.sourceCommit === undefined
      ? {}
      : { sourceCommit: requireText(value.sourceCommit, `Task final-review rebind ${label} source commit`) })
  });
}

function compareCreatedAt(
  left: Readonly<{ createdAt: string }>,
  right: Readonly<{ createdAt: string }>
): number {
  return left.createdAt.localeCompare(right.createdAt);
}

function requireDigest(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/u.test(value)) {
    throw new Error(`${label} is invalid.`);
  }
  return value;
}

function requireText(value: unknown, label: string): string {
  if (typeof value !== "string" || value.includes("\0")) {
    throw new Error(`${label} is invalid.`);
  }
  const normalized = value.trim();
  if (normalized.length === 0) throw new Error(`${label} is required.`);
  return normalized;
}
