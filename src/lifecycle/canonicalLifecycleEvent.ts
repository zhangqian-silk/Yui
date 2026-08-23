/**
 * The smallest stable, provider-neutral Yui lifecycle vocabulary.
 *
 * Each phase is a durable semantic fact about a managed Agent generation or the
 * Run whose prompt it carries. Agent Drivers translate native signals into
 * these phases; the scheduler and durable fold reason about phases, sources,
 * and evidence — never about provider names.
 */
export type CanonicalLifecyclePhase =
  /** A host window/process was created by Yui for a Role generation. */
  | "host-process-created"
  /** The provider reported that its own session exists (identity is now known). */
  | "provider-session-started"
  /** The provider reported it is ready; pre-input readiness is stated explicitly. */
  | "provider-ready"
  /** Managed prompt bytes were handed to the transport (tmux receipt) exactly once. */
  | "prompt-pushed"
  /** The provider durably accepted an identity-matched managed prompt. */
  | "provider-accepted"
  /** The provider reported forward progress within an accepted turn. */
  | "turn-progress"
  /** The provider reported that the current turn ended (completed or failed). */
  | "turn-terminal";

/**
 * Where a raw signal originated. Kept deliberately distinct from evidence level
 * so a strong-looking transport receipt can never masquerade as provider proof.
 */
export type LifecycleEventSource =
  /** Synthesized by the Yui controller (e.g. it created the host process). */
  | "controller"
  /** A tmux/pane receipt: proves bytes were pushed, nothing about acceptance. */
  | "transport"
  /** Pane/PID/currentCommand host liveness: never advances a durable phase. */
  | "liveness"
  /** A native provider hook or structured event. */
  | "provider-native";

/**
 * How much a signal actually proves. Only `provider-native-durable` is strong
 * enough to move acceptance; everything weaker fails closed for that phase.
 */
export type LifecycleEvidenceLevel =
  /** A controller-owned internal fact (host creation). */
  | "controller"
  /** Transport receipt only (a prompt push). */
  | "transport"
  /** Host liveness only. */
  | "liveness"
  /** A provider signal an adapter mapped structurally (shape, not durable proof). */
  | "adapter-mapped"
  /** A durable, identity-matched native provider fact. */
  | "provider-native-durable";

/**
 * Exact identity fences carried by every canonical event. Run-scoped phases
 * (pushed/accepted/progress/terminal) require `runId`; generation-scoped phases
 * (host/session/ready) may omit it. `launchId` and `nativeSessionId` fence the
 * external process generation so a stale generation can never rebind a live one.
 */
export type CanonicalIdentityFence = Readonly<{
  taskId: string;
  roleName: string;
  agentId: string;
  adapterId: string;
  runId?: string;
  nativeSessionId?: string;
  launchId?: string;
  receiptId?: string;
}>;

export type CanonicalLifecycleEvent = Readonly<{
  phase: CanonicalLifecyclePhase;
  source: LifecycleEventSource;
  evidence: LifecycleEvidenceLevel;
  fence: CanonicalIdentityFence;
  /**
   * Required on `provider-ready`, forbidden elsewhere. There is no default: an
   * omitted value fails closed at construction so an ambiguous readiness event
   * can never be silently coerced to false (or true).
   */
  preInputReady?: boolean;
  /**
   * The exact provider-native discriminator that justifies a `provider-ready`
   * event — e.g. Claude's SessionStart `source`. Preserved end to end so a
   * provider hook parser (and every test) can prove readiness came from the one
   * variant proven to precede the first prompt, not any SessionStart.
   */
  readinessVariant?: string;
  /** Optional monotonic ordinal for progress/terminal ordering within a turn. */
  sequence?: number;
  /** Optional human-facing summary (turn-terminal). Never an identity input. */
  summary?: string;
}>;

/**
 * The adapter capability that answers exactly one question: does this provider
 * emit a native event, proven to occur before the first prompt, that Yui may map
 * to pre-input readiness? Unsupported must be explicit and name the reason so a
 * consumer fails closed rather than assuming a provider-wide default.
 */
export type PreInputReadinessCapability =
  | Readonly<{
      status: "supported";
      /** The native event proven to fire before the first prompt. */
      nativeEvent: string;
      note: string;
    }>
  | Readonly<{
      status: "unsupported";
      reason: "not-available";
      note: string;
    }>;

export function isPreInputReadinessSupported(
  capability: PreInputReadinessCapability
): boolean {
  return capability.status === "supported";
}

