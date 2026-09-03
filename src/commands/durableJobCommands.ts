import { usageError } from "../errors/cliError.js";
import { ensureFileTaskController } from "../controller/clientRuntime.js";
import {
  acknowledgeDurableJob,
  cancelDurableJob,
  getDurableJob,
  startDurableJob,
  type ControllerDurableJobStartParams
} from "../controller/jobClient.js";
import type { DurableJobOwner, DurableJobStep } from "../job/durableJob.js";
import type { TaskStore } from "../storage/taskStore.js";
import { resolveJobCaller, taskLocalActor } from "./taskActor.js";

/**
 * The textual `--owner` forms accepted by `job start`. The public help text in
 * the command catalog must document exactly these forms.
 */
export const JOB_OWNER_USAGE = "task|work-item:<id>|integration-attempt:<id>" as const;

export type DurableJobCommandOptions = Readonly<{
  home: string;
  json?: boolean;
  environment?: NodeJS.ProcessEnv;
  /** Required for `job acknowledge` to validate Task-local control identity. */
  store?: Pick<TaskStore, "getRole" | "getActiveTurn" | "getJobCallerKeyHash">;
}>;

/**
 * `yui job start|get|cancel` — the operational surface for Controller-owned
 * DurableJobs. Every request goes through the Controller socket; this command
 * never spawns a runner itself.
 */
export async function runDurableJobCommand(
  args: string[],
  options: DurableJobCommandOptions
): Promise<string> {
  const [command, ...rest] = args;
  if (command === "start") return startJob(rest, options);
  if (command === "get") return getJob(rest, options);
  if (command === "cancel") return cancelJob(rest, options);
  if (command === "acknowledge") return acknowledgeJob(rest, options);
  throw usageError(
    command === undefined
      ? "Job command is required: start, get, cancel, or acknowledge."
      : `Unknown command: job ${command}`,
    "yui job start --task <id> --project <project> --head <sha> --workspace <dir> "
      + "--step <name>=<command> [--step ...] [--env K=V ...] "
      + `[--owner ${JOB_OWNER_USAGE}] [--retry-of <job-id>]\n`
      + "yui job get --task <id> --job <job-id>\n"
      + "yui job cancel --task <id> --job <job-id>\n"
      + "yui job acknowledge --task <id> --job <job-id>"
  );
}

async function startJob(
  args: string[],
  options: DurableJobCommandOptions
): Promise<string> {
  const parsed = parseStartArgs(args);
  await ensureFileTaskController(options.home, { environment: options.environment });
  const caller = resolveJobCaller(options.environment, parsed.taskId);
  const params: ControllerDurableJobStartParams = {
    taskId: parsed.taskId,
    owner: parsed.owner,
    projectId: parsed.projectId,
    head: parsed.head,
    workspace: parsed.workspace,
    env: parsed.env,
    steps: parsed.steps,
    caller,
    ...(parsed.retryOf === undefined ? {} : { retryOf: parsed.retryOf })
  };
  const result = await startDurableJob(options.home, params);
  if (options.json === true) return `${JSON.stringify(result, null, 2)}\n`;
  const verb = result.created ? "queued" : "already exists";
  return `Job ${result.job.id} ${verb} (status: ${result.job.status})\n`;
}

async function getJob(
  args: string[],
  options: DurableJobCommandOptions
): Promise<string> {
  const ref = parseRefArgs(args, "get");
  await ensureFileTaskController(options.home, { environment: options.environment });
  const job = await getDurableJob(options.home, ref.taskId, ref.jobId);
  if (options.json === true) return `${JSON.stringify(job, null, 2)}\n`;
  const lines = [
    `Job ${job.id} (task ${job.taskId})`,
    `  status: ${job.status}`,
    `  owner: ${formatOwner(job.owner)}`,
    `  head: ${job.head}`,
    `  workspace: ${job.workspace}`,
    `  created: ${job.createdAt}`
  ];
  if (job.startedAt !== undefined) lines.push(`  started: ${job.startedAt}`);
  if (job.terminalAt !== undefined) lines.push(`  terminal: ${job.terminalAt}`);
  if (job.result !== undefined) {
    lines.push(`  outcome: ${job.result.outcome}`);
    if (job.result.failedStep !== undefined) lines.push(`  failed step: ${job.result.failedStep}`);
    if (job.result.unknownReason !== undefined) lines.push(`  reason: ${job.result.unknownReason}`);
  }
  for (const step of job.steps) {
    lines.push(`  step ${step.name}: ${step.command}`);
  }
  return `${lines.join("\n")}\n`;
}

async function cancelJob(
  args: string[],
  options: DurableJobCommandOptions
): Promise<string> {
  const ref = parseRefArgs(args, "cancel");
  await ensureFileTaskController(options.home, { environment: options.environment });
  // rr8/rr12: Bind the cancel request to the caller's managed identity.
  const caller = resolveJobCaller(options.environment, ref.taskId);
  const result = await cancelDurableJob(options.home, ref.taskId, ref.jobId, caller);
  if (options.json === true) return `${JSON.stringify(result, null, 2)}\n`;
  return result.cancelRequested
    ? `Cancel requested for job ${result.job.id}\n`
    : `Job ${result.job.id} is already terminal (${result.job.status})\n`;
}

