import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmdirSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import type { RoleStatus } from "../role/role.js";
import type { Role } from "../role/role.js";
import type { AgentLaunchPlan } from "../executor/launchPlan.js";
import { CommandExecutionError, type CommandExecutor } from "./commandExecutor.js";

const CARRIER_REGISTRY_PREFIX = ".taskmux-launch-carriers-";
const PENDING_CARRIER_PREFIX = ".pending-launch-";
const PENDING_CARRIER_DIRECTORY = new RegExp(`^${PENDING_CARRIER_PREFIX}[a-f0-9-]{36}$`);
const CARRIER_SCRIPT_NAME = "launch.sh";
const CARRIER_ACK_NAME = "ack";
const CARRIER_OWNER_NAME = "owner.json";
const MAX_CARRIER_OWNER_BYTES = 256;
const CARRIER_ACK_TIMEOUT_MS = 2_000;
const CARRIER_ACK_POLL_MS = 10;

export class TmuxManager {
  constructor(
    private readonly tmuxBin: string,
    private readonly executor: CommandExecutor,
    private readonly taskmuxHome: string
  ) {
    sweepPendingLaunchCarriers(taskmuxHome);
  }

  enterRole(
    taskId: string,
    role: Role,
    launch?: AgentLaunchPlan,
    options: LaunchCallbacks = {}
  ): void {
    this.ensureRoleWindow(taskId, role, launch, options);
    this.attachRole(taskId, role.name);
  }

  ensureRoleWindow(
    taskId: string,
    role: Role,
    launch?: AgentLaunchPlan,
    options: LaunchCallbacks = {}
  ): boolean {
    this.ensureSession(taskId);
    const launchToken = options.launchToken ?? randomUUID();
    let created = false;
    try {
      created = this.ensureWindow(taskId, role, launch, launchToken);
      if (created) options.onStarted?.();
    } catch (error) {
      this.failCreatedLaunch(taskId, role.name, launchToken, created, options);
      throw error;
    }
    return created;
  }

  attachRole(taskId: string, roleName: string): void {
    this.executor.run(this.tmuxBin, ["attach-session", "-t", this.target(taskId, roleName)], {
      inheritStdio: true
    });
  }

  captureRole(taskId: string, roleName: string, lines = 80): string {
    return this.executor.run(this.tmuxBin, [
      "capture-pane",
      "-p",
      "-t",
      this.target(taskId, roleName),
      "-S",
      `-${lines}`
    ]);
  }

  dispatchRole(
    taskId: string,
    role: Role,
    launch: AgentLaunchPlan,
    input: string,
    options: { replaceExisting?: boolean; launchToken: string } & LaunchCallbacks
  ): boolean {
    this.ensureSession(taskId);
    let created = false;
    try {
      if (options.replaceExisting === true) {
        try {
          this.killRole(taskId, role.name);
        } catch {
          // A new session can also be the first session for this role.
        }
        this.createWindow(taskId, role, launch, options.launchToken);
        created = true;
      } else {
        created = this.ensureWindow(taskId, role, launch, options.launchToken);
      }
      if (created) options.onStarted?.();
      this.sendRoleInput(taskId, role.name, input);
      return created;
    } catch (error) {
      this.failCreatedLaunch(taskId, role.name, options.launchToken, created, options);
      throw error;
    }
  }

  sendRoleInput(taskId: string, roleName: string, input: string): void {
    this.executor.run(this.tmuxBin, ["send-keys", "-l", "-t", this.target(taskId, roleName), "--", input]);
    this.executor.run(this.tmuxBin, ["send-keys", "-t", this.target(taskId, roleName), "Enter"]);
  }

  detachRole(taskId: string): void {
    this.executor.run(this.tmuxBin, ["detach-client", "-s", this.sessionName(taskId)]);
  }

  restartRole(taskId: string, role: Role, launch: AgentLaunchPlan): void {
    try {
      this.killRole(taskId, role.name);
    } catch {
      // Restart must recover even when the old window is already gone.
    }

    this.enterRole(taskId, role, launch);
  }

  detectRoleStatus(taskId: string, roleName: string, fallback: RoleStatus): RoleStatus {
    try {
      return this.probeRoleStatus(taskId, roleName);
    } catch {
      return fallback;
    }
  }

