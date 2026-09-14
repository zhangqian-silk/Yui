import type { TaskEvent } from "../event/taskEvent.js";
import type { AgentRun } from "../agentRun/agentRun.js";
import { operationalTaskRecords } from "../task/taskRecordRetirement.js";

/** Exact results named by a notification delta, including Runs older than its cursor. */
export function referencedWakeRunIds(
  runs: readonly AgentRun[],
  allEvents: readonly TaskEvent[],
  terminalEvents: readonly TaskEvent[]
): readonly string[] {
  const runsById = new Map(
    operationalTaskRecords(runs, allEvents, "run").map(run => [run.id, run])
  );
  return [...new Set(terminalEvents.flatMap(event => {
    if (!["run.completed", "run.failed", "run.cancelled"].includes(event.type)) return [];
    const runId = event.payload.runId;
    return runId !== undefined && runsById.has(runId) ? [runId] : [];
  }))];
}
