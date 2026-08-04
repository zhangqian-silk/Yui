#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { createConnection } from "node:net";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";

export const DEV_LAUNCHER_NAME = "yui";

const managedMarker = "# yui-local-dev: managed";
const globalBackupName = ".yui-link-original";
const globalRecoveryName = ".yui-link-recovery.json";
const legacyGlobalStateName = ".yui-link-state.json";
const registrySchemaVersion = 3;
const recoverySchemaVersion = 1;
const controllerDiscoveryName = "controller.json";
const controllerProbeTimeoutMs = 500;

export function installDevLauncher(options = {}) {
  const projectRoot = resolve(options.projectRoot ?? process.cwd());
  const outputDir = resolve(options.outputDir ?? join(projectRoot, "output", "dev"));
  const binDir = join(outputDir, "bin");
  const launcherPath = join(binDir, DEV_LAUNCHER_NAME);
  const yuiHome = join(outputDir, "home");

  assertCanReplace(launcherPath);
  mkdirSync(binDir, { recursive: true });
  writeFileSync(launcherPath, renderLauncher({ projectRoot, binDir, yuiHome }), { mode: 0o755 });
  chmodSync(launcherPath, 0o755);

  return { launcherPath, projectRoot, outputDir, binDir, yuiHome };
}

export function uninstallDevLauncher(options = {}) {
  const projectRoot = resolve(options.projectRoot ?? process.cwd());
  const outputDir = resolve(options.outputDir ?? join(projectRoot, "output", "dev"));
  const launcherPath = join(outputDir, "bin", DEV_LAUNCHER_NAME);
  const existing = inspectManagedFile(launcherPath);

  if (existing !== null && !existing.managed) {
    throw new Error(`Refusing to remove a file not managed by this checkout: ${launcherPath}`);
  }
  if (existing !== null) rmSync(launcherPath);
  return { launcherPath, removed: existing !== null };
}

export async function linkDevLauncher(options = {}) {
  const projectRoot = resolve(options.projectRoot ?? process.cwd());
  const outputDir = resolve(options.outputDir ?? join(projectRoot, "output", "dev"));
  const yuiHome = join(outputDir, "home");
  await assertCompatibleDevHome(yuiHome);
  const local = installDevLauncher({ projectRoot, outputDir });
  const globalBinDir = resolve(options.globalBinDir ?? resolveNpmGlobalBinDir());
  const globalLauncherPath = join(globalBinDir, DEV_LAUNCHER_NAME);
  const backupPath = join(globalBinDir, globalBackupName);
  const statePath = resolveRegistryPath(options);
  const legacyNvmDir = resolveLegacyNvmDir(options);

  mkdirSync(globalBinDir, { recursive: true });
  const releaseRegistryLock = acquireRegistryLock(statePath);
  try {
    return linkDevLauncherLocked({
      local,
      projectRoot,
      globalBinDir,
      globalLauncherPath,
      backupPath,
      statePath,
      legacyNvmDir
    });
  } finally {
    releaseRegistryLock();
  }
}

function linkDevLauncherLocked({
  local,
  projectRoot,
  globalBinDir,
  globalLauncherPath,
  backupPath,
  statePath,
  legacyNvmDir
}) {
  const existingState = readGlobalState(statePath)
    ?? adoptDiscoveredLegacyGlobalState(globalBinDir, statePath, legacyNvmDir)
    ?? adoptDiscoveredManagedOrphanState(
      globalBinDir,
      statePath,
      legacyNvmDir,
      projectRoot
    );
  if (existingState !== null) {
    if (existingState.globalLauncherPath === globalLauncherPath) {
      ensureManagedGlobalLinkActive(existingState);
      if (existingState.localLauncherPath !== local.launcherPath) {
        const nextState = {
          ...existingState,
          activeProjectRoot: projectRoot,
          localLauncherPath: local.launcherPath
        };
        replaceActiveDevelopmentLink(globalLauncherPath, existingState.localLauncherPath, local.launcherPath);
        try {
          writeGlobalState(statePath, nextState);
          writeManagedRecoveryState(nextState);
        } catch (error) {
          try {
            replaceActiveDevelopmentLink(
              globalLauncherPath,
              local.launcherPath,
              existingState.localLauncherPath
            );
            writeGlobalState(statePath, existingState);
            writeManagedRecoveryState(existingState);
          } catch (rollbackError) {
            throw new AggregateError(
              [error, rollbackError],
              `Failed to update ${globalLauncherPath} and failed to restore its previous managed state.`
            );
          }
          throw error;
        }
      } else {
        writeManagedRecoveryState(existingState);
      }
      return globalLinkResult(
        local,
        globalLauncherPath,
        existingState.backupPath,
        statePath,
        existingState.hadOriginal
      );
    }

    if (pathExists(backupPath)) {
      throw new Error(`Refusing to overwrite an existing development backup: ${backupPath}`);
    }
    restoreManagedGlobalLink(existingState);
    let previousStateRemoved = false;
    try {
      removeManagedRecoveryState(existingState);
      rmSync(statePath);
      previousStateRemoved = true;
      const result = createManagedGlobalLink({
        local,
        projectRoot,
        globalLauncherPath,
        backupPath,
        statePath
      });
      return result;
    } catch (error) {
      try {
        if (previousStateRemoved) {
          createManagedGlobalLinkFromState(existingState, statePath);
        } else {
          activateManagedGlobalLink(existingState);
          writeManagedRecoveryState(existingState);
        }
      } catch (rollbackError) {
        throw new AggregateError(
          [error, rollbackError],
          `Failed to link ${globalLauncherPath} and failed to restore the previous development link.`
        );
      }
      throw error;
    }
  }

  if (pathExists(backupPath)) {
    throw new Error(`Refusing to overwrite an existing development backup: ${backupPath}`);
  }
  return createManagedGlobalLink({
    local,
    projectRoot,
    globalLauncherPath,
    backupPath,
    statePath
  });
}

