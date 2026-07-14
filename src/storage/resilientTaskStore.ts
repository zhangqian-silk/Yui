import { CliError } from "../errors/cliError.js";
import type { TaskReader, TaskStore } from "./taskStore.js";

// Only derived renderings can remain available after an isolated malformed
// edit. Every domain record that can drive an action must fail closed rather
// than mixing an older cached generation with current authoritative state.
const cacheableReadMethods = new Set<keyof TaskReader>([
  "readTaskBrief",
  "readTaskTopicSummaries",
  "listComments",
  "listEvents",
  "readTranscript"
]);

export function createResilientTaskStore(
  store: TaskStore,
  onInvalidData: (error: CliError, method: keyof TaskStore, args: unknown[]) => void
): TaskStore {
  const lastValid = new Map<string, unknown>();
  const clone = <T>(value: T): T => structuredClone(value);
  const resilientMethod = (current: TaskReader, property: keyof TaskReader, value: Function) =>
    (...args: unknown[]) => {
      const key = `${String(property)}:${JSON.stringify(args)}`;
      try {
        const snapshot = clone(Reflect.apply(value, current, args) as unknown);
        lastValid.set(key, snapshot);
        return clone(snapshot);
      } catch (error) {
        if (
          !(error instanceof CliError) ||
          error.code !== "DATA_ERROR" ||
          !lastValid.has(key)
        ) {
          throw error;
        }
        onInvalidData(error, property, args);
        return clone(lastValid.get(key));
      }
    };
  const wrapReader = (target: TaskReader): TaskReader => {
    // The native FileTaskStore reader is already immutable and callback-bound.
    // A Proxy cannot substitute functions on its non-configurable properties,
    // so create a separate bounded facade when derived reads need a cache.
    if (Object.isFrozen(target)) {
      const reader = Object.create(null) as Record<string, unknown>;
      for (const property of Object.keys(target) as Array<keyof TaskReader>) {
        const value = target[property] as unknown;
        if (property === "runReadSnapshot" && typeof value === "function") {
          reader[property] = <T>(execute: (snapshot: TaskReader) => T): T =>
            target.runReadSnapshot((snapshot) => execute(wrapReader(snapshot)));
        } else if (
          cacheableReadMethods.has(property) &&
          typeof value === "function"
        ) {
          reader[property] = resilientMethod(target, property, value);
        } else {
          reader[property] = typeof value === "function" ? value.bind(target) : value;
        }
      }
      return Object.freeze(reader) as TaskReader;
    }
    return new Proxy(target, {
      get(current, property, receiver) {
        const value = Reflect.get(current, property, receiver) as unknown;
        if (property === "runReadSnapshot" && typeof value === "function") {
          return <T>(execute: (snapshot: TaskReader) => T): T =>
            current.runReadSnapshot((snapshot) => execute(wrapReader(snapshot)));
        }
        if (
          typeof property === "string" &&
          cacheableReadMethods.has(property as keyof TaskReader) &&
          typeof value === "function"
        ) {
          return resilientMethod(current, property as keyof TaskReader, value);
        }
        return typeof value === "function" ? value.bind(current) : value;
      }
    }) as TaskReader;
  };

  return new Proxy(store, {
    get(current, property, receiver) {
      const value = Reflect.get(current, property, receiver) as unknown;
      if (property === "runReadSnapshot" && typeof value === "function") {
        return <T>(execute: (snapshot: TaskReader) => T): T =>
          current.runReadSnapshot((snapshot) => execute(wrapReader(snapshot)));
      }
      if (
        typeof property === "string" &&
        cacheableReadMethods.has(property as keyof TaskReader) &&
        typeof value === "function"
      ) {
        return resilientMethod(current, property as keyof TaskReader, value);
      }
      return typeof value === "function" ? value.bind(current) : value;
    }
  }) as TaskStore;
}

export function primeResilientTaskStore(store: TaskStore): void {
  store.runReadSnapshot((snapshot) => primeResilientTaskStoreSnapshot(snapshot));
}

function primeResilientTaskStoreSnapshot(store: TaskReader): void {
  store.getConfig();
  store.listTrashedTaskIds();
  for (const wakeup of store.listPendingWakeups()) {
    store.getPendingWakeup(wakeup.taskId);
  }
  for (const role of store.listGlobalRoles()) {
    store.getGlobalRole(role.name);
  }
  for (const agent of store.listConfiguredAgents()) {
    store.getConfiguredAgent(agent.id);
  }

  for (const task of store.listTasks()) {
    store.getTask(task.id);
    store.getTaskTopics(task.id);
    store.getTaskInputDraft(task.id);
    for (const request of store.listInputRequests(task.id)) {
      store.getInputRequest(task.id, request.id);
    }
    for (const resolution of store.listInputResolutions(task.id)) {
      store.getInputResolution(task.id, resolution.id);
    }
    store.getPendingWakeup(task.id);
    store.getLeaderFailure(task.id);
    store.getOperatorNotification(task.id);
    store.getTaskSchedule(task.id);
    store.readTaskBrief(task.id);
    store.readTaskTopicSummaries(task.id);
    store.listComments(task.id);
    store.listEvents(task.id);
    for (const run of store.listAgentRuns(task.id)) {
      store.getAgentRun(task.id, run.id);
    }

    for (const cycle of store.listCycles(task.id)) {
      store.getCycle(task.id, cycle.id);
    }
    for (const workItem of store.listWorkItems(task.id)) {
      store.getWorkItem(task.id, workItem.id);
    }
    for (const milestone of store.listMilestones(task.id)) {
      store.getMilestone(task.id, milestone.id);
    }
    for (const decision of store.listDecisions(task.id)) {
      store.getDecision(task.id, decision.id);
    }
    for (const childRole of store.listChildRoles(task.id)) {
      store.getChildRole(task.id, childRole.name);
    }
    for (const role of store.listRoles(task.id)) {
      store.getRole(task.id, role.name);
      store.getRoleWorktree(task.id, role.name);
      store.getAgentSession(task.id, role.name);
      store.getActiveAgentRun(task.id, role.name);
      store.readTranscript(task.id, role.name);
    }
  }
}
