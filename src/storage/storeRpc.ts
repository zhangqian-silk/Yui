/**
 * Bounded RPC seam for the persistence Worker Thread (task-21, work-item-5).
 *
 * The main thread talks to the persistence worker (storage/persistenceWorker)
 * over a `MessageChannel` port. This module provides:
 *
 *   - {@link AsyncTaskStore} ........ the async counterpart to `TaskStore`
 *     (design §6): every method returns a promise; the worker owns the
 *     `SqliteTaskStore` connection, the main thread never touches the db.
 *   - {@link AsyncTaskStoreClient} .. the client: serializes requests, bounds
 *     in-flight requests (default 64) and queue depth, applies backpressure
 *     (callers await; the socket keeps draining), dedupes by `requestId`
 *     (outbox, §5.4), honours `AbortSignal` cancellation (§3.1), and restarts
 *     the worker + replays unacknowledged requests on crash (§3.1 fault boundary).
 *   - {@link StoreCommand} .......... one variant per `TaskStore` op, so
 *     `transactionAsync` ships an ordered batch that the worker runs inside one
 *     `BEGIN IMMEDIATE … COMMIT` (§3.2).
 *
 * The file `TaskStore` remains the default for CLI tools and tests; the worker
 * backend is opt-in via `YUI_STORE_BACKEND=sqlite` + `YUI_STORE_WORKER=1`
 * ({@link resolveStoreWorkerEnabled}). Rollback to the file store is a config
 * flip (§6).
 */
import { Worker, MessageChannel } from "node:worker_threads";
import type { MessagePort } from "node:worker_threads";
import {
  StorageCancelledError,
  StorageConflictError,
  StorageRecordError,
  type TaskStore
} from "./taskStore.js";

// -- Protocol ----------------------------------------------------------------

/** A single command in a `transactionAsync` batch (one variant per TaskStore op). */
export type StoreCommand = {
  [K in Exclude<keyof TaskStore, "transaction">]: TaskStore[K] extends (...args: infer A) => infer _R
    ? { op: K; args: A }
    : never;
}[Exclude<keyof TaskStore, "transaction">];

/** Requests sent main -> worker. */
export type WorkerRequest =
  | {
      kind: "init";
      home: string;
      readPoolSize?: number;
      /** Optional URL of a module exporting `FileSchedulerStoreAdapter` (the controller's observer host). */
      observerModule?: string;
    }
  | { kind: "call"; requestId: string; method: string; args: unknown[]; readOnly: boolean }
  | { kind: "transaction"; requestId: string; commands: ReadonlyArray<{ op: string; args: unknown[] }>; expectedRevision?: number }
  | { kind: "observer"; requestId: string; method: string; args: unknown[] }
  | { kind: "cancel"; requestId: string }
  | { kind: "shutdown" };

/** A serialized error crossing the thread boundary. */
export type SerializedError = Readonly<{
  name: string;
  message: string;
  stack?: string;
  code?: string;
}>;

/** Responses posted worker -> main. */
export type WorkerResponse =
  | { kind: "ready" }
  | { kind: "result"; requestId: string; result: unknown }
  | { kind: "already-applied"; requestId: string }
  | { kind: "error"; requestId: string; error: SerializedError };

// -- Async store interface ---------------------------------------------------

/** Per-call options for the bounded RPC. */
export type RpcCallOptions = Readonly<{
  /** Idempotency key. Writes are deduped via the durable outbox (§5.4). */
  requestId?: string;
  /** Abort signal. A cancelled request rolls back an open transaction (§3.1). */
  signal?: AbortSignal;
}>;

/** Options for {@link AsyncTaskStore.transactionAsync}. */
export type TransactionAsyncOptions = RpcCallOptions & {
  /**
   * Expected global revision. When set, the worker checks `home_meta.revision`
   * inside the same transaction and fails with {@link StorageConflictError} on
   * a mismatch (the cross-writer CAS, §3.2/§5.3).
   */
  expectedRevision?: number;
};

/**
 * The async counterpart to {@link TaskStore} (design §6). Every method is a
 * promise; the closure-based `transaction` is replaced by {@link transactionAsync}.
 */
export type AsyncTaskStore = {
  [K in Exclude<keyof TaskStore, "transaction">]: TaskStore[K] extends (...args: infer A) => infer R
    ? (...args: [...A, options?: RpcCallOptions]) => Promise<Awaited<R>>
    : TaskStore[K];
} & {
  /**
   * Run an ordered command batch inside one `BEGIN IMMEDIATE … COMMIT` on the
   * worker's single writer connection (§3.2). Read-then-write closures become
   * batches executed atomically in the worker. Returns one result per command.
   */
  transactionAsync<T = unknown>(
    commands: ReadonlyArray<StoreCommand>,
    options?: TransactionAsyncOptions
  ): Promise<T[]>;
  /** Close the worker and release its database connections. */
  close(): Promise<void>;
};

