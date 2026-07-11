import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import {
  acquireControllerLock,
  callController,
  isProcessAlive,
  readControllerDiscovery,
  removeControllerDiscovery,
  runSchedulerTransaction,
  serveController
} from "../controller/controller.js";
import { runtimeError, usageError } from "../errors/cliError.js";
import { readAgentRunTtl } from "../scheduler/inactivityScanner.js";
import { NodeCommandRunner } from "../tmux/commandRunner.js";
import { TmuxManager } from "../tmux/tmuxManager.js";

export async function runControllerCommand(
  args: string[],
  rootDir: string,
  env: NodeJS.ProcessEnv
): Promise<string> {
  const [command, ...rest] = args;

  if (command === "serve" && rest.length === 0) {
    await serveController(rootDir);
    return "";
  }

  if (command === "start" && rest.length === 0) {
    return startController(rootDir, env);
  }

  if (command === "status" && (rest.length === 0 || (rest.length === 1 && rest[0] === "--json"))) {
    const status = await controllerStatus(rootDir);
    return rest[0] === "--json"
      ? `${JSON.stringify(status)}\n`
      : status.running
        ? `Controller running (pid ${status.pid})\n`
        : "Controller stopped\n";
  }

  if (command === "stop" && rest.length === 0) {
    return stopController(rootDir);
  }

  if (command === "scan" && rest.length === 0) {
    const discovery = readControllerDiscovery(rootDir);
    if (discovery !== null && isProcessAlive(discovery.pid)) {
      const result = await callController(discovery, "scheduler.scan", randomUUID()) as { output: string };
      return result.output;
    }
    const tmux = new TmuxManager(env.TASKMUX_TMUX_BIN ?? "tmux", new NodeCommandRunner());
    const release = acquireControllerLock(rootDir, process.pid);
    try {
      const queued = runSchedulerTransaction(
        rootDir,
        tmux,
        new Date(),
        readAgentRunTtl(env.TASKMUX_AGENT_RUN_TTL_MS),
        false
      );
      return `Queued ${queued} task wakeup${queued === 1 ? "" : "s"}\n`;
    } finally {
      release();
    }
  }

  throw usageError("Controller usage: taskmux controller start|status [--json]|stop|scan.");
}

async function startController(rootDir: string, env: NodeJS.ProcessEnv): Promise<string> {
  const existing = await controllerStatus(rootDir);
  if (existing.running) {
    return `Controller already running (pid ${existing.pid})\n`;
  }

  const cliPath = process.argv[1];
  if (cliPath === undefined) {
    throw runtimeError("Cannot locate the TaskMux CLI entry point.");
  }

  const child = spawn(process.execPath, [cliPath, "controller", "serve"], {
    detached: true,
    env: { ...env, TASKMUX_HOME: rootDir },
    stdio: "ignore"
  });
  child.unref();

  const discovery = await waitForDiscovery(rootDir, 5_000);
  if (discovery === null) {
    throw runtimeError("Controller did not start within 5 seconds.");
  }

  return `Controller started (pid ${discovery.pid})\n`;
}

export async function ensureControllerRunning(
  rootDir: string,
  env: NodeJS.ProcessEnv
) {
  const status = await controllerStatus(rootDir);
  if (!status.running) {
    await startController(rootDir, env);
  }

  const discovery = readControllerDiscovery(rootDir);
  if (discovery === null) {
    throw runtimeError("Controller discovery is unavailable after startup.");
  }
  return discovery;
}

async function controllerStatus(rootDir: string): Promise<{ running: boolean; pid?: number; apiVersion?: number }> {
  const discovery = readControllerDiscovery(rootDir);

  if (discovery === null || !isProcessAlive(discovery.pid)) {
    if (discovery !== null) {
      removeControllerDiscovery(rootDir);
    }
    return { running: false };
  }

  try {
    return await callController(discovery, "health", randomUUID()) as {
      running: boolean;
      pid: number;
      apiVersion: number;
    };
  } catch {
    removeControllerDiscovery(rootDir);
    return { running: false };
  }
}

async function stopController(rootDir: string): Promise<string> {
  const status = await controllerStatus(rootDir);
  if (!status.running) {
    return "Controller stopped\n";
  }
  const discovery = readControllerDiscovery(rootDir);

  if (discovery === null) {
    return "Controller stopped\n";
  }

  if (isProcessAlive(discovery.pid)) {
    process.kill(discovery.pid, "SIGTERM");
  } else {
    removeControllerDiscovery(rootDir);
  }

  const deadline = Date.now() + 3_000;
  while (Date.now() < deadline && readControllerDiscovery(rootDir) !== null) {
    await delay(25);
  }

  if (readControllerDiscovery(rootDir) !== null) {
    throw runtimeError(`Controller ${discovery.pid} did not stop within 3 seconds.`);
  }

  return "Controller stopped\n";
}

async function waitForDiscovery(rootDir: string, timeoutMs: number) {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const discovery = readControllerDiscovery(rootDir);
    if (discovery !== null) {
      return discovery;
    }
    await delay(25);
  }

  return null;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
