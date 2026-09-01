import { dataError, roleNotFound, taskNotFound, usageError } from "../errors/cliError.js";
import { createTaskEvent, type TaskEventPayload } from "../event/taskEvent.js";
import {
  activeLiveRoleAgentSession,
  type TaskRoleSessionSet
} from "../executor/agentExecutor.js";
import {
  answerInputRequest,
  cancelInputRequest,
  createInputRequest,
  type InputAnswer,
  type InputBlockedRef,
  type InputChoice,
  type InputRequest,
  type InputRequestPolicy,
  type InputRequester
} from "../input/inputRequest.js";
import { defaultTableWidth, renderTable } from "../output/table.js";
import { formatTimestamp } from "../output/timePresentation.js";
import { type Role } from "../role/role.js";
import type { Turn } from "../turn/turn.js";
import { enqueueWork } from "../coordination/workMailboxQueue.js";
import type { MailboxTarget } from "../coordination/workMailbox.js";
import {
  isRoleTurnStalled,
  TURN_RECOVERED_EVENT
} from "../scheduler/roleTurnStall.js";
import type { TaskStore } from "../storage/taskStore.js";
import {
  hasRuntimeCleanupObligation,
  isRuntimeLaunchReservation,
  runtimeLifecycleTarget
} from "../runtime/lifecycleReservation.js";
import {
  isLinuxProcessLive,
  listOwnedProcessTree
} from "../runtime/sessionOwnerIdentity.js";
import type { Task } from "../task/task.js";
import {
  resolveTaskRecordReference
} from "../task/taskRecordReference.js";

const LEADER_ROLE = "leader";

type TaskInputCommandOptions = Readonly<{
  runtime?: {
    notifyStateChanged(taskId: string): void;
    notifyMailboxChanged?(target: MailboxTarget): void;
  };
  now?: () => Date;
  environment?: NodeJS.ProcessEnv;
}>;

export type TaskInputCommandExecution = Readonly<{
  kind: "output";
  output: string;
  data?: unknown;
}>;

export function runTaskInputCommand(
  args: string[],
  store: TaskStore,
  options: TaskInputCommandOptions
): TaskInputCommandExecution {
  const [command, ...rest] = args;
  switch (command) {
    case "request": return createRequest(rest, store, options);
    case "list": return listRequests(rest, store);
    case "show": return showRequest(rest, store, options);
    case "answer": return answerRequest(rest, store, options);
    case "cancel": return cancelRequest(rest, store, options);
    default:
      throw usageError(command === undefined
        ? "Task input command is required."
        : `Unknown command: task input ${command}`);
  }
}

export function openInputRequestCount(store: TaskStore, taskId: string): number {
  return store.listInputRequests(taskId).filter((request) => request.status === "open").length;
}

export function assertNoOpenInputRequests(
  store: TaskStore,
  taskId: string,
  action: string
): void {
  const open = store.listInputRequests(taskId).find((request) => request.status === "open");
  if (open !== undefined) {
    throw usageError(`Task ${taskId} has open input ${open.id}; resolve it before ${action}.`);
  }
}

