export type ProviderConversationRecoverability = "unknown" | "recoverable" | "unrecoverable";
export type ProviderConversationStatus = "current" | "superseded";
export type ProviderActivationStatus = "active" | "ended" | "failed";
export type ProviderAuthorityOwner = "controller" | "human" | "none" | "unknown";
export type ProviderTurnStatus =
  | "submitting"
  | "accepted"
  | "running"
  | "completed"
  | "failed"
  | "cancelled"
  | "rejected"
  | "delivery-unknown";

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
  startedAt: string;
  endedAt?: string;
  terminalReason?: string;
}>;

/**
 * One monotonically fenced writer authority for the current Conversation.
 * It is deliberately independent from the Provider process: a human may take
 * over the same live Activation without creating or resuming a Conversation.
 */
export type ProviderAuthority = Readonly<{
  epoch: number;
  owner: ProviderAuthorityOwner;
  holderId?: string;
  changedAt: string;
}>;

export type ProviderTurn = Readonly<{
  /** Correlation only: workflow ownership remains in AgentRun. */
  runId: string;
  attemptId: string;
  authorityEpoch: number;
  status: ProviderTurnStatus;
  submittedAt: string;
  updatedAt: string;
  turnId?: string;
  terminalReason?: string;
}>;

export type ProviderRuntimeBinding = Readonly<{
  schemaVersion: 3;
  providerNamespace: string;
  accountScope: string;
  currentConversationEpoch: number;
  conversations: readonly ProviderConversation[];
  activations: readonly ProviderActivation[];
  authority: ProviderAuthority;
  turn: ProviderTurn | null;
}>;

export function createProviderRuntimeBinding(input: Readonly<{
  providerNamespace: string;
  accountScope: string;
  conversationId: string;
  activationId: string;
  startedAt: string;
}>): ProviderRuntimeBinding {
  const startedAt = timestamp(input.startedAt, "Provider Activation startedAt");
  return validateProviderRuntimeBinding({
    schemaVersion: 3,
    providerNamespace: identity(input.providerNamespace, "Provider namespace"),
    accountScope: identity(input.accountScope, "Provider account scope"),
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
      startedAt
    }],
    authority: {
      epoch: 1,
      owner: "controller",
      holderId: input.activationId,
      changedAt: startedAt
    },
    turn: null
  });
}

export function currentProviderAuthority(binding: ProviderRuntimeBinding): ProviderAuthority {
  return validateProviderRuntimeBinding(binding).authority;
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
  if (binding.authority.owner !== "none") {
    throw new Error("Provider Conversation authority must be unowned before a new Activation starts.");
  }
  const conversation = currentProviderConversation(binding);
  const generation = binding.activations
    .filter((entry) => entry.conversationId === conversation.conversationId)
    .reduce((maximum, entry) => Math.max(maximum, entry.generation), 0) + 1;
  const startedAt = timestamp(input.startedAt, "Provider Activation startedAt");
  const activationId = identity(input.activationId, "Provider Activation id");
  return validateProviderRuntimeBinding({
    ...binding,
    activations: [...binding.activations, {
      activationId,
      conversationId: conversation.conversationId,
      generation,
      status: "active",
      startedAt
    }],
    authority: {
      epoch: binding.authority.epoch + 1,
      owner: "controller",
      holderId: activationId,
      changedAt: startedAt
    }
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
          endedAt,
          ...(input.reason === undefined
            ? {}
            : { terminalReason: identity(input.reason, "Provider Activation terminal reason") })
        }
      : entry),
    authority: {
      epoch: binding.authority.epoch + 1,
      owner: "none",
      changedAt: endedAt
    }
  });
}

/**
 * Compare-and-swap the only Provider writer. A stale Controller or detached
 * terminal cannot regain authority with an older epoch.
 */