  probeRoleStatus(taskId: string, roleName: string): "running" | "exited" {
    try {
      this.executor.run(this.tmuxBin, ["has-session", "-t", this.sessionName(taskId)]);
    } catch (sessionError) {
      if (isExplicitlyAbsentTmuxSession(sessionError)) return "exited";
      throw sessionError;
    }
    const windows = this.executor.run(this.tmuxBin, [
      "list-windows",
      "-t",
      this.sessionName(taskId),
      "-F",
      "#{window_name}"
    ]);
    return windows.split("\n").includes(roleName) ? "running" : "exited";
  }

  killRoleAndConfirmStopped(taskId: string, roleName: string): void {
    if (this.probeRoleStatus(taskId, roleName) === "exited") return;
    this.killRole(taskId, roleName);
    if (this.probeRoleStatus(taskId, roleName) !== "exited") {
      throw new Error(`Role native process did not stop: ${roleName}.`);
    }
  }

  roleLaunchToken(taskId: string, roleName: string): string | null {
    if (!this.windowNames(taskId).includes(roleName)) return null;
    try {
      const value = this.executor.run(this.tmuxBin, [
        "show-options",
        "-w",
        "-v",
        "-t",
        this.target(taskId, roleName),
        "@taskmux_launch_token"
      ]).trim();
      return value.length === 0 ? null : value;
    } catch (error) {
      if (!this.windowNames(taskId).includes(roleName)) return null;
      throw error;
    }
  }

  killRoleLaunchAndConfirmStopped(taskId: string, roleName: string, launchToken: string): boolean {
    if (this.roleLaunchToken(taskId, roleName) !== launchToken) return false;
    this.killRole(taskId, roleName);
    if (this.roleLaunchToken(taskId, roleName) === launchToken) {
      throw new Error(`Owned Role native process did not stop: ${roleName}.`);
    }
    return true;
  }

  stopRole(taskId: string, roleName: string): void {
    this.executor.run(this.tmuxBin, ["send-keys", "-t", this.target(taskId, roleName), "C-c"]);
  }

  stopRoleWithOperationToken(taskId: string, roleName: string, operationToken: string): void {
    if (!this.claimRoleOperationToken(taskId, roleName, operationToken)) {
      throw new Error(`Role window is not running: ${roleName}.`);
    }
    this.stopRole(taskId, roleName);
  }

  killRoleWithOperationToken(taskId: string, roleName: string, operationToken: string): void {
    if (!this.killRoleForRestartWithOperationToken(taskId, roleName, operationToken)) {
      throw new Error(`Role window is not running: ${roleName}.`);
    }
  }

  killRoleForRestartWithOperationToken(
    taskId: string,
    roleName: string,
    operationToken: string
  ): boolean {
    if (!this.claimRoleOperationToken(taskId, roleName, operationToken)) return false;
    this.killRole(taskId, roleName);
    if (this.windowNames(taskId).includes(roleName)) {
      throw new Error(`Role native process did not stop: ${roleName}.`);
    }
    return true;
  }

  killRole(taskId: string, roleName: string): void {
    this.executor.run(this.tmuxBin, ["kill-window", "-t", this.target(taskId, roleName)]);
  }

  renameRole(taskId: string, oldRoleName: string, newRoleName: string): void {
    this.executor.run(this.tmuxBin, ["rename-window", "-t", this.target(taskId, oldRoleName), newRoleName]);
  }

  renameRoleWithOperationToken(
    taskId: string,
    oldRoleName: string,
    newRoleName: string,
    operationToken: string
  ): void {
    if (!this.claimRoleOperationToken(taskId, oldRoleName, operationToken)) {
      throw new Error(`Role window is not running: ${oldRoleName}.`);
    }
    this.renameRole(taskId, oldRoleName, newRoleName);
    if (this.windowNames(taskId).includes(oldRoleName) || !this.windowNames(taskId).includes(newRoleName) ||
        this.roleOperationToken(taskId, newRoleName) !== operationToken) {
      throw new Error(`Role window rename ownership could not be confirmed: ${oldRoleName}.`);
    }
  }

  private ensureSession(taskId: string): void {
    try {
      this.executor.run(this.tmuxBin, ["has-session", "-t", this.sessionName(taskId)]);
      return;
    } catch {
      this.executor.run(this.tmuxBin, ["new-session", "-d", "-s", this.sessionName(taskId)]);
    }
  }

