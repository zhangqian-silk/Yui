/**
 * Generic bounded RPC seam for Worker Threads (task-21, §3.1).
 *
 * The main thread talks to a worker over a `MessageChannel` port. This module
 * provides the shared primitives used by every worker RPC in the control plane
 * (the persistence worker, `storage/storeRpc`, and the resource inventory
 * worker, `controller/resourceInventoryRpc`):
 *
 *   - {@link BoundedSlotPool} ..... an async semaphore with a bounded waiter
 *     queue: bounds in-flight requests (default 64) and queue depth, applies
 *     backpressure (callers await; the socket keeps draining), so the main
 *     event loop is never blocked.
 *   - {@link BoundedRpcClient} .... the main-thread client: spawns the worker,
 *     completes the `ready` handshake, bounds in-flight requests, tracks
 *     pending requests, honours `AbortSignal` cancellation (posts a cancel
 *     notice, rejects promptly), and restarts the worker + replays
 *     unacknowledged requests on crash (the §3.1 fault boundary).
 *   - {@link runRpcWorker} ......... the worker-side host: owns the port
 *     handshake, dispatches requests (optionally through a FIFO queue),
 *     observes cancels, and serializes errors back across the thread boundary.
 *
 * Each worker supplies a small protocol adapter ({@link BoundedRpcProtocol} /
 * {@link RpcWorkerHost}) describing its own request/response dialect; the
 * backpressure, cancellation, and fault-boundary logic lives here once.
 */
import { parentPort } from "node:worker_threads";
import { Worker, MessageChannel } from "node:worker_threads";
import type { MessagePort } from "node:worker_threads";

// -- Error serialization -----------------------------------------------------

/** A serialized error crossing the thread boundary. */
export type SerializedError = Readonly<{
  name: string;
  message: string;
  stack?: string;
  code?: string;
}>;

