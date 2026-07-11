import { randomBytes } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { join } from "node:path";
import { CliError, dataError, type CliErrorCode } from "../errors/cliError.js";
import { expireStaleAgentRuns, failExitedAgentRuns, readAgentRunTtl, scanTaskWakeups } from "../scheduler/inactivityScanner.js";
import { processLeaderWakeups } from "../scheduler/leaderWakeupProcessor.js";
import { mergePendingWakeup } from "../scheduler/pendingWakeup.js";
import { FileTaskStore } from "../storage/taskStore.js";
import { NodeCommandRunner } from "../tmux/commandRunner.js";
import { TmuxManager } from "../tmux/tmuxManager.js";
import { runTaskCommand } from "../commands/taskCommands.js";
import { runAgentCommand } from "../commands/agentCommands.js";
import { runBoardCommand } from "../commands/boardCommands.js";
import { runConfigCommand } from "../commands/configCommands.js";
import { runGlobalRoleCommand } from "../commands/globalRoleCommands.js";
import { runRunnerCommand } from "../commands/runnerCommands.js";

export const CONTROLLER_API_VERSION = 1;

export type ControllerDiscovery = {
  schemaVersion: 1;
  apiVersion: 1;
  host: "127.0.0.1";
  port: number;
  pid: number;
  token: string;
  startedAt: string;
};

type RpcRequest = {
  apiVersion: number;
  requestId: string;
  method: string;
  params?: unknown;
};

export async function serveController(rootDir: string): Promise<void> {
  const existing = readControllerDiscovery(rootDir);

  if (existing !== null && isProcessAlive(existing.pid)) {
    throw dataError(`Controller is already running with pid ${existing.pid}.`);
  }

  removeControllerDiscovery(rootDir);
  const releaseLock = acquireControllerLock(rootDir, process.pid);
  try {
    const token = randomBytes(32).toString("hex");
    const store = new FileTaskStore(rootDir);
    const tmux = new TmuxManager(process.env.TASKMUX_TMUX_BIN ?? "tmux", new NodeCommandRunner());
    const server = createServer((request, response) => {
      void handleRequest(request, response, token, rootDir, store, tmux);
    });

    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => resolve());
    });

    const address = server.address();
    if (address === null || typeof address === "string") {
      server.close();
      throw new Error("Controller did not receive a loopback TCP port.");
    }

    writeControllerDiscovery(rootDir, {
      schemaVersion: 1,
      apiVersion: CONTROLLER_API_VERSION,
      host: "127.0.0.1",
      port: address.port,
      pid: process.pid,
      token,
      startedAt: new Date().toISOString()
    });

    const scanInterval = readScanInterval(process.env.TASKMUX_CONTROLLER_SCAN_INTERVAL_MS);
    const agentRunTtl = readAgentRunTtl(process.env.TASKMUX_AGENT_RUN_TTL_MS);
    const scan = (): void => {
      try {
        expireStaleAgentRuns(store, new Date(), agentRunTtl);
        failExitedAgentRuns(store, tmux, new Date());
        scanTaskWakeups(store, new Date());
        processLeaderWakeups(store, tmux, new Date());
      } catch {
        // A malformed user-edited file must not terminate the Controller.
      }
    };
    scan();
    const scanTimer = setInterval(scan, scanInterval);
    scanTimer.unref();

    await new Promise<void>((resolve) => {
      let stopping = false;
      const stop = (): void => {
        if (stopping) {
          return;
        }
        stopping = true;
        clearInterval(scanTimer);
        server.close(() => {
          removeControllerDiscovery(rootDir);
          resolve();
        });
      };

      process.once("SIGTERM", stop);
      process.once("SIGINT", stop);
    });
  } finally {
    removeControllerDiscovery(rootDir);
    releaseLock();
  }
}

export function acquireControllerLock(rootDir: string, pid: number): () => void {
  const runtimeDir = join(rootDir, "runtime");
  const target = join(runtimeDir, "controller.lock");
  mkdirSync(runtimeDir, { recursive: true });

  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      writeFileSync(target, `${JSON.stringify({ pid, createdAt: new Date().toISOString() })}\n`, {
        flag: "wx",
        mode: 0o600
      });
      return () => rmSync(target, { force: true });
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) {
        throw error;
      }

      const existingPid = readControllerLockPid(target);
      if (existingPid !== null && isProcessAlive(existingPid)) {
        throw dataError(`Controller startup is locked by pid ${existingPid}.`);
      }
      rmSync(target, { force: true });
    }
  }

  throw dataError("Controller startup is locked.");
}