// -- Options -----------------------------------------------------------------

export type RpcOptions = Readonly<{
  /** Max in-flight requests (default 64, §3.1). */
  maxInFlight?: number;
  /** Max queued requests waiting for a slot (default 256, §3.1). */
  maxQueue?: number;
  /** Read-pool size in the worker (default 4). */
  readPoolSize?: number;
  /** Override the worker script URL (tests). */
  workerScript?: string | URL;
  /** Environment for backend resolution (defaults to process.env). */
  environment?: NodeJS.ProcessEnv;
  /** Optional observer module URL hosted by the worker (controller adapter). */
  observerModule?: string | URL;
}>;

// -- Read-only classification ------------------------------------------------

/**
 * TaskStore methods that do not mutate. Reads use the worker's read pool
 * (separate WAL connections that never take the write lock, §3.2). Everything
 * else is routed to the writer connection.
 */
const READ_ONLY_STORE_METHODS: ReadonlySet<string> = new Set([
  "rootDirectory",
  "getConfig",
  "getHomeIdentity",
  "getReviewConfig",
  "getRevision",
  "listConfiguredAgents",
  "getConfiguredAgent",
  "listProjects",
  "getProject",
  "listAgentProfiles",
  "getAgentProfile",
  "listGlobalRoles",
  "getGlobalRole",
  "getGlobalRoleSessionSet",
  "listGlobalRoleSessionSets",
  "listTasks",
  "getTask",
  "listActiveTaskIds",
  "getTaskBrief",
  "listChangeSets",
  "getChangeSet",
  "listIntegrationAttempts",
  "getIntegrationAttempt",
  "listRoles",
  "getRole",
  "listManagedWorkspaces",
  "listManagedWorkspace",
  "getManagedWorkspace",
  "getTaskWorkspace",
  "getWorkItemWorkspace",
  "getReviewRoundWorkspace",
  "getIntegrationWorkspace",
  "getRoleSessionSet",
  "getTaskRoleSessionSet",
  "listRoleSessionSets",
  "getRoleSession",
  "getWorkItem",
  "listWorkItems",
  "getAgentRun",
  "listAgentRuns",
  "peekNextAgentRunId",
  "getReviewRound",
  "listReviewRuns",
  "getActiveAgentRun",
  "getActiveExecutionLaneRun",
  "listMessages",
  "getInputRequest",
  "listInputRequests",
  "listAllInputRequests",
  "listDecisions",
  "getDecision",
  "listMilestones",
  "getMilestone",
  "listEvents",
  "getWorkMailbox",
  "listWorkMailboxes",
  "getPendingWakeup",
  "listPendingWakeups",
  "getLeaderFailure",
  "getOperatorNotification",
  "listTelemetry",
  "countTelemetry",
  "hasOutboxEntry",
  "listPendingOutbox"
]);

function isReadOnlyMethod(method: string): boolean {
  return READ_ONLY_STORE_METHODS.has(method);
}

// -- Bounded slot pool (backpressure) ----------------------------------------

/**
 * An async semaphore with a bounded waiter queue (§3.1). `acquire` waits when
 * all permits are in flight; when the waiter queue is full, callers wait on the
 * backpressure condition instead. Callers always await (they already return
 * promises), so the socket keeps accepting and draining — the main event loop
 * is never blocked.
 */
export class BoundedSlotPool {
  readonly #maxInFlight: number;
  #permits: number;
  readonly #maxQueue: number;
  #waiters: Array<() => void> = [];
  #backpressure: Array<() => void> = [];

  constructor(maxInFlight: number, maxQueue: number) {
    if (!Number.isSafeInteger(maxInFlight) || maxInFlight < 1) {
      throw new Error(`maxInFlight must be a positive integer: ${maxInFlight}`);
    }
    if (!Number.isSafeInteger(maxQueue) || maxQueue < 0) {
      throw new Error(`maxQueue must be a non-negative integer: ${maxQueue}`);
    }
    this.#maxInFlight = maxInFlight;
    this.#permits = maxInFlight;
    this.#maxQueue = maxQueue;
  }

