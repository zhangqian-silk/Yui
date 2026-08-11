// Blocking isolation preflight for the Provider E2E and Release E2E tiers.
//
// These are the only tiers permitted to launch a real model or exercise real
// install/upgrade flows, so before any such run we must PROVE the run cannot
// touch the developer's real environment. The preflight fails closed: every
// invariant must be satisfied by an explicit, resolved fact. A missing or
// ambiguous input is a rejection, never a guess or a silent fallback.
//
// It rejects the classic footguns by construction:
//   - a bare `yui` resolved through PATH (not an absolute checkout-local path);
//   - the `make link` global launcher (a symlink / a path outside the checkout);
//   - an arbitrary absolute parent used as the "run root": the run root must be
//     proven temporary AND owned by this run before anything is derived in it.
//     Ownership is CREATOR-BOUND: `createOwnedRunRoot` makes the directory via
//     mkdtemp and writes a random-token receipt, and `gatherRunRootOwnership`
//     only reports ownedByRun when that exact token is presented back — a
//     pre-existing foreign temp directory can never satisfy it. It also rejects
//     a symlink run root and canonicalizes the run root, so a symlink under a
//     fresh temp base that points at the checkout is refused;
//   - a shared YUI_HOME (the dev home, ~/.yui, or anything outside the run root);
//   - a derived path (YUI_HOME/workspace/npm prefix) that symlinks out of the
//     owned run root — `assertIsolationReady` runs a PHYSICAL containment pass
//     (realpath of every existing component), so lexical nesting is not enough;
//   - the global npm prefix;
// and it refuses to run unless an explicit active-Session observation reports
// zero active production Sessions. Missing observation is a rejection, never an
// assumed-empty safe list.
//
// The pure evaluator (`evaluateIsolationPreflight`) takes already-resolved facts
// so it is deterministic and unit-testable with lexical paths. The fact
// gatherers read real disk / npm state and hand those facts to the evaluator;
// `assertIsolationReady` composes them, adds the physical containment fence, and
// throws on rejection.

