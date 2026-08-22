/**
 * Bounded RPC client for the resource inventory Worker Thread
 * (task-21, work-item-6).
 *
 * The `/proc` scanning in `resourceInventoryLinux` is blocking IO (hundreds of
 * `readFileSync` calls per pass, `spawnSync`, tmux inspection). When the worker
 * backend is active (`YUI_STORE_BACKEND=sqlite` + `YUI_STORE_WORKER=1`, the same
 * flag as the persistence worker, §6), the Controller runtime and the ephemeral
 * reaper scan through this client instead: the scan runs in the inventory
 * worker (its own thread), the main event loop stays free, and the result is
 * posted back at the same cadence (design §3.3).
 *
 * The backpressure, cancellation, and fault-boundary machinery is the shared
 * `core/boundedRpc` client; this module adds the inventory dialect:
 *
 *   main -> worker: init | scan | cancel | shutdown
 *   worker -> main: ready | result | error
 *
 * Only structured-cloneable scan options cross the port (the file-backed
 * `inspectStorage` / `openCompatibleStore` / `now` seams stay on the direct
 * path, which the file backend still uses). The inventory worker never touches
 * the persistence worker's database connection (§3.3): it is a separate worker
 * with a separate concern.
 */
import {
  BoundedRpcClient,
  deserializeError,
  nextRequestId,
  type BoundedRpcProtocol,
  type RpcSendOptions,
  type SerializedError
} from "../core/boundedRpc.js";
import type {
  ControllerInventoryScope,
  ControllerResourceInventory,
  RuntimePaneFact
} from "./resourceInventory.js";

// -- Protocol ----------------------------------------------------------------

/** The structured-cloneable subset of `ControllerInventoryScanOptions`. */
export type ResourceInventoryScanRequest = Readonly<{
  currentHome: string;
  scope: ControllerInventoryScope;
  environment?: Readonly<Record<string, string | undefined>>;
  /** Path to the tmux binary, from the durable Yui config. */
  tmuxBin?: string;
  /** Reuse the caller's one full pane inventory when already available. */
  panes?: readonly RuntimePaneFact[];
}>;

/** Requests sent main -> worker. */
export type InventoryWorkerRequest =
  | { kind: "init" }
  | { kind: "scan"; requestId: string; options: ResourceInventoryScanRequest }
  | { kind: "cancel"; requestId: string }
  | { kind: "shutdown" };

/** Responses posted worker -> main. */
export type InventoryWorkerResponse =
  | { kind: "ready" }
  | { kind: "result"; requestId: string; inventory: ControllerResourceInventory }
  | { kind: "error"; requestId: string; error: SerializedError };

// -- Options -----------------------------------------------------------------

export type ResourceInventoryClientOptions = Readonly<{
  /** Max in-flight scans (default 4; scans are heavy and run at a cadence). */
  maxInFlight?: number;
  /** Max queued scans waiting for a slot (default 16). */
  maxQueue?: number;
  /** Override the worker script URL (tests). */
  workerScript?: string | URL;
}>;

// -- Protocol adapter ---------------------------------------------------------

const inventoryProtocol: BoundedRpcProtocol<InventoryWorkerRequest, InventoryWorkerResponse> = {
  initRequest: () => ({ kind: "init" }),
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
      settlement.resolve(response.inventory);
      return;
    }
    if (response.kind === "error") {
      settlement.reject(deserializeError(response.error));
    }
  }
};

// -- Client ------------------------------------------------------------------

/**
 * The main-thread client for the inventory worker. `scan` runs the full
 * `scanControllerResourceInventory` in the worker and resolves with the same
 * inventory shape the direct call returns; the scheduler and the ephemeral
 * reaper consume it through the same ports as today (§3.3, behavior unchanged).
 */
export class ResourceInventoryClient {
  readonly #rpc: BoundedRpcClient<InventoryWorkerRequest, InventoryWorkerResponse>;

  constructor(options: ResourceInventoryClientOptions = {}) {
    this.#rpc = new BoundedRpcClient(inventoryProtocol, {
      maxInFlight: options.maxInFlight ?? 4,
      maxQueue: options.maxQueue ?? 16,
      workerScript: options.workerScript ?? new URL("./resourceInventoryWorker.js", import.meta.url)
    });
  }

  /** Run one resource inventory scan in the worker. */
  scan(
    options: ResourceInventoryScanRequest,
    rpcOptions?: RpcSendOptions
  ): Promise<ControllerResourceInventory> {
    const requestId = nextRequestId();
    return this.#rpc.send(
      requestId,
      { kind: "scan", requestId, options },
      rpcOptions
    ) as Promise<ControllerResourceInventory>;
  }

  /** Close the worker. */
  close(): Promise<void> {
    return this.#rpc.close();
  }

  /** Currently in-flight scans (metrics/tests). */
  get inFlight(): number {
    return this.#rpc.inFlight;
  }

  /** Currently queued scans waiting for a slot (metrics/tests). */
  get queueDepth(): number {
    return this.#rpc.queueDepth;
  }

  /** Test-only fault injection: terminate the worker (the client restarts it). */
  crashForTest(): Promise<void> {
    return this.#rpc.crashForTest();
  }
}
