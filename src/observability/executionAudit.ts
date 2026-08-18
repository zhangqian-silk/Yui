/**
 * Read-only execution audit aggregator (Issue 11 §3).
 *
 * The audit answers "what happened in this Home" from durable records alone:
 * Runs/failures/durations, wake reasons, Session generations, Review execution
 * vs semantic failures, Integration failure classes and gate reuse, telemetry
 * volume, and the longest/stale executions. It never writes Task state, never
 * wakes a Leader, and never takes the storage write lock — it only calls the
 * store's read methods. A section that cannot be read degrades to an error
 * entry while the rest of the report stays usable (Issue 11 minimal failure
 * semantics).
 */
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";

import { openCompatibleFileTaskStore } from "../storage/compatibleTaskStore.js";
import { resolveTaskStoreBackendForHome } from "../storage/sqliteStore.js";
import type { TaskStore } from "../storage/taskStore.js";
import type { AgentRun } from "../run/agentRun.js";
import {
  classifyAgentRunFailure,
  classifyIntegrationAttempt,
  classifyReviewRound,
  classifyWakeReasons,
  countFaultClasses,
  type FaultClassCounts
} from "./faultClassification.js";
import { UNSUPPORTED, type OptionalFact, type Unsupported } from "./runtimeIdentity.js";

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

export type RunsAudit = Readonly<{
  total: number;
  active: number;
  yielded: number;
  failed: number;
  failureRate: number;
  cumulativeDurationMs: number;
  failedDurationMs: number;
  byRole: Readonly<{ leader: number; reviewer: number; implementer: number; other: number }>;
  byPurpose: Readonly<{ execution: number; review: number }>;
  faultClasses: FaultClassCounts;
}>;

export type WakesAudit = Readonly<{
  leaderRuns: number;
  withWakeReasons: number;
  orphanWakes: number;
  orphanYieldOnly: number;
  byReason: Readonly<Record<string, number>>;
  /** Suppressed-wake counters belong to the scheduler Issue; absent → unsupported. */
  suppressedWakes: AuditSection<number>;
}>;

export type SessionsAudit = Readonly<{
  generations: number;
  broken: number;
  stopped: number;
  other: number;
  resets: number;
  lifecycleEvents: number;
  stopFailures: number;
}>;

