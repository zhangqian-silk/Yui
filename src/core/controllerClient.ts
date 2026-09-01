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
import { readHomeFilesystemId } from "./homeFilesystemIdentity.js";
import {
  findLiveControllerProcessForHome,
  inspectLiveControllerProcess
} from "./controllerProcessIdentity.js";

export class ControllerClientError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "ControllerClientError";
  }
}

/** The Controller may have committed the request before this client lost its acknowledgement. */
export function controllerCallMayHaveApplied(error: unknown): boolean {
  return error instanceof ControllerClientError
    && [
      "CONTROLLER_TIMEOUT",
      "CONTROLLER_UNAVAILABLE",
      "INVALID_RESPONSE"
    ].includes(error.code);
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
    const socketPath = discoverySocketPath(value);
    return parseControllerDiscovery(value, {
      homeFilesystemId: readHomeFilesystemId(home),
      socketPath
    });
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

function discoverySocketPath(value: unknown): string {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw invalidDiscovery();
  }
  const homeId = Reflect.get(value, "homeId");
  const socketPath = Reflect.get(value, "socketPath");
  if (
    typeof homeId !== "string"
    || typeof socketPath !== "string"
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
      homeFilesystemId: discovery.homeFilesystemId,
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

/**
 * Explicit restart recovery for an exact Controller whose discovery record
 * was lost. The signal is fenced by same UID, controller entrypoint, physical
 * Home identity, PID, and process-start identity; an unprovable process is
 * never touched.
 */
export async function stopOrphanedFileTaskController(
  home: string,
  timeoutMs: number
): Promise<Readonly<{ pid: number }> | undefined> {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) {
    throw new TypeError("Controller timeout must be a positive integer.");
  }
  const homeFilesystemId = readHomeFilesystemId(home);
  const candidate = findLiveControllerProcessForHome(homeFilesystemId);
  if (candidate === undefined) return undefined;
  if (
    inspectLiveControllerProcess(
      candidate.pid,
      homeFilesystemId,
      candidate.processStartIdentity
    ) === undefined
  ) return undefined;
  try {
    process.kill(candidate.pid, "SIGTERM");
  } catch (error) {
    if (isNodeError(error) && error.code === "ESRCH") return undefined;
    throw error;
  }
  const deadline = Date.now() + timeoutMs;
  while (
    inspectLiveControllerProcess(
      candidate.pid,
      homeFilesystemId,
      candidate.processStartIdentity
    ) !== undefined
  ) {
    if (Date.now() >= deadline) {
      throw new ControllerClientError(
        "CONTROLLER_TIMEOUT",
        `Orphaned Controller did not stop within ${timeoutMs} ms.`
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return Object.freeze({ pid: candidate.pid });
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
    let deliveryStarted = false;
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

    socket.on("connect", () => {
      // Once write begins, a missing response cannot prove that the Controller
      // did not commit the request. Callers must use their domain identity to
      // decide whether an explicit retry is safe.
      deliveryStarted = true;
      socket.write(requestLine);
    });
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
      fail(deliveryStarted
        ? new ControllerClientError(
          "CONTROLLER_DELIVERY_UNKNOWN",
          "Controller request delivery is unknown."
        )
        : new ControllerClientError(
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
