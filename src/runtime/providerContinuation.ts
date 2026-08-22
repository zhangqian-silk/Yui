export type ContinuationExecution = "active" | "quiescent" | "unknown";
export type ContinuationOutcome = "pending" | "succeeded" | "failed" | "cancelled" | "unknown";
export type ContinuationAttachment = "attached" | "detached";
export type ContinuationObservationQuality = "exact" | "partial" | "unavailable";

export type ProviderContinuationIdentity = Readonly<{
  providerNamespace: string;
  accountScope: string;
  conversationId: string;
  activationId: string;
  continuationId: string;
  generation: number;
}>;

export type ProviderReport = Readonly<{
  reportId: string;
  resultRef?: string;
  providerDeliveryRef?: string;
  observedAt: string;
}>;

export type ProviderContinuation = Readonly<{
  schemaVersion: 1;
  taskId: string;
  roleName: string;
  runId: string;
  identity: ProviderContinuationIdentity;
  parentContinuationId?: string;
  execution: ContinuationExecution;
  outcome: ContinuationOutcome;
  attachment: ContinuationAttachment;
  observation: ContinuationObservationQuality;
  mayWriteWorkspace: boolean;
  reports: readonly ProviderReport[];
  resultRef?: string;
  settledAt?: string;
  lastProviderSequence?: number;
  identityConflict: boolean;
  createdAt: string;
  updatedAt: string;
}>;

export function providerContinuationKey(identity: ProviderContinuationIdentity): string {
  const normalized = validateProviderContinuationIdentity(identity);
  return [
    normalized.providerNamespace,
    normalized.accountScope,
    normalized.conversationId,
    normalized.activationId,
    normalized.continuationId,
    normalized.generation
  ].join("\u0000");
}

export function createProviderContinuation(input: Readonly<{
  taskId: string;
  roleName: string;
  runId: string;
  identity: ProviderContinuationIdentity;
  parentContinuationId?: string;
  attachment: ContinuationAttachment;
  observation: ContinuationObservationQuality;
  mayWriteWorkspace: boolean;
  observedAt: string;
  providerSequence?: number;
}>): ProviderContinuation {
  return validateProviderContinuation({
    schemaVersion: 1,
    taskId: text(input.taskId, "Task id"),
    roleName: text(input.roleName, "Role name"),
    runId: text(input.runId, "Run id"),
    identity: validateProviderContinuationIdentity(input.identity),
    ...(input.parentContinuationId === undefined
      ? {}
      : { parentContinuationId: text(input.parentContinuationId, "Parent Continuation id") }),
    execution: "active",
    outcome: "pending",
    attachment: input.attachment,
    observation: input.observation,
    mayWriteWorkspace: input.mayWriteWorkspace,
    reports: [],
    ...(input.providerSequence === undefined ? {} : { lastProviderSequence: input.providerSequence }),
    identityConflict: false,
    createdAt: timestamp(input.observedAt, "Continuation observedAt"),
    updatedAt: input.observedAt
  });
}

export function recordProviderReport(
  raw: ProviderContinuation,
  report: ProviderReport,
  providerSequence?: number
): ProviderContinuation {
  const current = validateProviderContinuation(raw);
  if (current.identityConflict) return current;
  if (providerSequenceRegresses(current, providerSequence)) return current;
  const normalized = validateProviderReport(report);
  if (current.reports.some((entry) => entry.reportId === normalized.reportId)) return current;
  return validateProviderContinuation({
    ...current,
    reports: [...current.reports, normalized],
    ...(providerSequence === undefined ? {} : { lastProviderSequence: providerSequence }),
    updatedAt: normalized.observedAt
  });
}

export function observeProviderContinuation(
  raw: ProviderContinuation,
  input: Readonly<{
    execution: ContinuationExecution;
    outcome: ContinuationOutcome;
    attachment: ContinuationAttachment;
    observation: ContinuationObservationQuality;
    mayWriteWorkspace: boolean;
    observedAt: string;
    resultRef?: string;
    providerSequence?: number;
  }>
): ProviderContinuation {
  const current = validateProviderContinuation(raw);
  if (current.identityConflict || providerSequenceRegresses(current, input.providerSequence)) {
    return current;
  }
  const observedAt = timestamp(input.observedAt, "Continuation observedAt");
  if (current.settledAt !== undefined) {
    if (input.execution === "quiescent"
      && input.outcome === current.outcome
      && (input.resultRef === undefined || input.resultRef === current.resultRef)) return current;
    // Exact terminal evidence may fill a result reference that was indexed
    // after settlement, but it can never replace an existing reference.
    if (input.execution === "quiescent"
      && input.observation === "exact"
      && input.outcome === current.outcome
      && current.resultRef === undefined
      && input.resultRef !== undefined) {
      return validateProviderContinuation({
        ...current,
        resultRef: text(input.resultRef, "Result ref"),
        ...(input.providerSequence === undefined
          ? {}
          : { lastProviderSequence: input.providerSequence }),
        updatedAt: observedAt
      });
    }
    // Exact absence/completeness can close writer ownership before the
    // provider's terminal result record arrives. A later exact terminal fact
    // may refine only the unknown outcome; it cannot reopen execution.
    if (current.outcome === "unknown"
      && input.execution === "quiescent"
      && input.observation === "exact"
      && input.outcome !== "pending") {
      return validateProviderContinuation({
        ...current,
        outcome: input.outcome,
        ...(input.resultRef === undefined ? {} : { resultRef: text(input.resultRef, "Result ref") }),
        ...(input.providerSequence === undefined
          ? {}
          : { lastProviderSequence: input.providerSequence }),
        updatedAt: observedAt
      });
    }
    return validateProviderContinuation({ ...current, identityConflict: true, updatedAt: observedAt });
  }
  if (input.execution === "quiescent" && input.observation !== "exact") {
    return validateProviderContinuation({
      ...current,
      execution: "unknown",
      observation: input.observation,
      attachment: input.attachment,
      // Partial/unavailable evidence cannot release an already-established
      // writer umbrella. Only exact quiescence may prove workspace ownership
      // ended; otherwise cleanup could race a detached provider process.
      mayWriteWorkspace: current.mayWriteWorkspace || input.mayWriteWorkspace,
      ...(input.providerSequence === undefined ? {} : { lastProviderSequence: input.providerSequence }),
      updatedAt: observedAt
    });
  }
  return validateProviderContinuation({
    ...current,
    execution: input.execution,
    outcome: input.outcome,
    attachment: input.attachment,
    observation: input.observation,
    mayWriteWorkspace: input.mayWriteWorkspace,
    ...(input.resultRef === undefined ? {} : { resultRef: text(input.resultRef, "Result ref") }),
    ...(input.execution === "quiescent" && input.observation === "exact"
      ? { settledAt: observedAt }
      : {}),
    ...(input.providerSequence === undefined ? {} : { lastProviderSequence: input.providerSequence }),
    updatedAt: observedAt
  });
}

