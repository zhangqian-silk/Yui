import type { TaskEvent } from "../event/taskEvent.js";
import {
  selectedSchedulerRoles,
  selectedSchedulerTasks,
  type SchedulerReconcileSelection,
  type SchedulerStorePort,
  type TmuxDeliveryPort
} from "./ports.js";
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

export type RoleRunStallKind = "delivery-stalled" | "execution-stalled";
export type RoleRunStallClassification =
  | "working"
  | "waiting-user"
  | "waiting-on-workers"
  | "truly-stalled";

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
  let latest: { eventAt: string; progressAt: string } | undefined;
  for (const event of events) {
    if (event.type !== RUN_PROGRESS_EVENT || event.payload.runId !== runId) continue;
    const progressAt = typeof event.payload.progressAt === "string"
      && Number.isFinite(Date.parse(event.payload.progressAt))
      ? event.payload.progressAt
      : event.createdAt;
    if (
      latest === undefined
      || Date.parse(event.createdAt) > Date.parse(latest.eventAt)
    ) {
      latest = { eventAt: event.createdAt, progressAt };
    }
  }
  return latest?.progressAt;
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
  const recoveredAt = latestRunEventTime(events, RUN_RECOVERED_EVENT, runId);
  if (recoveredAt !== undefined && Date.parse(recoveredAt) > Date.parse(stalledAt)) {
    return false;
  }
  const progressEventAt = latestRunEventTime(events, RUN_PROGRESS_EVENT, runId);
  return progressEventAt === undefined || Date.parse(progressEventAt) <= Date.parse(stalledAt);
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
  liveStatuses?: RoleLiveStatusSnapshot
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
            session: store.getRoleSession(task.id, role.name)
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
      stallCandidate: false
    });
  }

  let statuses: Awaited<ReturnType<NonNullable<TmuxDeliveryPort["inspectRoles"]>>> | null = null;
  if (liveStatuses !== undefined) {
    statuses = null;
  } else if (delivery.inspectRoles !== undefined) {
    try {
      statuses = await delivery.inspectRoles(stallCandidates.map(({ task, role, session }) => ({
          taskId: task.id,
          roleName: role.name,
          agentId: role.activeAgentId,
          adapterId: role.adapterId,
          ...(session?.nativeSessionId === undefined
            ? {}
            : { nativeSessionId: session.nativeSessionId })
        })));
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
            agentId: candidate.role.activeAgentId,
            adapterId: candidate.role.adapterId,
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
        stallCandidate: true
      });
      continue;
    }

    const events = store.listEvents(candidate.task.id);
    let richerProgress: Readonly<{ progressAt: string; evidence?: string }> | null | undefined;
    try {
      richerProgress = store.getRunDurableProgress?.(
        candidate.task.id,
        candidate.role.name,
        candidate.run.id
      );
    } catch {
      // A related-record fold is advisory. The exact Run identity and
      // provider/session fence remain untouched if a read is unavailable.
      richerProgress = undefined;
    }
    const latestCheckpointAt = latestRunProgressAt(events, candidate.run.id);
    const fallbackProgressAt = candidate.run.deliveredAt === undefined
      ? undefined
      : latestDurableProgressAt({
          deliveredAt: candidate.run.deliveredAt,
          latestCheckpointAt,
          latestActivityAt: latestRunActivityAt(events, candidate.run.id)
        });
    // Before exact acceptance there is no execution progress clock. The Run
    // creation boundary is only the delivery-watch start; once accepted,
    // deliveredAt is the semantic baseline and bookkeeping timestamps stay
    // out of the fold.
    const progressAt = richerProgress?.progressAt
      ?? (candidate.run.deliveredAt === undefined
        ? latestCheckpointAt ?? latestRunActivityAt(events, candidate.run.id) ?? candidate.run.createdAt
        : fallbackProgressAt!);
    const evaluation = evaluateRoleRunStall({
      progressAt,
      now,
      windowMs,
      lastAttentionProgressAt: latestStallProgressAt(events, candidate.run.id)
    });
    observed.set(key, {
      candidate,
      live,
      progressAt,
      idleMs: evaluation.idleMs,
      stalled: evaluation.stalled,
      evidence: richerProgress?.evidence,
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
    }>;
    run: Readonly<{
      id: string;
      createdAt: string;
      deliveredAt?: string;
    }>;
    session: Readonly<{ status: string } | null>;
  }>;
  live: "present" | "absent";
  progressAt: string;
  idleMs: number;
  stalled: boolean;
  stallCandidate: boolean;
  evidence?: string;
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
  const healthyDownstream = downstream.some((entry) => (
    entry.live === "present" && !entry.stalled
  ));
  const mailbox = store.getWorkMailbox({ kind: "role", taskId, roleName: "leader" });
  const pending = mailbox?.pending;
  const pendingStalled = pending !== null
    && pending !== undefined
    && Number.isFinite(Date.parse(pending.lastQueuedAt))
    && now.getTime() - Date.parse(pending.lastQueuedAt) >= windowMs;
  if (healthyDownstream && !pendingStalled) return "waiting-on-workers";
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
  return `downstream=active:${active},healthy:${healthy},stalled:${stalled}:leader-mailbox=${pendingAge}`;
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
