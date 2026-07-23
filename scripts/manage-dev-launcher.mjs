#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from "node:fs";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";

export const DEV_LAUNCHER_NAME = "yui";

const managedMarker = "# yui-local-dev: managed";
const globalBackupName = ".yui-link-original";
const legacyGlobalStateName = ".yui-link-state.json";
const registrySchemaVersion = 3;

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
    ?? adoptDiscoveredLegacyGlobalState(globalBinDir, statePath, legacyNvmDir);
  if (existingState !== null) {
    if (existingState.globalLauncherPath === globalLauncherPath) {
      if (!isSymlinkTo(globalLauncherPath, existingState.localLauncherPath)) {
        throw new Error(`Managed global yui state is inconsistent: ${globalLauncherPath}`);
      }
      if (existingState.localLauncherPath !== local.launcherPath) {
        replaceActiveDevelopmentLink(globalLauncherPath, existingState.localLauncherPath, local.launcherPath);
        try {
          writeGlobalState(statePath, {
            ...existingState,
            activeProjectRoot: projectRoot,
            localLauncherPath: local.launcherPath
          });
        } catch (error) {
          replaceActiveDevelopmentLink(globalLauncherPath, local.launcherPath, existingState.localLauncherPath);
          throw error;
        }
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
  try {
    activateManagedGlobalLink(state);
  } catch (error) {
    if (!pathExists(state.globalLauncherPath) && pathExists(state.backupPath)) {
      renameSync(state.backupPath, state.globalLauncherPath);
    }
    rmSync(statePath, { force: true });
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
    state = adoptDiscoveredLegacyGlobalState(
      fallbackGlobalBinDir,
      statePath,
      resolveLegacyNvmDir(options)
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
  rmSync(statePath);
  removeManagedLauncherIfPresent(state.localLauncherPath);
  return {
    globalLauncherPath: state.globalLauncherPath,
    backupPath: state.backupPath,
    statePath,
    restored: true
  };
}

export function resetDevHome(options = {}) {
  const projectRoot = resolve(options.projectRoot ?? process.cwd());
  const outputDir = resolve(options.outputDir ?? join(projectRoot, "output", "dev"));
  const homePath = join(outputDir, "home");
  if (!pathExists(homePath)) return { homePath, backupPath: null, moved: false };
  const discoveryPath = join(homePath, "runtime", "controller.json");
  if (pathExists(discoveryPath)) {
    try {
      const discovery = JSON.parse(readFileSync(discoveryPath, "utf8"));
      if (Number.isSafeInteger(discovery.pid) && discovery.pid > 0) {
        process.kill(discovery.pid, 0);
        throw new Error(
          `Refusing to reset a development home while Controller PID ${discovery.pid} is running. `
          + "Run yui controller stop first."
        );
      }
    } catch (error) {
      if (error instanceof Error && error.message.startsWith("Refusing to reset")) throw error;
      if (!(error && typeof error === "object" && error.code === "ESRCH")) {
        throw new Error(`Cannot verify development Controller state: ${discoveryPath}`, {
          cause: error
        });
      }
    }
  }

  const timestamp = (options.now ?? new Date()).toISOString().replaceAll(/[-:.]/g, "");
  let backupPath = join(outputDir, `home.backup-${timestamp}`);
  for (let suffix = 2; pathExists(backupPath); suffix += 1) {
    backupPath = join(outputDir, `home.backup-${timestamp}-${suffix}`);
  }
  renameSync(homePath, backupPath);
  return { homePath, backupPath, moved: true };
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

function findLegacyGlobalStateBinDirs(globalBinDir, nvmDir) {
  const candidates = new Set([resolve(globalBinDir)]);
  const nodeVersionsDirs = new Set();
  const inferredNodeVersionsDir = inferNvmNodeVersionsDir(globalBinDir);
  if (inferredNodeVersionsDir !== null) nodeVersionsDirs.add(inferredNodeVersionsDir);
  if (nvmDir !== null) nodeVersionsDirs.add(join(nvmDir, "versions", "node"));
  for (const nodeVersionsDir of nodeVersionsDirs) {
    if (!pathExists(nodeVersionsDir)) continue;
    for (const entry of readdirSync(nodeVersionsDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      candidates.add(join(nodeVersionsDir, entry.name, "bin"));
    }
  }
  return [...candidates]
    .filter((candidate) => pathExists(join(candidate, legacyGlobalStateName)))
    .sort();
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

function restoreManagedGlobalLink(state) {
  if (pathExists(state.globalLauncherPath) && !isSymlinkTo(state.globalLauncherPath, state.localLauncherPath)) {
    throw new Error(`Refusing to replace a global yui command not managed by this checkout: ${state.globalLauncherPath}`);
  }
  if (state.hadOriginal && !pathExists(state.backupPath)) {
    throw new Error(`Cannot restore the original yui command; backup is missing: ${state.backupPath}`);
  }
  if (!pathExists(state.globalLauncherPath)) {
    if (state.hadOriginal) renameSync(state.backupPath, state.globalLauncherPath);
    return;
  }
  rmSync(state.globalLauncherPath);
  if (!state.hadOriginal) return;
  try {
    renameSync(state.backupPath, state.globalLauncherPath);
  } catch (error) {
    try {
      symlinkSync(state.localLauncherPath, state.globalLauncherPath);
    } catch (rollbackError) {
      throw new AggregateError(
        [error, rollbackError],
        `Failed to restore the original yui command and failed to reinstate the development link: ${state.globalLauncherPath}`
      );
    }
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
    const result = resetDevHome();
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
