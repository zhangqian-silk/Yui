/**
 * `yui release` commands: immutable local release installation, listing, and
 * atomic Controller handover activation (Issue 02).
 */

import { spawn, spawnSync } from "node:child_process";
import {
  chmodSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  rmSync,
} from "node:fs";
import { join, resolve } from "node:path";

import { callController, ControllerClientError } from "../core/controllerClient.js";
import { readLinuxProcessStartIdentity } from "../controller/domainIdentity.js";
import {
  activateRelease,
  type ReleaseActivatePorts,
  type ReleaseActivateResult
} from "../release/releaseHandover.js";
import {
  assertReleaseIsNotWorktreeOrLinked,
  readActiveReleasePointer,
  readReleaseManifest,
  releasesDirectory,
  releaseDirectoryFor,
  verifyReleaseIntegrity,
  writeSmokeReceipt,
  type HandoverOwner,
  type SmokeReceipt
} from "../release/runtimeRelease.js";

export type ReleaseInstallResult = Readonly<
  | {
      outcome: "installed";
      releaseId: string;
      buildId: string;
      packageDigest: string;
      releaseDir: string;
    }
  | { outcome: "already-installed"; releaseId: string; releaseDir: string }
  | { outcome: "aborted"; message: string; action: string }
>;

export type ReleaseListResult = Readonly<{
  active: string | null;
  releases: readonly {
    releaseId: string;
    version: string;
    buildId: string;
    packageDigest: string;
    smoke: boolean;
  }[];
}>;

/**
 * Installs a runtime package directory into the Home's immutable release
 * tree. The source must carry a release manifest, must not be a Git worktree
 * or contain symlinks, and must verify byte-for-byte after copying.
 */
export function runReleaseInstall(
  home: string,
  sourceDir: string,
  options: Readonly<{ now?: () => Date }> = {}
): ReleaseInstallResult {
  const now = options.now ?? (() => new Date());
  const source = resolve(sourceDir);
  if (!existsSync(join(source, "dist", "cli.js"))) {
    return {
      outcome: "aborted",
      message: `Release source has no dist/cli.js: ${source}.`,
      action: "Assemble the runtime package with scripts/assemble-runtime-package.mjs first."
    };
  }
  let manifest;
  try {
    manifest = readReleaseManifest(source);
  } catch (error) {
    return {
      outcome: "aborted",
      message: `Release source manifest is invalid: ${messageOf(error)}.`,
      action: "Re-assemble the runtime package; the manifest is written at assembly time."
    };
  }
  try {
    assertReleaseIsNotWorktreeOrLinked(source);
    verifyReleaseIntegrity(source);
  } catch (error) {
    return {
      outcome: "aborted",
      message: `Release source failed integrity verification: ${messageOf(error)}.`,
      action: "Re-assemble the runtime package from a clean build."
    };
  }

  const target = releaseDirectoryFor(home, manifest);
  if (existsSync(target)) {
    try {
      const existing = verifyReleaseIntegrity(target);
      if (existing.packageDigest === manifest.packageDigest) {
        return {
          outcome: "already-installed",
          releaseId: `${manifest.version}-${manifest.packageDigest}`,
          releaseDir: target
        };
      }
    } catch {
      // Fall through to the fail-closed diagnosis below.
    }
    return {
      outcome: "aborted",
      message: `Release directory already exists with different content: ${target}.`,
      action: "Remove the drifted directory manually after confirming it is not the active release."
    };
  }

  mkdirSync(releasesDirectory(home), { recursive: true, mode: 0o700 });
  copyRegularTree(source, target);
  try {
    assertReleaseIsNotWorktreeOrLinked(target);
    verifyReleaseIntegrity(target);
  } catch (error) {
    rmSync(target, { recursive: true, force: true });
    return {
      outcome: "aborted",
      message: `Installed release failed integrity verification: ${messageOf(error)}.`,
      action: "The partial release was removed; retry the installation."
    };
  }

  const smoke = runInstallSmoke(target, manifest.version);
  if (smoke !== null) {
    rmSync(target, { recursive: true, force: true });
    return {
      outcome: "aborted",
      message: `Release smoke failed: ${smoke}.`,
      action: "The partial release was removed; fix the package and retry."
    };
  }
  const receipt: SmokeReceipt = Object.freeze({
    schemaVersion: 1,
    version: manifest.version,
    buildId: manifest.buildId,
    packageDigest: manifest.packageDigest,
    checks: Object.freeze(["cli-version", "cli-help"]),
    ranAt: now().toISOString()
  });
  writeSmokeReceipt(target, receipt);
  return {
    outcome: "installed",
    releaseId: `${manifest.version}-${manifest.packageDigest}`,
    buildId: manifest.buildId,
    packageDigest: manifest.packageDigest,
    releaseDir: target
  };
}

