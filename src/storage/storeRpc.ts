/**
 * Bounded RPC seam for the persistence Worker Thread (task-21, work-item-5).
 *
 * The main thread talks to the persistence worker (storage/persistenceWorker)
 * over a `MessageChannel` port. The backpressure, cancellation, and
 * fault-boundary machinery lives in the shared `core/boundedRpc` module; this
 * module adds the storage dialect:
 *
 *   - {@link AsyncTaskStore} ........ the async counterpart to `TaskStore`
 *     (design §6): every method returns a promise; the worker owns the
 *     `SqliteTaskStore` connection, the main thread never touches the db.
 *   - {@link AsyncTaskStoreClient} .. the client: serializes requests, applies
 *     the storage idempotency/dialect rules on top of the shared bounded RPC
 *     (outbox §5.4, `AbortSignal` cancellation §3.1, restart + replay §3.1).
 *   - {@link StoreCommand} .......... one variant per `TaskStore` op, so
 *     `transactionAsync` ships an ordered batch that the worker runs inside one
 *     `BEGIN IMMEDIATE … COMMIT` (§3.2).
 *
 * SQLite is the only product Store. `YUI_STORE_WORKER` controls whether its
 * connection lives in a Worker Thread; it does not select another authority.
 */
import {
  BoundedRpcClient,
  nextRequestId,
  type BoundedRpcProtocol,
  type SerializedError
} from "../core/boundedRpc.js";
import {
  StorageCancelledError,
  StorageConflictError,
  StorageRecordError,
  type TaskStore
} from "./taskStore.js";

// Re-exported for the persistence worker and existing importers.
export type { SerializedError };

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
  "readNextActionFacts",
  "readCompletionReadinessFacts",
  "listActiveTaskIds",
  "getTaskBrief",
  "listChangeSets",
  "getChangeSet",
  "listIntegrationAttempts",
  "getIntegrationAttempt",
  "listActiveDurableJobs",
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
  "listRuntimeSessionCandidates",
  "getRoleSession",
  "getWorkItem",
  "listWorkItems",
  "getTurn",
  "listTurns",
  "listPendingProviderRetries",
  "peekNextTurnId",
  "getReviewRound",
  "getActiveTurn",
  "getActiveExecutionLaneTurn",
  "listMessages",
  "getInputRequest",
  "listInputRequests",
  "listOpenInputRequests",
  "listAllInputRequests",
  "listDecisions",
  "getDecision",
  "listMilestones",
  "getMilestone",
  "listEvents",
  "getWorkMailbox",
  "listWorkMailboxes",
  "listReadyWorkMailboxes",
  "getPendingWakeup",
  "listPendingWakeups",
  "getLeaderFailure",
  "listTelemetry",
  "countTelemetry",
  "hasOutboxEntry",
  "listPendingOutbox"
]);

function isReadOnlyMethod(method: string): boolean {
  return READ_ONLY_STORE_METHODS.has(method);
}

// -- Error deserialization (storage dialect) ---------------------------------

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

// -- Storage protocol adapter -------------------------------------------------

function storageProtocol(
  home: string,
  options: RpcOptions
): BoundedRpcProtocol<WorkerRequest, WorkerResponse> {
  return {
    initRequest: () => ({
      kind: "init",
      home,
      ...(options.readPoolSize === undefined ? {} : { readPoolSize: options.readPoolSize }),
      ...(options.observerModule === undefined
        ? {}
        : { observerModule: String(options.observerModule) })
    }),
    cancelRequest: (requestId) => ({ kind: "cancel", requestId }),
    shutdownRequest: () => ({ kind: "shutdown" }),
    isReady: (response) => response.kind === "ready",
    responseRequestId: (response) => {
      if (response.kind === "ready") {
        throw new Error("ready response has no requestId.");
      }
      return response.requestId;
    },
    settle: (response, settlement) => {
      if (response.kind === "result") {
        settlement.resolve(response.result);
        return;
      }
      if (response.kind === "already-applied") {
        // The effect committed before a crash; the retry is deduped (§5.4). The
        // original result is not retained; callers needing it re-read. Observer
        // callers treat `undefined` as "applied".
        settlement.resolve(undefined);
        return;
      }
      if (response.kind === "error") {
        settlement.reject(deserializeError(response.error));
      }
    },
    abortError: (beforeSend) => new StorageCancelledError(
      beforeSend ? "Request aborted before it was sent." : "Request aborted."
    )
  };
}

// -- Client ------------------------------------------------------------------

/**
 * The main-thread client for the persistence worker. Implements
 * {@link AsyncTaskStore} (via a Proxy that forwards `TaskStore` methods as `call`
 * RPCs) plus {@link transactionAsync}, {@link invokeObserver}, and {@link close}.
 */
export class AsyncTaskStoreClient {
  readonly #home: string;
  readonly #options: RpcOptions;
  readonly #rpc: BoundedRpcClient<WorkerRequest, WorkerResponse>;

  constructor(home: string, options: RpcOptions = {}) {
    this.#home = home;
    this.#options = options;
    this.#rpc = new BoundedRpcClient(storageProtocol(home, options), {
      maxInFlight: options.maxInFlight,
      maxQueue: options.maxQueue,
      workerScript: options.workerScript ?? new URL("./persistenceWorker.js", import.meta.url)
    });
  }

  /** Invoke a TaskStore method over the RPC (used by the Proxy). */
  callStore(method: string, args: unknown[], options?: RpcCallOptions): Promise<unknown> {
    const requestId = options?.requestId ?? nextRequestId();
    return this.#rpc.send(
      requestId,
      {
        kind: "call",
        requestId,
        method,
        args,
        readOnly: isReadOnlyMethod(method)
      },
      { signal: options?.signal }
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
    return this.#rpc.send(
      requestId,
      {
        kind: "transaction",
        requestId,
        commands: wireCommands,
        ...(options?.expectedRevision === undefined ? {} : { expectedRevision: options.expectedRevision })
      },
      { signal: options?.signal }
    ) as Promise<T[]>;
  }

  /**
   * Invoke a controller observer method hosted by the worker (the
   * `FileSchedulerStoreAdapter` observer surface). The adapter's folds run in
   * the worker, off the main event loop.
   */
  invokeObserver(method: string, args: unknown[], options?: RpcCallOptions): Promise<unknown> {
    const requestId = options?.requestId ?? nextRequestId();
    return this.#rpc.send(
      requestId,
      { kind: "observer", requestId, method, args },
      { signal: options?.signal }
    );
  }

  /** Close the worker and release its connections. */
  close(): Promise<void> {
    return this.#rpc.close();
  }

  /** Currently in-flight requests (metrics/tests). */
  get inFlight(): number {
    return this.#rpc.inFlight;
  }

  /** Currently queued requests waiting for a slot (metrics/tests). */
  get queueDepth(): number {
    return this.#rpc.queueDepth;
  }

  /**
   * Test-only fault injection: abruptly terminate the worker (simulating a
   * crash) so the exit handler restarts it and replays unacknowledged requests
   * (§3.1 fault boundary). The pending requests stay pending; they resolve
   * after the restart + replay.
   */
  crashForTest(): Promise<void> {
    return this.#rpc.crashForTest();
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

/** Resolve the optional persistence worker for the current SQLite store. */
export function resolveStoreWorkerEnabledForHome(
  _home: string,
  env: NodeJS.ProcessEnv = process.env
): boolean {
  const flag = env.YUI_STORE_WORKER?.toLowerCase();
  if (flag === "1" || flag === "true") return true;
  if (flag === "0" || flag === "false") return false;
  return true;
}
