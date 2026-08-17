import type { TaskEvent } from "../event/taskEvent.js";
import type { TaskStore } from "../storage/taskStore.js";
import { DEFAULT_TERMINAL_KEEP } from "./telemetryConfig.js";
import type { TelemetryAggregate, TelemetryProgressEntry, TelemetryStore } from "./telemetryStore.js";

/**
 * Issue 09 — historical compaction.
 *
 * Progress events that were appended to semantic Task event history (legacy
 * behavior) are folded into the telemetry tables inside the Home's `yui.db`:
 * the newest `keep` rows per Run/generation become the retained window, and
 * every Run/generation gets an accurate aggregate
 * (count/first/last/maxSequence/errorCount). The semantic progress events are
 * then removed through the store's public transaction adapter. Semantic
 * evidence (Run dispatch/delivery/terminal receipts, Session lifecycle,
 * Review, Decision, Integration, ...) is never touched.
 *
 * Compaction runs on a staged copy of a Home. The caller promotes the staged
 * copy only after this module validates the result; a validation failure
 * throws and leaves the original history unchanged.
 */

export const PROGRESS_EVENT_TYPE = "runtime.provider-turn-progress";

export type CompactionGenerationPlan = Readonly<{
  roleName: string;
  runId: string;
  generation: string;
  aggregate: TelemetryAggregate;
  /** Newest `keep` observations, ready for sidecar import. */
  window: readonly TelemetryProgressEntry[];
}>;

export type CompactionTaskPlan = Readonly<{
  taskId: string;
  /** Semantic progress event ids to remove after the sidecar import. */
  progressEventIds: readonly string[];
  /** Progress events kept as semantic because they lacked a run/progress id. */
  malformedKept: number;
  generations: readonly CompactionGenerationPlan[];
}>;

export type CompactionPlan = Readonly<{
  tasks: readonly CompactionTaskPlan[];
  totals: Readonly<{
    tasks: number;
    progressEvents: number;
    generations: number;
    telemetryRows: number;
  }>;
}>;

export type CompactionReceipt = Readonly<{
  schemaVersion: 1;
  createdAt: string;
  dryRun: boolean;
  source: string;
  terminalKeep: number;
  totals: CompactionPlan["totals"];
  tasks: readonly Readonly<{
    taskId: string;
    removedProgressEvents: number;
    generations: readonly TelemetryAggregate[];
  }>[];
  validation: "passed";
}>;

export type CompactionOptions = Readonly<{
  terminalKeep?: number;
  now?: Date;
}>;

/**
 * Scan a store and build the compaction plan. Read-only: nothing is modified.
 */
export function planTelemetryCompaction(
  store: TaskStore,
  options: CompactionOptions = {}
): CompactionPlan {
  const keep = options.terminalKeep ?? DEFAULT_TERMINAL_KEEP;
  const tasks: CompactionTaskPlan[] = [];
  let progressEvents = 0;
  let generations = 0;
  let telemetryRows = 0;
  for (const task of store.listTasks()) {
    const taskPlan = planTaskCompaction(task.id, store.listEvents(task.id), keep);
    if (taskPlan === null) continue;
    tasks.push(taskPlan);
    progressEvents += taskPlan.progressEventIds.length;
    generations += taskPlan.generations.length;
    for (const generation of taskPlan.generations) telemetryRows += generation.window.length;
  }
  return {
    tasks,
    totals: { tasks: tasks.length, progressEvents, generations, telemetryRows }
  };
}