/**
 * The minimal durable-ish state a consumer supplies so the pure fold can decide
 * without owning storage. The scheduler / WI4 durable fold projects its own
 * truth into this shape; this module never persists anything. Every field is a
 * projection of an already-applied durable fact — the fold adds no second source
 * of truth, it only reads what the consumer already recorded.
 */
export type CanonicalRunExpectation = Readonly<{
  fence: CanonicalIdentityFence;
  /** A provider session-started fact was already applied for this generation. */
  sessionStarted: boolean;
  /** A provider-ready fact was already applied for this generation. */
  ready: boolean;
  /** A single transport push was already recorded for this Run. */
  pushed: boolean;
  /** Provider acceptance was already recorded for this Run. */
  accepted: boolean;
  /** The turn is already terminal. */
  terminal: boolean;
  /**
   * The native session id already bound to this generation, if any. Absent
   * means discovery has not yet bound one: a session-started event may bind it
   * under the exact launch fence, after which later run-scoped facts must carry
   * and match it.
   */
  boundNativeSessionId?: string;
}>;

export type CanonicalFoldDecision =
  | Readonly<{ outcome: "mark-host-created" }>
  | Readonly<{ outcome: "mark-session-started" }>
  /** Session-started that also binds a previously-unknown native id (exact launch fence). */
  | Readonly<{ outcome: "bind-native-session"; nativeSessionId: string }>
  | Readonly<{ outcome: "mark-ready"; preInputReady: boolean }>
  | Readonly<{ outcome: "mark-pushed" }>
  | Readonly<{ outcome: "advance-accepted" }>
  | Readonly<{ outcome: "advance-progress" }>
  | Readonly<{ outcome: "advance-terminal" }>
  /** A fact already applied; applying again is a safe no-op. */
  | Readonly<{ outcome: "idempotent"; reason: string }>
  /** Valid but not yet applicable; hold the immutable event, do not drop it. */
  | Readonly<{ outcome: "deferred"; reason: string }>
  /** Stale/superseded/wrong-generation; drop without touching the successor. */
  | Readonly<{ outcome: "obsolete"; reason: string }>
  /** Contract violation; refuse to advance and surface the reason. */
  | Readonly<{ outcome: "fail-closed"; reason: string }>;

export class CanonicalLifecycleError extends Error {
  constructor(readonly reason: string) {
    super(reason);
    this.name = "CanonicalLifecycleError";
  }
}

const RUN_SCOPED_PHASES: ReadonlySet<CanonicalLifecyclePhase> = new Set([
  "prompt-pushed",
  "provider-accepted",
  "turn-progress",
  "turn-terminal"
]);

/**
 * Phases that assert durable provider truth about a Run. Every one must carry
 * the complete run-scoped identity — runId AND the generation fences
 * (nativeSessionId + launchId) AND, where the transport owns it, the receiptId —
 * because a missing or wrong fence must fail closed rather than advance a Run or
 * its successor.
 */
const PROVIDER_TRUTH_PHASES: ReadonlySet<CanonicalLifecyclePhase> = new Set([
  "provider-accepted",
  "turn-progress",
  "turn-terminal"
]);

/**
 * The (source, evidence) combinations each phase is allowed to carry. This is
 * where "receipt/pane/PID/liveness remain non-acceptance evidence" is enforced
 * structurally: only `provider-native-durable` may advance provider truth
 * (acceptance/progress/terminal), so neither a transport/liveness signal nor a
 * shape-only `adapter-mapped` observation can ever forge or terminalize a turn.
 * `adapter-mapped` remains permissible only for the pre-acceptance
 * session-started/ready phases, whose fold never advances Run truth.
 */
const PHASE_EVIDENCE_MATRIX: Readonly<Record<
  CanonicalLifecyclePhase,
  Readonly<{ sources: readonly LifecycleEventSource[]; evidence: readonly LifecycleEvidenceLevel[] }>
>> = {
  "host-process-created": { sources: ["controller"], evidence: ["controller"] },
  "provider-session-started": {
    sources: ["provider-native"],
    evidence: ["adapter-mapped", "provider-native-durable"]
  },
  "provider-ready": {
    sources: ["provider-native"],
    evidence: ["adapter-mapped", "provider-native-durable"]
  },
  "prompt-pushed": { sources: ["transport"], evidence: ["transport"] },
  "provider-accepted": {
    sources: ["provider-native"],
    evidence: ["provider-native-durable"]
  },
  "turn-progress": {
    sources: ["provider-native"],
    evidence: ["provider-native-durable"]
  },
  "turn-terminal": {
    sources: ["provider-native"],
    evidence: ["provider-native-durable"]
  }
};