export type ReviewsAudit = Readonly<{
  total: number;
  completed: number;
  failed: number;
  infraFailed: number;
  semanticNegative: number;
  faultClasses: FaultClassCounts;
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

export type EventsAudit = Readonly<{
  total: number;
  progressEvents: number;
  semanticEvents: number;
  obsoleteEvents: number;
  messages: number;
  progressShare: number;
}>;

export type StorageAudit = Readonly<{
  stateJsonBytes: number | Unsupported;
  databaseBytes: number | Unsupported;
  databaseHealth: "ok" | "corrupt" | "unopenable" | Unsupported;
  backend: "file" | "sqlite";
  runtimeDirBytes: number | Unsupported;
  deploymentsBytes: number | Unsupported;
}>;

export type LongRunEntry = Readonly<{
  taskId: string;
  runId: string;
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
  runs: AuditSection<RunsAudit>;
  wakes: AuditSection<WakesAudit>;
  sessions: AuditSection<SessionsAudit>;
  reviews: AuditSection<ReviewsAudit>;
  integrations: AuditSection<IntegrationsAudit>;
  events: AuditSection<EventsAudit>;
  workItems: AuditSection<Readonly<{
    total: number;
    completed: number;
    retired: number;
  }>>;
  storage: AuditSection<StorageAudit>;
  topLongRunning: AuditSection<readonly LongRunEntry[]>;
}>;

export type ExecutionAuditPorts = Readonly<{
  openStore(home: string): TaskStore;
  directorySize(path: string): number | null;
}>;

export function createProductionExecutionAuditPorts(): ExecutionAuditPorts {
  return {
    openStore: (home) => openCompatibleFileTaskStore(home),
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

const WAKE_REASON_PATTERN = /Yui wakeup reasons: ([^\n.]+)/u;

function inWindow(createdAt: string, options: ExecutionAuditOptions): boolean {
  const time = Date.parse(createdAt);
  if (!Number.isFinite(time)) return true;
  if (options.since !== undefined && time < options.since.getTime()) return false;
  if (options.until !== undefined && time > options.until.getTime()) return false;
  return true;
}

function roleBucket(roleName: string): keyof RunsAudit["byRole"] {
  const normalized = roleName.toLowerCase();
  if (normalized === "leader") return "leader";
  if (normalized === "reviewer") return "reviewer";
  if (normalized.startsWith("implementer") || normalized.startsWith("worker")) {
    return "implementer";
  }
  return "other";
}

function durationMs(run: AgentRun): number {
  if (run.endedAt === undefined) return 0;
  return Math.max(0, Date.parse(run.endedAt) - Date.parse(run.createdAt));
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
 * Run the read-only audit. The store is opened once and only read methods are
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
      runs: section,
      wakes: section,
      sessions: section,
      reviews: section,
      integrations: section,
      events: section,
      workItems: section,
      storage: section,
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

  const runs = ((): AuditSection<RunsAudit> => {
    try {
      let total = 0;
      let active = 0;
      let yielded = 0;
      let failedCount = 0;
      let cumulativeDurationMs = 0;
      let failedDurationMs = 0;
      const byRole = { leader: 0, reviewer: 0, implementer: 0, other: 0 };
      const byPurpose = { execution: 0, review: 0 };
      const failures = [];
      for (const taskId of taskIds) {
        for (const run of store.listAgentRuns(taskId)) {
          if (!inWindow(run.createdAt, options)) continue;
          total += 1;
          byRole[roleBucket(run.roleName)] += 1;
          if (run.purpose === "review") byPurpose.review += 1;
          else byPurpose.execution += 1;
          const duration = durationMs(run);
          if (run.status === "active") {
            active += 1;
            cumulativeDurationMs += Math.max(
              0,
              Date.now() - Date.parse(run.createdAt)
            );
          } else if (run.status === "yielded") {
            yielded += 1;
            cumulativeDurationMs += duration;
          } else if (run.status === "failed") {
            failedCount += 1;
            failedDurationMs += duration;
            cumulativeDurationMs += duration;
            failures.push(classifyAgentRunFailure(run));
          }
        }
      }
      return ok({
        total,
        active,
        yielded,
        failed: failedCount,
        failureRate: total === 0 ? 0 : failedCount / total,
        cumulativeDurationMs,
        failedDurationMs,
        byRole,
        byPurpose,
        faultClasses: countFaultClasses(failures)
      });
    } catch (error) {
      return failed<RunsAudit>(error);
    }
  })();

  const wakes = ((): AuditSection<WakesAudit> => {
    try {
      let leaderRuns = 0;
      let withWakeReasons = 0;
      let orphanWakes = 0;
      let orphanYieldOnly = 0;
      const byReason = new Map<string, number>();
      for (const taskId of taskIds) {
        for (const run of store.listAgentRuns(taskId)) {
          if (run.roleName !== "leader") continue;
          if (!inWindow(run.createdAt, options)) continue;
          leaderRuns += 1;
          const match = WAKE_REASON_PATTERN.exec(run.input);
          if (match === null) continue;
          withWakeReasons += 1;
          const reasons = match[1]!.split(",").map((value) => value.trim()).filter(Boolean);
          for (const reason of reasons) {
            byReason.set(reason, (byReason.get(reason) ?? 0) + 1);
          }
          if (classifyWakeReasons(reasons).faultClass
            === "scheduler-duplicate-suppressed-wake") {
            orphanWakes += 1;
            if (run.status === "yielded") orphanYieldOnly += 1;
          }
        }
      }
      return ok({
        leaderRuns,
        withWakeReasons,
        orphanWakes,
        orphanYieldOnly,
        byReason: Object.fromEntries(
          [...byReason.entries()].sort((left, right) => right[1] - left[1])
        ),
        // The quiescence/suppression counter is owned by the scheduler Issue;
        // this build has no producer, so report unsupported rather than 0.
        suppressedWakes: { status: "unsupported" }
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
      let lifecycleEvents = 0;
      let stopFailures = 0;
      for (const taskId of taskIds) {
        for (const set of store.listRoleSessionSets(taskId)) {
          const history = Array.isArray(set.history) ? set.history : [];
          for (const session of [...history, ...Object.values(set.sessions)]) {
            generations += 1;
            if (session.status === "broken") broken += 1;
            else if (session.status === "stopped") stopped += 1;
            else other += 1;
          }
        }
        for (const event of store.listEvents(taskId)) {
          if (!inWindow(event.createdAt, options)) continue;
          if (event.type === "runtime.role-session-reset") resets += 1;
          else if (event.type === "runtime.provider-session-lifecycle") lifecycleEvents += 1;
          else if (event.type === "runtime.claude-stop-failure") stopFailures += 1;
        }
      }
      return ok({
        generations,
        broken,
        stopped,
        other,
        resets,
        lifecycleEvents,
        stopFailures
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
      const classes = [];
      for (const taskId of taskIds) {
        for (const round of store.listReviewRounds(taskId)) {
          if (!inWindow(round.createdAt, options)) continue;
          total += 1;
          if (round.status === "completed") completed += 1;
          else if (round.status === "failed") failedCount += 1;
          const classification = classifyReviewRound(round);
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
        faultClasses: countFaultClasses(classes)
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
          if (event.type === "runtime.provider-turn-progress") progressEvents += 1;
          else if (event.type === "runtime.event-obsolete") obsoleteEvents += 1;
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

  const topLongRunning = ((): AuditSection<readonly LongRunEntry[]> => {
    try {
      const entries: LongRunEntry[] = [];
      for (const taskId of taskIds) {
        for (const run of store.listAgentRuns(taskId)) {
          if (!inWindow(run.createdAt, options)) continue;
          const duration = run.status === "active"
            ? Math.max(0, Date.now() - Date.parse(run.createdAt))
            : durationMs(run);
          if (duration <= 0) continue;
          entries.push({
            taskId,
            runId: run.id,
            roleName: run.roleName,
            status: run.status,
            durationMs: duration,
            startedAt: run.createdAt
          });
        }
      }
      return ok(
        entries
          .sort((left, right) => right.durationMs - left.durationMs)
          .slice(0, 10)
      );
    } catch (error) {
      return failed<readonly LongRunEntry[]>(error);
    }
  })();

  return {
    generatedAt,
    home,
    homeIdentity,
    scope,
    tasks,
    runs,
    wakes,
    sessions,
    reviews,
    integrations,
    events,
    workItems,
    storage,
    topLongRunning
  };
}
