import { randomBytes, timingSafeEqual } from "node:crypto";
import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { readFileSync, realpathSync } from "node:fs";
import { createConnection, createServer, type Server, type Socket } from "node:net";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  CONTROLLER_DISCOVERY_PATH,
  FILE_TASK_CONTROLLER_PROTOCOL_VERSION,
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
import { controllerSocketPath } from "./controllerEndpoint.js";
import { YUI_VERSION, yuiVersionIdentity } from "../version.js";
import { resolveStoreWorkerEnabledForHome } from "../storage/storeRpc.js";
import { resolveTaskStoreBackendForHome } from "../storage/sqliteStore.js";
import {
  detectRunningRelease,
  readActiveReleasePointer,
  readHandoverFence,
  verifyReleaseIntegrity,
  writeHandoverFence,
  writeRuntimeIdentity,
  type ActiveReleasePointer,
  type HandoverFence,
  type HandoverOwner,
  type RuntimeIdentityReceipt,
  type RuntimeReleaseManifest
} from "../release/runtimeRelease.js";
import {
  isBuiltinControllerMethod,
  ControllerCommandObserver,
  ControllerEventLoopDelay,
  type ControllerStatusTelemetry
} from "./controllerTelemetry.js";
import {
  removeEphemeralDomainIdentity,
  readEphemeralDomainIdentity,
  writeEphemeralDomainIdentity,
  type EphemeralDomainIdentity
} from "../controller/domainIdentity.js";

export type ControllerDispatcher = (
  method: string,
  params: JsonValue
) => JsonValue | PromiseLike<JsonValue>;

export type RunningControllerServer = Readonly<{
  discovery: ControllerDiscovery;
  closed: Promise<void>;
  close(): Promise<void>;
  commandObserver: ControllerCommandObserver;
  eventLoopDelay: ControllerEventLoopDelay;
}>;

export type ControllerServerOptions = Readonly<{
  domainIdentity?: EphemeralDomainIdentity;
  status?: (telemetry: ControllerStatusTelemetry) => JsonValue;
  /** Test seam: override the detected running release (null = dev checkout). */
  release?: { releaseDir: string; manifest: RuntimeReleaseManifest } | null;
  /** Test seam: override the storage backend reported in the identity receipt. */
  storageBackend?: "file" | "sqlite";
  /** Test seam: override the worker-enabled flag reported in the identity receipt. */
  workerEnabled?: boolean;
}>;

/** In-memory handover fence for one Controller process. */
export type ControllerHandoverState = {
  fence: { handoverId: string; fencedAt: string } | null;
};

/** Methods that stay available while a handover fence is active. */
const HANDOVER_ALLOWED_METHODS = new Set([
  "controller.identity",
  "controller.status",
  "controller.handover-state",
  "controller.commit-handover",
  "controller.rollback-handover"
]);

export async function startControllerServer(
  home: string,
  dispatcher?: ControllerDispatcher,
  beforeDiscoveryRemoval?: () => void | Promise<void>,
  options: ControllerServerOptions = {}
): Promise<RunningControllerServer> {
  const releaseLifecycleLock = await acquireHomeLifecycleLock(home);
  try {
    return await startControllerServerLocked(
      home,
      dispatcher,
      beforeDiscoveryRemoval,
      options
    );
  } finally {
    await releaseLifecycleLock();
  }
}