  private ensureWindow(
    taskId: string,
    role: Role,
    launch: AgentLaunchPlan | undefined,
    launchToken: string
  ): boolean {
    if (this.windowNames(taskId).includes(role.name)) {
      return false;
    }

    if (launch === undefined) {
      throw new Error(`Agent launch plan is required to create Role window: ${role.name}.`);
    }
    this.createWindow(taskId, role, launch, launchToken);
    return true;
  }

  private createWindow(
    taskId: string,
    role: Role,
    launch: AgentLaunchPlan,
    launchToken: string
  ): void {
    const temporaryName = launchWindowName(launchToken);
    const carrier = createLaunchCarrier(this.taskmuxHome, launch);
    const removeSignalCleanup = installCarrierSignalCleanup(carrier);
    let acknowledged = false;
    let cleanupHandled = false;
    try {
      this.executor.run(this.tmuxBin, [
        "new-window",
        "-t",
        this.sessionName(taskId),
        "-n",
        temporaryName,
        "-c",
        role.workspace,
        "/bin/sh",
        carrier.path
      ]);
      acknowledged = carrier.waitForAcknowledgement();
      if (!acknowledged) {
        throw new Error("Role launch did not acknowledge its private carrier.");
      }
      this.executor.run(this.tmuxBin, [
        "set-option",
        "-w",
        "-t",
        this.target(taskId, temporaryName),
        "@taskmux_launch_token",
        launchToken
      ]);
      this.executor.run(this.tmuxBin, [
        "rename-window",
        "-t",
        this.target(taskId, temporaryName),
        role.name
      ]);
    } catch (launchError) {
      const cleanupErrors: unknown[] = [];
      try {
        this.removeTokenNamedTemporaryWindow(taskId, temporaryName);
      } catch (error) {
        cleanupErrors.push(error);
      }
      try {
        this.killRoleLaunchAndConfirmStopped(taskId, role.name, launchToken);
      } catch (error) {
        cleanupErrors.push(error);
      }
      try {
        if (carrier.secretMayRemain()) carrier.remove();
        else carrier.removeAcknowledgedBestEffort();
      } catch (error) {
        cleanupErrors.push(error);
      }
      cleanupHandled = true;
      if (cleanupErrors.length > 0) {
        throw new AggregateError(
          [launchError, ...cleanupErrors],
          `Role window creation failed and cleanup could not be confirmed: ${role.name}.`
        );
      }
      throw launchError;
    } finally {
      try {
        if (acknowledged) {
          carrier.removeAcknowledgedBestEffort();
        } else if (!cleanupHandled) {
          carrier.remove();
        }
      } finally {
        removeSignalCleanup();
      }
    }
  }

  private failCreatedLaunch(
    taskId: string,
    roleName: string,
    launchToken: string,
    created: boolean,
    options: LaunchCallbacks
  ): void {
    if (!created) return;
    this.killRoleLaunchAndConfirmStopped(taskId, roleName, launchToken);
    options.onLaunchFailed?.();
  }

  private removeTokenNamedTemporaryWindow(taskId: string, temporaryName: string): void {
    if (!this.windowNames(taskId).includes(temporaryName)) return;
    this.executor.run(this.tmuxBin, ["kill-window", "-t", this.target(taskId, temporaryName)]);
    if (this.windowNames(taskId).includes(temporaryName)) {
      throw new Error(`Temporary Role launch window did not stop: ${temporaryName}.`);
    }
  }

  private claimRoleOperationToken(taskId: string, roleName: string, operationToken: string): boolean {
    if (!this.windowNames(taskId).includes(roleName)) return false;
    try {
      this.executor.run(this.tmuxBin, [
        "set-option",
        "-w",
        "-t",
        this.target(taskId, roleName),
        "@taskmux_operation_token",
        operationToken
      ]);
    } catch (error) {
      if (this.roleOperationToken(taskId, roleName) !== operationToken) throw error;
    }
    if (this.roleOperationToken(taskId, roleName) !== operationToken) {
      throw new Error(`Role window operation ownership could not be confirmed: ${roleName}.`);
    }
    return true;
  }

