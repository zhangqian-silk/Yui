import { spawn } from "node:child_process";
import { constants } from "node:os";
import type { Writable } from "node:stream";

const SIGKILL_GRACE_MS = 2_000;

export type ManagedClaudeProcessInput = Readonly<{
  command: string;
  args: readonly string[];
  prompt: string;
  cwd?: string;
  environment?: NodeJS.ProcessEnv;
  stdout?: Writable;
  stderr?: Writable;
}>;

/** The documented Claude Code stream-json user-message envelope. */
export function buildManagedClaudeInput(prompt: string): string {
  if (typeof prompt !== "string" || prompt.includes("\0")) {
    throw new TypeError("Managed Claude prompt must be text without NUL bytes.");
  }
  return `${JSON.stringify({
    type: "user",
    message: {
      role: "user",
      content: [{ type: "text", text: prompt }]
    }
  })}\n`;
}

/**
 * Runs one autonomous Claude turn without exposing the prompt in argv or
 * depending on terminal readiness/key timing. stdout/stderr are connected
 * before stdin is written, so a provider startup burst cannot deadlock the
 * prompt pipe. EOF makes this a finite per-Run process; native continuity is
 * carried by Claude's --session-id/--resume arguments.
 */
export async function runManagedClaudeProcess(
  input: ManagedClaudeProcessInput
): Promise<number> {
  const command = requireProcessToken(input.command, "Managed Claude command");
  const args = input.args.map((value) => requireProcessToken(value, "Managed Claude argument"));
  const child = spawn(command, args, {
    ...(input.cwd === undefined ? {} : { cwd: input.cwd }),
    env: input.environment ?? process.env,
    stdio: [
      "pipe",
      input.stdout === undefined ? "inherit" : "pipe",
      input.stderr === undefined ? "inherit" : "pipe"
    ],
    // Linux-only package: isolate the Provider process tree so tmux/session
    // cancellation cannot leave Claude tool descendants behind.
    detached: true
  });
  if (child.stdin === null) {
    child.kill();
    throw new Error("Managed Claude stdin pipe is unavailable.");
  }
  if (input.stdout !== undefined) child.stdout!.pipe(input.stdout, { end: false });
  if (input.stderr !== undefined) child.stderr!.pipe(input.stderr, { end: false });

  const signals = ["SIGINT", "SIGTERM", "SIGHUP"] as const;
  const handlers = new Map<NodeJS.Signals, () => void>();
  let killTimer: NodeJS.Timeout | undefined;
  let terminationRequested = false;
  let childSettled = false;
  const signalProcessGroup = (signal: NodeJS.Signals): void => {
    if (child.pid === undefined || child.exitCode !== null || child.signalCode !== null) return;
    try {
      process.kill(-child.pid, signal);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
    }
  };
  const terminateProcessGroup = (signal: NodeJS.Signals): void => {
    if (terminationRequested) return;
    terminationRequested = true;
    signalProcessGroup(signal);
    killTimer = setTimeout(() => signalProcessGroup("SIGKILL"), SIGKILL_GRACE_MS);
    killTimer.unref();
  };
  for (const signal of signals) {
    const handler = () => terminateProcessGroup(signal);
    handlers.set(signal, handler);
    process.on(signal, handler);
  }

  try {
    const closed = new Promise<Readonly<{ code: number | null; signal: NodeJS.Signals | null }>>(
      (resolve, reject) => {
        child.once("error", (error) => {
          childSettled = true;
          reject(error);
        });
        child.once("close", (code, signal) => {
          childSettled = true;
          resolve({ code, signal });
        });
      }
    );
    try {
      await new Promise<void>((resolve, reject) => {
        child.stdin!.once("error", reject);
        child.stdin!.end(buildManagedClaudeInput(input.prompt), "utf8", resolve);
      });
    } catch (error) {
      // A failed prompt pipe is not permission to orphan a Provider process or
      // its tools. Terminate the whole group and wait for bounded convergence.
      if (!childSettled) {
        terminateProcessGroup("SIGTERM");
        await closed.catch(() => undefined);
      }
      throw error;
    }
    const result = await closed;
    return result.code ?? (result.signal === null ? 1 : signalExitCode(result.signal));
  } finally {
    if (killTimer !== undefined) clearTimeout(killTimer);
    for (const [signal, handler] of handlers) process.removeListener(signal, handler);
  }
}

function requireProcessToken(value: string, label: string): string {
  if (typeof value !== "string" || value.length === 0 || value.includes("\0")) {
    throw new TypeError(`${label} must be non-empty text without NUL bytes.`);
  }
  return value;
}

function signalExitCode(signal: NodeJS.Signals): number {
  const number = constants.signals[signal];
  return number === undefined ? 1 : 128 + number;
}