function createManagedGlobalLink({ local, projectRoot, globalLauncherPath, backupPath, statePath }) {
  const hadOriginal = pathExists(globalLauncherPath);
  const state = {
    schemaVersion: registrySchemaVersion,
    activeProjectRoot: projectRoot,
    localLauncherPath: local.launcherPath,
    globalLauncherPath,
    backupPath,
    hadOriginal
  };
  createManagedGlobalLinkFromState(state, statePath);
  return globalLinkResult(local, globalLauncherPath, backupPath, statePath, hadOriginal);
}

function createManagedGlobalLinkFromState(state, statePath) {
  writeGlobalState(statePath, state, true);
  let recoveryWritten = false;
  try {
    activateManagedGlobalLink(state);
    writeManagedRecoveryState(state);
    recoveryWritten = true;
  } catch (error) {
    try {
      restoreManagedGlobalLink(state);
      if (recoveryWritten) removeManagedRecoveryState(state);
      rmSync(statePath, { force: true });
    } catch (rollbackError) {
      throw new AggregateError(
        [error, rollbackError],
        `Failed to create ${state.globalLauncherPath} and failed to restore its previous state.`
      );
    }
    throw error;
  }
}

function activateManagedGlobalLink(state) {
  if (state.hadOriginal) renameSync(state.globalLauncherPath, state.backupPath);
  symlinkSync(state.localLauncherPath, state.globalLauncherPath);
}

export function unlinkDevLauncher(options = {}) {
  const projectRoot = resolve(options.projectRoot ?? process.cwd());
  const statePath = resolveRegistryPath(options);
  const releaseRegistryLock = acquireRegistryLock(statePath);
  try {
    return unlinkDevLauncherLocked({ options, projectRoot, statePath });
  } finally {
    releaseRegistryLock();
  }
}

function unlinkDevLauncherLocked({ options, projectRoot, statePath }) {
  let state = readGlobalState(statePath);
  let fallbackGlobalBinDir;
  if (state === null) {
    fallbackGlobalBinDir = resolve(options.globalBinDir ?? resolveNpmGlobalBinDir());
    const legacyNvmDir = resolveLegacyNvmDir(options);
    state = adoptDiscoveredLegacyGlobalState(
      fallbackGlobalBinDir,
      statePath,
      legacyNvmDir
    ) ?? adoptDiscoveredManagedOrphanState(
      fallbackGlobalBinDir,
      statePath,
      legacyNvmDir,
      projectRoot
    );
  }

  if (state === null) {
    const globalBinDir = fallbackGlobalBinDir;
    const globalLauncherPath = join(globalBinDir, DEV_LAUNCHER_NAME);
    const backupPath = join(globalBinDir, globalBackupName);
    uninstallDevLauncher({ projectRoot, ...(options.outputDir === undefined ? {} : { outputDir: options.outputDir }) });
    return { globalLauncherPath, backupPath, statePath, restored: false };
  }
  restoreManagedGlobalLink(state);
  removeManagedRecoveryState(state);
  removeManagedLauncherIfPresent(state.localLauncherPath);
  rmSync(statePath);
  return {
    globalLauncherPath: state.globalLauncherPath,
    backupPath: state.backupPath,
    statePath,
    restored: true
  };
}

export async function resetDevHome(options = {}) {
  const projectRoot = resolve(options.projectRoot ?? process.cwd());
  const outputDir = resolve(options.outputDir ?? join(projectRoot, "output", "dev"));
  const homePath = join(outputDir, "home");
  if (!pathExists(homePath)) return { homePath, backupPath: null, moved: false };
  const releaseLifecycleLock = acquireHomeLifecycleLock(homePath);
  try {
    if (!pathExists(homePath)) return { homePath, backupPath: null, moved: false };
    const discoveryPath = join(homePath, "runtime", controllerDiscoveryName);
    const socketPath = controllerSocketPath(homePath);
    if (pathExists(discoveryPath)) {
      const discovery = readControllerDiscoveryForReset(homePath, discoveryPath);
      const probe = await probeController(discovery);
      if (probe.status === "running") {
        if (probe.pid !== discovery.pid) {
          throw cannotVerifyController(discoveryPath);
        }
        throw new Error(
          `Refusing to reset a development home while Controller PID ${discovery.pid} is running. `
          + "Run yui controller stop first."
        );
      }
      if (probe.status !== "unreachable") {
        throw cannotVerifyController(discoveryPath);
      }
      let currentProcessStartIdentity;
      try {
        currentProcessStartIdentity = readLinuxProcessStartIdentity(discovery.pid);
      } catch (error) {
        throw cannotVerifyController(discoveryPath, error);
      }
      if (currentProcessStartIdentity === discovery.processStartIdentity) {
        throw cannotVerifyController(discoveryPath);
      }
    } else if (pathExists(socketPath)) {
      throw cannotVerifyController(discoveryPath);
    }

    const timestamp = (options.now ?? new Date()).toISOString().replaceAll(/[-:.]/g, "");
    let backupPath = join(outputDir, `home.backup-${timestamp}`);
    for (let suffix = 2; pathExists(backupPath); suffix += 1) {
      backupPath = join(outputDir, `home.backup-${timestamp}-${suffix}`);
    }
    renameSync(homePath, backupPath);
    return { homePath, backupPath, moved: true };
  } finally {
    releaseLifecycleLock();
  }
}

