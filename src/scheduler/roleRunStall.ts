import type { TaskEvent } from "../event/taskEvent.js";
import {
  selectedSchedulerRoles,
  selectedSchedulerTasks,
  type SchedulerReconcileSelection,
  type SchedulerRoleSession,
  type SchedulerRoleResourceEvidence,
  type SchedulerStorePort,
  type TmuxDeliveryPort
} from "./ports.js";
import type { OperatorNotification } from "./operatorNotification.js";
import type { RoleLiveStatusSnapshot } from "./roleRunLiveness.js";

/**
 * Default window of no durable progress before a live-but-idle Run becomes a
 * traceable needs-attention signal. It is deliberately long: a healthy Run that
 * is simply slow keeps its structured checkpoint fresh and never crosses it.
 */
export const DEFAULT_STALL_WINDOW_MS = 30 * 60_000;
/** Cheap execution-stall candidate filter; the real threshold remains 30m. */
export const DEFAULT_EXECUTION_STALL_CANDIDATE_AGE_MS = 10 * 60_000;

export const RUN_PROGRESS_EVENT = "run.progress";
export const RUN_STALLED_EVENT = "run.stalled";
export const RUN_RECOVERED_EVENT = "run.recovered";
/** Durable one-shot advisory resource evidence; never a progress fact. */
export const RUN_RESOURCE_SUPPRESSED_EVENT = "run.resource-suppressed";
/** Structured, non-Message recovery evidence written by an explicit Leader. */
export const RUN_RECOVERY_REQUESTED_EVENT = "run.recovery-requested";
export const RUN_RECOVERY_APPLIED_EVENT = "run.recovery-applied";

/** The smallest storage boundary needed to clear a resolved Leader stall. */
export type LeaderStallAttentionStore = Readonly<{
  getOperatorNotification(taskId: string): OperatorNotification | null;
  clearOperatorNotification(taskId: string): void;
}>;

/**
 * Clear only the Operator projection raised for this exact Leader Run. A
 * later Run (or a recovery notification of another kind) must remain intact;
 * callers use this helper from every supported recovery/terminalization path
 * so attention cleanup cannot drift between CLI and runtime code.
 */
export function clearMatchingLeaderStallAttention(
  store: LeaderStallAttentionStore,
  taskId: string,
  runId: string
): boolean {
  const notification = store.getOperatorNotification(taskId);
  if (notification?.type !== "leader-stalled" || notification.runId !== runId) {
    return false;
  }
  store.clearOperatorNotification(taskId);
  return true;
}

export type RoleRunStallKind = "delivery-stalled" | "execution-stalled";
export type RoleRunStallClassification =
  | "working"
  | "waiting-user"
  | "waiting-on-workers"
  | "truly-stalled";

/** Provider acceptance is deliberately separate from transport and pane state. */
export type RoleRunProviderAcceptance = "accepted" | "rejected" | "ambiguous";

/** Optional advisory process sample carried by one scheduler inventory pass. */
export type RoleRunResourceEvidence = SchedulerRoleResourceEvidence;

export type RoleRunResourceEvidenceSnapshot = ReadonlyMap<
  string,
  RoleRunResourceEvidence
>;

export type RoleRunHealthProjection = Readonly<{
  candidate: boolean;
  stalled: boolean;
  classification: RoleRunStallClassification;
  providerAcceptance: RoleRunProviderAcceptance;
  hostLiveness: "present" | "absent" | "unknown";
  nativeSession: "matching" | "missing" | "stopped" | "broken" | "unknown";
  resourceActivity: boolean;
  progressAt: string;
  idleMs: number;
}>;

/**
 * One pure projection used by every Role. Resource activity can suppress a
 * false positive only together with a live host and matching native Session
 * or launch generation;
 * it never changes the durable progress clock or authorizes recovery.
 */