  async acquire(): Promise<void> {
    // Backpressure: the waiter queue is full. Wait for it to drain before
    // queueing (the socket keeps draining; callers await without blocking).
    while (this.#waiters.length >= this.#maxQueue) {
      await new Promise<void>((resolve) => this.#backpressure.push(resolve));
    }
    if (this.#permits > 0) {
      this.#permits -= 1;
      return;
    }
    await new Promise<void>((resolve) => this.#waiters.push(resolve));
    // A released permit was handed directly to this waiter.
  }

  release(): void {
    const waiter = this.#waiters.shift();
    if (waiter !== undefined) {
      waiter();
      return;
    }
    this.#permits += 1;
    const drained = this.#backpressure.shift();
    if (drained !== null && drained !== undefined) drained();
  }

  /** Current queue depth (waiters), for tests/metrics. */
  get queueDepth(): number {
    return this.#waiters.length;
  }

  /** Currently in-flight permits, for tests/metrics. */
  get inFlight(): number {
    return this.#maxInFlight - this.#permits;
  }
}

// -- Error serialization -----------------------------------------------------

function serializeError(error: unknown): SerializedError {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
      ...(error.stack === undefined ? {} : { stack: error.stack }),
      ...("code" in error && typeof (error as { code?: unknown }).code === "string"
        ? { code: (error as { code: string }).code }
        : {})
    };
  }
  return { name: "Error", message: String(error) };
}

function deserializeError(serialized: SerializedError): Error {
  const { name, message } = serialized;
  if (name === "StorageConflictError") return new StorageConflictError(message);
  if (name === "StorageRecordError") return new StorageRecordError(message);
  if (name === "StorageCancelledError" || name === "AbortError") {
    return new StorageCancelledError(message);
  }
  const error = new Error(message);
  error.name = name;
  return error;
}

// -- Client ------------------------------------------------------------------

type PendingRequest = {
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: unknown) => void;
  readonly request: WorkerRequest;
  readonly abortListener?: (() => void) | undefined;
  slotReleased: boolean;
};

let requestCounter = 0;
function nextRequestId(): string {
  requestCounter += 1;
  return `rpc-${process.pid}-${Date.now().toString(36)}-${requestCounter.toString(36)}`;
}

/**
 * The main-thread client for the persistence worker. Implements
 * {@link AsyncTaskStore} (via a Proxy that forwards `TaskStore` methods as `call`
 * RPCs) plus {@link transactionAsync}, {@link invokeObserver}, and {@link close}.
 */
export class AsyncTaskStoreClient {
  readonly #home: string;
  readonly #options: RpcOptions;
  readonly #slots: BoundedSlotPool;
  readonly #pending = new Map<string, PendingRequest>();
  #worker: Worker | undefined;
  #port: MessagePort | undefined;
  #ready: Promise<void>;
  #readyResolve: (() => void) | undefined;
  #readyReject: ((error: unknown) => void) | undefined;
  #readyFired = false;
  #closed = false;
  #restarting = false;
  #generation = 0;