export function resolveNpmGlobalBinDir() {
  const prefix = execFileSync("npm", ["prefix", "-g"], { encoding: "utf8" }).trim();
  if (prefix.length === 0) throw new Error("npm did not report a global prefix.");
  return join(prefix, "bin");
}

function assertCanReplace(path) {
  const existing = inspectManagedFile(path);
  if (existing !== null && !existing.managed) {
    throw new Error(`Refusing to overwrite a file not managed by this checkout: ${path}`);
  }
}

function inspectManagedFile(path) {
  try {
    const stats = lstatSync(path);
    if (!stats.isFile()) return { managed: false };
    return { managed: readFileSync(path, "utf8").split("\n")[1] === managedMarker };
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
    throw error;
  }
}

function globalLinkResult(local, globalLauncherPath, backupPath, statePath, replaced) {
  return {
    localLauncherPath: local.launcherPath,
    yuiHome: local.yuiHome,
    globalLauncherPath,
    backupPath,
    statePath,
    replaced
  };
}

function readGlobalState(statePath) {
  if (!pathExists(statePath)) return null;
  let value;
  try {
    value = JSON.parse(readFileSync(statePath, "utf8"));
  } catch {
    throw new Error(`Invalid managed global yui state: ${statePath}`);
  }
  if (
    typeof value !== "object" || value === null
    || value.schemaVersion !== registrySchemaVersion
    || typeof value.activeProjectRoot !== "string"
    || typeof value.localLauncherPath !== "string"
    || typeof value.globalLauncherPath !== "string"
    || typeof value.backupPath !== "string"
    || typeof value.hadOriginal !== "boolean"
    || !isValidManagedStatePaths(value)
  ) {
    throw new Error(`Invalid managed global yui state: ${statePath}`);
  }
  return value;
}

function isValidManagedStatePaths(state) {
  return isAbsolute(state.activeProjectRoot)
    && isAbsolute(state.localLauncherPath)
    && basename(state.localLauncherPath) === DEV_LAUNCHER_NAME
    && isAbsolute(state.globalLauncherPath)
    && basename(state.globalLauncherPath) === DEV_LAUNCHER_NAME
    && state.backupPath === join(dirname(state.globalLauncherPath), globalBackupName);
}

function acquireRegistryLock(statePath) {
  mkdirSync(dirname(statePath), { recursive: true });
  const lockPath = `${statePath}.lock`;
  const token = randomUUID();
  const writeLock = () => writeFileSync(
    lockPath,
    `${JSON.stringify({ pid: process.pid, token, createdAt: new Date().toISOString() })}\n`,
    { flag: "wx" }
  );

  try {
    writeLock();
    return () => releaseRegistryLock(lockPath, token);
  } catch (error) {
    if (!(error instanceof Error) || !("code" in error) || error.code !== "EEXIST") throw error;
  }

  const owner = readRegistryLockOwner(lockPath);
  if (isProcessAlive(owner.pid)) {
    throw new Error(`Another yui development link operation is already running: ${lockPath}`);
  }
  throw new Error(
    `A previous yui development link operation left a stale lock: ${lockPath}. `
      + `If no link/unlink command is running, remove this exact lock file and retry.`
  );
}

function readRegistryLockOwner(lockPath) {
  try {
    const owner = JSON.parse(readFileSync(lockPath, "utf8"));
    if (
      typeof owner !== "object" || owner === null
      || !Number.isInteger(owner.pid) || owner.pid <= 0
    ) {
      throw new Error("invalid owner");
    }
    return owner;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") throw error;
    throw new Error(
      `Cannot verify the existing yui development link lock: ${lockPath}. `
        + `If no link/unlink command is running, remove this exact lock file and retry.`
    );
  }
}

function isProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ESRCH") return false;
    return true;
  }
}