async function acknowledgeJob(
  args: string[],
  options: DurableJobCommandOptions
): Promise<string> {
  const ref = parseRefArgs(args, "acknowledge");
  if (options.store === undefined) {
    throw usageError(
      "job acknowledge requires a Task store to resolve the caller."
    );
  }
  taskLocalActor(options.store, options.environment, ref.taskId);
  const caller = resolveJobCaller(options.environment, ref.taskId);
  await ensureFileTaskController(options.home, { environment: options.environment });
  const result = await acknowledgeDurableJob(options.home, ref.taskId, ref.jobId, caller);
  if (options.json === true) return `${JSON.stringify(result, null, 2)}\n`;
  return result.acknowledged
    ? `Job ${result.job.id} acknowledged (status: ${result.job.status})\n`
    : `Job ${result.job.id} is not in unknown-needs-attention state (${result.job.status})\n`;
}

function parseStartArgs(args: string[]): Readonly<{
  taskId: string;
  owner: DurableJobOwner;
  projectId: string;
  head: string;
  workspace: string;
  env: Record<string, string>;
  steps: DurableJobStep[];
  retryOf?: string;
}> {
  let taskId: string | undefined;
  let projectId: string | undefined;
  let head: string | undefined;
  let workspace: string | undefined;
  let owner: DurableJobOwner = { kind: "task" };
  let retryOf: string | undefined;
  const env: Record<string, string> = {};
  const steps: DurableJobStep[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index];
    const value = args[index + 1];
    if (value === undefined || value.startsWith("--")) {
      throw usageError(`Missing value for ${flag}.`, "yui job start ...");
    }
    index += 1;
    switch (flag) {
      case "--task": taskId = value; break;
      case "--project": projectId = value; break;
      case "--head": head = value; break;
      case "--workspace": workspace = value; break;
      case "--owner": owner = parseJobOwner(value); break;
      case "--retry-of": retryOf = value; break;
      case "--env": {
        const separator = value.indexOf("=");
        if (separator <= 0) {
          throw usageError(`Invalid --env value: ${value}.`, "yui job start ...");
        }
        env[value.slice(0, separator)] = value.slice(separator + 1);
        break;
      }
      case "--step": {
        const separator = value.indexOf("=");
        if (separator <= 0) {
          throw usageError(`Invalid --step value: ${value}.`, "yui job start ...");
        }
        steps.push({ name: value.slice(0, separator), command: value.slice(separator + 1) });
        break;
      }
      default:
        throw usageError(`Unknown flag: ${flag}.`, "yui job start ...");
    }
  }
  if (taskId === undefined || projectId === undefined || head === undefined
    || workspace === undefined || steps.length === 0) {
    throw usageError(
      "job start requires --task, --project, --head, --workspace, and at least one --step.",
      "yui job start ..."
    );
  }
  return { taskId, owner, projectId, head, workspace, env, steps, retryOf };
}

export function parseJobOwner(value: string): DurableJobOwner {
  if (value === "task") return { kind: "task" };
  if (value.startsWith("work-item:")) {
    const id = value.slice("work-item:".length);
    if (id.length === 0) throw usageError("Invalid --owner work-item id.", "yui job start ...");
    return { kind: "work-item", workItemId: id };
  }
  if (value.startsWith("integration-attempt:")) {
    const id = value.slice("integration-attempt:".length);
    if (id.length === 0) {
      throw usageError("Invalid --owner integration-attempt id.", "yui job start ...");
    }
    return { kind: "integration-attempt", integrationAttemptId: id };
  }
  throw usageError(
    `Invalid --owner: ${value}. Use ${JOB_OWNER_USAGE}.`,
    "yui job start ..."
  );
}

function parseRefArgs(
  args: string[],
  command: string
): Readonly<{ taskId: string; jobId: string }> {
  let taskId: string | undefined;
  let jobId: string | undefined;
  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index];
    const value = args[index + 1];
    if (value === undefined || value.startsWith("--")) {
      throw usageError(`Missing value for ${flag}.`, `yui job ${command} ...`);
    }
    index += 1;
    if (flag === "--task") taskId = value;
    else if (flag === "--job") jobId = value;
    else throw usageError(`Unknown flag: ${flag}.`, `yui job ${command} ...`);
  }
  if (taskId === undefined || jobId === undefined) {
    throw usageError(`job ${command} requires --task and --job.`, `yui job ${command} ...`);
  }
  return { taskId, jobId };
}

function formatOwner(owner: DurableJobOwner): string {
  if (owner.kind === "task") return "task";
  if (owner.kind === "work-item") return `work-item:${owner.workItemId}`;
  return `integration-attempt:${owner.integrationAttemptId}`;
}