function createRequest(
  args: string[],
  store: TaskStore,
  options: TaskInputCommandOptions
): TaskInputCommandExecution {
  const usage = "Task input request usage: yui task input request <task> --question <text> [--choice <key=label> ...] [--blocks <work-item:id|run:id> ...] [--recommend <key> --timeout-seconds <seconds>].";
  const parsed = parseMultiValueTail(
    args,
    new Set(["--question", "--recommend", "--timeout-seconds"]),
    new Set(["--choice", "--blocks"]),
    usage
  );
  exactPositionals(parsed.positionals, 1, usage);
  const question = requiredOption(parsed.options, "--question");
  const choices = (parsed.multiOptions.get("--choice") ?? []).map(parseInputChoice);
  const blockedValues = parsed.multiOptions.get("--blocks") ?? [];
  const recommendedChoiceKey = optionalNonEmptyOption(parsed.options, "--recommend");
  const timeoutSeconds = optionalNonEmptyOption(parsed.options, "--timeout-seconds");
  if ((recommendedChoiceKey === undefined) !== (timeoutSeconds === undefined)) {
    throw usageError("--recommend and --timeout-seconds must be used together.", usage);
  }
  const now = clock(options);
  const policy: InputRequestPolicy = recommendedChoiceKey === undefined
    ? { kind: "required" }
    : {
        kind: "recommended",
        recommendedChoiceKey,
        timeoutAt: timeoutAfter(now, timeoutSeconds!)
      };
  const request = store.transaction((tx) => {
    const task = requireTask(tx, parsed.positionals[0]);
    if (task.status !== "active") throw usageError(inactiveTaskMessage(task, "requesting input"));
    const blockedRefs = blockedValues.map((value) => parseInputBlockedRef(value, task.id));
    validateBlockedInputOwnership(tx, task.id, blockedRefs);
    const origin = requireLeaderInputOrigin(tx, task.id, options.environment);
    const created = createInputRequest(
      tx.nextInputRequestId(task.id),
      task.id,
      origin.requester,
      { question, choices, blockedRefs, policy },
      now
    );
    const wasStalled = isRoleTurnStalled(tx.listEvents(task.id), origin.turn.id);
    tx.saveInputRequest(task.id, created);
    enqueueWork(tx, { kind: "operator" }, "input-requested", now, [
      { type: "input", taskId: task.id, id: created.id }
    ], {
      source: "input-request",
      dedupeKey: `operator-input:${task.id}:${created.id}`
    });
    if (wasStalled) {
      recordTaskEvent(tx, task.id, TURN_RECOVERED_EVENT, {
        turnId: origin.turn.id,
        roleName: LEADER_ROLE,
        progressAt: now.toISOString(),
        kind: "input-request"
      }, now);
    }
    recordTaskEvent(tx, task.id, "input.requested", {
      requestId: created.id,
      requesterTurnId: created.requester.turnId,
      policy: created.policy.kind
    }, now);
    return created;
  });
  notifyMailbox(options, { kind: "operator" }, request.taskId);
  return output(`Created input request ${request.id} for ${request.taskId}\n`, { request });
}

function listRequests(args: string[], store: TaskStore): TaskInputCommandExecution {
  const usage = "Task input list usage: yui task input list [task] [--all].";
  const parsed = parseTail(args, new Set(), usage, new Set(["--all"]));
  if (parsed.positionals.length > 1) throw usageError(usage);
  const taskId = parsed.positionals[0];
  if (taskId !== undefined) requireTask(store, taskId);
  const all = taskId === undefined
    ? store.listAllInputRequests()
    : store.listInputRequests(taskId);
  const requests = parsed.options.has("--all")
    ? all
    : all.filter((request) => request.status === "open");
  let rendered = "No input requests found.\n";
  if (requests.length > 0) {
    const timeZone = store.getConfig().timeZone;
    rendered = `${renderTable(
        taskId === undefined ? "Input inbox" : `Input requests: ${taskId}`,
        [
          { header: "Input", minWidth: 6, maxWidth: 18 },
          { header: "Task", minWidth: 6, maxWidth: 18 },
          { header: "Status", minWidth: 6, maxWidth: 10 },
          { header: "Policy", minWidth: 8, maxWidth: 12 },
          { header: "Question", minWidth: 8, maxWidth: 72 },
          { header: "Created", minWidth: 10, maxWidth: 28 }
        ],
        requests.map((request) => [
          taskId === undefined ? `${request.taskId}/${request.id}` : request.id,
          request.taskId,
          request.status,
          request.policy.kind,
          request.question,
          formatTimestamp(request.createdAt, timeZone)
        ]),
        defaultTableWidth()
      )}\n`;
  }
  return output(rendered, { requests });
}

function showRequest(
  args: string[],
  store: TaskStore,
  options: TaskInputCommandOptions
): TaskInputCommandExecution {
  const usage = "Task input show usage: yui task input show (<task>/<input> | <input> --task <task>).";
  const parsed = parseTail(args, new Set(["--task"]), usage);
  exactPositionals(parsed.positionals, 1, usage);
  const reference = inputRequestReference(
    store,
    parsed.positionals[0],
    optionalNonEmptyOption(parsed.options, "--task"),
    options.environment
  );
  const request = store.getInputRequest(reference.taskId, reference.localId);
  if (request === null) {
    throw dataError(`Input request not found: ${reference.taskId}/${reference.localId}.`);
  }
  return output(renderInputRequest(request, store.getConfig().timeZone), { request });
}

