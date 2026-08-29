import type { WorkMailbox } from "../coordination/workMailbox.js";
import {
  roleAgentSessionResumeMode,
  type TaskRoleSessionSet
} from "../executor/agentExecutor.js";
import {
  effectiveLaunchSnapshotsCompatibleForTaskSession,
  type EffectiveLaunchSnapshot
} from "../executor/effectiveLaunch.js";
import type { TaskEvent } from "../event/taskEvent.js";
import {
  currentProviderActivation,
  currentProviderConversation
} from "./providerRuntimeIdentity.js";
import { blockingProviderContinuations } from "./runtimeContinuationProjection.js";
import { runtimeObservationFromTaskEvent } from "./runtimeObservation.js";

export const CONVERSATION_SWITCH_REQUESTED_EVENT = "runtime.conversation-switch-requested";
export const CONVERSATION_SWITCH_RESOLVED_EVENT = "runtime.conversation-switch-resolved";
export const CONVERSATION_SWITCH_DETACHED_EVENT = "runtime.conversation-switch-detached";

export type ConversationSwitchStatus = Readonly<{
  requestId: string;
  roleName: string;
  generation: string;
  requestedBy: "user" | "operator" | "leader";
  reason: string;
  requestedAt: string;
  status: "pending" | "applied" | "obsolete";
  resolvedAt?: string;
}>;

export type ConversationReplacementBasis =
  | "actor-request"
  | "exact-unrecoverable";

export function providerConversationGeneration(
  sessions: TaskRoleSessionSet | null
): string | null {
  const binding = sessions?.providerBinding;
  if (binding === null || binding === undefined) return null;
  const current = currentProviderConversation(binding);
  return `${binding.providerNamespace}:${binding.accountScope}:${current.epoch}:${current.conversationId}`;
}

export function projectConversationSwitch(
  events: readonly TaskEvent[],
  roleName: string,
  sessions: TaskRoleSessionSet | null
): ConversationSwitchStatus | null {
  const requests = events.filter((event) => (
    event.type === CONVERSATION_SWITCH_REQUESTED_EVENT
    && event.payload.roleName === roleName
  ));
  const request = requests.at(-1);
  if (request === undefined) return null;
  const requestId = request.payload.requestId;
  const generation = request.payload.generation;
  const requestedBy = request.payload.requestedBy;
  const reason = request.payload.reason;
  if (requestId === undefined || generation === undefined || reason === undefined
    || (requestedBy !== "user" && requestedBy !== "operator" && requestedBy !== "leader")) {
    return null;
  }
  const resolution = [...events].reverse().find((event) => (
    event.type === CONVERSATION_SWITCH_RESOLVED_EVENT
    && event.payload.requestId === requestId
  ));
  const explicitStatus = resolution?.payload.status;
  const currentGeneration = providerConversationGeneration(sessions);
  const status = explicitStatus === "applied" || explicitStatus === "obsolete"
    ? explicitStatus
    : currentGeneration !== null && currentGeneration !== generation
      ? "obsolete"
      : "pending";
  return {
    requestId,
    roleName,
    generation,
    requestedBy,
    reason,
    requestedAt: request.createdAt,
    status,
    ...(resolution === undefined ? {} : { resolvedAt: resolution.createdAt })
  };
}

export function pendingConversationSwitch(
  events: readonly TaskEvent[],
  roleName: string,
  sessions: TaskRoleSessionSet | null
): ConversationSwitchStatus | null {
  const projected = projectConversationSwitch(events, roleName, sessions);
  return projected?.status === "pending" ? projected : null;
}

export function roleSessionDispatchModeWithConversationSwitch(
  sessions: TaskRoleSessionSet | null,
  events: readonly TaskEvent[],
  mailbox: WorkMailbox | null,
  roleName: string,
  agentId: string,
  effective: EffectiveLaunchSnapshot
): "new" | "resume" {
  const ordinary = roleAgentSessionResumeMode(sessions, agentId, effective);
  if (ordinary !== "resume") {
    if (sessions?.providerBinding !== null && sessions?.providerBinding !== undefined) {
      if (freshConversationLaunchAllowed({ sessions, events, mailbox, roleName })) {
        return "new";
      }
      const existing = sessions.sessions[agentId];
      if (existing?.nativeSessionId !== undefined
        && (existing.status === "stopped" || existing.status === "broken")
        && effectiveLaunchSnapshotsCompatibleForTaskSession(existing.effective, effective)) {
        // A terminal local Activation does not prove the Provider Conversation
        // is gone. Reattach to the same native identity by default.
        return "resume";
      }
      throw new Error(
        `Fresh Provider Conversation is not yet safe: ${sessions.owner.taskId}/${roleName}.`
      );
    }
    return ordinary;
  }
  if (sessions?.providerBinding !== null && sessions?.providerBinding !== undefined
    && freshConversationLaunchAllowed({ sessions, events, mailbox, roleName })) {
    return "new";
  }
  return "resume";
}

