import { resolve } from "node:path";

import { callController as defaultCallController } from "../core/controllerClient.js";
import type { JsonValue } from "../core/protocol.js";
import {
  inspectStorageSchema,
  type StorageSchemaState
} from "../storage/storageSchema.js";
import {
  yuiVersionIdentity,
  type YuiVersionIdentity
} from "../version.js";

export type RuntimeCoherenceOptions = Readonly<{
  identity?: YuiVersionIdentity;
  inspectStorage?: (home: string) => StorageSchemaState | Readonly<{
    status: string;
    currentVersion?: number;
    direction?: "older" | "newer";
  }>;
  callController?: (
    home: string,
    method: string,
    params: JsonValue
  ) => Promise<JsonValue>;
  checkController?: boolean;
}>;

export type RuntimeCoherenceInput = Readonly<{
  actualHome: string;
}>;

export async function assertRuntimeCoherence(
  input: RuntimeCoherenceInput,
  options: RuntimeCoherenceOptions = {}
): Promise<YuiVersionIdentity> {
  const home = resolve(input.actualHome);
  const identity = validateVersionIdentity(options.identity ?? yuiVersionIdentity());
  const storage = (options.inspectStorage ?? inspectStorageSchema)(home);
  if (storage.status !== "current") {
    throw new Error(`Managed control-plane storage is not current: ${storage.status}.`);
  }
  if (storage.currentVersion !== identity.storageVersion) {
    throw new Error(
      "Managed control-plane storage version is incompatible "
        + `(expected ${identity.storageVersion}, found `
        + `${storage.currentVersion ?? "unknown"}).`
    );
  }
  if (options.checkController !== false) {
    const call = options.callController ?? defaultCallController;
    try {
      const status = await call(home, "controller.status", {});
      assertControllerContinuityIdentity(status, identity);
    } catch (error) {
      if (!isDefinitelyNotRunning(error)) throw error;
    }
  }
  return identity;
}

export function assertControllerStatusIdentity(
  status: JsonValue,
  expected: YuiVersionIdentity = yuiVersionIdentity()
): void {
  if (!isRecord(status) || status.running !== true) {
    throw new Error("Controller status does not describe a running Controller.");
  }
  assertControllerField(
    status.protocolVersion,
    expected.controllerProtocolVersion,
    "protocol"
  );
  assertControllerField(status.version, expected.version, "version");
  assertControllerField(
    status.storageVersion,
    expected.storageVersion,
    "storage version"
  );
  assertControllerField(
    status.minimumStorageVersion,
    expected.minimumStorageVersion,
    "minimum storage migration version"
  );
}

function validateVersionIdentity(value: unknown): YuiVersionIdentity {
  if (!isRecord(value)) throw new Error("Yui version identity is invalid.");
  const version = requireText(value.version, "Yui version");
  const controllerProtocolVersion = requireVersion(
    value.controllerProtocolVersion,
    "Controller protocol version"
  );
  const storageVersion = requireVersion(
    value.storageVersion,
    "Storage version"
  );
  const minimumStorageVersion = requireVersion(
    value.minimumStorageVersion,
    "Minimum storage migration version"
  );
  if (minimumStorageVersion > storageVersion) {
    throw new Error(
      "Minimum storage migration version cannot exceed the current storage version."
    );
  }
  return {
    version,
    controllerProtocolVersion,
    storageVersion,
    minimumStorageVersion
  };
}

function assertControllerContinuityIdentity(
  status: JsonValue,
  expected: YuiVersionIdentity
): void {
  if (!isRecord(status) || status.running !== true) {
    throw new Error("Controller status does not describe a running Controller.");
  }
  if (typeof status.version !== "string" || status.version.trim().length === 0) {
    throw new Error("Controller version is invalid at the managed continuity gate.");
  }
  assertControllerField(
    status.protocolVersion,
    expected.controllerProtocolVersion,
    "protocol"
  );
  assertControllerField(
    status.storageVersion,
    expected.storageVersion,
    "storage version"
  );
}

function assertControllerField(
  actual: unknown,
  expected: string | number,
  label: string
): void {
  if (actual !== expected) {
    throw new Error(
      `Controller ${label} is incompatible with the exact control plane `
        + `(expected ${expected}, found ${typeof actual === "string" || typeof actual === "number" ? actual : "unknown"}). `
        + "Run controller restart through the matching exact control-plane invocation "
        + "before writing new Task records."
    );
  }
}

function requireText(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0 || value.includes("\0")) {
    throw new Error(`${label} is invalid.`);
  }
  return value;
}

function requireVersion(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    throw new Error(`${label} is invalid.`);
  }
  return value as number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isDefinitelyNotRunning(error: unknown): boolean {
  return isRecord(error) && error.code === "CONTROLLER_NOT_RUNNING";
}