/**
 * Builds a validated canonical event, failing closed if the phase, source,
 * evidence, or identity fence are inconsistent. Callers (adapters, transport,
 * the controller) must go through here so downstream folds can trust the shape.
 */
export function createCanonicalLifecycleEvent(
  input: CanonicalLifecycleEvent
): CanonicalLifecycleEvent {
  const rule = PHASE_EVIDENCE_MATRIX[input.phase];
  if (rule === undefined) {
    throw new CanonicalLifecycleError(`Unknown canonical lifecycle phase: ${String(input.phase)}.`);
  }
  if (!rule.sources.includes(input.source)) {
    throw new CanonicalLifecycleError(
      `Phase ${input.phase} rejects source ${input.source}; only ${rule.sources.join("/")} may prove it.`
    );
  }
  if (!rule.evidence.includes(input.evidence)) {
    throw new CanonicalLifecycleError(
      `Phase ${input.phase} rejects evidence ${input.evidence}; only ${rule.evidence.join("/")} may prove it.`
    );
  }
  const fence = normalizeFence(input.fence);
  if (RUN_SCOPED_PHASES.has(input.phase) && fence.runId === undefined) {
    throw new CanonicalLifecycleError(`Phase ${input.phase} requires a runId fence.`);
  }
  // Provider-truth phases must carry the complete generation fence so a stale or
  // wrong generation can never advance the Run.
  if (PROVIDER_TRUTH_PHASES.has(input.phase)) {
    if (fence.nativeSessionId === undefined) {
      throw new CanonicalLifecycleError(`Phase ${input.phase} requires a nativeSessionId fence.`);
    }
    if (fence.launchId === undefined) {
      throw new CanonicalLifecycleError(`Phase ${input.phase} requires a launchId fence.`);
    }
  }
  if (input.phase === "prompt-pushed" && fence.receiptId === undefined) {
    throw new CanonicalLifecycleError("A prompt-pushed event requires a transport receiptId.");
  }
  if (input.phase === "provider-accepted" && fence.receiptId === undefined) {
    throw new CanonicalLifecycleError("A provider-accepted event requires the transport receiptId it accepts.");
  }
  // Readiness must be explicit: provider-ready requires an explicit boolean and
  // the provider-native variant that justifies it; every other phase forbids
  // both so an ambiguous readiness claim can never be silently coerced.
  if (input.phase === "provider-ready") {
    if (typeof input.preInputReady !== "boolean") {
      throw new CanonicalLifecycleError(
        "A provider-ready event requires an explicit boolean preInputReady."
      );
    }
    if (input.readinessVariant !== undefined) {
      requireEventText(input.readinessVariant, "readinessVariant");
    }
  } else {
    if (input.preInputReady !== undefined) {
      throw new CanonicalLifecycleError("preInputReady is only meaningful on provider-ready.");
    }
    if (input.readinessVariant !== undefined) {
      throw new CanonicalLifecycleError("readinessVariant is only meaningful on provider-ready.");
    }
  }
  if (input.sequence !== undefined && !Number.isSafeInteger(input.sequence)) {
    throw new CanonicalLifecycleError("sequence must be a safe integer.");
  }
  return Object.freeze({
    phase: input.phase,
    source: input.source,
    evidence: input.evidence,
    fence,
    ...(input.preInputReady === undefined ? {} : { preInputReady: input.preInputReady }),
    ...(input.readinessVariant === undefined ? {} : { readinessVariant: input.readinessVariant }),
    ...(input.sequence === undefined ? {} : { sequence: input.sequence }),
    ...(input.summary === undefined ? {} : { summary: input.summary })
  });
}

/**
 * The provider-neutral decision. Given a validated canonical event and the
 * consumer's current expectation, it returns what should happen — idempotent for
 * duplicates, deferred for not-yet-applicable facts, obsolete for stale/wrong
 * generation, fail-closed for contract violations. It reads only phase / source
 * / evidence / identity, never the adapter name, and mutates nothing.
 */