  roleOperationToken(taskId: string, roleName: string): string | null {
    if (!this.windowNames(taskId).includes(roleName)) return null;
    return this.executor.run(this.tmuxBin, [
      "show-options",
      "-w",
      "-q",
      "-v",
      "-t",
      this.target(taskId, roleName),
      "@taskmux_operation_token"
    ]).trim() || null;
  }

  private windowNames(taskId: string): string[] {
    return this.executor.run(this.tmuxBin, [
      "list-windows",
      "-t",
      this.sessionName(taskId),
      "-F",
      "#{window_name}"
    ]).split("\n").filter((name) => name.length > 0);
  }

  private sessionName(taskId: string): string {
    return taskmuxTmuxSessionName(this.taskmuxHome, taskId);
  }

  private target(taskId: string, roleName: string): string {
    return `${this.sessionName(taskId)}:${roleName}`;
  }
}

type LaunchCallbacks = {
  launchToken?: string;
  onStarted?: () => void;
  onLaunchFailed?: () => void;
};

function launchWindowName(token: string): string {
  return `taskmux-launch-${token}`;
}

function isExplicitlyAbsentTmuxSession(error: unknown): boolean {
  if (error instanceof CommandExecutionError) {
    return error.code === "COMMAND_FAILED" && error.exitStatus === 1;
  }
  if (!(error instanceof Error)) return false;
  const diagnostic = "stderr" in error
    ? String(error.stderr)
    : error.message;
  return /can't find session|no server running on/i.test(diagnostic);
}

export function taskmuxTmuxSessionName(taskmuxHome: string, taskId: string): string {
  const namespace = createHash("sha256").update(resolve(taskmuxHome)).digest("hex").slice(0, 12);
  return `taskmux-${namespace}-${taskId}`;
}

export function taskmuxTmuxTarget(taskmuxHome: string, taskId: string, roleName: string): string {
  return `${taskmuxTmuxSessionName(taskmuxHome, taskId)}:${roleName}`;
}

type LaunchCarrier = {
  path: string;
  waitForAcknowledgement(): boolean;
  secretMayRemain(): boolean;
  remove(): void;
  removeAcknowledgedBestEffort(): void;
};

type PendingCarrierState = "launch-script" | "acknowledged" | "empty";

type CarrierOwner = {
  pid: number;
  startTime: string;
};

type PendingCarrier = {
  state: PendingCarrierState;
  owner: CarrierOwner;
};

type ProcessWitness =
  | { state: "alive"; startTime: string }
  | { state: "dead" }
  | { state: "unknown" };

export function launchCarrierRegistryPath(taskmuxHome: string, uid = currentUid()): string {
  const namespace = createHash("sha256").update(resolve(taskmuxHome)).digest("hex").slice(0, 24);
  return join(tmpdir(), `${carrierRegistryPrefix(uid, namespace)}${randomUUID()}`);
}

/**
 * The carrier registry tracks only short-lived secret transport files. It
 * deliberately contains no task, Role, or session authority, so startup
 * cleanup cannot create a competing runtime/session source of truth.
 */
export function sweepPendingLaunchCarriers(taskmuxHome: string): number {
  const uid = currentUid();
  const namespace = createHash("sha256").update(resolve(taskmuxHome)).digest("hex").slice(0, 24);
  const prefix = carrierRegistryPrefix(uid, namespace);
  let registryNames: string[];
  try {
    registryNames = readdirSync(tmpdir()).filter((name) =>
      name.startsWith(prefix) && /^[a-f0-9-]{36}$/.test(name.slice(prefix.length))
    );
  } catch {
    return 0;
  }
  let removed = 0;
  for (const registryName of registryNames) {
    const registry = join(tmpdir(), registryName);
    if (!isSecureDirectory(registry, 0o700)) continue;
    removed += sweepCarrierRegistry(registry);
  }
  return removed;
}

function sweepCarrierRegistry(registry: string): number {
  let removed = 0;
  let entries: string[];
  try {
    entries = readdirSync(registry);
  } catch {
    return 0;
  }
  for (const name of entries) {
    if (!PENDING_CARRIER_DIRECTORY.test(name)) continue;
    const path = join(registry, name);
    const carrier = inspectPendingCarrier(path);
    if (carrier === null || carrierOwnerLiveness(carrier.owner) !== "dead") continue;
    try {
      if (removeDeadPendingCarrier(path)) removed += 1;
    } catch {
      // Leave anything we cannot revalidate for a later startup rather than
      // traversing an untrusted path.
    }
  }
  removeEmptyCarrierRegistryBestEffort(registry);
  return removed;
}

