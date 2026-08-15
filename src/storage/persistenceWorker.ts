/**
 * Persistence Worker Thread (task-21, work-item-5).
 *
 * The worker owns the {@link SqliteTaskStore} connection: one writer connection
 * (single-writer, `BEGIN IMMEDIATE`) plus a small read pool (separate WAL
 * connections that never take the write lock, §3.2). The main thread never
 * touches the db; it sends commands over a `MessageChannel` port and receives
 * results.
 *
 * Protocol (see storeRpc.ts):
 *   main -> worker: init | call | transaction | observer | cancel | shutdown
 *   worker -> main: ready | result | already-applied | error
 *
 * Semantics:
 *   - Writes with a `requestId` are idempotent: the worker consults the durable
 *     outbox before executing and records the effect in the same transaction
 *     (§5.4). A retried write after a crash returns `already-applied`.
 *   - `transaction` runs an ordered command batch inside one
 *     `BEGIN IMMEDIATE … COMMIT` on the writer (§3.2), yielding between commands
 *     so a `cancel` can roll back an open transaction (§3.1). Committed batches
 *     are not undone.
 *   - `expectedRevision` enforces the global revision CAS in the same txn
 *     (§5.3); a mismatch fails with `StorageConflictError`.
 *   - `cancel` is processed immediately (bypasses the serial queue) so it can
 *     interrupt a yielding batch.
 *   - `observer` invokes a controller observer method hosted by the worker
 *     (the `FileSchedulerStoreAdapter` folds run here, off the main event loop).
 *
 * `synchronous=FULL` is never weakened; the worker opens the store with the same
 * pragmatics as the in-process path (WAL, FULL, busy_timeout).
 */
import { parentPort } from "node:worker_threads";
import type { MessagePort } from "node:worker_threads";
import { SqliteTaskStore } from "./sqliteStore.js";
import {
  StorageCancelledError,
  StorageConflictError,
  StorageRecordError
} from "./taskStore.js";
import type {
  SerializedError,
  WorkerRequest,
  WorkerResponse
} from "./storeRpc.js";

// -- error serialization (mirrors storeRpc.ts) -------------------------------

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

const state: {
  writer: SqliteTaskStore | undefined;
  readers: SqliteTaskStore[];
  readIndex: number;
  observer: ObserverHost | undefined;
  cancelled: Set<string>;
  queue: Promise<void>;
  port: MessagePort | undefined;
} = {
  writer: undefined,
  readers: [],
  readIndex: 0,
  observer: undefined,
  cancelled: new Set(),
  queue: Promise.resolve(),
  port: undefined
};

function post(message: WorkerResponse): void {
  state.port?.postMessage(message);
}

function nextReader(): SqliteTaskStore {
  const reader = state.readers[state.readIndex % state.readers.length];
  state.readIndex += 1;
  return reader;
}

function enqueue(fn: () => Promise<void>): void {
  state.queue = state.queue.then(fn).catch((error) => {
    // Backstop: a handler threw without posting a response. Fail the worker
    // rather than hang the caller.
    console.error("[persistenceWorker] unhandled handler error:", error);
  });
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
  post({ kind: "ready" });
}

async function handleCall(request: Extract<WorkerRequest, { kind: "call" }>): Promise<void> {
  const { requestId, method, args, readOnly } = request;
  try {
    if (readOnly) {
      const result = invokeMethod(nextReader(), method, args);
      post({ kind: "result", requestId, result });
      return;
    }
    // Write. With a requestId, make it idempotent via the durable outbox
    // (§5.4): skip if already committed, otherwise record the effect in the
    // same transaction. The worker is single-threaded, so the check and the
    // write are race-free; the UNIQUE constraint is the backstop.
    const writer = state.writer;
    if (writer === undefined) throw new Error("Worker not initialized.");
    if (requestId !== undefined && writer.hasOutboxEntry(requestId)) {
      post({ kind: "already-applied", requestId });
      return;
    }
    const result = writer.transaction(
      (store) => invokeMethod(store, method, args),
      requestId === undefined ? undefined : { requestId }
    );
    post({ kind: "result", requestId, result });
  } catch (error) {
    post({ kind: "error", requestId, error: serializeError(error) });
  }
}

async function handleTransaction(
  request: Extract<WorkerRequest, { kind: "transaction" }>
): Promise<void> {
  const { requestId, commands, expectedRevision } = request;
  const writer = state.writer;
  if (writer === undefined) {
    post({ kind: "error", requestId, error: serializeError(new Error("Worker not initialized.")) });
    return;
  }
  try {
    // Idempotent replay: a batch that committed before a crash is not re-run.
    if (writer.hasOutboxEntry(requestId)) {
      post({ kind: "already-applied", requestId });
      return;
    }
    const shouldCancel = () => state.cancelled.has(requestId);
    const results = await writer.transactionAsyncBatch(commands, {
      requestId,
      ...(expectedRevision === undefined ? {} : { expectedRevision }),
      shouldCancel
    });
    state.cancelled.delete(requestId);
    post({ kind: "result", requestId, result: results });
  } catch (error) {
    state.cancelled.delete(requestId);
    post({ kind: "error", requestId, error: serializeError(error) });
  }
}

async function handleObserver(request: Extract<WorkerRequest, { kind: "observer" }>): Promise<void> {
  const { requestId, method, args } = request;
  try {
    if (state.observer === undefined) {
      throw new Error("Worker has no observer host (observerModule not provided at init).");
    }
    const result = state.observer.invoke(method, args);
    post({ kind: "result", requestId, result });
  } catch (error) {
    post({ kind: "error", requestId, error: serializeError(error) });
  }
}

async function handleShutdown(): Promise<void> {
  try {
    for (const reader of state.readers) {
      try { reader.close(); } catch { /* already closed */ }
    }
    try { state.writer?.close(); } catch { /* already closed */ }
  } finally {
    process.exit(0);
  }
}

// -- message dispatch --------------------------------------------------------

function dispatch(message: WorkerRequest): void {
  switch (message.kind) {
    case "cancel":
      // Process immediately so a yielding transaction batch can observe it
      // between commands (§3.1).
      state.cancelled.add(message.requestId);
      return;
    case "shutdown":
      void handleShutdown();
      return;
    case "init":
      enqueue(() => handleInit(message));
      return;
    case "call":
      enqueue(() => handleCall(message));
      return;
    case "transaction":
      enqueue(() => handleTransaction(message));
      return;
    case "observer":
      enqueue(() => handleObserver(message));
      return;
    default: {
      const exhaustive: never = message;
      console.error("[persistenceWorker] unknown request:", exhaustive);
    }
  }
}

// -- bootstrap ----------------------------------------------------------------

const port = parentPort;
if (port === null) {
  throw new Error("persistenceWorker must be run as a worker thread.");
}

port.once("message", (value: { port: MessagePort }) => {
  const messagePort = value.port;
  state.port = messagePort;
  messagePort.on("message", (message: WorkerRequest) => {
    try {
      dispatch(message);
    } catch (error) {
      // A synchronous dispatch failure: surface it. Init failures crash the
      // worker (the client restarts); request failures are posted per-handler.
      console.error("[persistenceWorker] dispatch error:", error);
    }
  });
  messagePort.on("messageerror", (error) => {
    console.error("[persistenceWorker] message deserialization error:", error);
  });
});
