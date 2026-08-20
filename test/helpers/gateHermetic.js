// Pure building blocks for scripts/gate-hermetic.mjs. The gate verifies one
// exact commit in a fresh clone and isolated process environment. It never
// re-runs history or classifies current failures against an older baseline.

import { execFileSync } from "node:child_process";
import { accessSync, constants, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

export const STANDARD_SYSTEM_PATH = Object.freeze([
  "/usr/local/sbin",
  "/usr/local/bin",
  "/usr/sbin",
  "/usr/bin",
  "/sbin",
  "/bin"
]);

const PATH_TOOLS = Object.freeze(["node", "npm", "git", "tmux"]);
const STRIPPED_GIT_ENV_VARS = Object.freeze([
  "GIT_CONFIG_SYSTEM",
  "GIT_CONFIG_PARAMETERS",
  "GIT_CONFIG_COUNT",
  "GIT_TEMPLATE_DIR",
  "GIT_DIR",
  "GIT_WORK_TREE",
  "GIT_COMMON_DIR",
  "GIT_INDEX_FILE",
  "GIT_OBJECT_DIRECTORY",
  "GIT_ALTERNATE_OBJECT_DIRECTORIES"
]);

function isStrippedGitEnvVar(name) {
  return STRIPPED_GIT_ENV_VARS.includes(name)
    || /^GIT_CONFIG_(?:KEY|VALUE)_\d+$/u.test(name);
}

export function shortTmpBase(platform = process.platform) {
  if (platform === "linux" || platform === "darwin") {
    try {
      accessSync("/tmp", constants.R_OK | constants.W_OK | constants.X_OK);
      return "/tmp";
    } catch {
      // Fall back to the host temp directory.
    }
  }
  return tmpdir();
}

function deepFreeze(value) {
  if (value === null || typeof value !== "object" || Object.isFrozen(value)) {
    return value;
  }
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

export function resolveToolPath(name, environment = process.env) {
  if (name === "node") return process.execPath;
  for (const entry of (environment.PATH ?? "").split(delimiter)) {
    if (entry.length === 0) continue;
    const candidate = join(entry, name);
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      // Keep searching PATH.
    }
  }
  return null;
}

export function resolveToolDirectory(name, environment = process.env) {
  const path = resolveToolPath(name, environment);
  return path === null ? null : dirname(path);
}

export function buildHermeticEnvironment(root, options = {}) {
  const environment = options.environment ?? process.env;
  const toolDirs = PATH_TOOLS
    .map((name) => resolveToolDirectory(name, environment))
    .filter((dir) => dir !== null);
  const inherited = {};
  for (const [name, value] of Object.entries(environment)) {
    if (!isStrippedGitEnvVar(name)) inherited[name] = value;
  }
  return {
    ...inherited,
    HOME: options.home ?? join(root, "home"),
    XDG_CONFIG_HOME: options.xdgConfigHome ?? join(root, "xdg-config"),
    XDG_CACHE_HOME: options.xdgCacheHome ?? join(root, "xdg-cache"),
    XDG_DATA_HOME: options.xdgDataHome ?? join(root, "xdg-data"),
    GIT_CONFIG_GLOBAL: options.gitConfigGlobal ?? join(root, "gitconfig"),
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_TEMPLATE_DIR: options.gitTemplateDir ?? join(root, "git-template"),
    TMPDIR: options.tmpdir ?? join(root, "tmp"),
    npm_config_cache: options.npmCache ?? join(root, "npm-cache"),
    PATH: [...new Set([...toolDirs, ...STANDARD_SYSTEM_PATH])].join(delimiter)
  };
}

/**
 * Top-level test files excluded from the hermetic gate's `test` step.
 *
 * These are diagnostic tools and one-time storage-upgrade regressions for
 * already-validated migrations. They remain in `npm test` for local
 * development but are skipped in CI to keep the PR gate fast. The gate
 * still runs every `test/core/*.test.js` file plus the E2E, mock-agent,
 * and storage-lifecycle suites that guard active behavior.
 */
const GATE_EXCLUDED_TEST_PATTERN = "diagnostic|storage-upgrade-.*-regressions";
const GATE_TEST_RUNNER =
  "env -u FORCE_COLOR -u YUI_TEST_KEEP_SESSION_ENV -u YUI_TEST_TIER"
  + " -u YUI_TEST_PRIVILEGED_MANIFEST NO_COLOR=1 node"
  + " --import ./test/helpers/scrubSessionEnv.js --test";

// This file asserts bounded process-exit timing against real local processes.
// CI runs it on its own fresh runner, so the hermetic core gate must exclude it.
const GATE_PROCESS_LIFECYCLE_TEST = "test/core/session-reconcile-e2e.test.js";

export const GATE_STEPS = Object.freeze([
  Object.freeze({ name: "install", command: "npm ci" }),
  Object.freeze({ name: "build", command: "npm run build" }),
  Object.freeze({ name: "lint", command: "npm run lint" }),
  Object.freeze({
    name: "test",
    // The build step already established the src -> dist boundary, so invoke
    // the test command directly instead of triggering package pretest again.
    command:
      GATE_TEST_RUNNER
      + " $(ls test/*.test.js | grep -v -E '" + GATE_EXCLUDED_TEST_PATTERN + "')"
      + " $(ls test/core/*.test.js | grep -v -F '" + GATE_PROCESS_LIFECYCLE_TEST + "')"
  }),
  Object.freeze({
    name: "package-smoke",
    command:
      "node scripts/assemble-runtime-package.mjs --output .release-stage"
      + " && npm pack ./.release-stage --dry-run --ignore-scripts --json"
      + " > package-smoke.json"
      + " && node scripts/check-runtime-package-structure.mjs package-smoke.json"
  })
]);

function resolveNpmVersion(hermetic) {
  try {
    return execFileSync("npm", ["--version"], {
      encoding: "utf8",
      env: hermetic,
      stdio: ["ignore", "pipe", "ignore"]
    }).trim();
  } catch {
    return "unknown";
  }
}

export function planGateCheckout({ root, sha, source }) {
  const checkout = join(root, "checkout");
  return Object.freeze({
    sha,
    checkout,
    cloneArgs: Object.freeze([
      "clone",
      "--quiet",
      "--no-hardlinks",
      "--no-checkout",
      source,
      checkout
    ]),
    detachArgs: Object.freeze(["checkout", "--detach", "--quiet", sha])
  });
}

export function buildGateRecord({ sha, ref, checks, hermetic, npmVersion, now }) {
  return deepFreeze({
    sha,
    ref,
    result: checks.every((check) => check.status === "pass") ? "pass" : "fail",
    timestamp: (now ?? (() => new Date()))().toISOString(),
    node: process.version,
    npm: npmVersion ?? resolveNpmVersion(hermetic),
    platform: process.platform,
    hermetic: {
      home: hermetic.HOME,
      xdgConfigHome: hermetic.XDG_CONFIG_HOME,
      gitConfigGlobal: hermetic.GIT_CONFIG_GLOBAL,
      gitConfigNoSystem: hermetic.GIT_CONFIG_NOSYSTEM,
      gitTemplateDir: hermetic.GIT_TEMPLATE_DIR,
      tmpdir: hermetic.TMPDIR,
      npmCache: hermetic.npm_config_cache,
      pathEntries: hermetic.PATH.split(delimiter)
    },
    checks: checks.map(({ name, status, durationMs }) => ({ name, status, durationMs }))
  });
}

export function writeHermeticGitConfig(path) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(
    path,
    "[user]\n\tname = Yui Gate\n\temail = yui-gate@example.invalid\n",
    { encoding: "utf8", mode: 0o600 }
  );
}

