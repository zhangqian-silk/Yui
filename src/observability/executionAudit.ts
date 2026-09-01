/**
 * Read-only execution audit aggregator (Issue 11 §3).
 *
 * The audit answers "what happened in this Home" from durable records alone:
 * Turns/failures/durations, wake reasons, Session generations, Review execution
 * vs semantic failures, Integration failure classes and gate reuse, telemetry
 * volume, and the longest/stale executions. It never writes Task state, never
 * wakes a Leader, and never takes the storage write lock — it only calls the
 * store's read methods. A section that cannot be read degrades to an error
 * entry while the rest of the report stays usable (Issue 11 minimal failure
 * semantics).
 */
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";

import { openCurrentTaskStore } from "../storage/currentTaskStore.js";
import { resolveTaskStoreBackendForHome } from "../storage/sqliteStore.js";
import type { TaskStore } from "../storage/taskStore.js";
import type { Turn } from "../turn/turn.js";
import type { TaskRoleSessionSet } from "../executor/agentExecutor.js";
import { runtimeObservationFromTaskEvent } from "../runtime/runtimeObservation.js";
import {
  classifyTurnFailure,
  classifyIntegrationAttempt,
  classifyReviewRound,
  countFaultClasses,
  type FaultClassCounts
} from "./faultClassification.js";
import {
  RUNTIME_LAUNCH_KINDS,
  RUNTIME_LAUNCH_PHASES,
  type RuntimeLaunchKind,
  type RuntimeLaunchPhase
} from "../runtime/launchDiagnostics.js";
import { UNSUPPORTED, type OptionalFact, type Unsupported } from "./runtimeIdentity.js";
import {
  projectTaskOrchestration,
  type TaskOrchestrationMetrics
} from "./orchestrationMetrics.js";

export type ExecutionAuditOptions = Readonly<{
  taskId?: string;
  since?: Date;
  until?: Date;
}>;

export type AuditSectionStatus = "ok" | "error" | "unsupported";

export type AuditSection<T> = Readonly<{
  status: AuditSectionStatus;
  data?: T;
  error?: string;
}>;

export type TurnsAudit = Readonly<{
  total: number;
  active: number;
  completed: number;
  failed: number;
  failureRate: number;
  cumulativeDurationMs: number;
  failedDurationMs: number;
  byRole: Readonly<{ leader: number; reviewer: number; implementer: number; other: number }>;
  byPurpose: Readonly<{ execution: number; review: number }>;
  faultClasses: FaultClassCounts;
  launchFailures: LaunchFailureCounts;
}>;

export type LaunchFailureCounts = Readonly<{
  total: number;
  byPhase: Readonly<Record<RuntimeLaunchPhase, number>>;
  byKind: Readonly<Record<RuntimeLaunchKind, number>>;
}>;

type MutableLaunchFailureCounts = {
  total: number;
  byPhase: Record<RuntimeLaunchPhase, number>;
  byKind: Record<RuntimeLaunchKind, number>;
};

export type WakesAudit = Readonly<{
  leaderTurns: number;
  withWakeReasons: number;
  byReason: Readonly<Record<string, number>>;
  /** Wakes suppressed by scheduler single-flight (lifecycle lane busy). */
  suppressedWakes: AuditSection<number>;
}>;

export type SessionsAudit = Readonly<{
  generations: number;
  broken: number;
  stopped: number;
  other: number;
  resets: number;
  conversationSwitches: number;
  lifecycleEvents: number;
  stopFailures: number;
  /**
   * Issue 09: terminal Sessions (stopped/broken) split by their relationship
   * to the last Turn they carried, so a Session that stops after its Turn
   * completed is never merged into the Turn failure rate.
   *
   * - `postTurnCompleted`: the Session ended after its last Turn completed — a
   *   post-completion Session stop, not a Turn failure.
   * - `turnFailed`: the Session ended tied to a failed Turn's recovery.
   * - `activeTurn`: the Session died while a Turn was still active (no terminal
   *   receipt) — a Session failure that impacted a Turn.
   * - `noTurn`: the Session ended without carrying any Turn.
   */
  terminalByTurnRelation: Readonly<{
    postTurnCompleted: number;
    turnFailed: number;
    activeTurn: number;
    noTurn: number;
  }>;
}>;

