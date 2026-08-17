/**
 * Pure-memory, fixed-space command observation for the Controller socket.
 *
 * The core server owns route/built-in command observation: every authenticated
 * request is counted once at the routing layer, and a bounded unrefed scheduler
 * samples event-loop delay so an already-written request's pre-dispatch wait is
 * observable even when the loop is saturated by scheduler projections. The
 * FileTaskController composes these snapshots into its runtime status metric;
 * nothing here is persisted and every snapshot is O(1).
 */

export type ControllerRouteKind = "builtin" | "dispatched";
export type ControllerRouteOutcome = "success" | "failure";

export type ControllerRouteMetrics = Readonly<{
  received: number;
  completed: number;
  failed: number;
  inFlight: number;
  builtin: Readonly<{ completed: number; failed: number }>;
  dispatched: Readonly<{ completed: number; failed: number }>;
}>;

export type ControllerEventLoopDelayMetrics = Readonly<{
  samples: number;
  maximumLagMs: number;
  lagBuckets: Readonly<Record<string, number>>;
}>;

/**
 * The telemetry the core server hands to the status composer. The server owns
 * the instances; the FileTaskController only reads their snapshots.
 */
export type ControllerStatusTelemetry = Readonly<{
  commandObserver: ControllerCommandObserver;
  eventLoopDelay: ControllerEventLoopDelay;
}>;

const CONTROLLER_DELAY_BUCKETS_MS = [10, 50, 100, 250, 500, 1_000, 3_000] as const;

const DEFAULT_EVENT_LOOP_DELAY_INTERVAL_MS = 50;

const BUILTIN_METHODS = new Set([
  "controller.status",
  "controller.identity",
  "controller.stop",
  "controller.begin-handover",
  "controller.commit-handover",
  "controller.rollback-handover",
  "controller.handover-state"
]);

export function isBuiltinControllerMethod(method: string): boolean {
  return BUILTIN_METHODS.has(method);
}

export function monotonicMilliseconds(): number {
  return Number(process.hrtime.bigint()) / 1_000_000;
}

export type ControllerTelemetryHandle = Readonly<{
  unref(): void;
  close(): void;
}>;

/**
 * Scheduler seam for the delay sampler. Production uses an unrefed interval so
 * the sampler never keeps the process alive; tests drive a manual scheduler to
 * assert lag without real time.
 */
export type ControllerTelemetryScheduler = Readonly<{
  setInterval(callback: () => void, delayMs: number): ControllerTelemetryHandle;
}>;

export const productionTelemetryScheduler: ControllerTelemetryScheduler = {
  setInterval: (callback, delayMs) => {
    const timer = setInterval(callback, delayMs);
    timer.unref();
    return {
      unref: () => timer.unref(),
      close: () => clearInterval(timer)
    };
  }
};

export type ControllerCommandObservation = Readonly<{
  complete(kind: ControllerRouteKind, outcome: ControllerRouteOutcome): void;
}>;

/**
 * Counts routed commands once at the routing layer. Built-in routes
 * (controller.status/identity/stop) and dispatcher routes are observed
 * separately so the dispatcher's own service-time metric cannot be mistaken
 * for end-to-end latency and is never double-counted.
 */
export class ControllerCommandObserver {
  #received = 0;
  #completed = 0;
  #failed = 0;
  #inFlight = 0;
  #builtinCompleted = 0;
  #builtinFailed = 0;
  #dispatchedCompleted = 0;
  #dispatchedFailed = 0;

  start(): ControllerCommandObservation {
    this.#received += 1;
    this.#inFlight += 1;
    let completed = false;
    return {
      complete: (kind, outcome) => {
        if (completed) return;
        completed = true;
        this.#inFlight = Math.max(0, this.#inFlight - 1);
        this.#completed += 1;
        if (outcome === "failure") this.#failed += 1;
        if (kind === "builtin") {
          if (outcome === "failure") this.#builtinFailed += 1;
          else this.#builtinCompleted += 1;
        } else if (outcome === "failure") {
          this.#dispatchedFailed += 1;
        } else {
          this.#dispatchedCompleted += 1;
        }
      }
    };
  }

  snapshot(): ControllerRouteMetrics {
    return {
      received: this.#received,
      completed: this.#completed,
      failed: this.#failed,
      inFlight: this.#inFlight,
      builtin: {
        completed: this.#builtinCompleted,
        failed: this.#builtinFailed
      },
      dispatched: {
        completed: this.#dispatchedCompleted,
        failed: this.#dispatchedFailed
      }
    };
  }
}

/**
 * Bounded event-loop delay sampler. A fixed-cadence unrefed interval measures
 * how much later than expected it fires; that lag is the pre-dispatch wait an
 * already-written socket request experiences while the loop is busy. State is
 * a fixed counter set plus seven bucket counters, so memory is constant and
 * snapshots are O(1).
 */
export class ControllerEventLoopDelay {
  readonly #clock: () => number;
  readonly #scheduler: ControllerTelemetryScheduler;
  readonly #intervalMs: number;
  #handle: ControllerTelemetryHandle | undefined;
  #expectedAt = 0;
  #samples = 0;
  #maximumLagMs = 0;
  readonly #buckets = new Map<number, number>(
    CONTROLLER_DELAY_BUCKETS_MS.map((threshold) => [threshold, 0])
  );
  #stopped = false;

  constructor(
    clock: () => number = monotonicMilliseconds,
    scheduler: ControllerTelemetryScheduler = productionTelemetryScheduler,
    intervalMs: number = DEFAULT_EVENT_LOOP_DELAY_INTERVAL_MS
  ) {
    this.#clock = clock;
    this.#scheduler = scheduler;
    this.#intervalMs = intervalMs;
  }

  start(): void {
    if (this.#handle !== undefined || this.#stopped) return;
    this.#expectedAt = this.#clock() + this.#intervalMs;
    this.#handle = this.#scheduler.setInterval(
      () => this.#sample(),
      this.#intervalMs
    );
  }

  #sample(): void {
    if (this.#stopped) return;
    const lag = Math.max(0, this.#clock() - this.#expectedAt);
    this.#expectedAt = this.#clock() + this.#intervalMs;
    this.#samples += 1;
    const bounded = Math.ceil(lag);
    this.#maximumLagMs = Math.max(this.#maximumLagMs, bounded);
    for (const threshold of CONTROLLER_DELAY_BUCKETS_MS) {
      if (bounded <= threshold) {
        this.#buckets.set(threshold, (this.#buckets.get(threshold) ?? 0) + 1);
      }
    }
  }

  stop(): void {
    this.#stopped = true;
    this.#handle?.close();
    this.#handle = undefined;
  }

  snapshot(): ControllerEventLoopDelayMetrics {
    return {
      samples: this.#samples,
      maximumLagMs: this.#maximumLagMs,
      lagBuckets: Object.fromEntries(
        CONTROLLER_DELAY_BUCKETS_MS.map((threshold) => [
          `le${threshold}ms`,
          this.#buckets.get(threshold) ?? 0
        ])
      )
    };
  }
}
