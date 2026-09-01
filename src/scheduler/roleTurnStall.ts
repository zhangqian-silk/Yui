import type { TaskEvent } from "../event/taskEvent.js";
import {
  selectedSchedulerRoles,
  selectedActiveSchedulerTasks,
  type TurnProgressFacts,
  type SchedulerReconcileSelection,
  type SchedulerRoleSession,
  type SchedulerRoleResourceEvidence,
  type SchedulerStorePort,
  type TmuxDeliveryPort
} from "./ports.js";
import type { RoleLiveStatusSnapshot } from "./roleTurnLiveness.js";
import { nextPendingBatch } from "../coordination/workMailbox.js";
import {
  RUNTIME_DIAGNOSTIC_AFTER_MS,
  SEMANTIC_STALL_WINDOW_MS
} from "../runtime/runtimeHealthPolicy.js";

/**
 * Default window of no durable progress before a live-but-idle Turn becomes a
 * traceable needs-attention signal. It is deliberately long: a healthy Turn that
 * is simply slow keeps its structured checkpoint fresh and never crosses it.
 */
export const DEFAULT_STALL_WINDOW_MS = SEMANTIC_STALL_WINDOW_MS;
/** Cheap workflow-stall candidate filter; the real threshold remains 30m. */
export const DEFAULT_WORKFLOW_STALL_CANDIDATE_AGE_MS = RUNTIME_DIAGNOSTIC_AFTER_MS;
export const TURN_PROGRESS_EVENT = "turn.progress";
export const TURN_STALLED_EVENT = "turn.stalled";
export const TURN_RECOVERED_EVENT = "turn.recovered";
export const TURN_DIAGNOSTIC_FINISHED_EVENT = "runtime.diagnostic-finished";
/** Structured, non-Message recovery evidence written by an explicit Leader. */

/** Workflow-semantic events that count for the durable progress clock. */
const ACTIVITY_EVENT_TYPES = new Set([
  TURN_PROGRESS_EVENT,
  "message.sent",
  "input.answered",
  "input.auto-answered",
  "input.cancelled",
  "work.accepted",
  "work.updated",
  "review.completed",
  "review.failed",
  "integration.updated",
  "integration.completed",
  "integration.failed"
]);

export type RoleTurnStallKind = "delivery-stalled" | "workflow-not-progressing";
export type RoleTurnStallClassification =
  | "working"
  | "waiting-user"
  | "waiting-on-workers"
  | "truly-stalled";

/** Provider acceptance is deliberately separate from transport and pane state. */
export type RoleTurnProviderAcceptance = "accepted" | "rejected" | "ambiguous";

/** Optional advisory process sample carried by one scheduler inventory pass. */
export type RoleTurnResourceEvidence = SchedulerRoleResourceEvidence;

export type RoleTurnResourceEvidenceSnapshot = ReadonlyMap<
  string,
  RoleTurnResourceEvidence
>;

export type RoleTurnHealthProjection = Readonly<{
  candidate: boolean;
  stalled: boolean;
  classification: RoleTurnStallClassification;
  providerAcceptance: RoleTurnProviderAcceptance;
  hostLiveness: "present" | "absent" | "unknown";
  nativeSession: "matching" | "missing" | "stopped" | "broken" | "unknown";
  resourceActivity: boolean;
  progressAt: string;
  idleMs: number;
}>;

/**
 * One pure projection used by every Role. Resource activity is retained only
 * as exact-generation diagnostic evidence; it never changes the durable
 * progress clock, suppresses workflow attention, or authorizes recovery.
 */
export function projectRoleTurnHealth(input: Readonly<{
  progressAt: string;
  createdAt: string;
  now: Date;
  windowMs?: number;
  diagnosticAfterMs?: number;
  hostLiveness: "present" | "absent" | "unknown";
  nativeSession?: Readonly<{
    status: string;
    endReason?: string;
    nativeSessionId?: string;
    launchId?: string;
  }> | null;
  providerAcceptance?: RoleTurnProviderAcceptance;
  resource?: RoleTurnResourceEvidence;
  roleName?: string;
  waitingUser?: boolean;
  waitingOnWorkers?: boolean;
  staleLeaderMailbox?: boolean;
}>): RoleTurnHealthProjection {
  const windowMs = input.windowMs ?? DEFAULT_STALL_WINDOW_MS;
  const diagnosticAfterMs = input.diagnosticAfterMs
    ?? DEFAULT_WORKFLOW_STALL_CANDIDATE_AGE_MS;
  if (!Number.isFinite(windowMs) || windowMs <= 0) {
    throw new Error("Role Turn stall window must be a positive number of milliseconds.");
  }
  const evaluation = evaluateRoleTurnStall({
    progressAt: input.progressAt,
    now: input.now,
    windowMs
  });
  const idleMs = evaluation.idleMs;
  const candidateAge = input.now.getTime() - Date.parse(input.createdAt);
  const candidate = Number.isFinite(candidateAge) && candidateAge >= windowMs;
  const providerAcceptance = input.providerAcceptance
    ?? "ambiguous";
  const hostLiveness = input.hostLiveness;
  const session = input.nativeSession;
  const nativeSession = session === null || session === undefined
    ? "missing"
    : session.status === "ended"
      ? session.endReason === "failed" ? "broken" : "stopped"
      : !hasResourceIdentityText(session.nativeSessionId)
            && !hasResourceIdentityText(session.launchId)
            ? "unknown"
            : "matching";
  const resourceActivity = hostLiveness === "present"
    && nativeSession === "matching"
    && resourceEvidenceIsFresh(input.resource, input.now, windowMs, diagnosticAfterMs)
    // Residency/RSS and an unchanged cumulative counter are not progress.
    && input.resource?.active === true
    && input.resource?.changed === true;
  const waitingUser = input.waitingUser === true;
  const waitingOnWorkers = input.waitingOnWorkers === true && !input.staleLeaderMailbox;
  // A TmuxSessionHost binding may intentionally be opaque and therefore have
  // no persisted nativeSessionId.  With a present host, durable no-progress
  // evidence is still actionable in that case.  Only an explicit stopped or
  // broken Session blocks the projection; identity mismatches are fenced by
  // reconcileStalledRoleTurns below before this projection is routed.
  const workflowStall = candidate
    && evaluation.stalled
    && hostLiveness === "present"
    && nativeSession !== "stopped"
    && nativeSession !== "broken"
    && providerAcceptance !== "ambiguous";
  const stalled = workflowStall
    && !waitingUser
    && !waitingOnWorkers;
  const classification: RoleTurnStallClassification = waitingUser
    ? "waiting-user"
    : waitingOnWorkers
      ? "waiting-on-workers"
      : stalled
        ? "truly-stalled"
        : candidate && input.roleName === "leader"
          ? "working"
          : "working";
  return {
    candidate,
    stalled,
    classification,
    providerAcceptance,
    hostLiveness,
    nativeSession,
    resourceActivity,
    progressAt: input.progressAt,
    idleMs
  };
}

