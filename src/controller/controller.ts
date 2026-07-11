import { randomBytes } from "node:crypto";
import {
  chmodSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync
} from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { join } from "node:path";
import { CliError, dataError, type CliErrorCode } from "../errors/cliError.js";
import { expireStaleAgentRuns, failExitedAgentRuns, readAgentRunTtl, scanTaskWakeups } from "../scheduler/inactivityScanner.js";
import { processLeaderWakeups } from "../scheduler/leaderWakeupProcessor.js";
import { mergePendingWakeup } from "../scheduler/pendingWakeup.js";
import { FileTaskStore, type TaskStore } from "../storage/taskStore.js";
import { NodeCommandRunner } from "../tmux/commandRunner.js";
import { TmuxManager } from "../tmux/tmuxManager.js";
import { recordTaskRoleAttached, rememberTask, runTaskCommand } from "../commands/taskCommands.js";
import { runAgentCommand } from "../commands/agentCommands.js";
import { runBoardCommand } from "../commands/boardCommands.js";
import { runConfigCommand } from "../commands/configCommands.js";
import { runGlobalRoleCommand } from "../commands/globalRoleCommands.js";
import { runRunnerCommand } from "../commands/runnerCommands.js";
import { runImportCommand, runPruneCommand } from "../commands/maintenanceCommands.js";
import { runBackupCommand } from "../commands/migrationCommands.js";
import {
  replayPendingDomainTransactions,
  replayPendingSnapshotWrites
} from "../storage/recoveryJournal.js";
import { createResilientTaskStore, primeResilientTaskStore } from "../storage/resilientTaskStore.js";
import { rebuildDerivedIndex } from "../storage/derivedIndex.js";
import { executeDomainTransaction } from "../storage/domainTransaction.js";
import type { DomainTransactionOperation } from "../storage/recoveryJournal.js";
import { startTaskmuxFileWatcher } from "../storage/fileReloadWatcher.js";
import { appendControllerDiagnostic } from "./controllerDiagnostics.js";

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
  let stopFileWatcher = (): void => undefined;
  try {
    replayPendingDomainTransactions(rootDir);
    replayPendingSnapshotWrites(rootDir);
    const rpcResultRetention = readRpcResultRetention(process.env.TASKMUX_RPC_RESULT_RETENTION_MS);
    pruneRpcResults(rootDir, new Date(), rpcResultRetention);
    rmSync(join(rootDir, "runtime", "domain-workspaces"), { recursive: true, force: true });
    const token = randomBytes(32).toString("hex");
    const store = createResilientTaskStore(
      new FileTaskStore(rootDir),
      (error, method, args) => appendControllerDiagnostic(
        rootDir,
        "storage.invalid_edit",
        error.message,
        { method, args }
      )
    );
    const tmux = new TmuxManager(process.env.TASKMUX_TMUX_BIN ?? "tmux", new NodeCommandRunner());
    const refreshDerivedState = (): void => {
      primeResilientTaskStore(store);
      rebuildDerivedIndex(rootDir, store);
    };
    refreshDerivedState();
    stopFileWatcher = startTaskmuxFileWatcher(
      rootDir,
      refreshDerivedState,
      (error) => appendControllerDiagnostic(
        rootDir,
        "storage.reload_failed",
        error instanceof Error ? error.message : String(error)
      )
    );
    const server = createServer((request, response) => {
      void handleRequest(request, response, token, rootDir, store, tmux, refreshDerivedState);
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
        runSchedulerTransaction(rootDir, tmux, new Date(), agentRunTtl, true);
        pruneRpcResults(rootDir, new Date(), rpcResultRetention);
        refreshDerivedState();
      } catch (error) {
        if (error instanceof CliError && error.code === "DATA_ERROR") {
          try {
            appendControllerDiagnostic(
              rootDir,
              "scheduler.last_valid_fallback",
              error.message
            );
            runSchedulerPass(store, tmux, new Date(), agentRunTtl, true);
            pruneRpcResults(rootDir, new Date(), rpcResultRetention);
            refreshDerivedState();
            return;
          } catch (fallbackError) {
            error = fallbackError;
          }
        }
        appendControllerDiagnostic(
          rootDir,
          "scheduler.scan_failed",
          error instanceof Error ? error.message : String(error)
        );
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
    stopFileWatcher();
    removeControllerDiscovery(rootDir);
    releaseLock();
  }
}

export function runSchedulerTransaction(
  rootDir: string,
  tmux: TmuxManager,
  now: Date,
  agentRunTtl: number,
  processWakeups: boolean
): number {
  const transactionId = `scheduler-${now.getTime()}-${randomBytes(6).toString("hex")}`;
  return executeDomainTransaction(rootDir, transactionId, (workingRoot) => {
    const transactionStore = new FileTaskStore(workingRoot);
    return runSchedulerPass(transactionStore, tmux, now, agentRunTtl, processWakeups);
  });
}

function runSchedulerPass(
  store: TaskStore,
  tmux: TmuxManager,
  now: Date,
  agentRunTtl: number,
  processWakeups: boolean
): number {
  expireStaleAgentRuns(store, now, agentRunTtl);
  failExitedAgentRuns(store, tmux, now);
  const queued = scanTaskWakeups(store, now);
  if (processWakeups) {
    processLeaderWakeups(store, tmux, now);
  }
  return queued.length;
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
  store: TaskStore,
  tmux: TmuxManager,
  refreshDerivedState: () => void
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
    if (readRpcIntent(rootDir, rpc.requestId) !== null) {
      sendJson(response, 409, {
        requestId: rpc.requestId,
        error: `Request ${rpc.requestId} may have been applied before a crash; its outcome is unknown.`
      });
      return;
    }
    if (hasRpcTombstone(rootDir, rpc.requestId)) {
      sendJson(response, 409, {
        requestId: rpc.requestId,
        error: `Request ${rpc.requestId} expired from the result cache and will not be reapplied.`
      });
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
      const wakeupReason = rpc.params.reason;

      const body = executeRpcTransaction(
        rootDir,
        rpc,
        refreshDerivedState,
        (workingRoot) => {
          const transactionStore = new FileTaskStore(workingRoot);
          const wakeup = mergePendingWakeup(
            task.id,
            wakeupReason,
            new Date(),
            transactionStore.getPendingWakeup(task.id)
          );
          transactionStore.savePendingWakeup(wakeup);
          processLeaderWakeups(transactionStore, tmux, new Date());
          return { requestId: rpc.requestId, result: { wakeup } };
        }
      );
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
      const commandArgs = rpc.params.args;
      if (isTaskPointerCommand(commandArgs)) {
        const taskId = commandArgs[1] ?? "";
        const output = runTaskCommand(commandArgs, store, tmux, { rememberTaskReads: false });
        const body = executeRpcTransaction(
          rootDir,
          rpc,
          refreshDerivedState,
          (workingRoot) => {
            rememberTask(new FileTaskStore(workingRoot), taskId);
            return { requestId: rpc.requestId, result: { output } };
          }
        );
        sendJson(response, 200, body);
        return;
      }
      if (isReadOnlyTaskCommand(commandArgs)) {
        const output = runTaskCommand(commandArgs, store, tmux);
        sendJson(response, 200, { requestId: rpc.requestId, result: { output } });
        return;
      }

      const body = executeRpcTransaction(
        rootDir,
        rpc,
        refreshDerivedState,
        (workingRoot) => {
          const transactionStore = new FileTaskStore(workingRoot);
          const output = runTaskCommand(commandArgs, transactionStore, tmux);
          processLeaderWakeups(transactionStore, tmux, new Date());
          return { requestId: rpc.requestId, result: { output } };
        }
      );
      sendJson(response, 200, body);
      return;
    }

    if (rpc.method === "task.attach-complete") {
      if (
        typeof rpc.params !== "object" ||
        rpc.params === null ||
        !("taskId" in rpc.params) || typeof rpc.params.taskId !== "string" ||
        !("roleName" in rpc.params) || typeof rpc.params.roleName !== "string"
      ) {
        sendJson(response, 400, { error: "task.attach-complete requires taskId and roleName." });
        return;
      }
      const taskId = rpc.params.taskId;
      const roleName = rpc.params.roleName;
      const body = executeRpcTransaction(
        rootDir,
        rpc,
        refreshDerivedState,
        (workingRoot) => {
          recordTaskRoleAttached(taskId, roleName, new FileTaskStore(workingRoot));
          return { requestId: rpc.requestId, result: {} };
        }
      );
      sendJson(response, 200, body);
      return;
    }

    if (rpc.method === "scheduler.scan") {
      const now = new Date();
      const body = executeRpcTransaction(
        rootDir,
        rpc,
        refreshDerivedState,
        (workingRoot) => {
          const transactionStore = new FileTaskStore(workingRoot);
          expireStaleAgentRuns(
            transactionStore,
            now,
            readAgentRunTtl(process.env.TASKMUX_AGENT_RUN_TTL_MS)
          );
          failExitedAgentRuns(transactionStore, tmux, now);
          const queued = scanTaskWakeups(transactionStore, now).length;
          const output = `Queued ${queued} task wakeup${queued === 1 ? "" : "s"}\n`;
          return { requestId: rpc.requestId, result: { output } };
        }
      );
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
      const commandGroup = rpc.params.group;
      const commandArgs = rpc.params.args;
      if (isReadOnlyControllerCommand(commandGroup, commandArgs)) {
        const output = runControllerCommandGroup(commandGroup, commandArgs, store, rootDir);
        sendJson(response, 200, { requestId: rpc.requestId, result: { output } });
        return;
      }

      let body: { requestId: string; result: { output: string } };
      if (commandGroup === "backup") {
        writeRpcIntent(rootDir, rpc.requestId, rpc.method);
        body = runDirectControllerCommand(rootDir, rpc.requestId, commandGroup, commandArgs, store);
        clearRpcIntent(rootDir, rpc.requestId);
        refreshDerivedState();
      } else {
        body = executeRpcTransaction(
            rootDir,
            rpc,
            refreshDerivedState,
            (workingRoot) => {
              const transactionStore = new FileTaskStore(workingRoot);
              const output = runControllerCommandGroup(
                commandGroup,
                commandArgs,
                transactionStore,
                workingRoot
              );
              return { requestId: rpc.requestId, result: { output } };
            },
            { includeBackups: commandGroup === "prune" }
          );
      }
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

function executeRpcTransaction<T>(
  rootDir: string,
  rpc: RpcRequest & { requestId: string },
  refreshDerivedState: () => void,
  execute: (workingRoot: string) => T,
  options: { includeBackups?: boolean } = {}
): T {
  writeRpcIntent(rootDir, rpc.requestId, rpc.method);
  const result = executeDomainTransaction(
    rootDir,
    rpc.requestId,
    execute,
    (body) => [rpcResultOperation(rootDir, rpc.requestId, body)],
    options
  );
  clearRpcIntent(rootDir, rpc.requestId);
  refreshDerivedState();
  return result;
}

function isReadOnlyTaskCommand(args: string[]): boolean {
  const command = args[0] ?? "";
  if ([
    "list", "board", "last", "roles",
    "comments", "events", "activity", "timeline", "tail", "detail"
  ].includes(command)) {
    return true;
  }
  if (command === "current") {
    return args.length === 1;
  }
  return command === "topic" && args[1] === "list";
}

function isTaskPointerCommand(args: string[]): boolean {
  return ["show", "open", "context"].includes(args[0] ?? "");
}

function isReadOnlyControllerCommand(group: string, args: string[]): boolean {
  if (group === "board") {
    return true;
  }
  if (group === "config") {
    return args[0] === "show";
  }
  return ["agent", "runner", "role"].includes(group) && ["list", "show"].includes(args[0] ?? "");
}

function runDirectControllerCommand(
  rootDir: string,
  requestId: string,
  group: string,
  args: string[],
  store: TaskStore
): { requestId: string; result: { output: string } } {
  const output = runControllerCommandGroup(group, args, store, rootDir);
  const body = { requestId, result: { output } };
  writeRpcResult(rootDir, requestId, body);
  return body;
}

function runControllerCommandGroup(
  group: string,
  args: string[],
  store: TaskStore,
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
    case "backup":
      return runBackupCommand(rootDir);
    case "import":
      return runImportCommand(args, store);
    case "prune":
      return runPruneCommand(args, rootDir);
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

function rpcResultOperation(
  rootDir: string,
  requestId: string,
  body: unknown
): DomainTransactionOperation {
  return {
    type: "write",
    target: rpcResultFile(rootDir, requestId),
    content: `${JSON.stringify(body, null, 2)}\n`
  };
}

function readRpcIntent(rootDir: string, requestId: string): unknown | null {
  try {
    return JSON.parse(readFileSync(rpcIntentFile(rootDir, requestId), "utf8")) as unknown;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

function writeRpcIntent(rootDir: string, requestId: string, method: string): void {
  const directory = join(rootDir, "runtime", "rpc-intents");
  const target = rpcIntentFile(rootDir, requestId);
  const temporary = `${target}.${process.pid}.tmp`;
  mkdirSync(directory, { recursive: true });
  writeFileSync(temporary, `${JSON.stringify({
    schemaVersion: 1,
    requestId,
    method,
    createdAt: new Date().toISOString()
  }, null, 2)}\n`, { mode: 0o600 });
  renameSync(temporary, target);
}

function clearRpcIntent(rootDir: string, requestId: string): void {
  rmSync(rpcIntentFile(rootDir, requestId), { force: true });
}

function rpcIntentFile(rootDir: string, requestId: string): string {
  return join(rootDir, "runtime", "rpc-intents", `${requestId}.json`);
}

function rpcResultFile(rootDir: string, requestId: string): string {
  return join(rootDir, "runtime", "rpc-results", `${requestId}.json`);
}

function readRpcResultRetention(value: string | undefined): number {
  const parsed = Number(value ?? 30 * 24 * 60 * 60 * 1_000);
  return Number.isFinite(parsed) && parsed >= 1_000
    ? parsed
    : 30 * 24 * 60 * 60 * 1_000;
}

function pruneRpcResults(rootDir: string, now: Date, retentionMs: number): void {
  const directory = join(rootDir, "runtime", "rpc-results");
  let names: string[];
  try {
    names = readdirSync(directory).filter((name) => name.endsWith(".json"));
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return;
    }
    throw error;
  }
  for (const name of names) {
    const path = join(directory, name);
    if (now.getTime() - statSync(path).mtimeMs < retentionMs) {
      continue;
    }
    const requestId = name.slice(0, -5);
    appendRpcTombstone(rootDir, requestId, now);
    rmSync(path, { force: true });
  }
}

function hasRpcTombstone(rootDir: string, requestId: string): boolean {
  return readRpcTombstones(rootDir).some((entry) => entry.requestId === requestId);
}

function appendRpcTombstone(rootDir: string, requestId: string, now: Date): void {
  const entries = readRpcTombstones(rootDir);
  if (entries.some((entry) => entry.requestId === requestId)) {
    return;
  }
  const target = join(rootDir, "runtime", "rpc-tombstones.jsonl");
  const temporary = `${target}.${process.pid}.tmp`;
  mkdirSync(join(rootDir, "runtime"), { recursive: true });
  const content = [
    ...entries,
    { schemaVersion: 1, requestId, expiredAt: now.toISOString() }
  ].map((entry) => JSON.stringify(entry)).join("\n").concat("\n");
  writeFileSync(temporary, content, { mode: 0o600 });
  renameSync(temporary, target);
}

function readRpcTombstones(rootDir: string): Array<{
  schemaVersion: 1;
  requestId: string;
  expiredAt: string;
}> {
  try {
    return readFileSync(join(rootDir, "runtime", "rpc-tombstones.jsonl"), "utf8")
      .split("\n")
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line) as { schemaVersion: 1; requestId: string; expiredAt: string });
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return [];
    }
    throw error;
  }
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
