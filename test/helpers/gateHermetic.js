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
// classified introduced (fail-closed). A file-wrapper failure (a test file
// that crashed before registering tests) carries only the file path as
// identity, which cannot distinguish two different failures in the same
// file, so it additionally requires the crash error parsed from the TAP
// comments; without that positive diagnostic it contributes no fingerprint
// (fail-closed). The non-test steps carry no stable failure identity at all,
// so a failure on both sides is introduced (fail-closed): a red base must
// never swallow a failure the gate cannot prove is the same. A --base run
// persists a combined record (candidate record, base evidence, classification,
// disposition) so the saved evidence is consumable without re-running anything.

import { execFileSync } from "node:child_process";
import { accessSync, constants, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
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
 * Host Git control environment variables that can redirect config, templates,
 * the repository/common dir, the index, or the object store. Inheriting any
 * of these would let one side's writable state reach the other: a candidate
 * test could point GIT_CONFIG_SYSTEM at a host-writable file, set
 * core.hooksPath in it, and the base clone's checkout would run that hook.
 * The hermetic domain strips every one of these (plus the indexed
 * GIT_CONFIG_KEY_<n>/GIT_CONFIG_VALUE_<n> pairs that accompany
 * GIT_CONFIG_COUNT) and re-establishes only the per-side GIT_CONFIG_GLOBAL,
 * GIT_CONFIG_NOSYSTEM, and GIT_TEMPLATE_DIR it needs.
 */
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
  if (STRIPPED_GIT_ENV_VARS.includes(name)) {
    return true;
  }
  // GIT_CONFIG_COUNT's indexed key/value pairs: GIT_CONFIG_KEY_0,
  // GIT_CONFIG_VALUE_0, GIT_CONFIG_KEY_1, ...
  return /^GIT_CONFIG_(?:KEY|VALUE)_\d+$/u.test(name);
}

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
 *
 * Host Git control variables (GIT_CONFIG_SYSTEM, GIT_TEMPLATE_DIR,
 * GIT_CONFIG_PARAMETERS, GIT_CONFIG_COUNT and its indexed key/value pairs,
 * GIT_DIR, GIT_WORK_TREE, GIT_COMMON_DIR, GIT_INDEX_FILE,
 * GIT_OBJECT_DIRECTORY, GIT_ALTERNATE_OBJECT_DIRECTORIES) are stripped: they
 * can redirect config, templates, the repository/common dir, the index, or
 * the object store, so inheriting them would let one side's writable state
 * reach the other (a candidate test could write core.hooksPath to a
 * host-writable GIT_CONFIG_SYSTEM file and the base checkout would run that
 * hook). The domain re-establishes only the per-side GIT_CONFIG_GLOBAL,
 * GIT_CONFIG_NOSYSTEM, and an empty per-side GIT_TEMPLATE_DIR. Every other
 * host env var is inherited.
 *
 * `options` overrides any derived path (home, xdgConfigHome, xdgCacheHome,
 * xdgDataHome, gitConfigGlobal, gitTemplateDir, tmpdir, npmCache) and may
 * supply `environment` as the source env instead of process.env (used by the
 * unit tests).
 */