  constructor(home: string, options: RpcOptions = {}) {
    this.#home = home;
    this.#options = options;
    this.#slots = new BoundedSlotPool(
      options.maxInFlight ?? 64,
      options.maxQueue ?? 256
    );
    this.#ready = this.#newReadyPromise();
    this.#spawnWorker();
  }

  #newReadyPromise(): Promise<void> {
    this.#readyFired = false;
    return new Promise<void>((resolve, reject) => {
      this.#readyResolve = resolve;
      this.#readyReject = reject;
    });
  }

  #workerUrl(): URL {
    if (this.#options.workerScript !== undefined) {
      return this.#options.workerScript instanceof URL
        ? this.#options.workerScript
        : new URL(this.#options.workerScript);
    }
    return new URL("./persistenceWorker.js", import.meta.url);
  }

  #spawnWorker(): void {
    const generation = this.#generation;
    const worker = new Worker(this.#workerUrl(), {
      workerData: { home: this.#home }
    });
    const channel = new MessageChannel();
    worker.postMessage({ port: channel.port2 }, [channel.port2]);
    const port = channel.port1;
    this.#worker = worker;
    this.#port = port;

    port.on("message", (response: WorkerResponse) => {
      if (response.kind === "ready") {
        if (!this.#readyFired) {
          this.#readyFired = true;
          this.#readyResolve?.();
        }
        return;
      }
      this.#handleResponse(response);
    });
    worker.on("error", (error) => {
      // A worker-level error (e.g. uncaught exception). Before ready, fail the
      // ready handshake; after ready, the exit handler owns restart.
      if (!this.#readyFired) {
        this.#readyFired = true;
        this.#readyReject?.(error);
      }
    });
    worker.on("exit", (code) => {
      if (this.#closed || code === 0) return;
      if (generation !== this.#generation) return; // stale worker
      void this.#restart();
    });

    // Send init once the port is connected.
    const init: WorkerRequest = {
      kind: "init",
      home: this.#home,
      ...(this.#options.readPoolSize === undefined ? {} : { readPoolSize: this.#options.readPoolSize }),
      ...(this.#options.observerModule === undefined
        ? {}
        : { observerModule: String(this.#options.observerModule) })
    };
    port.postMessage(init);
  }

  #handleResponse(response: WorkerResponse): void {
    if (response.kind === "ready") return;
    const pending = this.#pending.get(response.requestId);
    if (pending === undefined) return; // stale/unknown (e.g. aborted)
    this.#pending.delete(response.requestId);
    if (!pending.slotReleased) {
      pending.slotReleased = true;
      this.#slots.release();
    }
    if (response.kind === "result") {
      pending.resolve(response.result);
    } else if (response.kind === "already-applied") {
      // The effect committed before a crash; the retry is deduped (§5.4). The
      // original result is not retained; callers needing it re-read. Observer
      // callers treat `undefined` as "applied".
      pending.resolve(undefined);
    } else {
      pending.reject(deserializeError(response.error));
    }
  }

  async #restart(): Promise<void> {
    if (this.#restarting || this.#closed) return;
    this.#restarting = true;
    try {
      // Brief backoff to avoid a hot crash loop.
      await new Promise((resolve) => setTimeout(resolve, 10));
      this.#generation += 1;
      this.#port?.close();
      this.#ready = this.#newReadyPromise();
      this.#spawnWorker();
      await this.#ready;
      // Replay unacknowledged requests (§3.1 fault boundary). Writes are
      // deduped by the durable outbox; reads re-execute. The original promises
      // are still pending and resolve when the new responses arrive.
      for (const pending of this.#pending.values()) {
        this.#port?.postMessage(pending.request);
      }
    } catch (error) {
      // Give up: fail all pending requests and release their slots.
      const failure = error instanceof Error ? error : new Error(String(error));
      for (const [id, pending] of this.#pending) {
        this.#pending.delete(id);
        if (!pending.slotReleased) {
          pending.slotReleased = true;
          this.#slots.release();
        }
        pending.reject(failure);
      }
    } finally {
      this.#restarting = false;
    }
  }

  async #doSend(
    kind: "call" | "transaction" | "observer",
    request: Extract<WorkerRequest, { kind: typeof kind }>,
    options?: RpcCallOptions
  ): Promise<unknown> {
    if (this.#closed) return Promise.reject(new Error("AsyncTaskStoreClient is closed."));
    await this.#ready;
    await this.#slots.acquire();
    if (this.#closed) {
      this.#slots.release();
      return Promise.reject(new Error("AsyncTaskStoreClient is closed."));
    }
    return new Promise<unknown>((resolve, reject) => {
      const requestId = request.requestId;
      let abortListener: (() => void) | undefined;
      const signal = options?.signal;
      if (signal !== undefined) {
        if (signal.aborted) {
          this.#slots.release();
          reject(new StorageCancelledError("Request aborted before it was sent."));
          return;
        }
        abortListener = () => {
          // Best-effort cancel; the worker rolls back an open transaction if it
          // observes the signal before commit (§3.1). Already-committed effects
          // are not undone.
          try {
            this.#port?.postMessage({ kind: "cancel", requestId } satisfies WorkerRequest);
          } catch {
            // Port may be gone.
          }
          const pending = this.#pending.get(requestId);
          if (pending !== undefined && !pending.slotReleased) {
            pending.slotReleased = true;
            this.#slots.release();
          }
          this.#pending.delete(requestId);
          reject(new StorageCancelledError("Request aborted."));
        };
        signal.addEventListener("abort", abortListener, { once: true });
      }
      this.#pending.set(requestId, {
        resolve: (value) => {
          if (abortListener !== undefined && signal !== undefined) {
            signal.removeEventListener("abort", abortListener);
          }
          resolve(value);
        },
        reject: (error) => {
          if (abortListener !== undefined && signal !== undefined) {
            signal.removeEventListener("abort", abortListener);
          }
          reject(error);
        },
        abortListener,
        request,
        slotReleased: false
      });
      this.#port?.postMessage(request);
    });
  }

  /** Invoke a TaskStore method over the RPC (used by the Proxy). */
  callStore(method: string, args: unknown[], options?: RpcCallOptions): Promise<unknown> {
    const requestId = options?.requestId ?? nextRequestId();
    return this.#doSend(
      "call",
      {
        kind: "call",
        requestId,
        method,
        args,
        readOnly: isReadOnlyMethod(method)
      },
      options
    );
  }

  /** Run a command batch atomically in the worker (§3.2). */
  transactionAsync<T = unknown>(
    commands: ReadonlyArray<StoreCommand>,
    options?: TransactionAsyncOptions
  ): Promise<T[]> {
    const requestId = options?.requestId ?? nextRequestId();
    const wireCommands = commands.map((command) => ({
      op: command.op,
      args: command.args as unknown[]
    }));
    return this.#doSend(
      "transaction",
      {
        kind: "transaction",
        requestId,
        commands: wireCommands,
        ...(options?.expectedRevision === undefined ? {} : { expectedRevision: options.expectedRevision })
      },
      options
    ) as Promise<T[]>;
  }

  /**
   * Invoke a controller observer method hosted by the worker (the
   * `FileSchedulerStoreAdapter` observer surface). The adapter's folds run in
   * the worker, off the main event loop.
   */
  invokeObserver(method: string, args: unknown[], options?: RpcCallOptions): Promise<unknown> {
    const requestId = options?.requestId ?? nextRequestId();
    return this.#doSend(
      "observer",
      { kind: "observer", requestId, method, args },
      options
    );
  }

  /** Close the worker and release its connections. */
  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    // Fail any requests still waiting on the ready handshake.
    if (!this.#readyFired) {
      this.#readyFired = true;
      this.#readyReject?.(new Error("AsyncTaskStoreClient closed before ready."));
    }
    // Reject all in-flight requests; their slots are released.
    for (const [id, pending] of this.#pending) {
      this.#pending.delete(id);
      if (!pending.slotReleased) {
        pending.slotReleased = true;
        this.#slots.release();
      }
      pending.reject(new Error("AsyncTaskStoreClient closed."));
    }
    try {
      this.#port?.postMessage({ kind: "shutdown" } satisfies WorkerRequest);
    } catch {
      // Worker may already be gone.
    }
    // Give the worker a moment to exit cleanly.
    await new Promise((resolve) => setTimeout(resolve, 20));
    try {
      await this.#worker?.terminate();
    } catch {
      // Already terminated.
    }
    this.#port?.close();
  }

  /** Currently in-flight requests (metrics/tests). */
  get inFlight(): number {
    return this.#slots.inFlight;
  }

  /** Currently queued requests waiting for a slot (metrics/tests). */
  get queueDepth(): number {
    return this.#slots.queueDepth;
  }

  /**
   * Test-only fault injection: abruptly terminate the worker (simulating a
   * crash) so the exit handler restarts it and replays unacknowledged requests
   * (§3.1 fault boundary). The pending requests stay pending; they resolve
   * after the restart + replay.
   */
  async crashForTest(): Promise<void> {
    await this.#worker?.terminate();
  }
}

