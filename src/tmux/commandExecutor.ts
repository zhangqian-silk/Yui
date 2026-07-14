import { spawnSync } from "node:child_process";

export type CommandRunOptions = {
  inheritStdio?: boolean;
};

export type CommandExecutor = {
  run(command: string, args: string[], options?: CommandRunOptions): string;
};

export class CommandExecutionError extends Error {
  constructor(
    readonly code: "COMMAND_FAILED" | "COMMAND_NOT_FOUND" | "COMMAND_TIMED_OUT",
    readonly exitStatus?: number
  ) {
    super(commandExecutionMessage(code));
    this.name = "CommandExecutionError";
  }
}

export class NodeCommandExecutor implements CommandExecutor {
  run(command: string, args: string[], options: CommandRunOptions = {}): string {
    const result = options.inheritStdio === true
      ? spawnSync(command, args, { stdio: "inherit" })
      : spawnSync(command, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    if (result.error !== undefined || result.status !== 0) {
      throw stableCommandExecutionError(result);
    }
    return options.inheritStdio === true ? "" : String(result.stdout ?? "");
  }
}

function stableCommandExecutionError(error: unknown): CommandExecutionError {
  const details = errorDetails(error);
  if (details.code === "ENOENT") return new CommandExecutionError("COMMAND_NOT_FOUND");
  if (details.code === "ETIMEDOUT" || details.signal === "SIGTERM" || details.signal === "SIGKILL") {
    return new CommandExecutionError("COMMAND_TIMED_OUT", details.exitStatus);
  }
  return new CommandExecutionError("COMMAND_FAILED", details.exitStatus);
}

function errorDetails(error: unknown): {
  code?: string;
  signal?: string;
  exitStatus?: number;
} {
  if (typeof error !== "object" || error === null) return {};
  const candidate = error as Record<string, unknown>;
  const nested = typeof candidate.error === "object" && candidate.error !== null
    ? candidate.error as Record<string, unknown>
    : {};
  return {
    ...(typeof candidate.code === "string"
      ? { code: candidate.code }
      : typeof nested.code === "string" ? { code: nested.code } : {}),
    ...(typeof candidate.signal === "string" ? { signal: candidate.signal } : {}),
    ...(typeof candidate.status === "number" ? { exitStatus: candidate.status } : {})
  };
}

function commandExecutionMessage(code: CommandExecutionError["code"]): string {
  switch (code) {
    case "COMMAND_NOT_FOUND":
      return "Command was not found.";
    case "COMMAND_TIMED_OUT":
      return "Command execution timed out.";
    case "COMMAND_FAILED":
      return "Command execution failed.";
  }
}