export function buildHermeticEnvironment(root, options = {}) {
  const environment = options.environment ?? process.env;
  const toolDirs = PATH_TOOLS
    .map((name) => resolveToolDirectory(name, environment))
    .filter((dir) => dir !== null);
  const pathEntries = [...new Set([...toolDirs, ...STANDARD_SYSTEM_PATH])];

  // Strip host Git control variables that could redirect config, templates,
  // the repository/common dir, the index, or the object store. Inheriting
  // any of these would let one side's writable state reach the other.
  const inherited = {};
  for (const [name, value] of Object.entries(environment)) {
    if (!isStrippedGitEnvVar(name)) {
      inherited[name] = value;
    }
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
 * The plan for gating one side (candidate or base) at a commit: a fresh
 * clone of the source checkout, detached at the resolved SHA — never the
 * source checkout itself and never a `git worktree add` of it. The source
 * checkout only answers git questions, so uncommitted or untracked content
 * there can never enter the gated tree, and a dirty checkout cannot produce
 * pass evidence labeled with a clean HEAD SHA.
 *
 * A clone owns its .git directory: its hooks, config, and refs are private
 * to it, unlike `git worktree add`, whose worktrees share the source's
 * common dir. A test that resolves its git common dir and plants a hook or
 * flips an executable config (core.hooksPath, core.fsmonitor, ...) can
 * therefore never reach the other side's checkout. `--no-checkout` keeps
 * the clone itself from checking out (and running hooks for) the source
 * HEAD, and `--no-hardlinks` avoids hardlinking the source's object store.
 * (A reference/shared source could still contribute alternates; objects are
 * content-addressed and a corrupt one fails closed, so this is not a
 * writable-state vector.) The host Git control env is stripped separately
 * by buildHermeticEnvironment, so GIT_CONFIG_SYSTEM/GIT_TEMPLATE_DIR and
 * the other redirectors cannot bridge the two sides either.
 *
 * `cloneArgs` run with the source checkout as cwd and the side's hermetic
 * env; `detachArgs` then run inside the clone with the same env.
 */
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
 * A test-file path in a `not ok` name. Node wraps a test file that crashed
 * before registering tests in a top-level `not ok` named after the file
 * (the basename on Node 22+, the full path on Node 20). Such a wrapper
 * carries only the file as identity and needs the crash diagnostic to
 * distinguish different failures in the same file.
 */
const TEST_FILE_PATH = /\.(?:test|spec)\.(?:js|mjs|cjs)$/u;

/**
 * A crash diagnostic printed as a TAP comment: `# <Type>Error: <message>`.
 * Node prints the uncaught error this way before the file-wrapper subtest,
 * while the wrapper's own YAML `error:` stays the generic `'test failed'`.
 * The captured `<Type>: <message>` first line is the stable diagnostic. The
 * type is captured as a word and then checked for an Error/Exception suffix
 * (a single greedy regex cannot match a word that ends in its own suffix).
 */
const ERROR_COMMENT = /^#\s*([A-Za-z_$][\w$]*)\s*:\s*(.*\S)\s*$/u;
const ERROR_TYPE_SUFFIX = /(?:Error|Exception)$/u;

/** The longest diagnostic signature kept, so a pathological error line cannot bloat a record. */
const MAX_DIAGNOSTIC_LENGTH = 200;

function normalizeErrorSignature(signature, checkout) {
  let normalized = signature.trim();
  if (checkout !== "") {
    // The base and candidate gate in different worktrees; normalize the
    // worktree path out of a diagnostic (e.g. a module-not-found error) so
    // the same failure produces the same signature on both sides.
    normalized = normalized.split(checkout).join("<checkout>");
  }
  return normalized.length > MAX_DIAGNOSTIC_LENGTH
    ? normalized.slice(0, MAX_DIAGNOSTIC_LENGTH)
    : normalized;
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
 * A file-wrapper `not ok` (a file that crashed before registering tests)
 * carries only the file path as identity, which cannot distinguish two
 * different failures in the same file. Such a result additionally requires
 * the crash diagnostic (the `# <Type>Error: <message>` comment Node prints
 * for the uncaught error): the fingerprint becomes `<file> :: <Type>:
 * <message>`, so a base error A and a candidate error B in the same file
 * produce different fingerprints. A wrapper without a diagnostic
 * contributes no fingerprint: its identity is unprovable, and the
 * classifier treats the empty failure list as introduced (fail-closed).
 *
 * Returns a sorted, de-duplicated list. An empty list means the stream
 * carried no failing-test identity (for example a runner crash), which the
 * classifier treats as unprovable identity (fail-closed).
 */
export function parseTapFailureFingerprints(tapText, { checkout = "" } = {}) {
  const fingerprints = new Set();
  const stack = [];
  let pending = null;
  let pendingErrorComment = null;

  const flush = () => {
    if (pending !== null) {
      if (pending.isFileWrapper) {
        // The file path alone cannot prove which failure this is; require the
        // crash diagnostic. Without it the failure has no fingerprint and is
        // classified introduced (fail-closed).
        if (pending.diagnostic !== null) {
          const file = pending.path[0];
          if (file !== undefined && file !== "") {
            fingerprints.add(`${file} :: ${pending.diagnostic}`);
          }
        }
      } else {
        fingerprints.add(pending.path.join(" > "));
      }
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
          if (pending.isFileWrapper) {
            // The location is the authoritative repo-relative file for a
            // wrapper (the `not ok` name may be just a basename).
            pending.path = [file];
          } else {
            pending.path = [file, ...pending.path.filter((entry) => entry !== file)];
          }
        }
      }
      continue;
    }

    const errorCommentMatch = ERROR_COMMENT.exec(line);
    if (errorCommentMatch !== null && ERROR_TYPE_SUFFIX.test(errorCommentMatch[1])) {
      // The most recent crash diagnostic before a `not ok` belongs to it.
      pendingErrorComment = normalizeErrorSignature(
        `${errorCommentMatch[1]}: ${errorCommentMatch[2]}`,
        checkout
      );
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
      const rawName = notOkMatch[2];
      const isFileWrapper = TEST_FILE_PATH.test(rawName);
      const parents = stack
        .filter((entry) => entry.indent < indent)
        .map((entry) => entry.name);
      // A file wrapper is the file itself, not a child of the file subtest:
      // its identity is the file (plus the crash diagnostic), not the file
      // subtest's name repeated.
      pending = {
        path: isFileWrapper
          ? [normalizeTapPath(rawName, checkout)]
          : [...parents, normalizeTapPath(rawName, checkout)],
        yamlIndent: -1,
        isFileWrapper,
        diagnostic: pendingErrorComment
      };
      pendingErrorComment = null;
      continue;
    }

    // A passing result ends any pending diagnostic window: a crash diagnostic
    // is always consumed by the next `not ok`, so a stale one must not leak
    // into a later failure.
    if (/^(\s*)ok \d+ -/u.test(line)) {
      pendingErrorComment = null;
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
      gitConfigNoSystem: hermetic.GIT_CONFIG_NOSYSTEM,
      gitTemplateDir: hermetic.GIT_TEMPLATE_DIR,
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
 * The other steps carry no stable failure identity (a lint error and a build
 * error have no comparable fingerprint), so a failure on both sides is
 * `introduced` (fail-closed): a red base must never swallow a failure the
 * gate cannot prove is the same. Failing only on the candidate is
 * `introduced`; passing on the candidate while the base failed is `fixed`. A
 * check absent on one side counts as failing on that side, so a missing
 * check is never silently treated as a pass.
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
      // No fingerprint identity on either side: the gate cannot prove the
      // two failures are the same, so a red base must not swallow this.
      introduced.push(name);
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

/**
 * Create one side's hermetic domain for a --base gate run.
 *
 * The candidate and the base must gate in fully isolated domains: a side
 * that writes to HOME, the XDG tree, the npm cache, or TMPDIR must never be
 * able to change the other side's result. The --base classification compares
 * the two records, so shared writable state would let a candidate poison the
 * base (or vice versa) and misclassify an introduced failure as pre-existing.
 *
 * Each side gets its own root (HOME, XDG, git config, npm cache) and its own
 * TMPDIR (the test step's TAP stream lives there). `side` names the domain
 * ("candidate" or "base") and, when a shared npm cache was requested with
 * --npm-cache, scopes it per side so the two never share a cache either.
 */
export function createGateSideDomain(root, tmpHome, options = {}, side) {
  const npmCache = options.npmCache !== undefined
    ? join(options.npmCache, side)
    : undefined;
  const hermetic = buildHermeticEnvironment(root, { npmCache, tmpdir: tmpHome });
  for (const dir of [
    hermetic.HOME,
    hermetic.XDG_CONFIG_HOME,
    hermetic.XDG_CACHE_HOME,
    hermetic.XDG_DATA_HOME,
    hermetic.GIT_TEMPLATE_DIR,
    hermetic.TMPDIR,
    hermetic.npm_config_cache
  ]) {
    mkdirSync(dir, { recursive: true });
  }
  writeHermeticGitConfig(hermetic.GIT_CONFIG_GLOBAL);
  return hermetic;
}

/** A full 40-hex commit SHA. The gate never accepts a partial or empty SHA. */
const FULL_SHA = /^[0-9a-f]{40}$/u;

export function isFullSha(value) {
  return typeof value === "string" && FULL_SHA.test(value);
}

/**
 * Resolve the merge base of HEAD and `ref` in the checkout at `cwd`, or
 * `null` when it cannot be computed. A shallow checkout (the actions/checkout
 * default of fetch-depth=1) has no common ancestor between the PR merge
 * commit and the base branch, so `git merge-base` exits non-zero with empty
 * output; the caller must treat `null` as "no provable base" and fail
 * closed, never as an empty SHA.
 */
export function resolveMergeBase(cwd, ref, { env = process.env } = {}) {
  let output;
  try {
    output = execFileSync("git", ["merge-base", "HEAD", ref], {
      cwd,
      env,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"]
    }).trim();
  } catch {
    return null;
  }
  return isFullSha(output) ? output : null;
}

/**
 * The record paths (relative to `cwd`) that the gate is about to write, so
 * the source-checkout cleanliness check does not mistake the gate's own
 * record output for dirtiness. Only paths under `cwd` are returned; a
 * record written elsewhere never shows up in `git status`.
 */
export function recordPathPrefixes(cwd, recordPath) {
  if (recordPath === undefined || recordPath === "-") {
    return [];
  }
  const relativePath = relative(cwd, resolve(cwd, recordPath));
  if (relativePath === "" || relativePath.startsWith("..") || isAbsolute(relativePath)) {
    return [];
  }
  const parts = relativePath.split(sep).filter((entry) => entry !== "");
  const prefixes = [];
  for (let index = 1; index <= parts.length; index += 1) {
    prefixes.push(parts.slice(0, index).join(sep));
  }
  return prefixes;
}

/**
 * Fail-closed source-checkout cleanliness check. The runner and helper are
 * loaded from the caller's checkout, so a dirty checkout (a tracked edit, a
 * staged change, or an untracked file) could run modified code and label its
 * result with the HEAD SHA. The gate refuses to produce evidence until the
 * checkout is clean. `except` lists untracked paths (relative to `cwd`) that
 * are the gate's own imminent output and must not count as dirtiness.
 * Throws when the checkout is dirty or its status cannot be read.
 */
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
  const dirty = [];
  for (const line of porcelain.split(/\r?\n/u)) {
    if (line.trim() === "") {
      continue;
    }
    // Porcelain format is `XY <path>`; untracked entries are `??`.
    const status = line.slice(0, 2);
    const path = line.slice(3).replace(/\/$/u, "");
    if (status === "??" && exceptSet.has(path)) {
      continue;
    }
    dirty.push(line);
  }
  if (dirty.length > 0) {
    throw new Error(
      `source checkout is dirty; refusing to gate (commit or stash first): ${dirty
        .slice(0, 5)
        .join(" | ")}`
    );
  }
}
