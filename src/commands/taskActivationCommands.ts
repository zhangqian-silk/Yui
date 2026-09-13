import { createHash } from "node:crypto";

import { enqueueWork } from "../coordination/workMailboxQueue.js";
import { usageError } from "../errors/cliError.js";
import type { EnvironmentPlan } from "../resources/projectResourceService.js";
import { SYSTEM_LEADER_ROLE } from "../role/systemRoles.js";
import { currentManagedRuntime } from "../runtime/managedCaller.js";
import type { TaskStore } from "../storage/taskStore.js";
import type { Task } from "../task/task.js";
import { describeEnvironmentPlan } from "../task/taskActivation.js";
import {
  cancelTaskActivation,
  requestTaskActivation,
  taskActivationOperationRef
} from "../task/taskActivationService.js";
import { taskLocalActor } from "../task/taskAuthority.js";
import type { TaskCommandExecution, TaskCommandOptions, TaskWorkflowStore } from "./taskCommandTypes.js";

/**
 * Explicit Activation requests.
 *
 * Requesting is not activating: this family only records durable intent and
 * returns its operation reference. Adoption stays at the single activation
 * boundary (`yui task activate`, or the Controller once a deferred request is
 * released), where the Task status change and the resource facts commit
 * together.
 */
export function runTaskActivationCommand(
  args: string[],
  store: TaskWorkflowStore,
  options: TaskCommandOptions
): TaskCommandExecution {
  const [command, ...rest] = args;
  switch (command) {
    case "request": return requestActivation(rest, store, options);
    case "cancel": return cancelActivation(rest, store, options);
    case "show": return showActivation(rest, store);
    default:
      throw usageError(command === undefined
        ? "Task activation command is required."
        : `Unknown command: task activation ${command}`);
  }
}

const REQUEST_USAGE = "Task activation request usage: yui task activation request <task> "
  + "--request-id <id> --environment <empty|scratch|local:<resource>:<read|write>>.";

/**
 * Records the request and returns its reference immediately.
 *
 * When the caller is the Leader's own running planning Turn the request is
 * stored as deferred and this command still returns right away: a synchronous
 * tool must never wait for the Turn it is running inside. The Turn keeps going
 * and the request is adopted after it terminates, against the facts that are
 * current then.
 */
function requestActivation(
  args: string[],
  store: TaskWorkflowStore,
  options: TaskCommandOptions
): TaskCommandExecution {
  const parsed = parseTail(args, new Set(["--request-id", "--environment"]), REQUEST_USAGE);
  exactPositionals(parsed.positionals, 1, REQUEST_USAGE);
  const taskId = parsed.positionals[0]!;
  const requestId = requiredOption(parsed.options, "--request-id", REQUEST_USAGE);
  const environmentPlan = parseEnvironmentPlan(
    requiredOption(parsed.options, "--environment", REQUEST_USAGE),
    REQUEST_USAGE
  );
  const now = options.now?.() ?? new Date();
  const caller = activationCaller(store, options, taskId);
  const result = attempt(REQUEST_USAGE, () => requestTaskActivation(store, {
    taskId,
    requestId,
    actorId: caller.actorId,
    authorityRef: caller.authorityRef,
    environmentPlan,
    // The activation-request command is the explicit activation boundary, so
    // every request it records carries an explicit provable origin (task-32
    // §2.4). A develop submission records its own request with `submit-develop`.
    origin: "explicit",
    ...(caller.planningRunId === undefined ? {} : { callerRunId: caller.planningRunId })
  }, now));
  // An immediate request has nothing left to wait for, so ask the Controller to
  // pick it up. A deferred one is released by its planning Turn's termination.
  // The signal is only promptness: the durable request is what is authoritative.
  if (result.created && result.startMode === "immediate") {
    store.transaction((tx) => {
      enqueueWork(
        tx,
        { kind: "task", taskId },
        "activation-requested",
        now,
        [{ type: "task", id: taskId }]
      );
    });
    void options.runtime?.notifyMailboxChanged?.({ kind: "task", taskId });
  }
  const request = result.request;
  const lines = [
    `${result.created ? "Requested" : "Existing"} activation ${result.operationRef}`,
    `Task: ${taskId} (draft)`,
    `Start: ${result.startMode}${
      result.afterPlanningRun === undefined ? "" : ` after ${taskId}/${result.afterPlanningRun}`
    }`,
    `Environment: ${describeEnvironmentPlan(request.environmentPlan)}`,
    `Disposition: ${request.disposition}`,
    result.startMode === "after-planning-turn"
      ? "This reference is returned now; the request is adopted after the planning Turn ends."
      : `Adopt it with: yui task activate ${taskId}`
  ];
  return output(`${lines.join("\n")}\n`, {
    operationRef: result.operationRef,
    created: result.created,
    startMode: result.startMode,
    ...(result.afterPlanningRun === undefined
      ? {}
      : { afterPlanningRun: result.afterPlanningRun }),
    request
  });
}

