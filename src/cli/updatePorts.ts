/**
 * Real {@link UpdatePorts} for `yui update`: side-by-side npm staging plus a
 * staged-binary read-only preflight, wired into the recoverable orchestration in
 * {@link runUpdate}.
 *
 * Staging installs the latest package into a throwaway prefix with
 * `npm install --global --prefix <tmp>`, so the live global install is never
 * touched until the binary-activation step. Preflight and post-verify invoke the
 * STAGED binary (`yui upgrade --dry-run`) so the new version — not the running
 * one — decides whether the target Home is safe.
 *
 * Two hardening guarantees this module enforces:
 *
 *  - **Promote the SAME artifact that was staged (P1-3).** `stage` resolves the
 *    exact version it installed from the staged package's own metadata; both the
 *    `StagedPackage.version` and `activateBinary` use that pinned version
 *    (`@zq-silk/yui@<version>`), never a second bare `@latest` that could resolve
 *    to a different build than the one that passed preflight.
 *  - **Verify the ACTUALLY-ACTIVATED binary (P1-3).** `verify` resolves the live
 *    global `yui` (via `npm prefix -g`), runs its `--json doctor`, AND confirms
 *    the promoted binary's reported version matches the staged version. A
 *    mismatch fails closed.
 *
 * And the ambiguity guarantee (P1-2): `activateStorage` returns `ambiguous`
 * (never a false "unchanged") when the child leaves no parseable receipt, and
 * `probeStorage` reads the durable receipt + backup + schema so the orchestrator
 * can resolve the true state.
 */

import { spawnSync, type SpawnSyncOptions, type SpawnSyncReturns } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runtimeError } from "../errors/cliError.js";
import { inspectStorageSchema } from "../storage/storageSchema.js";
import { readUpgradeReceipt } from "../storage/upgrade/upgradeOrchestrator.js";
import type {
  StagedPackage,
  StorageActivation,
  StorageStateProbe,
  UpdatePorts,
  UpdatePreflight
} from "./updateOrchestrator.js";

const PACKAGE_NAME = "@zq-silk/yui";
const PACKAGE_SPEC = `${PACKAGE_NAME}@latest`;

export type UpdateSpawner = (
  command: string,
  args: readonly string[],
  options: SpawnSyncOptions
) => SpawnSyncReturns<Buffer>;