export type ReviewsAudit = Readonly<{
  total: number;
  completed: number;
  failed: number;
  infraFailed: number;
  semanticNegative: number;
  faultClasses: FaultClassCounts;
  /** Issue 07: delta-recheck rounds and their terminal dispositions. */
  deltaRechecks: Readonly<{
    total: number;
    equivalentAndAccepted: number;
    finding: number;
    requiresFullReview: number;
  }>;
}>;

export type IntegrationsAudit = Readonly<{
  total: number;
  committed: number;
  failed: number;
  superseded: number;
  environmentFailures: number;
  staleCasFailures: number;
  candidateFailures: number;
  /** Attempts reusing an exact (candidateCommit, checkCommands) signature. */
  gateReuse: number;
  faultClasses: FaultClassCounts;
}>;

export type PublicationsAudit = Readonly<{
  total: number;
  merged: number;
  verified: number;
  open: number;
  closed: number;
  superseded: number;
}>;

export type EventsAudit = Readonly<{
  total: number;
  progressEvents: number;
  semanticEvents: number;
  obsoleteEvents: number;
  messages: number;
  progressShare: number;
}>;

export type AgentErrorAuditEntry = Readonly<{
  taskId: string;
  eventId: string;
  turnId: string;
  roleName: string;
  source: string;
  phase: string;
  category: string;
  code: string;
  message: string;
  raw: string;
  inputDisposition: string;
  sessionDisposition: string;
  createdAt: string;
}>;

export type AgentErrorsAudit = Readonly<{
  total: number;
  byCategory: Readonly<Record<string, number>>;
  entries: readonly AgentErrorAuditEntry[];
}>;

export type StorageAudit = Readonly<{
  stateJsonBytes: number | Unsupported;
  databaseBytes: number | Unsupported;
  databaseHealth: "ok" | "corrupt" | "unopenable" | Unsupported;
  backend: "file" | "sqlite";
  runtimeDirBytes: number | Unsupported;
  deploymentsBytes: number | Unsupported;
}>;

export type RuntimeProtocolAudit = Readonly<{
  contextProtocolVersions: Readonly<Record<string, number>>;
  manifestCompatibilityDigests: number;
  agentErrors: number;
  agentErrorCategories: Readonly<Record<string, number>>;
  contextCapacityFailures: number;
  processExitObservations: number;
  processExitClassifications: Readonly<Record<string, number>>;
  usageSemantics: Readonly<Record<string, number>>;
  compactionEvents: number;
}>;

export type LongTurnEntry = Readonly<{
  taskId: string;
  turnId: string;
  roleName: string;
  status: string;
  durationMs: number;
  startedAt: string;
}>;

export type ExecutionAuditReport = Readonly<{
  generatedAt: string;
  home: string;
  homeIdentity: OptionalFact;
  scope: Readonly<{ taskId?: string; since?: string; until?: string }>;
  tasks: AuditSection<Readonly<{ total: number; archived: number; active: number }>>;
  turns: AuditSection<TurnsAudit>;
  wakes: AuditSection<WakesAudit>;
  sessions: AuditSection<SessionsAudit>;
  reviews: AuditSection<ReviewsAudit>;
  integrations: AuditSection<IntegrationsAudit>;
  publications: AuditSection<PublicationsAudit>;
  events: AuditSection<EventsAudit>;
  agentErrors: AuditSection<AgentErrorsAudit>;
  workItems: AuditSection<Readonly<{
    total: number;
    completed: number;
    retired: number;
  }>>;
  orchestration: AuditSection<Readonly<{
    tasks: readonly TaskOrchestrationMetrics[];
    advisoryCount: number;
  }>>;
  storage: AuditSection<StorageAudit>;
  runtimeProtocol: AuditSection<RuntimeProtocolAudit>;
  topLongRunning: AuditSection<readonly LongTurnEntry[]>;
}>;

export type ExecutionAuditPorts = Readonly<{
  openStore(home: string): TaskStore;
  directorySize(path: string): number | null;
}>;

export function createProductionExecutionAuditPorts(): ExecutionAuditPorts {
  return {
    openStore: (home) => openCurrentTaskStore(home),
    directorySize: (path) => directorySizeBytes(path)
  };
}