export function foldCanonicalLifecycleEvent(
  event: CanonicalLifecycleEvent,
  expectation: CanonicalRunExpectation
): CanonicalFoldDecision {
  const identity = matchesFence(expectation, event);
  if (identity !== null) {
    return { outcome: "obsolete", reason: identity };
  }
  switch (event.phase) {
    case "host-process-created":
      return { outcome: "mark-host-created" };

    case "provider-session-started": {
      if (expectation.terminal) return { outcome: "obsolete", reason: "session-started-after-terminal" };
      // Idempotent on replay: a duplicate hook for an already-applied
      // session-started fact is a no-op, read from existing durable state.
      if (expectation.sessionStarted) {
        return { outcome: "idempotent", reason: "already-session-started" };
      }
      // Discovery may bind a previously-unknown native id, but only under the
      // exact launch fence and only when none is bound yet.
      if (
        expectation.boundNativeSessionId === undefined
        && event.fence.nativeSessionId !== undefined
        && event.fence.launchId !== undefined
        && event.fence.launchId === expectation.fence.launchId
      ) {
        return { outcome: "bind-native-session", nativeSessionId: event.fence.nativeSessionId };
      }
      return { outcome: "mark-session-started" };
    }

    case "provider-ready": {
      if (expectation.terminal) return { outcome: "obsolete", reason: "ready-after-terminal" };
      // Idempotent on replay against existing durable ready state.
      if (expectation.ready) return { outcome: "idempotent", reason: "already-ready" };
      // preInputReady is guaranteed an explicit boolean by construction.
      return { outcome: "mark-ready", preInputReady: event.preInputReady === true };
    }

    case "prompt-pushed":
      if (expectation.terminal) return { outcome: "obsolete", reason: "push-after-terminal" };
      if (expectation.accepted) return { outcome: "obsolete", reason: "push-after-accepted" };
      // Exactly one push: a repeat for an already-pushed Run is a no-op, never a
      // second Enter.
      if (expectation.pushed) return { outcome: "idempotent", reason: "already-pushed" };
      return { outcome: "mark-pushed" };

    case "provider-accepted":
      // Only an identity-matched durable native event can move accepted/delivered,
      // and only after the independently committed transport receipt. Provider
      // acceptance and transport acknowledgement are deliberately separate
      // evidence layers: neither may repair or infer the other. A fresh managed
      // Host can publish native acceptance immediately before its launch call
      // returns and lets the scheduler persist the transport receipt. Retain
      // that exact fenced fact for replay instead of misclassifying it as stale.
      if (!expectation.pushed) return { outcome: "deferred", reason: "accept-before-push" };
      if (expectation.terminal) return { outcome: "obsolete", reason: "accept-after-terminal" };
      if (expectation.accepted) return { outcome: "idempotent", reason: "already-accepted" };
      return { outcome: "advance-accepted" };

    case "turn-progress":
      // Progress only exists inside an accepted turn; a completion never promotes
      // acceptance, so progress before acceptance is a contract violation.
      if (!expectation.accepted) return { outcome: "fail-closed", reason: "progress-without-accept" };
      if (expectation.terminal) return { outcome: "obsolete", reason: "progress-after-terminal" };
      return { outcome: "advance-progress" };

    case "turn-terminal":
      if (expectation.terminal) return { outcome: "idempotent", reason: "already-terminal" };
      if (expectation.accepted) return { outcome: "advance-terminal" };
      // A terminal for a pushed-but-unaccepted Run must NOT promote acceptance;
      // hold the immutable fact until (or unless) acceptance folds first.
      if (expectation.pushed) return { outcome: "deferred", reason: "terminal-before-accept" };
      return { outcome: "fail-closed", reason: "terminal-without-push" };

    default:
      return { outcome: "fail-closed", reason: `unhandled-phase:${String(event.phase)}` };
  }
}

/**
 * Returns null when the event belongs to the expected generation/Run, or a
 * mismatch reason otherwise. Owner/adapter and run-scoped runId are always
 * compared. Provider-truth phases (acceptance/progress/terminal) require the
 * COMPLETE generation fence — nativeSessionId, launchId, and (for acceptance)
 * receiptId must be present and equal, so a missing or wrong generation/receipt
 * fails closed rather than advancing a Run or its successor. Where a native id
 * is already bound, every run-scoped fact must match it.
 */
