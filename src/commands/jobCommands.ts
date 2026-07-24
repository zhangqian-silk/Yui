import { runtimeError, taskNotFound, usageError } from "../errors/cliError.js";
import { defaultTableWidth, renderTable } from "../output/table.js";
import { formatTimestamp } from "../output/timePresentation.js";
import { enqueueWork } from "../coordination/workMailboxQueue.js";
import type { MailboxTarget } from "../coordination/workMailbox.js";
import type { TaskStore } from "../storage/taskStore.js";

const WAKEUP_PREFIX = "leader-wakeup:";
const RECOVERY_PREFIX = "leader-recovery:";

export type JobCommandRuntimePort = Readonly<{
  notifyStateChanged(taskId: string): void;
  notifyMailboxChanged?(target: MailboxTarget): void;
}>;

export type JobCommandOptions = Readonly<{
  runtime?: JobCommandRuntimePort;
  now?: () => Date;
}>;

type PresentedJob = Readonly<{
  id: string;
  taskId: string;
  kind: "leader-wakeup" | "leader-recovery";
  status: "pending" | "failed";
  detail: string;
  updatedAt: string;
}>;

/**
 * A compatibility view over the two durable scheduler records. This does not
 * reintroduce the deleted generic Job queue.
 */
export function runJobCommand(
  args: string[],
  store: TaskStore,
  options: JobCommandOptions = {}
): string {
  const [command, ...rest] = args;
  if (command === "list") return listJobs(rest, store);
  if (command === "retry") return retryJob(rest, store, options);
  throw usageError(command === undefined
    ? "Jobs command is required."
    : `Unknown command: jobs ${command}`);
}

function listJobs(args: string[], store: TaskStore): string {
  if (args.length !== 0) throw usageError("Jobs list usage: yui jobs list.");
  const jobs = collectJobs(store);
  if (jobs.length === 0) return "No scheduler jobs found.\n";
  const timeZone = store.getConfig().timeZone;
  return `${renderTable(
    "Scheduler jobs",
    [
      { header: "Job", minWidth: 12, maxWidth: 44 },
      { header: "Task", minWidth: 6, maxWidth: 20 },
      { header: "Kind", minWidth: 12, maxWidth: 18 },
      { header: "Status", minWidth: 6, maxWidth: 10 },
      { header: "Updated", minWidth: 10, maxWidth: 28 },
      { header: "Detail", minWidth: 8, maxWidth: 64 }
    ],
    jobs.map((job) => [
      job.id,
      job.taskId,
      job.kind,
      job.status,
      formatTimestamp(job.updatedAt, timeZone),
      job.detail
    ]),
    defaultTableWidth()
  )}\n`;
}

function collectJobs(store: TaskStore): PresentedJob[] {
  const jobs: PresentedJob[] = [];
  for (const task of store.listTasks()) {
    const wakeup = store.getPendingWakeup(task.id);
    if (wakeup !== null) {
      jobs.push({
        id: `${WAKEUP_PREFIX}${task.id}`,
        taskId: task.id,
        kind: "leader-wakeup",
        status: "pending",
        detail: `${wakeup.reasons.join(", ")} (${wakeup.requestCount})`,
        updatedAt: wakeup.lastRequestedAt
      });
    }
    const failure = store.getLeaderFailure(task.id);
    const notification = store.getOperatorNotification(task.id);
    if (failure !== null || notification !== null) {
      jobs.push({
        id: `${RECOVERY_PREFIX}${task.id}`,
        taskId: task.id,
        kind: "leader-recovery",
        status: "failed",
        detail: failure?.message ?? notification?.message ?? "Leader recovery failed.",
        updatedAt: failure?.lastFailedAt ?? notification?.updatedAt ?? task.updatedAt
      });
    }
  }
  return jobs.sort((left, right) => left.id.localeCompare(right.id, undefined, { numeric: true }));
}

function retryJob(
  args: string[],
  store: TaskStore,
  options: JobCommandOptions
): string {
  if (args.length !== 1 || args[0].trim().length === 0) {
    throw usageError("Jobs retry usage: yui jobs retry <id>.");
  }
  const id = args[0].trim();
  if (!id.startsWith(RECOVERY_PREFIX) || id.length === RECOVERY_PREFIX.length) {
    throw usageError(`Job is not retryable: ${id}. Only leader-recovery jobs can be retried.`);
  }
  const taskId = id.slice(RECOVERY_PREFIX.length);
  const now = options.now?.() ?? new Date();
  const runtime = options.runtime;
  if (runtime === undefined) throw runtimeError("Task workflow runtime is not configured.");
  store.transaction((tx) => {
    const task = tx.getTask(taskId);
    if (task === null) throw taskNotFound(taskId);
    if (task.status !== "active") {
      throw usageError(`Leader recovery can only be retried for an active Task: ${task.id}.`);
    }
    if (tx.getLeaderFailure(task.id) === null && tx.getOperatorNotification(task.id) === null) {
      throw usageError(`Job not found: ${id}.`);
    }
    tx.clearLeaderFailure(task.id);
    tx.clearOperatorNotification(task.id);
    enqueueWork(
      tx,
      { kind: "role", taskId: task.id, roleName: "leader" },
      "recovery-retry",
      now,
      [{ type: "task", id: task.id }]
    );
  });
  const target: MailboxTarget = { kind: "role", taskId, roleName: "leader" };
  if (runtime.notifyMailboxChanged !== undefined) runtime.notifyMailboxChanged(target);
  else runtime.notifyStateChanged(taskId);
  return `Retry requested for ${id}\n`;
}