function createLaunchCarrier(taskmuxHome: string, launch: AgentLaunchPlan): LaunchCarrier {
  const owner = currentCarrierOwner();
  let directory: string | undefined;
  let created = false;
  try {
    const registry = ensureCarrierRegistry(taskmuxHome);
    directory = join(registry, `${PENDING_CARRIER_PREFIX}${randomUUID()}`);
    mkdirSync(directory, { mode: 0o700 });
    created = true;
    chmodSync(directory, 0o700);
    const carrierDirectory = directory;
    const path = join(directory, CARRIER_SCRIPT_NAME);
    writeFileSync(join(directory, CARRIER_OWNER_NAME), `${JSON.stringify(owner)}\n`, {
      encoding: "utf8",
      mode: 0o600,
      flag: "wx"
    });
    chmodSync(join(directory, CARRIER_OWNER_NAME), 0o600);
    writeFileSync(path, renderLaunchCarrier(launch), {
      encoding: "utf8",
      mode: 0o600,
      flag: "wx"
    });
    chmodSync(path, 0o600);
    const carrier = inspectPendingCarrier(carrierDirectory);
    if (carrier?.state !== "launch-script" || !sameCarrierOwner(carrier.owner, owner)) {
      throw new Error("Role launch carrier permissions are invalid.");
    }
    return {
      path,
      waitForAcknowledgement() {
        const deadline = Date.now() + CARRIER_ACK_TIMEOUT_MS;
        while (Date.now() <= deadline) {
          if (isCarrierAcknowledged(carrierDirectory, owner)) return true;
          sleep(CARRIER_ACK_POLL_MS);
        }
        return isCarrierAcknowledged(carrierDirectory, owner);
      },
      secretMayRemain() {
        const pending = inspectPendingCarrier(carrierDirectory);
        if (pending?.state === "acknowledged" || pending?.state === "empty") return false;
        return !isPathAbsent(carrierDirectory);
      },
      remove() {
        removeOwnedPendingCarrier(carrierDirectory, owner);
        removeEmptyCarrierRegistryBestEffort(registry);
      },
      removeAcknowledgedBestEffort() {
        removeAcknowledgedCarrierBestEffort(carrierDirectory, owner);
        removeEmptyCarrierRegistryBestEffort(registry);
      }
    };
  } catch {
    if (created && directory !== undefined) {
      try {
        removeOwnedPendingCarrier(directory, owner);
      } catch {
        try {
          rmdirSync(directory);
        } catch {
          // A failed carrier creation must not traverse an invalid temporary path.
        }
      }
    }
    if (directory !== undefined) removeEmptyCarrierRegistryBestEffort(dirname(directory));
    throw new Error("Role launch could not create a private carrier.");
  }
}

function renderLaunchCarrier(launch: AgentLaunchPlan): string {
  const environment = Object.entries(launch.env)
    .map(([key, value]) => shellQuote(`${key}=${value}`));
  const command = [shellQuote(launch.command), ...launch.args.map(shellQuote)];
  return [
    "#!/bin/sh",
    "carrier_dir=${0%/*}",
    'ack_file="$carrier_dir/ack"',
    "umask 077",
    'rm -f -- "$0" || exit 125',
    '[ ! -e "$0" ] || exit 125',
    ': > "$ack_file" || exit 125',
    `exec env ${[...environment, ...command].join(" ")}`
  ].join("\n").concat("\n");
}

function ensureCarrierRegistry(taskmuxHome: string): string {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const registry = launchCarrierRegistryPath(taskmuxHome);
    let created = false;
    try {
      mkdirSync(registry, { mode: 0o700 });
      created = true;
      chmodSync(registry, 0o700);
      if (!isSecureDirectory(registry, 0o700)) throw new Error("Role launch carrier registry is invalid.");
      return registry;
    } catch (error) {
      if (isAlreadyExistsError(error)) continue;
      try {
        if (created) rmdirSync(registry);
      } catch {
        // The random registry path is removed only while it remains empty.
      }
      throw new Error("Role launch carrier registry is invalid.");
    }
  }
  throw new Error("Role launch carrier registry is invalid.");
}

