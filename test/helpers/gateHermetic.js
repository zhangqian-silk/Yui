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
//
// Failure identity: the `test` step streams TAP to a file, and the runner
// parses the stable failing-test fingerprints (file plus nested test path)
// from it. Classification is failure-level: a candidate failure is
// pre-existing only when its fingerprint is proven present on the base. A
// failed test step without fingerprint data cannot prove identity and is
// classified introduced (fail-closed). The other steps keep whole-step
// identity (the step name). A --base run persists a combined record
// (candidate record, base evidence, classification, disposition) so the
// saved evidence is consumable without re-running anything.

import { execFileSync } from "node:child_process";
import { accessSync, constants, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, sep } from "node:path";
import { fileURLToPath } from "node:url";

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

/**
 * Pick a short base directory for the gate's TMPDIR. Unix domain sockets live
 * under TMPDIR and are capped at 108 chars on Linux; a deep host tmpdir (some
 * CI runners, sandboxed homes) would push the Controller and tmux socket
 * paths past that limit and break the suite mid-gate. `/tmp` is used when it
 * is a writable directory on Linux/macOS; every other platform falls back to
 * the host tmpdir. The gate still creates a unique subdirectory per run, so
 * isolation is preserved.
 */
export function shortTmpBase(platform = process.platform) {
  if (platform === "linux" || platform === "darwin") {
    try {
      accessSync("/tmp", constants.R_OK | constants.W_OK | constants.X_OK);
      return "/tmp";
    } catch {
      // Not usable here; fall through to the host tmpdir.
    }
  }
  return tmpdir();
}

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
 * The basename of the TAP stream the `test` step writes under the gate's
 * TMPDIR. The step streams the live `spec` reporter to stdout and the `tap`
 * reporter to this file; the runner parses the file for stable failing-test
 * fingerprints. The file lives under TMPDIR (not the checkout) so the gated
 * tree stays pristine.
 */
export const TEST_STEP_TAP_BASENAME = "test-gate.tap";

/**
 * The ordered gate steps. Each step has a stable `name` (used by the record
 * and by failure classification) and the exact shell command to run. The
 * `test` step additionally names its TAP destination (relative to the gate
 * TMPDIR) so the runner can attach failure fingerprints to its check.
 */
