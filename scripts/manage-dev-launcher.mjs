#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { chmodSync, lstatSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, resolve } from "node:path";

export const DEV_LAUNCHER_NAME = "taskmux-dev";

const managedMarker = "# taskmux-dev-wrapper: managed";
const projectRootMarker = "# taskmux-dev-wrapper-project-root: ";

export function installDevLauncher(options = {}) {
  const projectRoot = normalizeProjectRoot(options.projectRoot ?? process.cwd());
  const binDir = normalizeBinDir(options.binDir ?? resolveNpmGlobalBinDir());
  const launcherPath = join(binDir, DEV_LAUNCHER_NAME);

  mkdirSync(binDir, { recursive: true });
  assertCanReplaceLauncher(launcherPath, projectRoot);
  writeFileSync(launcherPath, renderLauncher(projectRoot), { mode: 0o755 });
  chmodSync(launcherPath, 0o755);

  return { launcherPath, projectRoot, binDir };
}

export function uninstallDevLauncher(options = {}) {
  const projectRoot = normalizeProjectRoot(options.projectRoot ?? process.cwd());
  const binDir = normalizeBinDir(options.binDir ?? resolveNpmGlobalBinDir());
  const launcherPath = join(binDir, DEV_LAUNCHER_NAME);
  const existing = inspectLauncher(launcherPath);

  if (existing === null) {
    return { launcherPath, removed: false };
  }

  if (!existing.isRegularFile || existing.projectRoot !== projectRoot) {
    throw new Error(`Refusing to remove launcher not managed by this checkout: ${launcherPath}`);
  }

  rmSync(launcherPath);
  return { launcherPath, removed: true };
}

export function resolveNpmGlobalBinDir() {
  const prefix = execFileSync("npm", ["prefix", "-g"], { encoding: "utf8" }).trim();

  if (prefix.length === 0) {
    throw new Error("npm did not report a global prefix.");
  }

  return join(prefix, "bin");
}

function normalizeProjectRoot(projectRoot) {
  return resolve(projectRoot);
}

function normalizeBinDir(binDir) {
  return resolve(binDir);
}

function assertCanReplaceLauncher(launcherPath, projectRoot) {
  const existing = inspectLauncher(launcherPath);

  if (existing === null) {
    return;
  }

  if (!existing.isRegularFile || existing.projectRoot !== projectRoot) {
    throw new Error(`Refusing to overwrite unmanaged ${DEV_LAUNCHER_NAME} command: ${launcherPath}`);
  }
}

function inspectLauncher(launcherPath) {
  try {
    const stats = lstatSync(launcherPath);

    if (!stats.isFile()) {
      return { isRegularFile: false, projectRoot: null };
    }

    return {
      isRegularFile: true,
      projectRoot: readManagedProjectRoot(readFileSync(launcherPath, "utf8"))
    };
  } catch (error) {
    if (isMissingFileError(error)) {
      return null;
    }

    throw error;
  }
}

function readManagedProjectRoot(contents) {
  const lines = contents.split("\n");

  if (lines[0] !== "#!/usr/bin/env sh" || lines[1] !== managedMarker || !lines[2]?.startsWith(projectRootMarker)) {
    return null;
  }

  try {
    const projectRoot = JSON.parse(lines[2].slice(projectRootMarker.length));
    return typeof projectRoot === "string" ? projectRoot : null;
  } catch {
    return null;
  }
}

function renderLauncher(projectRoot) {
  const home = join(projectRoot, "output", "taskmux-cli-dev");

  return `#!/usr/bin/env sh
${managedMarker}
${projectRootMarker}${JSON.stringify(projectRoot)}
export TASKMUX_HOME=${shellQuote(home)}
exec node ${shellQuote(join(projectRoot, "dist", "cli.js"))} "$@"
`;
}

function shellQuote(value) {
  return `'${value.replaceAll("'", "'\"'\"'")}'`;
}

function isMissingFileError(error) {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

function runCli() {
  const action = process.argv[2];

  if (action === "install") {
    const result = installDevLauncher();
    console.log(`Installed ${DEV_LAUNCHER_NAME}: ${result.launcherPath}`);
    return;
  }

  if (action === "uninstall") {
    const result = uninstallDevLauncher();
    console.log(
      result.removed
        ? `Removed ${DEV_LAUNCHER_NAME}: ${result.launcherPath}`
        : `${DEV_LAUNCHER_NAME} was not installed: ${result.launcherPath}`
    );
    return;
  }

  throw new Error(`Usage: node scripts/manage-dev-launcher.mjs install|uninstall`);
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    runCli();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`TASKMUX_DEV_LAUNCHER_ERROR: ${message}`);
    process.exitCode = 1;
  }
}