function acquireHomeLifecycleLock(homePath) {
  const lockPath = homeLifecycleLockPath(homePath);
  mkdirSync(dirname(lockPath), { recursive: true });
  const token = randomUUID();
  const owner = {
    pid: process.pid,
    token,
    createdAt: new Date().toISOString()
  };
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      writeFileSync(lockPath, `${JSON.stringify(owner)}\n`, {
        flag: "wx",
        mode: 0o600
      });
      return () => releaseHomeLifecycleLock(lockPath, token);
    } catch (error) {
      if (!(error instanceof Error) || !("code" in error) || error.code !== "EEXIST") {
        throw error;
      }
    }
    let existing;
    try {
      existing = readHomeLifecycleLockOwner(lockPath);
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") continue;
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

function homeLifecycleLockPath(homePath) {
  const resolvedHome = resolve(homePath);
  return join(dirname(resolvedHome), `.${basename(resolvedHome)}.controller-lifecycle.lock`);
}

function readHomeLifecycleLockOwner(lockPath) {
  try {
    const owner = JSON.parse(readFileSync(lockPath, "utf8"));
    if (
      typeof owner !== "object" || owner === null
      || !Number.isSafeInteger(owner.pid) || owner.pid <= 0
      || typeof owner.token !== "string" || owner.token.length === 0 || owner.token.length > 128
      || typeof owner.createdAt !== "string" || Number.isNaN(Date.parse(owner.createdAt))
    ) {
      throw new Error("invalid owner");
    }
    return owner;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") throw error;
    throw new Error(
      `Cannot verify the existing Yui home lifecycle lock: ${lockPath}. `
        + "If no Controller startup or development reset is running, remove this exact lock file and retry."
    );
  }
}

function releaseHomeLifecycleLock(lockPath, token) {
  let owner;
  try {
    owner = readHomeLifecycleLockOwner(lockPath);
  } catch {
    return;
  }
  if (owner.token === token && owner.pid === process.pid) rmSync(lockPath, { force: true });
}

function releaseRegistryLock(lockPath, token) {
  let owner;
  try {
    owner = JSON.parse(readFileSync(lockPath, "utf8"));
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return;
    return;
  }
  if (owner?.token === token) rmSync(lockPath, { force: true });
}

function readControllerDiscoveryForReset(homePath, discoveryPath) {
  try {
    const metadata = lstatSync(discoveryPath);
    if (
      !metadata.isFile()
      || (metadata.mode & 0o077) !== 0
      || metadata.size > 4_096
    ) {
      throw new Error("invalid metadata");
    }
    const discovery = JSON.parse(readFileSync(discoveryPath, "utf8"));
    const expectedSocketPath = controllerSocketPath(homePath);
    if (
      typeof discovery !== "object" || discovery === null
      || Reflect.ownKeys(discovery).length !== 4
      || !Object.hasOwn(discovery, "pid")
      || !Object.hasOwn(discovery, "processStartIdentity")
      || !Object.hasOwn(discovery, "socketPath")
      || !Object.hasOwn(discovery, "token")
      || !Number.isSafeInteger(discovery.pid) || discovery.pid <= 0
      || typeof discovery.processStartIdentity !== "string"
      || !/^[0-9]{1,32}$/u.test(discovery.processStartIdentity)
      || discovery.socketPath !== expectedSocketPath
      || typeof discovery.token !== "string"
      || !/^[a-f0-9]{64}$/u.test(discovery.token)
    ) {
      throw new Error("invalid fields");
    }
    return discovery;
  } catch (error) {
    throw cannotVerifyController(discoveryPath, error);
  }
}

function controllerSocketPath(homePath) {
  const uid = typeof process.getuid === "function" ? process.getuid() : 0;
  const identity = createHash("sha256")
    .update(resolve(homePath))
    .digest("hex")
    .slice(0, 24);
  return join(tmpdir(), `yui-${uid}`, `${identity}.sock`);
}

function cannotVerifyController(discoveryPath, cause) {
  return new Error(`Cannot verify development Controller state: ${discoveryPath}`, {
    ...(cause === undefined ? {} : { cause })
  });
}

function readLinuxProcessStartIdentity(pid) {
  let stat;
  try {
    stat = readFileSync(`/proc/${pid}/stat`, "utf8");
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
    throw new Error(`Cannot verify process identity for Controller PID ${pid}.`, {
      cause: error
    });
  }
  const closingParenthesis = stat.lastIndexOf(")");
  const fieldsAfterCommand = closingParenthesis < 0
    ? []
    : stat.slice(closingParenthesis + 1).trim().split(/\s+/u);
  const processStartIdentity = fieldsAfterCommand[19];
  if (
    processStartIdentity === undefined
    || !/^[0-9]{1,32}$/u.test(processStartIdentity)
  ) {
    throw new Error(`Cannot verify process identity for Controller PID ${pid}.`);
  }
  return processStartIdentity;
}

function probeController(discovery) {
  return new Promise((resolveProbe) => {
    const requestId = `dev-reset-${randomUUID()}`;
    const request = `${JSON.stringify({
      id: requestId,
      token: discovery.token,
      method: "controller.status",
      params: {}
    })}\n`;
    const socket = createConnection(discovery.socketPath);
    let buffer = Buffer.alloc(0);
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolveProbe(result);
    };
    const timer = setTimeout(
      () => finish({ status: "unreachable" }),
      controllerProbeTimeoutMs
    );
    socket.once("connect", () => socket.write(request));
    socket.on("data", (chunk) => {
      if (settled) return;
      buffer = Buffer.concat([buffer, chunk]);
      if (buffer.length > 4_096) {
        finish({ status: "invalid" });
        return;
      }
      const newline = buffer.indexOf(0x0a);
      if (newline < 0) return;
      if (buffer.length !== newline + 1) {
        finish({ status: "invalid" });
        return;
      }
      try {
        const response = JSON.parse(buffer.subarray(0, newline).toString("utf8"));
        const result = response?.result;
        const resultKeys = typeof result === "object" && result !== null
          ? Reflect.ownKeys(result)
          : [];
        if (
          typeof response !== "object" || response === null
          || Reflect.ownKeys(response).length !== 3
          || response.id !== requestId
          || response.ok !== true
          || typeof result !== "object" || result === null
          || resultKeys.length < 2
          || resultKeys.length > 6
          || resultKeys.some((key) => ![
            "pid",
            "running",
            "protocolVersion",
            "version",
            "storageLayoutVersion",
            "aggregateSchemaVersion"
          ].includes(key))
          || result.running !== true
          || !Number.isSafeInteger(result.pid) || result.pid <= 0
          || (
            Object.hasOwn(result, "protocolVersion")
            && (!Number.isSafeInteger(result.protocolVersion) || result.protocolVersion <= 0)
          )
          || (
            Object.hasOwn(result, "version")
            && (typeof result.version !== "string" || result.version.length === 0)
          )
          || ["storageLayoutVersion", "aggregateSchemaVersion"].some((key) => (
            Object.hasOwn(result, key)
            && (!Number.isSafeInteger(result[key]) || result[key] <= 0)
          ))
        ) {
          finish({ status: "invalid" });
          return;
        }
        finish({ status: "running", pid: result.pid });
      } catch {
        finish({ status: "invalid" });
      }
    });
    socket.once("error", () => finish({ status: "unreachable" }));
    socket.once("end", () => finish({ status: "invalid" }));
  });
}

