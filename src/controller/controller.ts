import { randomBytes } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { join } from "node:path";
import { dataError } from "../errors/cliError.js";

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
  const token = randomBytes(32).toString("hex");
  const server = createServer((request, response) => {
    void handleRequest(request, response, token);
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

  await new Promise<void>((resolve) => {
    let stopping = false;
    const stop = (): void => {
      if (stopping) {
        return;
      }
      stopping = true;
      server.close(() => {
        removeControllerDiscovery(rootDir);
        resolve();
      });
    };

    process.once("SIGTERM", stop);
    process.once("SIGINT", stop);
  });
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
  requestId: string
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
      params: {}
    } satisfies RpcRequest),
    signal: AbortSignal.timeout(2_000)
  });

  if (!response.ok) {
    throw new Error(`Controller RPC failed with HTTP ${response.status}.`);
  }

  const body = await response.json() as { result?: unknown; error?: string };
  if (body.error !== undefined) {
    throw new Error(body.error);
  }

  return body.result;
}

async function handleRequest(
  request: IncomingMessage,
  response: ServerResponse,
  token: string
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

    if (rpc.method === "health") {
      sendJson(response, 200, {
        requestId: rpc.requestId,
        result: { running: true, pid: process.pid, apiVersion: CONTROLLER_API_VERSION }
      });
      return;
    }

    sendJson(response, 404, { requestId: rpc.requestId, error: `Unknown RPC method: ${rpc.method}` });
  } catch (error) {
    sendJson(response, 400, { error: error instanceof Error ? error.message : String(error) });
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
