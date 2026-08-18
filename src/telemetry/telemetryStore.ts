import type { TaskEvent } from "../event/taskEvent.js";
import type { TelemetryMode } from "./telemetryConfig.js";

/**
 * One provider progress observation routed to the telemetry sidecar.
 * `generation` is the launch/session generation the progress belongs to;
 * `sequence` is the provider's monotonic per-turn counter when known.
 */
export type TelemetryProgressEntry = Readonly<{
  taskId: string;
  roleName: string;
  runId: string;
  generation: string;
  progressId: string;
  sequence?: number;
  payload: Readonly<Record<string, string>>;
  receivedAt: string;
}>;

/**
 * Per-Run progress summary. `count` is the total number of progress
 * observations ever recorded for the Run (including rows pruned from the
 * retained window); the window and the aggregate are both bounded.
 */
export type TelemetryAggregate = Readonly<{
  taskId: string;
  roleName: string;
  runId: string;
  generation: string;
  firstAt: string;
  lastAt: string;
  count: number;
  maxSequence: number | null;
  errorCount: number;
}>;

export type TelemetryHealth = Readonly<{
  mode: TelemetryMode;
  /** False when the sidecar is unavailable; the semantic lane is unaffected. */
  available: boolean;
  /** Observations dropped because the sidecar was unavailable or overloaded. */
  dropped: number;
  /** Observations folded onto an already-pending/newer row for the same key. */
  coalesced: number;
  lastError: string | null;
  /** Retained telemetry rows across all Tasks. */
  rows: number;
}>;

export type TelemetryPage<T> = Readonly<{
  items: readonly T[];
  /** Offset for the next page, or null when this was the last page. */
  nextOffset: number | null;
}>;

/**
 * Write side of the sidecar. `observe` is best-effort and MUST NOT throw:
 * telemetry is an observation fact, so a sidecar failure only increments
 * `dropped` and records a health warning. Semantic terminal/yield writes
 * always take priority and are never blocked by this interface.
 */
export interface TelemetrySink {
  readonly mode: TelemetryMode;
  observe(entry: TelemetryProgressEntry): void;
  health(): TelemetryHealth;
  close(): Promise<void>;
}

/**
 * Read side of the sidecar. All reads are cold/bounded: default Task context
 * never loads full progress history — it uses aggregates and the latest row
 * per Run; full history is paged by Task ID.
 */
export interface TelemetryReader {
  count(taskId: string, runId?: string): number;
  list(
    taskId: string,
    runId?: string,
    page?: Readonly<{ limit: number; offset: number }>
  ): TelemetryPage<TelemetryProgressEntry>;
  /** Merged summary across all generations of one Run, or null when unknown. */
  aggregate(taskId: string, runId: string): TelemetryAggregate | null;
  /** Exact summary for one Run/generation, or null when unknown. */
  aggregateGeneration(
    taskId: string,
    roleName: string,
    runId: string,
    generation: string
  ): TelemetryAggregate | null;
  /** All per-generation aggregates for one Task (retention/status reads). */
  listRunAggregates(taskId: string): TelemetryAggregate[];
  /**
   * Monotonic counter of applied writes. Consumers that cache projections
   * derived from telemetry (for example the scheduler stall fold) include it
   * in their cache key so bounded-mode liveness stays fresh.
   */
  revision(): number;
  /**
   * One synthesized `runtime.provider-turn-progress` TaskEvent per Run (the
   * latest observation), so existing liveness/stall projections keep working
   * when progress is no longer appended to semantic events (bounded mode).
   */
  latestProgressEvents(taskId: string): TaskEvent[];
}

export interface TelemetryStore extends TelemetrySink, TelemetryReader {
  /**
   * Terminal retention: keep the newest `keep` rows per
   * (task, role, run, generation) and delete older ones. The aggregate is
   * preserved. Returns the number of rows deleted.
   */
  pruneGeneration(
    taskId: string,
    roleName: string,
    runId: string,
    generation: string,
    keep?: number
  ): number;
  /**
   * Active-Run hard cap: trim oldest rows across the Run beyond `cap`.
   * Returns the number of rows deleted.
   */
  capRun(taskId: string, runId: string, cap?: number): number;
  /**
   * Bulk-import one generation's retained window and authoritative aggregate
   * (historical compaction). Synchronous and transactional; bypasses the
   * coalescing ingress queue because the caller already validated the data.
   */
  importGeneration(
    entries: readonly TelemetryProgressEntry[],
    aggregate: TelemetryAggregate
  ): void;
  /** Block until all queued observations have been flushed. */
  flush(): Promise<void>;
}

/**
 * Wiring bundle consumed by the scheduler store adapter: the active mode
 * plus the sidecar's write and read sides.
 */
export type SchedulerTelemetry = Readonly<{
  mode: TelemetryMode;
  sink: TelemetrySink;
  reader: TelemetryReader;
}>;

/** No-op sink for `legacy` mode and for callers without a sidecar. */
export class NullTelemetrySink implements TelemetrySink {
  constructor(readonly mode: TelemetryMode = "legacy") {}
  observe(_entry: TelemetryProgressEntry): void {}
  health(): TelemetryHealth {
    return {
      mode: this.mode,
      available: false,
      dropped: 0,
      coalesced: 0,
      lastError: null,
      rows: 0
    };
  }
  async close(): Promise<void> {}
}