function answerRequest(
  args: string[],
  store: TaskStore,
  options: TaskInputCommandOptions
): TaskInputCommandExecution {
  const usage = "Task input answer usage: yui task input answer (<task>/<input> | <input> --task <task>) (--choice <key> | --text <text>).";
  const parsed = parseTail(args, new Set(["--task", "--choice", "--text"]), usage);
  exactPositionals(parsed.positionals, 1, usage);
  const choice = optionalNonEmptyOption(parsed.options, "--choice");
  const text = optionalNonEmptyOption(parsed.options, "--text");
  if ((choice === undefined) === (text === undefined)) {
    throw usageError("Exactly one of --choice or --text is required.", usage);
  }
  const reference = inputRequestReference(
    store,
    parsed.positionals[0],
    optionalNonEmptyOption(parsed.options, "--task"),
    options.environment
  );
  const located = store.getInputRequest(reference.taskId, reference.localId);
  if (located === null) {
    throw dataError(`Input request not found: ${reference.taskId}/${reference.localId}.`);
  }
  const answer: InputAnswer = choice === undefined ? { text: text! } : { choiceKey: choice };
  const now = clock(options);
  const request = store.transaction((tx) => {
    const current = tx.getInputRequest(located.taskId, located.id);
    if (current === null) throw dataError(`Input request not found: ${located.id}.`);
    const task = requireTask(tx, current.taskId);
    if (task.status !== "active") throw usageError(inactiveTaskMessage(task, "answering input"));
    const answered = answerInputRequest(current, answer, inputAnswerer(options.environment), now);
    tx.saveInputRequest(task.id, answered);
    recordTaskEvent(tx, task.id, "input.answered", {
      requestId: answered.id,
      answeredBy: answered.resolution.answeredBy
    }, now);
    enqueueWork(
      tx,
      { kind: "role", taskId: task.id, roleName: LEADER_ROLE },
      `input-answered:${answered.id}`,
      now,
      [{ type: "input", taskId: task.id, id: answered.id }]
    );
    return answered;
  });
  notifyMailbox(options, { kind: "role", taskId: request.taskId, roleName: LEADER_ROLE }, request.taskId);
  return output(`Answered input request ${request.id} for ${request.taskId}\n`, { request });
}

function cancelRequest(
  args: string[],
  store: TaskStore,
  options: TaskInputCommandOptions
): TaskInputCommandExecution {
  const usage = "Task input cancel usage: yui task input cancel <task> <input> --reason <text>.";
  const parsed = parseTail(args, new Set(["--reason"]), usage);
  exactPositionals(parsed.positionals, 2, usage);
  const reason = requiredOption(parsed.options, "--reason");
  const now = clock(options);
  const request = store.transaction((tx) => {
    const task = requireTask(tx, parsed.positionals[0]);
    if (task.status !== "active") throw usageError(inactiveTaskMessage(task, "cancelling input"));
    const current = tx.getInputRequest(task.id, parsed.positionals[1]);
    if (current === null) throw dataError(`Input request not found: ${parsed.positionals[1]}.`);
    const cancelledBy = assertInputCancelOrigin(tx, current, options.environment);
    const cancelled = cancelInputRequest(current, reason, now);
    if (cancelled.status !== "cancelled") {
      throw new Error(`Input request ${cancelled.id} did not enter the cancelled state.`);
    }
    tx.saveInputRequest(task.id, cancelled);
    recordTaskEvent(tx, task.id, "input.cancelled", {
      requestId: cancelled.id,
      cancelledBy,
      reason: cancelled.cancellation.reason
    }, now);
    enqueueWork(
      tx,
      { kind: "role", taskId: task.id, roleName: LEADER_ROLE },
      `input-cancelled:${cancelled.id}`,
      now,
      [{ type: "input", taskId: task.id, id: cancelled.id }]
    );
    return cancelled;
  });
  notifyMailbox(options, { kind: "role", taskId: request.taskId, roleName: LEADER_ROLE }, request.taskId);
  return output(`Cancelled input request ${request.id} for ${request.taskId}\n`, { request });
}