function writeGlobalState(statePath, state, exclusive = false) {
  mkdirSync(dirname(statePath), { recursive: true });
  const contents = `${JSON.stringify(state, null, 2)}\n`;
  if (exclusive) {
    writeFileSync(statePath, contents, { flag: "wx" });
    return;
  }
  const temporaryPath = `${statePath}.tmp-${process.pid}`;
  writeFileSync(temporaryPath, contents, { flag: "wx" });
  try {
    renameSync(temporaryPath, statePath);
  } catch (error) {
    rmSync(temporaryPath, { force: true });
    throw error;
  }
}

function managedRecoveryPath(globalLauncherPath) {
  return join(dirname(globalLauncherPath), globalRecoveryName);
}

function readManagedRecoveryState(globalBinDir) {
  const recoveryPath = join(globalBinDir, globalRecoveryName);
  if (!pathExists(recoveryPath)) return null;
  let value;
  try {
    const metadata = lstatSync(recoveryPath);
    if (
      !metadata.isFile()
      || (metadata.mode & 0o077) !== 0
      || metadata.size === 0
      || metadata.size > 4_096
    ) {
      throw new Error("invalid metadata");
    }
    value = JSON.parse(readFileSync(recoveryPath, "utf8"));
  } catch (error) {
    throw new Error(`Invalid managed global yui recovery state: ${recoveryPath}`, {
      cause: error
    });
  }
  if (
    typeof value !== "object" || value === null
    || Reflect.ownKeys(value).length !== 3
    || !Object.hasOwn(value, "schemaVersion")
    || !Object.hasOwn(value, "localLauncherPath")
    || !Object.hasOwn(value, "hadOriginal")
    || value.schemaVersion !== recoverySchemaVersion
    || typeof value.localLauncherPath !== "string"
    || !isAbsolute(value.localLauncherPath)
    || basename(value.localLauncherPath) !== DEV_LAUNCHER_NAME
    || typeof value.hadOriginal !== "boolean"
  ) {
    throw new Error(`Invalid managed global yui recovery state: ${recoveryPath}`);
  }
  return {
    localLauncherPath: resolve(value.localLauncherPath),
    hadOriginal: value.hadOriginal,
    recoveryPath
  };
}

function writeManagedRecoveryState(state) {
  const recoveryPath = managedRecoveryPath(state.globalLauncherPath);
  // Never silently replace an unrelated or corrupted reserved file.
  readManagedRecoveryState(dirname(state.globalLauncherPath));
  const value = {
    schemaVersion: recoverySchemaVersion,
    localLauncherPath: resolve(state.localLauncherPath),
    hadOriginal: state.hadOriginal
  };
  const temporaryPath = `${recoveryPath}.tmp-${process.pid}-${randomUUID()}`;
  writeFileSync(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, {
    flag: "wx",
    mode: 0o600
  });
  try {
    renameSync(temporaryPath, recoveryPath);
  } catch (error) {
    rmSync(temporaryPath, { force: true });
    throw error;
  }
}

function removeManagedRecoveryState(state) {
  const recovery = readManagedRecoveryState(dirname(state.globalLauncherPath));
  if (recovery === null) return;
  // Every caller first restores the global command from the authoritative
  // registry state. A valid but older witness can remain after a crash while
  // switching checkouts, so it is stale once that restore has succeeded.
  rmSync(recovery.recoveryPath);
}