export function projectRoleRunHealth(input: Readonly<{
  progressAt: string;
  createdAt: string;
  deliveredAt?: string;
  now: Date;
  windowMs?: number;
  hostLiveness: "present" | "absent" | "unknown";
  nativeSession?: Readonly<{
    status: string;
    nativeSessionId?: string;
    launchId?: string;
  }> | null;
  providerAcceptance?: RoleRunProviderAcceptance;
  resource?: RoleRunResourceEvidence;
  roleName?: string;
  waitingUser?: boolean;
  waitingOnWorkers?: boolean;
  staleLeaderMailbox?: boolean;
}>): RoleRunHealthProjection {
  const windowMs = input.windowMs ?? DEFAULT_STALL_WINDOW_MS;
  if (!Number.isFinite(windowMs) || windowMs <= 0) {
    throw new Error("Role run stall window must be a positive number of milliseconds.");
  }
  const evaluation = evaluateRoleRunStall({
    progressAt: input.progressAt,
    now: input.now,
    windowMs
  });
  const idleMs = evaluation.idleMs;
  const candidateStart = input.deliveredAt ?? input.createdAt;
  const candidateAge = input.now.getTime() - Date.parse(candidateStart);
  const candidate = Number.isFinite(candidateAge)
    && (input.deliveredAt === undefined
      ? candidateAge >= windowMs
      : candidateAge >= DEFAULT_EXECUTION_STALL_CANDIDATE_AGE_MS);
  const providerAcceptance = input.providerAcceptance
    ?? (input.deliveredAt === undefined ? "ambiguous" : "accepted");
  const hostLiveness = input.hostLiveness;
  const session = input.nativeSession;
  const nativeSession = session === null || session === undefined
    ? "missing"
    : session.status === "stopped"
      ? "stopped"
      : session.status === "broken"
        ? "broken"
        : session.status !== "ready" && session.status !== "running"
          ? "unknown"
          : !hasResourceIdentityText(session.nativeSessionId)
            && !hasResourceIdentityText(session.launchId)
            ? "unknown"
            : "matching";
  const resourceActivity = hostLiveness === "present"
    && nativeSession === "matching"
    && resourceEvidenceIsFresh(input.resource, input.now, windowMs)
    // Residency/RSS and an unchanged cumulative counter are not progress.
    && input.resource?.active === true
    && input.resource?.changed === true;
  const waitingUser = input.waitingUser === true;
  const waitingOnWorkers = input.waitingOnWorkers === true && !input.staleLeaderMailbox;
  // A TmuxSessionHost binding may intentionally be opaque and therefore have
  // no persisted nativeSessionId.  With a present host, durable no-progress
  // evidence is still actionable in that case.  Only an explicit stopped or
  // broken Session blocks the projection; identity mismatches are fenced by
  // reconcileStalledRoleRuns below before this projection is routed.
  const executionStall = candidate
    && evaluation.stalled
    && hostLiveness === "present"
    && nativeSession !== "stopped"
    && nativeSession !== "broken"
    && providerAcceptance !== "ambiguous"
    && !resourceActivity;
  const stalled = executionStall
    && !waitingUser
    && !waitingOnWorkers;
  const classification: RoleRunStallClassification = waitingUser
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

export type RoleRunStallEvaluation = Readonly<{
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
 * Run is stalled and whether this is new evidence worth surfacing again.
 */
export function evaluateRoleRunStall(input: Readonly<{
  progressAt: string;
  now: Date;
  windowMs?: number;
  lastAttentionProgressAt?: string;
}>): RoleRunStallEvaluation {
  const windowMs = input.windowMs ?? DEFAULT_STALL_WINDOW_MS;
  if (!Number.isFinite(windowMs) || windowMs <= 0) {
    throw new Error("Role run stall window must be a positive number of milliseconds.");
  }
  const progressMs = Date.parse(input.progressAt);
  if (!Number.isFinite(progressMs)) {
    throw new Error("Role run stall progress timestamp is invalid.");
  }
  const idleMs = input.now.getTime() - progressMs;
  const stalled = idleMs >= windowMs;
  const isNewEpisode = stalled && input.lastAttentionProgressAt !== input.progressAt;
  return { stalled, isNewEpisode, idleMs, progressAt: input.progressAt };
}

/**
 * Latest durable progress timestamp for an active Run. Provider acceptance
 * (deliveredAt), explicit structured checkpoints, and semantic Run-scoped
 * activity all count as progress; bookkeeping-only Run/Session timestamps are
 * intentionally excluded. CPU/memory are never inputs here.
 */
export function latestDurableProgressAt(input: Readonly<{
  deliveredAt?: string;
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
    input.deliveredAt,
    input.latestCheckpointAt,
    input.latestActivityAt
  ].filter((value): value is string => (
    typeof value === "string" && Number.isFinite(Date.parse(value))
  ));
  if (candidates.length === 0) {
    throw new Error("No durable progress timestamp is available for the Run.");
  }
  return candidates.reduce((latest, value) => (
    Date.parse(value) > Date.parse(latest) ? value : latest
  ));
}

/** Most recent semantic timestamp carried by a Run progress event. */
export function latestRunProgressAt(
  events: readonly TaskEvent[],
  runId: string
): string | undefined {
  let latest: string | undefined;
  for (const event of events) {
    if (
      event.type !== RUN_PROGRESS_EVENT
      && event.type !== "runtime.provider-turn-progress"
    ) continue;
    if (event.payload.runId !== runId) continue;
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
 * stall consumption for one active Run. The richer adapter fold remains
 * authoritative when available; the retained Run progress/activity events are
 * the provider-neutral fallback. Resource evidence carries this value as an
 * exact fence, but never advances it.
 */
export function currentRoleRunProgressAt(
  store: Readonly<{
    listEvents?: (taskId: string) => readonly TaskEvent[];
    getRunDurableProgress?: SchedulerStorePort["getRunDurableProgress"];
  }>,
  taskId: string,
  roleName: string,
  run: Readonly<{ id: string; createdAt: string; deliveredAt?: string }>,
  events: readonly TaskEvent[] = store.listEvents?.(taskId) ?? []
): Readonly<{ progressAt: string; evidence?: string }> {
  let richerProgress: Readonly<{ progressAt: string; evidence?: string }> | null | undefined;
  try {
    richerProgress = store.getRunDurableProgress?.(taskId, roleName, run.id);
  } catch {
    // A related-record fold is advisory. The retained Run/Event fence remains
    // usable when that optional read is unavailable.
    richerProgress = undefined;
  }
  if (run.deliveredAt === undefined) return { progressAt: run.createdAt };
  const fallbackProgressAt = latestDurableProgressAt({
    deliveredAt: run.deliveredAt,
    latestCheckpointAt: latestRunProgressAt(events, run.id),
    latestActivityAt: latestRunActivityAt(events, run.id)
  });
  return {
    progressAt: richerProgress?.progressAt ?? fallbackProgressAt,
    ...(richerProgress?.evidence === undefined
      ? {}
      : { evidence: richerProgress.evidence })
  };
}

/**
 * Computes the current semantic progress fence for an exact Run. The optional
 * related-record readers mirror the adapter's Work/Review/Integration fold;
 * narrow scheduler ports can omit them and still retain Run/Event evidence.
 */
export function latestRunDurableProgressAt(
  store: Readonly<{
    getAgentRun(taskId: string, runId: string): Readonly<{
      id: string;
      taskId: string;
      roleName: string;
      createdAt: string;
      deliveredAt?: string;
      workItemId?: string;
    }> | null;
    listEvents(taskId: string): readonly TaskEvent[];
    getWorkItem?(taskId: string, workItemId: string): Readonly<{
      updatedAt: string;
      candidates?: readonly Readonly<{ createdAt: string }>[];
    }> | null;
    listReviewRounds?(taskId: string): readonly Readonly<{
      workItemId: string;
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
      requester: Readonly<{ runId?: string }>;
      blockedRefs: readonly Readonly<{ type: string; id: string }>[];
    }>[];
  }>,
  taskId: string,
  roleName: string,
  runId: string
): Readonly<{ progressAt: string; evidence?: string }> | null {
  const run = store.getAgentRun(taskId, runId);
  if (run === null || run.taskId !== taskId || run.roleName !== roleName) return null;
  const events = store.listEvents(taskId);
  const latestCheckpointAt = latestRunProgressAt(events, run.id);
  const latestActivityAt = latestRunActivityAt(events, run.id);
  const baseline = run.deliveredAt === undefined
    ? run.createdAt
    : latestDurableProgressAt({
        deliveredAt: run.deliveredAt,
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
      request.requester.runId === run.id
      || request.blockedRefs.some((ref) => ref.type === "run" && ref.id === run.id)
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
  // Before provider acceptance the Run clock remains anchored to creation,
  // while related records are retained as diagnostic evidence only.
  return run.deliveredAt !== undefined
    && latestRelatedAt !== undefined
    && Date.parse(latestRelatedAt) > Date.parse(baseline)
    ? { progressAt: latestRelatedAt, evidence: "work-review-integration" }
    : {
        progressAt: baseline,
        ...(latestRelatedAt === undefined ? {} : { evidence: "work-review-integration" })
      };
}

/** Most recent createdAt of a Run-scoped event of one type, if any. */
export function latestRunEventTime(
  events: readonly TaskEvent[],
  type: string,
  runId: string
): string | undefined {
  let latest: string | undefined;
  for (const event of events) {
    if (event.type !== type || event.payload.runId !== runId) continue;
    if (latest === undefined || Date.parse(event.createdAt) > Date.parse(latest)) {
      latest = event.createdAt;
    }
  }
  return latest;
}

/** Most recent non-control event carrying a Run identity. */
export function latestRunActivityAt(
  events: readonly TaskEvent[],
  runId: string
): string | undefined {
  const semanticTypes = new Set([
    RUN_PROGRESS_EVENT,
    "runtime.provider-turn-progress",
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
  let latest: string | undefined;
  for (const event of events) {
    if (
      !semanticTypes.has(event.type)
      || event.payload.runId !== runId
      || event.type === RUN_STALLED_EVENT
      || event.type === RUN_RECOVERED_EVENT
    ) continue;
    const activityAt = event.type === RUN_PROGRESS_EVENT
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

/** The progress point recorded by the most recent stall attention for a Run. */
export function latestStallProgressAt(
  events: readonly TaskEvent[],
  runId: string
): string | undefined {
  let latest: TaskEvent | undefined;
  for (const event of events) {
    if (event.type !== RUN_STALLED_EVENT || event.payload.runId !== runId) continue;
    if (latest === undefined || Date.parse(event.createdAt) > Date.parse(latest.createdAt)) {
      latest = event;
    }
  }
  return latest?.payload.progressAt;
}

/** Latest stall episode identity used for source-idempotent attention. */
export function latestStallEvidenceKey(
  events: readonly TaskEvent[],
  runId: string
): Readonly<{ progressAt: string; evidenceKey: string }> | undefined {
  let latest: TaskEvent | undefined;
  for (const event of events) {
    if (event.type !== RUN_STALLED_EVENT || event.payload.runId !== runId) continue;
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

/**
 * True while a Run remains in an unresolved stall episode: a stall was raised
 * and no later checkpoint has advanced its durable progress since. This is the
 * projection the runtime-health view reads to surface needs-attention.
 */
export function isRoleRunStalled(
  events: readonly TaskEvent[],
  runId: string
): boolean {
  const stalledAt = latestRunEventTime(events, RUN_STALLED_EVENT, runId);
  if (stalledAt === undefined) return false;
  const stalled = [...events]
    .filter((event) => event.type === RUN_STALLED_EVENT && event.payload.runId === runId)
    .sort((left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt))[0];
  const stalledProgressAt = typeof stalled?.payload.progressAt === "string"
    && Number.isFinite(Date.parse(stalled.payload.progressAt))
    ? stalled.payload.progressAt
    : stalledAt;
  const recoveredAt = latestRunEventTime(events, RUN_RECOVERED_EVENT, runId);
  if (recoveredAt !== undefined && Date.parse(recoveredAt) > Date.parse(stalledAt)) {
    return false;
  }
  const progressAt = latestRunProgressAt(events, runId);
  return progressAt === undefined || Date.parse(progressAt) <= Date.parse(stalledProgressAt);
}

export type RoleRunStallResult = Readonly<{
  taskId: string;
  roleName: string;
  runId: string;
  status: "raised" | "already-raised";
  kind: RoleRunStallKind;
  classification: "truly-stalled";
  idleMs: number;
}>;

/**
 * Low-frequency health pass for active Task Role Runs. An unaccepted Run is
 * watched as delivery-stalled after the reasonable delivery window; an
 * accepted Run enters the execution-stall candidate scan after ten minutes,
 * while the actual no-progress threshold remains thirty minutes.
 * Leader Runs are only persisted when classification reaches truly-stalled —
 * healthy downstream work, open user input, and recent own progress remain
 * structured waiting/working facts. No branch sends terminal bytes, retries,
 * replaces a Session, or changes Run status.
 */
export async function reconcileStalledRoleRuns(
  store: SchedulerStorePort,
  delivery: Pick<TmuxDeliveryPort, "inspectRole" | "inspectRoles">,
  now: Date,
  selection?: SchedulerReconcileSelection,
  windowMs = DEFAULT_STALL_WINDOW_MS,
  liveStatuses?: RoleLiveStatusSnapshot,
  resourceEvidence?: RoleRunResourceEvidenceSnapshot,
  resourceSuppressionKeys?: Set<string>
): Promise<RoleRunStallResult[]> {
  // Dirty mailbox passes are intentionally not a second scheduler. Full
  // reconcile owns the all-active-Run scan; dirty passes may still route the
  // existing mailbox work without manufacturing another episode.
  if (selection !== undefined && !selection.full) return [];
  if (store.listEvents === undefined || store.recordRoleRunStall === undefined) return [];
  const candidates = selectedSchedulerTasks(store, selection).flatMap((task) => (
    task.status !== "active"
      ? []
      : selectedSchedulerRoles(store, task.id, selection).flatMap((role) => {
          const run = store.getActiveAgentRun(task.id, role.name);
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
  const stallCandidates = candidates.filter(({ run }) => isStallCandidate(run, now, windowMs));
  if (stallCandidates.length === 0) return [];
  const stallCandidateKeys = new Set(stallCandidates.map(({ task, role }) => (
    `${task.id}\0${role.name}`
  )));
  const observed = new Map<string, ObservedRun>();
  // Recent active Runs are known healthy enough for Leader classification from
  // their exact acceptance/creation boundary, but are deliberately not read
  // from tmux or Event history until the 10-minute execution candidate window.
  for (const candidate of candidates) {
    const key = `${candidate.task.id}\0${candidate.role.name}`;
    if (stallCandidateKeys.has(key)) continue;
    observed.set(key, {
      candidate,
      live: liveStatuses?.get(key) ?? "present",
      progressAt: candidate.run.deliveredAt ?? candidate.run.createdAt,
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
          runId: run.id,
          progressAt: run.deliveredAt ?? run.createdAt,
          agentId: session?.agentId ?? run.effective.agentId,
          adapterId: session?.adapterId ?? run.effective.adapterId,
          ...(session?.launchId === undefined ? {} : { launchId: session.launchId }),
          ...(session?.nativeSessionId === undefined
              ? {}
              : { nativeSessionId: session.nativeSessionId })
        })), stallCandidates.flatMap(({ task, role, run, session }) => (
          run.deliveredAt === undefined
            ? []
            : [{
                taskId: task.id,
                roleName: role.name,
                runId: run.id,
                progressAt: currentRoleRunProgressAt(
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
              }]
        )));
    } catch {
      // Health inspection is advisory. Unknown host state must leave the exact
      // Run/Session fence untouched and let the next full pass retry.
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
      return [];
    }
  }
  const raised: RoleRunStallResult[] = [];
  for (const candidate of stallCandidates) {
    const key = `${candidate.task.id}\0${candidate.role.name}`;
    let live: "present" | "absent";
    try {
      if (liveStatuses !== undefined && !liveStatuses.has(key)) return [];
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
      // Without a complete live snapshot, especially for downstream Runs,
      // Leader classification would be unsafe. Treat the whole advisory pass
      // as unknown instead of escalating a false stall.
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

    const events = store.listEvents(candidate.task.id);
    // Before exact acceptance there is no execution progress clock. Keep the
    // delivery watch anchored to the Run creation/transport boundary even if
    // checkpoints, output, or related WorkItem/Review/Integration records are
    // newer; those facts are useful evidence but cannot prove provider
    // acceptance or reset delivery timeout. Once accepted, deliveredAt is the
    // semantic baseline and the durable fold may advance it.
    const progress = currentRoleRunProgressAt(
      store,
      candidate.task.id,
      candidate.role.name,
      candidate.run,
      events
    );
    const progressAt = progress.progressAt;
    const evaluation = evaluateRoleRunStall({
      progressAt,
      now,
      windowMs,
      lastAttentionProgressAt: latestStallProgressAt(events, candidate.run.id)
    });
    const runAgentId = candidate.run.effective.agentId;
    const runAdapterId = candidate.run.effective.adapterId;
    const sessionMatchesRun = candidate.session === null
      || (
        candidate.session.agentId === runAgentId
        && candidate.session.adapterId === runAdapterId
      );
    const sessionUsable = candidate.session === null
      || (candidate.session.status !== "stopped" && candidate.session.status !== "broken");
    const expectedResourceIdentity = candidate.session === null
      ? undefined
      : {
          taskId: candidate.task.id,
          roleName: candidate.role.name,
          runId: candidate.run.id,
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
    const resourceCanSuppress = live === "present"
      && sessionMatchesRun
      && sessionUsable
      && expectedResourceIdentity !== undefined
      && resourceEvidenceMatchesCurrentRun(
        resourceSnapshot,
        expectedResourceIdentity,
        progressAt
      )
      && resourceEvidenceIsFresh(resourceSnapshot, now, windowMs);
    const resource = resourceCanSuppress
      ? await consumeResourceEvidence(
          store,
          resourceEvidence,
          candidate.task.id,
          candidate.role.name,
          candidate.run.id,
          progressAt,
          expectedResourceIdentity!,
          resourceSuppressionKeys,
          now
        )
      : undefined;
    const health = projectRoleRunHealth({
      progressAt,
      createdAt: candidate.run.createdAt,
      ...(candidate.run.deliveredAt === undefined
        ? {}
        : { deliveredAt: candidate.run.deliveredAt }),
      now,
      windowMs,
      hostLiveness: live,
      nativeSession: candidate.session,
      providerAcceptance: candidate.run.deliveredAt === undefined
        ? "ambiguous"
        : "accepted",
      resource,
      roleName: candidate.role.name
    });
    // Delivery-stalled Runs retain the existing delivery clock and immediate
    // provider-uncertainty path. Accepted execution Runs use the shared
    // projection, including its exact Session/host and advisory resource
    // conditions.
    const resourceActivity = health.resourceActivity;
    const stalled = candidate.run.deliveredAt === undefined
      ? evaluation.stalled && live === "present"
      : health.stalled && sessionMatchesRun && sessionUsable;
    observed.set(key, {
      candidate,
      live,
      progressAt,
      idleMs: evaluation.idleMs,
      // Resource activity is advisory: with a live, matching native Session it
      // keeps a long inference/remote-IO Run in the working projection, but it
      // never advances progress or creates a recovered event by itself.
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
    const events = store.listEvents(candidate.task.id);
    const previous = latestStallEvidenceKey(events, candidate.run.id);
    if (
      previous !== undefined
      && Date.parse(progressAt) > Date.parse(previous.progressAt)
    ) {
      // A new semantic progress point closes the previous episode first. It
      // may itself already be older than the window, in which case the same
      // pass records the next Run+progressAt episode below.
      store.recordRoleRunProgress?.({
        taskId: candidate.task.id,
        roleName: candidate.role.name,
        runId: candidate.run.id,
        progressAt,
        ...(current.evidence === undefined ? {} : { evidence: current.evidence }),
        now
      });
    }
    const kind: RoleRunStallKind = candidate.run.deliveredAt === undefined
      ? "delivery-stalled"
      : "execution-stalled";
    const classification = candidate.role.name === "leader"
      ? classifyLeaderStall(store, candidate.task.id, observed, now, windowMs)
      : "truly-stalled";
    // A Leader waiting on the user or healthy downstream work is not a stall
    // episode. Its durable InputRequest/worker facts remain the evidence.
    if (classification !== "truly-stalled") continue;
    const evidenceKey = [
      kind,
      stallEvidenceKey(candidate.role.status, candidate.session?.status),
      classification,
      ...(candidate.role.name === "leader"
        ? [leaderStallEvidence(store, candidate.task.id, observed, now, windowMs)]
        : []),
      ...(current.evidence === undefined ? [] : [current.evidence])
    ].join(":");
    // The final contract is one episode per Run + semantic progress point.
    // New role/session/provider evidence is retained in the Leader's next
    // diagnostic context, not duplicated as another Task-level alert.
    if (previous?.progressAt === progressAt) continue;
    const persisted = store.recordRoleRunStall({
      taskId: candidate.task.id,
      roleName: candidate.role.name,
      runId: candidate.run.id,
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
        runId: candidate.run.id,
        status: persisted,
        kind,
        classification,
        idleMs: current.idleMs
      });
    }
  }

  // A related WorkItem/Review/Integration fold may advance progress without
  // carrying the Run id. Materialize it once so context/web can clear the
  // attention projection and the event history records the recovery boundary.
  for (const current of observed.values()) {
    if (current.live !== "present" || current.stalled || !current.stallCandidate) continue;
    const { candidate, progressAt } = current;
    const events = store.listEvents(candidate.task.id);
    const previous = latestStallEvidenceKey(events, candidate.run.id);
    if (
      previous !== undefined
      && Date.parse(progressAt) > Date.parse(previous.progressAt)
    ) {
      store.recordRoleRunProgress?.({
        taskId: candidate.task.id,
        roleName: candidate.role.name,
        runId: candidate.run.id,
        progressAt,
        ...(current.evidence === undefined ? {} : { evidence: current.evidence }),
        now
      });
    }
  }
  return raised;
}

function isStallCandidate(
  run: Readonly<{ createdAt: string; deliveredAt?: string }>,
  now: Date,
  windowMs: number
): boolean {
  const startAt = run.deliveredAt ?? run.createdAt;
  const ageMs = now.getTime() - Date.parse(startAt);
  if (!Number.isFinite(ageMs)) return false;
  // Undelivered Runs are watched for a delivery stall on the same reasonable
  // window, but they never enter execution-stall candidate filtering.
  return run.deliveredAt === undefined
    ? ageMs >= windowMs
    : ageMs >= DEFAULT_EXECUTION_STALL_CANDIDATE_AGE_MS;
}

type ObservedRun = Readonly<{
  candidate: Readonly<{
    task: Readonly<{ id: string }>;
    role: Readonly<{
      name: string;
      status: string;
      activeAgentId: string;
      adapterId: string;
    }>;
    run: Readonly<{
      id: string;
      createdAt: string;
      deliveredAt?: string;
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
): RoleRunStallClassification {
  if (store.hasOpenInputRequest(taskId)) return "waiting-user";
  const downstream = [...observed.values()].filter((entry) => (
    entry.candidate.task.id === taskId && entry.candidate.role.name !== "leader"
  ));
  // A present downstream Run keeps recovery Leader-owned. If that Run is
  // itself stalled, this pass has just routed its structured attention to the
  // Leader; escalating the Leader to the Operator in the same pass would skip
  // the intended recovery owner.
  const downstreamPresent = downstream.some((entry) => entry.live === "present");
  const leader = [...observed.values()].find((entry) => (
    entry.candidate.task.id === taskId && entry.candidate.role.name === "leader"
  ));
  const mailbox = store.getWorkMailbox({ kind: "role", taskId, roleName: "leader" });
  const pending = mailbox?.pending;
  const pendingStalled = pending !== null
    && pending !== undefined
    && Number.isFinite(Date.parse(pending.lastQueuedAt))
    && now.getTime() - Date.parse(pending.lastQueuedAt) >= windowMs;
  const processing = mailbox?.processing;
  const processingCurrent = processing?.executionRef?.type === "run"
    && processing.executionRef.taskId === taskId
    && leader !== undefined
    && processing.executionRef.id === leader.candidate.run.id;
  const processingStartedAt = processing === undefined || processing === null
    ? NaN
    : Date.parse(processing.startedAt);
  const leaderProgressAt = leader === undefined ? NaN : Date.parse(leader.progressAt);
  const processingStalled = processingCurrent
    && Number.isFinite(processingStartedAt)
    && now.getTime() - processingStartedAt >= windowMs
    && Number.isFinite(leaderProgressAt)
    && leaderProgressAt <= processingStartedAt;
  if (processingStalled || pendingStalled) return "truly-stalled";
  if (downstreamPresent) return "waiting-on-workers";
  return "truly-stalled";
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
  const pending = store.getWorkMailbox({ kind: "role", taskId, roleName: "leader" })?.pending;
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
  const processingCurrent = processing?.executionRef?.type === "run"
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

function stallEvidenceKey(roleStatus: string, sessionStatus: string | undefined): string {
  return `live-pane-no-progress:role=${roleStatus}:session=${sessionStatus ?? "unknown"}`;
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
  snapshot: RoleRunResourceEvidenceSnapshot | undefined,
  taskId: string,
  roleName: string,
  runId: string
): RoleRunResourceEvidence | undefined {
  if (snapshot === undefined) return undefined;
  return snapshot.get(`${taskId}\0${roleName}\0${runId}`);
}

function resourceEvidenceMatchesCurrentRun(
  resource: RoleRunResourceEvidence | undefined,
  expected: Readonly<{
    taskId: string;
    roleName: string;
    runId: string;
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
    || identity.runId !== expected.runId
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

/** Consume at most one advisory sample for one Run/progress point. */
async function consumeResourceEvidence(
  store: SchedulerStorePort,
  snapshot: RoleRunResourceEvidenceSnapshot | undefined,
  taskId: string,
  roleName: string,
  runId: string,
  progressAt: string,
  expectedIdentity: Readonly<{
    taskId: string;
    roleName: string;
    runId: string;
    agentId: string;
    adapterId: string;
    nativeSessionId?: string;
    launchId?: string;
  }>,
  suppressionKeys: Set<string> | undefined,
  now: Date
): Promise<RoleRunResourceEvidence | undefined> {
  const resource = resourceForRun(snapshot, taskId, roleName, runId);
  if (resource === undefined) return undefined;
  if (!resourceEvidenceMatchesCurrentRun(resource, expectedIdentity, progressAt)) {
    return resource;
  }
  if (resource.active !== true || resource.changed !== true) return resource;
  const key = `${taskId}\0${roleName}\0${runId}\0${progressAt}`;
  if (store.recordRoleRunResourceSuppression !== undefined) {
    const persisted = store.recordRoleRunResourceSuppression({
      taskId,
      roleName,
      runId,
      agentId: expectedIdentity.agentId,
      adapterId: expectedIdentity.adapterId,
      ...(expectedIdentity.nativeSessionId === undefined
        ? {}
        : { nativeSessionId: expectedIdentity.nativeSessionId }),
      ...(expectedIdentity.launchId === undefined
        ? {}
        : { launchId: expectedIdentity.launchId }),
      progressAt,
      observedAt: resource.observedAt,
      now
    });
    if (persisted === "recorded") return resource;
    if (persisted === "already-recorded") {
      return { ...resource, active: false, changed: false };
    }
    // A concurrent Run/session change invalidates this sample. Do not let the
    // stale changed bit suppress the current Run's attention episode.
    return { ...resource, active: false, changed: false };
  }
  if (suppressionKeys === undefined || !suppressionKeys.has(key)) {
    suppressionKeys?.add(key);
    return resource;
  }
  return { ...resource, active: false, changed: false };
}

function resourceEvidenceIsFresh(
  evidence: RoleRunResourceEvidence | undefined,
  now: Date,
  windowMs: number
): boolean {
  if (evidence === undefined) return false;
  const observedAt = Date.parse(evidence.observedAt);
  if (!Number.isFinite(observedAt)) return false;
  // A sample from an earlier scheduler window is not a current health signal.
  return observedAt <= now.getTime()
    && now.getTime() - observedAt < Math.max(windowMs, DEFAULT_EXECUTION_STALL_CANDIDATE_AGE_MS);
}