function requireLeaderInputOrigin(
  store: TaskStore,
  taskId: string,
  environment: NodeJS.ProcessEnv | undefined
): Readonly<{
  requester: InputRequester;
  role: Role;
  turn: Turn;
  sessions: TaskRoleSessionSet | null;
}> {
  const env = environment ?? {};
  const role = requireRole(store, taskId, LEADER_ROLE);
  const turn = store.getActiveTurn(taskId, LEADER_ROLE);
  if (
    env.YUI_SESSION_SCOPE !== "task"
    || env.YUI_TASK_ID !== taskId
    || env.YUI_ROLE !== LEADER_ROLE
    || turn === null
    || env.YUI_AGENT_ID !== turn.effective.agentId
    || turn.status !== "active"
    || turn.workItemId !== undefined
  ) {
    throw usageError("Task input request requires the active Leader Turn environment.");
  }
  const sessions = store.getTaskRoleSessionSet(taskId, LEADER_ROLE);
  const nativeSessionId = trimmed(env.YUI_NATIVE_SESSION_ID);
  if (nativeSessionId !== undefined
    && sessions?.sessions[turn.effective.agentId]?.nativeSessionId !== nativeSessionId) {
    throw usageError("Task input request native session does not match the active Leader session.");
  }
  return {
    requester: {
      taskId,
      roleName: "leader",
      agentId: turn.effective.agentId,
      turnId: turn.id,
      ...(nativeSessionId === undefined ? {} : { nativeSessionId })
    },
    role,
    turn,
    sessions
  };
}

function assertInputCancelOrigin(
  store: Pick<TaskStore, "getGlobalRole" | "getGlobalRoleSessionSet">,
  request: InputRequest,
  environment: NodeJS.ProcessEnv | undefined
): "leader" | "operator" {
  const env = environment ?? {};
  if (isCurrentGlobalOperator(store, env)) {
    return "operator";
  }
  if (
    env.YUI_SESSION_SCOPE !== "task"
    || env.YUI_TASK_ID !== request.taskId
    || env.YUI_ROLE !== request.requester.roleName
    || env.YUI_AGENT_ID !== request.requester.agentId
    || (request.requester.nativeSessionId !== undefined
      && env.YUI_NATIVE_SESSION_ID !== request.requester.nativeSessionId)
  ) {
    throw usageError("Only the originating Leader may cancel this input request.");
  }
  return "leader";
}

export function isCurrentGlobalOperator(
  store: Pick<TaskStore, "getGlobalRole" | "getGlobalRoleSessionSet">
    & Partial<Pick<TaskStore, "getSessionOwner" | "getWorkMailbox">>,
  environment: NodeJS.ProcessEnv
): boolean {
  if (
    environment.YUI_SESSION_SCOPE !== "global"
    || environment.YUI_ROLE !== "operator"
    || environment.YUI_TASK_ID !== undefined
  ) return false;
  const role = store.getGlobalRole("operator");
  if (role === null) return false;
  const agentId = exactIdentity(environment.YUI_AGENT_ID);
  const adapterId = exactIdentity(environment.YUI_ADAPTER_ID);
  const launchId = exactIdentity(environment.YUI_LAUNCH_ID);
  const nativeSessionId = exactIdentity(environment.YUI_NATIVE_SESSION_ID);
  const binding = role.agentBindings[role.activeAgentId];
  if (agentId === undefined
    || adapterId === undefined
    || launchId === undefined
    || binding === undefined
    || binding.agentId !== agentId
    || binding.adapterId !== adapterId) return false;
  const sessions = store.getGlobalRoleSessionSet(role.name);
  const session = activeLiveRoleAgentSession(sessions);
  if (sessions === null || session === null || sessions.activeAgentId !== role.activeAgentId) {
    // Codex learns its native Session ID only after the first Turn. During
    // that narrow bootstrap window, authenticate against the durable launch
    // reservation and its strongly attributed live process owner instead.
    return nativeSessionId === undefined
      && binding.adapterId === "codex"
      && currentProcessBelongsToReservedGlobalLaunch(store, {
        roleName: role.name,
        agentId,
        adapterId,
        launchId
      });
  }
  // A fresh Codex launch discovers its native Session asynchronously. Its
  // launch envelope therefore cannot carry YUI_NATIVE_SESSION_ID, but the
  // durable Session still binds that provider identity to the exact launch
  // generation. Accept that one transport shape only when the current
  // launch, Agent, and adapter all match; Claude and stale/unknown launches
  // remain fail-closed on the native identity fence.
  const nativeSessionMatches = binding !== undefined && (
    nativeSessionId === session.nativeSessionId
      || (nativeSessionId === undefined
        && binding.adapterId === "codex"
        && session.adapterId === "codex"
        && session.launchId !== undefined
        && session.launchId === launchId)
  );
  return binding.agentId === session.agentId
    && binding.adapterId === session.adapterId
    && session.agentId === agentId
    && session.adapterId === adapterId
    && session.launchId !== undefined
    && session.launchId === launchId
    && nativeSessionMatches;
}