function planTaskCompaction(
  taskId: string,
  events: readonly TaskEvent[],
  keep: number
): CompactionTaskPlan | null {
  const byGeneration = new Map<string, TaskEvent[]>();
  const progressEventIds: string[] = [];
  let malformedKept = 0;
  for (const event of events) {
    if (event.type !== PROGRESS_EVENT_TYPE) continue;
    const runId = event.payload.runId;
    const progressId = event.payload.progressId;
    if (typeof runId !== "string" || typeof progressId !== "string") {
      // Fail closed: an anomalous progress row stays semantic and is reported.
      malformedKept++;
      continue;
    }
    const roleName = typeof event.payload.roleName === "string" ? event.payload.roleName : "unknown";
    const generation = typeof event.payload.launchId === "string" && event.payload.launchId !== ""
      ? event.payload.launchId
      : typeof event.payload.nativeSessionId === "string" && event.payload.nativeSessionId !== ""
        ? event.payload.nativeSessionId
        : "unbound";
    const key = `${roleName}\u0000${runId}\u0000${generation}`;
    const group = byGeneration.get(key);
    if (group === undefined) byGeneration.set(key, [event]);
    else group.push(event);
    progressEventIds.push(event.id);
  }
  if (progressEventIds.length === 0 && malformedKept === 0) return null;
  const generations: CompactionGenerationPlan[] = [];
  for (const group of byGeneration.values()) {
    generations.push(planGenerationCompaction(taskId, group, keep));
  }
  return { taskId, progressEventIds, malformedKept, generations };
}

function planGenerationCompaction(
  taskId: string,
  events: readonly TaskEvent[],
  keep: number
): CompactionGenerationPlan {
  const first = events[0];
  const roleName = typeof first.payload.roleName === "string" ? first.payload.roleName : "unknown";
  const runId = first.payload.runId as string;
  const generation = typeof first.payload.launchId === "string" && first.payload.launchId !== ""
    ? first.payload.launchId
    : typeof first.payload.nativeSessionId === "string" && first.payload.nativeSessionId !== ""
      ? first.payload.nativeSessionId
      : "unbound";
  const ordered = [...events].sort(compareProgressEvents);
  let firstAt = progressAt(ordered[0]);
  let lastAt = firstAt;
  let maxSequence: number | null = null;
  let errorCount = 0;
  for (const event of ordered) {
    const at = progressAt(event);
    if (at < firstAt) firstAt = at;
    if (at > lastAt) lastAt = at;
    const sequence = event.payload.sequence;
    if (typeof sequence === "string") {
      const value = Number(sequence);
      if (Number.isSafeInteger(value) && (maxSequence === null || value > maxSequence)) {
        maxSequence = value;
      }
    }
    if (
      (typeof event.payload.error === "string" && event.payload.error !== "")
      || (typeof event.payload.errorKind === "string" && event.payload.errorKind !== "")
    ) {
      errorCount++;
    }
  }
  const window = ordered.slice(-keep).map((event) => ({
    taskId,
    roleName,
    runId,
    generation,
    progressId: event.payload.progressId as string,
    ...(typeof event.payload.sequence === "string"
      && Number.isSafeInteger(Number(event.payload.sequence))
      ? { sequence: Number(event.payload.sequence) }
      : {}),
    payload: { ...event.payload },
    receivedAt: progressAt(event)
  }));
  return {
    roleName,
    runId,
    generation,
    aggregate: {
      taskId,
      roleName,
      runId,
      generation,
      firstAt,
      lastAt,
      count: ordered.length,
      maxSequence,
      errorCount
    },
    window
  };
}

