import {
  cancelProviderRetry, completeProviderRetry, validateProviderInput, validateProviderRetry,
  type ProviderInput, type ProviderRetry
} from "./providerRetry.js";
import { isStandardAgentError, type StandardAgentError } from "./agentError.js";

export type ProviderConversationRecoverability = "unknown" | "recoverable" | "unrecoverable";
export type ProviderConversationStatus = "current" | "superseded";
export type ProviderAuthorityOwner = "controller" | "human" | "none" | "unknown";
export type ProviderTurnStatus =
  | "submitting"
  | "accepted"
  | "completed"
  | "failed"
  | "cancelled"
  | "rejected"
  | "deferred"
  | "delivery-unknown";

export type ProviderGoalStatus =
  | "active"
  | "paused"
  | "blocked"
  | "usage-limited"
  | "budget-limited"
  | "complete";

/** Provider-native Session intent. It is independent from AgentRun and Task completion. */
export type ProviderGoal = Readonly<{
  status: ProviderGoalStatus;
  objective: string;
  updatedAt: string;
  nativeTurnId?: string;
  tokenBudget?: number;
}>;

export type ProviderConversation = Readonly<{
  conversationId: string;
  epoch: number;
  status: ProviderConversationStatus;
  recoverability: ProviderConversationRecoverability;
  createdAt: string;
  supersededAt?: string;
}>;

/**
 * One monotonically fenced writer authority for the current Conversation.
 * It is deliberately independent from the Provider process: a human may take
 * over the same Conversation without replacing its identity.
 */
export type ProviderAuthority = Readonly<{
  epoch: number;
  owner: ProviderAuthorityOwner;
  holderId?: string;
  changedAt: string;
}>;

export type ProviderTurn = Readonly<{
  /** Optional correlation for the durable Yui AgentRun record. */
  runId?: string;
  attemptId: string;
  authorityEpoch: number;
  status: ProviderTurnStatus;
  submittedAt: string;
  updatedAt: string;
  nativeTurnId?: string;
  terminalReason?: string;
  input?: ProviderInput;
  retrySupported?: boolean;
  failure?: Readonly<{ error: StandardAgentError; ref: string }>;
}>;

export type ProviderRuntimeBinding = Readonly<{
  schemaVersion: 5;
  providerNamespace: string;
  accountScope: string;
  currentConversationEpoch: number;
  conversations: readonly ProviderConversation[];
  authority: ProviderAuthority;
  run: ProviderTurn | null;
  goal: ProviderGoal | null;
  retry?: ProviderRetry;
  /** Terminal audit, never an additional scheduling source. */
  retryHistory?: readonly ProviderRetry[];
  retryDisabled?: boolean;
}>;

export function createProviderRuntimeBinding(input: Readonly<{
  providerNamespace: string;
  accountScope: string;
  conversationId: string;
  startedAt: string;
}>): ProviderRuntimeBinding {
  const startedAt = timestamp(input.startedAt, "Provider Conversation startedAt");
  return validateProviderRuntimeBinding({
    schemaVersion: 5,
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
    authority: {
      epoch: 1,
      owner: "controller",
      holderId: "controller",
      changedAt: startedAt
    },
    run: null,
    goal: null
  });
}

export function updateProviderGoal(
  raw: ProviderRuntimeBinding,
  goal: ProviderGoal
): ProviderRuntimeBinding {
  const binding = validateProviderRuntimeBinding(raw);
  const normalized = validateProviderGoal(goal);
  return validateProviderRuntimeBinding({ ...binding, goal: normalized });
}

export function clearProviderGoal(
  raw: ProviderRuntimeBinding
): ProviderRuntimeBinding {
  const binding = validateProviderRuntimeBinding(raw);
  return binding.goal === null
    ? binding
    : validateProviderRuntimeBinding({ ...binding, goal: null });
}