async function startControllerServerLocked(
  home: string,
  dispatcher?: ControllerDispatcher,
  beforeDiscoveryRemoval?: () => void | Promise<void>,
  options: ControllerServerOptions = {}
): Promise<RunningControllerServer> {
  const discoveryPath = join(home, CONTROLLER_DISCOVERY_PATH);
  const socketPath = controllerSocketPath(home);
  const runtimeDirectory = dirname(discoveryPath);
  const socketDirectory = dirname(socketPath);
  await mkdir(runtimeDirectory, { recursive: true, mode: 0o700 });
  await chmod(runtimeDirectory, 0o700);
  await mkdir(socketDirectory, { recursive: true, mode: 0o700 });
  await chmod(socketDirectory, 0o700);

  const token = randomBytes(32).toString("hex");
  let closeRunning: () => Promise<void> = async () => undefined;
  const commandObserver = new ControllerCommandObserver();
  const eventLoopDelay = new ControllerEventLoopDelay();
  const telemetry: ControllerStatusTelemetry = Object.freeze({
    commandObserver,
    eventLoopDelay
  });
  const handover: ControllerHandoverState = { fence: null };
  const release = options.release === undefined
    ? detectRunningRelease(fileURLToPath(import.meta.url))
    : options.release;
  // Issue 01: the Home decides the backend. The receipt reports the truthful
  // Home-decided backend (SQLite for a layout-7 Home with yui.db, file store
  // for older layouts) instead of deriving it from YUI_STORE_BACKEND, which is
  // reserved for tests and explicit recovery commands.
  const storageBackend = options.storageBackend
    ?? resolveTaskStoreBackendForHome(home, process.env);
  const workerEnabled = options.workerEnabled
    ?? resolveStoreWorkerEnabledForHome(home, process.env);
  const netServer = createServer((socket) => {
    receiveRequest(
      socket,
      token,
      dispatcher,
      () => closeRunning(),
      options.status,
      telemetry,
      handover,
      home
    );
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

  eventLoopDelay.start();

  try {
    await chmod(socketPath, 0o600);
    const processStartIdentity = await readLinuxProcessStartIdentity(process.pid);
    const discovery: ControllerDiscovery = Object.freeze({
      pid: process.pid,
      processStartIdentity,
      socketPath,
      token
    });
    if (options.domainIdentity !== undefined) {
      writeEphemeralDomainIdentity(home, options.domainIdentity);
    }
    await writeDiscoveryAtomically(discoveryPath, discovery);
    // Issue 02: every Controller start publishes its provenance. The receipt
    // is the stable, file-based identity that survives a Controller stop and
    // backs the read-only `controller identity --json` command.
    writeRuntimeIdentity(home, buildRuntimeIdentityReceipt({
      home,
      release,
      storageBackend,
      workerEnabled,
      processStartIdentity,
      mode: "primary",
      dualOwner: false
    }));

    let resolveClosed: () => void = () => undefined;
    const closed = new Promise<void>((resolve) => {
      resolveClosed = resolve;
    });
    let closePromise: Promise<void> | undefined;
    closeRunning = (): Promise<void> => {
      if (closePromise !== undefined) return closePromise;
      closePromise = (async () => {
        eventLoopDelay.stop();
        await beforeDiscoveryRemoval?.();
        await closeNetServer(netServer);
        await removeOwnedDiscovery(discoveryPath, token);
        if (options.domainIdentity !== undefined) {
          // Keep the exact target fence while detached Role panes survive a
          // Controller stop/restart. The owning test teardown or an expired
          // domain reaper removes the identity only after those resources
          // converge, never by dropping the fence during a normal stop.
          const current = readEphemeralDomainIdentity(home);
          if (
            current.status === "valid"
            && current.identity?.token === options.domainIdentity.token
            && current.identity.tmuxTargets.length === 0
          ) {
            removeEphemeralDomainIdentity(home, options.domainIdentity.token);
          }
        }
        resolveClosed();
      })();
      return closePromise;
    };

    return Object.freeze({
      discovery,
      closed,
      close: closeRunning,
      commandObserver,
      eventLoopDelay
    });
  } catch (error) {
    eventLoopDelay.stop();
    await closeNetServer(netServer);
    throw error;
  }
}

async function writeDiscoveryAtomically(
  discoveryPath: string,
  discovery: ControllerDiscovery
): Promise<void> {
  const temporaryPath = `${discoveryPath}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`;
  try {
    await writeFile(temporaryPath, `${JSON.stringify(discovery)}\n`, {
      mode: 0o600,
      flag: "wx"
    });
    await chmod(temporaryPath, 0o600);
    await rename(temporaryPath, discoveryPath);
  } catch (error) {
    await rm(temporaryPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

function receiveRequest(
  socket: Socket,
  token: string,
  dispatcher: ControllerDispatcher | undefined,
  stop: () => Promise<void>,
  status: ((telemetry: ControllerStatusTelemetry) => JsonValue) | undefined,
  telemetry: ControllerStatusTelemetry,
  handover: ControllerHandoverState,
  home: string
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
    void routeRequest(
      socket,
      buffer.subarray(0, newline).toString("utf8"),
      token,
      dispatcher,
      stop,
      status,
      telemetry,
      handover,
      home
    );
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
  stop: () => Promise<void>,
  status: ((telemetry: ControllerStatusTelemetry) => JsonValue) | undefined,
  telemetry: ControllerStatusTelemetry,
  handover: ControllerHandoverState,
  home: string
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

  // Every authenticated request is observed once at the routing layer. The
  // observation completes when the response is handed to the socket, so a
  // later status snapshot sees prior built-in completions and the dispatcher
  // service-time metric stays a distinct observation.
  const observation = telemetry.commandObserver.start();
  const send = (response: ControllerResponse, onFlushed?: () => void): void => {
    observation.complete(
      isBuiltinControllerMethod(request.method) ? "builtin" : "dispatched",
      response.ok ? "success" : "failure"
    );
    sendResponse(socket, response, onFlushed);
  };

  // Issue 02: a fenced Controller is mid-handover. It stops accepting new
  // mutations and only answers the handover control methods plus read-only
  // identity/status queries until the candidate promotes or the handover
  // rolls back.
  if (handover.fence !== null && !HANDOVER_ALLOWED_METHODS.has(request.method)) {
    send(
      controllerFailure(
        request.id,
        "CONTROLLER_HANDOVER_FENCED",
        "Controller is fenced for a release handover; retry after the handover completes."
      )
    );
    return;
  }

  if (request.method === "controller.identity") {
    if (!isEmptyParams(request.params)) {
      send(
        controllerFailure(request.id, "INVALID_PARAMS", "Controller params are invalid.")
      );
      return;
    }
    // This is an authenticated, private lifecycle response. Unlike the public
    // resource inventory, it retains the exact executable/argv that the socket
    // owner was launched with so an update can restore that same Controller.
    // Issue 02 extends it with the release provenance the handover and the
    // exact control-plane gate consume.
    // The pid + process start identity let `release activate` fence this exact
    // owner as the old Controller during a handover; without them the
    // activator cannot distinguish a live owner from an empty Home and would
    // bypass the handover sequence.
    const release = detectRunningRelease(fileURLToPath(import.meta.url));
    // Verify the running release's integrity so a drifted Controller can be
    // refused by a handover activator. The Controller stays alive; the flag
    // lets the activator fail closed without killing the serving process.
    let releaseDrifted = false;
    if (release !== null) {
      try {
        verifyReleaseIntegrity(release.releaseDir);
      } catch {
        releaseDrifted = true;
      }
    }
    let processStartIdentity: string | undefined;
    try {
      processStartIdentity = readLinuxProcessStartIdentitySync(process.pid);
    } catch {
      // Non-Linux or an unreadable /proc: the owner cannot be fenced, so the
      // handover path treats it as absent. The rest of the identity stays
      // available for read-only consumers.
    }
    send({
      id: request.id,
      ok: true,
      result: {
        executablePath: process.execPath,
        args: process.argv.slice(1),
        version: YUI_VERSION,
        buildId: release?.manifest.buildId ?? "dev",
        packageDigest: release?.manifest.packageDigest ?? null,
        sourceCommit: release?.manifest.sourceCommit ?? null,
        cliRealpath: controllerCliRealpath(),
        controllerRealpath: realpathSync(fileURLToPath(import.meta.url)),
        controllerProtocolVersion: FILE_TASK_CONTROLLER_PROTOCOL_VERSION,
        storageBackend: resolveTaskStoreBackendForHome(home, process.env),
        workerEnabled: resolveStoreWorkerEnabledForHome(home, process.env),
        mode: "primary",
        dualOwner: false,
        ...(releaseDrifted ? { releaseDrifted: true } : {}),
        // A corrupted pointer file must not kill the serving Controller with
        // an unhandled rejection; surface a degraded identity so the caller
        // can diagnose, and let `release activate` fail on its own read.
        activeRelease: readActiveReleasePointerSafe(home),
        pid: process.pid,
        ...(processStartIdentity === undefined
          ? {}
          : { processStartIdentity })
      }
    });
    return;
  }

  if (request.method === "controller.status") {
    if (!isEmptyParams(request.params)) {
      send(
        controllerFailure(request.id, "INVALID_PARAMS", "Controller params are invalid.")
      );
      return;
    }
    send({
      id: request.id,
      ok: true,
      result: {
        pid: process.pid,
        running: true,
        // Issue 11: process identity facts for status/audit. Read-only.
        uptimeMs: Math.round(process.uptime() * 1000),
        rssBytes: process.memoryUsage().rss,
        protocolVersion: FILE_TASK_CONTROLLER_PROTOCOL_VERSION,
        version: YUI_VERSION,
        storageLayoutVersion: yuiVersionIdentity().storageLayoutVersion,
        aggregateSchemaVersion: yuiVersionIdentity().aggregateSchemaVersion,
        ...(status === undefined ? {} : { runtime: status(telemetry) })
      }
    });
    return;
  }

  if (request.method === "controller.stop") {
    const expectedPid = expectedControllerStopPid(request.params);
    if (expectedPid === null) {
      send(
        controllerFailure(request.id, "INVALID_PARAMS", "Controller params are invalid.")
      );
      return;
    }
    if (expectedPid !== undefined && expectedPid !== process.pid) {
      send(
        controllerFailure(
          request.id,
          "CONTROLLER_OWNERSHIP_MISMATCH",
          `Controller PID ${process.pid} does not match the expected PID ${expectedPid}.`
        )
      );
      return;
    }
    send(
      {
        id: request.id,
        ok: true,
        result: {
          stopped: true,
          ...(expectedPid === undefined ? {} : { pid: process.pid })
        }
      },
      () => void stop()
    );
    return;
  }

  if (request.method === "controller.begin-handover") {
    const params = parseBeginHandoverParams(request.params);
    if (params === null) {
      send(
        controllerFailure(request.id, "INVALID_PARAMS", "Controller params are invalid.")
      );
      return;
    }
    if (handover.fence !== null) {
      send(
        controllerFailure(
          request.id,
          "CONTROLLER_HANDOVER_ACTIVE",
          "Controller is already fenced for a release handover."
        )
      );
      return;
    }
    const fencedAt = new Date().toISOString();
    const owner = currentHandoverOwner();
    const fence: HandoverFence = Object.freeze({
      schemaVersion: 1,
      handoverId: params.handoverId,
      phase: "fenced",
      old: owner,
      candidate: null,
      fromReleaseId: params.fromReleaseId,
      toReleaseId: params.toReleaseId,
      createdAt: fencedAt,
      updatedAt: fencedAt
    });
    // Write the durable fence BEFORE setting the in-memory fence. If the
    // durable write fails, the Controller must not be left permanently fenced
    // in memory (retry would get CONTROLLER_HANDOVER_ACTIVE with no durable
    // state to roll back).
    try {
      writeHandoverFence(home, fence);
    } catch (error) {
      const detail = error instanceof Error ? safeErrorMessage(error.message) : undefined;
      send(
        controllerFailure(
          request.id,
          "INTERNAL_ERROR",
          `Failed to write the handover fence${detail === undefined ? "" : `: ${detail}`}`
        )
      );
      return;
    }
    handover.fence = { handoverId: params.handoverId, fencedAt };
    send({
      id: request.id,
      ok: true,
      result: handoverFenceResult(fence)
    });
    return;
  }

  if (request.method === "controller.commit-handover") {
    const handoverId = parseHandoverIdParam(request.params);
    if (handoverId === null) {
      send(
        controllerFailure(request.id, "INVALID_PARAMS", "Controller params are invalid.")
      );
      return;
    }
    if (handover.fence === null || handover.fence.handoverId !== handoverId) {
      send(
        controllerFailure(
          request.id,
          "CONTROLLER_HANDOVER_MISMATCH",
          "Controller handover fence does not match the requested handover."
        )
      );
      return;
    }
    const committedAt = new Date().toISOString();
    const existing = readHandoverFenceOrNull(home);
    if (existing !== null) {
      try {
        writeHandoverFence(home, Object.freeze({
          ...existing,
          phase: "committed",
          updatedAt: committedAt
        }));
      } catch (error) {
        const detail = error instanceof Error ? safeErrorMessage(error.message) : undefined;
        send(
          controllerFailure(
            request.id,
            "INTERNAL_ERROR",
            `Failed to commit the handover fence${detail === undefined ? "" : `: ${detail}`}`
          )
        );
        return;
      }
    }
    // Keep the in-memory fence set until this process exits. The pointer has
    // switched and the Controller is draining; clearing the fence here would
    // reopen the mutation window on the old release before stop() completes.
    // The in-memory state dies with the process.
    send({
      id: request.id,
      ok: true,
      result: { committed: true, pid: process.pid }
    }, () => void stop());
    return;
  }

  if (request.method === "controller.rollback-handover") {
    const handoverId = parseHandoverIdParam(request.params);
    if (handoverId === null) {
      send(
        controllerFailure(request.id, "INVALID_PARAMS", "Controller params are invalid.")
      );
      return;
    }
    if (handover.fence === null || handover.fence.handoverId !== handoverId) {
      send(
        controllerFailure(
          request.id,
          "CONTROLLER_HANDOVER_MISMATCH",
          "Controller handover fence does not match the requested handover."
        )
      );
      return;
    }
    const rolledBackAt = new Date().toISOString();
    const existing = readHandoverFenceOrNull(home);
    if (existing !== null) {
      writeHandoverFence(home, Object.freeze({
        ...existing,
        phase: "rolled-back",
        updatedAt: rolledBackAt
      }));
    }
    handover.fence = null;
    send({
      id: request.id,
      ok: true,
      result: { resumed: true, pid: process.pid }
    });
    return;
  }

  if (request.method === "controller.handover-state") {
    if (!isEmptyParams(request.params)) {
      send(
        controllerFailure(request.id, "INVALID_PARAMS", "Controller params are invalid.")
      );
      return;
    }
    const fence = readHandoverFenceOrNull(home);
    send({
      id: request.id,
      ok: true,
      result: {
        fenced: handover.fence !== null,
        ...(handover.fence === null ? {} : { handoverId: handover.fence.handoverId }),
        ...(fence === null ? {} : { phase: fence.phase })
      }
    });
    return;
  }

  if (dispatcher === undefined) {
    send(
      controllerFailure(request.id, "METHOD_NOT_FOUND", "Controller method was not found.")
    );
    return;
  }

  try {
    const result = await dispatcher(request.method, request.params);
    send({ id: request.id, ok: true, result });
  } catch (error) {
    const safeError = safeDispatcherError(error);
    send(
      safeError === undefined
        ? controllerFailure(request.id, "INTERNAL_ERROR", "Controller request failed.")
        : controllerFailure(request.id, safeError.code, safeError.message)
    );
  }
}

// ---------------------------------------------------------------------------
// Issue 02: release handover helpers

type BeginHandoverParams = Readonly<{
  handoverId: string;
  fromReleaseId: string | null;
  toReleaseId: string;
}>;

function parseBeginHandoverParams(value: JsonValue): BeginHandoverParams | null {
  if (
    typeof value !== "object"
    || value === null
    || Array.isArray(value)
  ) {
    return null;
  }
  const record = value as Record<string, JsonValue>;
  const handoverId = record.handoverId;
  const toReleaseId = record.toReleaseId;
  if (
    typeof handoverId !== "string"
    || handoverId.length === 0
    || handoverId.length > 128
    || typeof toReleaseId !== "string"
    || toReleaseId.length === 0
    || toReleaseId.length > 256
  ) {
    return null;
  }
  const fromReleaseId = record.fromReleaseId;
  if (
    fromReleaseId !== undefined
    && (typeof fromReleaseId !== "string" || fromReleaseId.length > 256)
  ) {
    return null;
  }
  return {
    handoverId,
    fromReleaseId: typeof fromReleaseId === "string" ? fromReleaseId : null,
    toReleaseId
  };
}

function parseHandoverIdParam(value: JsonValue): string | null {
  if (
    typeof value !== "object"
    || value === null
    || Array.isArray(value)
  ) {
    return null;
  }
  const handoverId = (value as Record<string, JsonValue>).handoverId;
  return typeof handoverId === "string" && handoverId.length > 0 && handoverId.length <= 128
    ? handoverId
    : null;
}

function currentHandoverOwner(): HandoverOwner {
  const release = detectRunningRelease(fileURLToPath(import.meta.url));
  return Object.freeze({
    pid: process.pid,
    processStartIdentity: readLinuxProcessStartIdentitySync(process.pid),
    buildId: release?.manifest.buildId ?? "dev",
    version: YUI_VERSION
  });
}

function handoverFenceResult(fence: HandoverFence): JsonValue {
  return {
    handoverId: fence.handoverId,
    phase: fence.phase,
    old: {
      pid: fence.old.pid,
      processStartIdentity: fence.old.processStartIdentity,
      buildId: fence.old.buildId,
      version: fence.old.version
    },
    toReleaseId: fence.toReleaseId
  };
}

function readHandoverFenceOrNull(home: string): HandoverFence | null {
  try {
    return readHandoverFence(home);
  } catch {
    return null;
  }
}

/** Read the active release pointer without letting a corrupted file kill the Controller. */
function readActiveReleasePointerSafe(home: string): ActiveReleasePointer | null {
  try {
    return readActiveReleasePointer(home);
  } catch {
    return null;
  }
}

function readLinuxProcessStartIdentitySync(pid: number): string {
  // The async /proc reader is used at startup; handover RPCs need a sync
  // identity to keep the request handler simple. Both parse the same field.
  const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
  const closingParenthesis = stat.lastIndexOf(")");
  if (closingParenthesis < 0) {
    throw new Error(`Cannot read Controller process identity for PID ${pid}.`);
  }
  const fieldsAfterCommand = stat.slice(closingParenthesis + 1).trim().split(/\s+/u);
  const processStartIdentity = fieldsAfterCommand[19];
  if (
    processStartIdentity === undefined
    || !/^[0-9]{1,32}$/u.test(processStartIdentity)
  ) {
    throw new Error(`Cannot read Controller process identity for PID ${pid}.`);
  }
  return processStartIdentity;
}

function controllerCliRealpath(): string {
  return realpathSync(fileURLToPath(new URL("../cli.js", import.meta.url)));
}

type RuntimeIdentityInput = Readonly<{
  home: string;
  release: { releaseDir: string; manifest: RuntimeReleaseManifest } | null;
  storageBackend: "file" | "sqlite";
  workerEnabled: boolean;
  processStartIdentity: string;
  mode: "primary" | "candidate";
  dualOwner: boolean;
}>;

export function buildRuntimeIdentityReceipt(input: RuntimeIdentityInput): RuntimeIdentityReceipt {
  const activeRelease: ActiveReleasePointer | null = (() => {
    try {
      return readActiveReleasePointer(input.home);
    } catch {
      return null;
    }
  })();
  return Object.freeze({
    schemaVersion: 1,
    version: YUI_VERSION,
    executablePath: process.execPath,
    args: process.argv.slice(1),
    buildId: input.release?.manifest.buildId ?? "dev",
    packageDigest: input.release?.manifest.packageDigest ?? null,
    sourceCommit: input.release?.manifest.sourceCommit ?? null,
    cliRealpath: controllerCliRealpath(),
    controllerRealpath: realpathSync(fileURLToPath(import.meta.url)),
    controllerProtocolVersion: FILE_TASK_CONTROLLER_PROTOCOL_VERSION,
    storageLayoutVersion: yuiVersionIdentity().storageLayoutVersion,
    aggregateSchemaVersion: yuiVersionIdentity().aggregateSchemaVersion,
    storageBackend: input.storageBackend,
    workerEnabled: input.workerEnabled,
    pid: process.pid,
    processStartIdentity: input.processStartIdentity,
    mode: input.mode,
    dualOwner: input.dualOwner,
    activeRelease,
    writtenAt: new Date().toISOString()
  });
}

/**
 * `controller.stop` is public with `{}` params, but update's replacement
 * mismatch path may provide one exact PID fence.  `null` means malformed;
 * `undefined` is the ordinary unfenced public request.
 */
function expectedControllerStopPid(value: JsonValue): number | undefined | null {
  if (isEmptyParams(value)) return undefined;
  if (
    typeof value !== "object"
    || value === null
    || Array.isArray(value)
    || Reflect.ownKeys(value).length !== 1
    || !("expectedPid" in value)
    || !Number.isSafeInteger(value.expectedPid)
    || (value.expectedPid as number) <= 0
  ) {
    return null;
  }
  return value.expectedPid as number;
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
    case "UNAUTHORIZED":
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

type HomeLifecycleLockOwner = Readonly<{
  pid: number;
  token: string;
  createdAt: string;
}>;

async function acquireHomeLifecycleLock(home: string): Promise<() => Promise<void>> {
  const lockPath = homeLifecycleLockPath(home);
  await mkdir(dirname(lockPath), { recursive: true, mode: 0o700 });
  const owner: HomeLifecycleLockOwner = Object.freeze({
    pid: process.pid,
    token: randomBytes(16).toString("hex"),
    createdAt: new Date().toISOString()
  });
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      await writeFile(lockPath, `${JSON.stringify(owner)}\n`, {
        flag: "wx",
        mode: 0o600
      });
      return () => releaseHomeLifecycleLock(lockPath, owner);
    } catch (error) {
      if (!isNodeError(error) || error.code !== "EEXIST") throw error;
    }
    let existing: HomeLifecycleLockOwner;
    try {
      existing = await readHomeLifecycleLockOwner(lockPath);
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") continue;
      throw error;
    }
    const ownerDescription = `owner PID ${existing.pid}, createdAt ${existing.createdAt}`;
    if (isProcessAlive(existing.pid)) {
      throw new Error(
        `Another Yui home lifecycle operation is already running (${ownerDescription}): ${lockPath}`
      );
    }
    throw new Error(
      `A previous Yui home lifecycle operation left a stale lock `
        + `(${ownerDescription}): ${lockPath}. `
        + "If no Controller startup or development reset is running, "
        + "remove this exact lock file and retry."
    );
  }
  throw new Error(
    `Cannot safely acquire the Yui home lifecycle lock because its owner changed repeatedly: `
      + lockPath
  );
}

function homeLifecycleLockPath(home: string): string {
  const resolvedHome = resolve(home);
  return join(dirname(resolvedHome), `.${basename(resolvedHome)}.controller-lifecycle.lock`);
}

async function readHomeLifecycleLockOwner(lockPath: string): Promise<HomeLifecycleLockOwner> {
  try {
    const value: unknown = JSON.parse(await readFile(lockPath, "utf8"));
    if (
      typeof value !== "object" || value === null
      || !("pid" in value) || !Number.isSafeInteger(value.pid) || (value.pid as number) <= 0
      || !("token" in value) || typeof value.token !== "string"
      || value.token.length === 0 || value.token.length > 128
      || !("createdAt" in value) || typeof value.createdAt !== "string"
      || Number.isNaN(Date.parse(value.createdAt))
    ) {
      throw new Error("invalid owner");
    }
    return Object.freeze({
      pid: value.pid as number,
      token: value.token,
      createdAt: value.createdAt
    });
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") throw error;
    throw new Error(
      `Cannot verify the existing Yui home lifecycle lock: ${lockPath}. `
        + "If no Controller startup or development reset is running, remove this exact lock file and retry."
    );
  }
}

async function releaseHomeLifecycleLock(
  lockPath: string,
  owner: HomeLifecycleLockOwner
): Promise<void> {
  let current: HomeLifecycleLockOwner;
  try {
    current = await readHomeLifecycleLockOwner(lockPath);
  } catch {
    return;
  }
  if (current.pid === owner.pid && current.token === owner.token) {
    await rm(lockPath, { force: true });
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !isNodeError(error) || error.code !== "ESRCH";
  }
}

async function readLinuxProcessStartIdentity(pid: number): Promise<string> {
  const stat = await readFile(`/proc/${pid}/stat`, "utf8");
  const closingParenthesis = stat.lastIndexOf(")");
  if (closingParenthesis < 0) {
    throw new Error(`Cannot read Controller process identity for PID ${pid}.`);
  }
  const fieldsAfterCommand = stat.slice(closingParenthesis + 1).trim().split(/\s+/u);
  const processStartIdentity = fieldsAfterCommand[19];
  if (
    processStartIdentity === undefined
    || !/^[0-9]{1,32}$/u.test(processStartIdentity)
  ) {
    throw new Error(`Cannot read Controller process identity for PID ${pid}.`);
  }
  return processStartIdentity;
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