function currentUid(): number {
  const uid = process.getuid?.();
  if (typeof uid !== "number" || !Number.isSafeInteger(uid) || uid < 0) {
    throw new Error("Role launch carrier ownership is unavailable.");
  }
  return uid;
}

function carrierRegistryPrefix(uid: number, namespace: string): string {
  if (!Number.isSafeInteger(uid) || uid < 0 || !/^[a-f0-9]{24}$/.test(namespace)) {
    throw new Error("Role launch carrier registry identity is invalid.");
  }
  return `${CARRIER_REGISTRY_PREFIX}${uid}-${namespace}-`;
}

function removeEmptyCarrierRegistryBestEffort(path: string): void {
  try {
    if (!isSecureDirectory(path, 0o700) || readdirSync(path).length !== 0) return;
    rmdirSync(path);
  } catch {
    // An empty registry carries no secret and a future sweep can retry.
  }
}

function removeDeadPendingCarrier(directory: string): boolean {
  const carrier = inspectPendingCarrier(directory);
  if (carrier === null || carrierOwnerLiveness(carrier.owner) !== "dead") return false;
  rmSync(directory, { recursive: true, force: false });
  return true;
}

function removeOwnedPendingCarrier(directory: string, owner: CarrierOwner): void {
  const carrier = inspectPendingCarrier(directory);
  if (carrier === null) {
    if (isPathAbsent(directory)) return;
    throw new Error("Role launch carrier cannot be removed safely.");
  }
  if (!sameCarrierOwner(carrier.owner, owner)) {
    throw new Error("Role launch carrier ownership changed unexpectedly.");
  }
  rmSync(directory, { recursive: true, force: false });
}

function removeAcknowledgedCarrierBestEffort(directory: string, owner: CarrierOwner): void {
  try {
    const carrier = inspectPendingCarrier(directory);
    if (carrier === null || !sameCarrierOwner(carrier.owner, owner)) return;
    if (carrier.state !== "acknowledged" && carrier.state !== "empty") return;
    rmSync(directory, { recursive: true, force: false });
  } catch {
    // Acknowledged carriers contain no launch secret and are swept after their
    // owner exits, so cleanup here must not turn a successful launch into a retry.
  }
}

function isCarrierAcknowledged(directory: string, owner: CarrierOwner): boolean {
  const carrier = inspectPendingCarrier(directory);
  return carrier?.state === "acknowledged" && sameCarrierOwner(carrier.owner, owner);
}

function inspectPendingCarrier(directory: string): PendingCarrier | null {
  if (!PENDING_CARRIER_DIRECTORY.test(basename(directory))) return null;
  if (!isSecureDirectory(directory, 0o700)) return null;
  let names: string[];
  try {
    names = readdirSync(directory).sort();
  } catch {
    return null;
  }
  const owner = readCarrierOwner(join(directory, CARRIER_OWNER_NAME));
  if (owner === null) return null;
  if (sameNames(names, [CARRIER_OWNER_NAME])) return { state: "empty", owner };
  if (sameNames(names, [CARRIER_SCRIPT_NAME, CARRIER_OWNER_NAME])) {
    return isSecureRegularFile(join(directory, CARRIER_SCRIPT_NAME), 0o600, false)
      ? { state: "launch-script", owner }
      : null;
  }
  if (sameNames(names, [CARRIER_ACK_NAME, CARRIER_OWNER_NAME])) {
    return isSecureRegularFile(join(directory, CARRIER_ACK_NAME), 0o600, true)
      ? { state: "acknowledged", owner }
      : null;
  }
  return null;
}

function isSecureDirectory(path: string, mode: number): boolean {
  try {
    const metadata = lstatSync(path);
    const uid = process.getuid?.();
    return typeof uid === "number" &&
      metadata.isDirectory() &&
      metadata.uid === uid &&
      (metadata.mode & 0o777) === mode;
  } catch {
    return false;
  }
}

function isSecureRegularFile(path: string, mode: number, requireEmpty: boolean): boolean {
  try {
    const metadata = lstatSync(path);
    const uid = process.getuid?.();
    return typeof uid === "number" &&
      metadata.isFile() &&
      metadata.uid === uid &&
      (metadata.mode & 0o777) === mode &&
      (!requireEmpty || metadata.size === 0);
  } catch {
    return false;
  }
}