export function createGateDomain(root, tmpHome, options = {}) {
  const hermetic = buildHermeticEnvironment(root, {
    npmCache: options.npmCache,
    tmpdir: tmpHome
  });
  for (const dir of [
    hermetic.HOME,
    hermetic.XDG_CONFIG_HOME,
    hermetic.XDG_CACHE_HOME,
    hermetic.XDG_DATA_HOME,
    hermetic.GIT_TEMPLATE_DIR,
    hermetic.TMPDIR,
    hermetic.npm_config_cache
  ]) mkdirSync(dir, { recursive: true });
  writeHermeticGitConfig(hermetic.GIT_CONFIG_GLOBAL);
  return hermetic;
}

const FULL_SHA = /^[0-9a-f]{40}$/u;

export function isFullSha(value) {
  return typeof value === "string" && FULL_SHA.test(value);
}

export function recordPathPrefixes(cwd, recordPath) {
  if (recordPath === undefined || recordPath === "-") return [];
  const relativePath = relative(cwd, resolve(cwd, recordPath));
  if (relativePath === "" || relativePath.startsWith("..") || isAbsolute(relativePath)) {
    return [];
  }
  const parts = relativePath.split(sep).filter((entry) => entry !== "");
  return parts.map((_, index) => parts.slice(0, index + 1).join(sep));
}

export function assertCleanSourceCheckout(cwd, { env = process.env, except = [] } = {}) {
  let porcelain;
  try {
    porcelain = execFileSync("git", ["status", "--porcelain"], {
      cwd,
      env,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"]
    });
  } catch (error) {
    throw new Error(
      `cannot verify source checkout cleanliness: ${error instanceof Error ? error.message : String(error)}`
    );
  }
  const exceptSet = new Set(except);
  const dirty = porcelain.split(/\r?\n/u).filter((line) => {
    if (line.trim() === "") return false;
    const status = line.slice(0, 2);
    const path = line.slice(3).replace(/\/$/u, "");
    return status !== "??" || !exceptSet.has(path);
  });
  if (dirty.length > 0) {
    throw new Error(
      `source checkout is dirty; refusing to gate (commit or stash first): ${dirty
        .slice(0, 5)
        .join(" | ")}`
    );
  }
}
