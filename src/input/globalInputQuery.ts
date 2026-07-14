import { dataError } from "../errors/cliError.js";
import type { TaskStore } from "../storage/taskStore.js";
import type { InputRequest } from "./inputRequest.js";

export type GlobalInputRequestRef = {
  taskId: string;
  requestId: string;
};

/**
 * The global inbox is a read model built from durable task-owned requests. It
 * must never become a second persisted request body or answer authority.
 */
export function listGlobalInputRequests(
  store: Pick<TaskStore, "listTasks" | "listInputRequests">,
  options: { includeTerminal?: boolean } = {}
): InputRequest[] {
  return store.listTasks()
    .flatMap((task) => store.listInputRequests(task.id))
    .filter((request) => options.includeTerminal === true || request.status === "open")
    .sort((left, right) =>
      left.createdAt.localeCompare(right.createdAt) ||
      compositeInputRequestKey(left).localeCompare(compositeInputRequestKey(right))
    );
}

export function resolveGlobalInputRequest(
  store: Pick<TaskStore, "listTasks" | "listInputRequests" | "getInputRequest">,
  requestId: string,
  taskId?: string
): InputRequest {
  const normalizedRequestId = normalizePointer(requestId, "Input request id");
  if (taskId !== undefined) {
    const normalizedTaskId = normalizePointer(taskId, "Task id");
    const request = store.getInputRequest(normalizedTaskId, normalizedRequestId);
    if (request === null) {
      throw dataError(`Input request not found: ${normalizedTaskId}/${normalizedRequestId}`);
    }
    return request;
  }

  const matches = store.listTasks().flatMap((task) =>
    store.listInputRequests(task.id).filter((request) => request.id === normalizedRequestId)
  );
  if (matches.length === 0) {
    throw dataError(`Input request not found: ${normalizedRequestId}`);
  }
  if (matches.length > 1) {
    throw dataError(`Input request id is ambiguous: ${normalizedRequestId}`);
  }
  return matches[0];
}

export function compositeInputRequestKey(
  value: Pick<InputRequest, "taskId" | "id">
): string {
  return `${value.taskId}\u0000${value.id}`;
}

function normalizePointer(value: string, label: string): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value)) {
    throw dataError(`Invalid ${label.toLowerCase()}`);
  }
  return value;
}