function readCarrierOwner(path: string): CarrierOwner | null {
  if (!isSecureRegularFile(path, 0o600, false)) return null;
  try {
    if (lstatSync(path).size > MAX_CARRIER_OWNER_BYTES) return null;
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    const record = parsed as Record<string, unknown>;
    if (!sameNames(Object.keys(record).sort(), ["pid", "startTime"])) return null;
    const pid = record.pid;
    if (typeof pid !== "number" || !Number.isSafeInteger(pid) || pid <= 0) return null;
    if (typeof record.startTime !== "string" || !isCanonicalUnsignedDecimal(record.startTime)) {
      return null;
    }
    return { pid, startTime: record.startTime };
  } catch {
    return null;
  }
}

function currentCarrierOwner(): CarrierOwner {
  const witness = readProcessWitness(process.pid);
  if (witness.state !== "alive") {
    throw new Error("Role launch owner process cannot be verified.");
  }
  return { pid: process.pid, startTime: witness.startTime };
}

function carrierOwnerLiveness(owner: CarrierOwner): "alive" | "dead" | "unknown" {
  const witness = readProcessWitness(owner.pid);
  if (witness.state !== "alive") return witness.state;
  return witness.startTime === owner.startTime ? "alive" : "dead";
}

function readProcessWitness(pid: number): ProcessWitness {
  if (!Number.isSafeInteger(pid) || pid <= 0) return { state: "unknown" };
  let stat: string;
  try {
    stat = readFileSync(`/proc/${pid}/stat`, "utf8");
  } catch (error) {
    return isNotFoundError(error) ? { state: "dead" } : { state: "unknown" };
  }
  const closingParenthesis = stat.lastIndexOf(")");
  if (closingParenthesis < 0) return { state: "unknown" };
  const fields = stat.slice(closingParenthesis + 1).trim().split(/\s+/);
  const startTime = fields[19];
  if (startTime === undefined || !isCanonicalUnsignedDecimal(startTime)) {
    return { state: "unknown" };
  }
  return { state: "alive", startTime };
}

function sameCarrierOwner(left: CarrierOwner, right: CarrierOwner): boolean {
  return left.pid === right.pid && left.startTime === right.startTime;
}

function sameNames(actual: string[], expected: string[]): boolean {
  if (actual.length !== expected.length) return false;
  return actual.every((name, index) => name === expected[index]);
}

function isCanonicalUnsignedDecimal(value: string): boolean {
  return /^(0|[1-9]\d*)$/.test(value);
}

function isPathAbsent(path: string): boolean {
  try {
    lstatSync(path);
    return false;
  } catch (error) {
    return isNotFoundError(error);
  }
}

function isNotFoundError(error: unknown): boolean {
  return isNodeError(error, "ENOENT");
}

function isAlreadyExistsError(error: unknown): boolean {
  return isNodeError(error, "EEXIST");
}

function isNodeError(error: unknown, code: string): boolean {
  return typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === code;
}

function installCarrierSignalCleanup(carrier: LaunchCarrier): () => void {
  let active = true;
  const exit = () => {
    if (!active) return;
    active = false;
    try {
      if (carrier.secretMayRemain()) carrier.remove();
      else carrier.removeAcknowledgedBestEffort();
    } catch {
      // Never replace the original termination reason with a carrier path.
    }
  };
  const signals: NodeJS.Signals[] = ["SIGINT", "SIGTERM", "SIGHUP"];
  const listeners = signals.map((signal) => ({
    signal,
    listener: () => {
      exit();
      process.kill(process.pid, signal);
    }
  }));
  process.once("exit", exit);
  for (const { signal, listener } of listeners) process.once(signal, listener);
  return () => {
    active = false;
    process.removeListener("exit", exit);
    for (const { signal, listener } of listeners) process.removeListener(signal, listener);
  };
}

function sleep(milliseconds: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

function shellQuote(value: string): string {
  if (/^[A-Za-z0-9_./:=@%+,-]+$/.test(value)) {
    return value;
  }

  return `'${value.replaceAll("'", "'\\''")}'`;
}
