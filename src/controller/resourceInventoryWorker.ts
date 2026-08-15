/**
 * Resource inventory Worker Thread (task-21, work-item-6).
 *
 * Runs the blocking `/proc` scanning of `resourceInventoryLinux` off the main
 * thread. The main thread asks for a scan over a `MessageChannel` port; the
 * worker runs the exact same `scanControllerResourceInventory` the file backend
 * calls directly and posts the inventory back. Because worker threads share the
 * process, the scanner's self-exclusion (`process.pid`, its start identity)
 * keeps excluding the Controller process exactly as on the main thread.
 *
 * The port handshake, dispatch, cancellation observation, and error
 * serialization are the shared `core/boundedRpc` worker host; this module only
 * supplies the inventory dialect. The worker is read-only: it never touches the
 * persistence worker's database connection (§3.3) — it opens the same file
 * store reads the direct scan uses, in its own thread.
 *
 * Protocol (see resourceInventoryRpc.ts):
 *   main -> worker: init | scan | cancel | shutdown
 *   worker -> main: ready | result | error
 */
import { runRpcWorker } from "../core/boundedRpc.js";
import { scanControllerResourceInventory } from "./resourceInventoryLinux.js";
import type { ControllerResourceInventory } from "./resourceInventory.js";
import type {
  InventoryWorkerRequest,
  InventoryWorkerResponse
} from "./resourceInventoryRpc.js";

runRpcWorker<InventoryWorkerRequest, InventoryWorkerResponse>({
  kindOf: (request) => (request.kind === "scan" ? "request" : request.kind),
  requestIdOf: (request) => (
    request.kind === "scan" || request.kind === "cancel" ? request.requestId : undefined
  ),
  init: async () => {
    // No resources to initialize: each scan opens what it needs and closes it.
  },
  handle: async (request) => {
    if (request.kind !== "scan") {
      throw new Error(`Unexpected inventory request: ${request.kind}`);
    }
    return scanControllerResourceInventory(request.options);
  },
  cancel: () => {
    // The /proc scan has no cancellation points. The main thread rejects the
    // aborted call immediately and suppresses the late result; the worker
    // thread finishes the scan on its own time without blocking the main loop.
  },
  shutdown: async () => {
    // Nothing to close: scans own no long-lived resources.
  },
  ready: () => ({ kind: "ready" }),
  result: (requestId, value) => ({
    kind: "result",
    requestId,
    inventory: value as ControllerResourceInventory
  }),
  error: (requestId, error) => ({ kind: "error", requestId, error })
});