function currentProcessBelongsToReservedGlobalLaunch(
  store: Partial<Pick<TaskStore, "getSessionOwner" | "getWorkMailbox">>,
  input: Readonly<{
    roleName: string;
    agentId: string;
    adapterId: string;
    launchId: string;
  }>
): boolean {
  if (store.getSessionOwner === undefined || store.getWorkMailbox === undefined) return false;
  const mailbox = store.getWorkMailbox(runtimeLifecycleTarget({
    scope: "global",
    roleName: input.roleName
  }));
  if (!isRuntimeLaunchReservation(mailbox?.processing, input.launchId)
    || hasRuntimeCleanupObligation(mailbox)) return false;
  const owner = store.getSessionOwner(input.launchId);
  if (owner === null
    || owner.owner.scope !== "global"
    || owner.owner.roleName !== input.roleName
    || owner.agentId !== input.agentId
    || owner.adapterId !== input.adapterId
    || owner.launchId !== input.launchId
    || owner.providerRoot.attribution !== "launch-env"
    || !isLinuxProcessLive(owner.providerRoot.pid, owner.providerRoot.startIdentity)) {
    return false;
  }
  return listOwnedProcessTree(
    owner.providerRoot.pid,
    owner.providerRoot.processGroupId
  ).some(({ pid }) => pid === process.pid);
}

function inputAnswerer(environment: NodeJS.ProcessEnv | undefined): "user" | "operator" {
  const env = environment ?? {};
  if (env.YUI_SESSION_SCOPE === undefined && env.YUI_ROLE === undefined) return "user";
  if (env.YUI_SESSION_SCOPE === "global" && env.YUI_ROLE === "operator") return "operator";
  throw usageError("Task input answers may be submitted only by the user or Operator.");
}

function parseInputChoice(value: string): InputChoice {
  const separator = value.indexOf("=");
  if (separator <= 0 || separator === value.length - 1) {
    throw usageError("--choice must use key=label.");
  }
  return { key: value.slice(0, separator).trim(), label: value.slice(separator + 1).trim() };
}

function parseInputBlockedRef(value: string, taskId: string): InputBlockedRef {
  const separator = value.indexOf(":");
  const type = value.slice(0, separator);
  const id = value.slice(separator + 1).trim();
  if ((type !== "work-item" && type !== "turn") || separator <= 0 || id.length === 0) {
    throw usageError("--blocks must use work-item:<id> or turn:<id>.");
  }
  return { type, taskId, id };
}

function validateBlockedInputOwnership(
  store: TaskStore,
  taskId: string,
  references: readonly InputBlockedRef[]
): void {
  for (const reference of references) {
    const record = reference.type === "work-item"
      ? store.getWorkItem(taskId, reference.id)
      : store.getTurn(taskId, reference.id);
    if (record === null) throw dataError(`Blocked ${reference.type} not found: ${reference.id}.`);
  }
}