export function conversationDetachmentBasis(input: Readonly<{
  sessions: TaskRoleSessionSet;
  events: readonly TaskEvent[];
  mailbox: WorkMailbox | null;
  roleName: string;
  runId: string;
  runMode: "new" | "resume";
}>): "actor-request" | null {
  const { sessions, mailbox } = input;
  const binding = sessions.providerBinding;
  const activation = binding === null ? null : currentProviderActivation(binding);
  if (input.runMode !== "new" || binding === null || activation === null
    || sessions.inFlight?.runId !== input.runId
    || mailbox?.processing?.batchId !== sessions.inFlight.receiptId
    || mailbox.processing.owner !== "controller"
    || mailbox.processing.executionRef?.type !== "run"
    || mailbox.processing.executionRef.taskId !== sessions.owner.taskId
    || mailbox.processing.executionRef.id !== input.runId
    || !actorRequestedSwitchBoundaryReady(sessions, mailbox)
    || currentConversationExecutionBlockers(sessions, input.events, input.roleName).length > 0
    || pendingConversationSwitch(input.events, input.roleName, sessions) === null) {
    return null;
  }
  return "actor-request";
}

export function conversationReplacementBasis(input: Readonly<{
  sessions: TaskRoleSessionSet;
  events: readonly TaskEvent[];
  mailbox: WorkMailbox | null;
  roleName: string;
  runId: string;
  runMode: "new" | "resume";
}>): ConversationReplacementBasis | null {
  const { sessions, mailbox } = input;
  const binding = sessions.providerBinding;
  if (input.runMode !== "new" || binding === null
    || sessions.inFlight?.runId !== input.runId
    || mailbox?.processing?.batchId !== sessions.inFlight.receiptId
    || mailbox.processing.owner !== "controller"
    || mailbox?.processing?.executionRef?.type !== "run"
    || mailbox.processing.executionRef.taskId !== sessions.owner.taskId
    || mailbox.processing.executionRef.id !== input.runId
    || mailbox.inputDelivery !== null
    || !conversationIsQuiescent(sessions, mailbox)
    || currentConversationExecutionBlockers(sessions, input.events, input.roleName).length > 0) {
    return null;
  }
  if (currentConversationIsExactlyUnrecoverable(
    sessions,
    input.events,
    input.roleName
  )) return "exact-unrecoverable";
  return pendingConversationSwitch(input.events, input.roleName, sessions) === null
    ? null
    : "actor-request";
}

export function freshConversationLaunchAllowed(input: Readonly<{
  sessions: TaskRoleSessionSet | null;
  events: readonly TaskEvent[];
  mailbox: WorkMailbox | null;
  roleName: string;
  candidateRunId?: string;
}>): boolean {
  return freshConversationLaunchBlockers(input).length === 0;
}

/** Exact reasons a fresh Conversation cannot currently be admitted. */
export function freshConversationLaunchBlockers(input: Readonly<{
  sessions: TaskRoleSessionSet | null;
  events: readonly TaskEvent[];
  mailbox: WorkMailbox | null;
  roleName: string;
  candidateRunId?: string;
}>): readonly string[] {
  const { sessions } = input;
  if (sessions === null) return [];
  const session = sessions.sessions[sessions.activeAgentId];
  if (sessions.providerBinding === null) {
    return session === undefined
      || session.status === "stopped"
      || session.status === "broken"
      ? []
      : ["native-session-not-terminal"];
  }
  const request = pendingConversationSwitch(input.events, input.roleName, sessions);
  const binding = sessions.providerBinding;
  const blockers: string[] = [];
  if (input.mailbox?.inputDelivery != null) blockers.push("provider-input-delivery-unsettled");
  if (binding.turn !== null
    && ["submitting", "accepted", "running", "delivery-unknown"].includes(
      binding.turn.status
    )) blockers.push("provider-turn-unsettled");
  blockers.push(...currentConversationExecutionBlockers(
    sessions,
    input.events,
    input.roleName
  ));
  if (blockers.length > 0) return blockers;
  if (request !== null && actorRequestedSwitchBoundaryReady(
    sessions,
    input.mailbox,
    input.candidateRunId
  )) return [];
  if (currentProviderActivation(binding) !== null) blockers.push("provider-activation-active");
  if (binding.authority.owner !== "none") blockers.push("provider-writer-authority-owned");
  if (blockers.length > 0) return blockers;
  if (currentProviderConversation(binding).recoverability === "unrecoverable") {
    return currentConversationIsExactlyUnrecoverable(
      sessions,
      input.events,
      input.roleName
    ) ? [] : ["exact-unrecoverable-evidence-missing"];
  }
  if (request !== null) return ["actor-switch-boundary-not-ready"];
  return ["current-conversation-recoverable"];
}