function compareProgressEvents(a: TaskEvent, b: TaskEvent): number {
  const seqA = numericSequence(a);
  const seqB = numericSequence(b);
  if (seqA !== null && seqB !== null && seqA !== seqB) return seqA - seqB;
  const atA = Date.parse(progressAt(a));
  const atB = Date.parse(progressAt(b));
  if (atA !== atB) return atA - atB;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

function numericSequence(event: TaskEvent): number | null {
  const raw = event.payload.sequence;
  if (typeof raw !== "string") return null;
  const value = Number(raw);
  return Number.isSafeInteger(value) ? value : null;
}

function progressAt(event: TaskEvent): string {
  const raw = event.payload.progressAt;
  if (typeof raw === "string" && Number.isFinite(Date.parse(raw))) return raw;
  return event.createdAt;
}

/**
 * Apply a plan to a staged Home. The telemetry windows/aggregates are imported
 * first and validated, then the semantic progress events are removed inside
 * one store transaction and validated again. Throws on any validation
 * failure; the caller must discard the staged Home in that case. A crash
 * between the two phases leaves the staged Home in the equivalent of
 * dual-write state (telemetry imported, semantic progress still present),
 * which is harmless and re-runnable.
 */
export function applyTelemetryCompaction(
  store: TaskStore,
  telemetry: TelemetryStore,
  plan: CompactionPlan,
  options: Readonly<{
    dryRun: boolean;
    source: string;
    terminalKeep?: number;
    now?: Date;
  }>
): CompactionReceipt {
  const now = options.now ?? new Date();
  const keep = options.terminalKeep ?? DEFAULT_TERMINAL_KEEP;
  if (!options.dryRun) {
    // Import first and validate the sidecar before touching semantic history:
    // a validation failure leaves the staged Home's semantic events intact.
    for (const task of plan.tasks) {
      for (const generation of task.generations) {
        telemetry.importGeneration(generation.window, generation.aggregate);
      }
    }
    validateAggregates(telemetry, plan);
    store.transaction(() => {
      for (const task of plan.tasks) {
        if (task.progressEventIds.length === 0) continue;
        store.removeEvents(task.taskId, task.progressEventIds);
      }
    });
    validateSemanticClean(store, plan);
  }
  return {
    schemaVersion: 1,
    createdAt: now.toISOString(),
    dryRun: options.dryRun,
    source: options.source,
    terminalKeep: keep,
    totals: plan.totals,
    tasks: plan.tasks.map((task) => ({
      taskId: task.taskId,
      removedProgressEvents: options.dryRun ? 0 : task.progressEventIds.length,
      generations: task.generations.map((generation) => generation.aggregate)
    })),
    validation: "passed"
  };
}

/**
 * Verify every planned Run/generation aggregate in the sidecar matches the
 * plan (count, first/last, max sequence) before semantic history is touched.
 */
function validateAggregates(
  telemetry: TelemetryStore,
  plan: CompactionPlan
): void {
  for (const task of plan.tasks) {
    for (const generation of task.generations) {
      const stored = telemetry.aggregateGeneration(
        generation.aggregate.taskId,
        generation.aggregate.roleName,
        generation.aggregate.runId,
        generation.aggregate.generation
      );
      if (stored === null) {
        throw new Error(`Compaction validation failed: missing aggregate for Run ${generation.aggregate.runId}.`);
      }
      const expected = generation.aggregate;
      if (
        stored.count !== expected.count
        || stored.firstAt !== expected.firstAt
        || stored.lastAt !== expected.lastAt
        || stored.maxSequence !== expected.maxSequence
        || stored.errorCount !== expected.errorCount
      ) {
        throw new Error(
          `Compaction validation failed: aggregate mismatch for Run ${expected.runId} `
          + `(expected count=${expected.count} first=${expected.firstAt} last=${expected.lastAt} `
          + `maxSequence=${String(expected.maxSequence)} errors=${expected.errorCount}; `
          + `got count=${stored.count} first=${stored.firstAt} last=${stored.lastAt} `
          + `maxSequence=${String(stored.maxSequence)} errors=${stored.errorCount}).`
        );
      }
    }
  }
}

/** Verify no planned progress event remains in semantic history. */
function validateSemanticClean(store: TaskStore, plan: CompactionPlan): void {
  for (const task of plan.tasks) {
    if (task.progressEventIds.length === 0) continue;
    const remaining = new Set(
      store.listEvents(task.taskId)
        .filter((event) => event.type === PROGRESS_EVENT_TYPE)
        .map((event) => event.id)
    );
    for (const id of task.progressEventIds) {
      if (remaining.has(id)) {
        throw new Error(`Compaction validation failed: progress event ${task.taskId}/${id} still present.`);
      }
    }
  }
}