/** Lists installed releases and the active release pointer. */
export function runReleaseList(home: string): ReleaseListResult {
  const active = readActiveReleasePointer(home);
  const directory = releasesDirectory(home);
  const releases: ReleaseListResult["releases"] = existsSync(directory)
    ? readdirSync(directory, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => {
        const releaseDir = join(directory, entry.name);
        try {
          const manifest = verifyReleaseIntegrity(releaseDir);
          return {
            releaseId: entry.name,
            version: manifest.version,
            buildId: manifest.buildId,
            packageDigest: manifest.packageDigest,
            smoke: existsSync(join(releaseDir, "smoke-receipt.json"))
          };
        } catch {
          return {
            releaseId: entry.name,
            version: "unknown",
            buildId: "unknown",
            packageDigest: "unknown",
            smoke: false
          };
        }
      })
    : [];
  return { active: active?.releaseId ?? null, releases };
}

/** Resolves an installed release by directory name or build ID. */
export function resolveInstalledRelease(
  home: string,
  releaseId: string
): { releaseDir: string; manifest: ReturnType<typeof readReleaseManifest> } | null {
  const directory = releasesDirectory(home);
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    if (entry.name === releaseId) {
      const releaseDir = join(directory, entry.name);
      try {
        return { releaseDir, manifest: verifyReleaseIntegrity(releaseDir) };
      } catch (error) {
        throw new Error(
          `Release ${releaseId} failed integrity verification and may have drifted: `
          + `${error instanceof Error ? error.message : String(error)}. `
          + "Reinstall it with `yui release install <source-dir>` before activating.",
          { cause: error }
        );
      }
    }
    try {
      const manifest = readReleaseManifest(join(directory, entry.name));
      if (manifest.buildId === releaseId) {
        return { releaseDir: join(directory, entry.name), manifest };
      }
    } catch {
      continue;
    }
  }
  return null;
}

/** Runs the atomic Controller handover for one installed release. */
export async function runReleaseActivate(
  home: string,
  releaseId: string,
  options: Readonly<{
    ports?: Partial<ReleaseActivatePorts>;
    candidateReadyTimeoutMs?: number;
    promotionTimeoutMs?: number;
    dualOwnerGraceMs?: number;
  }> = {}
): Promise<ReleaseActivateResult> {
  let resolved: ReturnType<typeof resolveInstalledRelease>;
  try {
    resolved = resolveInstalledRelease(home, releaseId);
  } catch (error) {
    return {
      outcome: "aborted",
      phase: "resolve",
      message: error instanceof Error ? error.message : String(error),
      action: "Reinstall the release; a drifted release cannot be activated.",
      recoverable: true
    };
  }
  if (resolved === null) {
    return {
      outcome: "aborted",
      phase: "resolve",
      message: `Release is not installed: ${releaseId}.`,
      action: "Install it with `yui release install <source-dir>` first.",
      recoverable: true
    };
  }
  if (!existsSync(join(resolved.releaseDir, "smoke-receipt.json"))) {
    return {
      outcome: "aborted",
      phase: "resolve",
      message: `Release has no smoke receipt: ${releaseId}.`,
      action: "Reinstall the release; the smoke receipt is written at install time.",
      recoverable: true
    };
  }
  const ports = createReleaseActivatePorts(options.ports);
  return activateRelease(ports, {
    home,
    releaseDir: resolved.releaseDir,
    manifest: resolved.manifest,
    ...(options.candidateReadyTimeoutMs === undefined
      ? {}
      : { candidateReadyTimeoutMs: options.candidateReadyTimeoutMs }),
    ...(options.promotionTimeoutMs === undefined
      ? {}
      : { promotionTimeoutMs: options.promotionTimeoutMs }),
    ...(options.dualOwnerGraceMs === undefined
      ? {}
      : { dualOwnerGraceMs: options.dualOwnerGraceMs })
  });
}

/** Renders the install result as concise CLI text. */
export function renderReleaseInstallResult(result: ReleaseInstallResult): string {
  switch (result.outcome) {
    case "installed":
      return `Installed release ${result.releaseId} (build ${result.buildId}).`;
    case "already-installed":
      return `Release ${result.releaseId} is already installed.`;
    case "aborted":
      return `Release install aborted: ${result.message}\nAction: ${result.action}`;
  }
}