export function transferProviderAuthority(
  raw: ProviderRuntimeBinding,
  input: Readonly<{
    expectedEpoch: number;
    expectedOwner: ProviderAuthorityOwner;
    owner: "controller" | "human" | "none";
    holderId?: string;
    changedAt: string;
  }>
): ProviderRuntimeBinding {
  const binding = validateProviderRuntimeBinding(raw);
  if (binding.authority.epoch !== input.expectedEpoch
    || binding.authority.owner !== input.expectedOwner) {
    throw new Error("Provider authority fence is stale.");
  }
  if (providerTurnIsActive(binding.turn)) {
    throw new Error("Provider authority cannot transfer while a Turn is unsettled.");
  }
  const active = currentProviderActivation(binding);
  const changedAt = timestamp(input.changedAt, "Provider authority changedAt");
  if (Date.parse(changedAt) < Date.parse(binding.authority.changedAt)) {
    throw new Error("Provider authority changedAt moved backwards.");
  }
  let holderId: string | undefined;
  if (input.owner === "none") {
    if (input.holderId !== undefined) {
      throw new Error("Unowned Provider authority cannot name a holder.");
    }
  } else {
    if (active === null) {
      throw new Error("Provider authority requires a live Activation.");
    }
    holderId = identity(input.holderId!, "Provider authority holder id");
    if (input.owner === "controller" && holderId !== active.activationId) {
      throw new Error("Controller authority must be held by the live Activation.");
    }
  }
  return validateProviderRuntimeBinding({
    ...binding,
    authority: {
      epoch: binding.authority.epoch + 1,
      owner: input.owner,
      ...(holderId === undefined ? {} : { holderId }),
      changedAt
    }
  });
}

export function beginProviderTurn(
  raw: ProviderRuntimeBinding,
  input: Readonly<{
    runId: string;
    attemptId: string;
    authorityEpoch: number;
    submittedAt: string;
  }>
): ProviderRuntimeBinding {
  const binding = validateProviderRuntimeBinding(raw);
  const runId = identity(input.runId, "Run id");
  const attemptId = identity(input.attemptId, "Provider input attempt id");
  if (binding.turn?.runId === runId
    && binding.turn.attemptId === attemptId
    && binding.turn.authorityEpoch === input.authorityEpoch
    && binding.turn.status === "submitting") {
    return binding;
  }
  if (binding.authority.epoch !== input.authorityEpoch
    || binding.authority.owner === "none"
    || binding.authority.owner === "unknown") {
    throw new Error("Provider Turn authority fence is stale.");
  }
  if (providerTurnIsActive(binding.turn)) {
    throw new Error("Provider Conversation already has an unsettled Turn.");
  }
  const submittedAt = timestamp(input.submittedAt, "Provider Turn submittedAt");
  return validateProviderRuntimeBinding({
    ...binding,
    turn: {
      runId,
      attemptId,
      authorityEpoch: input.authorityEpoch,
      status: "submitting",
      submittedAt,
      updatedAt: submittedAt
    }
  });
}

export function acceptProviderTurn(
  raw: ProviderRuntimeBinding,
  input: Readonly<{ attemptId: string; turnId: string; acceptedAt: string }>
): ProviderRuntimeBinding {
  const binding = validateProviderRuntimeBinding(raw);
  const attemptId = identity(input.attemptId, "Provider input attempt id");
  const turn = binding.turn;
  if (turn === null || turn.attemptId !== attemptId
    || (turn.status !== "submitting" && turn.status !== "delivery-unknown")) {
    throw new Error("Provider Turn does not match an acceptable delivery state.");
  }
  const acceptedAt = orderedTurnTimestamp(turn, input.acceptedAt, "Provider Turn acceptedAt");
  return validateProviderRuntimeBinding({
    ...binding,
    turn: {
      ...turn,
      status: "accepted",
      turnId: identity(input.turnId, "Provider Turn id"),
      updatedAt: acceptedAt
    }
  });
}

export function markProviderTurnDeliveryUnknown(
  raw: ProviderRuntimeBinding,
  input: Readonly<{ attemptId: string; observedAt: string; reason: string }>
): ProviderRuntimeBinding {
  const binding = validateProviderRuntimeBinding(raw);
  const turn = requireProviderTurn(binding, input.attemptId, "submitting");
  const observedAt = orderedTurnTimestamp(turn, input.observedAt, "Provider Turn unknownAt");
  return validateProviderRuntimeBinding({
    ...binding,
    turn: {
      ...turn,
      status: "delivery-unknown",
      terminalReason: identity(input.reason, "Provider Turn unknown reason"),
      updatedAt: observedAt
    }
  });
}

