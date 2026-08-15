// Test worker for the resource inventory RPC (task-21, work-item-6).
//
// Speaks the inventory protocol but does a controlled synchronous busy-wait
// before returning a minimal inventory, so the event-loop-delay, backpressure,
// cancellation, and fault-injection tests are deterministic. The block length
// is taken from the scan options (`busyMs`, default 250ms) so a single worker
// URL serves every test.
import { runRpcWorker } from "../../dist/core/boundedRpc.js";

function minimalInventory(currentHome) {
  return {
    schemaVersion: 1,
    observedAt: new Date().toISOString(),
    currentHome,
    scope: "current",
    summary: {
      domainCount: 0,
      resourceCount: 0,
      liveProcessCount: 0,
      rssBytes: 0,
      byDisposition: { safe: 0, review: 0, protected: 0, "report-only": 0 }
    },
    domains: [],
    resources: [],
    warnings: []
  };
}

runRpcWorker({
  kindOf: (request) => (request.kind === "scan" ? "request" : request.kind),
  requestIdOf: (request) => (
    request.kind === "scan" || request.kind === "cancel" ? request.requestId : undefined
  ),
  init: async () => {
    // No resources to initialize.
  },
  handle: async (request) => {
    if (request.kind !== "scan") {
      throw new Error(`Unexpected inventory request: ${request.kind}`);
    }
    const busyMs = typeof request.options.busyMs === "number" ? request.options.busyMs : 250;
    if (busyMs > 0) {
      // Controlled synchronous block simulating the /proc scan cost.
      const end = Date.now() + busyMs;
      while (Date.now() < end) {
        // spin
      }
    }
    return minimalInventory(request.options.currentHome);
  },
  cancel: () => {
    // The busy-wait has no cancellation points; the main thread rejects the
    // aborted call immediately and suppresses the late result.
  },
  shutdown: async () => {
    // Nothing to close.
  },
  ready: () => ({ kind: "ready" }),
  result: (requestId, value) => ({ kind: "result", requestId, inventory: value }),
  error: (requestId, error) => ({ kind: "error", requestId, error })
});