export type RoleTurnStallEvaluation = Readonly<{
  stalled: boolean;
  /**
   * A stall observed against a progress point no prior attention already
   * covered. Repeated observations of the same idle point are the same stall
   * and must not re-notify; only genuinely new stall evidence is a new episode.
   */
  isNewEpisode: boolean;
  idleMs: number;
  progressAt: string;
}>;

/**
 * Pure stall decision. Given the last durable progress timestamp and whatever
 * progress point the previous attention (if any) recorded, decide whether the
 * Turn is stalled and whether this is new evidence worth surfacing again.
 */
export function evaluateRoleTurnStall(input: Readonly<{
  progressAt: string;
  now: Date;
  windowMs?: number;
  lastAttentionProgressAt?: string;
}>): RoleTurnStallEvaluation {
  const windowMs = input.windowMs ?? DEFAULT_STALL_WINDOW_MS;
  if (!Number.isFinite(windowMs) || windowMs <= 0) {
    throw new Error("Role Turn stall window must be a positive number of milliseconds.");
  }
  const progressMs = Date.parse(input.progressAt);
  if (!Number.isFinite(progressMs)) {
    throw new Error("Role Turn stall progress timestamp is invalid.");
  }
  const idleMs = input.now.getTime() - progressMs;
  const stalled = idleMs >= windowMs;
  const isNewEpisode = stalled && input.lastAttentionProgressAt !== input.progressAt;
  return { stalled, isNewEpisode, idleMs, progressAt: input.progressAt };
}

/**
 * Latest durable progress timestamp for an active Turn. Turn creation,
 * explicit workflow checkpoints, and semantic domain activity count as
 * progress. Provider operations, tokens, CPU/memory and bookkeeping are
 * intentionally excluded.
 */
export function latestDurableProgressAt(input: Readonly<{
  startedAt: string;
  /**
   * Retained for narrow ports that still provide these fields, but deliberately
   * ignored: bookkeeping refreshes must not reset a semantic progress clock.
   */
  runUpdatedAt?: string;
  sessionUpdatedAt?: string;
  latestCheckpointAt?: string;
  latestActivityAt?: string;
}>): string {
  const candidates = [
    input.startedAt,
    input.latestCheckpointAt,
    input.latestActivityAt
  ].filter((value): value is string => (
    typeof value === "string" && Number.isFinite(Date.parse(value))
  ));
  if (candidates.length === 0) {
    throw new Error("No durable progress timestamp is available for the Turn.");
  }
  return candidates.reduce((latest, value) => (
    Date.parse(value) > Date.parse(latest) ? value : latest
  ));
}

/** Most recent semantic timestamp carried by a Turn progress event. */
export function latestTurnProgressAt(
  events: readonly TaskEvent[],
  turnId: string
): string | undefined {
  let latest: string | undefined;
  for (const event of events) {
    if (event.type !== TURN_PROGRESS_EVENT) continue;
    if (event.payload.turnId !== turnId) continue;
    const progressAt = typeof event.payload.progressAt === "string"
      && Number.isFinite(Date.parse(event.payload.progressAt))
      ? event.payload.progressAt
      : event.createdAt;
    // The semantic timestamp is the CAS value. A late/stale event must not
    // move the durable progress projection backwards merely because it was
    // appended later than a newer checkpoint.
    if (latest === undefined || Date.parse(progressAt) > Date.parse(latest)) {
      latest = progressAt;
    }
  }
  return latest;
}

/**
 * Resolve the exact semantic progress fence shared by resource production and
 * stall consumption for one active Turn. The richer adapter fold remains
 * authoritative when available; the retained Turn progress/activity events are
 * the provider-neutral fallback. Resource evidence carries this value as an
 * exact fence, but never advances it.
 */
export function currentRoleTurnProgressAt(
  store: Readonly<{
    listEvents?: (taskId: string) => readonly TaskEvent[];
    getTurnDurableProgress?: SchedulerStorePort["getTurnDurableProgress"];
    getTurnProgressFacts?: SchedulerStorePort["getTurnProgressFacts"];
  }>,
  taskId: string,
  roleName: string,
  run: Readonly<{ id: string; createdAt: string }>,
  events?: readonly TaskEvent[],
  progressFacts?: TurnProgressFacts
): Readonly<{ progressAt: string; evidence?: string }> {
  let richerProgress: Readonly<{ progressAt: string; evidence?: string }> | null | undefined;
  try {
    richerProgress = store.getTurnDurableProgress?.(taskId, roleName, run.id);
  } catch {
    // A related-record fold is advisory. The retained Turn/Event fence remains
    // usable when that optional read is unavailable.
    richerProgress = undefined;
  }
  // The richer fold is authoritative when present; skip the per-candidate
  // full-history scans that every stall candidate otherwise pays.
  if (richerProgress !== undefined && richerProgress !== null) {
    return {
      progressAt: richerProgress.progressAt,
      ...(richerProgress.evidence === undefined
        ? {}
        : { evidence: richerProgress.evidence })
    };
  }
  // A present fold port is authoritative even when this Turn has no entry. Do
  // not evaluate a default history argument or fall back to listEvents in
  // that case: an absent entry is the folded empty fact.
  const folded = store.getTurnProgressFacts !== undefined;
  const foldedFacts = folded
    ? progressFacts ?? store.getTurnProgressFacts?.(taskId, run.id)
    : undefined;
  if (folded) {
    const fallbackProgressAt = latestDurableProgressAt({
      startedAt: run.createdAt,
      latestCheckpointAt: foldedFacts?.latestCheckpointAt,
      latestActivityAt: foldedFacts?.latestActivityAt
    });
    return { progressAt: fallbackProgressAt };
  }
  // Legacy ports retain the per-Turn event-history fallback. Resolve the
  // history only in this branch so fold-backed callers perform zero scans.
  const history = events ?? store.listEvents?.(taskId) ?? [];
  const fallbackProgressAt = latestDurableProgressAt({
    startedAt: run.createdAt,
    latestCheckpointAt: latestTurnProgressAt(history, run.id),
    latestActivityAt: latestTurnActivityAt(history, run.id)
  });
  return {
    progressAt: fallbackProgressAt
  };
}

/**
 * Computes the current semantic progress fence for an exact Turn. The optional
 * related-record readers mirror the adapter's Work/Review/Integration fold;
 * narrow scheduler ports can omit them and still retain Turn/Event evidence.
 */
