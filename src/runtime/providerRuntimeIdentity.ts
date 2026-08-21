export type ProviderConversationRecoverability = "unknown" | "recoverable" | "unrecoverable";
export type ProviderConversationStatus = "current" | "superseded";
export type ProviderActivationStatus = "active" | "ended" | "failed";

export type ProviderConversation = Readonly<{
  conversationId: string;
  epoch: number;
  status: ProviderConversationStatus;
  recoverability: ProviderConversationRecoverability;
  createdAt: string;
  supersededAt?: string;
}>;

export type ProviderActivation = Readonly<{
  activationId: string;
  conversationId: string;
  generation: number;
  status: ProviderActivationStatus;
  writerLease: boolean;
  startedAt: string;
  endedAt?: string;
  terminalReason?: string;
}>;

export type ProviderRuntimeBinding = Readonly<{
  schemaVersion: 1;
  providerNamespace: string;
  accountScope: string;
  runId: string;
  currentConversationEpoch: number;
  conversations: readonly ProviderConversation[];
  activations: readonly ProviderActivation[];
}>;

export function createProviderRuntimeBinding(input: Readonly<{
  providerNamespace: string;
  accountScope: string;
  runId: string;
  conversationId: string;
  activationId: string;
  startedAt: string;
}>): ProviderRuntimeBinding {
  const startedAt = timestamp(input.startedAt, "Provider Activation startedAt");
  return validateProviderRuntimeBinding({
    schemaVersion: 1,
    providerNamespace: identity(input.providerNamespace, "Provider namespace"),
    accountScope: identity(input.accountScope, "Provider account scope"),
    runId: identity(input.runId, "Run id"),
    currentConversationEpoch: 1,
    conversations: [{
      conversationId: identity(input.conversationId, "Provider Conversation id"),
      epoch: 1,
      status: "current",
      recoverability: "unknown",
      createdAt: startedAt
    }],
    activations: [{
      activationId: identity(input.activationId, "Provider Activation id"),
      conversationId: input.conversationId,
      generation: 1,
      status: "active",
      writerLease: true,
      startedAt
    }]
  });
}

export function currentProviderConversation(
  binding: ProviderRuntimeBinding
): ProviderConversation {
  validateProviderRuntimeBinding(binding);
  return binding.conversations.find((entry) => (
    entry.epoch === binding.currentConversationEpoch && entry.status === "current"
  ))!;
}

export function currentProviderActivation(
  binding: ProviderRuntimeBinding
): ProviderActivation | null {
  const conversation = currentProviderConversation(binding);
  return [...binding.activations].reverse().find((entry) => (
    entry.conversationId === conversation.conversationId && entry.status === "active"
  )) ?? null;
}

export function startProviderActivation(
  raw: ProviderRuntimeBinding,
  input: Readonly<{ activationId: string; startedAt: string }>
): ProviderRuntimeBinding {
  const binding = validateProviderRuntimeBinding(raw);
  if (currentProviderActivation(binding) !== null) {
    throw new Error("Provider Conversation already has a live writer Activation.");
  }
  const conversation = currentProviderConversation(binding);
  const generation = binding.activations
    .filter((entry) => entry.conversationId === conversation.conversationId)
    .reduce((maximum, entry) => Math.max(maximum, entry.generation), 0) + 1;
  return validateProviderRuntimeBinding({
    ...binding,
    activations: [...binding.activations, {
      activationId: identity(input.activationId, "Provider Activation id"),
      conversationId: conversation.conversationId,
      generation,
      status: "active",
      writerLease: true,
      startedAt: timestamp(input.startedAt, "Provider Activation startedAt")
    }]
  });
}

export function endProviderActivation(
  raw: ProviderRuntimeBinding,
  activationId: string,
  input: Readonly<{ status: "ended" | "failed"; endedAt: string; reason?: string }>
): ProviderRuntimeBinding {
  const binding = validateProviderRuntimeBinding(raw);
  const id = identity(activationId, "Provider Activation id");
  const target = binding.activations.find((entry) => entry.activationId === id);
  if (target === undefined) throw new Error(`Provider Activation is not recorded: ${id}.`);
  if (target.status !== "active") return binding;
  const endedAt = timestamp(input.endedAt, "Provider Activation endedAt");
  if (Date.parse(endedAt) < Date.parse(target.startedAt)) {
    throw new Error("Provider Activation endedAt is earlier than startedAt.");
  }
  return validateProviderRuntimeBinding({
    ...binding,
    activations: binding.activations.map((entry) => entry.activationId === id
      ? {
          ...entry,
          status: input.status,
          writerLease: false,
          endedAt,
          ...(input.reason === undefined
            ? {}
            : { terminalReason: identity(input.reason, "Provider Activation terminal reason") })
        }
      : entry)
  });
}

export function updateProviderConversationRecoverability(
  raw: ProviderRuntimeBinding,
  recoverability: ProviderConversationRecoverability
): ProviderRuntimeBinding {
  const binding = validateProviderRuntimeBinding(raw);
  const current = currentProviderConversation(binding);
  return validateProviderRuntimeBinding({
    ...binding,
    conversations: binding.conversations.map((entry) => entry.epoch === current.epoch
      ? { ...entry, recoverability }
      : entry)
  });
}