import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { lstatSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";

import { yuiTmuxServerName } from "../../dist/tmux/tmuxManager.js";

/** The second line every `make install-local` launcher carries. */
export const MANAGED_LAUNCHER_MARKER = "# yui-local-dev: managed";

/**
 * The creator-bound ownership receipt written into a run root by
 * `createOwnedRunRoot`. Its presence — with the exact token this run generated —
 * is what proves *this* run created the directory. A pre-existing foreign temp
 * directory will not carry a matching token, so it is never accepted as owned.
 */
export const RUN_ROOT_OWNER_MARKER = ".yui-run-owner";

/** The canonical checkout-local launcher path relative to a checkout root. */
export const CHECKOUT_LOCAL_LAUNCHER = join("output", "dev", "bin", "yui");

/** The shared dev YUI_HOME the local launcher defaults to. Never disposable. */
export const CHECKOUT_DEV_HOME = join("output", "dev", "home");

/**
 * @typedef {Readonly<{ name: string, ok: boolean, detail: string }>} PreflightCheck
 * @typedef {Readonly<{ ok: boolean, checks: readonly PreflightCheck[], rejections: readonly string[] }>} PreflightResult
 */

/**
 * @typedef {Readonly<{
 *   path: string,
 *   exists: boolean,
 *   isSymbolicLink: boolean,
 *   isRegularFile: boolean,
 *   secondLine: string | null
 * }>} LauncherFacts
 */

/**
 * Proof that the run root is a disposable directory this run owns. Every field
 * is required and must be explicitly true; a missing or false field is a
 * rejection. `temporaryBase` is the OS/temp base the run root must live under
 * (proving it is temporary), `canonicalRunRoot` is the symlink-resolved
 * (physical) run-root path the derived paths must live inside, and `evidence` is
 * a human-readable note of how the run established ownership.
 *
 * The pure evaluator only reads `isTemporary`/`ownedByRun`/`temporaryBase` (it
 * trusts these as already-verified facts). The *facts themselves* are produced
 * by `gatherRunRootOwnership`, which verifies them physically: it rejects a
 * symlink run root, requires the canonical run root to sit strictly inside the
 * canonical temp base, and requires a creator-bound ownership marker/token.
 * @typedef {Readonly<{
 *   isTemporary: boolean,
 *   ownedByRun: boolean,
 *   temporaryBase: string,
 *   canonicalRunRoot?: string | null,
 *   evidence?: string
 * }>} RunRootOwnership
 */

/**
 * Explicit result of observing active production Sessions. There is no implicit
 * empty default: a run must present this observation, and `observed` must be
 * true, before the "no active Session" invariant can even be evaluated.
 * @typedef {Readonly<{
 *   observed: boolean,
 *   sessions: readonly string[],
 *   source?: string
 * }>} ActiveSessionObservation
 */

/**
 * @typedef {Readonly<{
 *   checkoutRoot: string,
 *   runRoot: string,
 *   runRootOwnership: RunRootOwnership,
 *   launcher: LauncherFacts,
 *   yuiHome: string,
 *   workspace: string,
 *   npmPrefix: string,
 *   globalNpmPrefix: string,
 *   tmuxServer: string,
 *   protectedHomes?: readonly string[],
 *   activeSessionObservation?: ActiveSessionObservation
 * }>} IsolationDescriptor
 */

/**
 * Evaluates every isolation invariant against resolved facts. Pure and
 * deterministic: no filesystem, process, or environment access. Returns the
 * full ordered check list plus the reasons any check failed. `ok` is true only
 * when every check passes.
 * @param {IsolationDescriptor} descriptor
 * @returns {PreflightResult}
 */
export function evaluateIsolationPreflight(descriptor) {
  /** @type {PreflightCheck[]} */
  const checks = [];
  const add = (name, ok, detail) => {
    checks.push(Object.freeze({ name, ok: ok === true, detail }));
  };

  const checkoutRoot = absoluteOrNull(descriptor?.checkoutRoot);
  const runRoot = absoluteOrNull(descriptor?.runRoot);
  const launcher = descriptor?.launcher;

  // 1. The launcher must be an absolute path. A bare `yui` (basename only, or
  // any relative path) is resolved through PATH and cannot be proven to be this
  // checkout's build, so it is rejected before anything else.
  const launcherPath = typeof launcher?.path === "string" ? launcher.path : "";
  const launcherAbsolute = launcherPath.length > 0 && isAbsolute(launcherPath);
  add(
    "launcher-absolute-path",
    launcherAbsolute,
    launcherAbsolute
      ? `launcher is an absolute path: ${launcherPath}`
      : `launcher must be an absolute path, refusing bare/relative: ${JSON.stringify(launcherPath)}`
  );

  // 2. The launcher must be exactly this checkout's install-local launcher.
  const expectedLauncher = checkoutRoot === null
    ? null
    : resolve(checkoutRoot, CHECKOUT_LOCAL_LAUNCHER);
  const launcherIsCheckoutLocal = launcherAbsolute
    && expectedLauncher !== null
    && resolve(launcherPath) === expectedLauncher;
  add(
    "launcher-checkout-local",
    launcherIsCheckoutLocal,
    launcherIsCheckoutLocal
      ? `launcher is the checkout-local launcher: ${expectedLauncher}`
      : `launcher must be ${expectedLauncher ?? "<checkout>/" + CHECKOUT_LOCAL_LAUNCHER}, got ${JSON.stringify(launcherPath)}`
  );

  // 3. The launcher must be a real regular file, not a symlink. The `make link`
  // global launcher is a symlink into a checkout; requiring a regular file at
  // the checkout-local path rejects driving the run through the global link.
  const launcherRealFile = launcher?.exists === true
    && launcher?.isSymbolicLink === false
    && launcher?.isRegularFile === true;
  add(
    "launcher-regular-file",
    launcherRealFile,
    launcherRealFile
      ? "launcher is a regular non-symlink file"
      : "launcher must be a present regular file (not a symlink); refusing make-link/global launcher"
  );

  // 4. The launcher must carry the managed marker so an arbitrary same-named
  // script cannot masquerade as the generated launcher.
  const markerOk = launcher?.secondLine === MANAGED_LAUNCHER_MARKER;
  add(
    "launcher-managed-marker",
    markerOk,
    markerOk
      ? "launcher carries the managed marker"
      : `launcher second line must be ${JSON.stringify(MANAGED_LAUNCHER_MARKER)}, got ${JSON.stringify(launcher?.secondLine ?? null)}`
  );

  // 5. Run root must be an absolute path.
  add(
    "run-root-absolute",
    runRoot !== null,
    runRoot !== null
      ? `run root is absolute: ${runRoot}`
      : `run root must be an absolute path, got ${JSON.stringify(descriptor?.runRoot ?? null)}`
  );

  // 5b. The run root must be PROVEN temporary and owned by this run. An
  // arbitrary absolute parent (e.g. /tmp, /home/dev, or / itself) is rejected:
  // we require an explicit ownership proof whose fields are all present and
  // true, and the run root must resolve strictly inside the declared temporary
  // base. Missing or ambiguous ownership is a rejection, never a guess.
  const ownership = descriptor?.runRootOwnership;
  const temporaryBase = absoluteOrNull(ownership?.temporaryBase);
  const ownershipComplete = ownership !== null
    && typeof ownership === "object"
    && ownership?.isTemporary === true
    && ownership?.ownedByRun === true
    && temporaryBase !== null;
  const runRootUnderTempBase = ownershipComplete
    && runRoot !== null
    && isStrictlyInside(temporaryBase, runRoot);
  const runRootOwned = ownershipComplete && runRootUnderTempBase;
  add(
    "run-root-owned-temporary",
    runRootOwned,
    runRootOwned
      ? `run root is a temporary directory owned by this run under ${temporaryBase}`
      : ownership === undefined || ownership === null
        ? "run root ownership proof is missing; refusing to treat an arbitrary "
          + "absolute parent as a disposable run root"
        : !ownershipComplete
          ? "run root ownership proof is incomplete; require isTemporary=true, "
            + `ownedByRun=true, and an absolute temporaryBase, got ${JSON.stringify(ownership)}`
          : `run root must resolve strictly inside its temporary base ${temporaryBase}, `
            + `got ${JSON.stringify(descriptor?.runRoot ?? null)}`
  );

  // Everything derived below must live inside the EXACT owned run root. If the
  // run root is not provably owned, the derivations cannot be trusted either, so
  // treat the owned root as null and let each derived check fail closed.
  const ownedRunRoot = runRootOwned ? runRoot : null;

  // 6. YUI_HOME must live strictly inside the disposable owned run root and must
  // not be any protected/shared home.
  const yuiHome = absoluteOrNull(descriptor?.yuiHome);
  const protectedHomes = (descriptor?.protectedHomes ?? []).map((home) => resolve(home));
  const homeInsideRun = yuiHome !== null && ownedRunRoot !== null && isStrictlyInside(ownedRunRoot, yuiHome);
  const homeShared = yuiHome !== null && protectedHomes.includes(yuiHome);
  const homeOk = homeInsideRun && !homeShared;
  add(
    "yui-home-disposable",
    homeOk,
    homeOk
      ? `YUI_HOME is disposable inside the owned run root: ${yuiHome}`
      : homeShared
        ? `YUI_HOME is a shared/protected home and must not be used: ${yuiHome}`
        : `YUI_HOME must be an absolute path strictly inside the owned run root, got ${JSON.stringify(descriptor?.yuiHome ?? null)}`
  );

  // 7. The external workspace must also be disposable and distinct from home.
  const workspace = absoluteOrNull(descriptor?.workspace);
  const workspaceInsideRun = workspace !== null && ownedRunRoot !== null && isStrictlyInside(ownedRunRoot, workspace);
  const workspaceDistinct = workspace !== null && yuiHome !== null && workspace !== yuiHome;
  const workspaceOk = workspaceInsideRun && workspaceDistinct;
  add(
    "workspace-disposable",
    workspaceOk,
    workspaceOk
      ? `workspace is disposable inside the owned run root: ${workspace}`
      : `workspace must be an absolute path inside the owned run root and distinct from YUI_HOME, got ${JSON.stringify(descriptor?.workspace ?? null)}`
  );

  // 8. The npm prefix must be isolated inside the owned run root and must not be
  // the global prefix, so install/upgrade flows cannot mutate global packages.
  const npmPrefix = absoluteOrNull(descriptor?.npmPrefix);
  const globalNpmPrefix = absoluteOrNull(descriptor?.globalNpmPrefix);
  const npmInsideRun = npmPrefix !== null && ownedRunRoot !== null && isStrictlyInside(ownedRunRoot, npmPrefix);
  const npmIsGlobal = npmPrefix !== null && globalNpmPrefix !== null && npmPrefix === globalNpmPrefix;
  const npmOk = npmInsideRun && globalNpmPrefix !== null && !npmIsGlobal;
  add(
    "npm-prefix-isolated",
    npmOk,
    npmOk
      ? `npm prefix is isolated inside the owned run root: ${npmPrefix}`
      : npmIsGlobal
        ? `npm prefix equals the global prefix and must not be used: ${npmPrefix}`
        : globalNpmPrefix === null
          ? "global npm prefix is unknown; refusing to run without proof the prefix is isolated"
          : `npm prefix must be an absolute path inside the owned run root, got ${JSON.stringify(descriptor?.npmPrefix ?? null)}`
  );

  // 9. The Controller/tmux namespace must be the one derived from the disposable
  // YUI_HOME. A caller cannot smuggle a shared server name past the fence.
  const expectedServer = yuiHome === null ? null : yuiTmuxServerName(yuiHome);
  const namespaceOk = expectedServer !== null && descriptor?.tmuxServer === expectedServer;
  add(
    "namespace-unique",
    namespaceOk,
    namespaceOk
      ? `tmux/Controller namespace is derived from the disposable home: ${expectedServer}`
      : `tmux server must be ${expectedServer ?? "<derived from YUI_HOME>"}, got ${JSON.stringify(descriptor?.tmuxServer ?? null)}`
  );

  // 10. No active production Session may be running, and — fail-closed — the run
  // must PROVE it observed the active-Session state. A missing observation, or
  // one whose `observed` flag is not true, is rejected: we never default missing
  // evidence to an assumed-empty safe list.
  const observation = descriptor?.activeSessionObservation;
  const sessions = Array.isArray(observation?.sessions) ? observation.sessions : null;
  const observationPresent = observation !== null
    && typeof observation === "object"
    && observation?.observed === true
    && sessions !== null;
  const noActiveSession = observationPresent && sessions.length === 0;
  add(
    "no-active-production-session",
    noActiveSession,
    noActiveSession
      ? `no active production Session observed${observation?.source ? ` (${observation.source})` : ""}`
      : !observationPresent
        ? "active-Session observation is missing or unconfirmed; refusing to assume "
          + "zero Sessions. Provide an explicit observation {observed:true, sessions:[...]}"
        : `refusing to run while ${sessions.length} active production Session(s) exist: ${sessions.join(", ")}`
  );

  const rejections = checks.filter((check) => !check.ok).map((check) => `${check.name}: ${check.detail}`);
  return Object.freeze({
    ok: rejections.length === 0,
    checks: Object.freeze(checks),
    rejections: Object.freeze(rejections)
  });
}

/**
 * Reads the real launcher facts for a path without throwing on a missing file.
 * @param {string} path
 * @returns {LauncherFacts}
 */
export function gatherLauncherFacts(path) {
  const resolved = typeof path === "string" ? path : "";
  let stat;
  try {
    stat = lstatSync(resolved);
  } catch {
    return Object.freeze({
      path: resolved,
      exists: false,
      isSymbolicLink: false,
      isRegularFile: false,
      secondLine: null
    });
  }
  const isSymbolicLink = stat.isSymbolicLink();
  const isRegularFile = stat.isFile() && !isSymbolicLink;
  let secondLine = null;
  if (isRegularFile) {
    try {
      secondLine = readFileSync(resolved, "utf8").split("\n")[1] ?? null;
    } catch {
      secondLine = null;
    }
  }
  return Object.freeze({
    path: resolved,
    exists: true,
    isSymbolicLink,
    isRegularFile,
    secondLine
  });
}

/**
 * Resolves the global npm prefix, or null when npm cannot report one. A null
 * result is a rejection at evaluation time, never a silent pass.
 * @param {NodeJS.ProcessEnv} [environment]
 * @returns {string | null}
 */
export function resolveGlobalNpmPrefix(environment = process.env) {
  try {
    const prefix = execFileSync("npm", ["prefix", "-g"], {
      encoding: "utf8",
      env: environment
    }).trim();
    return prefix.length > 0 ? resolve(prefix) : null;
  } catch {
    return null;
  }
}

/**
 * The standard set of protected/shared homes a Provider/Release run must never
 * adopt as its YUI_HOME.
 * @param {Readonly<{ checkoutRoot: string, environment?: NodeJS.ProcessEnv }>} input
 * @returns {readonly string[]}
 */
export function standardProtectedHomes(input) {
  const environment = input.environment ?? process.env;
  const homes = [
    resolve(input.checkoutRoot, CHECKOUT_DEV_HOME),
    resolve(homedir(), ".yui")
  ];
  if (typeof environment.YUI_HOME === "string" && environment.YUI_HOME.length > 0) {
    homes.push(resolve(environment.YUI_HOME));
  }
  return Object.freeze([...new Set(homes)]);
}

/**
 * True only for a prefix that is a single safe path segment. `mkdtempSync`
 * appends random characters to `join(base, prefix)`, so a prefix that contains a
 * path separator or a `..` traversal (or is absolute) would make the created
 * directory land *outside* the requested base. Such a prefix is rejected before
 * anything is created — we never create first and detect the escape afterwards.
 * A trailing separator is likewise refused: it would place the temp name in a
 * child directory of the base rather than the base itself.
 * @param {string} prefix
 * @returns {boolean}
 */
function isSafeRunRootPrefix(prefix) {
  if (typeof prefix !== "string" || prefix.length === 0) return false;
  if (isAbsolute(prefix)) return false;
  // No path separators of any kind (POSIX or Windows), so the prefix cannot
  // descend into or escape the base.
  if (prefix.includes("/") || prefix.includes("\\")) return false;
  // basename() collapses separators/traversal; if it differs, the prefix was not
  // a plain segment. Also reject the traversal/self segments explicitly.
  if (prefix === "." || prefix === "..") return false;
  if (basename(prefix) !== prefix) return false;
  return true;
}

/**
 * Creates the exact disposable run root this run owns — the supported normal
 * path. It makes a unique directory under the canonical OS temp base via
 * `mkdtempSync` and writes a creator-bound ownership receipt
 * (`RUN_ROOT_OWNER_MARKER`) containing a fresh random token and this process's
 * pid. The returned `token` must be presented back to `gatherRunRootOwnership`
 * at preflight, which is how "this run created this directory" is proven — a
 * pre-existing foreign temp directory cannot produce a matching receipt.
 *
 * The `prefix` is validated as a safe single path segment BEFORE anything is
 * created (so a traversal prefix like `../escaped-run-` is rejected and creates
 * nothing outside the base), and the created root's canonical path is required
 * to sit strictly inside the canonical base as a postcondition before the
 * receipt is written; a violation removes the directory and throws.
 *
 * @param {Readonly<{ temporaryBase?: string, prefix?: string }>} [input]
 * @returns {Readonly<{ runRoot: string, canonicalRunRoot: string, token: string, ownership: RunRootOwnership }>}
 */
export function createOwnedRunRoot(input = {}) {
  // Canonicalize the temp base first so the receipt and later proof compare
  // physical paths, not symlinked ones.
  const temporaryBase = realpathSync(resolve(input.temporaryBase ?? tmpdir()));
  const prefix = input.prefix === undefined ? "yui-run-" : input.prefix;
  // Validate BEFORE creating: mkdtempSync(join(base, prefix)) would otherwise
  // create a directory outside the requested base for a traversal prefix.
  if (!isSafeRunRootPrefix(prefix)) {
    throw new Error(
      `createOwnedRunRoot refuses an unsafe run-root prefix ${JSON.stringify(prefix)}: `
      + "it must be a single path segment with no separators, no '..' traversal, and not absolute."
    );
  }
  const runRoot = mkdtempSync(join(temporaryBase, prefix));
  const canonicalRunRoot = realpathSync(runRoot);
  // Physical inside-base postcondition: even with a validated prefix, never
  // trust that the created root landed inside the requested base. If it did not,
  // remove it and fail closed rather than deriving anything in an escaped root.
  if (!isStrictlyInside(temporaryBase, canonicalRunRoot)) {
    try {
      rmSync(runRoot, { recursive: true, force: true });
    } catch {
      // Best-effort cleanup; the throw below is the important signal.
    }
    throw new Error(
      `createOwnedRunRoot created a run root outside its base: ${JSON.stringify(canonicalRunRoot)} `
      + `is not strictly inside ${JSON.stringify(temporaryBase)}; refusing to derive anything in it.`
    );
  }
  const token = randomBytes(32).toString("hex");
  const receipt = {
    kind: "yui-ephemeral-run-root",
    token,
    pid: process.pid,
    createdAtBase: temporaryBase
  };
  writeFileSync(join(canonicalRunRoot, RUN_ROOT_OWNER_MARKER), JSON.stringify(receipt), {
    encoding: "utf8",
    // Fail if it somehow already exists: we must be the creator.
    flag: "wx"
  });
  const ownership = gatherRunRootOwnership({
    runRoot: canonicalRunRoot,
    temporaryBase,
    expectedToken: token,
    evidence: `run root created via mkdtemp under ${temporaryBase} by pid ${process.pid}`
  });
  return Object.freeze({ runRoot, canonicalRunRoot, token, ownership });
}

/**
 * Builds an explicit run-root ownership proof and verifies it PHYSICALLY, so
 * ownership is a creator-bound checked fact rather than a lexical coincidence.
 * It rejects, with `ownedByRun:false`:
 *   - a run root that is itself a symbolic link (the reproduced escape: a symlink
 *     under a fresh temp base pointing at the checkout);
 *   - a run root whose canonical (symlink-resolved) path does not sit strictly
 *     inside the canonical temporary base — so a symlink that lexically looks
 *     "under /tmp" but physically resolves into the checkout is refused;
 *   - a pre-existing foreign directory that carries no creator-bound ownership
 *     receipt, or one whose receipt token does not match `expectedToken`.
 *
 * `expectedToken` is the token returned by `createOwnedRunRoot`. When it is
 * supplied, the on-disk receipt token must equal it. When it is omitted the
 * receipt must still be present and valid, but a matching token cannot be
 * asserted, so ownership stays unproven (`ownedByRun:false`) — there is no
 * self-asserted or existence-only acceptance.
 * @param {Readonly<{ runRoot: string, temporaryBase?: string, expectedToken?: string, evidence?: string }>} input
 * @returns {RunRootOwnership}
 */
export function gatherRunRootOwnership(input) {
  const canonicalTemporaryBase = canonicalizeExisting(resolve(input.temporaryBase ?? tmpdir()));
  const runRoot = absoluteOrNull(input.runRoot);

  // 1. Reject a symbolic-link run root outright (lstat does not follow links).
  let isSymlink = false;
  let isDirectory = false;
  if (runRoot !== null) {
    try {
      const linkStat = lstatSync(runRoot);
      isSymlink = linkStat.isSymbolicLink();
      isDirectory = !isSymlink && linkStat.isDirectory();
    } catch {
      isSymlink = false;
      isDirectory = false;
    }
  }

  // 2. Canonicalize the run root (resolve every symlink component) and require
  // the physical path to live strictly inside the canonical temp base.
  const canonicalRunRoot = !isSymlink && isDirectory ? canonicalizeExisting(runRoot) : null;
  const underTempBase = canonicalRunRoot !== null
    && canonicalTemporaryBase !== null
    && isStrictlyInside(canonicalTemporaryBase, canonicalRunRoot);

  // 3. Require a creator-bound ownership receipt whose token matches.
  const receipt = canonicalRunRoot !== null ? readOwnerReceipt(canonicalRunRoot) : null;
  const tokenMatches = receipt !== null
    && typeof receipt.token === "string"
    && receipt.token.length > 0
    && typeof input.expectedToken === "string"
    && input.expectedToken.length > 0
    && receipt.token === input.expectedToken;

  const ownedByRun = isDirectory && underTempBase && tokenMatches;
  return Object.freeze({
    isTemporary: underTempBase,
    ownedByRun,
    temporaryBase: canonicalTemporaryBase ?? resolve(input.temporaryBase ?? tmpdir()),
    canonicalRunRoot,
    evidence: input.evidence
      ?? (isSymlink
        ? "run root is a symbolic link; refusing to treat it as owned"
        : receipt === null
          ? "run root carries no creator-bound ownership receipt"
          : !tokenMatches
            ? "run root ownership receipt token does not match this run"
            : `run root physically owned under ${canonicalTemporaryBase}`)
  });
}

/**
 * Reads and parses the creator-bound ownership receipt from a run root, or null
 * if it is missing/unreadable/malformed. Never throws.
 * @param {string} canonicalRunRoot
 * @returns {{ token?: string, pid?: number } | null}
 */
function readOwnerReceipt(canonicalRunRoot) {
  try {
    const raw = readFileSync(join(canonicalRunRoot, RUN_ROOT_OWNER_MARKER), "utf8");
    const parsed = JSON.parse(raw);
    return parsed !== null && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Produces an explicit active-Session observation. This is the fail-closed seam:
 * a run must call an observer that actually looked, and the returned
 * `observed:true` is what unlocks the "no active Session" check. There is no
 * implicit empty default — a caller that cannot observe must not fabricate one.
 * @param {Readonly<{ sessions: readonly string[], source?: string }>} input
 * @returns {ActiveSessionObservation}
 */
export function recordActiveSessionObservation(input) {
  if (!Array.isArray(input?.sessions)) {
    throw new Error(
      "recordActiveSessionObservation requires an explicit sessions array from a real observation."
    );
  }
  return Object.freeze({
    observed: true,
    sessions: Object.freeze([...input.sessions]),
    source: input.source ?? "explicit observation"
  });
}

/**
 * Physically fences a set of derived paths inside the canonical (symlink-
 * resolved) run root. Unlike the pure evaluator's lexical `isStrictlyInside`,
 * this resolves each path's existing components with `realpathSync`, so a
 * derived path that *lexically* looks nested but whose existing components
 * symlink out of the owned root is rejected. Leaf components that do not exist
 * yet (a home/workspace/npm prefix about to be created) are allowed — only the
 * existing ancestors are canonicalized.
 * @param {Readonly<{ canonicalRunRoot: string | null, paths: Readonly<Record<string, string>> }>} input
 * @returns {PreflightResult}
 */
export function evaluatePhysicalContainment(input) {
  /** @type {PreflightCheck[]} */
  const checks = [];
  const canonicalRunRoot = input.canonicalRunRoot;
  for (const [label, rawPath] of Object.entries(input.paths ?? {})) {
    const canonical = canonicalizeExisting(rawPath);
    const contained = canonicalRunRoot !== null
      && canonical !== null
      && isStrictlyInside(canonicalRunRoot, canonical);
    checks.push(Object.freeze({
      name: `physical-containment:${label}`,
      ok: contained,
      detail: contained
        ? `${label} physically resolves inside the owned run root: ${canonical}`
        : canonicalRunRoot === null
          ? `${label} cannot be fenced: the owned run root has no canonical path`
          : `${label} physically escapes the owned run root (resolved to ${JSON.stringify(canonical)}, `
            + `which is not inside ${canonicalRunRoot}); refusing symlink escape`
    }));
  }
  const rejections = checks.filter((check) => !check.ok).map((check) => `${check.name}: ${check.detail}`);
  return Object.freeze({
    ok: rejections.length === 0,
    checks: Object.freeze(checks),
    rejections: Object.freeze(rejections)
  });
}

/**
 * Composes fact gathering with the pure evaluator and throws a single,
 * fully-explained error if the run is not provably isolated. On success it
 * returns the structured result so a report can record the exact checks.
 *
 * Both the run-root ownership proof and the active-Session observation are
 * REQUIRED: this function does not synthesize a permissive default for either.
 * A caller must pass `runRootOwnership` (see gatherRunRootOwnership) and
 * `activeSessionObservation` (see recordActiveSessionObservation).
 *
 * On top of the pure evaluator's lexical checks, this composer runs a PHYSICAL
 * containment pass: it canonicalizes the run root and each derived path and
 * rejects any that symlink out of the owned root. This is what makes the
 * lexical `isStrictlyInside` immune to a symlink escape on the real filesystem.
 * @param {Readonly<{
 *   checkoutRoot: string,
 *   runRoot: string,
 *   runRootOwnership: RunRootOwnership,
 *   launcherPath: string,
 *   yuiHome: string,
 *   workspace: string,
 *   npmPrefix: string,
 *   tmuxServer?: string,
 *   environment?: NodeJS.ProcessEnv,
 *   protectedHomes?: readonly string[],
 *   globalNpmPrefix?: string | null,
 *   activeSessionObservation: ActiveSessionObservation
 * }>} input
 * @returns {PreflightResult}
 */
export function assertIsolationReady(input) {
  const environment = input.environment ?? process.env;
  const descriptor = {
    checkoutRoot: input.checkoutRoot,
    runRoot: input.runRoot,
    // No permissive default: a missing proof stays undefined and the evaluator
    // rejects it.
    runRootOwnership: input.runRootOwnership,
    launcher: gatherLauncherFacts(input.launcherPath),
    yuiHome: input.yuiHome,
    workspace: input.workspace,
    npmPrefix: input.npmPrefix,
    globalNpmPrefix: input.globalNpmPrefix === undefined
      ? resolveGlobalNpmPrefix(environment)
      : input.globalNpmPrefix,
    tmuxServer: input.tmuxServer
      ?? (typeof input.yuiHome === "string" && input.yuiHome.length > 0
        ? yuiTmuxServerName(input.yuiHome)
        : undefined),
    protectedHomes: input.protectedHomes
      ?? standardProtectedHomes({ checkoutRoot: input.checkoutRoot, environment }),
    // No permissive default: a missing observation stays undefined and the
    // evaluator rejects it (fail-closed, never assumed-empty).
    activeSessionObservation: input.activeSessionObservation
  };
  const result = evaluateIsolationPreflight(descriptor);

  // Physical fence: resolve real paths so a symlinked run root or a symlinked
  // derived path cannot pass the lexical checks. Prefer the canonical run root
  // captured by the ownership proof; fall back to canonicalizing the run root.
  const canonicalRunRoot = input.runRootOwnership?.canonicalRunRoot
    ?? canonicalizeExisting(input.runRoot);
  const physical = evaluatePhysicalContainment({
    canonicalRunRoot,
    paths: {
      "yui-home": input.yuiHome,
      workspace: input.workspace,
      "npm-prefix": input.npmPrefix
    }
  });

  const rejections = [...result.rejections, ...physical.rejections];
  if (rejections.length > 0) {
    throw new Error(
      "Isolation preflight rejected this Provider/Release run:\n"
      + rejections.map((reason) => `  - ${reason}`).join("\n")
    );
  }
  return Object.freeze({
    ok: true,
    checks: Object.freeze([...result.checks, ...physical.checks]),
    rejections: Object.freeze([])
  });
}

function absoluteOrNull(value) {
  return typeof value === "string" && value.length > 0 && isAbsolute(value)
    ? resolve(value)
    : null;
}

/** True when `child` is a strict descendant of `parent` (not equal). */
function isStrictlyInside(parent, child) {
  const relativePath = relative(parent, child);
  return relativePath.length > 0
    && !relativePath.startsWith("..")
    && !isAbsolute(relativePath);
}

/**
 * Canonicalizes the *existing* portion of an absolute path: it resolves every
 * symlink in the longest existing ancestor via `realpathSync`, then re-appends
 * the not-yet-created remainder. This is what lets us physically fence a path
 * whose leaf does not exist yet (a YUI_HOME/workspace/npm prefix about to be
 * created) while still refusing one whose existing components symlink out of the
 * owned run root.
 *
 * Stripping a component as "not created yet" is deliberately narrow: it happens
 * ONLY when `realpathSync` reports `ENOENT` *and* a separate `lstatSync` of that
 * exact component *also* reports `ENOENT` — i.e. nothing is present at that path
 * at all. Every other outcome fails closed with null:
 *   - a non-ENOENT `realpathSync` error (ELOOP symlink loop, EACCES permission,
 *     ENOTDIR, …) — we cannot prove where the path physically resolves;
 *   - a `realpathSync` ENOENT but an `lstatSync` that SUCCEEDS — an
 *     existing-but-unresolvable node, e.g. a dangling symlink (its target is
 *     absent, so realpath throws ENOENT while the link itself exists);
 *   - a `realpathSync` ENOENT and a non-ENOENT `lstatSync` error (e.g. EACCES
 *     because a parent directory denies traversal) — an ambiguity we refuse to
 *     resolve.
 * A symlink is an existing component even when its target is absent, so it must
 * never be mistaken for an ordinary missing leaf.
 *
 * Returns null for a non-absolute input, and the lexical absolute path if no
 * ancestor exists at all.
 * @param {string} path
 * @returns {string | null}
 */
function canonicalizeExisting(path) {
  const abs = absoluteOrNull(path);
  if (abs === null) return null;
  let current = abs;
  const trailing = [];
  // Bounded by the number of path components: each proven-absent leaf strips one
  // segment; anything else returns immediately (resolved or fail-closed null).
  for (;;) {
    let real = null;
    try {
      real = realpathSync(current);
    } catch (realError) {
      // A component may be stripped as "not created yet" ONLY when realpathSync
      // reports ENOENT. Any other realpath error (ELOOP, EACCES, ENOTDIR, …) is
      // an escape/ambiguity we cannot resolve, so fail closed.
      if (realError?.code !== "ENOENT") {
        return null;
      }
      // realpath said ENOENT — but a dangling symlink also throws ENOENT while
      // the link node itself exists. lstat does NOT follow the final link, so it
      // distinguishes "nothing is here" from "something unresolvable is here".
      try {
        lstatSync(current);
        // Something exists at this exact path that realpath could not resolve
        // (dangling symlink, …). Existing-but-unresolvable → fail closed.
        return null;
      } catch (lstatError) {
        // Only a matching ENOENT from BOTH calls proves the component is
        // genuinely absent. A non-ENOENT lstat error (e.g. EACCES on a parent
        // that denies traversal) is an ambiguity → fail closed.
        if (lstatError?.code !== "ENOENT") {
          return null;
        }
      }
      // Proven absent by both realpath ENOENT and lstat ENOENT: strip this leaf
      // and keep walking up toward the longest existing ancestor.
      const parent = dirname(current);
      if (parent === current) {
        // Reached the filesystem root without any existing component.
        return abs;
      }
      trailing.unshift(basename(current));
      current = parent;
      continue;
    }
    return trailing.length === 0 ? real : join(real, ...trailing);
  }
}
