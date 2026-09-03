import { execFile } from "node:child_process";
import { accessSync, constants } from "node:fs";
import { delimiter, isAbsolute, resolve } from "node:path";
import { promisify } from "node:util";

export type CommandResult = Readonly<{
  code: number;
  stdout: string;
  stderr: string;
}>;

export type CommandRunner = (
  command: string,
  args: readonly string[],
  cwd?: string,
  env?: Readonly<Record<string, string>>
) => Promise<CommandResult>;

export function createExecFileCommandRunner(): CommandRunner {
  const exec = promisify(execFile);
  return async (command, args, cwd, env) => {
    try {
      const { stdout, stderr } = await exec(command, args, {
        cwd,
        maxBuffer: 16 * 1024 * 1024,
        ...(env === undefined ? {} : { env: { ...process.env, ...env } })
      });
      return { code: 0, stdout, stderr };
    } catch (error) {
      const failure = error as {
        code?: number | string;
        stdout?: string;
        stderr?: string;
        message?: string;
      };
      return {
        code: typeof failure.code === "number" ? failure.code : 1,
        stdout: failure.stdout ?? "",
        stderr: failure.stderr ?? failure.message ?? String(error)
      };
    }
  };
}

/**
 * Resolve an external command once through the supplied PATH. Callers pin the
 * result for the lifetime of an adapter so a later PATH change cannot swap the
 * executable that supplies an external fact or effect.
 */
export function resolveExecutable(
  command: string,
  environmentPath: string | undefined
): string | undefined {
  if (isAbsolute(command)) return command;
  for (const directory of (environmentPath ?? "").split(delimiter)) {
    if (directory.length === 0) continue;
    const candidate = resolve(directory, command);
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      // Keep walking PATH.
    }
  }
  return undefined;
}

export function createPinnedCommandRunner(
  base: CommandRunner,
  commands: readonly string[],
  environmentPath: string | undefined = process.env.PATH
): CommandRunner {
  const pinned = new Map<string, string | undefined>();
  for (const command of commands) {
    pinned.set(command, resolveExecutable(command, environmentPath));
  }
  return (command, args, cwd, env) => {
    let resolved: string | undefined;
    if (pinned.has(command)) {
      resolved = pinned.get(command);
    } else {
      resolved = isAbsolute(command)
        ? command
        : resolveExecutable(command, environmentPath);
      pinned.set(command, resolved);
    }
    if (resolved === undefined) {
      return Promise.resolve({
        code: 127,
        stdout: "",
        stderr: `Unable to resolve trusted executable: ${command}`
      });
    }
    return base(resolved, args, cwd, env);
  };
}
