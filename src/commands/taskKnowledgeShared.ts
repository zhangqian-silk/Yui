import { usageError } from "../errors/cliError.js";
import { createTaskEvent, type TaskEventPayload } from "../event/taskEvent.js";
import type { TaskStore } from "../storage/taskStore.js";

export type TaskWorkflowStore = TaskStore;

export type TaskCommandOptions = Readonly<{
  runtime?: { notifyStateChanged(taskId: string): void };
  now?: () => Date;
  environment?: NodeJS.ProcessEnv;
}>;

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

export function clock(options: TaskCommandOptions): Date {
  return options.now?.() ?? new Date();
}

export function recordTaskEvent(
  store: TaskWorkflowStore,
  taskId: string,
  type: string,
  payload: TaskEventPayload,
  now: Date
): void {
  store.saveEvent(taskId, createTaskEvent(store.nextEventId(taskId), type, payload, now));
}