function inputRequestReference(
  store: TaskStore,
  value: string,
  taskHint: string | undefined,
  environment: NodeJS.ProcessEnv | undefined
) {
  const explicitTaskId = taskHint === undefined
    ? undefined
    : requireTask(store, taskHint).id;
  let reference;
  try {
    reference = resolveTaskRecordReference(value, {
      kind: "inputRequest",
      label: "Input request reference",
      ...(explicitTaskId !== undefined
        ? { contextTaskId: explicitTaskId }
        : environment?.YUI_TASK_ID === undefined
          ? {}
          : { contextTaskId: environment.YUI_TASK_ID })
    });
  } catch (error) {
    throw usageError(error instanceof Error ? error.message : String(error));
  }
  if (explicitTaskId !== undefined && reference.taskId !== explicitTaskId) {
    throw usageError(
      `Input request belongs to another Task: ${reference.taskId}/${reference.localId}.`
    );
  }
  return reference;
}

function renderInputRequest(request: InputRequest, timeZone: string | undefined): string {
  return [
    `Input: ${request.id}`,
    `Task: ${request.taskId}`,
    `Status: ${request.status}`,
    `Question: ${request.question}`,
    `Requested by: ${request.requester.agentId}/${request.requester.turnId}`,
    ...(request.choices.length === 0
      ? ["Answer type: text"]
      : ["Choices:", ...request.choices.map((choice) => `  ${choice.key}: ${choice.label}`)]),
    ...(request.blockedRefs.length === 0
      ? []
      : ["Blocks:", ...request.blockedRefs.map((reference) => `  ${reference.type}:${reference.id}`)]),
    ...(request.policy.kind === "required"
      ? ["Policy: user response required"]
      : [
          `Policy: use recommended choice ${request.policy.recommendedChoiceKey} after timeout`,
          `Timeout: ${formatTimestamp(request.policy.timeoutAt, timeZone)}`
        ]),
    ...(request.status === "answered"
      ? [
          `Answered by: ${request.resolution.answeredBy}`,
          `Answer: ${request.resolution.answer.text}`,
          `Answered: ${formatTimestamp(request.resolution.answeredAt, timeZone)}`
        ]
      : request.status === "cancelled"
        ? [
            `Cancellation: ${request.cancellation.reason}`,
            `Cancelled: ${formatTimestamp(request.cancellation.cancelledAt, timeZone)}`
          ]
        : []),
    `Created: ${formatTimestamp(request.createdAt, timeZone)}`,
    `Updated: ${formatTimestamp(request.updatedAt, timeZone)}`
  ].join("\n").concat("\n");
}

function requireTask(store: TaskStore, taskId: string | undefined): Task {
  const id = requiredText(taskId, "Task id");
  const task = store.getTask(id);
  if (task === null) throw taskNotFound(id);
  return task;
}

function requireRole(store: TaskStore, taskId: string, roleName: string): Role {
  const role = store.getRole(taskId, roleName);
  if (role === null) throw roleNotFound(roleName);
  return role;
}

function inactiveTaskMessage(task: Task, action: string): string {
  if (task.status === "draft") {
    return `Task ${task.id} is a Draft; activate it before ${action}.`;
  }
  if (task.status === "completed") {
    return `Task ${task.id} is completed; reopen it before ${action}.`;
  }
  if (task.status === "retired") return `Task ${task.id} is retired; it cannot resume ${action}.`;
  return `Task is archived: ${task.id}.`;
}

function requiredOption(options: ReadonlyMap<string, string>, name: string): string {
  return requiredText(options.get(name), name);
}

function optionalNonEmptyOption(
  options: ReadonlyMap<string, string>,
  name: string
): string | undefined {
  if (!options.has(name)) return undefined;
  return requiredText(options.get(name), name);
}

function output(value: string, data?: unknown): TaskInputCommandExecution {
  return data === undefined
    ? { kind: "output", output: value }
    : { kind: "output", output: value, data };
}

function clock(options: TaskInputCommandOptions): Date {
  return options.now?.() ?? new Date();
}