function actorRequestedSwitchBoundaryReady(
  sessions: TaskRoleSessionSet | null,
  mailbox: WorkMailbox | null,
  candidateRunId?: string
): boolean {
  const binding = sessions?.providerBinding;
  if (sessions === null || sessions === undefined
    || binding === null || binding === undefined
    || mailbox?.inputDelivery != null) return false;
  const turnSettled = binding.turn === null
    || ["completed", "failed", "cancelled", "rejected"].includes(binding.turn.status);
  if (!turnSettled) return false;
  const session = sessions.sessions[sessions.activeAgentId];
  if (session?.status === "running") return false;
  const activation = currentProviderActivation(binding);
  if (activation === null) return binding.authority.owner === "none";
  if (binding.authority.owner !== "controller"
    || binding.authority.holderId !== activation.activationId) return false;
  if (session === undefined) return false;
  if (sessions.inFlight === null) {
    if (mailbox?.processing === null) return true;
    return candidateRunId !== undefined
      && mailbox?.processing?.owner === "controller"
      && mailbox.processing.executionRef?.type === "run"
      && mailbox.processing.executionRef.taskId === sessions.owner.taskId
      && mailbox.processing.executionRef.id === candidateRunId;
  }
  return mailbox?.processing?.batchId === sessions.inFlight.receiptId
    && mailbox.processing.owner === "controller"
    && mailbox.processing.executionRef?.type === "run"
    && mailbox.processing.executionRef.taskId === sessions.owner.taskId
    && mailbox.processing.executionRef.id === sessions.inFlight.runId;
}

function conversationIsQuiescent(
  sessions: TaskRoleSessionSet | null,
  mailbox: WorkMailbox | null
): boolean {
  const binding = sessions?.providerBinding;
  if (binding === null || binding === undefined) return false;
  const turnSettled = binding.turn === null
    || ["completed", "failed", "cancelled", "rejected"].includes(binding.turn.status);
  return turnSettled
    && currentProviderActivation(binding) === null
    && binding.authority.owner === "none"
    && mailbox?.inputDelivery == null;
}

/**
 * A projected recoverability flag is necessary but not sufficient to replace
 * a Conversation. Require the exact structured missing-Conversation fact for
 * the current Provider identity and latest Activation generation, so an old
 * observation cannot authorize a later fresh Conversation. The binding's Run
 * id is deliberately excluded: replacement work rebinds that fence before
 * launching, while the missing fact necessarily came from the preceding Run's
 * exact attempt to resume this same Activation.
 */
function currentConversationIsExactlyUnrecoverable(
  sessions: TaskRoleSessionSet,
  events: readonly TaskEvent[],
  roleName: string
): boolean {
  const binding = sessions.providerBinding;
  if (binding === null) return false;
  const conversation = currentProviderConversation(binding);
  if (conversation.recoverability !== "unrecoverable") return false;
  const activation = [...binding.activations].reverse().find((entry) => (
    entry.conversationId === conversation.conversationId
  ));
  const generationStartedAt = activation?.startedAt ?? conversation.createdAt;
  return events.some((event) => {
    const observation = runtimeObservationFromTaskEvent(event);
    if (observation === null
      || observation.kind !== "conversation.observed"
      || observation.payload.recoverability !== "unrecoverable"
      || (observation.authority !== "provider-structured"
        && observation.authority !== "controller")) return false;
    const fence = observation.fence;
    if (fence.taskId !== sessions.owner.taskId
      || fence.roleName !== roleName
      || fence.agentId !== binding.accountScope
      || fence.driverId !== binding.providerNamespace
      || fence.conversationId !== conversation.conversationId
      || (activation !== undefined && fence.activationId !== activation.activationId)) {
      return false;
    }
    return Date.parse(observation.observedAt ?? observation.receivedAt)
      >= Date.parse(generationStartedAt);
  });
}

/** Current Provider-owned work that may outlive a foreground Turn. */
function currentConversationExecutionBlockers(
  sessions: TaskRoleSessionSet,
  events: readonly TaskEvent[],
  roleName: string
): readonly string[] {
  const binding = sessions.providerBinding;
  if (binding === null) return [];
  const conversation = currentProviderConversation(binding);
  const activation = [...binding.activations].reverse().find((entry) => (
    entry.conversationId === conversation.conversationId
  ));
  if (activation === undefined) return ["provider-activation-identity-missing"];
  const activeOperation = events.some((event) => {
    const observation = runtimeObservationFromTaskEvent(event);
    if (observation?.kind !== "operation.started") return false;
    const fence = observation.fence;
    return fence.taskId === sessions.owner.taskId
      && fence.roleName === roleName
      && fence.agentId === binding.accountScope
      && fence.driverId === binding.providerNamespace
      && (fence.conversationId ?? fence.nativeSessionId) === conversation.conversationId
      && (fence.activationId ?? fence.launchId) === activation.activationId;
  });
  const blockingContinuation = blockingProviderContinuations(events).some((entry) => (
    entry.taskId === sessions.owner.taskId
    && entry.roleName === roleName
    && entry.identity.providerNamespace === binding.providerNamespace
    && entry.identity.accountScope === binding.accountScope
    && entry.identity.conversationId === conversation.conversationId
    && entry.identity.activationId === activation.activationId
  ));
  return [
    ...(activeOperation ? ["provider-operation-active"] : []),
    ...(blockingContinuation ? ["provider-continuation-writer-owned"] : [])
  ];
}
