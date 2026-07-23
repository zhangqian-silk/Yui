import { spawn, spawnSync } from "node:child_process";

const ASYNC_TIMEOUT_KILL_GRACE_MS = 100;

export type CommandRunOptions = Readonly<{
  inheritStdio?: boolean;
  timeoutMs?: number;
  environment?: Readonly<Record<string, string | undefined>>;
}>;

export type CommandExecutor = Readonly<{
  run(command: string, args: string[], options?: CommandRunOptions): string;
  runAsync?(command: string, args: string[], options?: CommandRunOptions): Promise<string>;
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
    const common = {
      ...(options.timeoutMs === undefined ? {} : { timeout: options.timeoutMs }),
      ...(options.environment === undefined
        ? {}
        : { env: { ...process.env, ...options.environment } })
    };
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

  runAsync(
    command: string,
    args: string[],
    options: CommandRunOptions = {}
  ): Promise<string> {
    return new Promise((resolve, reject) => {
      const inheritStdio = options.inheritStdio === true;
      const child = spawn(command, args, {
        ...(options.environment === undefined
          ? {}
          : { env: { ...process.env, ...options.environment } }),
        stdio: inheritStdio ? "inherit" : ["ignore", "pipe", "pipe"]
      });
      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      let spawnError: unknown;
      let timedOut = false;
      let settled = false;
      let killTimer: ReturnType<typeof setTimeout> | undefined;
      const timer = options.timeoutMs === undefined
        ? undefined
        : setTimeout(() => {
            if (settled) return;
            timedOut = true;
            child.kill("SIGTERM");
            killTimer = setTimeout(() => {
              child.kill("SIGKILL");
            }, ASYNC_TIMEOUT_KILL_GRACE_MS);
            killTimer.unref();
            child.stdout?.destroy();
            child.stderr?.destroy();
            settled = true;
            reject(stableCommandExecutionError({
              code: "ETIMEDOUT",
              stderr: Buffer.concat(stderr).toString("utf8")
            }));
          }, options.timeoutMs);
      timer?.unref();

      child.stdout?.on("data", (chunk: Buffer | string) => {
        stdout.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      });
      child.stderr?.on("data", (chunk: Buffer | string) => {
        stderr.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      });
      child.once("error", (error) => {
        spawnError = error;
      });
      child.once("close", (status, signal) => {
        if (settled) return;
        settled = true;
        if (timer !== undefined) clearTimeout(timer);
        if (killTimer !== undefined) clearTimeout(killTimer);
        const capturedStderr = Buffer.concat(stderr).toString("utf8");
        if (spawnError !== undefined || timedOut || status !== 0) {
          reject(stableCommandExecutionError({
            ...(spawnError === undefined ? {} : { error: spawnError }),
            ...(timedOut ? { code: "ETIMEDOUT" } : {}),
            status,
            signal,
            stderr: capturedStderr
          }));
          return;
        }
        resolve(inheritStdio ? "" : Buffer.concat(stdout).toString("utf8"));
      });
    });
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