/** Only active means the Provider is expected to continue autonomously. */
export function providerGoalContinues(goal: ProviderGoal | null | undefined): boolean {
  return goal?.status === "active";
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
  if (providerTurnIsActive(binding.run)) {
    throw new Error("Provider authority cannot transfer while a AgentRun is unsettled.");
  }
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
    holderId = identity(input.holderId!, "Provider authority holder id");
    if (input.owner === "controller" && holderId !== "controller") {
      throw new Error("Controller authority must name the Controller.");
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
    runId?: string;
    attemptId: string;
    authorityEpoch: number;
    submittedAt: string;
    input?: ProviderInput;
    retrySupported?: boolean;
  }>
): ProviderRuntimeBinding {
  let binding = validateProviderRuntimeBinding(raw);
  const attemptId = identity(input.attemptId, "Provider input attempt id");
  const runId = input.runId === undefined ? undefined : identity(input.runId, "AgentRun id");
  const currentRun = binding.run;
  if (currentRun !== null
    && currentRun.runId === runId
    && currentRun.attemptId === attemptId
    && currentRun.authorityEpoch === input.authorityEpoch
    && currentRun.status === "submitting") {
    return binding;
  }
  if (binding.authority.epoch !== input.authorityEpoch
    || binding.authority.owner === "none"
    || binding.authority.owner === "unknown") {
    throw new Error("Provider Turn authority fence is stale.");
  }
  if (providerTurnIsActive(binding.run)) {
    throw new Error("Provider Conversation already has an unsettled AgentRun.");
  }
  const submittedAt = timestamp(input.submittedAt, "Provider Turn submittedAt");
  if (binding.retry?.currentAttemptId !== attemptId) {
    binding = cancelProviderRetry(binding, "superseded-by-explicit-input", Date.parse(submittedAt));
  }
  return validateProviderRuntimeBinding({
    ...binding,
    run: {
      ...(runId === undefined ? {} : { runId }),
      attemptId,
      authorityEpoch: input.authorityEpoch,
      status: "submitting",
      ...(input.input === undefined ? {} : { input: input.input }),
      ...(input.retrySupported === undefined ? {} : { retrySupported: input.retrySupported }),
      submittedAt,
      updatedAt: submittedAt
    }
  });
}

export function acceptProviderTurn(
  raw: ProviderRuntimeBinding,
  input: Readonly<{ attemptId: string; nativeTurnId?: string; acceptedAt: string }>
): ProviderRuntimeBinding {
  const binding = validateProviderRuntimeBinding(raw);
  const attemptId = identity(input.attemptId, "Provider input attempt id");
  const run = binding.run;
  if (run === null || run.attemptId !== attemptId
    || (run.status !== "submitting" && run.status !== "delivery-unknown")) {
    throw new Error("Provider Turn does not match an acceptable delivery state.");
  }
  const acceptedAt = orderedRunTimestamp(run, input.acceptedAt, "Provider Turn acceptedAt");
  return validateProviderRuntimeBinding({
    ...binding,
    run: {
      ...run,
      status: "accepted",
      ...(input.nativeTurnId === undefined
        ? {}
        : { nativeTurnId: identity(input.nativeTurnId, "Provider native Turn id") }),
      updatedAt: acceptedAt
    }
  });
}

