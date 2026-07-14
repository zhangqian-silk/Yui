import { dataError } from "../errors/cliError.js";
import { createTaskEvent } from "../event/taskEvent.js";
import {
  answerInputRequest,
  autoResolveInputRequest,
  createInputResolutionEventPayload,
  type InputResolution,
  type InputResolutionResult,
  type OperatorPresence
} from "./inputRequest.js";
import {
  operatorDeliveryKey,
  revokeOperatorDelivery
} from "../operator/operatorDelivery.js";
import { createInputResolutionWakeup } from "../scheduler/inputResolutionWakeup.js";
import type { TaskStore } from "../storage/taskStore.js";

export function applyUserInputResolution(
  store: TaskStore,
  taskId: string,
  requestId: string,
  resolutionId: string,
  answer: InputResolution["answer"],
  operatorPresence: OperatorPresence,
  now: Date
): InputResolutionResult {
  const request = loadOpenResolutionTarget(store, taskId, requestId, resolutionId);
  return commitResolution(
    store,
    answerInputRequest(request, resolutionId, answer, operatorPresence, now),
    now
  );
}

export function applyOfflineRecommendedResolution(
  store: TaskStore,
  taskId: string,
  requestId: string,
  resolutionId: string,
  now: Date
): InputResolutionResult {
  const request = loadOpenResolutionTarget(store, taskId, requestId, resolutionId);
  return commitResolution(
    store,
    autoResolveInputRequest(request, resolutionId, "offline", now),
    now
  );
}

function loadOpenResolutionTarget(
  store: TaskStore,
  taskId: string,
  requestId: string,
  resolutionId: string
) {
  const task = store.getTask(taskId);
  if (task === null) {
    throw dataError(`Task not found: ${taskId}`);
  }
  if (task.archived) {
    throw dataError(`Cannot resolve input request for archived task: ${taskId}`);
  }
  const request = store.getInputRequest(taskId, requestId);
  if (request === null) {
    throw dataError(`Input request not found: ${taskId}/${requestId}`);
  }
  if (request.status !== "open") {
    throw dataError(`Input request is not open: ${taskId}/${requestId}`);
  }
  if (store.getInputResolution(taskId, resolutionId) !== null) {
    throw dataError(`Input resolution id already exists: ${taskId}/${resolutionId}`);
  }
  return request;
}

function commitResolution(
  store: TaskStore,
  result: InputResolutionResult,
  now: Date
): InputResolutionResult {
  const { request, resolution } = result;
  store.saveInputResolution(resolution);
  store.saveInputRequest(request);
  store.clearOfflineResolutionClock(request.taskId, request.id);
  store.saveEvent(request.taskId, createTaskEvent(
    store.nextEventId(request.taskId),
    resolution.source === "user" ? "task.input_answered" : "task.input_auto_resolved",
    createInputResolutionEventPayload(resolution),
    now
  ));
  revokeUnacceptedDeliveries(store, request.taskId, request.id, now);
  store.saveInputResolutionWakeup(createInputResolutionWakeup({
    taskId: request.taskId,
    roleName: request.requester.roleName,
    agentId: request.requester.agentId,
    requestId: request.id,
    resolutionId: resolution.id,
    agentRunId: request.requester.agentRunId,
    adapterId: request.requester.adapterId,
    sessionRoot: request.requester.sessionRoot,
    nativeSessionId: request.requester.nativeSessionId
  }, now));
  return result;
}

function revokeUnacceptedDeliveries(
  store: TaskStore,
  taskId: string,
  requestId: string,
  now: Date
): void {
  const key = operatorDeliveryKey({ taskId, requestId });
  for (const delivery of store.listOperatorDeliveries()) {
    if (
      operatorDeliveryKey(delivery) === key &&
      (delivery.status === "pending" || delivery.status === "leased")
    ) {
      store.saveOperatorDelivery(revokeOperatorDelivery(delivery, "request-terminal", now));
    }
  }
}