/** A cancelled request is never adopted, even if the same id is retried. */
function cancelActivation(
  args: string[],
  store: TaskWorkflowStore,
  options: TaskCommandOptions
): TaskCommandExecution {
  const usage = "Task activation cancel usage: yui task activation cancel <task> "
    + "--request-id <id> --reason <text>.";
  const parsed = parseTail(args, new Set(["--request-id", "--reason"]), usage);
  exactPositionals(parsed.positionals, 1, usage);
  const taskId = parsed.positionals[0]!;
  const requestId = requiredOption(parsed.options, "--request-id", usage);
  const reason = requiredOption(parsed.options, "--reason", usage);
  // Cancelling is a Task-local decision: the same authority that may request
  // activation may withdraw it, and withdrawal is always the safe direction.
  taskLocalActor(store, options.environment, taskId);
  const now = options.now?.() ?? new Date();
  const request = attempt(usage, () => cancelTaskActivation(store, taskId, requestId, reason, now));
  return output(
    `Cancelled activation ${taskActivationOperationRef(taskId, requestId)}\n`
    + `Reason: ${request.outcome ?? reason}\n`,
    { request }
  );
}

function showActivation(args: string[], store: TaskWorkflowStore): TaskCommandExecution {
  const usage = "Task activation show usage: yui task activation show <task>.";
  const parsed = parseTail(args, new Set(), usage);
  exactPositionals(parsed.positionals, 1, usage);
  const task = requireTask(store, parsed.positionals[0]!);
  const request = task.activationRequest;
  // The recent terminal requests the Task still displays. The refusal itself is
  // enforced from the durable activation event ledger, not this bounded list;
  // showing it just lets an Operator diagnosing a refusal see the recent
  // outcomes at a glance instead of only the latest request. An id can be
  // refused without appearing here once it has aged out of the display bound.
  const settled = task.settledActivationRequests ?? [];
  const settledLines = settled.length === 0 ? [] : [
    "",
    `Earlier requests (${settled.length}, oldest first):`,
    ...settled.map((entry) => (
      `  ${entry.operation.requestId}: ${entry.disposition}`
      + ` / effect ${entry.operation.effect}`
      + ` / ${describeEnvironmentPlan(entry.environmentPlan)}`
      + `${entry.outcome === undefined ? "" : ` — ${entry.outcome}`}`
    ))
  ];
  if (request === undefined) {
    return output(
      `No activation request exists for ${task.id} (${task.status}).\n`
      + (settledLines.length === 0 ? "" : `${settledLines.join("\n")}\n`),
      { task, request: null, settledRequests: settled }
    );
  }
  const lines = [
    `Activation ${taskActivationOperationRef(task.id, request.operation.requestId)}`,
    `Task: ${task.id} (${task.status})`,
    `Start: ${request.startMode}${
      request.afterPlanningRun === undefined ? "" : ` after ${task.id}/${request.afterPlanningRun}`
    }`,
    `Environment: ${describeEnvironmentPlan(request.environmentPlan)}`,
    `Disposition: ${request.disposition}`,
    `Effect: ${request.operation.effect}`,
    ...(request.preparationId === undefined
      ? []
      : [`Adopted environment: ${request.preparationId}`]),
    ...(request.outcome === undefined ? [] : [`Outcome: ${request.outcome}`]),
    `Requested at: ${request.requestedAt}`,
    ...settledLines
  ];
  return output(`${lines.join("\n")}\n`, { task, request, settledRequests: settled });
}

/**
 * Resolves who is requesting, and whether they are running inside this Task's
 * own planning Turn.
 *
 * The start mode is derived from that fact rather than accepted from the
 * caller: a request can only defer to a Turn the caller is actually in, and a
 * Turn that is not an active planning Turn is simply not a deferral target.
 */
