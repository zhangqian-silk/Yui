import type { TaskStore } from "../storage/taskStore.js";
import type { ProviderRuntimeBinding } from "../runtime/providerRuntimeIdentity.js";
import {
  admitProviderRetry, cancelProviderRetry, providerRetryAttemptId, providerRetryPending,
  type ProviderInput, type ProviderRetry
} from "../runtime/providerRetry.js";
import { blockingProviderContinuations } from "../runtime/runtimeContinuationProjection.js";
import { validateExactRunReviewRound } from "../lifecycle/exactRunTerminalization.js";
import { isDeepStrictEqual } from "node:util";

export type OwnedProviderAdmission = Readonly<{
  taskId?: string; roleName: string; runId?: string; agentId: string;
  nativeSessionId: string; attemptId: string; now: Date;
  boundedText?: string; retrySupported?: boolean;
}>;

export function ownedProviderInput(input: OwnedProviderAdmission): ProviderInput | undefined {
  if (input.runId !== undefined && input.taskId !== undefined) {
    return { kind: "run", taskId: input.taskId, runId: input.runId };
  }
  const wake = /^notification:([^/]+)\/([^/]+)\//u.exec(input.attemptId);
  if (wake !== null && wake[1] === input.taskId) {
    return { kind: "wake", taskId: wake[1]!, wakeId: wake[2]! };
  }
  const message = /^global-input:([^/]+)\/([^/]+)$/u.exec(input.attemptId);
  if (message !== null && message[1] === input.roleName && input.taskId === undefined) {
    return { kind: "message", roleName: input.roleName, messageId: message[2]! };
  }
  return input.boundedText === undefined ? undefined : { kind: "text", text: input.boundedText };
}

export function retryIntentBlocker(
  store: TaskStore, input: Pick<OwnedProviderAdmission, "taskId" | "roleName">, retry: ProviderRetry
): string | undefined {
  if (input.taskId === undefined) {
    const role = store.getGlobalRole(input.roleName);
    const sessions = store.getGlobalRoleSessionSet(input.roleName);
    if (role === null || sessions?.activeAgentId !== role.activeAgentId) return "role-changed";
    if (sessions.sessions[sessions.activeAgentId]?.effective.sourceDesiredRevision !== role.launchRevision) return "role-configuration-changed";
    if (store.listGlobalRoleMessages(input.roleName).some(message =>
      Date.parse(message.createdAt) > Date.parse(retry.intentAt)
      && message.delivery === undefined && message.notDelivered === undefined)) return "new-user-input";
    return undefined;
  }
  const task = store.getTask(input.taskId);
  if (task === null || !["active", "draft"].includes(task.status)
    || task.executionGate.state !== "enabled") return "task-execution-stopped";
  const role = store.getRole(input.taskId, input.roleName);
  const sessions = store.getTaskRoleSessionSet(input.taskId, input.roleName);
  if (role === null || sessions?.activeAgentId !== role.activeAgentId) return "role-changed";
  if (sessions.sessions[sessions.activeAgentId]?.effective.sourceDesiredRevision !== role.launchRevision) return "role-configuration-changed";
  if (store.listMessages(input.taskId).some(message =>
    (message.kind === "operator" || message.kind === "user")
    && Date.parse(message.createdAt) > Date.parse(retry.intentAt))) return "new-user-input";
  if (blockingProviderContinuations(store.listEvents(input.taskId)).some(c =>
    c.roleName === input.roleName && c.identity.conversationId === retry.nativeSessionId)) {
    return "background-work-unsettled";
  }
  return undefined;
}

/** Shared by automatic recovery and every ordinary Host submit. The native
 * writer CAS remains the only grant; a scheduled successor is not a grant. */
export function admitOwnedProviderInput(
  store: TaskStore, binding: ProviderRuntimeBinding, input: OwnedProviderAdmission
): ProviderRuntimeBinding {
  const retry = binding.retry;
  const sameReviewSuccessor = retry?.successorReviewRoundId !== undefined && input.taskId !== undefined && input.runId !== undefined
    && store.getRun(input.taskId, input.runId)?.reviewRoundId === retry.successorReviewRoundId;
  if (retry !== undefined && !providerRetryPending(binding)
    && (input.attemptId.startsWith("provider-retry:") || input.runId !== undefined && input.runId === retry.successorRunId
      || sameReviewSuccessor)) {
    throw new Error(`Provider retry is ${retry.status}; this scheduled successor cannot regain admission.`);
  }
  if (!providerRetryPending(binding) || retry === undefined) return binding;
  const automatic = input.attemptId === providerRetryAttemptId(retry)
    || input.runId !== undefined && input.runId === retry.successorRunId
    || input.runId !== undefined && input.taskId !== undefined && retry.successorReviewRoundId !== undefined
      && store.getRun(input.taskId, input.runId)?.reviewRoundId === retry.successorReviewRoundId
    || retry.status === "in-flight" && input.attemptId === retry.currentAttemptId;
  if (!automatic) return cancelProviderRetry(binding, "superseded-by-explicit-input", input.now.getTime());
  const blocker = retryIntentBlocker(store, input, retry);
  if (blocker !== undefined) throw new Error(`Provider retry admission stopped: ${blocker}.`);
  if (input.retrySupported !== true) throw new Error("This Host cannot prove safe same-Session recovery; use explicit recovery.");
  if (binding.goal?.status === "active") throw new Error("Provider still owns an autonomous Goal; inspect its exact continuation.");
  if (input.taskId !== undefined && input.runId !== undefined) {
    const run = store.getRun(input.taskId, input.runId);
    const sessions = store.getTaskRoleSessionSet(input.taskId, input.roleName);
    if (run === null || run.status !== "active"
      || !isDeepStrictEqual(run.effective, sessions?.sessions[input.agentId]?.effective)) {
      throw new Error("Retry execution no longer matches its fixed native Session.");
    }
    if (run.workspace !== undefined && !isDeepStrictEqual(store.getManagedWorkspace(run.workspace.owner), run.workspace)) {
      throw new Error("Retry workspace authority changed.");
    }
    if (run.workItemId !== undefined) {
      const item = store.getWorkItem(input.taskId, run.workItemId);
      if (item?.status !== "open" || run.purpose !== "review" && run.executionLaneId === undefined
        && item.assignee !== run.roleName) throw new Error("Retry WorkItem responsibility changed.");
    }
    if (validateExactRunReviewRound(store, run).disposition !== "applied") {
      throw new Error("Retry Review no longer matches its exact Round and frozen candidate.");
    }
  }
  const admitted = admitProviderRetry(binding, { attemptId: input.attemptId, at: input.now.getTime() });
  return input.runId === undefined ? admitted
    : { ...admitted, retry: { ...admitted.retry!, successorRunId: input.runId } };
}
