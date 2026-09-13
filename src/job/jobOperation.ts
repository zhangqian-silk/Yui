import { type DurableJob } from "../job/durableJob.js";

/** A read model over the one Job, never separately persisted.
 * confirmed means the selected runner was observed, not that every action
 * performed by an arbitrary command succeeded. Inspect original step receipts.
 */
export function inspectJobOperation(job: DurableJob) {
  return {
    operationRef: { taskId: job.taskId, jobId: job.id },
    ...job.operation,
    state: job.status === "queued" ? "pending"
      : job.status === "running" ? "running"
      : job.status === "unknown-needs-attention" ? "unknown" : "finished",
    outcome: job.result?.outcome,
    result: job.result,
    checkpoint: job.checkpoint
  };
}
