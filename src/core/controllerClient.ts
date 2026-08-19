import { randomUUID } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import { createConnection, type Socket } from "node:net";
import { join } from "node:path";

import {
  CONTROLLER_DISCOVERY_PATH,
  FILE_TASK_CONTROLLER_PROTOCOL_VERSION,
  MAX_CONTROLLER_MESSAGE_BYTES,
  ControllerProtocolError,
  encodeControllerRequest,
  parseControllerDiscovery,
  parseControllerResponse,
  type ControllerDiscovery,
  type JsonValue
} from "./protocol.js";
import { isControllerSocketPathForHome } from "./controllerEndpoint.js";
import { readCompatibleHomeIdentity } from "../storage/compatibleTaskStore.js";

export class ControllerClientError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "ControllerClientError";
  }
}

export type ControllerCallOptions = Readonly<{
  timeoutMs?: number;
  id?: string;
}>;

export async function readControllerDiscovery(home: string): Promise<ControllerDiscovery> {
  const discoveryPath = join(home, CONTROLLER_DISCOVERY_PATH);
  try {
    const metadata = await lstat(discoveryPath);
    const uid = typeof process.getuid === "function" ? process.getuid() : undefined;
    if (
      !metadata.isFile()
      || (metadata.mode & 0o077) !== 0
      || metadata.size > 4_096
      || (uid !== undefined && metadata.uid !== uid)
    ) {
      throw invalidDiscovery();
    }
    const value: unknown = JSON.parse(await readFile(discoveryPath, "utf8"));
    const homeId = readCompatibleHomeIdentity(home).homeId;
    const socketPath = discoverySocketPath(homeId, value);
    return parseControllerDiscovery(value, { homeId, socketPath });
  } catch (error) {
    if (error instanceof ControllerClientError) throw error;
    if (isNodeError(error) && error.code === "ENOENT") {
      throw new ControllerClientError(
        "CONTROLLER_NOT_RUNNING",
        "Controller is not running."
      );
    }
    throw invalidDiscovery();
  }
}

function discoverySocketPath(homeId: string, value: unknown): string {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw invalidDiscovery();
  }
  const socketPath = Reflect.get(value, "socketPath");
  if (
    typeof socketPath !== "string"
    || !isControllerSocketPathForHome(homeId, socketPath)
  ) {
    throw invalidDiscovery();
  }
  return socketPath;
}

export async function callController(
  home: string,
  method: string,
  params: JsonValue = {},
  options: ControllerCallOptions = {}
): Promise<JsonValue> {
  const discovery = await readControllerDiscovery(home);
  const timeoutMs = options.timeoutMs ?? 5_000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) {
    throw new TypeError("Controller timeout must be a positive integer.");
  }
  const id = options.id ?? randomUUID();
  let requestLine: string;
  try {
    requestLine = encodeControllerRequest({
      id,
      token: discovery.token,
      protocolVersion: FILE_TASK_CONTROLLER_PROTOCOL_VERSION,
      homeId: discovery.homeId,
      controllerInstanceId: discovery.controllerInstanceId,
      method,
      params
    });
  } catch (error) {
    if (error instanceof ControllerProtocolError) {
      throw new ControllerClientError(error.code, error.message);
    }
    throw new ControllerClientError("INVALID_REQUEST", "Invalid controller request.");
  }
  return exchange(discovery.socketPath, requestLine, id, timeoutMs);
}

function exchange(
  socketPath: string,
  requestLine: string,
  expectedId: string,
  timeoutMs: number
): Promise<JsonValue> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(socketPath);
    let buffer = Buffer.alloc(0);
    let settled = false;
    const timer = setTimeout(() => {
      fail(new ControllerClientError(
        "CONTROLLER_TIMEOUT",
        "Controller request timed out."
      ));
    }, timeoutMs);

    const finish = (result: JsonValue): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(result);
    };
    const fail = (error: ControllerClientError): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      reject(error);
    };

    socket.on("connect", () => socket.write(requestLine));
    socket.on("data", (chunk: Buffer) => {
      if (settled) return;
      buffer = Buffer.concat([buffer, chunk]);
      const newline = buffer.indexOf(0x0a);
      if (newline < 0) {
        if (buffer.length > MAX_CONTROLLER_MESSAGE_BYTES) fail(invalidResponse());
        return;
      }
      if (newline > MAX_CONTROLLER_MESSAGE_BYTES || buffer.length !== newline + 1) {
        fail(invalidResponse());
        return;
      }
      try {
        const response = parseControllerResponse(
          buffer.subarray(0, newline).toString("utf8"),
          expectedId
        );
        if (response.ok) finish(response.result);
        else fail(new ControllerClientError(response.error.code, response.error.message));
      } catch {
        fail(invalidResponse());
      }
    });
    socket.on("end", () => {
      if (!settled) fail(invalidResponse());
    });
    socket.on("error", () => {
      fail(new ControllerClientError(
        "CONTROLLER_UNAVAILABLE",
        "Controller is unavailable."
      ));
    });
  });
}

function invalidDiscovery(): ControllerClientError {
  return new ControllerClientError(
    "CONTROLLER_DISCOVERY_INVALID",
    "Controller discovery is invalid."
  );
}

function invalidResponse(): ControllerClientError {
  return new ControllerClientError(
    "INVALID_RESPONSE",
    "Controller response is invalid."
  );
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