export function latestTurnDurableProgressAt(
  store: Readonly<{
    getTurn(taskId: string, turnId: string): Readonly<{
      id: string;
      taskId: string;
      roleName: string;
      createdAt: string;
      workItemId?: string;
    }> | null;
    listEvents(taskId: string): readonly TaskEvent[];
    getWorkItem?(taskId: string, workItemId: string): Readonly<{
      updatedAt: string;
      candidates?: readonly Readonly<{ createdAt: string }>[];
    }> | null;
    listReviewRounds?(taskId: string): readonly Readonly<{
      workItemId?: string;
      createdAt: string;
      endedAt?: string;
    }>[];
    listChangeSets?(taskId: string): readonly Readonly<{
      workItemId: string;
      createdAt: string;
      id: string;
    }>[];
    listIntegrationAttempts?(taskId: string): readonly Readonly<{
      updatedAt: string;
      changeSetIds: readonly string[];
    }>[];
    listInputRequests?(taskId: string): readonly Readonly<{
      updatedAt: string;
      requester: Readonly<{ turnId?: string }>;
      blockedRefs: readonly Readonly<{ type: string; id: string }>[];
    }>[];
  }>,
  taskId: string,
  roleName: string,
  turnId: string,
  precomputed?: { latestCheckpointAt?: string; latestActivityAt?: string }
): Readonly<{ progressAt: string; evidence?: string }> | null {
  const run = store.getTurn(taskId, turnId);
  if (run === null || run.taskId !== taskId || run.roleName !== roleName) return null;
  // The adapter folds checkpoint/activity once per revision. When the fold
  // port exists, a missing per-Turn entry is an authoritative empty fold: use
  // its (possibly undefined) values directly and never re-scan the whole
  // history per candidate. Legacy callers without the port omit precomputed
  // and keep the per-candidate full-history scans.
  const folded = precomputed !== undefined;
  const events = folded ? undefined : store.listEvents(taskId);
  const latestCheckpointAt = folded
    ? precomputed!.latestCheckpointAt
    : latestTurnProgressAt(events!, run.id);
  const latestActivityAt = folded
    ? precomputed!.latestActivityAt
    : latestTurnActivityAt(events!, run.id);
  const baseline = latestDurableProgressAt({
    startedAt: run.createdAt,
    latestCheckpointAt,
    latestActivityAt
  });
  if (run.workItemId === undefined) {
    return { progressAt: baseline };
  }

  const workItem = store.getWorkItem?.(taskId, run.workItemId) ?? null;
  const reviewRounds = store.listReviewRounds?.(taskId)
    .filter(({ workItemId }) => workItemId === run.workItemId)
    ?? [];
  const changeSets = store.listChangeSets?.(taskId)
    .filter(({ workItemId }) => workItemId === run.workItemId)
    ?? [];
  const changeSetIds = new Set(changeSets.map(({ id }) => id));
  const integrations = store.listIntegrationAttempts?.(taskId)
    .filter(({ changeSetIds: ids }) => ids.some((id) => changeSetIds.has(id)))
    ?? [];
  const inputProgress = store.listInputRequests?.(taskId)
    .filter((request) => (
      request.requester.turnId === run.id
      || request.blockedRefs.some((ref) => ref.type === "turn" && ref.id === run.id)
    ))
    ?? [];
  const related = [
    workItem?.updatedAt,
    ...reviewRounds.map(({ endedAt, createdAt }) => endedAt ?? createdAt),
    ...changeSets.map(({ createdAt }) => createdAt),
    ...integrations.map(({ updatedAt }) => updatedAt),
    ...inputProgress.map(({ updatedAt }) => updatedAt),
    ...(workItem?.candidates ?? []).map(({ createdAt }) => createdAt)
  ].filter((value): value is string => (
    typeof value === "string" && Number.isFinite(Date.parse(value))
  ));
  const latestRelatedAt = related.reduce<string | undefined>(
    (latest, value) => latest === undefined || Date.parse(value) > Date.parse(latest)
      ? value
      : latest,
    undefined
  );
  return latestRelatedAt !== undefined
    && Date.parse(latestRelatedAt) > Date.parse(baseline)
    ? { progressAt: latestRelatedAt, evidence: "work-review-integration" }
    : {
        progressAt: baseline,
        ...(latestRelatedAt === undefined ? {} : { evidence: "work-review-integration" })
      };
}

/** Most recent createdAt of a Turn-scoped event of one type, if any. */
export function latestTurnEventTime(
  events: readonly TaskEvent[],
  type: string,
  turnId: string
): string | undefined {
  let latest: string | undefined;
  for (const event of events) {
    if (event.type !== type || event.payload.turnId !== turnId) continue;
    if (latest === undefined || Date.parse(event.createdAt) > Date.parse(latest)) {
      latest = event.createdAt;
    }
  }
  return latest;
}

/** Most recent non-control event carrying a Turn identity. */
export function latestTurnActivityAt(
  events: readonly TaskEvent[],
  turnId: string
): string | undefined {
  let latest: string | undefined;
  for (const event of events) {
    if (
      !ACTIVITY_EVENT_TYPES.has(event.type)
      || event.payload.turnId !== turnId
      || event.type === TURN_STALLED_EVENT
      || event.type === TURN_RECOVERED_EVENT
    ) continue;
    const activityAt = event.type === TURN_PROGRESS_EVENT
      && typeof event.payload.progressAt === "string"
      && Number.isFinite(Date.parse(event.payload.progressAt))
      ? event.payload.progressAt
      : event.createdAt;
    if (latest === undefined || Date.parse(activityAt) > Date.parse(latest)) {
      latest = activityAt;
    }
  }
  return latest;
}

/** The progress point recorded by the most recent stall attention for a Turn. */
export function latestStallProgressAt(
  events: readonly TaskEvent[],
  turnId: string
): string | undefined {
  let latest: TaskEvent | undefined;
  for (const event of events) {
    if (event.type !== TURN_STALLED_EVENT || event.payload.turnId !== turnId) continue;
    if (latest === undefined || Date.parse(event.createdAt) > Date.parse(latest.createdAt)) {
      latest = event;
    }
  }
  return latest?.payload.progressAt;
}

/** Latest stall episode identity used for source-idempotent attention. */
export function latestStallEvidenceKey(
  events: readonly TaskEvent[],
  turnId: string
): Readonly<{ progressAt: string; evidenceKey: string }> | undefined {
  let latest: TaskEvent | undefined;
  for (const event of events) {
    if (event.type !== TURN_STALLED_EVENT || event.payload.turnId !== turnId) continue;
    if (latest === undefined || Date.parse(event.createdAt) > Date.parse(latest.createdAt)) {
      latest = event;
    }
  }
  if (latest?.payload.progressAt === undefined) return undefined;
  return {
    progressAt: latest.payload.progressAt,
    evidenceKey: latest.payload.evidenceKey ?? "live-pane-no-progress"
  };
}