function activationCaller(
  store: TaskWorkflowStore,
  options: TaskCommandOptions,
  taskId: string
): Readonly<{ actorId: string; authorityRef: string; planningRunId?: string }> {
  const actor = taskLocalActor(store, options.environment, taskId);
  if (actor === "leader") {
    const runtime = currentManagedRuntime(
      store,
      options.environment,
      taskId,
      SYSTEM_LEADER_ROLE
    );
    if (runtime === undefined) {
      throw usageError(
        `Task-local Leader authority requires the current Provider AgentRun: ${taskId}.`
      );
    }
    const current = runtime.currentRunId === undefined
      ? null
      : store.getRun(taskId, runtime.currentRunId);
    return {
      actorId: `task:${taskId}/role:${SYSTEM_LEADER_ROLE}`,
      // Non-secret binding fingerprint of the live Session, matching the Job
      // boundary: reattaching the same Session keeps it, replacing it does not.
      authorityRef: fingerprint([
        runtime.agentId,
        runtime.adapterId,
        runtime.nativeSessionId
      ]),
      ...(current?.status === "active" && current.purpose === "planning"
        ? { planningRunId: current.id }
        : {})
    };
  }
  if (actor === "operator") {
    return nonLeaderActivationIdentity(store, "operator");
  }
  return nonLeaderActivationIdentity(store, "user");
}

/**
 * The activation actor/authority identity for a user or Operator submission.
 *
 * A develop submission (task-32 §2.4) records its own activation request inside
 * the message-save transaction, and it must stamp the exact same identity the
 * explicit `yui task activation request` boundary would for the same caller —
 * otherwise the Controller and the workspace preparer could treat "the user
 * asked via submit" differently from "the user asked via activate". Sharing this
 * mapping is what keeps the two entry points one activation contract rather than
 * two. Leader identity is deliberately excluded: it binds to a live native
 * Session and is resolved only by {@link activationCaller}.
 */
export function nonLeaderActivationIdentity(
  store: Pick<TaskStore, "getGlobalRole">,
  actor: "user" | "operator"
): Readonly<{ actorId: string; authorityRef: string }> {
  if (actor === "operator") {
    return {
      actorId: "global:operator",
      authorityRef: fingerprint([
        "operator",
        store.getGlobalRole("operator")?.activeAgentId ?? "operator"
      ])
    };
  }
  return { actorId: "user:local", authorityRef: fingerprint(["user", "local-terminal"]) };
}

function parseEnvironmentPlan(value: string, usage: string): EnvironmentPlan {
  if (value === "empty") return { kind: "empty" };
  if (value === "scratch") return { kind: "scratch" };
  const local = /^local:(?<resourceId>[^:]+):(?<access>read|write)$/u.exec(value);
  if (local?.groups !== undefined) {
    return {
      kind: "local",
      resourceId: local.groups.resourceId!,
      access: local.groups.access as "read" | "write"
    };
  }
  throw usageError(
    `Environment plan is invalid: ${value}. Use empty, scratch, or local:<resource>:<read|write>.`,
    usage
  );
}

function fingerprint(parts: readonly string[]): string {
  return createHash("sha256").update(JSON.stringify(parts)).digest("hex");
}

/** Domain rejections are caller mistakes here, so they carry the usage text. */
function attempt<T>(usage: string, action: () => T): T {
  try {
    return action();
  } catch (error) {
    throw usageError(error instanceof Error ? error.message : String(error), usage);
  }
}

function requireTask(store: TaskWorkflowStore, taskId: string): Task {
  const task = store.getTask(taskId);
  if (task === null) throw usageError(`Task not found: ${taskId}.`);
  return task;
}

type ParsedTail = Readonly<{
  positionals: readonly string[];
  options: ReadonlyMap<string, string>;
}>;

function parseTail(
  args: readonly string[],
  valueOptions: ReadonlySet<string>,
  usage: string
): ParsedTail {
  const positionals: string[] = [];
  const options = new Map<string, string>();
  for (let index = 0; index < args.length; index += 1) {
    const value = args[index]!;
    if (!value.startsWith("--")) {
      positionals.push(value);
      continue;
    }
    if (!valueOptions.has(value)) throw usageError(`Unsupported option: ${value}.`, usage);
    if (options.has(value)) {
      throw usageError(`Option may only be specified once: ${value}.`, usage);
    }
    const optionValue = args[index + 1];
    if (optionValue === undefined || optionValue.startsWith("--")) {
      throw usageError(`${value} is required.`, usage);
    }
    options.set(value, optionValue);
    index += 1;
  }
  return { positionals, options };
}

function exactPositionals(
  values: readonly string[],
  count: number,
  usage: string
): void {
  if (values.length !== count || values.some((value) => value.trim().length === 0)) {
    throw usageError(usage);
  }
}

function requiredOption(
  options: ReadonlyMap<string, string>,
  name: string,
  usage: string
): string {
  const value = options.get(name)?.trim();
  if (value === undefined || value.length === 0) {
    throw usageError(`${name} is required.`, usage);
  }
  return value;
}

function output(value: string, data?: unknown): TaskCommandExecution {
  return data === undefined
    ? { kind: "output", output: value }
    : { kind: "output", output: value, data };
}