function directorySizeBytes(path: string): number | null {
  // Node has no built-in recursive du; use a bounded iterative walk. The audit
  // is read-only and a permission/race error degrades to unsupported.
  try {
    const root = statSync(path);
    if (!root.isDirectory()) return root.size;
  } catch {
    return null;
  }
  let total = 0;
  const stack: string[] = [path];
  while (stack.length > 0) {
    const current = stack.pop()!;
    let entries: import("node:fs").Dirent[];
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const child = join(current, entry.name);
      try {
        if (entry.isDirectory()) {
          stack.push(child);
        } else if (entry.isFile()) {
          total += statSync(child).size;
        }
      } catch {
        // Race with external writers: skip this entry, keep counting.
      }
    }
  }
  return total;
}

const WAKE_REASON_PATTERN = /Wake reasons: ([^\n.]+)/u;

function inWindow(createdAt: string, options: ExecutionAuditOptions): boolean {
  const time = Date.parse(createdAt);
  if (!Number.isFinite(time)) return true;
  if (options.since !== undefined && time < options.since.getTime()) return false;
  if (options.until !== undefined && time > options.until.getTime()) return false;
  return true;
}

function roleBucket(roleName: string): keyof TurnsAudit["byRole"] {
  const normalized = roleName.toLowerCase();
  if (normalized === "leader") return "leader";
  if (normalized === "reviewer") return "reviewer";
  if (normalized.startsWith("implementer") || normalized.startsWith("worker")) {
    return "implementer";
  }
  return "other";
}

function durationMs(turn: Turn): number {
  if (turn.result === undefined) return 0;
  return Math.max(0, Date.parse(turn.result.completedAt) - Date.parse(turn.createdAt));
}

function emptyLaunchFailureCounts(): MutableLaunchFailureCounts {
  const counts: MutableLaunchFailureCounts = {
    total: 0,
    byPhase: Object.fromEntries(
      RUNTIME_LAUNCH_PHASES.map((phase) => [phase, 0])
    ) as Record<RuntimeLaunchPhase, number>,
    byKind: Object.fromEntries(
      RUNTIME_LAUNCH_KINDS.map((kind) => [kind, 0])
    ) as Record<RuntimeLaunchKind, number>
  };
  return counts;
}

function addLaunchFailureCounts(
  counts: MutableLaunchFailureCounts,
  summary: string | undefined
): void {
  if (summary === undefined) return;
  const phase = /failurePhase=([a-z-]+)/u.exec(summary)?.[1];
  const kind = /failureKind=([a-z-]+)/u.exec(summary)?.[1];
  if (
    phase === undefined
    || kind === undefined
    || !RUNTIME_LAUNCH_PHASES.includes(phase as RuntimeLaunchPhase)
    || !RUNTIME_LAUNCH_KINDS.includes(kind as RuntimeLaunchKind)
  ) {
    return;
  }
  counts.byPhase[phase as RuntimeLaunchPhase] += 1;
  counts.byKind[kind as RuntimeLaunchKind] += 1;
  counts.total += 1;
}

/**
 * Issue 09: classify a terminal Session (stopped/broken) by its relationship
 * to the last Turn it carried. Turns and Sessions are separate axes: a Session
 * that stops after its Turn completed is a post-completion stop, not a Turn
 * failure. Correlation is by Role + Agent + Adapter (the durable identity a
 * Turn and its Session share) and the Session's terminal update timestamp.
 */
function classifyTerminalSessionTurnRelation(
  turns: readonly Turn[],
  roleName: string,
  session: Readonly<{
    agentId: string;
    adapterId: string;
    updatedAt: string;
  }>,
  counts: {
    postTurnCompleted: number;
    turnFailed: number;
    activeTurn: number;
    noTurn: number;
  }
): void {
  const terminalAt = Date.parse(session.updatedAt);
  const carried = turns
    .filter((turn) => (
      turn.roleName === roleName
      && turn.effective.agentId === session.agentId
      && turn.effective.adapterId === session.adapterId
      && Date.parse(turn.createdAt) <= terminalAt
    ))
    .sort((left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt));
  const lastTurn = carried[0];
  if (lastTurn === undefined) {
    counts.noTurn += 1;
    return;
  }
  if (lastTurn.status === "completed"
    && lastTurn.result !== undefined
    && Date.parse(lastTurn.result.completedAt) <= terminalAt) {
    counts.postTurnCompleted += 1;
    return;
  }
  if (lastTurn.status === "failed") {
    counts.turnFailed += 1;
    return;
  }
  counts.activeTurn += 1;
}

function ok<T>(data: T): AuditSection<T> {
  return { status: "ok", data };
}

