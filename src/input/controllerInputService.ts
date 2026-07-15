import { dataError } from "../errors/cliError.js";
import { createTaskEvent } from "../event/taskEvent.js";
import {
  cancelInputRequest,
  assertInputRequesterWithNativeSession,
  createInputRequest,
  createInputRequestEventPayload,
  type CreateInputRequest,
  type InputRequesterWithNativeSession,
  type InputResolution,
  type InputResolutionResult,
  type OperatorPresence
} from "./inputRequest.js";
import { listGlobalInputRequests, resolveGlobalInputRequest } from "./globalInputQuery.js";
import {
  createOperatorDelivery,
  operatorDeliveryKey,
  revokeOperatorDelivery
} from "../operator/operatorDelivery.js";
import { blockAgentRunForInput, resumeBlockedAgentRun } from "../run/agentRun.js";
import { executeDomainTransaction } from "../storage/domainTransaction.js";
import { FileTaskStore, type TaskStore } from "../storage/taskStore.js";
import { applyUserInputResolution } from "./inputResolutionTransaction.js";

export type ControllerInputIds = {
  nextRequestId(): string;
  nextResolutionId(): string;
  nextDeliveryId(): string;
};

export type CreateControllerInputRequest = {
  taskId: string;
  requester: InputRequesterWithNativeSession;
  input: CreateInputRequest;
};

export type ResolveControllerInputRequest = {
  requestId: string;
  taskId?: string;
  answer: InputResolution["answer"];
  operatorPresence: OperatorPresence;
};

export type CancelControllerInputRequest = {
  taskId: string;
  requestId: string;
  requester: InputRequesterWithNativeSession;
  reason: string;
};

/**
 * Controller-only mutation facade for task-owned input state. Each operation
 * is one #34 domain transaction; the outbox is a transport pointer and no
 * method creates a second Inbox or Operator-session authority.
 */
export class ControllerInputService {
  constructor(
    private readonly rootDir: string,
    private readonly ids: ControllerInputIds
  ) {}

  create(
    transactionId: string,
    command: CreateControllerInputRequest,
    now: Date
  ) {
    return executeDomainTransaction(this.rootDir, transactionId, (workingRoot) => {
      const store = new FileTaskStore(workingRoot);
      return this.createInStore(store, command, now);
    });
  }

  createInStore(
    store: TaskStore,
    command: CreateControllerInputRequest,
    now: Date
  ) {
    const task = requireAvailableTask(store, command.taskId);
    const origin = requireActiveLeaderOrigin(store, command.taskId, command.requester, "active");
    assertBlockedReferences(store, command.taskId, command.input);

    const request = createInputRequest(
      nextUniqueRequestId(store, this.ids),
      task.id,
      command.requester,
      command.input,
      now
    );
    const delivery = createOperatorDelivery(
      nextUniqueDeliveryId(store, this.ids),
      nextDeliverySequence(store),
      request.taskId,
      request.id,
      now
    );
    const blockedRun = blockAgentRunForInput(origin.run, request.id, now);

    store.saveInputRequest(request);
    store.saveAgentRun(blockedRun);
    store.saveActiveAgentRun(blockedRun);
    store.saveEvent(request.taskId, createTaskEvent(
      store.nextEventId(request.taskId),
      "task.input_requested",
      createInputRequestEventPayload(request),
      now
    ));
    store.saveOperatorDelivery(delivery);
    return request;
  }

  resolve(
    transactionId: string,
    command: ResolveControllerInputRequest,
    now: Date
  ): InputResolutionResult {
    return executeDomainTransaction(this.rootDir, transactionId, (workingRoot) => {
      const store = new FileTaskStore(workingRoot);
      return this.resolveInStore(store, command, now);
    });
  }

  resolveInStore(
    store: TaskStore,
    command: ResolveControllerInputRequest,
    now: Date
  ): InputResolutionResult {
    const request = resolveGlobalInputRequest(store, command.requestId, command.taskId);
    requireAvailableTask(store, request.taskId);
    if (request.status !== "open") {
      throw dataError(`Input request is not open: ${request.taskId}/${request.id}`);
    }
    const originRun = store.getAgentRun(request.taskId, request.requester.agentRunId);
    if (originRun === null || originRun.roleName !== "leader") {
      throw dataError(`Input request origin is unavailable: ${request.taskId}/${request.id}`);
    }
    return applyUserInputResolution(
      store,
      request.taskId,
      request.id,
      nextUniqueResolutionId(store, request.taskId, this.ids),
      command.answer,
      command.operatorPresence,
      now
    );
  }

  answer(
    transactionId: string,
    command: ResolveControllerInputRequest,
    now: Date
  ): InputResolutionResult {
    return this.resolve(transactionId, command, now);
  }

  answerInStore(
    store: TaskStore,
    command: ResolveControllerInputRequest,
    now: Date
  ): InputResolutionResult {
    return this.resolveInStore(store, command, now);
  }

  cancel(
    transactionId: string,
    command: CancelControllerInputRequest,
    now: Date
  ) {
    return executeDomainTransaction(this.rootDir, transactionId, (workingRoot) => {
      const store = new FileTaskStore(workingRoot);
      return this.cancelInStore(store, command, now);
    });
  }