export function markProviderTurnDeliveryUnknown(
  raw: ProviderRuntimeBinding,
  input: Readonly<{ attemptId: string; observedAt: string; reason: string }>
): ProviderRuntimeBinding {
  const binding = validateProviderRuntimeBinding(raw);
  const run = requireProviderTurn(binding, input.attemptId, "submitting");
  const observedAt = orderedRunTimestamp(run, input.observedAt, "Provider Turn unknownAt");
  return validateProviderRuntimeBinding({
    ...binding,
    run: {
      ...run,
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
  const run = binding.run;
  if (run === null || run.attemptId !== identity(input.attemptId, "Provider input attempt id")
    || (run.status !== "submitting" && run.status !== "delivery-unknown")) {
    throw new Error("Provider Turn does not match a rejectable delivery state.");
  }
  const rejectedAt = orderedRunTimestamp(run, input.rejectedAt, "Provider Turn rejectedAt");
  return validateProviderRuntimeBinding({
    ...binding,
    run: {
      ...run,
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
    status: "rejected" | "deferred" | "delivery-unknown";
    reason: string;
    resolvedAt: string;
  }>
): ProviderRuntimeBinding {
  const binding = validateProviderRuntimeBinding(raw);
  const attemptId = identity(input.attemptId, "Provider input attempt id");
  if (binding.run?.attemptId !== attemptId) {
    throw new Error("Provider Turn does not match a resolvable delivery state.");
  }
  if (binding.run.status === input.status) return binding;
  if (
    binding.run.status !== "submitting"
    && !(binding.run.status === "delivery-unknown" && input.status === "rejected")
  ) {
    throw new Error("Provider Turn does not match a resolvable delivery state.");
  }
  if (input.status === "deferred") {
    return validateProviderRuntimeBinding({
      ...binding,
      run: {
        ...binding.run,
        status: "deferred",
        terminalReason: identity(input.reason, "Provider admission deferral reason"),
        updatedAt: orderedRunTimestamp(binding.run, input.resolvedAt, "Provider deferredAt")
      }
    });
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
    nativeTurnId?: string;
    attemptId?: string;
    status: "completed" | "failed" | "cancelled";
    settledAt: string;
    reason?: string;
  }>
): ProviderRuntimeBinding {
  const binding = validateProviderRuntimeBinding(raw);
  const run = binding.run;
  const nativeTurnId = input.nativeTurnId === undefined
    ? undefined : identity(input.nativeTurnId, "Provider native Turn id");
  if (run === null
    || (input.attemptId === undefined
      ? nativeTurnId === undefined || run.nativeTurnId !== nativeTurnId
      : run.attemptId !== input.attemptId)
    || (run.nativeTurnId !== undefined && nativeTurnId !== undefined
      && run.nativeTurnId !== nativeTurnId)
    || run.status !== "accepted") {
    throw new Error("Provider Turn settlement does not match the current AgentRun.");
  }
  const settledAt = orderedRunTimestamp(run, input.settledAt, "Provider Turn settledAt");
  const settled = validateProviderRuntimeBinding({
    ...binding,
    run: {
      ...run,
      ...(nativeTurnId === undefined ? {} : { nativeTurnId }),
      status: input.status,
      updatedAt: settledAt,
      ...(input.reason === undefined
        ? {}
        : { terminalReason: identity(input.reason, "Provider Turn terminal reason") })
    }
  });
  return completeProviderRetry(settled, settled.run!);
}

/** Explicitly abandon an engineering input only after its execution resources
 * are quiescent. This does not invent native acceptance, a Turn id or success. */
export function cancelQuiescentProviderInput(
  raw: ProviderRuntimeBinding,
  input: Readonly<{ attemptId: string; cancelledAt: string; reason: string }>
): ProviderRuntimeBinding {
  const binding = validateProviderRuntimeBinding(raw);
  if (binding.run?.attemptId !== input.attemptId) throw new Error("Provider input identity changed during stop.");
  if (!providerTurnIsActive(binding.run)) return binding;
  return validateProviderRuntimeBinding({
    ...binding,
    run: { ...binding.run, status: "cancelled",
      updatedAt: orderedRunTimestamp(binding.run, input.cancelledAt, "Provider input cancelledAt"),
      terminalReason: input.reason }
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

/** Shared pre-start and commit guard for explicit native Conversation replacement. */
export function assertProviderConversationReplaceable(raw: ProviderRuntimeBinding): void {
  const binding = validateProviderRuntimeBinding(raw);
  if (providerTurnIsActive(binding.run)) {
    throw new Error(
      `Provider Conversation replacement cannot discard unsettled input attempt ${
        binding.run!.attemptId
      } (${binding.run!.status}). Resolve its actual outcome before selecting a new Conversation.`
    );
  }
}

export function supersedeProviderConversation(
  raw: ProviderRuntimeBinding,
  input: Readonly<{
    conversationId: string;
    switchedAt: string;
    basis: "terminal-session";
  }>
): ProviderRuntimeBinding {
  const binding = validateProviderRuntimeBinding(raw);
  const current = currentProviderConversation(binding);
  if (input.basis !== "terminal-session") {
    throw new Error("Provider Conversation replacement basis is invalid.");
  }
  assertProviderConversationReplaceable(binding);
  const switchedAt = timestamp(input.switchedAt, "Provider Conversation replacement timestamp");
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
    authority: {
      epoch: binding.authority.epoch + 1,
      owner: "controller",
      holderId: "controller",
      changedAt: switchedAt
    },
    goal: null
  });
}

export function validateProviderRuntimeBinding(value: ProviderRuntimeBinding): ProviderRuntimeBinding {
  if (value.schemaVersion !== 5) throw new Error("Provider Runtime Binding schemaVersion must be 5.");
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
  integer(value.authority.epoch, 1, "Provider authority epoch");
  timestamp(value.authority.changedAt, "Provider authority changedAt");
  if (!["controller", "human", "none", "unknown"].includes(value.authority.owner)) {
    throw new Error("Provider authority owner is invalid.");
  }
  if (value.authority.owner === "controller" || value.authority.owner === "human") {
    const holderId = identity(value.authority.holderId!, "Provider authority holder id");
    if (value.authority.owner === "controller" && holderId !== "controller") {
      throw new Error("Controller authority must name the Controller.");
    }
  } else if (value.authority.holderId !== undefined) {
    throw new Error("Unowned or unknown Provider authority cannot name a holder.");
  }
  if (!Object.hasOwn(value, "run")) throw new Error("Provider Runtime Binding requires AgentRun state.");
  if (value.run !== null) {
    validateProviderTurn(value.run, value.authority.epoch);
  }
  if (!Object.hasOwn(value, "goal")) throw new Error("Provider Runtime Binding requires Goal state.");
  if (value.goal !== null) validateProviderGoal(value.goal);
  if (value.retry !== undefined) validateProviderRetry(value.retry);
  if (value.retryHistory !== undefined) {
    if (!Array.isArray(value.retryHistory)) throw new Error("Provider retry audit must be an array.");
    for (const retry of value.retryHistory) {
      validateProviderRetry(retry);
      if (retry.status === "waiting" || retry.status === "in-flight") throw new Error("Provider retry audit cannot schedule work.");
    }
  }
  if (value.retryDisabled !== undefined && typeof value.retryDisabled !== "boolean") throw new Error("Provider retry switch must be boolean.");
  if (value.run?.input !== undefined) validateProviderInput(value.run.input);
  if (value.run?.failure !== undefined
    && (!isStandardAgentError(value.run.failure.error) || !value.run.failure.ref)) throw new Error("Invalid Provider input failure.");
  return value;
}

function validateProviderGoal(goal: ProviderGoal): ProviderGoal {
  if (![
    "active",
    "paused",
    "blocked",
    "usage-limited",
    "budget-limited",
    "complete"
  ].includes(goal.status)) {
    throw new Error("Provider Goal status is invalid.");
  }
  const normalized: ProviderGoal = {
    status: goal.status,
    objective: identity(goal.objective, "Provider Goal objective"),
    updatedAt: timestamp(goal.updatedAt, "Provider Goal updatedAt"),
    ...(goal.nativeTurnId === undefined
      ? {}
      : { nativeTurnId: identity(goal.nativeTurnId, "Provider Goal native Turn id") }),
    ...(goal.tokenBudget === undefined
      ? {}
      : { tokenBudget: integer(goal.tokenBudget, 1, "Provider Goal token budget") })
  };
  return Object.freeze(normalized);
}

function validateProviderTurn(run: ProviderTurn, currentAuthorityEpoch: number): void {
  if (run.runId !== undefined) identity(run.runId, "AgentRun id");
  identity(run.attemptId, "Provider input attempt id");
  integer(run.authorityEpoch, 1, "Provider Turn authority epoch");
  if (run.authorityEpoch > currentAuthorityEpoch) {
    throw new Error("Provider Turn authority epoch is ahead of current authority.");
  }
  if (!["submitting", "accepted", "completed", "failed", "cancelled", "rejected", "deferred", "delivery-unknown"]
    .includes(run.status)) {
    throw new Error("Provider Turn status is invalid.");
  }
  timestamp(run.submittedAt, "Provider Turn submittedAt");
  timestamp(run.updatedAt, "Provider Turn updatedAt");
  if (Date.parse(run.updatedAt) < Date.parse(run.submittedAt)) {
    throw new Error("Provider Turn updatedAt is earlier than submittedAt.");
  }
  const hasAcceptedIdentity = run.status === "accepted"
    || run.status === "completed" || run.status === "failed" || run.status === "cancelled";
  if (hasAcceptedIdentity && run.nativeTurnId !== undefined) {
    identity(run.nativeTurnId, "Provider native Turn id");
  } else if (!hasAcceptedIdentity && run.nativeTurnId !== undefined) {
    throw new Error("Unaccepted Provider Turn cannot have a native Turn id.");
  }
}

export function managedProviderTurnId(run: ProviderTurn | null | undefined): string | null {
  return run?.runId ?? null;
}

function requireProviderTurn(
  binding: ProviderRuntimeBinding,
  attemptId: string,
  status: ProviderTurnStatus
): ProviderTurn {
  const id = identity(attemptId, "Provider input attempt id");
  if (binding.run === null || binding.run.attemptId !== id || binding.run.status !== status) {
    throw new Error("Provider Turn does not match the expected delivery state.");
  }
  return binding.run;
}

function orderedRunTimestamp(run: ProviderTurn, value: string, label: string): string {
  const normalized = timestamp(value, label);
  if (Date.parse(normalized) < Date.parse(run.updatedAt)) {
    throw new Error(`${label} moved backwards.`);
  }
  return normalized;
}

function providerTurnIsActive(run: ProviderTurn | null): boolean {
  return run !== null && ["submitting", "accepted", "delivery-unknown"]
    .includes(run.status);
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
