import { randomBytes, timingSafeEqual } from "node:crypto";
import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createConnection, createServer, type Server, type Socket } from "node:net";
import { dirname, join } from "node:path";

import {
  CONTROLLER_DISCOVERY_PATH,
  CONTROLLER_SOCKET_PATH,
  MAX_CONTROLLER_MESSAGE_BYTES,
  ControllerProtocolError,
  controllerFailure,
  encodeControllerResponse,
  isEmptyParams,
  parseControllerRequest,
  type ControllerDiscovery,
  type ControllerResponse,
  type JsonValue
} from "./protocol.js";

export type ControllerDispatcher = (
  method: string,
  params: JsonValue
) => JsonValue | PromiseLike<JsonValue>;

export type RunningControllerServer = Readonly<{
  discovery: ControllerDiscovery;
  closed: Promise<void>;
  close(): Promise<void>;
}>;

export async function startControllerServer(
  home: string,
  dispatcher?: ControllerDispatcher
): Promise<RunningControllerServer> {
  const discoveryPath = join(home, CONTROLLER_DISCOVERY_PATH);
  const socketPath = join(home, CONTROLLER_SOCKET_PATH);
  const runtimeDirectory = dirname(discoveryPath);
  await mkdir(runtimeDirectory, { recursive: true, mode: 0o700 });
  await chmod(runtimeDirectory, 0o700);

  const token = randomBytes(32).toString("hex");
  let closeRunning: () => Promise<void> = async () => undefined;
  const netServer = createServer((socket) => {
    receiveRequest(socket, token, dispatcher, () => closeRunning());
  });

  try {
    await listen(netServer, socketPath);
  } catch (error) {
    if (!isAddressInUse(error)) throw error;
    if (await socketIsReachable(socketPath)) throw controllerAlreadyRunning();
    await rm(socketPath, { force: true });
    try {
      await listen(netServer, socketPath);
    } catch (retryError) {
      if (isAddressInUse(retryError)) throw controllerAlreadyRunning();
      throw retryError;
    }
  }

  try {
    await chmod(socketPath, 0o600);
    const discovery: ControllerDiscovery = Object.freeze({
      pid: process.pid,
      socketPath,
      token
    });
    await writeFile(discoveryPath, `${JSON.stringify(discovery)}\n`, { mode: 0o600 });
    await chmod(discoveryPath, 0o600);

    let resolveClosed: () => void = () => undefined;
    const closed = new Promise<void>((resolve) => {
      resolveClosed = resolve;
    });
    let closePromise: Promise<void> | undefined;
    closeRunning = (): Promise<void> => {
      if (closePromise !== undefined) return closePromise;
      closePromise = (async () => {
        await closeNetServer(netServer);
        await removeOwnedDiscovery(discoveryPath, token);
        resolveClosed();
      })();
      return closePromise;
    };

    return Object.freeze({ discovery, closed, close: closeRunning });
  } catch (error) {
    await closeNetServer(netServer);
    throw error;
  }
}

function receiveRequest(
  socket: Socket,
  token: string,
  dispatcher: ControllerDispatcher | undefined,
  stop: () => Promise<void>
): void {
  let buffer = Buffer.alloc(0);
  let complete = false;

  const fail = (code: string, message: string, id = "invalid"): void => {
    if (complete) return;
    complete = true;
    sendResponse(socket, controllerFailure(id, code, message));
  };

  socket.on("data", (chunk: Buffer) => {
    if (complete) return;
    buffer = Buffer.concat([buffer, chunk]);
    const newline = buffer.indexOf(0x0a);
    if (newline < 0) {
      if (buffer.length > MAX_CONTROLLER_MESSAGE_BYTES) {
        fail("MESSAGE_TOO_LARGE", "Controller message exceeds 1 MiB.");
      }
      return;
    }
    if (newline > MAX_CONTROLLER_MESSAGE_BYTES) {
      fail("MESSAGE_TOO_LARGE", "Controller message exceeds 1 MiB.");
      return;
    }
    if (buffer.length !== newline + 1) {
      fail("INVALID_REQUEST", "Invalid controller request.");
      return;
    }
    complete = true;
    void routeRequest(socket, buffer.subarray(0, newline).toString("utf8"), token, dispatcher, stop);
  });
  socket.on("end", () => {
    if (!complete) fail("INVALID_REQUEST", "Invalid controller request.");
  });
  socket.on("error", () => undefined);
}

