import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
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

export const EXACT_CONTROL_ARGUMENT = "--yui-control";
export const YUI_CONTROL_PLANE_DESCRIPTOR = "YUI_CONTROL_PLANE_DESCRIPTOR";

export type ExactControlPlaneDescriptor = Readonly<{
  schemaVersion: 1;
  kind: "yui-control-plane";
  executable: string;
  cliEntry: string;
  yuiHome: string;
  identity: YuiVersionIdentity;
  /**
   * Issue 02: the release build ID this control plane runs. Present when the
   * Controller runs from an installed release; absent for a dev checkout.
   * When present, the preflight gates on the Home's active release pointer.
   */
  buildId?: string;
  /** Package SHA-256 of the active release, when known. */
  activeReleaseDigest?: string;
}>;

export type ExactControlPlanePreflightInput = Readonly<{
  serializedDescriptor: string;
  digest: string;
  actualExecutable: string;
  actualCliEntry: string;
  actualHome: string;
}>;

export type ExactControlPlanePreflightOptions = Readonly<{
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

export type CompatibleControlPlanePreflightInput = Readonly<{
  actualHome: string;
}>;

export function createExactControlPlaneDescriptor(input: Readonly<{
  executable: string;
  cliEntry: string;
  yuiHome: string;
  identity?: YuiVersionIdentity;
  buildId?: string;
  activeReleaseDigest?: string;
}>): ExactControlPlaneDescriptor {
  const identity = validateVersionIdentity(input.identity ?? yuiVersionIdentity());
  return Object.freeze({
    schemaVersion: 1,
    kind: "yui-control-plane",
    executable: canonicalPath(input.executable),
    cliEntry: canonicalPath(input.cliEntry),
    yuiHome: canonicalPath(input.yuiHome),
    identity: Object.freeze({ ...identity }),
    ...(input.buildId === undefined ? {} : { buildId: input.buildId }),
    ...(input.activeReleaseDigest === undefined
      ? {}
      : { activeReleaseDigest: input.activeReleaseDigest })
  });
}

export function serializeExactDescriptor(
  descriptor: ExactControlPlaneDescriptor
): string {
  return JSON.stringify(descriptor);
}

export function parseExactControlPlaneDescriptor(value: string): ExactControlPlaneDescriptor {
  const record = parseDescriptorRecord(value);
  assertDescriptorKind(record, "yui-control-plane");
  if (record.schemaVersion !== 1) {
    throw new Error("Exact control-plane descriptor schema version is invalid.");
  }
  return createExactControlPlaneDescriptor({
    executable: requireText(record.executable, "Control-plane executable"),
    cliEntry: requireText(record.cliEntry, "Control-plane CLI entry"),
    yuiHome: requireText(record.yuiHome, "Control-plane YUI_HOME"),
    identity: validateVersionIdentity(record.identity),
    ...(typeof record.buildId !== "string" ? {} : { buildId: record.buildId }),
    ...(typeof record.activeReleaseDigest !== "string"
      ? {}
      : { activeReleaseDigest: record.activeReleaseDigest })
  });
}

export function exactControlPlaneDigest(descriptor: ExactControlPlaneDescriptor): string {
  return createHash("sha256").update(serializeExactDescriptor(descriptor)).digest("hex");
}

export function exactControlPlaneCommandPrefix(
  descriptor: ExactControlPlaneDescriptor
): string {
  return [
    descriptor.executable,
    descriptor.cliEntry,
    EXACT_CONTROL_ARGUMENT,
    exactControlPlaneDigest(descriptor)
  ].map(shellQuote).join(" ");
}

export function extractExactControlArgument(args: readonly string[]): Readonly<{
  digest?: string;
  args: readonly string[];
  error?: string;
}> {
  const later = args.indexOf(EXACT_CONTROL_ARGUMENT);
  if (later < 0) return { args: [...args] };
  if (later !== 0) {
    return {
      args: [...args],
      error: `${EXACT_CONTROL_ARGUMENT} must be the first CLI argument.`
    };
  }
  const digest = args[1];
  if (digest === undefined || !/^[a-f0-9]{64}$/u.test(digest)) {
    return {
      args: args.slice(2),
      error: "Exact control-plane digest is invalid."
    };
  }
  return { digest, args: args.slice(2) };
}

/**
 * One read-only gate shared by every managed Task control command. It verifies
 * the frozen executable/CLI/Home/digest, protocol and storage identity,
 * on-disk schema, and any live Controller before command routing may construct
 * a writable store. Package version alone may advance at the same managed path
 * so an existing Session can cross an explicitly compatible in-place update.
 */
export async function assertExactControlPlanePreflight(
  input: ExactControlPlanePreflightInput,
  options: ExactControlPlanePreflightOptions = {}
): Promise<ExactControlPlaneDescriptor> {
  const descriptor = parseExactControlPlaneDescriptor(input.serializedDescriptor);
  if (exactControlPlaneDigest(descriptor) !== requireDigest(input.digest)) {
    throw new Error("Exact control-plane digest does not match its frozen descriptor.");
  }
  assertSamePath(
    descriptor.executable,
    input.actualExecutable,
    "Control-plane executable"
  );
  assertSamePath(descriptor.cliEntry, input.actualCliEntry, "Control-plane CLI entry");
  assertSamePath(descriptor.yuiHome, input.actualHome, "Control-plane YUI_HOME");

  const localIdentity = validateVersionIdentity(options.identity ?? yuiVersionIdentity());
  assertContinuityIdentity("Local CLI", descriptor.identity, localIdentity);
  const storage = (options.inspectStorage ?? inspectStorageSchema)(descriptor.yuiHome);
  if (storage.status !== "current") {
    throw new Error(`Exact control-plane storage is not current: ${storage.status}.`);
  }
  if (storage.currentVersion !== descriptor.identity.storageVersion) {
    throw new Error(
      "Exact control-plane storage version does not match its frozen descriptor "
        + `(expected ${descriptor.identity.storageVersion}, found `
        + `${storage.currentVersion ?? "unknown"}).`
    );
  }

  // A frozen descriptor authenticates the command that created it; it no
  // longer pins the Home's deployment pointer for the lifetime of a Session.
  // Continuity is the protocol/storage contract checked above and the durable
  // Task/Role/Turn identity checked below. This lets a compatible Controller or
  // active release advance without invalidating a still-current Session.

  if (options.checkController !== false) {
    const call = options.callController ?? defaultCallController;
    try {
      const status = await call(descriptor.yuiHome, "controller.status", {});
      assertControllerContinuityIdentity(status, descriptor.identity);
    } catch (error) {
      if (!isDefinitelyNotRunning(error)) throw error;
    }
  }
  return descriptor;
}

/**
 * Compatibility gate for an ordinary `yui` invocation inside a managed
 * Session. The Session Manifest and durable runtime state authenticate the
 * actor separately; this gate proves that the current CLI can safely share the
 * Home with its storage and Controller without pinning package/build identity.
 */
export async function assertCompatibleControlPlanePreflight(
  input: CompatibleControlPlanePreflightInput,
  options: ExactControlPlanePreflightOptions = {}
): Promise<YuiVersionIdentity> {
  const home = canonicalPath(input.actualHome);
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

/** Managed continuity is a protocol/storage contract, not a package pin. */
function assertContinuityIdentity(
  label: string,
  expected: YuiVersionIdentity,
  actual: YuiVersionIdentity
): void {
  for (const field of [
    "controllerProtocolVersion",
    "storageVersion"
  ] as const) {
    if (expected[field] !== actual[field]) {
      throw new Error(
        `${label} ${field} does not match the frozen control plane `
          + `(expected ${expected[field]}, found ${actual[field]}).`
      );
    }
  }
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

function assertSamePath(expected: string, actual: string, label: string): void {
  const normalized = canonicalPath(actual);
  if (expected !== normalized) {
    throw new Error(`${label} does not match the frozen control plane (expected ${expected}, found ${normalized}).`);
  }
}

function parseDescriptorRecord(value: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(requireText(value, "Exact descriptor"));
  } catch (error) {
    throw new Error("Exact descriptor is not valid JSON.", { cause: error });
  }
  if (!isRecord(parsed)) throw new Error("Exact descriptor must be an object.");
  return parsed;
}

function assertDescriptorKind(
  value: Record<string, unknown>,
  expected: ExactControlPlaneDescriptor["kind"]
): void {
  if (value.kind !== expected) {
    throw new Error(
      `Exact descriptor kind is invalid: expected ${expected}, found `
        + `${typeof value.kind === "string" ? value.kind : "unknown"}.`
    );
  }
}

function requireText(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0 || value.includes("\0")) {
    throw new Error(`${label} is invalid.`);
  }
  return value;
}

function requireDigest(value: unknown): string {
  const digest = requireText(value, "Control-plane digest");
  if (!/^[a-f0-9]{64}$/u.test(digest)) {
    throw new Error("Control-plane digest is invalid.");
  }
  return digest;
}

function requireVersion(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    throw new Error(`${label} is invalid.`);
  }
  return value as number;
}

function canonicalPath(value: string): string {
  const absolute = resolve(requireText(value, "Path"));
  try {
    return realpathSync(absolute);
  } catch {
    return absolute;
  }
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\"'\"'")}'`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isDefinitelyNotRunning(error: unknown): boolean {
  return isRecord(error) && error.code === "CONTROLLER_NOT_RUNNING";
}