/** Renders the list result as concise CLI text. */
export function renderReleaseList(result: ReleaseListResult): string {
  if (result.releases.length === 0) {
    return "No releases installed.";
  }
  const lines = result.releases.map((release) => {
    const active = release.releaseId === result.active ? " (active)" : "";
    const smoke = release.smoke ? "" : " [no smoke receipt]";
    return `  ${release.releaseId}${active}${smoke}`;
  });
  return [`Installed releases:`, ...lines].join("\n");
}

/** Renders the activate result as concise CLI text. */
export function renderReleaseActivateResult(result: ReleaseActivateResult): string {
  switch (result.outcome) {
    case "activated":
      return `Activated release ${result.releaseId} via handover ${result.handoverId}.`;
    case "already-active":
      return `Release ${result.releaseId} is already active.`;
    case "dual-owner":
      return [
        `DUAL-OWNER after handover ${result.handoverId}: ${result.message}`,
        `Action: ${result.action}`
      ].join("\n");
    case "aborted":
      return [
        `Activation aborted during ${result.phase}: ${result.message}`,
        result.recoverable
          ? "The previous Controller and active release pointer remain usable."
          : "Manual recovery is required (see below).",
        `Action: ${result.action}`
      ].join("\n");
  }
}

// ---------------------------------------------------------------------------
// Real ports

export function createReleaseActivatePorts(
  overrides: Partial<ReleaseActivatePorts> = {}
): ReleaseActivatePorts {
  const sleep = overrides.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
  return Object.freeze({
    call: overrides.call ?? ((home, method, params) => callController(home, method, params)),
    spawnCandidate: overrides.spawnCandidate ?? ((home, releaseDir, handoverId) => {
      spawnDetachedController(home, releaseDir, {
        [CONTROLLER_CANDIDATE_ENV]: "1",
        [CONTROLLER_HANDOVER_ID_ENV]: handoverId
      });
    }),
    startControllerFromRelease: overrides.startControllerFromRelease
      ?? (async (home, releaseDir) => {
        spawnDetachedController(home, releaseDir, {});
        const deadline = Date.now() + 30_000;
        const expectedBuildId = readReleaseManifest(releaseDir).buildId;
        for (;;) {
          try {
            const status = await callController(home, "controller.status", {});
            if (typeof status === "object" && status !== null && (status as { running?: unknown }).running === true) {
              // Verify the running Controller is the target release, not a
              // stale/previous Controller that happened to answer.
              const identity = await callController(home, "controller.identity", {}) as {
                buildId?: unknown;
              };
              if (identity.buildId !== expectedBuildId) {
                throw new Error(
                  `Controller is running build ${String(identity.buildId)}, `
                  + `not the target release build ${expectedBuildId}.`
                );
              }
              return;
            }
          } catch (error) {
            if (!isUnavailableError(error)) throw error;
          }
          if (Date.now() >= deadline) {
            throw new Error("Controller did not become ready within 30000 ms.");
          }
          await sleep(100);
        }
      }),
    runPreflight: overrides.runPreflight ?? ((releaseDir, home) => {
      const cli = join(releaseDir, "dist", "cli.js");
      const result = spawnSync(process.execPath, [cli, "doctor", "--json"], {
        env: { ...process.env, YUI_HOME: home, NO_COLOR: "1" },
        encoding: "utf8",
        timeout: 60_000
      });
      let report: unknown;
      try {
        const envelope = JSON.parse(result.stdout) as { data?: unknown };
        report = envelope.data;
      } catch (error) {
        throw new Error(
          `Release preflight produced no JSON (exit ${result.status}): `
            + `${messageOf(error)} ${result.stderr.trim()}`
        );
      }
      // The handover preflight is a compatibility check: the new release must
      // understand the Home's storage schema and layout. The four-state
      // `storage compatibility` verdict is authoritative: it is `ok` for
      // current, compatible-old, and migration-required (MIGRATABLE) Homes,
      // and non-ok for needs-new-version or corrupted Homes. The strict
      // `storage schema` check reads `unsupported` for a MIGRATABLE Home even
      // though the Controller opens it through the compatible migration path,
      // so gating on it would reject every older-but-upgradable Home. A
      // missing `storage state` (a Home that never ran `yui setup`) is not a
      // compatibility blocker — the new Controller initializes it.
      const checks = (report as { checks?: readonly { name?: unknown; status?: unknown }[] } | undefined)?.checks;
      if (!Array.isArray(checks)) {
        throw new Error("Release preflight report has no storage checks.");
      }
      const required = ["storage compatibility"];
      const failed = required.filter((name) => {
        const check = checks.find(
          (candidate) => candidate !== null
            && typeof candidate === "object"
            && (candidate as { name?: unknown }).name === name
        );
        return check === undefined
          || (check as { status?: unknown }).status !== "ok";
      });
      if (failed.length > 0) {
        throw new Error(
          `Release preflight storage compatibility checks failed: ${failed.join(", ")}.`
        );
      }
    }),
    killOwnedProcess: overrides.killOwnedProcess ?? ((owner: HandoverOwner) => {
      if (readLinuxProcessStartIdentity(owner.pid) !== owner.processStartIdentity) return;
      process.kill(owner.pid, "SIGTERM");
    }),
    sleep,
    now: overrides.now ?? (() => new Date())
  });
}