async function routeRequest(
  socket: Socket,
  line: string,
  token: string,
  dispatcher: ControllerDispatcher | undefined,
  stop: () => Promise<void>
): Promise<void> {
  let request;
  try {
    request = parseControllerRequest(line);
  } catch (error) {
    const protocolError = error instanceof ControllerProtocolError
      ? error
      : new ControllerProtocolError("INVALID_REQUEST", "Invalid controller request.");
    sendResponse(
      socket,
      controllerFailure(protocolError.id, protocolError.code, protocolError.message)
    );
    return;
  }

  if (!tokensMatch(request.token, token)) {
    sendResponse(
      socket,
      controllerFailure(
        request.id,
        "UNAUTHORIZED",
        "Controller authentication failed."
      )
    );
    return;
  }

  if (request.method === "controller.status") {
    if (!isEmptyParams(request.params)) {
      sendResponse(
        socket,
        controllerFailure(request.id, "INVALID_PARAMS", "Controller params are invalid.")
      );
      return;
    }
    sendResponse(socket, {
      id: request.id,
      ok: true,
      result: { pid: process.pid, running: true }
    });
    return;
  }

  if (request.method === "controller.stop") {
    if (!isEmptyParams(request.params)) {
      sendResponse(
        socket,
        controllerFailure(request.id, "INVALID_PARAMS", "Controller params are invalid.")
      );
      return;
    }
    sendResponse(
      socket,
      { id: request.id, ok: true, result: { stopped: true } },
      () => void stop()
    );
    return;
  }

  if (dispatcher === undefined) {
    sendResponse(
      socket,
      controllerFailure(request.id, "METHOD_NOT_FOUND", "Controller method was not found.")
    );
    return;
  }

  try {
    const result = await dispatcher(request.method, request.params);
    sendResponse(socket, { id: request.id, ok: true, result });
  } catch (error) {
    const safeError = safeDispatcherError(error);
    sendResponse(
      socket,
      safeError === undefined
        ? controllerFailure(request.id, "INTERNAL_ERROR", "Controller request failed.")
        : controllerFailure(request.id, safeError.code, safeError.message)
    );
  }
}

function sendResponse(
  socket: Socket,
  response: ControllerResponse,
  onFlushed?: () => void
): void {
  let line: string;
  try {
    line = encodeControllerResponse(response);
  } catch {
    line = encodeControllerResponse(
      controllerFailure(response.id, "INTERNAL_ERROR", "Controller request failed.")
    );
  }
  socket.end(line, onFlushed);
}

function tokensMatch(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left, "hex");
  const rightBytes = Buffer.from(right, "hex");
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
}

function listen(server: Server, socketPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error): void => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = (): void => {
      server.off("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(socketPath);
  });
}

function socketIsReachable(socketPath: string): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection(socketPath);
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("error", () => {
      socket.destroy();
      resolve(false);
    });
  });
}

function closeNetServer(server: Server): Promise<void> {
  if (!server.listening) return Promise.resolve();
  return new Promise((resolve, reject) => {
    server.close((error) => error === undefined ? resolve() : reject(error));
  });
}

async function removeOwnedDiscovery(path: string, token: string): Promise<void> {
  try {
    const value: unknown = JSON.parse(await readFile(path, "utf8"));
    if (
      typeof value === "object"
      && value !== null
      && "token" in value
      && value.token === token
    ) {
      await rm(path, { force: true });
    }
  } catch {
    // Cleanup is best effort; transport shutdown must still finish.
  }
}

function safeDispatcherError(
  error: unknown
): Readonly<{ code: string; message: string }> | undefined {
  try {
    if (!(error instanceof Error) || typeof error.message !== "string") return undefined;
    const message = safeErrorMessage(error.message);
    if (message === undefined) return undefined;
    switch (error.name) {
      case "CoreApplicationError": {
        const code = "code" in error && typeof error.code === "string"
          ? safeApplicationErrorCode(error.code)
          : undefined;
        return code === undefined ? undefined : { code, message };
      }
      case "CoreServiceError":
        return { code: "SERVICE_ERROR", message };
      case "CoreJobError":
        return { code: "JOB_ERROR", message };
      default:
        return undefined;
    }
  } catch {
    return undefined;
  }
}

function safeApplicationErrorCode(code: string): string | undefined {
  switch (code) {
    case "INVALID_PARAMS":
    case "METHOD_NOT_FOUND":
    case "NOT_FOUND":
      return code;
    default:
      return undefined;
  }
}

function safeErrorMessage(message: string): string | undefined {
  const safe = message
    .replace(/[\r\n\u2028\u2029]+/gu, " ")
    .trim()
    .slice(0, 512);
  return safe.length === 0 ? undefined : safe;
}

function controllerAlreadyRunning(): Error {
  return new Error("Controller is already running.");
}

function isAddressInUse(error: unknown): boolean {
  return isNodeError(error) && error.code === "EADDRINUSE";
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