/** Build the real ports. `spawn` is injectable so tests avoid real installs. */
export function createUpdatePorts(
  environment: NodeJS.ProcessEnv,
  spawn: UpdateSpawner = spawnSync
): UpdatePorts {
  return {
    stage(): StagedPackage {
      const stagingPath = mkdtempSync(join(tmpdir(), "yui-update-stage-"));
      const result = spawn(
        "npm",
        ["install", "--global", "--prefix", stagingPath, PACKAGE_SPEC],
        { cwd: process.cwd(), env: environment, shell: false, stdio: "inherit" }
      );
      assertSpawnOk(result, "stage the new package");
      const binaryPath = join(stagingPath, "bin", "yui");
      // Resolve the EXACT version that was staged (from the staged install's own
      // package.json), so activation promotes this same artifact rather than a
      // second, independently-resolved `@latest` (P1-3).
      const version = resolveStagedVersion(stagingPath, binaryPath, environment, spawn);
      return { binaryPath, version, stagingPath };
    },

    preflight(staged: StagedPackage, home: string): UpdatePreflight {
      const result = spawn(
        staged.binaryPath,
        ["--json", "upgrade", "--dry-run"],
        { cwd: process.cwd(), env: { ...environment, YUI_HOME: home }, shell: false }
      );
      return interpretPreflight(result);
    },

    activateStorage(staged: StagedPackage, home: string): StorageActivation {
      const result = spawn(
        staged.binaryPath,
        ["--json", "upgrade"],
        { cwd: process.cwd(), env: { ...environment, YUI_HOME: home }, shell: false }
      );
      return interpretActivation(result);
    },

    activateBinary(staged: StagedPackage): void {
      // Promote the SAME resolved artifact, pinned by exact version — not a fresh
      // bare `@latest` that could resolve to a different build than the one that
      // passed preflight/stage (P1-3).
      const spec = staged.version === "latest" || staged.version.length === 0
        ? PACKAGE_SPEC
        : `${PACKAGE_NAME}@${staged.version}`;
      const result = spawn(
        "npm",
        ["install", "--global", spec],
        { cwd: process.cwd(), env: environment, shell: false, stdio: "inherit" }
      );
      assertSpawnOk(result, "activate the new binary");
    },

    verify(staged: StagedPackage, home: string): void {
      // Verify the ACTUALLY-ACTIVATED global binary, not the staging path (P1-3).
      const activeBinary = resolveGlobalBinary(environment, spawn);
      if (activeBinary === null || !existsSync(activeBinary)) {
        throw runtimeError(
          "Post-update health check failed: could not locate the activated global `yui` binary."
        );
      }
      // 1) Health check the migrated Home through the activated binary's loader.
      const doctor = spawn(
        activeBinary,
        ["--json", "doctor"],
        { cwd: process.cwd(), env: { ...environment, YUI_HOME: home }, shell: false }
      );
      assertSpawnOk(doctor, "run the post-update health check");

      // 2) Confirm the activated binary's identity matches the staged artifact;
      // a mismatch (e.g. staged A but @latest moved to B) fails closed.
      if (staged.version !== "latest" && staged.version.length > 0) {
        const activeVersion = resolveBinaryVersion(activeBinary, environment, spawn);
        if (activeVersion !== null && activeVersion !== staged.version) {
          throw runtimeError(
            `Post-update health check failed: the activated binary is version ${activeVersion}, `
              + `but the staged/verified artifact was ${staged.version}. Refusing to trust a `
              + "different build than the one that passed preflight."
          );
        }
      }
    },

    probeStorage(home: string): StorageStateProbe {
      // Resolve an ambiguous activation from durable on-disk evidence (P1-2).
      const receipt = readUpgradeReceipt(home);
      const schema = inspectStorageSchema(home);
      return {
        switched: receipt !== null,
        schemaCurrent: schema.status === "current",
        ...(receipt?.backupPath === undefined ? {} : { backupPath: receipt.backupPath })
      };
    },

    cleanup(staged: StagedPackage): void {
      if (staged.stagingPath !== undefined) {
        rmSync(staged.stagingPath, { recursive: true, force: true });
      }
    }
  };
}

function interpretPreflight(result: SpawnSyncReturns<Buffer>): UpdatePreflight {
  const parsed = parseJsonResult(result);
  const data = parsed?.data as Record<string, unknown> | undefined;
  const outcome = typeof data?.outcome === "string" ? data.outcome : undefined;
  if (outcome === "already-current") return { status: "already-current" };
  if (outcome === "dry-run") {
    return { status: "migratable", summary: describe(data) };
  }
  return {
    status: "blocked",
    stage: typeof data?.stage === "string" ? data.stage : "preflight",
    message: typeof data?.message === "string" ? data.message : "Preflight was not safe.",
    action: typeof data?.action === "string"
      ? data.action
      : "Resolve the reported condition and retry."
  };
}

function interpretActivation(result: SpawnSyncReturns<Buffer>): StorageActivation {
  // A spawn transport error (could not even run) is a clean pre-switch failure.
  if (result.error !== undefined) {
    return {
      status: "ambiguous",
      detail: `the activation process could not be run: ${result.error.message}`
    };
  }
  // Killed by a signal, or a non-zero exit with no parseable JSON: the child may
  // have died after the atomic switch but before printing its result. This is
  // AMBIGUOUS, never a false "recoverable/unchanged" (P1-2).
  const parsed = parseJsonResult(result);
  if (parsed === null) {
    const how = result.signal !== null
      ? `terminated by ${result.signal}`
      : result.status === null
        ? "terminated without an exit code"
        : `exited with status ${result.status} and no parseable result`;
    return {
      status: "ambiguous",
      detail: `the activation process ${how}`
    };
  }
  const data = parsed.data as Record<string, unknown> | undefined;
  const outcome = typeof data?.outcome === "string" ? data.outcome : undefined;
  if (outcome === "already-current") return { status: "already-current" };
  if (outcome === "upgraded") {
    return {
      status: "migrated",
      ...(typeof data?.backupPath === "string" ? { backupPath: data.backupPath } : {})
    };
  }
  if (outcome === "blocked") {
    return {
      status: "blocked",
      stage: typeof data?.stage === "string" ? data.stage : "activate-storage",
      message: typeof data?.message === "string" ? data.message : "Storage activation was refused.",
      action: typeof data?.action === "string"
        ? data.action
        : "Resolve the reported condition and retry."
    };
  }
  // Parseable JSON but an unrecognized outcome: we cannot classify it, so it is
  // ambiguous rather than silently treated as a clean refusal.
  return {
    status: "ambiguous",
    detail: `the activation process returned an unrecognized outcome (${String(outcome)})`
  };
}

