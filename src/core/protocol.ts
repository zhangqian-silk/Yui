export const MAX_CONTROLLER_MESSAGE_BYTES = 1_048_576;
export const CONTROLLER_DISCOVERY_PATH = "runtime/controller.json";
/** Bump when a running Controller cannot safely share one YUI_HOME with this CLI. */
export const FILE_TASK_CONTROLLER_PROTOCOL_VERSION = 3;

export type JsonValue =
  | null
  | boolean
  | number
  | string
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue };

export type ControllerRequest = Readonly<{
  id: string;
  token: string;
  method: string;
  params: JsonValue;
}>;

export type ControllerError = Readonly<{
  code: string;
  message: string;
}>;

export type ControllerSuccessResponse = Readonly<{
  id: string;
  ok: true;
  result: JsonValue;
}>;

export type ControllerFailureResponse = Readonly<{
  id: string;
  ok: false;
  error: ControllerError;
}>;

export type ControllerResponse = ControllerSuccessResponse | ControllerFailureResponse;

export type ControllerDiscovery = Readonly<{
  pid: number;
  processStartIdentity: string;
  socketPath: string;
  token: string;
}>;

export class ControllerProtocolError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly id = "invalid"
  ) {
    super(message);
    this.name = "ControllerProtocolError";
  }
}

export function parseControllerRequest(line: string): ControllerRequest {
  if (Buffer.byteLength(line) > MAX_CONTROLLER_MESSAGE_BYTES) {
    throw new ControllerProtocolError(
      "MESSAGE_TOO_LARGE",
      "Controller message exceeds 1 MiB."
    );
  }
  try {
    const value: unknown = JSON.parse(line);
    if (!isRecord(value) || !hasExactKeys(value, ["id", "token", "method", "params"])) {
      throw new Error("shape");
    }
    if (
      !isIdentifier(value.id)
      || typeof value.token !== "string"
      || !/^[a-f0-9]{64}$/u.test(value.token)
      || typeof value.method !== "string"
      || value.method.length > 128
      || !/^[a-z][a-z0-9-]*(?:\.[a-z][a-z0-9-]*)*$/u.test(value.method)
      || !isJsonValue(value.params)
    ) {
      throw new Error("fields");
    }
    return Object.freeze({
      id: value.id,
      token: value.token,
      method: value.method,
      params: value.params
    });
  } catch (error) {
    if (error instanceof ControllerProtocolError) throw error;
    throw new ControllerProtocolError("INVALID_REQUEST", "Invalid controller request.");
  }
}

export function parseControllerResponse(
  line: string,
  expectedId: string
): ControllerResponse {
  if (Buffer.byteLength(line) > MAX_CONTROLLER_MESSAGE_BYTES) {
    throw invalidResponse();
  }
  try {
    const value: unknown = JSON.parse(line);
    if (!isRecord(value) || value.id !== expectedId || !isIdentifier(value.id)) {
      throw new Error("identity");
    }
    if (value.ok === true) {
      if (!hasExactKeys(value, ["id", "ok", "result"]) || !isJsonValue(value.result)) {
        throw new Error("success");
      }
      return Object.freeze({ id: value.id, ok: true, result: value.result });
    }
    if (
      value.ok !== false
      || !hasExactKeys(value, ["id", "ok", "error"])
      || !isRecord(value.error)
      || !hasExactKeys(value.error, ["code", "message"])
      || typeof value.error.code !== "string"
      || !/^[A-Z][A-Z0-9_]{0,63}$/u.test(value.error.code)
      || typeof value.error.message !== "string"
      || value.error.message.length === 0
      || value.error.message.length > 512
    ) {
      throw new Error("failure");
    }
    return Object.freeze({
      id: value.id,
      ok: false,
      error: Object.freeze({ code: value.error.code, message: value.error.message })
    });
  } catch {
    throw invalidResponse();
  }
}

export function encodeControllerRequest(request: ControllerRequest): string {
  const line = JSON.stringify(request);
  parseControllerRequest(line);
  return appendNewline(line);
}

export function encodeControllerResponse(response: ControllerResponse): string {
  const line = JSON.stringify(response);
  parseControllerResponse(line, response.id);
  return appendNewline(line);
}

export function controllerFailure(
  id: string,
  code: string,
  message: string
): ControllerFailureResponse {
  return Object.freeze({
    id,
    ok: false,
    error: Object.freeze({ code, message })
  });
}

export function parseControllerDiscovery(
  value: unknown,
  expectedSocketPath: string
): ControllerDiscovery {
  if (
    !isRecord(value)
    || !hasExactKeys(value, ["pid", "processStartIdentity", "socketPath", "token"])
    || !Number.isSafeInteger(value.pid)
    || (value.pid as number) < 1
    || typeof value.processStartIdentity !== "string"
    || !/^[0-9]{1,32}$/u.test(value.processStartIdentity)
    || value.socketPath !== expectedSocketPath
    || typeof value.token !== "string"
    || !/^[a-f0-9]{64}$/u.test(value.token)
  ) {
    throw new ControllerProtocolError(
      "CONTROLLER_DISCOVERY_INVALID",
      "Controller discovery is invalid."
    );
  }
  return Object.freeze({
    pid: value.pid as number,
    processStartIdentity: value.processStartIdentity,
    socketPath: value.socketPath,
    token: value.token
  });
}

export function isEmptyParams(value: JsonValue): boolean {
  return isRecord(value) && Reflect.ownKeys(value).length === 0;
}

function appendNewline(line: string): string {
  if (Buffer.byteLength(line) > MAX_CONTROLLER_MESSAGE_BYTES) {
    throw new ControllerProtocolError(
      "MESSAGE_TOO_LARGE",
      "Controller message exceeds 1 MiB."
    );
  }
  return `${line}\n`;
}

function invalidResponse(): ControllerProtocolError {
  return new ControllerProtocolError(
    "INVALID_RESPONSE",
    "Controller response is invalid."
  );
}

function isIdentifier(value: unknown): value is string {
  return typeof value === "string"
    && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(
  value: Readonly<Record<string, unknown>>,
  keys: readonly string[]
): boolean {
  const actual = Reflect.ownKeys(value);
  return actual.length === keys.length
    && actual.every((key) => typeof key === "string")
    && keys.every((key) => Object.hasOwn(value, key));
}

function isJsonValue(value: unknown): value is JsonValue {
  const pending: unknown[] = [value];
  const seen = new Set<object>();
  while (pending.length > 0) {
    const current = pending.pop();
    if (
      current === null
      || typeof current === "string"
      || typeof current === "boolean"
    ) {
      continue;
    }
    if (typeof current === "number") {
      if (!Number.isFinite(current)) return false;
      continue;
    }
    if (typeof current !== "object") return false;
    if (seen.has(current)) return false;
    seen.add(current);
    if (Array.isArray(current)) {
      pending.push(...current);
      continue;
    }
    const prototype = Object.getPrototypeOf(current);
    if (prototype !== Object.prototype && prototype !== null) return false;
    pending.push(...Object.values(current));
  }
  return true;
}
