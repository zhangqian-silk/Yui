#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, relative, resolve } from "node:path";

export const DEV_LAUNCHER_NAME = "yui";

const managedMarker = "# yui-local-dev: managed";
const globalStateName = ".yui-link-state.json";
const globalBackupName = ".yui-link-original";

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

export function linkDevLauncher(options = {}) {
  const projectRoot = resolve(options.projectRoot ?? process.cwd());
  const local = installDevLauncher({ projectRoot, ...(options.outputDir === undefined ? {} : { outputDir: options.outputDir }) });
  const globalBinDir = resolve(options.globalBinDir ?? resolveNpmGlobalBinDir());
  const globalLauncherPath = join(globalBinDir, DEV_LAUNCHER_NAME);
  const backupPath = join(globalBinDir, globalBackupName);
  const statePath = join(globalBinDir, globalStateName);
  const existingState = readGlobalState(statePath);

  mkdirSync(globalBinDir, { recursive: true });
  if (existingState !== null) {
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
    return globalLinkResult(local, globalLauncherPath, backupPath, statePath, existingState.hadOriginal);
  }

  if (pathExists(backupPath)) {
    throw new Error(`Refusing to overwrite an existing development backup: ${backupPath}`);
  }

  const hadOriginal = pathExists(globalLauncherPath);
  const state = { schemaVersion: 2, activeProjectRoot: projectRoot, localLauncherPath: local.launcherPath, hadOriginal };
  writeGlobalState(statePath, state, true);

  try {
    if (hadOriginal) renameSync(globalLauncherPath, backupPath);
    symlinkSync(local.launcherPath, globalLauncherPath);
  } catch (error) {
    if (!pathExists(globalLauncherPath) && pathExists(backupPath)) renameSync(backupPath, globalLauncherPath);
    rmSync(statePath, { force: true });
    throw error;
  }

  return globalLinkResult(local, globalLauncherPath, backupPath, statePath, hadOriginal);
}

export function unlinkDevLauncher(options = {}) {
  const projectRoot = resolve(options.projectRoot ?? process.cwd());
  const globalBinDir = resolve(options.globalBinDir ?? resolveNpmGlobalBinDir());
  const globalLauncherPath = join(globalBinDir, DEV_LAUNCHER_NAME);
  const backupPath = join(globalBinDir, globalBackupName);
  const statePath = join(globalBinDir, globalStateName);
  const state = readGlobalState(statePath);

  if (state === null) {
    uninstallDevLauncher({ projectRoot, ...(options.outputDir === undefined ? {} : { outputDir: options.outputDir }) });
    return { globalLauncherPath, backupPath, statePath, restored: false };
  }
  if (pathExists(globalLauncherPath) && !isSymlinkTo(globalLauncherPath, state.localLauncherPath)) {
    throw new Error(`Refusing to replace a global yui command not managed by this checkout: ${globalLauncherPath}`);
  }
  if (state.hadOriginal && !pathExists(backupPath)) {
    throw new Error(`Cannot restore the original yui command; backup is missing: ${backupPath}`);
  }

  if (pathExists(globalLauncherPath)) rmSync(globalLauncherPath);
  if (state.hadOriginal) renameSync(backupPath, globalLauncherPath);
  rmSync(statePath);
  removeManagedLauncherIfPresent(state.localLauncherPath);
  uninstallDevLauncher({ projectRoot, ...(options.outputDir === undefined ? {} : { outputDir: options.outputDir }) });
  return { globalLauncherPath, backupPath, statePath, restored: true };
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
    || value.schemaVersion !== 2
    || typeof value.activeProjectRoot !== "string"
    || typeof value.localLauncherPath !== "string"
    || typeof value.hadOriginal !== "boolean"
  ) {
    throw new Error(`Invalid managed global yui state: ${statePath}`);
  }
  return value;
}

function writeGlobalState(statePath, state, exclusive = false) {
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

function replaceActiveDevelopmentLink(globalLauncherPath, previousTarget, nextTarget) {
  rmSync(globalLauncherPath);
  try {
    symlinkSync(nextTarget, globalLauncherPath);
  } catch (error) {
    symlinkSync(previousTarget, globalLauncherPath);
    throw error;
  }
}

function removeManagedLauncherIfPresent(path) {
  const existing = inspectManagedFile(path);
  if (existing?.managed === true) rmSync(path);
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

function runCli() {
  const action = process.argv[2];
  if (action === "link") {
    const result = linkDevLauncher();
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
  throw new Error("Usage: node scripts/manage-dev-launcher.mjs link|unlink");
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    runCli();
  } catch (error) {
    console.error(`YUI_DEV_LAUNCHER_ERROR: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
