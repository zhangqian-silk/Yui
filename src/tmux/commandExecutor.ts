import { spawnSync } from "node:child_process";

export type CommandRunOptions = Readonly<{
  inheritStdio?: boolean;
  timeoutMs?: number;
}>;

export type CommandExecutor = Readonly<{
  run(command: string, args: string[], options?: CommandRunOptions): string;
}>;

export type CommandExecutionErrorCode =
  | "COMMAND_FAILED"
  | "COMMAND_NOT_FOUND"
  | "COMMAND_TIMED_OUT";

export class CommandExecutionError extends Error {
  constructor(
    readonly code: CommandExecutionErrorCode,
    readonly exitStatus?: number,
    readonly stderr = ""
  ) {
    super(commandExecutionMessage(code));
    this.name = "CommandExecutionError";
  }
}

export class NodeCommandExecutor implements CommandExecutor {
  run(command: string, args: string[], options: CommandRunOptions = {}): string {
    const common = options.timeoutMs === undefined ? {} : { timeout: options.timeoutMs };
    const result = options.inheritStdio === true
      ? spawnSync(command, args, { ...common, stdio: "inherit" })
      : spawnSync(command, args, {
          ...common,
          encoding: "utf8",
          stdio: ["ignore", "pipe", "pipe"]
        });

    if (result.error !== undefined || result.status !== 0) {
      throw stableCommandExecutionError(result);
    }
    return options.inheritStdio === true ? "" : String(result.stdout ?? "");
  }
}

function stableCommandExecutionError(error: unknown): CommandExecutionError {
  const details = errorDetails(error);
  if (details.code === "ENOENT") {
    return new CommandExecutionError("COMMAND_NOT_FOUND", details.exitStatus, details.stderr);
  }
  if (
    details.code === "ETIMEDOUT"
    || details.signal === "SIGTERM"
    || details.signal === "SIGKILL"
  ) {
    return new CommandExecutionError("COMMAND_TIMED_OUT", details.exitStatus, details.stderr);
  }
  return new CommandExecutionError("COMMAND_FAILED", details.exitStatus, details.stderr);
}

function errorDetails(error: unknown): {
  code?: string;
  signal?: string;
  exitStatus?: number;
  stderr: string;
} {
  if (typeof error !== "object" || error === null) return { stderr: "" };
  const candidate = error as Record<string, unknown>;
  const nested = typeof candidate.error === "object" && candidate.error !== null
    ? candidate.error as Record<string, unknown>
    : {};
  return {
    ...(typeof candidate.code === "string"
      ? { code: candidate.code }
      : typeof nested.code === "string" ? { code: nested.code } : {}),
    ...(typeof candidate.signal === "string" ? { signal: candidate.signal } : {}),
    ...(typeof candidate.status === "number" ? { exitStatus: candidate.status } : {}),
    stderr: typeof candidate.stderr === "string"
      ? candidate.stderr
      : Buffer.isBuffer(candidate.stderr) ? candidate.stderr.toString("utf8") : ""
  };
}

function commandExecutionMessage(code: CommandExecutionErrorCode): string {
  switch (code) {
    case "COMMAND_NOT_FOUND":
      return "Command was not found.";
    case "COMMAND_TIMED_OUT":
      return "Command execution timed out.";
    case "COMMAND_FAILED":
      return "Command execution failed.";
  }
}