function adoptLegacyGlobalState(globalBinDir, statePath) {
  const legacyStatePath = join(globalBinDir, legacyGlobalStateName);
  if (!pathExists(legacyStatePath)) return null;
  let legacy;
  try {
    legacy = JSON.parse(readFileSync(legacyStatePath, "utf8"));
  } catch {
    throw new Error(`Invalid previous managed global yui state: ${legacyStatePath}`);
  }
  if (
    typeof legacy !== "object" || legacy === null
    || legacy.schemaVersion !== 2
    || typeof legacy.activeProjectRoot !== "string"
    || typeof legacy.localLauncherPath !== "string"
    || typeof legacy.hadOriginal !== "boolean"
    || !isAbsolute(legacy.activeProjectRoot)
    || !isAbsolute(legacy.localLauncherPath)
    || basename(legacy.localLauncherPath) !== DEV_LAUNCHER_NAME
  ) {
    throw new Error(`Invalid previous managed global yui state: ${legacyStatePath}`);
  }

  const globalLauncherPath = join(globalBinDir, DEV_LAUNCHER_NAME);
  const backupPath = join(globalBinDir, globalBackupName);
  if (!isSymlinkTo(globalLauncherPath, legacy.localLauncherPath)) {
    throw new Error(`Previous managed global yui state is inconsistent: ${globalLauncherPath}`);
  }
  if (legacy.hadOriginal && !pathExists(backupPath)) {
    throw new Error(`Cannot restore the original yui command; backup is missing: ${backupPath}`);
  }
  if (!legacy.hadOriginal && pathExists(backupPath)) {
    throw new Error(`Previous managed global yui state has an unexpected backup: ${backupPath}`);
  }

  const state = {
    schemaVersion: registrySchemaVersion,
    activeProjectRoot: legacy.activeProjectRoot,
    localLauncherPath: legacy.localLauncherPath,
    globalLauncherPath,
    backupPath,
    hadOriginal: legacy.hadOriginal
  };
  writeGlobalState(statePath, state, true);
  rmSync(legacyStatePath);
  return state;
}

function adoptDiscoveredLegacyGlobalState(globalBinDir, statePath, nvmDir) {
  const candidates = findLegacyGlobalStateBinDirs(globalBinDir, nvmDir);
  if (candidates.length === 0) return null;
  if (candidates.length > 1) {
    const statePaths = candidates.map((candidate) => join(candidate, legacyGlobalStateName));
    throw new Error(
      "Multiple previous managed global yui states were found; refusing to choose or remove any of them:\n"
        + statePaths.map((path) => `- ${path}`).join("\n")
    );
  }
  return adoptLegacyGlobalState(candidates[0], statePath);
}

function adoptDiscoveredManagedOrphanState(
  globalBinDir,
  statePath,
  nvmDir,
  activeProjectRoot
) {
  const candidates = findManagedOrphanGlobalStates(globalBinDir, nvmDir);
  if (candidates.length === 0) return null;
  if (candidates.length > 1) {
    throw new Error(
      "Multiple managed global yui links were found without a registry; "
        + "refusing to choose or remove any of them:\n"
        + candidates.map(({ globalLauncherPath }) => `- ${globalLauncherPath}`).join("\n")
    );
  }
  const candidate = candidates[0];
  if (candidate.hadOriginal && !candidate.hasBackup) {
    throw new Error(
      `Cannot safely restore the original yui command because its backup is missing: `
        + candidate.backupPath
    );
  }
  if (!candidate.hadOriginal && candidate.hasBackup) {
    throw new Error(
      `Managed global yui recovery state has an unexpected backup: ${candidate.backupPath}`
    );
  }
  if (candidate.hadOriginal && !isRestorableCommand(candidate.backupPath)) {
    throw new Error(`Cannot safely restore an invalid yui backup: ${candidate.backupPath}`);
  }
  const state = {
    schemaVersion: registrySchemaVersion,
    activeProjectRoot: resolve(activeProjectRoot),
    localLauncherPath: candidate.localLauncherPath,
    globalLauncherPath: candidate.globalLauncherPath,
    backupPath: candidate.backupPath,
    hadOriginal: candidate.hadOriginal
  };
  writeGlobalState(statePath, state, true);
  return state;
}

function findManagedOrphanGlobalStates(globalBinDir, nvmDir) {
  return candidateGlobalBinDirs(globalBinDir, nvmDir)
    .map((candidate) => inspectManagedGlobalLink(candidate))
    .filter((candidate) => candidate !== null);
}

function inspectManagedGlobalLink(globalBinDir) {
  const globalLauncherPath = join(globalBinDir, DEV_LAUNCHER_NAME);
  const recovery = readManagedRecoveryState(globalBinDir);
  if (recovery === null) return null;
  if (!isSymlinkTo(globalLauncherPath, recovery.localLauncherPath)) {
    throw new Error(
      `Managed global yui recovery state is inconsistent: ${recovery.recoveryPath}`
    );
  }
  const backupPath = join(globalBinDir, globalBackupName);
  return {
    localLauncherPath: recovery.localLauncherPath,
    globalLauncherPath,
    backupPath,
    hadOriginal: recovery.hadOriginal,
    hasBackup: pathExists(backupPath)
  };
}

function findLegacyGlobalStateBinDirs(globalBinDir, nvmDir) {
  return candidateGlobalBinDirs(globalBinDir, nvmDir)
    .filter((candidate) => pathExists(join(candidate, legacyGlobalStateName)));
}

