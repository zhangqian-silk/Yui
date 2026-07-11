import { CliError } from "../errors/cliError.js";
import type { TaskStore } from "./taskStore.js";

const resilientReadMethods = new Set<keyof TaskStore>([
  "getConfig",
  "listTasks",
  "getTask",
  "getTaskTopics",
  "getTaskInputDraft",
  "getPendingWakeup",
  "listPendingWakeups",
  "getLeaderFailure",
  "getOperatorNotification",
  "getTaskSchedule",
  "getCycle",
  "listCycles",
  "getWorkItem",
  "listWorkItems",
  "getAgentSession",
  "getAgentRun",
  "getActiveAgentRun",
  "readTaskBrief",
  "readTaskTopicSummaries",
  "getMilestone",
  "listMilestones",
  "getDecision",
  "getRoleWorktree",
  "listDecisions",
  "listRoles",
  "getRole",
  "getChildRole",
  "listChildRoles",
  "listGlobalRoles",
  "getGlobalRole",
  "listComments",
  "listEvents",
  "readTranscript",
  "listCustomRunners",
  "getCustomRunner"
]);

export function createResilientTaskStore(
  store: TaskStore,
  onInvalidData: (error: CliError, method: keyof TaskStore, args: unknown[]) => void
): TaskStore {
  const lastValid = new Map<string, unknown>();

  return new Proxy(store, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver) as unknown;
      if (
        typeof property !== "string" ||
        !resilientReadMethods.has(property as keyof TaskStore) ||
        typeof value !== "function"
      ) {
        return typeof value === "function" ? value.bind(target) : value;
      }

      return (...args: unknown[]) => {
        const key = `${property}:${JSON.stringify(args)}`;
        try {
          const result = Reflect.apply(value, target, args) as unknown;
          lastValid.set(key, result);
          return result;
        } catch (error) {
          if (!(error instanceof CliError) || error.code !== "DATA_ERROR" || !lastValid.has(key)) {
            throw error;
          }
          onInvalidData(error, property as keyof TaskStore, args);
          return lastValid.get(key);
        }
      };
    }
  }) as TaskStore;
}

export function primeResilientTaskStore(store: TaskStore): void {
  store.getConfig();
  for (const role of store.listGlobalRoles()) {
    store.getGlobalRole(role.name);
  }
  for (const runner of store.listCustomRunners()) {
    store.getCustomRunner(runner.id);
  }

  for (const task of store.listTasks()) {
    store.getTask(task.id);
    store.getTaskTopics(task.id);
    store.getTaskInputDraft(task.id);
    store.getPendingWakeup(task.id);
    store.getLeaderFailure(task.id);
    store.getOperatorNotification(task.id);
    store.getTaskSchedule(task.id);
    store.readTaskBrief(task.id);
    store.readTaskTopicSummaries(task.id);
    store.listComments(task.id);
    store.listEvents(task.id);

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
