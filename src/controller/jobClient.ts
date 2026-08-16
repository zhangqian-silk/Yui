/**
 * Client for the Controller's `job.*` socket methods. Leader/Worker code and
 * the CLI request DurableJobs through these functions instead of spawning
 * runners themselves: the Controller is the sole job owner, so a Leader
 * yield, Session replacement, or CLI exit never kills a running job.
 */
import type { JsonValue } from "../core/protocol.js";
import type { IntegrationJobPort } from "../integration/gitIntegrationService.js";
import type {
  DurableJob,
  DurableJobOwner,
  DurableJobStep
} from "../job/durableJob.js";
import type { DurableJobCaller } from "./jobControl.js";
import { resolveJobCaller } from "../commands/taskActor.js";
import type { JobCallerStore } from "../commands/taskActor.js";
import {
  callFileTaskController,
  type FileControllerClientOptions
} from "./clientRuntime.js";

export type ControllerDurableJobStartParams = Readonly<{
  taskId: string;
  owner: DurableJobOwner;
  projectId: string;
  head: string;
  workspace: string;
  env: Readonly<Record<string, string>>;
  steps: readonly DurableJobStep[];
  retryOf?: string;
  /** rr8: The caller identity the declared owner is bound to. */
  caller: DurableJobCaller;
}>;

export type ControllerDurableJobStartResult = Readonly<{
  job: DurableJob;
  /** False when an existing job with the same idempotency key was returned. */
  created: boolean;
}>;

export async function startDurableJob(
  home: string,
  params: ControllerDurableJobStartParams,
  clientOptions: FileControllerClientOptions = {}
): Promise<ControllerDurableJobStartResult> {
  // rr6/f2: Route through callFileTaskController so an Integration-issued
  // job.start starts a stopped per-Home Controller on demand, mirroring the
  // `job start` CLI. A bare callController only reads discovery and fails.
  const result = await callFileTaskController(
    home,
    "job.start",
    params as unknown as JsonValue,
    clientOptions
  );
  return parseStartResult(result);
}

export async function getDurableJob(
  home: string,
  taskId: string,
  jobId: string,
  clientOptions: FileControllerClientOptions = {}
): Promise<DurableJob> {
  const result = await callFileTaskController(
    home,
    "job.get",
    { taskId, jobId },
    clientOptions
  );
  return parseJobResult(result);
}

export type ControllerDurableJobCancelResult = Readonly<{
  job: DurableJob;
  cancelRequested: boolean;
}>;

export type ControllerDurableJobAcknowledgeResult = Readonly<{
  job: DurableJob;
  acknowledged: boolean;
}>;

export async function acknowledgeDurableJob(
  home: string,
  taskId: string,
  jobId: string,
  caller: DurableJobCaller,
  clientOptions: FileControllerClientOptions = {}
): Promise<ControllerDurableJobAcknowledgeResult> {
  const result = await callFileTaskController(
    home,
    "job.acknowledge",
    {
      taskId,
      jobId,
      caller
    },
    clientOptions
  );
  if (
    typeof result !== "object" || result === null || Array.isArray(result)
    || typeof (result as Record<string, unknown>).acknowledged !== "boolean"
  ) {
    throw new Error("Controller job.acknowledge returned an invalid result.");
  }
  return {
    job: parseJobResult(result),
    acknowledged: (result as Record<string, unknown>).acknowledged as boolean
  };
}

export async function cancelDurableJob(
  home: string,
  taskId: string,
  jobId: string,
  caller: DurableJobCaller,
  clientOptions: FileControllerClientOptions = {}
): Promise<ControllerDurableJobCancelResult> {
  const result = await callFileTaskController(
    home,
    "job.cancel",
    { taskId, jobId, caller },
    clientOptions
  );
  if (
    typeof result !== "object" || result === null || Array.isArray(result)
    || typeof (result as Record<string, unknown>).cancelRequested !== "boolean"
  ) {
    throw new Error("Controller job.cancel returned an invalid result.");
  }
  return {
    job: parseJobResult(result),
    cancelRequested: (result as Record<string, unknown>).cancelRequested as boolean
  };
}

function parseStartResult(value: JsonValue): ControllerDurableJobStartResult {
  if (
    typeof value !== "object" || value === null || Array.isArray(value)
    || typeof (value as Record<string, unknown>).created !== "boolean"
  ) {
    throw new Error("Controller job.start returned an invalid result.");
  }
  return {
    job: parseJobResult(value),
    created: (value as Record<string, unknown>).created as boolean
  };
}

function parseJobResult(value: JsonValue): DurableJob {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Controller returned an invalid DurableJob result.");
  }
  const job = (value as Record<string, unknown>).job;
  if (typeof job !== "object" || job === null || Array.isArray(job)) {
    throw new Error("Controller returned an invalid DurableJob record.");
  }
  return job as unknown as DurableJob;
}

/**
 * Production IntegrationJobPort: Integration checks ask the Controller socket
 * for their DurableJob. The Controller owns the detached runner, so a Leader
 * exit or Session replacement never kills a running check.
 *
 * rr6/f2: The port routes through callFileTaskController, so an Integration
 * operation that issues a job.* RPC (start/continue/abort, and job-backed Task
 * completion) starts a stopped per-Home Controller on demand. Read-only
 * list/show paths do not use this port and stay lean.
 */
export function createControllerIntegrationJobPort(
  home: string,
  clientOptions: FileControllerClientOptions & Readonly<{ store?: JobCallerStore }> = {}
): IntegrationJobPort {
  const { store, ...controllerOptions } = clientOptions;
  return {
    async startCheckJob(input) {
      const owner: DurableJobOwner = {
        kind: "integration-attempt",
        integrationAttemptId: input.integrationId
      };
      // rr8/rr12: Bind the Integration-issued job to the caller's managed
      // identity. A user-scope caller carries a verified Leader assertion.
      const caller = resolveJobCaller(controllerOptions.environment, input.taskId, store);
      const { job } = await startDurableJob(home, {
        taskId: input.taskId,
        owner,
        projectId: input.projectId,
        head: input.head,
        workspace: input.workspace,
        env: input.env,
        steps: input.steps,
        caller
      }, controllerOptions);
      return job;
    },
    async getJob(taskId, jobId) {
      return getDurableJob(home, taskId, jobId, controllerOptions);
    },
    async cancelJob(taskId, jobId) {
      // rr8/rr12: Bind the cancel request to the caller's managed identity.
      const caller = resolveJobCaller(controllerOptions.environment, taskId, store);
      await cancelDurableJob(home, taskId, jobId, caller, controllerOptions);
    }
  };
}
