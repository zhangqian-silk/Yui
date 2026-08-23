import {
  currentProviderActivation,
  currentProviderConversation,
  validateProviderRuntimeBinding,
  type ProviderRuntimeBinding
} from "./providerRuntimeIdentity.js";
import type { ProviderConversationProbe } from "./providerControl.js";

export type ProviderRecoveryDecision =
  | Readonly<{ action: "resume"; conversationId: string }>
  | Readonly<{ action: "observe-active-turn"; conversationId: string; turnId: string }>
  | Readonly<{ action: "replace"; conversationId: string }>
  | Readonly<{ action: "attention"; conversationId: string; reason: string }>;

/**
 * Exact tri-state recovery policy. Unknown is a terminal decision for the
 * automatic recovery attempt, not permission to create another Conversation.
 */
export function decideProviderRecovery(input: Readonly<{
  binding: ProviderRuntimeBinding;
  probe: ProviderConversationProbe;
  unsettledInputDelivery: boolean;
}>): ProviderRecoveryDecision {
  const binding = validateProviderRuntimeBinding(input.binding);
  const conversation = currentProviderConversation(binding);
  if (input.probe.conversationId !== conversation.conversationId) {
    throw new Error("Provider recovery probe targets a different Conversation.");
  }
  if (input.probe.state === "unknown") {
    return {
      action: "attention",
      conversationId: conversation.conversationId,
      reason: "Provider Conversation existence is unknown; replacement is fenced."
    };
  }
  if (input.probe.state === "exists") {
    if (input.probe.activeTurnId !== undefined) {
      return {
        action: "observe-active-turn",
        conversationId: conversation.conversationId,
        turnId: input.probe.activeTurnId
      };
    }
    if (input.unsettledInputDelivery || providerTurnIsUnsettled(binding)) {
      return {
        action: "attention",
        conversationId: conversation.conversationId,
        reason: "Provider Conversation exists but prior input delivery is still unsettled."
      };
    }
    return { action: "resume", conversationId: conversation.conversationId };
  }
  if (input.unsettledInputDelivery || providerTurnIsUnsettled(binding)) {
    return {
      action: "attention",
      conversationId: conversation.conversationId,
      reason: "Provider Conversation is missing but input delivery remains unsettled."
    };
  }
  if (currentProviderActivation(binding) !== null || binding.authority.owner !== "none") {
    return {
      action: "attention",
      conversationId: conversation.conversationId,
      reason: "Provider Conversation is missing but its Activation writer has not ended."
    };
  }
  return { action: "replace", conversationId: conversation.conversationId };
}

function providerTurnIsUnsettled(binding: ProviderRuntimeBinding): boolean {
  return binding.turn !== null
    && ["submitting", "accepted", "running", "delivery-unknown"].includes(binding.turn.status);
}