function failed<T>(error: unknown): AuditSection<T> {
  return {
    status: "error",
    error: error instanceof Error ? error.message : String(error)
  };
}

/**
 * Execute the read-only audit. The store is opened once and only read methods are
 * called; no transaction, no Event, no Message, no wake is produced.
 */
export function runExecutionAudit(
  home: string,
  options: ExecutionAuditOptions = {},
  ports: ExecutionAuditPorts = createProductionExecutionAuditPorts()
): ExecutionAuditReport {
  const generatedAt = new Date().toISOString();
  const scope = {
    ...(options.taskId === undefined ? {} : { taskId: options.taskId }),
    ...(options.since === undefined ? {} : { since: options.since.toISOString() }),
    ...(options.until === undefined ? {} : { until: options.until.toISOString() })
  };

  let store: TaskStore;
  try {
    store = ports.openStore(home);
  } catch (error) {
    const section = failed<never>(error);
    return {
      generatedAt,
      home,
      homeIdentity: UNSUPPORTED,
      scope,
      tasks: section,
      turns: section,
      wakes: section,
      sessions: section,
      reviews: section,
      integrations: section,
      publications: section,
      events: section,
      agentErrors: section,
      workItems: section,
      orchestration: section,
      storage: section,
      runtimeProtocol: section,
      topLongRunning: section
    };
  }

  let homeIdentity: OptionalFact = UNSUPPORTED;
  try {
    homeIdentity = store.getHomeIdentity().homeId;
  } catch {
    homeIdentity = UNSUPPORTED;
  }

  const taskIds = (() => {
    try {
      const tasks = store.listTasks();
      return tasks
        .filter((task) => options.taskId === undefined || task.id === options.taskId)
        .map((task) => task.id);
    } catch {
      return [];
    }
  })();

  const tasks = (() => {
    try {
      const tasks = store.listTasks().filter(
        (task) => options.taskId === undefined || task.id === options.taskId
      );
      return ok({
        total: tasks.length,
        archived: tasks.filter((task) => task.status === "archived").length,
        active: tasks.filter((task) => task.status === "active").length
      });
    } catch (error) {
      return failed<{ total: number; archived: number; active: number }>(error);
    }
  })();

  const turns = ((): AuditSection<TurnsAudit> => {
    try {
      let total = 0;
      let active = 0;
      let completed = 0;
      let failedCount = 0;
      let cumulativeDurationMs = 0;
      let failedDurationMs = 0;
      const byRole = { leader: 0, reviewer: 0, implementer: 0, other: 0 };
      const byPurpose = { execution: 0, review: 0 };
      const failures = [];
      const launchFailures: MutableLaunchFailureCounts = emptyLaunchFailureCounts();
      for (const taskId of taskIds) {
        for (const turn of store.listTurns(taskId)) {
          if (!inWindow(turn.createdAt, options)) continue;
          total += 1;
          byRole[roleBucket(turn.roleName)] += 1;
          if (turn.purpose === "review") byPurpose.review += 1;
          else byPurpose.execution += 1;
          const duration = durationMs(turn);
          if (turn.status === "active") {
            active += 1;
            cumulativeDurationMs += Math.max(
              0,
              Date.now() - Date.parse(turn.createdAt)
            );
          } else if (turn.status === "completed") {
            completed += 1;
            cumulativeDurationMs += duration;
          } else if (turn.status === "failed") {
            failedCount += 1;
            failedDurationMs += duration;
            cumulativeDurationMs += duration;
            addLaunchFailureCounts(launchFailures, turn.result?.output);
            failures.push(classifyTurnFailure(turn));
          }
        }
      }
      return ok({
        total,
        active,
        completed,
        failed: failedCount,
        failureRate: total === 0 ? 0 : failedCount / total,
        cumulativeDurationMs,
        failedDurationMs,
        byRole,
        byPurpose,
        faultClasses: countFaultClasses(failures),
        launchFailures
      });
    } catch (error) {
      return failed<TurnsAudit>(error);
    }
  })();

  const wakes = ((): AuditSection<WakesAudit> => {
    try {
      let leaderTurns = 0;
      let withWakeReasons = 0;
      let suppressedWakes = 0;
      const byReason = new Map<string, number>();
      for (const taskId of taskIds) {
        for (const turn of store.listTurns(taskId)) {
          if (turn.roleName !== "leader") continue;
          if (!inWindow(turn.createdAt, options)) continue;
          leaderTurns += 1;
          const match = WAKE_REASON_PATTERN.exec(turn.inputs[0]!.input.directive ?? "");
          if (match === null) continue;
          withWakeReasons += 1;
          const reasons = match[1]!.split(",").map((value) => value.trim()).filter(Boolean);
          for (const reason of reasons) {
            byReason.set(reason, (byReason.get(reason) ?? 0) + 1);
          }
        }
        for (const event of store.listEvents(taskId)) {
          if (event.type !== "wake.suppressed") continue;
          if (!inWindow(event.createdAt, options)) continue;
          suppressedWakes += 1;
        }
      }
      return ok({
        leaderTurns,
        withWakeReasons,
        byReason: Object.fromEntries(
          [...byReason.entries()].sort((left, right) => right[1] - left[1])
        ),
        // Scheduler single-flight suppression: wakes that were coalesced
        // because the Role runtime lifecycle lane was busy. These are
        // scheduler outcomes, never failed Turns.
        suppressedWakes: { status: "ok", data: suppressedWakes }
      });
    } catch (error) {
      return failed<WakesAudit>(error);
    }
  })();

  const sessions = ((): AuditSection<SessionsAudit> => {
    try {
      let generations = 0;
      let broken = 0;
      let stopped = 0;
      let other = 0;
      let resets = 0;
      let conversationSwitches = 0;
      let lifecycleEvents = 0;
      let stopFailures = 0;
      const terminalByTurnRelation = {
        postTurnCompleted: 0,
        turnFailed: 0,
        activeTurn: 0,
        noTurn: 0
      };
      for (const taskId of taskIds) {
        const turns = store.listTurns(taskId);
        for (const set of store.listRoleSessionSets(taskId)) {
          const history = Array.isArray(set.history) ? set.history : [];
          for (const session of [...history, ...Object.values(set.sessions)]) {
            generations += 1;
            if (session.status === "ended" && session.endReason === "failed") broken += 1;
            else if (session.status === "ended") stopped += 1;
            else other += 1;
            if (session.status === "ended") {
              classifyTerminalSessionTurnRelation(
                turns,
                set.owner.roleName,
                session,
                terminalByTurnRelation
              );
            }
          }
        }
        for (const event of store.listEvents(taskId)) {
          if (!inWindow(event.createdAt, options)) continue;
          if (event.type === "runtime.role-session-reset") resets += 1;
          else if (event.type === "runtime.conversation-switch-resolved"
            && event.payload.status === "applied") conversationSwitches += 1;
          else if (runtimeObservationFromTaskEvent(event)?.kind.startsWith("session.")) {
            lifecycleEvents += 1;
          } else if (event.type === "runtime.turn-failed") stopFailures += 1;
        }
      }
      return ok({
        generations,
        broken,
        stopped,
        other,
        resets,
        conversationSwitches,
        lifecycleEvents,
        stopFailures,
        terminalByTurnRelation
      });
    } catch (error) {
      return failed<SessionsAudit>(error);
    }
  })();

  const reviews = ((): AuditSection<ReviewsAudit> => {
    try {
      let total = 0;
      let completed = 0;
      let failedCount = 0;
      let infraFailed = 0;
      let semanticNegative = 0;
      let deltaTotal = 0;
      let deltaAccepted = 0;
      let deltaFinding = 0;
      let deltaEscalated = 0;
      const classes = [];
      for (const taskId of taskIds) {
        for (const round of store.listReviewRounds(taskId)) {
          if (!inWindow(round.createdAt, options)) continue;
          total += 1;
          if (round.status === "completed") completed += 1;
          else if (round.status === "failed") failedCount += 1;
          if (round.deltaRecheck !== undefined) {
            deltaTotal += 1;
            if (round.deltaRecheck.disposition === "equivalent-and-accepted") deltaAccepted += 1;
            else if (round.deltaRecheck.disposition === "finding") deltaFinding += 1;
            else if (round.deltaRecheck.disposition === "requires-full-review") deltaEscalated += 1;
          }
          const classification = classifyReviewRound(round, store);
          if (classification.faultClass === "review-infra") infraFailed += 1;
          else if (classification.faultClass === "review-semantic-negative") {
            semanticNegative += 1;
          }
          if (classification.faultClass !== "other") classes.push(classification);
        }
      }
      return ok({
        total,
        completed,
        failed: failedCount,
        infraFailed,
        semanticNegative,
        faultClasses: countFaultClasses(classes),
        deltaRechecks: {
          total: deltaTotal,
          equivalentAndAccepted: deltaAccepted,
          finding: deltaFinding,
          requiresFullReview: deltaEscalated
        }
      });
    } catch (error) {
      return failed<ReviewsAudit>(error);
    }
  })();

  const integrations = ((): AuditSection<IntegrationsAudit> => {
    try {
      let total = 0;
      let committed = 0;
      let failedCount = 0;
      let superseded = 0;
      let environmentFailures = 0;
      let staleCasFailures = 0;
      let candidateFailures = 0;
      let gateReuse = 0;
      const classes = [];
      const seenSignatures = new Set<string>();
      for (const taskId of taskIds) {
        for (const attempt of store.listIntegrationAttempts(taskId)) {
          if (!inWindow(attempt.createdAt, options)) continue;
          total += 1;
          if (attempt.status === "committed") committed += 1;
          else if (attempt.status === "failed") failedCount += 1;
          else if (attempt.status === "superseded") superseded += 1;
          const classification = classifyIntegrationAttempt(attempt);
          if (classification.faultClass === "integration-environment") {
            environmentFailures += 1;
          } else if (classification.faultClass === "stale-base-target-cas") {
            staleCasFailures += 1;
          } else if (classification.faultClass === "integration-candidate-failure") {
            candidateFailures += 1;
          }
          if (classification.faultClass !== "other") classes.push(classification);
          if (attempt.candidateCommit !== undefined) {
            const signature = `${attempt.candidateCommit}|${attempt.checkCommands.join(",")}`;
            if (seenSignatures.has(signature)) gateReuse += 1;
            else seenSignatures.add(signature);
          }
        }
      }
      return ok({
        total,
        committed,
        failed: failedCount,
        superseded,
        environmentFailures,
        staleCasFailures,
        candidateFailures,
        gateReuse,
        faultClasses: countFaultClasses(classes)
      });
    } catch (error) {
      return failed<IntegrationsAudit>(error);
    }
  })();

  const publications = ((): AuditSection<PublicationsAudit> => {
    try {
      let total = 0;
      let merged = 0;
      let verified = 0;
      let open = 0;
      let closed = 0;
      let superseded = 0;
      for (const taskId of taskIds) {
        const references = store.listPublicationReferences(taskId);
        const supersededIds = new Set(
          references
            .map((reference) => reference.supersedes)
            .filter((id): id is string => id !== undefined)
        );
        for (const reference of references) {
          if (!inWindow(reference.createdAt, options)) continue;
          total += 1;
          if (reference.state === "merged") merged += 1;
          if (reference.state === "open") open += 1;
          if (reference.state === "closed") closed += 1;
          if (reference.verification === "verified") verified += 1;
          if (supersededIds.has(reference.id)) superseded += 1;
        }
      }
      return ok({ total, merged, verified, open, closed, superseded });
    } catch (error) {
      return failed<PublicationsAudit>(error);
    }
  })();

  const events = ((): AuditSection<EventsAudit> => {
    try {
      let total = 0;
      let progressEvents = 0;
      let obsoleteEvents = 0;
      let messages = 0;
      for (const taskId of taskIds) {
        for (const event of store.listEvents(taskId)) {
          if (!inWindow(event.createdAt, options)) continue;
          total += 1;
          if (runtimeObservationFromTaskEvent(event)?.kind === "activity.observed") {
            progressEvents += 1;
          } else if (event.type === "runtime.event-obsolete") obsoleteEvents += 1;
        }
        messages += store.listMessages(taskId)
          .filter((message) => inWindow(message.createdAt, options))
          .length;
      }
      return ok({
        total,
        progressEvents,
        semanticEvents: total - progressEvents,
        obsoleteEvents,
        messages,
        progressShare: total === 0 ? 0 : progressEvents / total
      });
    } catch (error) {
      return failed<EventsAudit>(error);
    }
  })();

  const agentErrors = ((): AuditSection<AgentErrorsAudit> => {
    try {
      const entries: AgentErrorAuditEntry[] = [];
      const categories = new Map<string, number>();
      for (const taskId of taskIds) {
        for (const event of store.listEvents(taskId)) {
          if (!inWindow(event.createdAt, options) || event.type !== "runtime.agent-error") {
            continue;
          }
          const category = event.payload.category ?? "unknown";
          categories.set(category, (categories.get(category) ?? 0) + 1);
          entries.push({
            taskId,
            eventId: event.id,
            turnId: event.payload.turnId ?? "",
            roleName: event.payload.roleName ?? "",
            source: event.payload.source ?? "unknown",
            phase: event.payload.phase ?? "unknown",
            category,
            code: event.payload.code ?? "unknown",
            message: event.payload.message ?? "",
            raw: event.payload.raw ?? "",
            inputDisposition: event.payload.inputDisposition ?? "unknown",
            sessionDisposition: event.payload.sessionDisposition ?? "unknown",
            createdAt: event.createdAt
          });
        }
      }
      return ok({
        total: entries.length,
        byCategory: Object.fromEntries(categories),
        entries
      });
    } catch (error) {
      return failed<AgentErrorsAudit>(error);
    }
  })();

  const workItems = ((): AuditSection<{ total: number; completed: number; retired: number }> => {
    try {
      let total = 0;
      let completed = 0;
      let retired = 0;
      for (const taskId of taskIds) {
        for (const item of store.listWorkItems(taskId)) {
          if (!inWindow(item.createdAt, options)) continue;
          total += 1;
          if (item.status === "completed") completed += 1;
          else if (item.status === "retired") retired += 1;
        }
      }
      return ok({ total, completed, retired });
    } catch (error) {
      return failed<{ total: number; completed: number; retired: number }>(error);
    }
  })();

  const orchestration = ((): ExecutionAuditReport["orchestration"] => {
    try {
      const metrics = taskIds.flatMap((taskId) => {
        const task = store.getTask(taskId);
        if (task === null) return [];
        return [projectTaskOrchestration({
          task,
          turns: withinWindow(store.listTurns(taskId), options),
          roleSessionSets: sessionSetsWithinWindow(store.listRoleSessionSets(taskId), options),
          workItems: withinWindow(store.listWorkItems(taskId), options),
          changeSets: withinWindow(store.listChangeSets(taskId), options),
          reviewRounds: withinWindow(store.listReviewRounds(taskId), options),
          reviewFindings: withinWindow(store.listReviewFindings(taskId), options),
          integrations: withinWindow(store.listIntegrationAttempts(taskId), options),
          durableJobs: withinWindow(store.listDurableJobs(taskId), options),
          publications: withinWindow(store.listPublicationReferences(taskId), options),
          decisions: withinWindow(store.listDecisions(taskId), options),
          events: withinWindow(store.listEvents(taskId), options),
          managedWorkspaces: withinWindow(store.listManagedWorkspaces(taskId), options)
        })];
      });
      return ok({
        tasks: metrics,
        advisoryCount: metrics.reduce((total, task) => total + task.advisories.length, 0)
      });
    } catch (error) {
      return failed<{ tasks: readonly TaskOrchestrationMetrics[]; advisoryCount: number }>(error);
    }
  })();

  const storage = ((): AuditSection<StorageAudit> => {
    try {
      let stateJsonBytes: number | Unsupported = UNSUPPORTED;
      try {
        stateJsonBytes = statSync(join(home, "state.json")).size;
      } catch {
        stateJsonBytes = UNSUPPORTED;
      }
      let databaseBytes: number | Unsupported = UNSUPPORTED;
      try {
        databaseBytes = statSync(join(home, "yui.db")).size;
      } catch {
        databaseBytes = UNSUPPORTED;
      }
      return ok({
        stateJsonBytes,
        databaseBytes,
        // The audit aggregates history; live db integrity is the status
        // command's job (it runs PRAGMA quick_check). Report presence/size
        // and the authoritative backend, not a duplicate health probe.
        databaseHealth: UNSUPPORTED,
        backend: resolveTaskStoreBackendForHome(home),
        runtimeDirBytes: ports.directorySize(join(home, "runtime")) ?? UNSUPPORTED,
        deploymentsBytes:
          ports.directorySize(join(home, "runtime", "deployments")) ?? UNSUPPORTED
      });
    } catch (error) {
      return failed<StorageAudit>(error);
    }
  })();

  const runtimeProtocol = ((): AuditSection<RuntimeProtocolAudit> => {
    try {
      const protocolVersions = new Map<string, number>();
      const manifestDigests = new Set<string>();
      const agentErrorCategories = new Map<string, number>();
      const exitClassifications = new Map<string, number>();
      const usageSemantics = new Map<string, number>();
      let agentErrors = 0;
      let contextCapacityFailures = 0;
      let processExitObservations = 0;
      let compactionEvents = 0;
      for (const taskId of taskIds) {
        for (const run of store.listTurns(taskId)) {
          if (!inWindow(run.createdAt, options)) continue;
          const version = String(run.effective.contextProtocolVersion ?? "legacy");
          protocolVersions.set(version, (protocolVersions.get(version) ?? 0) + 1);
          if (run.effective.sessionManifestCompatibilityDigest !== undefined) {
            manifestDigests.add(run.effective.sessionManifestCompatibilityDigest);
          }
        }
        for (const event of store.listEvents(taskId)) {
          if (!inWindow(event.createdAt, options)) continue;
          if (event.type === "runtime.agent-error") {
            agentErrors += 1;
            const category = event.payload.category ?? "unknown";
            agentErrorCategories.set(
              category,
              (agentErrorCategories.get(category) ?? 0) + 1
            );
            if (category === "context") contextCapacityFailures += 1;
          }
          else if (event.type === "runtime.process-exit-observed") {
            processExitObservations += 1;
            const classification = event.payload.classification ?? "unknown";
            exitClassifications.set(
              classification,
              (exitClassifications.get(classification) ?? 0) + 1
            );
          }
          const observation = runtimeObservationFromTaskEvent(event);
          const semantics = observation?.payload.usage?.semantics;
          if (semantics !== undefined) {
            usageSemantics.set(semantics, (usageSemantics.get(semantics) ?? 0) + 1);
          }
          if (event.type === "runtime.compaction-started"
            || event.type === "runtime.compaction-completed") compactionEvents += 1;
        }
      }
      return ok({
        contextProtocolVersions: Object.fromEntries(protocolVersions),
        manifestCompatibilityDigests: manifestDigests.size,
        agentErrors,
        agentErrorCategories: Object.fromEntries(agentErrorCategories),
        contextCapacityFailures,
        processExitObservations,
        processExitClassifications: Object.fromEntries(exitClassifications),
        usageSemantics: Object.fromEntries(usageSemantics),
        compactionEvents
      });
    } catch (error) {
      return failed<RuntimeProtocolAudit>(error);
    }
  })();

  const topLongRunning = ((): AuditSection<readonly LongTurnEntry[]> => {
    try {
      const entries: LongTurnEntry[] = [];
      for (const taskId of taskIds) {
        for (const turn of store.listTurns(taskId)) {
          if (!inWindow(turn.createdAt, options)) continue;
          const duration = turn.status === "active"
            ? Math.max(0, Date.now() - Date.parse(turn.createdAt))
            : durationMs(turn);
          if (duration <= 0) continue;
          entries.push({
            taskId,
            turnId: turn.id,
            roleName: turn.roleName,
            status: turn.status,
            durationMs: duration,
            startedAt: turn.createdAt
          });
        }
      }
      return ok(
        entries
          .sort((left, right) => right.durationMs - left.durationMs)
          .slice(0, 10)
      );
    } catch (error) {
      return failed<readonly LongTurnEntry[]>(error);
    }
  })();

  return {
    generatedAt,
    home,
    homeIdentity,
    scope,
    tasks,
    turns,
    wakes,
    sessions,
    reviews,
    integrations,
    publications,
    events,
    agentErrors,
    workItems,
    orchestration,
    storage,
    runtimeProtocol,
    topLongRunning
  };
}

function withinWindow<T extends Readonly<{ createdAt: string }>>(
  records: readonly T[],
  options: ExecutionAuditOptions
): readonly T[] {
  return records.filter((record) => inWindow(record.createdAt, options));
}

function sessionSetsWithinWindow(
  sets: readonly TaskRoleSessionSet[],
  options: ExecutionAuditOptions
): readonly TaskRoleSessionSet[] {
  if (options.since === undefined && options.until === undefined) return sets;
  return sets.map((set) => ({
    ...set,
    sessions: Object.fromEntries(Object.entries(set.sessions).filter(([, session]) => (
      inWindow(session.createdAt, options)
    ))),
    history: (set.history ?? []).filter((session) => inWindow(session.createdAt, options))
  }));
}
