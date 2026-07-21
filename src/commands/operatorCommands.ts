import { usageError } from "../errors/cliError.js";
import {
  submitOperatorMessage,
  type TaskCommandExecution,
  type TaskCommandOptions,
  type TaskWorkflowStore
} from "./taskCommands.js";

/** Operator is intentionally small: interactive entry is owned by the tmux CLI path. */
export function runOperatorCommand(
  args: string[],
  store: TaskWorkflowStore,
  options: TaskCommandOptions = {}
): TaskCommandExecution {
  const [command, ...rest] = args;
  if (command !== "submit") {
    throw usageError(command === undefined
      ? "Operator command is required."
      : `Unknown command: operator ${command}`);
  }

  const usage = "Operator submit usage: taskmux operator submit <body> [--task <id>].";
  const positionals: string[] = [];
  let taskId: string | undefined;
  for (let index = 0; index < rest.length; index += 1) {
    const value = rest[index];
    if (value !== "--task") {
      if (value.startsWith("--")) throw usageError(`Unsupported option: ${value}.`, usage);
      positionals.push(value);
      continue;
    }
    if (taskId !== undefined) throw usageError("Option may only be specified once: --task.", usage);
    const candidate = rest[index + 1];
    if (candidate === undefined || candidate.startsWith("--")) {
      throw usageError("--task is required.", usage);
    }
    taskId = candidate.trim();
    index += 1;
  }
  if (positionals.length !== 1 || positionals[0].trim().length === 0) {
    throw usageError(usage);
  }
  return {
    kind: "output",
    output: submitOperatorMessage(positionals[0], taskId, store, options)
  };
}