const CONTROLLER_CANDIDATE_ENV = "YUI_CONTROLLER_CANDIDATE";
const CONTROLLER_HANDOVER_ID_ENV = "YUI_CONTROLLER_HANDOVER_ID";

const CONTROLLER_OPERATIONAL_ENV = [
  "PATH",
  "HOME",
  "USER",
  "LOGNAME",
  "SHELL",
  "TMPDIR",
  "TMP",
  "TEMP",
  "TZ",
  "LANG",
  "TERM",
] as const;

function spawnDetachedController(
  home: string,
  releaseDir: string,
  extraEnv: Readonly<Record<string, string>>
): void {
  // Fail closed before launching: a release that drifted from its manifest
  // (corrupted or partially-deleted files) must never spawn a Controller.
  // `runReleaseActivate` verifies at resolve time; this closes the window
  // where the tree drifts between resolve and spawn and covers direct port
  // callers that bypass `resolveInstalledRelease`.
  verifyReleaseIntegrity(releaseDir);
  const environment: NodeJS.ProcessEnv = {};
  for (const name of CONTROLLER_OPERATIONAL_ENV) {
    const value = process.env[name];
    if (value !== undefined) environment[name] = value;
  }
  environment.YUI_HOME = home;
  Object.assign(environment, extraEnv);
  const child = spawn(
    process.execPath,
    [join(releaseDir, "dist", "controller", "controllerMain.js")],
    { env: environment, detached: true, stdio: "ignore" }
  );
  child.unref();
}

function runInstallSmoke(releaseDir: string, expectedVersion: string): string | null {
  const cli = join(releaseDir, "dist", "cli.js");
  const version = spawnSync(process.execPath, [cli, "version"], {
    env: { ...process.env, NO_COLOR: "1" },
    encoding: "utf8",
    timeout: 30_000
  });
  if (version.status !== 0) {
    return `cli version exited with ${version.status}: ${version.stderr.trim()}`;
  }
  if (version.stdout.trim() !== expectedVersion) {
    return `cli version reported ${version.stdout.trim()}, expected ${expectedVersion}`;
  }
  const help = spawnSync(process.execPath, [cli, "help"], {
    env: { ...process.env, NO_COLOR: "1" },
    encoding: "utf8",
    timeout: 30_000
  });
  if (help.status !== 0 || !help.stdout.includes("Yui")) {
    return "cli help did not render.";
  }
  return null;
}

function copyRegularTree(source: string, target: string): void {
  mkdirSync(target, { recursive: true, mode: 0o755 });
  for (const entry of readdirSync(source, { withFileTypes: true })) {
    const sourceChild = join(source, entry.name);
    const targetChild = join(target, entry.name);
    if (entry.isDirectory()) {
      copyRegularTree(sourceChild, targetChild);
      continue;
    }
    if (!entry.isFile() || entry.isSymbolicLink()) {
      throw new Error(`Release source contains an unsupported entry: ${sourceChild}.`);
    }
    const metadata = lstatSync(sourceChild);
    cpSync(sourceChild, targetChild);
    // cpSync's `mode` option is the COPYFILE flag bitmask, not a permission
    // mode; apply the source permission bits after the copy.
    chmodSync(targetChild, metadata.mode & 0o777);
  }
}

function isUnavailableError(error: unknown): boolean {
  return error instanceof ControllerClientError
    || (typeof error === "object"
      && error !== null
      && "code" in error
      && ((error as { code?: unknown }).code === "CONTROLLER_NOT_RUNNING"
        || (error as { code?: unknown }).code === "ECONNREFUSED"
        || (error as { code?: unknown }).code === "ECONNRESET"));
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
