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
import { correlateUpgradeReceipt } from "../storage/upgrade/upgradeOrchestrator.js";
import { readSwitchProgress } from "../storage/upgrade/switchProgress.js";
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
      // POST-VERIFY PARSES THE MACHINE-READABLE RESULT (P1-3). A zero exit is
      // necessary but NOT sufficient: parse doctor's structured storage-health
      // verdict and fail closed on any unsupported / corrupted / uninitialized /
      // version-mismatch storage check, even when the process exited 0.
      assertDoctorStorageHealthy(doctor);

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
      // Resolve an ambiguous activation from durable on-disk evidence (P1-2),
      // but only trust a receipt that CORRESPONDS to the current Home/backup
      // (P2-6): a leftover receipt from a prior attempt, a different Home, or one
      // whose backup was already restored/cleaned is NOT evidence that THIS
      // attempt's switch committed. When it does not correspond, fall back to the
      // on-disk schema and report `switched: false` so the caller re-probes the
      // real state instead of giving a recovery instruction from a stale receipt.
      const schema = inspectStorageSchema(home);

      // A crash mid-switch leaves a durable progress marker. Any phase — including
      // `backing-up` and `promoting`, not just `interrupted` — combined with
      // filesystem evidence that the original was moved aside (the backup exists)
      // and the Home is not in place means the authoritative data lives ONLY at
      // the backup. That is a known, precise restore, never a "most likely did not
      // commit" glob/retry that would send the operator to re-setup a missing Home
      // (F3). We only decline to treat a marker as interrupted when the Home is
      // demonstrably intact (nothing to recover) or there is no backup to restore.
      const progress = readSwitchProgress(home);
      if (progress !== null) {
        const backupPresent = progress.backupPath !== undefined
          && existsSync(progress.backupPath);
        // The Home is "in place" only when storage is actually initialized there;
        // a missing/uninitialized Home after a mid-switch crash means the data is
        // at the backup.
        const homeInitialized = schema.status !== "uninitialized";
        if (progress.phase === "interrupted"
          || (backupPresent && !homeInitialized)) {
          // Original at the backup, Home missing/uninitialized: recover by restore.
          return {
            switched: false,
            interrupted: true,
            schemaCurrent: schema.status === "current",
            ...(progress.backupPath === undefined ? {} : { backupPath: progress.backupPath })
          };
        }
        // A pre-start/complete-ish marker with an intact Home (or no usable backup)
        // is not an interrupted switch — fall through to the receipt/schema logic.
      }

      const correlation = correlateUpgradeReceipt(home);
      if (!correlation.corresponds) {
        return { switched: false, schemaCurrent: schema.status === "current" };
      }
      const receipt = correlation.receipt;
      return {
        switched: true,
        schemaCurrent: schema.status === "current",
        ...(receipt.backupPath === undefined ? {} : { backupPath: receipt.backupPath })
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
  // EXIT/OUTCOME CONSISTENCY (P1-2): preflight is read-only, but a success-class
  // outcome paired with a non-zero exit is still a violated contract. Treat it as
  // blocked (do NOT proceed to a switch on an inconsistent green preflight).
  if ((outcome === "already-current" || outcome === "dry-run") && result.status !== 0) {
    return {
      status: "blocked",
      stage: "preflight",
      message:
        `The staged binary reported outcome=${outcome} but exited with status `
        + `${result.status ?? "null"}; a safe preflight must exit 0. Refusing to proceed.`,
      action: "Investigate the staged binary; do not force an update on an inconsistent preflight."
    };
  }
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
  // EXIT STATUS / OUTCOME CONSISTENCY (P1-2)
  // A success-class outcome is only trustworthy when the child ALSO exited 0. A
  // contradiction (e.g. stdout says `upgraded` but the process exited non-zero)
  // means the child's own contract was violated mid-flight — the switch may or
  // may not have committed — so it is AMBIGUOUS, never a false success. Blocker-
  // class outcomes are exempt: `yui upgrade` deliberately exits non-zero (5) for
  // a clean `blocked`, so a non-zero exit there is expected and consistent.
  if ((outcome === "already-current" || outcome === "upgraded") && result.status !== 0) {
    return {
      status: "ambiguous",
      detail:
        `the activation process reported outcome=${outcome} but exited with status `
        + `${result.status ?? "null"} (a success outcome must exit 0); the switch state is unknown`
    };
  }
  if (outcome === "already-current") return { status: "already-current" };
  if (outcome === "upgraded") {
    return {
      status: "migrated",
      ...(typeof data?.backupPath === "string" ? { backupPath: data.backupPath } : {})
    };
  }
  if (outcome === "blocked") {
    const stage = typeof data?.stage === "string" ? data.stage : "activate-storage";
    // A `switch-ambiguous` blocker is NOT a clean, recoverable refusal (P1-4):
    // the upgrade's atomic switch was left partially applied (original moved to
    // backup, promotion + rollback both failed). Route it to AMBIGUOUS so the
    // orchestrator probes the interrupted marker and reports a restore, never a
    // false "the current install and Home remain usable".
    if (stage === "switch-ambiguous") {
      return {
        status: "ambiguous",
        detail: typeof data?.message === "string"
          ? data.message
          : "the storage switch was left partially applied"
      };
    }
    return {
      status: "blocked",
      stage,
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

/**
 * Fail closed unless the doctor result proves the migrated Home's storage is
 * healthy (P1-3). Parses the machine-readable `{ ok, data: { storage } }`
 * envelope and throws when storage is unhealthy — or when the result cannot be
 * parsed at all, since an unverifiable health check must not pass silently.
 */
function assertDoctorStorageHealthy(result: SpawnSyncReturns<Buffer>): void {
  const parsed = parseJsonResult(result);
  const data = parsed?.data as Record<string, unknown> | undefined;
  const storage = data?.storage as
    | { healthy?: unknown; blocking?: unknown }
    | undefined;
  if (storage === undefined || typeof storage.healthy !== "boolean") {
    throw runtimeError(
      "Post-update health check failed: the activated binary's `doctor` did not return a "
        + "parseable storage-health result, so the migrated Home cannot be confirmed healthy. "
        + "Investigate with `yui doctor` before resuming; if storage was migrated, restore the "
        + "timestamped backup to recover."
    );
  }
  if (storage.healthy !== true) {
    const blocking = Array.isArray(storage.blocking) ? storage.blocking : [];
    const detail = blocking
      .map((check) => {
        const record = check as Record<string, unknown>;
        return `${String(record.name)}=${String(record.status)} (${String(record.detail)})`;
      })
      .join("; ");
    throw runtimeError(
      "Post-update health check failed: the migrated Home is not healthy per the activated "
        + `binary's doctor: ${detail || "(no detail)"}. The storage did not come up cleanly on `
        + "the new version. Restore the timestamped backup to recover the original Home before "
        + "resuming writes."
    );
  }
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