export function supersedeProviderConversation(
  raw: ProviderRuntimeBinding,
  input: Readonly<{
    conversationId: string;
    activationId: string;
    switchedAt: string;
    noUnsettledInputDelivery: boolean;
    writerUmbrellaClear: boolean;
  }>
): ProviderRuntimeBinding {
  const binding = validateProviderRuntimeBinding(raw);
  const current = currentProviderConversation(binding);
  if (current.recoverability !== "unrecoverable") {
    throw new Error("Current Provider Conversation is not exactly unrecoverable.");
  }
  if (!input.noUnsettledInputDelivery) {
    throw new Error("Cannot replace a Provider Conversation with unsettled input delivery.");
  }
  if (!input.writerUmbrellaClear || currentProviderActivation(binding) !== null) {
    throw new Error("Cannot replace a Provider Conversation while its writer umbrella is owned.");
  }
  const switchedAt = timestamp(input.switchedAt, "Provider Conversation switch timestamp");
  const epoch = current.epoch + 1;
  return validateProviderRuntimeBinding({
    ...binding,
    currentConversationEpoch: epoch,
    conversations: [
      ...binding.conversations.map((entry) => entry.epoch === current.epoch
        ? { ...entry, status: "superseded" as const, supersededAt: switchedAt }
        : entry),
      {
        conversationId: identity(input.conversationId, "Provider Conversation id"),
        epoch,
        status: "current",
        recoverability: "unknown",
        createdAt: switchedAt
      }
    ],
    activations: [...binding.activations, {
      activationId: identity(input.activationId, "Provider Activation id"),
      conversationId: input.conversationId,
      generation: 1,
      status: "active",
      writerLease: true,
      startedAt: switchedAt
    }]
  });
}

export function validateProviderRuntimeBinding(value: ProviderRuntimeBinding): ProviderRuntimeBinding {
  if (value.schemaVersion !== 1) throw new Error("Provider Runtime Binding schemaVersion must be 1.");
  identity(value.providerNamespace, "Provider namespace");
  identity(value.accountScope, "Provider account scope");
  identity(value.runId, "Run id");
  integer(value.currentConversationEpoch, 1, "Current Provider Conversation epoch");
  if (!Array.isArray(value.conversations) || value.conversations.length === 0) {
    throw new Error("Provider Runtime Binding requires a Conversation.");
  }
  const conversationIds = new Set<string>();
  const epochs = new Set<number>();
  let currentCount = 0;
  for (const conversation of value.conversations) {
    identity(conversation.conversationId, "Provider Conversation id");
    integer(conversation.epoch, 1, "Provider Conversation epoch");
    if (conversationIds.has(conversation.conversationId) || epochs.has(conversation.epoch)) {
      throw new Error("Provider Runtime Binding contains duplicate Conversation identity.");
    }
    conversationIds.add(conversation.conversationId);
    epochs.add(conversation.epoch);
    if (conversation.status !== "current" && conversation.status !== "superseded") {
      throw new Error("Provider Conversation status is invalid.");
    }
    if (!["unknown", "recoverable", "unrecoverable"].includes(conversation.recoverability)) {
      throw new Error("Provider Conversation recoverability is invalid.");
    }
    timestamp(conversation.createdAt, "Provider Conversation createdAt");
    if (conversation.status === "current") {
      currentCount += 1;
      if (conversation.epoch !== value.currentConversationEpoch) {
        throw new Error("Current Provider Conversation epoch is inconsistent.");
      }
      if (conversation.supersededAt !== undefined) {
        throw new Error("Current Provider Conversation cannot be superseded.");
      }
    } else if (conversation.supersededAt === undefined) {
      throw new Error("Superseded Provider Conversation requires supersededAt.");
    } else {
      timestamp(conversation.supersededAt, "Provider Conversation supersededAt");
    }
  }
  if (currentCount !== 1) throw new Error("Provider Runtime Binding requires one current Conversation.");
  const activationIds = new Set<string>();
  const activeByConversation = new Set<string>();
  const generations = new Set<string>();
  for (const activation of value.activations) {
    identity(activation.activationId, "Provider Activation id");
    if (activationIds.has(activation.activationId)) {
      throw new Error("Provider Runtime Binding contains duplicate Activation identity.");
    }
    activationIds.add(activation.activationId);
    if (!conversationIds.has(activation.conversationId)) {
      throw new Error("Provider Activation references an unknown Conversation.");
    }
    integer(activation.generation, 1, "Provider Activation generation");
    const generationKey = `${activation.conversationId}\u0000${activation.generation}`;
    if (generations.has(generationKey)) {
      throw new Error("Provider Runtime Binding contains duplicate Activation generation.");
    }
    generations.add(generationKey);
    if (!["active", "ended", "failed"].includes(activation.status)) {
      throw new Error("Provider Activation status is invalid.");
    }
    timestamp(activation.startedAt, "Provider Activation startedAt");
    if (activation.status === "active") {
      if (!activation.writerLease || activation.endedAt !== undefined) {
        throw new Error("Active Provider Activation must hold its writer lease.");
      }
      if (activeByConversation.has(activation.conversationId)) {
        throw new Error("Provider Conversation has multiple live writer Activations.");
      }
      activeByConversation.add(activation.conversationId);
    } else {
      if (activation.writerLease || activation.endedAt === undefined) {
        throw new Error("Terminal Provider Activation must release its writer lease.");
      }
      timestamp(activation.endedAt, "Provider Activation endedAt");
    }
  }
  return value;
}

function identity(value: string, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0) throw new Error(`${label} is invalid.`);
  return value.trim();
}

function timestamp(value: string, label: string): string {
  const normalized = identity(value, label);
  if (!Number.isFinite(Date.parse(normalized))) throw new Error(`${label} must be a timestamp.`);
  return normalized;
}

function integer(value: number, minimum: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < minimum) throw new Error(`${label} is invalid.`);
  return value;
}