  cancelInStore(
    store: TaskStore,
    command: CancelControllerInputRequest,
    now: Date
  ) {
    requireAvailableTask(store, command.taskId);
    const request = store.getInputRequest(command.taskId, command.requestId);
    if (request === null) {
      throw dataError(`Input request not found: ${command.taskId}/${command.requestId}`);
    }
    if (request.status !== "open") {
      throw dataError(`Input request is not open: ${command.taskId}/${command.requestId}`);
    }
    assertInputRequesterWithNativeSession(request.requester);
    assertSameOrigin(request.requester, command.requester);
    const origin = requireActiveLeaderOrigin(store, command.taskId, command.requester, "blocked");
    if (origin.run.blockedBy?.requestId !== request.id) {
      throw dataError(`Leader origin is not blocked by input request: ${command.taskId}/${request.id}`);
    }

    const cancelled = cancelInputRequest(request, command.reason, now);
    const resumed = resumeBlockedAgentRun(origin.run, request.id, now);
    store.saveInputRequest(cancelled);
    store.saveAgentRun(resumed);
    store.saveActiveAgentRun(resumed);
    store.clearOfflineResolutionClock(command.taskId, command.requestId);
    store.clearInputResolutionWakeup(command.taskId, command.requestId);
    store.saveEvent(command.taskId, createTaskEvent(
      store.nextEventId(command.taskId),
      "task.input_cancelled",
      createInputRequestEventPayload(cancelled),
      now
    ));
    revokeUnacceptedDeliveries(store, command.taskId, command.requestId, "request-terminal", now);
    return cancelled;
  }
}

function requireAvailableTask(store: TaskStore, taskId: string) {
  const task = store.getTask(taskId);
  if (task === null) {
    throw dataError(`Task not found: ${taskId}`);
  }
  if (task.archived) {
    throw dataError(`Task is archived: ${taskId}`);
  }
  return task;
}

function requireActiveLeaderOrigin(
  store: TaskStore,
  taskId: string,
  requester: InputRequesterWithNativeSession,
  expectedStatus: "active" | "blocked"
) {
  const active = store.getActiveAgentRun(taskId, "leader");
  const recorded = store.getAgentRun(taskId, requester.agentRunId);
  const role = store.getRole(taskId, "leader");
  const sessionSet = store.getRoleSessionSet(taskId, "leader");
  const binding = role?.agentBindings[requester.agentId];
  const session = sessionSet?.sessions[requester.agentId];
  if (
    active === null ||
    recorded === null ||
    active.id !== requester.agentRunId ||
    recorded.id !== requester.agentRunId ||
    active.status !== expectedStatus ||
    recorded.status !== expectedStatus ||
    active.roleName !== "leader" ||
    recorded.roleName !== "leader" ||
    role === null ||
    role.activeAgentId !== requester.agentId ||
    sessionSet === null ||
    sessionSet.activeAgentId !== requester.agentId ||
    binding === undefined ||
    binding.adapterId !== requester.adapterId ||
    session === undefined ||
    session.agentId !== requester.agentId ||
    session.adapterId !== requester.adapterId ||
    session.sessionRoot !== requester.sessionRoot ||
    session.nativeSessionId !== requester.nativeSessionId ||
    session.status !== "running"
  ) {
    throw dataError(`Leader origin does not match active session: ${taskId}`);
  }
  return { run: active, session, sessionSet };
}

function assertSameOrigin(
  expected: InputRequesterWithNativeSession,
  actual: InputRequesterWithNativeSession
): void {
  if (
    expected.roleName !== actual.roleName ||
    expected.agentId !== actual.agentId ||
    expected.adapterId !== actual.adapterId ||
    expected.sessionRoot !== actual.sessionRoot ||
    expected.agentRunId !== actual.agentRunId ||
    expected.nativeSessionId !== actual.nativeSessionId
  ) {
    throw dataError("Only the originating Leader origin may mutate this input request.");
  }
}

function assertBlockedReferences(
  store: TaskStore,
  taskId: string,
  input: CreateInputRequest
): void {
  for (const reference of input.blockedRefs) {
    const exists = reference.type === "work-item"
      ? store.getWorkItem(taskId, reference.id) !== null
      : reference.type === "decision"
        ? store.getDecision(taskId, reference.id) !== null
        : store.getTask(reference.id) !== null;
    if (!exists) {
      throw dataError(`Blocked reference not found: ${reference.type}/${reference.id}`);
    }
  }
}

function revokeUnacceptedDeliveries(
  store: TaskStore,
  taskId: string,
  requestId: string,
  reason: "request-terminal",
  now: Date
): void {
  const key = operatorDeliveryKey({ taskId, requestId });
  for (const delivery of store.listOperatorDeliveries()) {
    if (
      operatorDeliveryKey(delivery) === key &&
      (delivery.status === "pending" || delivery.status === "leased")
    ) {
      store.saveOperatorDelivery(revokeOperatorDelivery(delivery, reason, now));
    }
  }
}

function nextUniqueRequestId(store: TaskStore, ids: ControllerInputIds): string {
  const used = new Set(
    listGlobalInputRequests(store, { includeTerminal: true }).map((request) => request.id)
  );
  return nextUnique("input request", ids.nextRequestId, (id) => !used.has(id));
}

function nextUniqueResolutionId(
  store: TaskStore,
  taskId: string,
  ids: ControllerInputIds
): string {
  return nextUnique("input resolution", ids.nextResolutionId, (id) =>
    store.getInputResolution(taskId, id) === null
  );
}

function nextUniqueDeliveryId(store: TaskStore, ids: ControllerInputIds): string {
  return nextUnique("operator delivery", ids.nextDeliveryId, (id) =>
    store.getOperatorDelivery(id) === null
  );
}

function nextDeliverySequence(store: TaskStore): number {
  const last = store.listOperatorDeliveries().at(-1);
  return (last?.sequence ?? 0) + 1;
}

function nextUnique(label: string, next: () => string, available: (id: string) => boolean): string {
  for (let attempt = 0; attempt < 32; attempt += 1) {
    const id = next();
    if (/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(id) && available(id)) {
      return id;
    }
  }
  throw dataError(`Could not allocate a unique ${label} id.`);
}
