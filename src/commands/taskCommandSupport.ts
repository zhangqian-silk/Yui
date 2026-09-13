import {
  type MailboxEntityRef,
  type MailboxTarget
} from "../coordination/workMailbox.js";
import {
  taskNotFound,
  usageError
} from "../errors/cliError.js";
import { createTaskEvent, type TaskEvent, type TaskEventPayload } from "../event/taskEvent.js";
import { formatTimestamp } from "../output/timePresentation.js";
import { SYSTEM_LEADER_ROLE as LEADER_ROLE } from "../role/systemRoles.js";
import { currentManagedRuntime } from "../runtime/managedCaller.js";
import {
  type Task
} from "../task/task.js";
import {
  taskLocalActor as resolveTaskLocalActor
} from "../task/taskAuthority.js";
import type {
  TaskCommandExecution,
  TaskCommandOptions,
  TaskWorkflowRuntimePort,
  TaskWorkflowStore
} from "./taskCommandTypes.js";
export function recordTaskEvent(
  store: TaskWorkflowStore,
  taskId: string,
  type: string,
  payload: TaskEventPayload,
  now: Date
): TaskEvent {
  return recordTaskEventRecord(store, taskId, type, payload, now);
}


export function leaderActionEventPayload(
  store: TaskWorkflowStore,
  taskId: string,
  options: TaskCommandOptions
): TaskEventPayload {
  const caller = currentManagedRuntime(store, options.environment, taskId, "leader");
  // A long-lived Session may be handling direct input while another request
  // awaits admission. The Role's active pointer cannot prove command origin.
  return caller === undefined ? {} : { leaderNativeSessionId: caller.nativeSessionId };
}


export function recordTaskEventRecord(
  store: TaskWorkflowStore,
  taskId: string,
  type: string,
  payload: TaskEventPayload,
  now: Date
): TaskEvent {
  const event = createTaskEvent(store.nextEventId(taskId), taskId, type, payload, now);
  store.saveEvent(taskId, event);
  return event;
}


export function requireTask(store: TaskWorkflowStore, taskId: string | undefined): Task {
  const id = requiredText(taskId, "Task id");
  const task = store.getTask(id);
  if (task === null) throw taskNotFound(id);
  return task;
}


export function assertTaskOpen(task: Task): void {
  if (task.status === "completed") {
    throw usageError(`Task ${task.id} is completed; reopen it before continuing.`);
  }
  if (task.status === "archived") throw usageError(`Task is archived: ${task.id}.`);
  if (task.status === "cancelled") throw usageError(`Task is retired: ${task.id}.`);
}


export function taskActor(
  store: Pick<
    TaskWorkflowStore,
    "getRole" | "getActiveRun" | "getTaskRoleSessionSet" | "listEventsByType"
  >,
  options: TaskCommandOptions,
  taskId: string
) {
  return resolveTaskLocalActor(store, options.environment, taskId);
}


export type ParsedMultiTail = Readonly<{
  positionals: string[];
  options: ReadonlyMap<string, string>;
  multiOptions: ReadonlyMap<string, string[]>;
}>;


export function parseMultiValueTail(
  args: string[],
  valueOptions: ReadonlySet<string>,
  repeatOptions: ReadonlySet<string>,
  usage: string,
  flagOptions: ReadonlySet<string> = new Set()
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
    if (!valueOptions.has(value) && !repeatOptions.has(value) && !flagOptions.has(value)) {
      throw usageError(`Unsupported option: ${value}.`, usage);
    }
    if (flagOptions.has(value)) {
      if (options.has(value)) throw usageError(`Option may only be specified once: ${value}.`, usage);
      options.set(value, "");
      continue;
    }
    if (repeatOptions.has(value)) {
      const optionValue = args[index + 1];
      if (optionValue === undefined || optionValue.startsWith("--")) {
        throw usageError(`${value} is required.`, usage);
      }
      const existing = multiOptions.get(value) ?? [];
      multiOptions.set(value, [...existing, optionValue]);
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


export type ParsedTail = Readonly<{
  positionals: string[];
  options: ReadonlyMap<string, string>;
}>;


export function parseTail(
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


export function requiredOption(options: ReadonlyMap<string, string>, name: string): string {
  return requiredText(options.get(name), name);
}


export function optionalNonEmptyOption(
  options: ReadonlyMap<string, string>,
  name: string
): string | undefined {
  if (!options.has(name)) return undefined;
  return requiredText(options.get(name), name);
}


export function exactPositionals(values: readonly string[], count: number, usage: string): void {
  if (values.length !== count || values.some((value) => value.trim().length === 0)) {
    throw usageError(usage);
  }
}


export function requiredText(value: string | undefined, label: string): string {
  const normalized = value?.trim();
  if (normalized === undefined || normalized.length === 0) throw usageError(`${label} is required.`);
  return normalized;
}


export function trimmed(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized === undefined || normalized.length === 0 ? undefined : normalized;
}


export function presentTime(value: string, timeZone: string | undefined): string {
  return formatTimestamp(value, timeZone);
}


export function output(value: string, data?: unknown): TaskCommandExecution {
  return data === undefined
    ? { kind: "output", output: value }
    : { kind: "output", output: value, data };
}


export function clock(options: TaskCommandOptions): Date {
  return options.now?.() ?? new Date();
}


export function taskMailbox(taskId: string): MailboxTarget {
  return { kind: "task", taskId };
}


export function roleMailbox(taskId: string, roleName: string): MailboxTarget {
  return { kind: "role", taskId, roleName };
}


export function leaderMailbox(taskId: string): MailboxTarget {
  return roleMailbox(taskId, LEADER_ROLE);
}


export function taskRef(id: string): MailboxEntityRef {
  return { type: "task", id };
}


export function notifyMailbox(
  runtime: TaskWorkflowRuntimePort | undefined,
  target: MailboxTarget,
  compatibilityTaskId: string
): void {
  if (runtime?.notifyMailboxChanged !== undefined) {
    runtime.notifyMailboxChanged(target);
  } else {
    runtime?.notifyStateChanged(compatibilityTaskId);
  }
}
