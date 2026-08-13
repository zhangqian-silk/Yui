// Pure, unit-testable building blocks for the hermetic gate runner
// (scripts/gate-hermetic.mjs). No side effects at import: every function
// derives its result from its arguments and the process state at call time.
//
// The hermetic gate runs the full PR gate (install, build, lint, the
// deterministic suite, package smoke) inside an isolated HOME, XDG tree, git
// identity, temp dir, and npm cache, with a sanitized PATH, so the exact
// commit is verified the same way on a developer machine and in CI. Each run
// persists a per-SHA JSON record (the gate result), and a --base run
// classifies introduced vs pre-existing failures against a base commit.

import { execFileSync } from "node:child_process";
import { accessSync, mkdirSync, writeFileSync } from "node:fs";
import { delimiter, dirname, join } from "node:path";

/** Standard system PATH entries, in order, after the resolved tool dirs. */
export const STANDARD_SYSTEM_PATH = Object.freeze([
  "/usr/local/sbin",
  "/usr/local/bin",
  "/usr/sbin",
  "/usr/bin",
  "/sbin",
  "/bin"
]);

/** Tools whose directories must lead the sanitized PATH, in order. */
const PATH_TOOLS = Object.freeze(["node", "npm", "git", "tmux"]);

function deepFreeze(value) {
  if (value === null || typeof value !== "object" || Object.isFrozen(value)) {
    return value;
  }
  for (const child of Object.values(value)) {
    deepFreeze(child);
  }
  return Object.freeze(value);
}

/**
 * Resolve a tool's absolute path by searching PATH in the given environment
 * (the current process env at call time), or null when it cannot be found.
 * `node` is always the running interpreter (process.execPath).
 */
export function resolveToolPath(name, environment = process.env) {
  if (name === "node") {
    return process.execPath;
  }
  const pathEnv = environment.PATH ?? "";
  for (const entry of pathEnv.split(delimiter)) {
    if (entry.length === 0) {
      continue;
    }
    const candidate = join(entry, name);
    try {
      accessSync(candidate, 1 /* X_OK */);
      return candidate;
    } catch {
      // Not executable here; keep scanning.
    }
  }
  return null;
}

/** Directory containing the resolved tool, or null when the tool is absent. */
export function resolveToolDirectory(name, environment = process.env) {
  const resolved = resolveToolPath(name, environment);
  return resolved === null ? null : dirname(resolved);
}

/**
 * Build the hermetic environment for a gate run rooted at `root`.
 *
 * Overrides the host paths that would otherwise leak per-user or per-machine
 * state (HOME, the XDG trio, the global git identity, TMPDIR, the npm cache)
 * with fresh locations under `root`, and replaces PATH with the directories
 * of node/npm/git/tmux (resolved from the current process env at call time)
 * followed by the standard system directories, de-duplicated in that order.
 * Every other host env var is inherited.
 *
 * `options` overrides any derived path (home, xdgConfigHome, xdgCacheHome,
 * xdgDataHome, gitConfigGlobal, tmpdir, npmCache) and may supply `environment`
 * as the source env instead of process.env (used by the unit tests).
 */
export function buildHermeticEnvironment(root, options = {}) {
  const environment = options.environment ?? process.env;
  const toolDirs = PATH_TOOLS
    .map((name) => resolveToolDirectory(name, environment))
    .filter((dir) => dir !== null);
  const pathEntries = [...new Set([...toolDirs, ...STANDARD_SYSTEM_PATH])];

  return {
    ...environment,
    HOME: options.home ?? join(root, "home"),
    XDG_CONFIG_HOME: options.xdgConfigHome ?? join(root, "xdg-config"),
    XDG_CACHE_HOME: options.xdgCacheHome ?? join(root, "xdg-cache"),
    XDG_DATA_HOME: options.xdgDataHome ?? join(root, "xdg-data"),
    GIT_CONFIG_GLOBAL: options.gitConfigGlobal ?? join(root, "gitconfig"),
    TMPDIR: options.tmpdir ?? join(root, "tmp"),
    npm_config_cache: options.npmCache ?? join(root, "npm-cache"),
    PATH: pathEntries.join(delimiter)
  };
}

/**
 * The ordered gate steps. Each step has a stable `name` (used by the record
 * and by failure classification) and the exact shell command to run.
 */
export const GATE_STEPS = Object.freeze([
  Object.freeze({ name: "install", command: "npm ci" }),
  Object.freeze({ name: "build", command: "npm run build" }),
  Object.freeze({ name: "lint", command: "npm run lint" }),
  Object.freeze({ name: "test", command: "npm test" }),
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

/**
 * Build the frozen per-SHA gate record. `checks` is the ordered list of
 * `{ name, status, durationMs }` results; `hermetic` is the environment the
 * steps ran in. `npmVersion` and `now` are injectable for deterministic unit
 * tests. The record passes only when every check passed.
 */
export function buildGateRecord({ sha, ref, checks, hermetic, npmVersion, now }) {
  const timestamp = (now ?? (() => new Date()))().toISOString();
  return deepFreeze({
    sha,
    ref,
    result: checks.every((check) => check.status === "pass") ? "pass" : "fail",
    timestamp,
    node: process.version,
    npm: npmVersion ?? resolveNpmVersion(hermetic),
    platform: process.platform,
    hermetic: {
      home: hermetic.HOME,
      xdgConfigHome: hermetic.XDG_CONFIG_HOME,
      gitConfigGlobal: hermetic.GIT_CONFIG_GLOBAL,
      tmpdir: hermetic.TMPDIR,
      npmCache: hermetic.npm_config_cache,
      pathEntries: hermetic.PATH.split(delimiter)
    },
    checks: checks.map((check) => ({
      name: check.name,
      status: check.status,
      durationMs: check.durationMs
    }))
  });
}

function checkPassed(record, name) {
  const check = record.checks.find((candidate) => candidate.name === name);
  return check !== undefined && check.status === "pass";
}

/**
 * Classify a candidate gate record against a base record. A check failing on
 * the candidate but passing on the base is `introduced`; failing on both is
 * `preExisting`; passing on the candidate but failing on the base is `fixed`.
 * A check absent on one side counts as failing on that side, so a missing
 * check is never silently treated as a pass.
 */
export function classifyGateResults(candidateRecord, baseRecord) {
  const names = [
    ...new Set([
      ...candidateRecord.checks.map((check) => check.name),
      ...baseRecord.checks.map((check) => check.name)
    ])
  ];
  const introduced = [];
  const preExisting = [];
  const fixed = [];
  for (const name of names) {
    const candidatePassed = checkPassed(candidateRecord, name);
    const basePassed = checkPassed(baseRecord, name);
    if (!candidatePassed && basePassed) {
      introduced.push(name);
    } else if (!candidatePassed && !basePassed) {
      preExisting.push(name);
    } else if (candidatePassed && !basePassed) {
      fixed.push(name);
    }
  }
  return deepFreeze({ introduced, preExisting, fixed });
}

/**
 * Write the hermetic global git identity at `path` (the GIT_CONFIG_GLOBAL
 * target), so gate git operations never read or write the developer's real
 * ~/.gitconfig.
 */
export function writeHermeticGitConfig(path) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(
    path,
    "[user]\n\tname = Yui Gate\n\temail = yui-gate@example.invalid\n",
    { encoding: "utf8", mode: 0o600 }
  );
}