export function detachProviderContinuation(
  raw: ProviderContinuation,
  observedAt: string
): ProviderContinuation {
  const current = validateProviderContinuation(raw);
  if (current.attachment === "detached") return current;
  return validateProviderContinuation({
    ...current,
    attachment: "detached",
    updatedAt: timestamp(observedAt, "Continuation detachedAt")
  });
}

export function continuationOwnsWriterUmbrella(value: ProviderContinuation): boolean {
  const continuation = validateProviderContinuation(value);
  return continuation.mayWriteWorkspace
    && continuation.identityConflict === false
    && (continuation.execution === "active" || continuation.execution === "unknown");
}

export function validateProviderContinuation(value: ProviderContinuation): ProviderContinuation {
  if (value.schemaVersion !== 1) throw new Error("Provider Continuation schemaVersion must be 1.");
  text(value.taskId, "Task id");
  text(value.roleName, "Role name");
  text(value.runId, "Run id");
  validateProviderContinuationIdentity(value.identity);
  if (!["active", "quiescent", "unknown"].includes(value.execution)) {
    throw new Error("Provider Continuation execution is invalid.");
  }
  if (!["pending", "succeeded", "failed", "cancelled", "unknown"].includes(value.outcome)) {
    throw new Error("Provider Continuation outcome is invalid.");
  }
  if (value.attachment !== "attached" && value.attachment !== "detached") {
    throw new Error("Provider Continuation attachment is invalid.");
  }
  if (!["exact", "partial", "unavailable"].includes(value.observation)) {
    throw new Error("Provider Continuation observation quality is invalid.");
  }
  if (typeof value.mayWriteWorkspace !== "boolean" || typeof value.identityConflict !== "boolean") {
    throw new Error("Provider Continuation flags are invalid.");
  }
  const reports = value.reports.map(validateProviderReport);
  if (new Set(reports.map((entry) => entry.reportId)).size !== reports.length) {
    throw new Error("Provider Continuation reports contain duplicate identity.");
  }
  timestamp(value.createdAt, "Provider Continuation createdAt");
  timestamp(value.updatedAt, "Provider Continuation updatedAt");
  if (value.settledAt !== undefined) {
    timestamp(value.settledAt, "Provider Continuation settledAt");
    if (value.execution !== "quiescent" || value.observation !== "exact") {
      throw new Error("Settled Provider Continuation requires exact quiescence.");
    }
  }
  if (value.execution === "active" && value.outcome !== "pending") {
    throw new Error("Active Provider Continuation outcome must remain pending.");
  }
  if (value.lastProviderSequence !== undefined) sequence(value.lastProviderSequence);
  return value;
}

export function validateProviderContinuationIdentity(
  value: ProviderContinuationIdentity
): ProviderContinuationIdentity {
  text(value.providerNamespace, "Provider namespace");
  text(value.accountScope, "Provider account scope");
  text(value.conversationId, "Provider Conversation id");
  text(value.activationId, "Provider Activation id");
  text(value.continuationId, "Provider Continuation id");
  if (!Number.isSafeInteger(value.generation) || value.generation < 1) {
    throw new Error("Provider Continuation generation is invalid.");
  }
  return value;
}

function validateProviderReport(value: ProviderReport): ProviderReport {
  return {
    reportId: text(value.reportId, "Provider report id"),
    ...(value.resultRef === undefined ? {} : { resultRef: text(value.resultRef, "Result ref") }),
    ...(value.providerDeliveryRef === undefined
      ? {}
      : { providerDeliveryRef: text(value.providerDeliveryRef, "Provider delivery ref") }),
    observedAt: timestamp(value.observedAt, "Provider report observedAt")
  };
}

function providerSequenceRegresses(
  current: ProviderContinuation,
  incoming: number | undefined
): boolean {
  if (incoming === undefined) return false;
  sequence(incoming);
  return current.lastProviderSequence !== undefined && incoming < current.lastProviderSequence;
}

function sequence(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error("Provider sequence is invalid.");
  return value;
}

function text(value: string, label: string): string {
  if (typeof value !== "string" || value.includes("\0") || value.trim().length === 0) {
    throw new Error(`${label} is invalid.`);
  }
  return value.trim();
}

function timestamp(value: string, label: string): string {
  const normalized = text(value, label);
  if (!Number.isFinite(Date.parse(normalized))) throw new Error(`${label} must be a timestamp.`);
  return normalized;
}