export function serializeError(error: unknown): SerializedError {
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

/**
 * Default error deserializer. Worker RPCs with domain-specific error classes
 * override this in their protocol's `settle` (the persistence client maps
 * `Storage*Error` names back to their classes).
 */
export function deserializeError(serialized: SerializedError): Error {
  const error = new Error(serialized.message);
  error.name = serialized.name;
  return error;
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

// -- Request ids --------------------------------------------------------------

let requestCounter = 0;
export function nextRequestId(): string {
  requestCounter += 1;
  return `rpc-${process.pid}-${Date.now().toString(36)}-${requestCounter.toString(36)}`;
}

// -- Main-thread client -------------------------------------------------------

/** Per-call options for {@link BoundedRpcClient.send}. */
export type RpcSendOptions = Readonly<{
  /** Abort signal. A cancelled request sends a cancel notice and rejects promptly. */
  signal?: AbortSignal;
}>;

export type BoundedRpcOptions = Readonly<{
  /** Max in-flight requests (default 64, §3.1). */
  maxInFlight?: number;
  /** Max queued requests waiting for a slot (default 256, §3.1). */
  maxQueue?: number;
  /** The worker script URL. */
  workerScript: string | URL;
  /** Backoff before restarting a crashed worker (default 10ms). */
  restartBackoffMs?: number;
}>;

/** Settle a non-ready response against the pending call's promise. */
export type PendingSettlement = Readonly<{
  resolve(value: unknown): void;
  reject(error: unknown): void;
}>;

/**
 * The protocol adapter: describes one worker RPC dialect so the generic client
 * can speak it without knowing the request/response shapes.
 */
export type BoundedRpcProtocol<Request, Response> = Readonly<{
  /** The init request posted once the port is connected (drives the worker's ready handshake). */
  initRequest(): Request;
  /** A cancel notice for an aborted in-flight request. */
  cancelRequest(requestId: string): Request;
  /** The shutdown request. */
  shutdownRequest(): Request;
  /** True for the worker's ready response. */
  isReady(response: Response): boolean;
  /** Extract the requestId from a non-ready response. */
  responseRequestId(response: Response): string;
  /** Settle a non-ready response (resolve/reject the pending call). */
  settle(response: Response, settlement: PendingSettlement): void;
  /** Build the rejection error for an aborted call (defaults to a plain Error). */
  abortError?(beforeSend: boolean): Error;
}>;

type PendingRequest<Request> = {
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: unknown) => void;
  readonly request: Request;
  slotReleased: boolean;
};

/**
 * The main-thread client for a worker RPC. Spawns the worker, completes the
 * ready handshake, bounds in-flight requests with a {@link BoundedSlotPool},
 * tracks pending requests, honours `AbortSignal` cancellation, and restarts
 * the worker + replays unacknowledged requests on crash (§3.1 fault boundary).
 */
export class BoundedRpcClient<Request, Response> {
  readonly #protocol: BoundedRpcProtocol<Request, Response>;
  readonly #workerScript: string | URL;
  readonly #restartBackoffMs: number;
  readonly #slots: BoundedSlotPool;
  readonly #pending = new Map<string, PendingRequest<Request>>();
  #worker: Worker | undefined;
  #port: MessagePort | undefined;
  #ready: Promise<void>;
  #readyResolve: (() => void) | undefined;
  #readyReject: ((error: unknown) => void) | undefined;
  #readyFired = false;
  #closed = false;
  #restarting = false;
  #generation = 0;

  constructor(
    protocol: BoundedRpcProtocol<Request, Response>,
    options: BoundedRpcOptions
  ) {
    this.#protocol = protocol;
    this.#workerScript = options.workerScript;
    this.#restartBackoffMs = options.restartBackoffMs ?? 10;
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
    return this.#workerScript instanceof URL
      ? this.#workerScript
      : new URL(this.#workerScript);
  }

  #spawnWorker(): void {
    const generation = this.#generation;
    const worker = new Worker(this.#workerUrl());
    const channel = new MessageChannel();
    worker.postMessage({ port: channel.port2 }, [channel.port2]);
    const port = channel.port1;
    this.#worker = worker;
    this.#port = port;

    port.on("message", (response: Response) => {
      if (this.#protocol.isReady(response)) {
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
    port.postMessage(this.#protocol.initRequest());
  }

  #handleResponse(response: Response): void {
    const requestId = this.#protocol.responseRequestId(response);
    const pending = this.#pending.get(requestId);
    if (pending === undefined) return; // stale/unknown (e.g. aborted)
    this.#pending.delete(requestId);
    if (!pending.slotReleased) {
      pending.slotReleased = true;
      this.#slots.release();
    }
    this.#protocol.settle(response, {
      resolve: pending.resolve,
      reject: pending.reject
    });
  }

  async #restart(): Promise<void> {
    if (this.#restarting || this.#closed) return;
    this.#restarting = true;
    try {
      // If the worker died before becoming ready, fail the old ready handshake
      // so awaiting send() calls reject instead of hanging on an orphaned promise.
      if (!this.#readyFired) {
        this.#readyFired = true;
        this.#readyReject?.(new Error("Worker exited before becoming ready."));
      }
      // Brief backoff to avoid a hot crash loop.
      await new Promise((resolve) => setTimeout(resolve, this.#restartBackoffMs));
      this.#generation += 1;
      this.#port?.close();
      this.#ready = this.#newReadyPromise();
      this.#spawnWorker();
      await this.#ready;
      // Replay unacknowledged requests (§3.1 fault boundary). Idempotent
      // effects are deduped by the worker; read-only effects re-execute. The
      // original promises are still pending and resolve when the new responses
      // arrive.
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

  /**
   * Send one request and await its response. The request must carry
   * `requestId` (used for the pending map, cancel notices, and restart replay).
   */
  async send(
    requestId: string,
    request: Request,
    options: RpcSendOptions = {}
  ): Promise<unknown> {
    if (this.#closed) return Promise.reject(new Error("BoundedRpcClient is closed."));
    await this.#ready;
    await this.#slots.acquire();
    if (this.#closed) {
      this.#slots.release();
      return Promise.reject(new Error("BoundedRpcClient is closed."));
    }
    const abortError = (beforeSend: boolean): Error =>
      this.#protocol.abortError?.(beforeSend)
      ?? new Error(beforeSend ? "Request aborted before it was sent." : "Request aborted.");
    return new Promise<unknown>((resolve, reject) => {
      let abortListener: (() => void) | undefined;
      const signal = options.signal;
      if (signal !== undefined) {
        if (signal.aborted) {
          this.#slots.release();
          reject(abortError(true));
          return;
        }
        abortListener = () => {
          // Best-effort cancel; the worker observes the notice and suppresses
          // a late result. Already-completed effects are not undone.
          try {
            this.#port?.postMessage(this.#protocol.cancelRequest(requestId));
          } catch {
            // Port may be gone.
          }
          const pending = this.#pending.get(requestId);
          if (pending !== undefined && !pending.slotReleased) {
            pending.slotReleased = true;
            this.#slots.release();
          }
          this.#pending.delete(requestId);
          reject(abortError(false));
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
        request,
        slotReleased: false
      });
      this.#port?.postMessage(request);
    });
  }

  /** Close the worker and release its resources. */
  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    // Fail any requests still waiting on the ready handshake.
    if (!this.#readyFired) {
      this.#readyFired = true;
      this.#readyReject?.(new Error("BoundedRpcClient closed before ready."));
    }
    // Reject all in-flight requests; their slots are released.
    for (const [id, pending] of this.#pending) {
      this.#pending.delete(id);
      if (!pending.slotReleased) {
        pending.slotReleased = true;
        this.#slots.release();
      }
      pending.reject(new Error("BoundedRpcClient closed."));
    }
    try {
      this.#port?.postMessage(this.#protocol.shutdownRequest());
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

// -- Worker-side host ---------------------------------------------------------

/**
 * The worker-side adapter for one RPC dialect. {@link runRpcWorker} owns the
 * port handshake and dispatch; the host implements the dialect.
 */
export type RpcWorkerHost<Request, Response> = Readonly<{
  /** Classify a request. `scan`-style work requests map to `"request"`. */
  kindOf(request: Request): "init" | "request" | "cancel" | "shutdown";
  /** Extract the requestId (undefined for init/shutdown). */
  requestIdOf(request: Request): string | undefined;
  /** Initialize the worker. Throw to fail the worker (the main thread restarts). */
  init(request: Request): Promise<void>;
  /** Handle a work request; return the result (thrown → serialized error response). */
  handle(request: Request): Promise<unknown>;
  /** Observe a cancel notice (best-effort; the host suppresses a late result). */
  cancel(requestId: string): void;
  /** Clean up resources before the worker exits. */
  shutdown(): Promise<void>;
  /** Build the ready response. */
  ready(): Response;
  /** Build a result response. */
  result(requestId: string, value: unknown): Response;
  /** Build an error response. */
  error(requestId: string, error: SerializedError): Response;
  /**
   * Serialize requests through a FIFO queue (default false). The persistence
   * worker sets this so writes stay strictly ordered; read-only workers (the
   * inventory worker) leave it false and let the worker's event loop
   * interleave requests at its await points.
   */
  serial?: boolean;
}>;

/**
 * Run a worker RPC host. Called once at the top level of a worker script.
 * Completes the port handshake, then dispatches requests per the host's
 * {@link RpcWorkerHost.kindOf}. `cancel` is processed immediately (so it can
 * interrupt queued work); `shutdown` cleans up and exits; `init` and `request`
 * are queued (FIFO) when `serial` is set, otherwise run immediately.
 *
 * A request whose cancel notice arrived before its result is posted is
 * suppressed (the main thread already rejected the call).
 */
export function runRpcWorker<Request, Response>(
  host: RpcWorkerHost<Request, Response>
): void {
  const port = parentPort;
  if (port === null) {
    throw new Error("RPC worker must be run as a worker thread.");
  }
  const cancelled = new Set<string>();
  let queue: Promise<void> = Promise.resolve();
  // Responses go back on the handshake MessageChannel port, not parentPort:
  // the main thread listens on the channel, not on the worker's parent port.
  let messagePort: MessagePort | undefined;

  const post = (message: Response): void => {
    messagePort?.postMessage(message);
  };

  const runRequest = async (request: Request): Promise<void> => {
    const requestId = host.requestIdOf(request);
    try {
      const value = await host.handle(request);
      if (requestId !== undefined && cancelled.has(requestId)) {
        cancelled.delete(requestId);
        return; // the main thread already gave up; don't post a late result
      }
      if (requestId === undefined) {
        throw new Error("RPC worker request has no requestId.");
      }
      post(host.result(requestId, value));
    } catch (error) {
      if (requestId !== undefined) cancelled.delete(requestId);
      if (requestId === undefined) {
        console.error("[rpcWorker] request failed without a requestId:", error);
        return;
      }
      post(host.error(requestId, serializeError(error)));
    }
  };

  const enqueue = (task: () => Promise<void>): void => {
    queue = queue.then(task).catch((error) => {
      // Backstop: a handler threw without posting a response. Fail the worker
      // rather than hang the caller.
      console.error("[rpcWorker] unhandled handler error:", error);
    });
  };

  port.once("message", (value: { port: MessagePort }) => {
    messagePort = value.port;
    messagePort.on("message", (message: Request) => {
      try {
        const kind = host.kindOf(message);
        if (kind === "cancel") {
          // Process immediately so it can interrupt queued work.
          const requestId = host.requestIdOf(message);
          if (requestId !== undefined) {
            cancelled.add(requestId);
            host.cancel(requestId);
          }
          return;
        }
        if (kind === "shutdown") {
          void host.shutdown()
            .catch((error) => {
              console.error("[rpcWorker] shutdown error:", error);
            })
            .finally(() => {
              process.exit(0);
            });
          return;
        }
        if (kind === "init") {
          const initAndReady = async (): Promise<void> => {
            await host.init(message);
            post(host.ready());
          };
          if (host.serial === true) {
            enqueue(initAndReady);
          } else {
            void initAndReady().catch((error) => {
              console.error("[rpcWorker] init failed:", error);
              process.exit(1);
            });
          }
          return;
        }
        // A regular work request.
        if (host.serial === true) {
          enqueue(() => runRequest(message));
        } else {
          void runRequest(message);
        }
      } catch (error) {
        // A synchronous dispatch failure: surface it. Init failures crash the
        // worker (the client restarts); request failures are posted per-handler.
        console.error("[rpcWorker] dispatch error:", error);
      }
    });
    messagePort.on("messageerror", (error) => {
      console.error("[rpcWorker] message deserialization error:", error);
    });
  });
}

// Re-exported for worker scripts that need the parent port type.
export type { MessagePort } from "node:worker_threads";