type MutableTurnProgressFacts = {
  latestCheckpointAt?: string;
  latestActivityAt?: string;
  latestStall?: { progressAt: string; evidenceKey: string };
};

/**
 * Folds a Task's event history into per-Turn progress facts in one O(events)
 * pass. The adapter builds this once per durable revision and serves the
 * stall reconciliation from it, replacing the per-candidate full-history
 * clones and scans that turned one pass into an O(candidates x events) hot
 * read. The fold mirrors latestTurnProgressAt/latestTurnActivityAt/
 * latestStallProgressAt/latestStallEvidenceKey exactly.
 */
export function foldTurnProgressFacts(
  events: readonly TaskEvent[]
): Map<string, TurnProgressFacts> {
  const byTurn = new Map<string, MutableTurnProgressFacts>();
  const latestStallCreatedAt = new Map<string, string>();
  for (const event of events) {
    const turnId = event.payload.turnId;
    if (typeof turnId !== "string") continue;
    let facts = byTurn.get(turnId) as MutableTurnProgressFacts | undefined;
    if (facts === undefined) {
      facts = {};
      byTurn.set(turnId, facts);
    }
    const type = event.type;
    const isProgress = type === TURN_PROGRESS_EVENT;
    if (isProgress) {
      const validProgress = typeof event.payload.progressAt === "string"
        && Number.isFinite(Date.parse(event.payload.progressAt));
      const progressAt = validProgress
        ? (event.payload.progressAt as string)
        : event.createdAt;
      if (facts.latestCheckpointAt === undefined
        || Date.parse(progressAt) > Date.parse(facts.latestCheckpointAt)) {
        facts.latestCheckpointAt = progressAt;
      }
      // Workflow checkpoints are also semantic activity.
      if (facts.latestActivityAt === undefined
        || Date.parse(progressAt) > Date.parse(facts.latestActivityAt)) {
        facts.latestActivityAt = progressAt;
      }
    } else if (type === TURN_STALLED_EVENT) {
      const previousCreatedAt = latestStallCreatedAt.get(turnId);
      if (previousCreatedAt === undefined
        || Date.parse(event.createdAt) > Date.parse(previousCreatedAt)) {
        latestStallCreatedAt.set(turnId, event.createdAt);
        facts.latestStall = typeof event.payload.progressAt === "string"
          ? {
              progressAt: event.payload.progressAt as string,
              evidenceKey: typeof event.payload.evidenceKey === "string"
                ? event.payload.evidenceKey as string
                : "live-pane-no-progress"
            }
          : undefined;
      }
    } else if (ACTIVITY_EVENT_TYPES.has(type)
      && type !== TURN_STALLED_EVENT
      && type !== TURN_RECOVERED_EVENT) {
      if (facts.latestActivityAt === undefined
        || Date.parse(event.createdAt) > Date.parse(facts.latestActivityAt)) {
        facts.latestActivityAt = event.createdAt;
      }
    }
  }
  return byTurn as Map<string, TurnProgressFacts>;
}

