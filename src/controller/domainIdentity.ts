import { createHash, randomBytes } from "node:crypto";
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
  type Stats
} from "node:fs";
import { dirname, join, resolve } from "node:path";

/** Durable identity written by an isolated integration-test runtime. */
export const CONTROLLER_DOMAIN_PATH = "runtime/domain.json";
export const EPHEMERAL_DOMAIN_GRACE_MS = 1_000;

export const EPHEMERAL_DOMAIN_ENVIRONMENT_NAMES = [
  "YUI_EPHEMERAL_DOMAIN",
  "YUI_EPHEMERAL_TOKEN",
  "YUI_EPHEMERAL_HOST_PID",
  "YUI_EPHEMERAL_HOST_START_IDENTITY",
  "YUI_EPHEMERAL_TMUX_SERVER",
  "YUI_EPHEMERAL_TMUX_TARGETS",
  "YUI_EPHEMERAL_CREATED_AT"
] as const;

export type EphemeralDomainIdentity = Readonly<{
  schemaVersion: 1;
  domainKind: "ephemeral-test";
  /** Explicit test marker; an absent marker is never cleanup authority. */
  test: true;
  token: string;
  hostPid: number;
  hostProcessStartIdentity: string;
  tmuxServer: string;
  tmuxTargets: readonly string[];
  createdAt: string;
}>;

export type DomainIdentityRead = Readonly<{
  status: "absent" | "valid" | "invalid";
  identity?: EphemeralDomainIdentity;
  fingerprint?: string;
}>;

export type EphemeralDomainIdentityOptions = Readonly<{
  token?: string;
  hostPid?: number;
  hostProcessStartIdentity?: string;
  tmuxServer: string;
  tmuxTargets?: readonly string[];
  createdAt?: Date;
}>;

/**
 * Creates the one durable identity used to fence a disposable test domain.
 * The host process is the test runner, not the detached Controller child.
 */
export function createEphemeralDomainIdentity(
  options: EphemeralDomainIdentityOptions
): EphemeralDomainIdentity {
  const hostPid = options.hostPid ?? process.pid;
  const hostProcessStartIdentity = options.hostProcessStartIdentity
    ?? readLinuxProcessStartIdentity(hostPid);
  if (hostProcessStartIdentity === undefined) {
    throw new Error(`Cannot read Linux process start identity for host PID ${hostPid}.`);
  }
  const token = options.token ?? randomBytes(32).toString("hex");
  const identity: EphemeralDomainIdentity = {
    schemaVersion: 1,
    domainKind: "ephemeral-test",
    test: true,
    token,
    hostPid,
    hostProcessStartIdentity,
    tmuxServer: options.tmuxServer,
    tmuxTargets: [...(options.tmuxTargets ?? [])],
    createdAt: (options.createdAt ?? new Date()).toISOString()
  };
  validateEphemeralDomainIdentity(identity);
  return Object.freeze(identity);
}

/** Converts identity facts to the narrowly allow-listed Controller env. */
export function ephemeralDomainEnvironment(
  identity: EphemeralDomainIdentity
): NodeJS.ProcessEnv {
  validateEphemeralDomainIdentity(identity);
  return {
    YUI_EPHEMERAL_DOMAIN: "1",
    YUI_EPHEMERAL_TOKEN: identity.token,
    YUI_EPHEMERAL_HOST_PID: String(identity.hostPid),
    YUI_EPHEMERAL_HOST_START_IDENTITY: identity.hostProcessStartIdentity,
    YUI_EPHEMERAL_TMUX_SERVER: identity.tmuxServer,
    YUI_EPHEMERAL_TMUX_TARGETS: JSON.stringify(identity.tmuxTargets),
    YUI_EPHEMERAL_CREATED_AT: identity.createdAt
  };
}

/** Parses the isolated-runtime marker inherited by a detached Controller. */
export function ephemeralDomainFromEnvironment(
  environment: NodeJS.ProcessEnv
): EphemeralDomainIdentity | undefined {
  const marker = environment.YUI_EPHEMERAL_DOMAIN;
  const values = EPHEMERAL_DOMAIN_ENVIRONMENT_NAMES.map((name) => environment[name]);
  if (values.every((value) => value === undefined)) return undefined;
  if (marker !== "1") throw new Error("YUI ephemeral domain marker is invalid.");
  const hostPid = Number(environment.YUI_EPHEMERAL_HOST_PID);
  const targets = parseTargets(environment.YUI_EPHEMERAL_TMUX_TARGETS);
  const identity: EphemeralDomainIdentity = {
    schemaVersion: 1,
    domainKind: "ephemeral-test",
    test: true,
    token: environment.YUI_EPHEMERAL_TOKEN ?? "",
    hostPid,
    hostProcessStartIdentity: environment.YUI_EPHEMERAL_HOST_START_IDENTITY ?? "",
    tmuxServer: environment.YUI_EPHEMERAL_TMUX_SERVER ?? "",
    tmuxTargets: targets,
    createdAt: environment.YUI_EPHEMERAL_CREATED_AT ?? ""
  };
  validateEphemeralDomainIdentity(identity);
  return Object.freeze(identity);
}