function candidateGlobalBinDirs(globalBinDir, nvmDir) {
  const candidates = new Map();
  const addCandidate = (candidate) => {
    const resolvedCandidate = resolve(candidate);
    let canonicalCandidate;
    try {
      canonicalCandidate = realpathSync(resolvedCandidate);
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
      canonicalCandidate = resolvedCandidate;
    }
    if (!candidates.has(canonicalCandidate)) {
      candidates.set(canonicalCandidate, resolvedCandidate);
    }
  };
  addCandidate(globalBinDir);
  const nodeVersionsDirs = new Set();
  const inferredNodeVersionsDir = inferNvmNodeVersionsDir(globalBinDir);
  if (inferredNodeVersionsDir !== null) nodeVersionsDirs.add(inferredNodeVersionsDir);
  if (nvmDir !== null) nodeVersionsDirs.add(join(nvmDir, "versions", "node"));
  for (const nodeVersionsDir of nodeVersionsDirs) {
    if (!pathExists(nodeVersionsDir)) continue;
    for (const entry of readdirSync(nodeVersionsDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      addCandidate(join(nodeVersionsDir, entry.name, "bin"));
    }
  }
  return [...candidates.values()].sort();
}

function inferNvmNodeVersionsDir(globalBinDir) {
  const versionDir = dirname(resolve(globalBinDir));
  const nodeVersionsDir = dirname(versionDir);
  if (basename(nodeVersionsDir) !== "node" || basename(dirname(nodeVersionsDir)) !== "versions") {
    return null;
  }
  return nodeVersionsDir;
}

function replaceActiveDevelopmentLink(globalLauncherPath, previousTarget, nextTarget) {
  rmSync(globalLauncherPath);
  try {
    symlinkSync(nextTarget, globalLauncherPath);
  } catch (error) {
    symlinkSync(previousTarget, globalLauncherPath);
    throw error;
  }
}

function ensureManagedGlobalLinkActive(state) {
  const globalExists = pathExists(state.globalLauncherPath);
  const activeTarget = managedDevelopmentLinkTarget(
    state.globalLauncherPath,
    state.localLauncherPath
  );
  const backupExists = pathExists(state.backupPath);
  if (state.hadOriginal) {
    if (backupExists) {
      if (!isRestorableCommand(state.backupPath)) {
        throw new Error(`Cannot safely restore an invalid yui backup: ${state.backupPath}`);
      }
      if (!globalExists) {
        symlinkSync(state.localLauncherPath, state.globalLauncherPath);
        return;
      }
      if (activeTarget === null) {
        throw new Error(
          `Refusing to replace a global yui command not managed by this checkout: `
            + state.globalLauncherPath
        );
      }
      if (resolve(activeTarget) !== resolve(state.localLauncherPath)) {
        replaceActiveDevelopmentLink(
          state.globalLauncherPath,
          activeTarget,
          state.localLauncherPath
        );
      }
      return;
    }
    if (!globalExists) {
      throw new Error(`Cannot restore the original yui command; backup is missing: ${state.backupPath}`);
    }
    if (activeTarget !== null) {
      throw new Error(`Cannot restore the original yui command; backup is missing: ${state.backupPath}`);
    }
    renameSync(state.globalLauncherPath, state.backupPath);
    try {
      symlinkSync(state.localLauncherPath, state.globalLauncherPath);
    } catch (error) {
      renameSync(state.backupPath, state.globalLauncherPath);
      throw error;
    }
    return;
  }

  if (backupExists) {
    throw new Error(`Managed global yui state has an unexpected backup: ${state.backupPath}`);
  }
  if (!globalExists) {
    symlinkSync(state.localLauncherPath, state.globalLauncherPath);
    return;
  }
  if (activeTarget === null) {
    throw new Error(
      `Refusing to replace a global yui command not managed by this checkout: `
        + state.globalLauncherPath
    );
  }
  if (resolve(activeTarget) !== resolve(state.localLauncherPath)) {
    replaceActiveDevelopmentLink(
      state.globalLauncherPath,
      activeTarget,
      state.localLauncherPath
    );
  }
}

function restoreManagedGlobalLink(state) {
  const globalExists = pathExists(state.globalLauncherPath);
  const activeTarget = managedDevelopmentLinkTarget(
    state.globalLauncherPath,
    state.localLauncherPath
  );
  const backupExists = pathExists(state.backupPath);
  if (!state.hadOriginal) {
    if (backupExists) {
      throw new Error(`Managed global yui state has an unexpected backup: ${state.backupPath}`);
    }
    if (!globalExists) return;
    if (activeTarget === null) {
      throw new Error(
        `Refusing to replace a global yui command not managed by this checkout: `
          + state.globalLauncherPath
      );
    }
    rmSync(state.globalLauncherPath);
    return;
  }

  if (!backupExists) {
    if (!globalExists || activeTarget !== null) {
      throw new Error(`Cannot restore the original yui command; backup is missing: ${state.backupPath}`);
    }
    // The original command is already back in place. This is the durable state
    // left between restore and registry cleanup.
    return;
  }
  if (!isRestorableCommand(state.backupPath)) {
    throw new Error(`Cannot safely restore an invalid yui backup: ${state.backupPath}`);
  }
  if (globalExists && activeTarget === null) {
    throw new Error(
      `Refusing to replace a global yui command not managed by this checkout: `
        + state.globalLauncherPath
    );
  }
  if (globalExists) rmSync(state.globalLauncherPath);
  try {
    renameSync(state.backupPath, state.globalLauncherPath);
  } catch (error) {
    if (globalExists && activeTarget !== null) {
      try {
        symlinkSync(activeTarget, state.globalLauncherPath);
      } catch (rollbackError) {
        throw new AggregateError(
          [error, rollbackError],
          `Failed to restore the original yui command and failed to reinstate the development link: `
            + state.globalLauncherPath
        );
      }
    }
    throw error;
  }
}

function managedDevelopmentLinkTarget(path, knownTarget) {
  try {
    if (!lstatSync(path).isSymbolicLink()) return null;
    const target = resolve(dirname(path), readlinkSync(path));
    if (knownTarget !== undefined && target === resolve(knownTarget)) return target;
    return inspectManagedFile(target)?.managed === true ? target : null;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
    throw error;
  }
}

function isRestorableCommand(path) {
  try {
    const metadata = lstatSync(path);
    return metadata.isFile() || metadata.isSymbolicLink();
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return false;
    throw error;
  }
}

function removeManagedLauncherIfPresent(path) {
  const existing = inspectManagedFile(path);
  if (existing?.managed === true) rmSync(path);
}

function resolveRegistryPath(options) {
  if (options.registryPath !== undefined) return resolve(options.registryPath);
  const stateRoot = process.env.XDG_STATE_HOME === undefined || process.env.XDG_STATE_HOME.length === 0
    ? join(homedir(), ".local", "state")
    : resolve(process.env.XDG_STATE_HOME);
  return join(stateRoot, "yui", "dev-launcher.json");
}

function resolveLegacyNvmDir(options) {
  if (options.nvmDir !== undefined) return resolve(options.nvmDir);
  // An explicit registry path is primarily a test/embedding seam. Avoid inspecting
  // an unrelated real home unless its NVM root is explicitly supplied as well.
  if (options.registryPath !== undefined) return null;
  if (process.env.NVM_DIR !== undefined && process.env.NVM_DIR.length > 0) {
    return resolve(process.env.NVM_DIR);
  }
  return join(homedir(), ".nvm");
}

async function assertCompatibleDevHome(homePath) {
  if (!pathExists(homePath)) return;
  const { inspectStorageSchema } = await import("../dist/storage/storageSchema.js");
  const state = inspectStorageSchema(homePath);
  if (state.status === "current") return;
  if (state.status === "uninitialized") {
    if (readdirSync(homePath).length === 0) return;
    throw incompatibleDevHomeError(state.manifestPath, "schema manifest is missing");
  }
  if (state.status === "invalid") {
    throw incompatibleDevHomeError(state.manifestPath, state.detail);
  }
  throw incompatibleDevHomeError(
    state.manifestPath,
    `expected storage ${state.latestLayoutVersion} and aggregate ${state.latestAggregateSchemaVersion}; `
      + `found storage ${state.currentLayoutVersion} and aggregate ${state.currentAggregateSchemaVersion}`
  );
}

function incompatibleDevHomeError(schemaPath, detail) {
  return new Error(
    `Development home schema is incompatible at ${schemaPath}: ${detail}. `
      + "Run 'make dev-reset' to move the existing home aside, then retry 'make link'."
  );
}

function pathExists(path) {
  try {
    lstatSync(path);
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return false;
    throw error;
  }
}

function isSymlinkTo(path, expectedTarget) {
  try {
    return lstatSync(path).isSymbolicLink() && resolve(dirname(path), readlinkSync(path)) === resolve(expectedTarget);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return false;
    throw error;
  }
}

function renderLauncher({ projectRoot, binDir, yuiHome }) {
  const projectFromBin = relative(binDir, projectRoot);
  const homeFromProject = relative(projectRoot, yuiHome);
  return `${renderHeader()}launcher_path=$0
while [ -L "$launcher_path" ]; do
  link_target=$(readlink "$launcher_path")
  case "$link_target" in
    /*) launcher_path=$link_target ;;
    *) launcher_path=$(dirname -- "$launcher_path")/$link_target ;;
  esac
done
script_dir=$(CDPATH= cd -- "$(dirname -- "$launcher_path")" && pwd)
project_root=$(CDPATH= cd -- "$script_dir"/${shellQuote(projectFromBin)} && pwd)
${renderEnvironment('"$project_root"', homeFromProject, '"$script_dir"')}exec node "$project_root/dist/cli.js" "$@"
`;
}

function renderHeader() {
  return `#!/usr/bin/env sh
${managedMarker}
`;
}

function renderEnvironment(rootExpression, homeFromRoot, binExpression) {
  return `if [ -z "\${YUI_HOME:-}" ]; then
  export YUI_HOME=${rootExpression}/${shellQuote(homeFromRoot)}
fi
export YUI_CLI_NAME=yui
case ":$PATH:" in
  *:${binExpression}:*) ;;
  *) export PATH=${binExpression}:"$PATH" ;;
esac
`;
}

function shellQuote(value) {
  return `'${value.replaceAll("'", "'\"'\"'")}'`;
}

async function runCli() {
  const action = process.argv[2];
  if (action === "link") {
    const result = await linkDevLauncher();
    console.log(`Linked global yui to this checkout: ${result.globalLauncherPath}`);
    console.log(`Original yui ${result.replaced ? `saved at ${result.backupPath}` : "was not present"}.`);
    console.log(`Isolated YUI_HOME default: ${result.yuiHome}`);
    return;
  }
  if (action === "unlink") {
    const result = unlinkDevLauncher();
    console.log(result.restored ? `Restored the previous global yui command: ${result.globalLauncherPath}` : "This checkout did not own the global yui command.");
    return;
  }
  if (action === "reset-home") {
    const result = await resetDevHome();
    console.log(
      result.moved
        ? `Moved the previous development home to: ${result.backupPath}`
        : `Development home does not exist; nothing to reset: ${result.homePath}`
    );
    return;
  }
  throw new Error("Usage: node scripts/manage-dev-launcher.mjs link|unlink|reset-home");
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    await runCli();
  } catch (error) {
    console.error(`YUI_DEV_LAUNCHER_ERROR: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