/**
 * Open an {@link AsyncTaskStore} backed by the persistence worker. The returned
 * object is a Proxy that forwards `TaskStore` methods as RPCs; `transactionAsync`
 * and `close` are handled directly.
 */
export function openAsyncTaskStoreClient(
  home: string,
  options: RpcOptions = {}
): AsyncTaskStore {
  const client = new AsyncTaskStoreClient(home, options);
  const proxy = new Proxy(client, {
    get(target, property) {
      if (property === "then") return undefined; // not promise-like
      if (property in target) {
        // Access on the target (not the proxy) so getters that touch private
        // fields (#slots, etc.) resolve against the class instance.
        const value = Reflect.get(target, property);
        if (typeof value === "function") return value.bind(target);
        return value;
      }
      if (typeof property === "string") {
        return (...args: unknown[]) => {
          const options = args.length > 0 && isRpcCallOptions(args[args.length - 1])
            ? (args.pop() as RpcCallOptions)
            : undefined;
          return target.callStore(property, args, options);
        };
      }
      return undefined;
    }
  }) as unknown as AsyncTaskStore;
  return proxy;
}

function isRpcCallOptions(value: unknown): value is RpcCallOptions {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return "requestId" in record || "signal" in record;
}

/**
 * Resolve whether the persistence worker backend is enabled (design §6).
 * The worker requires the SQLite backend (`YUI_STORE_BACKEND=sqlite`) and is
 * opt-in via `YUI_STORE_WORKER=1`. The file store remains the default.
 */
export function resolveStoreWorkerEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  if (env.YUI_STORE_BACKEND?.toLowerCase() !== "sqlite") return false;
  const flag = env.YUI_STORE_WORKER;
  return flag === "1" || flag?.toLowerCase() === "true";
}