/** Exact negative acknowledgement before a Provider Turn identity existed. */
export function rejectProviderTurn(
  raw: ProviderRuntimeBinding,
  input: Readonly<{ attemptId: string; rejectedAt: string; reason: string }>
): ProviderRuntimeBinding {
  const binding = validateProviderRuntimeBinding(raw);
  const turn = binding.turn;
  if (turn === null || turn.attemptId !== identity(input.attemptId, "Provider input attempt id")
    || (turn.status !== "submitting" && turn.status !== "delivery-unknown")) {
    throw new Error("Provider Turn does not match a rejectable delivery state.");
  }
  const rejectedAt = orderedTurnTimestamp(turn, input.rejectedAt, "Provider Turn rejectedAt");
  return validateProviderRuntimeBinding({
    ...binding,
    turn: {
      ...turn,
      status: "rejected",
      terminalReason: identity(input.reason, "Provider Turn rejection reason"),
      updatedAt: rejectedAt
    }
  });
}

/** Resolves an Agent Host submission; an unknown delivery may later gain exact negative evidence. */
export function settleProviderTurnSubmission(
  raw: ProviderRuntimeBinding,
  input: Readonly<{
    attemptId: string;
    status: "rejected" | "delivery-unknown";
    reason: string;
    resolvedAt: string;
  }>
): ProviderRuntimeBinding {
  const binding = validateProviderRuntimeBinding(raw);
  const attemptId = identity(input.attemptId, "Provider input attempt id");
  if (binding.turn?.attemptId !== attemptId) {
    throw new Error("Provider Turn does not match a resolvable delivery state.");
  }
  if (binding.turn.status === input.status) return binding;
  if (
    binding.turn.status !== "submitting"
    && !(binding.turn.status === "delivery-unknown" && input.status === "rejected")
  ) {
    throw new Error("Provider Turn does not match a resolvable delivery state.");
  }
  return input.status === "delivery-unknown"
    ? markProviderTurnDeliveryUnknown(binding, {
        attemptId,
        observedAt: input.resolvedAt,
        reason: input.reason
      })
    : rejectProviderTurn(binding, {
        attemptId,
        rejectedAt: input.resolvedAt,
        reason: input.reason
      });
}

export function settleProviderTurn(
  raw: ProviderRuntimeBinding,
  input: Readonly<{
    turnId: string;
    status: "completed" | "failed" | "cancelled";
    settledAt: string;
    reason?: string;
  }>
): ProviderRuntimeBinding {
  const binding = validateProviderRuntimeBinding(raw);
  const turn = binding.turn;
  const turnId = identity(input.turnId, "Provider Turn id");
  if (turn === null || turn.turnId !== turnId
    || (turn.status !== "accepted" && turn.status !== "running")) {
    throw new Error("Provider Turn settlement does not match the current Turn.");
  }
  const settledAt = orderedTurnTimestamp(turn, input.settledAt, "Provider Turn settledAt");
  return validateProviderRuntimeBinding({
    ...binding,
    turn: {
      ...turn,
      status: input.status,
      updatedAt: settledAt,
      ...(input.reason === undefined
        ? {}
        : { terminalReason: identity(input.reason, "Provider Turn terminal reason") })
    }
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
    basis: "terminal-session";
  }>
): ProviderRuntimeBinding {
  const binding = validateProviderRuntimeBinding(raw);
  const current = currentProviderConversation(binding);
  const basis = input.basis;
  if (basis !== "terminal-session") {
    throw new Error("Provider Conversation replacement basis is invalid.");
  }
  const switchedAt = timestamp(input.switchedAt, "Provider Conversation replacement timestamp");
  const epoch = current.epoch + 1;
  const terminalReason = "terminal-session-replaced";
  const activations = binding.activations.map((entry) => entry.status === "active"
      ? {
          ...entry,
          status: "failed" as const,
          endedAt: switchedAt,
          terminalReason
        }
      : entry);
  const turn = binding.turn !== null
    && ["submitting", "accepted", "running", "delivery-unknown"].includes(binding.turn.status)
    ? {
        ...binding.turn,
        status: binding.turn.turnId === undefined ? "rejected" as const : "failed" as const,
        updatedAt: switchedAt,
        terminalReason
      }
    : binding.turn;
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
    activations: [...activations, {
      activationId: identity(input.activationId, "Provider Activation id"),
      conversationId: input.conversationId,
      generation: 1,
      status: "active",
      startedAt: switchedAt
    }],
    authority: {
      epoch: binding.authority.epoch + 1,
      owner: "controller",
      holderId: input.activationId,
      changedAt: switchedAt
    },
    turn
  });
}