function recordTaskEvent(
  store: TaskStore,
  taskId: string,
  type: string,
  payload: TaskEventPayload,
  now: Date
): void {
  store.saveEvent(taskId, createTaskEvent(
    store.nextEventId(taskId), taskId, type, payload, now
  ));
}

function requiredText(value: string | undefined, label: string): string {
  const normalized = value?.trim();
  if (normalized === undefined || normalized.length === 0) throw usageError(`${label} is required.`);
  return normalized;
}

function trimmed(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized === undefined || normalized.length === 0 ? undefined : normalized;
}

function exactIdentity(value: string | undefined): string | undefined {
  if (value === undefined || value.includes("\0")) return undefined;
  const normalized = value.trim();
  return normalized.length === 0 || normalized !== value ? undefined : normalized;
}

function timeoutAfter(now: Date, value: string): string {
  if (!/^[1-9][0-9]*$/.test(value)) {
    throw usageError("--timeout-seconds must be a positive integer.");
  }
  const seconds = Number(value);
  const timestamp = now.getTime() + seconds * 1_000;
  const timeout = new Date(timestamp);
  if (!Number.isSafeInteger(seconds) || !Number.isFinite(timeout.getTime())) {
    throw usageError("--timeout-seconds is too large.");
  }
  return timeout.toISOString();
}

function exactPositionals(values: readonly string[], count: number, usage: string): void {
  if (values.length !== count || values.some((value) => value.trim().length === 0)) {
    throw usageError(usage);
  }
}

type ParsedTail = Readonly<{
  positionals: string[];
  options: ReadonlyMap<string, string>;
}>;

function parseTail(
  args: string[],
  valueOptions: ReadonlySet<string>,
  usage: string,
  flagOptions: ReadonlySet<string> = new Set()
): ParsedTail {
  const positionals: string[] = [];
  const options = new Map<string, string>();
  for (let index = 0; index < args.length; index += 1) {
    const value = args[index];
    if (!value.startsWith("--")) {
      positionals.push(value);
      continue;
    }
    if (!valueOptions.has(value) && !flagOptions.has(value)) {
      throw usageError(`Unsupported option: ${value}.`, usage);
    }
    if (options.has(value)) throw usageError(`Option may only be specified once: ${value}.`, usage);
    if (flagOptions.has(value)) {
      options.set(value, "");
      continue;
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

type ParsedMultiTail = Readonly<{
  positionals: string[];
  options: ReadonlyMap<string, string>;
  multiOptions: ReadonlyMap<string, string[]>;
}>;

function parseMultiValueTail(
  args: string[],
  valueOptions: ReadonlySet<string>,
  repeatOptions: ReadonlySet<string>,
  usage: string
): ParsedMultiTail {
  const positionals: string[] = [];
  const options = new Map<string, string>();
  const multiOptions = new Map<string, string[]>();
  for (let index = 0; index < args.length; index += 1) {
    const value = args[index];
    if (!value.startsWith("--")) {
      positionals.push(value);
      continue;
    }
    if (!valueOptions.has(value) && !repeatOptions.has(value)) {
      throw usageError(`Unsupported option: ${value}.`, usage);
    }
    if (repeatOptions.has(value)) {
      const optionValue = args[index + 1];
      if (optionValue === undefined || optionValue.startsWith("--")) {
        throw usageError(`${value} is required.`, usage);
      }
      multiOptions.set(value, [...(multiOptions.get(value) ?? []), optionValue]);
      index += 1;
      continue;
    }
    if (options.has(value)) throw usageError(`Option may only be specified once: ${value}.`, usage);
    const optionValue = args[index + 1];
    if (optionValue === undefined || optionValue.startsWith("--")) {
      throw usageError(`${value} is required.`, usage);
    }
    options.set(value, optionValue);
    index += 1;
  }
  return { positionals, options, multiOptions };
}

function notifyMailbox(
  options: TaskInputCommandOptions,
  target: MailboxTarget,
  compatibilityTaskId: string
): void {
  if (options.runtime?.notifyMailboxChanged !== undefined) {
    options.runtime.notifyMailboxChanged(target);
  } else {
    options.runtime?.notifyStateChanged(compatibilityTaskId);
  }
}