/** Writes identity with the same restrictive permissions as Controller discovery. */
export function writeEphemeralDomainIdentity(
  home: string,
  identity: EphemeralDomainIdentity
): void {
  validateEphemeralDomainIdentity(identity);
  const path = domainIdentityPath(home);
  const directory = dirname(path);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  chmodSync(directory, 0o700);
  const temporary = `${path}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`;
  try {
    writeFileSync(temporary, `${JSON.stringify(identity)}\n`, {
      flag: "wx",
      mode: 0o600
    });
    chmodSync(temporary, 0o600);
    renameSync(temporary, path);
  } catch (error) {
    rmSync(temporary, { force: true });
    throw error;
  }
}

export function readEphemeralDomainIdentity(home: string): DomainIdentityRead {
  const path = domainIdentityPath(home);
  let metadata: Stats;
  try {
    metadata = lstatSync(path);
  } catch (error) {
    if (isNodeCode(error, "ENOENT")) return { status: "absent" };
    return { status: "invalid" };
  }
  try {
    if (!metadata.isFile() || metadata.isSymbolicLink() || (metadata.mode & 0o077) !== 0) {
      return { status: "invalid", fingerprint: statFingerprint(metadata) };
    }
    const identity = JSON.parse(readFileSync(path, "utf8")) as unknown;
    validateEphemeralDomainIdentity(identity);
    return {
      status: "valid",
      identity,
      fingerprint: statFingerprint(metadata)
    };
  } catch {
    return { status: "invalid", fingerprint: statFingerprint(metadata) };
  }
}

/** Removes only the identity owned by this Controller generation. */
export function removeEphemeralDomainIdentity(
  home: string,
  token: string
): void {
  const path = domainIdentityPath(home);
  const current = readEphemeralDomainIdentity(home);
  if (current.status !== "valid" || current.identity?.token !== token) return;
  rmSync(path, { force: true });
}

export function domainIdentityPath(home: string): string {
  return join(resolve(home), CONTROLLER_DOMAIN_PATH);
}

export function readLinuxProcessStartIdentity(pid: number): string | undefined {
  if (!Number.isSafeInteger(pid) || pid <= 0) return undefined;
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const closing = stat.lastIndexOf(")");
    if (closing < 0) return undefined;
    const identity = stat.slice(closing + 1).trim().split(/\s+/u)[19];
    return identity !== undefined && /^[0-9]{1,32}$/u.test(identity)
      ? identity
      : undefined;
  } catch {
    return undefined;
  }
}

export function validateEphemeralDomainIdentity(
  value: unknown
): asserts value is EphemeralDomainIdentity {
  if (
    typeof value !== "object"
    || value === null
    || Array.isArray(value)
  ) throw new Error("Ephemeral domain identity is invalid.");
  const record = value as Record<string, unknown>;
  const expected = [
    "schemaVersion",
    "domainKind",
    "test",
    "token",
    "hostPid",
    "hostProcessStartIdentity",
    "tmuxServer",
    "tmuxTargets",
    "createdAt"
  ];
  if (
    Object.keys(record).length !== expected.length
    || expected.some((key) => !Object.hasOwn(record, key))
    || record.schemaVersion !== 1
    || record.domainKind !== "ephemeral-test"
    || record.test !== true
    || typeof record.token !== "string"
    || !/^[a-f0-9]{64}$/u.test(record.token)
    || !Number.isSafeInteger(record.hostPid)
    || (record.hostPid as number) <= 0
    || typeof record.hostProcessStartIdentity !== "string"
    || !/^[0-9]{1,32}$/u.test(record.hostProcessStartIdentity)
    || typeof record.tmuxServer !== "string"
    || !/^yui-[a-f0-9]{24}$/u.test(record.tmuxServer)
    || !Array.isArray(record.tmuxTargets)
    || record.tmuxTargets.some((target) => (
      typeof target !== "string"
      || target.length === 0
      || target.length > 256
      || target.includes("\0")
    ))
    || typeof record.createdAt !== "string"
    || !Number.isFinite(Date.parse(record.createdAt))
  ) throw new Error("Ephemeral domain identity is invalid.");
}

function parseTargets(value: string | undefined): readonly string[] {
  if (value === undefined) throw new Error("Ephemeral tmux target identity is missing.");
  const parsed: unknown = JSON.parse(value);
  if (!Array.isArray(parsed)) throw new Error("Ephemeral tmux target identity is invalid.");
  return parsed as string[];
}

function statFingerprint(metadata: Stats): string {
  return [
    metadata.dev,
    metadata.ino,
    metadata.mode,
    metadata.size,
    Math.trunc(metadata.mtimeMs)
  ].join(":");
}

function isNodeCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}

// Keep this import-free helper usable by test fixtures without requiring tmux.
export function defaultEphemeralTmuxServer(home: string): string {
  return `yui-${createHash("sha256").update(resolve(home)).digest("hex").slice(0, 24)}`;
}