function readControllerLockPid(path: string): number | null {
  try {
    const value = JSON.parse(readFileSync(path, "utf8")) as { pid?: unknown };
    return typeof value.pid === "number" ? value.pid : null;
  } catch {
    return null;
  }
}

function readScanInterval(value: string | undefined): number {
  const parsed = Number(value ?? 30_000);
  return Number.isFinite(parsed) && parsed >= 25 ? parsed : 30_000;
}

export function readControllerDiscovery(rootDir: string): ControllerDiscovery | null {
  try {
    const value = JSON.parse(readFileSync(controllerFile(rootDir), "utf8")) as unknown;

    if (
      typeof value !== "object" ||
      value === null ||
      !("schemaVersion" in value) || value.schemaVersion !== 1 ||
      !("apiVersion" in value) || value.apiVersion !== CONTROLLER_API_VERSION ||
      !("host" in value) || value.host !== "127.0.0.1" ||
      !("port" in value) || typeof value.port !== "number" ||
      !("pid" in value) || typeof value.pid !== "number" ||
      !("token" in value) || typeof value.token !== "string" ||
      !("startedAt" in value) || typeof value.startedAt !== "string"
    ) {
      throw dataError("Invalid controller discovery record.");
    }

    return value as ControllerDiscovery;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

export function removeControllerDiscovery(rootDir: string): void {
  rmSync(controllerFile(rootDir), { force: true });
}

export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export async function callController(
  discovery: ControllerDiscovery,
  method: string,
  requestId: string,
  params: unknown = {}
): Promise<unknown> {
  const response = await fetch(`http://${discovery.host}:${discovery.port}/rpc`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${discovery.token}`,
      "content-type": "application/json"
    },
    body: JSON.stringify({
      apiVersion: CONTROLLER_API_VERSION,
      requestId,
      method,
      params
    } satisfies RpcRequest),
    signal: AbortSignal.timeout(30_000)
  });

  const body = await response.json() as {
    result?: unknown;
    error?: string | { code: CliErrorCode; message: string };
  };
  if (body.error !== undefined) {
    if (typeof body.error === "object") {
      throw new CliError(body.error.code, body.error.message);
    }
    throw new Error(body.error);
  }
  if (!response.ok) {
    throw new Error(`Controller RPC failed with HTTP ${response.status}.`);
  }

  return body.result;
}

async function handleRequest(
  request: IncomingMessage,
  response: ServerResponse,
  token: string,
  rootDir: string,
  store: FileTaskStore,
  tmux: TmuxManager
): Promise<void> {
  if (request.method !== "POST" || request.url !== "/rpc") {
    sendJson(response, 404, { error: "Not found." });
    return;
  }

  if (request.headers.authorization !== `Bearer ${token}`) {
    sendJson(response, 401, { error: "Unauthorized." });
    return;
  }

  try {
    const body = await readRequestBody(request);
    const rpc = JSON.parse(body) as RpcRequest;

    if (rpc.apiVersion !== CONTROLLER_API_VERSION || typeof rpc.requestId !== "string") {
      sendJson(response, 400, { error: "Invalid RPC envelope." });
      return;
    }

    if (!/^[A-Za-z0-9_-]+$/.test(rpc.requestId)) {
      sendJson(response, 400, { error: "Invalid request id." });
      return;
    }

    if (rpc.method === "health") {
      sendJson(response, 200, {
        requestId: rpc.requestId,
        result: { running: true, pid: process.pid, apiVersion: CONTROLLER_API_VERSION }
      });
      return;
    }

    const cached = readRpcResult(rootDir, rpc.requestId);
    if (cached !== null) {
      sendJson(response, 200, cached);
      return;
    }

    if (rpc.method === "wakeup.merge") {
      if (
        typeof rpc.params !== "object" ||
        rpc.params === null ||
        !("taskId" in rpc.params) ||
        typeof rpc.params.taskId !== "string" ||
        !("reason" in rpc.params) ||
        typeof rpc.params.reason !== "string"
      ) {
        sendJson(response, 400, { error: "wakeup.merge requires taskId and reason." });
        return;
      }

      const task = store.getTask(rpc.params.taskId);
      if (task === null) {
        sendJson(response, 404, { error: `Task not found: ${rpc.params.taskId}` });
        return;
      }
      if (task.archived) {
        sendJson(response, 409, { error: `Cannot wake archived task: ${task.id}` });
        return;
      }

      const wakeup = mergePendingWakeup(
        task.id,
        rpc.params.reason,
        new Date(),
        store.getPendingWakeup(task.id)
      );
      store.savePendingWakeup(wakeup);
      processLeaderWakeups(store, tmux, new Date());
      const body = { requestId: rpc.requestId, result: { wakeup } };
      writeRpcResult(rootDir, rpc.requestId, body);
      sendJson(response, 200, body);
      return;
    }

    if (rpc.method === "task.command") {
      if (
        typeof rpc.params !== "object" ||
        rpc.params === null ||
        !("args" in rpc.params) ||
        !Array.isArray(rpc.params.args) ||
        !rpc.params.args.every((value) => typeof value === "string")
      ) {
        sendJson(response, 400, { error: "task.command requires a string args array." });
        return;
      }
      if (["shell", "enter"].includes(rpc.params.args[0] ?? "")) {
        sendJson(response, 400, { error: "Interactive task commands cannot run through RPC." });
        return;
      }

      const output = runTaskCommand(rpc.params.args, store, tmux);
      processLeaderWakeups(store, tmux, new Date());
      const body = { requestId: rpc.requestId, result: { output } };
      writeRpcResult(rootDir, rpc.requestId, body);
      sendJson(response, 200, body);
      return;
    }

    if (rpc.method === "command.execute") {
      if (
        typeof rpc.params !== "object" ||
        rpc.params === null ||
        !("group" in rpc.params) ||
        typeof rpc.params.group !== "string" ||
        !("args" in rpc.params) ||
        !Array.isArray(rpc.params.args) ||
        !rpc.params.args.every((value) => typeof value === "string")
      ) {
        sendJson(response, 400, { error: "command.execute requires group and a string args array." });
        return;
      }

      const output = runControllerCommandGroup(rpc.params.group, rpc.params.args, store, rootDir);
      const body = { requestId: rpc.requestId, result: { output } };
      writeRpcResult(rootDir, rpc.requestId, body);
      sendJson(response, 200, body);
      return;
    }

    sendJson(response, 404, { requestId: rpc.requestId, error: `Unknown RPC method: ${rpc.method}` });
  } catch (error) {
    sendJson(response, 400, {
      error: error instanceof CliError
        ? { code: error.code, message: error.message }
        : error instanceof Error ? error.message : String(error)
    });
  }
}

function runControllerCommandGroup(
  group: string,
  args: string[],
  store: FileTaskStore,
  rootDir: string
): string {
  switch (group) {
    case "config":
      return runConfigCommand(args, store, process.env);
    case "agent":
      return runAgentCommand(args, store);
    case "role":
      if (args[0] === "enter") {
        throw new Error("Interactive role commands cannot run through RPC.");
      }
      return runGlobalRoleCommand(args, store, { taskmuxHome: rootDir });
    case "runner":
      return runRunnerCommand(args, store);
    case "board":
      return runBoardCommand(store);
    default:
      throw new Error(`Unsupported Controller command group: ${group}`);
  }
}

function readRpcResult(rootDir: string, requestId: string): unknown | null {
  try {
    return JSON.parse(readFileSync(rpcResultFile(rootDir, requestId), "utf8")) as unknown;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

function writeRpcResult(rootDir: string, requestId: string, body: unknown): void {
  const directory = join(rootDir, "runtime", "rpc-results");
  const target = rpcResultFile(rootDir, requestId);
  const temporary = `${target}.${process.pid}.tmp`;
  mkdirSync(directory, { recursive: true });
  writeFileSync(temporary, `${JSON.stringify(body, null, 2)}\n`, { mode: 0o600 });
  renameSync(temporary, target);
}

function rpcResultFile(rootDir: string, requestId: string): string {
  return join(rootDir, "runtime", "rpc-results", `${requestId}.json`);
}

async function readRequestBody(request: IncomingMessage): Promise<string> {
  let body = "";

  for await (const chunk of request) {
    body += chunk.toString();
    if (body.length > 1_000_000) {
      throw new Error("RPC request is too large.");
    }
  }

  return body;
}

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
}

function writeControllerDiscovery(rootDir: string, discovery: ControllerDiscovery): void {
  const runtimeDir = join(rootDir, "runtime");
  const target = controllerFile(rootDir);
  const temporary = `${target}.${process.pid}.tmp`;
  mkdirSync(runtimeDir, { recursive: true });
  writeFileSync(temporary, `${JSON.stringify(discovery, null, 2)}\n`, { mode: 0o600 });
  chmodSync(temporary, 0o600);
  renameSync(temporary, target);
}

function controllerFile(rootDir: string): string {
  return join(rootDir, "runtime", "controller.json");
}