function matchesFence(
  expectation: CanonicalRunExpectation,
  event: CanonicalLifecycleEvent
): string | null {
  const expected = expectation.fence;
  const actual = event.fence;
  const phase = event.phase;
  if (expected.taskId !== actual.taskId) return "fence-mismatch:taskId";
  if (expected.roleName !== actual.roleName) return "fence-mismatch:roleName";
  if (expected.agentId !== actual.agentId) return "fence-mismatch:agentId";
  if (expected.adapterId !== actual.adapterId) return "fence-mismatch:adapterId";

  // Run-scoped phases must name the exact expected Run.
  if (RUN_SCOPED_PHASES.has(phase)) {
    if (expected.runId === undefined) return "fence-mismatch:expected-run-missing";
    if (actual.runId !== expected.runId) return "fence-mismatch:runId";
  } else if (
    actual.runId !== undefined
    && expected.runId !== undefined
    && actual.runId !== expected.runId
  ) {
    return "fence-mismatch:runId";
  }

  // Provider-truth phases require the complete, equal generation fence. A
  // provider-accepted event additionally must carry the exact receipt it accepts.
  if (PROVIDER_TRUTH_PHASES.has(phase)) {
    if (actual.nativeSessionId === undefined) return "fence-mismatch:missing-native-session";
    if (actual.launchId === undefined) return "fence-mismatch:missing-launch";
    if (expected.launchId !== undefined && actual.launchId !== expected.launchId) {
      return "fence-mismatch:launchId";
    }
    // Once a native id is bound, every provider-truth fact must match it. Before
    // binding (discovery still open) the expected fence's own nativeSessionId, if
    // present, still constrains it.
    const boundNative = expectation.boundNativeSessionId ?? expected.nativeSessionId;
    if (boundNative !== undefined && actual.nativeSessionId !== boundNative) {
      return "fence-mismatch:nativeSessionId";
    }
    if (phase === "provider-accepted") {
      if (actual.receiptId === undefined) return "fence-mismatch:missing-receipt";
      if (expected.receiptId !== undefined && actual.receiptId !== expected.receiptId) {
        return "fence-mismatch:receiptId";
      }
    }
    return null;
  }

  // Pre-acceptance phases (host/session/ready and the transport push): compare
  // the generation dimensions that are present on both sides. A push must match
  // its expected receipt when both name one.
  if (
    actual.nativeSessionId !== undefined
    && expectation.boundNativeSessionId !== undefined
    && actual.nativeSessionId !== expectation.boundNativeSessionId
  ) {
    return "fence-mismatch:nativeSessionId";
  }
  if (
    actual.nativeSessionId !== undefined
    && expected.nativeSessionId !== undefined
    && actual.nativeSessionId !== expected.nativeSessionId
  ) {
    return "fence-mismatch:nativeSessionId";
  }
  if (
    actual.launchId !== undefined
    && expected.launchId !== undefined
    && actual.launchId !== expected.launchId
  ) {
    return "fence-mismatch:launchId";
  }
  if (
    phase === "prompt-pushed"
    && actual.receiptId !== undefined
    && expected.receiptId !== undefined
    && actual.receiptId !== expected.receiptId
  ) {
    return "fence-mismatch:receiptId";
  }
  return null;
}

function normalizeFence(fence: CanonicalIdentityFence): CanonicalIdentityFence {
  const taskId = requireFenceText(fence.taskId, "taskId");
  const roleName = requireFenceText(fence.roleName, "roleName");
  const agentId = requireFenceText(fence.agentId, "agentId");
  if (fence.adapterId !== "codex" && fence.adapterId !== "claude") {
    throw new CanonicalLifecycleError(`Unsupported adapter fence: ${String(fence.adapterId)}.`);
  }
  return Object.freeze({
    taskId,
    roleName,
    agentId,
    adapterId: fence.adapterId,
    ...(fence.runId === undefined ? {} : { runId: requireFenceText(fence.runId, "runId") }),
    ...(fence.nativeSessionId === undefined
      ? {}
      : { nativeSessionId: requireFenceText(fence.nativeSessionId, "nativeSessionId") }),
    ...(fence.launchId === undefined ? {} : { launchId: requireFenceText(fence.launchId, "launchId") }),
    ...(fence.receiptId === undefined ? {} : { receiptId: requireFenceText(fence.receiptId, "receiptId") })
  });
}

function requireFenceText(value: unknown, label: string): string {
  if (typeof value !== "string" || value.includes("\0")) {
    throw new CanonicalLifecycleError(`Fence ${label} is invalid.`);
  }
  const text = value.trim();
  if (text.length === 0 || text.length > 1_024) {
    throw new CanonicalLifecycleError(`Fence ${label} is invalid.`);
  }
  return text;
}

function requireEventText(value: unknown, label: string): string {
  if (typeof value !== "string" || value.includes("\0")) {
    throw new CanonicalLifecycleError(`${label} is invalid.`);
  }
  const text = value.trim();
  if (text.length === 0 || text.length > 1_024) {
    throw new CanonicalLifecycleError(`${label} is invalid.`);
  }
  return text;
}