export const GATE_STEPS = Object.freeze([
  Object.freeze({ name: "install", command: "npm ci" }),
  Object.freeze({ name: "build", command: "npm run build" }),
  Object.freeze({ name: "lint", command: "npm run lint" }),
  Object.freeze({
    name: "test",
    tapDestination: TEST_STEP_TAP_BASENAME,
    // The npm `test` script cannot forward reporter flags (node treats flags
    // after the positional test files as more files), so the gate invokes the
    // script's underlying command directly. The `build` step already produced
    // dist/, so the pretest build is not needed here.
    command:
      "env -u FORCE_COLOR -u YUI_TEST_KEEP_SESSION_ENV -u YUI_TEST_TIER"
      + " -u YUI_TEST_PRIVILEGED_MANIFEST NO_COLOR=1 node"
      + " --import ./test/helpers/scrubSessionEnv.js --test"
      + " --test-reporter=spec --test-reporter-destination=stdout"
      + " --test-reporter=tap --test-reporter-destination=\"$TMPDIR/"
      + TEST_STEP_TAP_BASENAME + "\""
      + " test/*.test.js test/core/*.test.js"
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

/**
 * The plan for gating a candidate commit: a fresh detached worktree at the
 * resolved SHA, never the source checkout. The source checkout is only used
 * for git operations; uncommitted or untracked content there can never enter
 * the gated tree, so a dirty checkout cannot produce pass evidence labeled
 * with a clean HEAD SHA.
 */
export function planCandidateCheckout({ root, sha }) {
  const checkout = join(root, "worktree-candidate");
  return Object.freeze({
    sha,
    checkout,
    addArgs: Object.freeze(["worktree", "add", "--detach", checkout, sha])
  });
}

function stripCheckoutPrefix(path, checkout) {
  if (checkout !== "" && path.startsWith(checkout + sep)) {
    return path.slice(checkout.length + 1);
  }
  return path;
}

/** Normalize a TAP path token (a `location` value or a file subtest name). */
function normalizeTapPath(value, checkout) {
  let path = value.trim();
  if (path.startsWith("file://")) {
    try {
      path = fileURLToPath(path);
    } catch {
      return value;
    }
  }
  return stripCheckoutPrefix(path, checkout);
}

/**
 * Parse the stable failing-test fingerprints from a TAP stream.
 *
 * A fingerprint is the repo-relative test file (from the YAML `location` of
 * each `not ok` result, normalized against the checkout) joined with the
 * nested test path (built from the `# Subtest:` comments). The TAP test
 * numbers are deliberately excluded: they shift when tests are added or
 * reordered, so a number would misclassify an unchanged failure as
 * introduced. Both the flat (Node 20) and file-wrapped (Node 22+) TAP
 * layouts are handled: a file-wrapper subtest name is normalized to the
 * same repo-relative path and de-duplicated against the `location` file.
 *
 * Returns a sorted, de-duplicated list. An empty list means the stream
 * carried no failing-test identity (for example a runner crash), which the
 * classifier treats as unprovable identity (fail-closed).
 */
export function parseTapFailureFingerprints(tapText, { checkout = "" } = {}) {
  const fingerprints = new Set();
  const stack = [];
  let pending = null;

  const flush = () => {
    if (pending !== null) {
      fingerprints.add(pending.path.join(" > "));
      pending = null;
    }
  };

  for (const line of tapText.split(/\r?\n/u)) {
    if (pending !== null && pending.yamlIndent !== -1) {
      const endMatch = /^(\s*)\.\.\.\s*$/.exec(line);
      if (endMatch !== null && endMatch[1].length === pending.yamlIndent) {
        flush();
        continue;
      }
      const locationMatch = /^(\s*)location:\s*(.*?)\s*$/.exec(line);
      if (locationMatch !== null && locationMatch[1].length === pending.yamlIndent) {
        const raw = locationMatch[2]
          .replace(/^'(.*)'$/u, "$1")
          .replace(/:\d+:\d+$/u, "");
        const file = normalizeTapPath(raw, checkout);
        if (file !== "") {
          pending.path = [file, ...pending.path.filter((entry) => entry !== file)];
        }
      }
      continue;
    }

    const subtestMatch = /^(\s*)# Subtest: (.*\S)\s*$/.exec(line);
    if (subtestMatch !== null) {
      flush();
      const indent = subtestMatch[1].length;
      while (stack.length > 0 && stack[stack.length - 1].indent >= indent) {
        stack.pop();
      }
      stack.push({ indent, name: normalizeTapPath(subtestMatch[2], checkout) });
      continue;
    }

    const notOkMatch = /^(\s*)not ok \d+ - (.*\S)\s*$/.exec(line);
    if (notOkMatch !== null) {
      flush();
      const indent = notOkMatch[1].length;
      const parents = stack
        .filter((entry) => entry.indent < indent)
        .map((entry) => entry.name);
      // In the file-wrapped TAP layout the file wrapper's own `not ok` uses
      // the absolute file path as its name; normalize it like a subtest name.
      pending = {
        path: [...parents, normalizeTapPath(notOkMatch[2], checkout)],
        yamlIndent: -1
      };
      continue;
    }

    const yamlStart = /^(\s*)---\s*$/.exec(line);
    if (pending !== null && yamlStart !== null) {
      pending.yamlIndent = yamlStart[1].length;
    }
  }
  flush();
  return [...fingerprints].sort();
}

/**
 * Build the frozen per-SHA gate record. `checks` is the ordered list of
 * `{ name, status, durationMs, failures? }` results; a failed `test` check
 * carries its sorted failure fingerprints (an empty array means the step
 * failed without provable identity). `hermetic` is the environment the steps
 * ran in. `npmVersion` and `now` are injectable for deterministic unit tests.
 * The record passes only when every check passed.
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
    checks: checks.map((check) => {
      const recorded = {
        name: check.name,
        status: check.status,
        durationMs: check.durationMs
      };
      if (Array.isArray(check.failures)) {
        recorded.failures = [...check.failures].sort();
      }
      return recorded;
    })
  });
}

function checkPassed(record, name) {
  const check = record.checks.find((candidate) => candidate.name === name);
  return check !== undefined && check.status === "pass";
}

function checkByName(record, name) {
  return record.checks.find((candidate) => candidate.name === name);
}

function qualifyFailure(stepName, failure) {
  return `${stepName}: ${failure}`;
}

/**
 * Classify a candidate gate record against a base record at failure level.
 *
 * For a check carrying failure fingerprints (the `test` step), identity is
 * the fingerprint set: a candidate failure is `preExisting` only when its
 * fingerprint is proven present on the base (candidate failures are a subset
 * of the base's); a candidate fingerprint the base does not have is
 * `introduced`; a base fingerprint the candidate no longer has is `fixed`.
 * When the check failed on either side without fingerprint data, identity
 * cannot be proven and the failure is `introduced` (fail-closed): a red base
 * must never swallow an unidentifiable new failure.
 *
 * The other steps keep whole-step identity (the step name): failing on both
 * is `preExisting`, failing only on the candidate is `introduced`, passing
 * on the candidate while the base failed is `fixed`. A check absent on one
 * side counts as failing on that side, so a missing check is never silently
 * treated as a pass.
 *
 * Fingerprint-level entries are qualified as `<step>: <fingerprint>` so the
 * classification stays human-readable.
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
    const candidateCheck = checkByName(candidateRecord, name);
    const baseCheck = checkByName(baseRecord, name);
    const candidateFailed = !checkPassed(candidateRecord, name);
    const baseFailed = !checkPassed(baseRecord, name);
    if (!candidateFailed && !baseFailed) {
      continue;
    }
    const candidateFailures = candidateCheck?.failures;
    const baseFailures = baseCheck?.failures;
    if (Array.isArray(candidateFailures) || Array.isArray(baseFailures)) {
      // Fingerprint identity: prove every candidate failure against the base.
      if (candidateFailed && baseFailed) {
        if (
          Array.isArray(candidateFailures)
          && Array.isArray(baseFailures)
          && candidateFailures.length > 0
          && baseFailures.length > 0
        ) {
          const baseSet = new Set(baseFailures);
          const candidateSet = new Set(candidateFailures);
          for (const failure of candidateFailures) {
            (baseSet.has(failure) ? preExisting : introduced).push(
              qualifyFailure(name, failure)
            );
          }
          for (const failure of baseFailures) {
            if (!candidateSet.has(failure)) {
              fixed.push(qualifyFailure(name, failure));
            }
          }
        } else {
          // Failed on both sides but identity is missing on at least one.
          introduced.push(name);
        }
      } else if (candidateFailed) {
        // The base passed: every candidate failure is introduced.
        if (Array.isArray(candidateFailures) && candidateFailures.length > 0) {
          introduced.push(...candidateFailures.map((f) => qualifyFailure(name, f)));
        } else {
          introduced.push(name);
        }
      } else {
        // The candidate passed: everything the base failed with is fixed.
        if (Array.isArray(baseFailures) && baseFailures.length > 0) {
          fixed.push(...baseFailures.map((f) => qualifyFailure(name, f)));
        } else {
          fixed.push(name);
        }
      }
    } else if (candidateFailed && baseFailed) {
      preExisting.push(name);
    } else if (candidateFailed) {
      introduced.push(name);
    } else {
      fixed.push(name);
    }
  }
  return deepFreeze({
    introduced: introduced.sort(),
    preExisting: preExisting.sort(),
    fixed: fixed.sort()
  });
}

/**
 * The gate process exit code for a run. A passing candidate exits 0. A failing
 * candidate without a base exits 1 (the failure is unclassified and blocks).
 * With a base classification, only introduced failures exit 1; pre-existing
 * failures exit 0 so a red base never blocks a change that did not cause the
 * failure. `classification` is null when no --base run happened.
 */
export function gateExitCode(candidateRecord, classification = null) {
  if (candidateRecord.result === "pass") {
    return 0;
  }
  if (classification === null) {
    return 1;
  }
  return classification.introduced.length > 0 ? 1 : 0;
}

/**
 * The human-readable disposition of a gate run, aligned with the exit code:
 * `pass` for a green candidate, `unclassified-failure` for a red candidate
 * without a base comparison, `introduced-failures` when the classification
 * found introduced failures, and `pre-existing-only` when every candidate
 * failure is proven pre-existing on the base.
 */
export function gateDisposition(candidateRecord, classification = null) {
  if (candidateRecord.result === "pass") {
    return "pass";
  }
  if (classification === null) {
    return "unclassified-failure";
  }
  return classification.introduced.length > 0
    ? "introduced-failures"
    : "pre-existing-only";
}

/**
 * Build the frozen combined record for a --base run. The top-level `sha` and
 * `result` stay the candidate's (the publish-lane contract: those two fields
 * alone decide releasability), while the full candidate record, the base SHA
 * and record, the failure-level classification, the disposition, and a fresh
 * timestamp make the saved evidence self-contained: nothing is re-run or
 * deleted to consume it.
 */
export function buildCombinedGateRecord({ candidate, base, baseSha, classification, now }) {
  const timestamp = (now ?? (() => new Date()))().toISOString();
  return deepFreeze({
    sha: candidate.sha,
    result: candidate.result,
    candidate,
    baseSha,
    base,
    classification,
    disposition: gateDisposition(candidate, classification),
    timestamp
  });
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
