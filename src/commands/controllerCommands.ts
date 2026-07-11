import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import {
  callController,
  isProcessAlive,
  readControllerDiscovery,
  removeControllerDiscovery,
  serveController
} from "../controller/controller.js";
import { runtimeError, usageError } from "../errors/cliError.js";
import { scanTaskWakeups } from "../scheduler/inactivityScanner.js";
import { FileTaskStore } from "../storage/taskStore.js";

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
    const queued = scanTaskWakeups(new FileTaskStore(rootDir), new Date());
    return `Queued ${queued.length} task wakeup${queued.length === 1 ? "" : "s"}\n`;
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
    return { running: false };
  }
}

async function stopController(rootDir: string): Promise<string> {
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