export function validateProviderRuntimeBinding(value: ProviderRuntimeBinding): ProviderRuntimeBinding {
  if (value.schemaVersion !== 3) throw new Error("Provider Runtime Binding schemaVersion must be 3.");
  identity(value.providerNamespace, "Provider namespace");
  identity(value.accountScope, "Provider account scope");
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
      if (activation.endedAt !== undefined) {
        throw new Error("Active Provider Activation cannot have endedAt.");
      }
      if (activeByConversation.has(activation.conversationId)) {
        throw new Error("Provider Conversation has multiple live writer Activations.");
      }
      activeByConversation.add(activation.conversationId);
    } else {
      if (activation.endedAt === undefined) throw new Error("Terminal Provider Activation requires endedAt.");
      timestamp(activation.endedAt, "Provider Activation endedAt");
    }
  }
  integer(value.authority.epoch, 1, "Provider authority epoch");
  timestamp(value.authority.changedAt, "Provider authority changedAt");
  if (!["controller", "human", "none", "unknown"].includes(value.authority.owner)) {
    throw new Error("Provider authority owner is invalid.");
  }
  const active = currentActivationUnchecked(value);
  if (value.authority.owner === "controller" || value.authority.owner === "human") {
    const holderId = identity(value.authority.holderId!, "Provider authority holder id");
    if (active === null) throw new Error("Owned Provider authority requires a live Activation.");
    if (value.authority.owner === "controller" && holderId !== active.activationId) {
      throw new Error("Controller authority must be held by the live Activation.");
    }
  } else if (value.authority.holderId !== undefined) {
    throw new Error("Unowned or unknown Provider authority cannot name a holder.");
  }
  if (active !== null && (value.authority.owner === "none" || value.authority.owner === "unknown")) {
    throw new Error("A live Provider Activation requires an exact writer authority.");
  }
  if (!Object.hasOwn(value, "turn")) throw new Error("Provider Runtime Binding requires Turn state.");
  if (value.turn !== null) validateProviderTurn(value.turn, value.authority.epoch);
  return value;
}

function validateProviderTurn(turn: ProviderTurn, currentAuthorityEpoch: number): void {
  identity(turn.runId, "Run id");
  identity(turn.attemptId, "Provider input attempt id");
  integer(turn.authorityEpoch, 1, "Provider Turn authority epoch");
  if (turn.authorityEpoch > currentAuthorityEpoch) {
    throw new Error("Provider Turn authority epoch is ahead of current authority.");
  }
  if (!["submitting", "accepted", "running", "completed", "failed", "cancelled", "rejected", "delivery-unknown"]
    .includes(turn.status)) {
    throw new Error("Provider Turn status is invalid.");
  }
  timestamp(turn.submittedAt, "Provider Turn submittedAt");
  timestamp(turn.updatedAt, "Provider Turn updatedAt");
  if (Date.parse(turn.updatedAt) < Date.parse(turn.submittedAt)) {
    throw new Error("Provider Turn updatedAt is earlier than submittedAt.");
  }
  const hasAcceptedIdentity = turn.status === "accepted" || turn.status === "running"
    || turn.status === "completed" || turn.status === "failed" || turn.status === "cancelled";
  if (hasAcceptedIdentity) identity(turn.turnId!, "Provider Turn id");
  else if (turn.turnId !== undefined) throw new Error("Unaccepted Provider Turn cannot have a Turn id.");
}

function requireProviderTurn(
  binding: ProviderRuntimeBinding,
  attemptId: string,
  status: ProviderTurnStatus
): ProviderTurn {
  const id = identity(attemptId, "Provider input attempt id");
  if (binding.turn === null || binding.turn.attemptId !== id || binding.turn.status !== status) {
    throw new Error("Provider Turn does not match the expected delivery state.");
  }
  return binding.turn;
}

function orderedTurnTimestamp(turn: ProviderTurn, value: string, label: string): string {
  const normalized = timestamp(value, label);
  if (Date.parse(normalized) < Date.parse(turn.updatedAt)) {
    throw new Error(`${label} moved backwards.`);
  }
  return normalized;
}

function providerTurnIsActive(turn: ProviderTurn | null): boolean {
  return turn !== null && ["submitting", "accepted", "running", "delivery-unknown"]
    .includes(turn.status);
}

function currentActivationUnchecked(binding: ProviderRuntimeBinding): ProviderActivation | null {
  const current = binding.conversations.find((entry) => (
    entry.epoch === binding.currentConversationEpoch && entry.status === "current"
  ));
  return current === undefined ? null : [...binding.activations].reverse().find((entry) => (
    entry.conversationId === current.conversationId && entry.status === "active"
  )) ?? null;
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
