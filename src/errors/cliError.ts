export type CliErrorCode =
  | "USAGE_ERROR"
  | "TASK_NOT_FOUND"
  | "ROLE_NOT_FOUND"
  | "AGENT_NOT_FOUND"
  | "DATA_ERROR"
  | "RUNTIME_ERROR";

const EXIT_CODES: Record<CliErrorCode, number> = {
  USAGE_ERROR: 2,
  TASK_NOT_FOUND: 3,
  ROLE_NOT_FOUND: 3,
  AGENT_NOT_FOUND: 3,
  DATA_ERROR: 4,
  RUNTIME_ERROR: 5
};

export class CliError extends Error {
  readonly exitCode: number;

  constructor(readonly code: CliErrorCode, message: string, readonly helpText?: string) {
    super(message);
    this.name = "CliError";
    this.exitCode = EXIT_CODES[code];
  }
}

export function usageError(message: string, helpText?: string): CliError {
  return new CliError("USAGE_ERROR", message, helpText);
}

export function taskNotFound(id: string): CliError {
  return new CliError("TASK_NOT_FOUND", `Task not found: ${id}`);
}

export function roleNotFound(name: string): CliError {
  return new CliError("ROLE_NOT_FOUND", `Role not found: ${name}`);
}

export function roleConflict(name: string): CliError {
  return usageError(`Role conflict: ${name}. Refresh and retry.`);
}

export function agentNotFound(id: string): CliError {
  return new CliError("AGENT_NOT_FOUND", `Agent not found: ${id}`);
}

export function dataError(message: string): CliError {
  return new CliError("DATA_ERROR", message);
}

export function runtimeError(message: string): CliError {
  return new CliError("RUNTIME_ERROR", message);
}