/**
 * Parse the `{ ok, data }` JSON envelope from a spawn result's stdout. Returns
 * `null` when the process errored, was killed, exited non-zero, or produced no
 * parseable JSON — every case the caller must treat as unresolved.
 */
function parseJsonResult(
  result: SpawnSyncReturns<Buffer>
): Record<string, unknown> | null {
  if (result.error !== undefined) return null;
  if (result.signal !== null || result.status === null) return null;
  try {
    const text = result.stdout.toString("utf8").trim();
    if (text.length === 0) return null;
    const value = JSON.parse(text) as Record<string, unknown>;
    return value;
  } catch {
    return null;
  }
}

/** Resolve the exact version of the staged install from its package metadata. */
function resolveStagedVersion(
  stagingPath: string,
  binaryPath: string,
  environment: NodeJS.ProcessEnv,
  spawn: UpdateSpawner
): string {
  // Prefer the staged package.json (deterministic, no extra process).
  const manifest = join(stagingPath, "lib", "node_modules", PACKAGE_NAME, "package.json");
  const fromManifest = readVersionFromPackageJson(manifest);
  if (fromManifest !== null) return fromManifest;
  // Fall back to asking the staged binary itself.
  const fromBinary = resolveBinaryVersion(binaryPath, environment, spawn);
  return fromBinary ?? "latest";
}

/** Read `version` from a package.json, or `null` when unavailable. */
function readVersionFromPackageJson(path: string): string | null {
  try {
    const value = JSON.parse(readFileSync(path, "utf8")) as { version?: unknown };
    return typeof value.version === "string" && value.version.length > 0 ? value.version : null;
  } catch {
    return null;
  }
}

/** Ask a `yui` binary for its version via `--json version`; `null` on failure. */
function resolveBinaryVersion(
  binaryPath: string,
  environment: NodeJS.ProcessEnv,
  spawn: UpdateSpawner
): string | null {
  const result = spawn(
    binaryPath,
    ["--json", "version"],
    { cwd: process.cwd(), env: environment, shell: false }
  );
  const parsed = parseJsonResult(result);
  const data = parsed?.data as Record<string, unknown> | undefined;
  return typeof data?.version === "string" && data.version.length > 0 ? data.version : null;
}

/** Resolve the live global `yui` binary path from `npm prefix -g`. */
function resolveGlobalBinary(
  environment: NodeJS.ProcessEnv,
  spawn: UpdateSpawner
): string | null {
  const result = spawn(
    "npm",
    ["prefix", "--global"],
    { cwd: process.cwd(), env: environment, shell: false }
  );
  if (result.error !== undefined || result.status !== 0) return null;
  const prefix = result.stdout.toString("utf8").trim();
  if (prefix.length === 0) return null;
  return join(prefix, "bin", "yui");
}

function describe(data: Record<string, unknown> | undefined): string {
  const report = data?.report as Record<string, unknown> | undefined;
  const steps = Array.isArray(report?.steps) ? report?.steps.length : 0;
  return `${steps} migration step(s) validated`;
}

function assertSpawnOk(result: SpawnSyncReturns<Buffer>, action: string): void {
  if (result.error !== undefined) {
    throw runtimeError(`Failed to ${action}: ${result.error.message}`);
  }
  if (result.status === null) {
    throw runtimeError(
      `Failed to ${action}: process terminated${result.signal === null ? "" : ` by ${result.signal}`}.`
    );
  }
  if (result.status !== 0) {
    throw runtimeError(`Failed to ${action}: exited with status ${result.status}.`);
  }
}
