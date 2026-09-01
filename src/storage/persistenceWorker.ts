/**
 * Persistence Worker Thread (task-21, work-item-5).
 *
 * The worker owns the {@link SqliteTaskStore} connection: one writer connection
 * (single-writer, `BEGIN IMMEDIATE`) plus a small read pool (separate WAL
 * connections that never take the write lock, §3.2). The main thread never
 * touches the db; it sends commands over a `MessageChannel` port and receives
 * results.
 *
 * The port handshake, dispatch, cancellation observation, and error
 * serialization are provided by the shared `core/boundedRpc` worker host
 * (`runRpcWorker`); this module supplies the storage dialect:
 *
 *   - `call` ......... a `TaskStore` method. Reads use the read pool; writes
 *                      run on the writer inside a transaction and are made
 *                      idempotent via the durable outbox (§5.4): a retried
 *                      write after a crash returns `already-applied`.
 *   - `transaction` .. an ordered command batch inside one
 *                      `BEGIN IMMEDIATE … COMMIT` on the writer (§3.2),
 *                      yielding between commands so a `cancel` can roll back an
 *                      open transaction (§3.1). Committed batches are not undone.
 *   - `observer` ..... a controller observer method hosted by the worker (the
 *                      `FileSchedulerStoreAdapter` folds run here, off the main
 *                      event loop).
 *   - `expectedRevision` enforces the global revision CAS in the same txn
 *                      (§5.3); a mismatch fails with `StorageConflictError`.
 *
 * `synchronous=FULL` is never weakened; the worker opens the store with the same
 * pragmas as the in-process path (WAL, FULL, busy_timeout).
 */
import { runRpcWorker } from "../core/boundedRpc.js";
import { SqliteTaskStore } from "./sqliteStore.js";
import { StorageRecordError } from "./taskStore.js";
import type {
  WorkerRequest,
  WorkerResponse
} from "./storeRpc.js";

// -- method invocation -------------------------------------------------------

function invokeMethod(target: object, method: string, args: readonly unknown[]): unknown {
  const fn = (target as Record<string, unknown>)[method];
  if (typeof fn !== "function") {
    throw new StorageRecordError(`Unknown store method: ${method}`);
  }
  return (fn as (...callArgs: unknown[]) => unknown).apply(target, args as unknown[]);
}

// -- worker state ------------------------------------------------------------

type ObserverHost = {
  invoke(method: string, args: readonly unknown[]): unknown;
};

/**
 * Sentinel returned by a handler when the durable outbox already records the
 * request's effect (§5.4). The host's `result` builder maps it to an
 * `already-applied` response. Store results are plain JSON data, so a Symbol
 * sentinel can never collide with a real result.
 */
const ALREADY_APPLIED = Symbol("already-applied");

const state: {
  writer: SqliteTaskStore | undefined;
  readers: SqliteTaskStore[];
  readIndex: number;
  observer: ObserverHost | undefined;
  cancelled: Set<string>;
} = {
  writer: undefined,
  readers: [],
  readIndex: 0,
  observer: undefined,
  cancelled: new Set()
};

function nextReader(): SqliteTaskStore {
  const reader = state.readers[state.readIndex % state.readers.length];
  state.readIndex += 1;
  return reader;
}

// -- request handlers --------------------------------------------------------

async function handleInit(request: Extract<WorkerRequest, { kind: "init" }>): Promise<void> {
  const writer = new SqliteTaskStore(request.home);
  const poolSize = request.readPoolSize ?? 4;
  const readers: SqliteTaskStore[] = [];
  for (let index = 0; index < poolSize; index += 1) {
    readers.push(new SqliteTaskStore(request.home));
  }
  state.writer = writer;
  state.readers = readers;

  if (request.observerModule !== undefined) {
    const module = (await import(request.observerModule)) as Record<string, unknown>;
    const Adapter = module.FileSchedulerStoreAdapter as
      | (new (store: SqliteTaskStore) => ObserverHost)
      | undefined;
    if (Adapter === undefined) {
      throw new Error(
        `Observer module ${request.observerModule} does not export FileSchedulerStoreAdapter.`
      );
    }
    const host = new Adapter(writer);
    state.observer = {
      invoke(method, args) {
        return invokeMethod(host, method, args);
      }
    };
  }
}

async function handleCall(request: Extract<WorkerRequest, { kind: "call" }>): Promise<unknown> {
  const { requestId, method, args, readOnly } = request;
  if (readOnly) {
    return invokeMethod(nextReader(), method, args);
  }
  // Write. With a requestId, make it idempotent via the durable outbox
  // (§5.4): skip if already committed, otherwise record the effect in the
  // same transaction. The worker is single-threaded, so the check and the
  // write are race-free; the UNIQUE constraint is the backstop.
  const writer = state.writer;
  if (writer === undefined) throw new Error("Worker not initialized.");
  if (writer.hasOutboxEntry(requestId)) {
    return ALREADY_APPLIED;
  }
  return writer.transaction(
    (store) => invokeMethod(store, method, args),
    { requestId }
  );
}

async function handleTransaction(
  request: Extract<WorkerRequest, { kind: "transaction" }>
): Promise<unknown> {
  const { requestId, commands, expectedRevision } = request;
  const writer = state.writer;
  if (writer === undefined) {
    throw new Error("Worker not initialized.");
  }
  // Idempotent replay: a batch that committed before a crash is not re-turn.
  if (writer.hasOutboxEntry(requestId)) {
    return ALREADY_APPLIED;
  }
  const shouldCancel = (): boolean => state.cancelled.has(requestId);
  try {
    return await writer.transactionAsyncBatch(commands, {
      requestId,
      ...(expectedRevision === undefined ? {} : { expectedRevision }),
      shouldCancel
    });
  } finally {
    state.cancelled.delete(requestId);
  }
}

async function handleObserver(request: Extract<WorkerRequest, { kind: "observer" }>): Promise<unknown> {
  if (state.observer === undefined) {
    throw new Error("Worker has no observer host (observerModule not provided at init).");
  }
  return state.observer.invoke(request.method, request.args);
}

// -- worker host --------------------------------------------------------------

runRpcWorker<WorkerRequest, WorkerResponse>({
  serial: true,
  kindOf: (request) => {
    switch (request.kind) {
      case "init":
        return "init";
      case "cancel":
        return "cancel";
      case "shutdown":
        return "shutdown";
      case "call":
      case "transaction":
      case "observer":
        return "request";
    }
  },
  requestIdOf: (request) => {
    switch (request.kind) {
      case "call":
      case "transaction":
      case "observer":
      case "cancel":
        return request.requestId;
      case "init":
      case "shutdown":
        return undefined;
    }
  },
  init: (request) => handleInit(request as Extract<WorkerRequest, { kind: "init" }>),
  handle: (request) => {
    switch (request.kind) {
      case "call":
        return handleCall(request);
      case "transaction":
        return handleTransaction(request);
      case "observer":
        return handleObserver(request);
      case "init":
      case "cancel":
      case "shutdown":
        throw new Error(`Unexpected request kind for handle: ${request.kind}`);
    }
  },
  cancel: (requestId) => {
    state.cancelled.add(requestId);
  },
  shutdown: async () => {
    for (const reader of state.readers) {
      try { reader.close(); } catch { /* already closed */ }
    }
    try { state.writer?.close(); } catch { /* already closed */ }
  },
  ready: () => ({ kind: "ready" }),
  result: (requestId, value) => (
    value === ALREADY_APPLIED
      ? { kind: "already-applied", requestId }
      : { kind: "result", requestId, result: value }
  ),
  error: (requestId, error) => ({ kind: "error", requestId, error })
});