/** Yield the event loop so already-written control requests stay responsive. */
function yieldEventLoop(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

/**
 * True while a Turn remains in an unresolved stall episode: a stall was raised
 * and no later checkpoint has advanced its durable progress since. This is the
 * projection the runtime-health view reads to surface needs-attention.
 */
export function isRoleTurnStalled(
  events: readonly TaskEvent[],
  turnId: string
): boolean {
  let stalled: TaskEvent | undefined;
  let recoveredAt: string | undefined;
  let progressAt: string | undefined;
  for (const event of events) {
    if (event.payload.turnId !== turnId) continue;
    if (event.type === TURN_STALLED_EVENT) {
      if (event.payload.status === "diagnostic-only") continue;
      if (stalled === undefined
        || Date.parse(event.createdAt) > Date.parse(stalled.createdAt)) {
        stalled = event;
      }
      continue;
    }
    if (event.type === TURN_RECOVERED_EVENT) {
      if (recoveredAt === undefined
        || Date.parse(event.createdAt) > Date.parse(recoveredAt)) {
        recoveredAt = event.createdAt;
      }
      continue;
    }
    if (event.type !== TURN_PROGRESS_EVENT) continue;
    const candidate = typeof event.payload.progressAt === "string"
      && Number.isFinite(Date.parse(event.payload.progressAt))
      ? event.payload.progressAt
      : event.createdAt;
    if (progressAt === undefined || Date.parse(candidate) > Date.parse(progressAt)) {
      progressAt = candidate;
    }
  }
  if (stalled === undefined) return false;
  const stalledAt = stalled.createdAt;
  const stalledProgressAt = typeof stalled.payload.progressAt === "string"
    && Number.isFinite(Date.parse(stalled.payload.progressAt))
    ? stalled.payload.progressAt
    : stalledAt;
  if (recoveredAt !== undefined && Date.parse(recoveredAt) > Date.parse(stalledAt)) {
    return false;
  }
  return progressAt === undefined || Date.parse(progressAt) <= Date.parse(stalledProgressAt);
}

export type RoleTurnStallResult = Readonly<{
  taskId: string;
  roleName: string;
  turnId: string;
  status: "raised" | "already-raised";
  kind: RoleTurnStallKind;
  classification: "truly-stalled";
  idleMs: number;
}>;

/**
 * Low-frequency health pass for active Task Role Turns. An unaccepted Turn is
 * watched as delivery-stalled after the reasonable delivery window; an
 * accepted Turn is displayed as checkpoint-overdue after fifteen minutes, but
 * this scheduler performs no runtime inspection until the thirty-minute
 * diagnostic window is due.
 * Leader Turns are only persisted when classification reaches truly-stalled —
 * healthy downstream work, open user input, and recent own progress remain
 * structured waiting/working facts. No branch sends terminal bytes, retries,
 * replaces a Session, or changes Turn status.
 */
export async function reconcileStalledRoleTurns(
  store: SchedulerStorePort,
  delivery: Pick<TmuxDeliveryPort, "inspectRole" | "inspectRoles">,
  now: Date,
  selection?: SchedulerReconcileSelection,
  windowMs = DEFAULT_STALL_WINDOW_MS,
  liveStatuses?: RoleLiveStatusSnapshot,
  resourceEvidence?: RoleTurnResourceEvidenceSnapshot,
  diagnosticAfterMs = DEFAULT_WORKFLOW_STALL_CANDIDATE_AGE_MS
): Promise<RoleTurnStallResult[]> {
  // Dirty mailbox passes are intentionally not a second scheduler. Full
  // reconcile owns the all-active-Turn scan; dirty passes may still route the
  // existing mailbox work without manufacturing another episode.
  if (selection !== undefined && !selection.full) return [];
  if (
    (store.getTurnProgressFacts === undefined && store.listEvents === undefined)
    || store.recordRoleTurnStall === undefined
  ) return [];
  // When the fold port exists, a missing per-Turn entry is an authoritative
  // empty fold: the stall reconciliation must not re-scan the whole history
  // per candidate. Legacy stores without the port keep the per-candidate
  // scans.
  const foldPortPresent = store.getTurnProgressFacts !== undefined;
  const candidates = selectedActiveSchedulerTasks(store, selection).flatMap((task) => (
    selectedSchedulerRoles(store, task.id, selection).flatMap((role) => {
      const run = store.getActiveTurn(task.id, role.name);
      if (run === null || run.status !== "active") return [];
      return [{
        task,
        role,
        run,
        session: store.getRoleSession(
          task.id,
          role.name,
          run.effective.agentId
        )
      }];
    })
  ));
  const eventsByTask = new Map<string, readonly TaskEvent[]>();
  const diagnosticEvents = (taskId: string): readonly TaskEvent[] => {
    const existing = eventsByTask.get(taskId);
    if (existing !== undefined) return existing;
    const events = store.listEvents?.(taskId) ?? [];
    eventsByTask.set(taskId, events);
    return events;
  };
  const cadenceCandidates = candidates.filter(({ task, run }) => isStallCandidate(
    run,
    now,
    windowMs,
    latestTurnEventTime(diagnosticEvents(task.id), TURN_DIAGNOSTIC_FINISHED_EVENT, run.id)
  ));
  const stallCandidates = cadenceCandidates.filter(({ task, role, run }) => {
    const progressFacts = foldPortPresent
      ? store.getTurnProgressFacts?.(task.id, run.id)
      : undefined;
    const progressAt = currentRoleTurnProgressAt(
      store,
      task.id,
      role.name,
      run,
      foldPortPresent ? undefined : diagnosticEvents(task.id),
      progressFacts
    ).progressAt;
    return isStallCandidate(
      run,
      now,
      windowMs,
      latestTurnEventTime(
        diagnosticEvents(task.id),
        TURN_DIAGNOSTIC_FINISHED_EVENT,
        run.id
      ),
      progressAt
    );
  });
  if (stallCandidates.length === 0) return [];
  const diagnosticStartedAt = now.toISOString();
  const finishDiagnostics = (outcome: "observed" | "observation-error"): void => {
    for (const { task, role, run } of stallCandidates) {
      store.recordRoleTurnDiagnostic?.({
        taskId: task.id,
        roleName: role.name,
        turnId: run.id,
        startedAt: diagnosticStartedAt,
        outcome,
        now
      });
    }
  };
  const stallCandidateKeys = new Set(stallCandidates.map(({ task, role }) => (
    `${task.id}\0${role.name}`
  )));
  const observed = new Map<string, ObservedRun>();
  // Recent active Turns are known healthy enough for Leader classification from
  // their exact acceptance/creation boundary, but are deliberately not read
  // from tmux or Event history until the 30-minute diagnostic window.
  for (const candidate of candidates) {
    const key = `${candidate.task.id}\0${candidate.role.name}`;
    if (stallCandidateKeys.has(key)) continue;
    observed.set(key, {
      candidate,
      live: liveStatuses?.get(key) ?? "present",
      progressAt: candidate.run.createdAt,
      idleMs: 0,
      stalled: false,
      resourceActivity: false,
      stallCandidate: false
    });
  }

  let statuses: Awaited<ReturnType<NonNullable<TmuxDeliveryPort["inspectRoles"]>>> | null = null;
  if (liveStatuses !== undefined) {
    statuses = null;
  } else if (delivery.inspectRoles !== undefined) {
    try {
      statuses = await delivery.inspectRoles(stallCandidates.map(({ task, role, run, session }) => ({
          taskId: task.id,
          roleName: role.name,
          turnId: run.id,
          progressAt: run.createdAt,
          agentId: session?.agentId ?? run.effective.agentId,
          adapterId: session?.adapterId ?? run.effective.adapterId,
          ...(session?.launchId === undefined ? {} : { launchId: session.launchId }),
          ...(session?.nativeSessionId === undefined
              ? {}
              : { nativeSessionId: session.nativeSessionId })
        })), stallCandidates.map(({ task, role, run, session }) => ({
                taskId: task.id,
                roleName: role.name,
                turnId: run.id,
                progressAt: currentRoleTurnProgressAt(
                  store,
                  task.id,
                  role.name,
                  run
                ).progressAt,
                agentId: session?.agentId ?? run.effective.agentId,
                adapterId: session?.adapterId ?? run.effective.adapterId,
                ...(session?.launchId === undefined ? {} : { launchId: session.launchId }),
                ...(session?.nativeSessionId === undefined
                  ? {}
                  : { nativeSessionId: session.nativeSessionId })
              })));
    } catch {
      // Health inspection is advisory. Unknown host state must leave the exact
      // Turn/Session fence untouched. Closing this window schedules the next
      // bounded diagnostic thirty minutes later instead of hot-looping.
      finishDiagnostics("observation-error");
      return [];
    }
  }
  let byRole: Map<string, "present" | "absent"> | null = null;
  if (statuses !== null) {
    try {
      byRole = exactLiveStatuses(statuses, stallCandidates);
    } catch {
      // A malformed/partial provider snapshot is not evidence of a stall.
      // Leave all fences untouched and let the next full pass retry.
      finishDiagnostics("observation-error");
      return [];
    }
  }
  const raised: RoleTurnStallResult[] = [];
  for (const [candidateIndex, candidate] of stallCandidates.entries()) {
    // A large Task's per-candidate reads are now bounded, but many candidates
    // in one pass still add up. Yield periodically so already-written control
    // requests are not starved by the whole reconciliation.
    if (candidateIndex > 0 && candidateIndex % 16 === 0) await yieldEventLoop();
    const key = `${candidate.task.id}\0${candidate.role.name}`;
    let live: "present" | "absent";
    try {
      if (liveStatuses !== undefined && !liveStatuses.has(key)) {
        finishDiagnostics("observation-error");
        return [];
      }
      live = liveStatuses !== undefined
        ? liveStatuses.get(key)!
        : byRole === null
        ? await delivery.inspectRole({
            taskId: candidate.task.id,
            roleName: candidate.role.name,
            agentId: candidate.session?.agentId ?? candidate.run.effective.agentId,
            adapterId: candidate.session?.adapterId ?? candidate.run.effective.adapterId,
            ...(candidate.session?.nativeSessionId === undefined
              ? {}
              : { nativeSessionId: candidate.session.nativeSessionId })
          })
        : byRole.get(key)!;
    } catch {
      // Without a complete live snapshot, especially for downstream Turns,
      // Leader classification would be unsafe. Treat the whole advisory pass
      // as unknown instead of escalating a false stall.
      finishDiagnostics("observation-error");
      return [];
    }
    // A missing process is handled by the existing fenced liveness pass. This
    // monitor must not race it or synthesize a second failure disposition.
    if (live !== "present") {
      observed.set(key, {
        candidate,
        live,
        progressAt: candidate.run.createdAt,
        idleMs: 0,
        stalled: false,
        resourceActivity: false,
        stallCandidate: true
      });
      continue;
    }

    // Fold-backed adapters expose an authoritative per-Turn fact, so do not
    // load the Task history just to satisfy currentRoleTurnProgressAt or its
    // fallback. Legacy ports retain one history read for these projections.
    const progressFacts = foldPortPresent
      ? store.getTurnProgressFacts?.(candidate.task.id, candidate.run.id)
      : undefined;
    const events = foldPortPresent
      ? undefined
      : store.listEvents?.(candidate.task.id);
    // The Turn creation boundary starts the execution clock; durable workflow
    // facts may advance it independently of Provider transport observations.
    const progress = currentRoleTurnProgressAt(
      store,
      candidate.task.id,
      candidate.role.name,
      candidate.run,
      events,
      progressFacts
    );
    const progressAt = progress.progressAt;
    const evaluation = evaluateRoleTurnStall({
      progressAt,
      now,
      windowMs,
      lastAttentionProgressAt: foldPortPresent
        ? progressFacts?.latestStall?.progressAt
        : latestStallProgressAt(events ?? [], candidate.run.id)
    });
    const runAgentId = candidate.run.effective.agentId;
    const runAdapterId = candidate.run.effective.adapterId;
    const sessionMatchesRun = candidate.session === null
      || (
        candidate.session.agentId === runAgentId
        && candidate.session.adapterId === runAdapterId
      );
    const sessionUsable = candidate.session === null
      || candidate.session.status === "active";
    const expectedResourceIdentity = candidate.session === null
      ? undefined
      : {
          taskId: candidate.task.id,
          roleName: candidate.role.name,
          turnId: candidate.run.id,
          agentId: runAgentId,
          adapterId: runAdapterId,
          ...(candidate.session.nativeSessionId === undefined
            ? {}
            : { nativeSessionId: candidate.session.nativeSessionId }),
          ...(candidate.session.launchId === undefined
            ? {}
            : { launchId: candidate.session.launchId })
        };
    const resourceSnapshot = resourceForRun(
      resourceEvidence,
      candidate.task.id,
      candidate.role.name,
      candidate.run.id
    );
    const resourceIsCurrent = live === "present"
      && sessionMatchesRun
      && sessionUsable
      && expectedResourceIdentity !== undefined
      && resourceEvidenceMatchesCurrentRun(
        resourceSnapshot,
        expectedResourceIdentity,
        progressAt
      )
      && resourceEvidenceIsFresh(resourceSnapshot, now, windowMs, diagnosticAfterMs);
    const resource = resourceIsCurrent ? resourceSnapshot : undefined;
    const health = projectRoleTurnHealth({
      progressAt,
      createdAt: candidate.run.createdAt,
      now,
      windowMs,
      diagnosticAfterMs,
      hostLiveness: live,
      nativeSession: candidate.session,
      providerAcceptance: candidate.session === null ? "ambiguous" : "accepted",
      resource,
      roleName: candidate.role.name
    });
    // Delivery-stalled Turns retain the existing delivery clock and immediate
    // Provider-uncertainty path. Accepted execution Turns use the shared
    // projection. Exact Session/host resource evidence remains diagnostic.
    const resourceActivity = health.resourceActivity;
    const stalled = health.stalled && sessionMatchesRun && sessionUsable;
    observed.set(key, {
      candidate,
      live,
      progressAt,
      idleMs: evaluation.idleMs,
      // Resource activity is advisory and never advances workflow progress or
      // suppresses a workflow-not-progressing episode.
      stalled,
      resourceActivity,
      evidence: [
        ...(progress.evidence === undefined ? [] : [progress.evidence]),
        ...(resourceActivity ? ["resource-activity"] : [])
      ].join(",") || undefined,
      stallCandidate: true
    });
  }

  for (const current of observed.values()) {
    if (current.live !== "present" || !current.stalled || !current.stallCandidate) continue;
    const { candidate, progressAt } = current;
    const previous = foldPortPresent
      ? store.getTurnProgressFacts?.(candidate.task.id, candidate.run.id)?.latestStall
      : latestStallEvidenceKey(store.listEvents?.(candidate.task.id) ?? [], candidate.run.id);
    if (
      previous !== undefined
      && Date.parse(progressAt) > Date.parse(previous.progressAt)
    ) {
      // A new semantic progress point closes the previous episode first. It
      // may itself already be older than the window, in which case the same
      // pass records the next Turn+progressAt episode below.
      store.recordRoleTurnProgress?.({
        taskId: candidate.task.id,
        roleName: candidate.role.name,
        turnId: candidate.run.id,
        progressAt,
        ...(current.evidence === undefined ? {} : { evidence: current.evidence }),
        now
      });
    }
    const kind: RoleTurnStallKind = candidate.session === null
      ? "delivery-stalled"
      : "workflow-not-progressing";
    const classification = candidate.role.name === "leader"
      ? classifyLeaderStall(store, candidate.task.id, observed, now, windowMs)
      : "truly-stalled";
    // A Leader waiting on the user or healthy downstream work is not a stall
    // episode. Its durable InputRequest/worker facts remain the evidence.
    if (classification !== "truly-stalled") continue;
    const evidenceKey = [
      kind,
      stallEvidenceKey(candidate.session?.status),
      classification,
      ...(candidate.role.name === "leader"
        ? [leaderStallEvidence(store, candidate.task.id, observed, now, windowMs)]
        : []),
      ...(current.evidence === undefined ? [] : [current.evidence])
    ].join(":");
    // The final contract is one episode per Turn + semantic progress point.
    // New role/session/provider evidence is retained in the Leader's next
    // diagnostic context, not duplicated as another Task-level alert.
    if (previous?.progressAt === progressAt) continue;
    const persisted = store.recordRoleTurnStall({
      taskId: candidate.task.id,
      roleName: candidate.role.name,
      turnId: candidate.run.id,
      agentId: candidate.run.effective.agentId,
      adapterId: candidate.run.effective.adapterId,
      session: candidate.session,
      kind,
      classification,
      progressAt,
      idleMs: current.idleMs,
      evidenceKey,
      now
    });
    if (persisted === "raised" || persisted === "already-raised") {
      raised.push({
        taskId: candidate.task.id,
        roleName: candidate.role.name,
        turnId: candidate.run.id,
        status: persisted,
        kind,
        classification,
        idleMs: current.idleMs
      });
    }
  }

  // A related WorkItem/Review/Integration fold may advance progress without
  // carrying the Turn id. Materialize it once so context/web can clear the
  // attention projection and the event history records the recovery boundary.
  for (const current of observed.values()) {
    if (current.live !== "present" || current.stalled || !current.stallCandidate) continue;
    const { candidate, progressAt } = current;
    const previous = foldPortPresent
      ? store.getTurnProgressFacts?.(candidate.task.id, candidate.run.id)?.latestStall
      : latestStallEvidenceKey(store.listEvents?.(candidate.task.id) ?? [], candidate.run.id);
    if (
      previous !== undefined
      && Date.parse(progressAt) > Date.parse(previous.progressAt)
    ) {
      store.recordRoleTurnProgress?.({
        taskId: candidate.task.id,
        roleName: candidate.role.name,
        turnId: candidate.run.id,
        progressAt,
        ...(current.evidence === undefined ? {} : { evidence: current.evidence }),
        now
      });
    }
  }
  finishDiagnostics("observed");
  return raised;
}

function isStallCandidate(
  run: Readonly<{ createdAt: string }>,
  now: Date,
  windowMs: number,
  lastDiagnosticFinishedAt?: string,
  latestProgressAt?: string
): boolean {
  const baseline = [run.createdAt, lastDiagnosticFinishedAt, latestProgressAt]
    .filter((value): value is string => (
      value !== undefined && Number.isFinite(Date.parse(value))
    ))
    .reduce((latest, value) => (
      Date.parse(value) > Date.parse(latest) ? value : latest
    ));
  const ageMs = now.getTime() - Date.parse(baseline);
  if (!Number.isFinite(ageMs)) return false;
  return ageMs >= windowMs;
}

type ObservedRun = Readonly<{
  candidate: Readonly<{
    task: Readonly<{ id: string }>;
    role: Readonly<{
      name: string;
      activeAgentId: string;
      adapterId: string;
    }>;
    run: Readonly<{
      id: string;
      createdAt: string;
      effective: Readonly<{ agentId: string; adapterId: string }>;
    }>;
    session: Readonly<{
      agentId: string;
      adapterId: string;
      nativeSessionId?: string;
      launchId?: string;
      status: SchedulerRoleSession["status"];
    } | null>;
  }>;
  live: "present" | "absent";
  progressAt: string;
  idleMs: number;
  stalled: boolean;
  stallCandidate: boolean;
  evidence?: string;
  resourceActivity: boolean;
}>;

function classifyLeaderStall(
  store: SchedulerStorePort,
  taskId: string,
  observed: ReadonlyMap<string, ObservedRun>,
  now: Date,
  windowMs: number
): RoleTurnStallClassification {
  if (store.hasOpenInputRequest(taskId)) return "waiting-user";
  const downstream = [...observed.values()].filter((entry) => (
    entry.candidate.task.id === taskId && entry.candidate.role.name !== "leader"
  ));
  // A present downstream Turn keeps recovery Leader-owned. If that Turn is
  // itself stalled, this pass has just routed its structured attention to the
  // Leader; escalating the Leader to the Operator in the same pass would skip
  // the intended recovery owner.
  const downstreamPresent = downstream.some((entry) => entry.live === "present");
  const leader = [...observed.values()].find((entry) => (
    entry.candidate.task.id === taskId && entry.candidate.role.name === "leader"
  ));
  const mailbox = store.getWorkMailbox({ kind: "role", taskId, roleName: "leader" });
  const pending = mailbox === null || mailbox === undefined ? null : nextPendingBatch(mailbox);
  const processing = mailbox?.processing;
  const processingCurrent = processing?.executionRef?.type === "turn"
    && processing.executionRef.taskId === taskId
    && leader !== undefined
    && processing.executionRef.id === leader.candidate.run.id;
  const currentTurnId = leader?.candidate.run.id;
  if (processingCurrent && currentTurnId !== undefined && processing !== null) {
    const actionProgressAt = latestLeaderActionProgressAt(
      store,
      taskId,
      currentTurnId,
      processing.startedAt,
      processing.batch,
      now
    );
    const actionProgressMs = Date.parse(actionProgressAt);
    const actionStalled = Number.isFinite(actionProgressMs)
      && now.getTime() - actionProgressMs >= windowMs;
    if (actionStalled) return "truly-stalled";
    return downstreamPresent ? "waiting-on-workers" : "working";
  }
  const pendingStalled = pending !== null
    && pending !== undefined
    && Number.isFinite(Date.parse(pending.lastQueuedAt))
    && now.getTime() - Date.parse(pending.lastQueuedAt) >= windowMs;
  if (pendingStalled) return "truly-stalled";
  if (downstreamPresent) return "waiting-on-workers";
  return "truly-stalled";
}

const LEADER_ACTION_PROGRESS_TYPES = new Set([
  TURN_PROGRESS_EVENT,
  "input.answered",
  "input.auto-answered",
  "input.cancelled",
  "work.accepted",
  "work.updated",
  "work.retired",
  "review.completed",
  "review.failed",
  "integration.updated",
  "integration.completed",
  "integration.failed",
  "decision.recorded",
  "decision.superseded",
  "milestone.added"
]);

function latestLeaderActionProgressAt(
  store: SchedulerStorePort,
  taskId: string,
  turnId: string,
  startedAt: string,
  batch: Readonly<{
    refs: readonly Readonly<{ type: string; taskId?: string; id: string }>[];
    reasons: readonly string[];
  }>,
  now: Date
): string {
  const startedMs = Date.parse(startedAt);
  if (!Number.isFinite(startedMs)) return "";
  let latest = startedAt;
  let latestMs = startedMs;
  for (const event of store.listEvents?.(taskId) ?? []) {
    if (!LEADER_ACTION_PROGRESS_TYPES.has(event.type)) continue;
    if (event.payload.taskId !== undefined && event.payload.taskId !== taskId) continue;
    if (!leaderActionEventMatches(event, taskId, turnId, batch)) continue;
    const createdMs = Date.parse(event.createdAt);
    if (
      !Number.isFinite(createdMs)
      || createdMs < startedMs
      || createdMs > now.getTime()
    ) continue;
    const value = event.type === TURN_PROGRESS_EVENT
      && typeof event.payload.progressAt === "string"
      && Number.isFinite(Date.parse(event.payload.progressAt))
      ? event.payload.progressAt
      : event.createdAt;
    const valueMs = Date.parse(value);
    if (
      !Number.isFinite(valueMs)
      || valueMs < startedMs
      || valueMs > now.getTime()
      || valueMs <= latestMs
    ) continue;
    latest = value;
    latestMs = valueMs;
  }
  return latest;
}

function leaderActionEventMatches(
  event: TaskEvent,
  taskId: string,
  turnId: string,
  batch: Readonly<{
    refs: readonly Readonly<{ type: string; taskId?: string; id: string }>[];
    reasons: readonly string[];
  }>
): boolean {
  if (event.taskId !== taskId) return false;
  if (event.payload.leaderTurnId === turnId) return true;
  if (event.payload.turnId === turnId) return true;
  const refs = batch.refs ?? [];
  const refMatches = (type: string, payloadKey: string): boolean => {
    const id = event.payload[payloadKey];
    return typeof id === "string" && refs.some((ref) => (
      ref.type === type
      && ref.id === id
      && (ref.taskId === undefined || ref.taskId === taskId)
    ));
  };
  if (refMatches("turn", "turnId")) return true;
  if (refMatches("work-item", "workItemId")) return true;
  const reason = event.type.replaceAll(".", "-");
  // Mailbox reasons are opaque exact coalescing keys. A prefix or suffix
  // resemblance can belong to another action in the same Task and is not a
  // durable ownership fence.
  const reasonMatches = batch.reasons.some((candidate) => (
    candidate === reason
  ));
  return reasonMatches && refs.some((ref) => (
    ref.type === "task" && (ref.taskId === undefined || ref.taskId === taskId)
  ));
}

function leaderStallEvidence(
  store: SchedulerStorePort,
  taskId: string,
  observed: ReadonlyMap<string, ObservedRun>,
  now: Date,
  windowMs: number
): string {
  const downstream = [...observed.values()].filter((entry) => (
    entry.candidate.task.id === taskId && entry.candidate.role.name !== "leader"
  ));
  const active = downstream.filter((entry) => entry.candidate.run !== null).length;
  const healthy = downstream.filter((entry) => entry.live === "present" && !entry.stalled).length;
  const stalled = downstream.filter((entry) => entry.live === "present" && entry.stalled).length;
  const leaderMailbox = store.getWorkMailbox({ kind: "role", taskId, roleName: "leader" });
  const pending = leaderMailbox === null ? null : nextPendingBatch(leaderMailbox);
  const pendingAge = pending === undefined || pending === null
    ? "none"
    : Number.isFinite(Date.parse(pending.lastQueuedAt))
      && now.getTime() - Date.parse(pending.lastQueuedAt) >= windowMs
      ? "stale"
      : "recent";
  const processing = store.getWorkMailbox({ kind: "role", taskId, roleName: "leader" })?.processing;
  const leader = [...observed.values()].find((entry) => (
    entry.candidate.task.id === taskId && entry.candidate.role.name === "leader"
  ));
  const processingCurrent = processing?.executionRef?.type === "turn"
    && processing.executionRef.taskId === taskId
    && leader !== undefined
    && processing.executionRef.id === leader.candidate.run.id;
  const processingAge = processing === undefined || processing === null
    ? "none"
    : !processingCurrent
      ? "mismatched"
      : Number.isFinite(Date.parse(processing.startedAt))
        && now.getTime() - Date.parse(processing.startedAt) >= windowMs
        ? "stale"
        : "recent";
  return `downstream=active:${active},healthy:${healthy},stalled:${stalled}:leader-mailbox=${pendingAge},leader-processing=${processingAge}`;
}

function stallEvidenceKey(sessionStatus: string | undefined): string {
  return `live-pane-no-progress:session=${sessionStatus ?? "unknown"}`;
}

function exactLiveStatuses(
  statuses: readonly Readonly<{
    taskId: string;
    roleName: string;
    status: "present" | "absent";
  }>[],
  candidates: readonly Readonly<{
    task: Readonly<{ id: string }>;
    role: Readonly<{ name: string }>;
  }>[]
): Map<string, "present" | "absent"> {
  const expected = new Set(candidates.map(({ task, role }) => `${task.id}\0${role.name}`));
  const result = new Map<string, "present" | "absent">();
  for (const status of statuses) {
    const key = `${status.taskId}\0${status.roleName}`;
    if (!expected.has(key) || result.has(key)) {
      throw new Error("Tmux Role stall snapshot is invalid.");
    }
    result.set(key, status.status);
  }
  if (result.size !== expected.size) throw new Error("Tmux Role stall snapshot is incomplete.");
  return result;
}

function resourceForRun(
  snapshot: RoleTurnResourceEvidenceSnapshot | undefined,
  taskId: string,
  roleName: string,
  turnId: string
): RoleTurnResourceEvidence | undefined {
  if (snapshot === undefined) return undefined;
  return snapshot.get(`${taskId}\0${roleName}\0${turnId}`);
}

function resourceEvidenceMatchesCurrentRun(
  resource: RoleTurnResourceEvidence | undefined,
  expected: Readonly<{
    taskId: string;
    roleName: string;
    turnId: string;
    agentId: string;
    adapterId: string;
    nativeSessionId?: string;
    launchId?: string;
  }> | undefined,
  progressAt: string
): boolean {
  if (resource === undefined || expected === undefined) return false;
  const identity = resource.identity;
  if (
    identity === undefined
    || resource.progressAt !== progressAt
    || identity.taskId !== expected.taskId
    || identity.roleName !== expected.roleName
    || identity.turnId !== expected.turnId
    || identity.agentId !== expected.agentId
    || identity.adapterId !== expected.adapterId
    || identity.nativeSessionId !== expected.nativeSessionId
    || identity.launchId !== expected.launchId
  ) return false;
  return hasResourceIdentityText(identity.nativeSessionId)
    || hasResourceIdentityText(identity.launchId);
}

function hasResourceIdentityText(value: string | undefined): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function resourceEvidenceIsFresh(
  evidence: RoleTurnResourceEvidence | undefined,
  now: Date,
  windowMs: number,
  diagnosticAfterMs = DEFAULT_WORKFLOW_STALL_CANDIDATE_AGE_MS
): boolean {
  if (evidence === undefined) return false;
  const observedAt = Date.parse(evidence.observedAt);
  if (!Number.isFinite(observedAt)) return false;
  // A sample from an earlier scheduler window is not a current health signal.
  return observedAt <= now.getTime()
    && now.getTime() - observedAt < Math.max(windowMs, diagnosticAfterMs);
}
