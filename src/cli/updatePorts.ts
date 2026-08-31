/**
 * Real {@link UpdatePorts} for `yui update`: side-by-side npm staging plus a
 * staged-binary path-specific read-only preflight, wired into the recoverable
 * orchestration in {@link runUpdate}.
 *
 * Staging installs the latest package into a throwaway prefix with
 * `npm install --global --prefix <tmp>`, so the live global install is never
 * touched until the binary-activation step. Preflight invokes the STAGED binary's
 * internal `yui upgrade --update-preflight` contract so the target version
 * classifies the Home, validates a compatible source in memory, or reads the
 * authoritative offline inventory as required by that path. After the parent
 * stops the exact old Controller, storage activation performs the full staged
 * validation/switch. Post-verify invokes the actually activated global binary.
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
import { accessSync, constants, existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import Database from "better-sqlite3";

import { runtimeError } from "../errors/cliError.js";
import { isConcreteVersion } from "../domain/validation.js";
import { STORAGE_DOCTOR_CHECK_NAMES } from "../doctor/doctor.js";
import { acquireHandoverLock } from "../release/runtimeRelease.js";
import { inspectStorageSchema } from "../storage/storageSchema.js";
import { placeUpgradeFence } from "../storage/upgradeFence.js";
import { correlateUpgradeReceipt } from "../storage/upgrade/upgradeOrchestrator.js";
import { readSwitchProgress } from "../storage/upgrade/switchProgress.js";
import type {
  StagedPackage,
  ControllerIdentity,
  StorageActivation,
  StorageStateProbe,
  UpdateControllerLifecycleStatus,
  UpdateControllerStopResult,
  UpdateBlockerIdentity,
  UpdatePorts,
  UpdatePreflight,
  UpdateSqliteLedgerHead,
  UpdateSqliteMigrationBoundary
} from "./updateOrchestrator.js";

const PACKAGE_NAME = "@zq-silk/yui";
const PACKAGE_SPEC = `${PACKAGE_NAME}@latest`;

function resolveExecutable(command: string, environmentPath: string | undefined): string | undefined {
  if (isAbsolute(command)) return command;
  for (const directory of (environmentPath ?? "").split(delimiter)) {
    if (directory.length === 0) continue;
    const candidate = resolve(directory, command);
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      // Keep walking PATH; callers fail closed when no executable is found.
    }
  }
  return undefined;
}

function failedSpawnResult(message: string): SpawnSyncReturns<Buffer> {
  return {
    pid: undefined,
    output: [null, Buffer.alloc(0), Buffer.from(message)],
    stdout: Buffer.alloc(0),
    stderr: Buffer.from(message),
    status: 127,
    signal: null,
    error: new Error(message)
  } as unknown as SpawnSyncReturns<Buffer>;
}

export type UpdateSpawner = (
  command: string,
  args: readonly string[],
  options: SpawnSyncOptions
) => SpawnSyncReturns<Buffer>;

/** Build the real ports. `spawn` is injectable so tests avoid real installs. */
export function createUpdatePorts(
  environment: NodeJS.ProcessEnv,
  spawn: UpdateSpawner = spawnSync,
  stagingRoot: string = tmpdir()
): UpdatePorts {
  // The production adapter must not let a later PATH change select a
  // different npm during staging, activation, or recovery. Test doubles are
  // intentionally left untouched so deterministic tests can dispatch on the
  // stable command name `npm`.
  const trustedNpm = spawn === spawnSync
    ? resolveExecutable("npm", environment.PATH)
    : "npm";
  const run: UpdateSpawner = (command, args, options) => {
    if (command !== "npm") return spawn(command, args, options);
    if (trustedNpm === undefined) {
      return failedSpawnResult("Unable to resolve trusted executable: npm");
    }
    return spawn(trustedNpm, args, options);
  };
  // Keep the exact verified artifact in memory for this update attempt. This is
  // deliberately not persisted as a retry or recovery protocol.
  let verifiedActivatedBinary: string | undefined;
  let verifiedActivatedVersion: string | undefined;
  let storageFenceOwnerPid: number | undefined;
  const stopReplacementController = (home: string, pid: number): UpdateControllerStopResult => (
    stopReplacementControllerForUpdate(home, pid, environment, run)
  );
  return {
    beginControllerHandover(home: string): () => void {
      return acquireHandoverLock(home).release;
    },
    beginStorageWriteFence(home: string): () => void {
      const release = placeUpgradeFence(home, {
        reason: "update storage activation in progress",
        createdAt: new Date().toISOString(),
        ownerPid: process.pid
      });
      storageFenceOwnerPid = process.pid;
      let released = false;
      return () => {
        if (released) return;
        release();
        released = true;
        if (storageFenceOwnerPid === process.pid) storageFenceOwnerPid = undefined;
      };
    },
    stage(version?: string): StagedPackage {
      // A caller that names a version (the release workflow, which freezes the
      // exact version in its plan) installs THAT version — never a moving
      // `latest` that could resolve to a different build than the one the
      // plan authorized. A non-concrete value fails closed rather than being
      // interpolated into an install spec. An omitted version keeps the
      // interactive `yui update` behavior of staging latest.
      const spec = version === undefined
        ? PACKAGE_SPEC
        : isConcreteVersion(version)
          ? `${PACKAGE_NAME}@${version.trim()}`
          : null;
      if (spec === null) {
        throw runtimeError(
          `Refusing to stage a non-concrete version (${String(version)}): only an exact `
            + "major.minor.patch version can be pinned for an update."
        );
      }
      const stagingPath = mkdtempSync(join(stagingRoot, "yui-update-stage-"));
      let ownsStaging = true;
      try {
        const result = run(
          "npm",
          ["install", "--global", "--prefix", stagingPath, spec],
          { cwd: process.cwd(), env: environment, shell: false, stdio: "inherit" }
        );
        assertSpawnOk(result, "stage the new package");
        const binaryPath = join(stagingPath, "bin", "yui");
        // Resolve the EXACT version that was staged (from the staged install's own
        // package.json, else the staged binary itself). If neither yields a concrete
        // version, FAIL the stage (R2-F1): we must never fall back to a bare
        // `@latest`, which would let activation promote — and verify wave through —
        // a different build than the one that passed preflight.
        const version = resolveStagedVersion(stagingPath, binaryPath, environment, run);
        if (version === null) {
          throw runtimeError(
            "Failed to resolve the exact staged package version (neither the staged package.json "
              + "nor `yui --json version` returned a concrete version). Refusing to proceed with a "
              + "`@latest` fallback that could promote a different build than the one preflighted."
          );
        }
        // Successful staging transfers cleanup ownership to runUpdate's finally
        // block. Every assertion, spawn, npm/network, or version-resolution
        // failure before that handoff removes the throwaway prefix here.
        ownsStaging = false;
        return { binaryPath, version, stagingPath };
      } finally {
        if (ownsStaging) rmSync(stagingPath, { recursive: true, force: true });
      }
    },

    preflight(staged: StagedPackage, home: string): UpdatePreflight {
      const result = run(
        staged.binaryPath,
        ["--json", "upgrade", "--update-preflight"],
        { cwd: process.cwd(), env: { ...environment, YUI_HOME: home }, shell: false }
      );
      return interpretPreflight(result);
    },

    activateStorage(staged: StagedPackage, home: string): StorageActivation {
      const result = run(
        staged.binaryPath,
        ["--json", "upgrade"],
        {
          cwd: process.cwd(),
          // The parent update process captures/stops/drains the old Controller
          // before invoking the staged child. Mark this internal call so the
          // child performs storage migration only and never starts a Controller
          // from the temporary staging installation.
          env: {
            ...environment,
            YUI_HOME: home,
            YUI_UPDATE_EXTERNALLY_QUIESCED: "1",
            ...(storageFenceOwnerPid === undefined
              ? {}
              : { YUI_UPDATE_HANDOVER_OWNER_PID: String(storageFenceOwnerPid) })
          },
          shell: false
        }
      );
      return interpretActivation(result);
    },

    activateBinary(staged: StagedPackage): void {
      verifiedActivatedBinary = undefined;
      verifiedActivatedVersion = undefined;
      // Promote the SAME resolved artifact, pinned by exact version — never a bare
      // `@latest` (R2-F1: `stage` guarantees `staged.version` is a concrete
      // version, so there is no `latest` sentinel to fall back to).
      const spec = `${PACKAGE_NAME}@${staged.version}`;
      const result = run(
        "npm",
        ["install", "--global", spec],
        { cwd: process.cwd(), env: environment, shell: false, stdio: "inherit" }
      );
      assertSpawnOk(result, "activate the new binary");
    },

    verify(staged: StagedPackage, home: string): void {
      // Verify the ACTUALLY-ACTIVATED global binary, not the staging path (P1-3).
      const activeBinary = resolveGlobalBinary(environment, run);
      if (activeBinary === null || !existsSync(activeBinary)) {
        throw runtimeError(
          "Post-update health check failed: could not locate the activated global `yui` binary."
        );
      }
      // 1) Health check the migrated Home through the activated binary's loader.
      // POST-VERIFY PARSES THE MACHINE-READABLE RESULT FIRST, THEN THE EXIT STATUS
      // (R2-F2). `yui --json doctor` deliberately sets a non-zero exit when storage
      // is unhealthy, so interpreting the exit status before the envelope would
      // reduce a precise "storage unsupported/corrupted" verdict to a generic
      // "exited with status 5". We therefore parse+validate the structured storage
      // health first: only a valid success envelope with every expected storage
      // check present-and-ok, no blocking checks, AND exit 0 is healthy.
      const doctor = run(
        activeBinary,
        ["--json", "doctor"],
        { cwd: process.cwd(), env: { ...environment, YUI_HOME: home }, shell: false }
      );
      assertDoctorStorageHealthy(doctor);

      // 2) Confirm the activated binary's identity matches the staged artifact.
      // `staged.version` is always a concrete version (R2-F1), so we REQUIRE the
      // activated binary to report a concrete version that equals it; a missing,
      // unparseable, or non-zero `version` result fails closed rather than being
      // skipped — we must never trust a build we cannot positively identify.
      const activeVersion = resolveBinaryVersion(activeBinary, environment, spawn);
      if (activeVersion === null) {
        throw runtimeError(
          "Post-update health check failed: could not determine the activated binary's version "
            + `(expected ${staged.version}). Refusing to trust a build whose identity cannot be `
            + "confirmed against the staged/preflighted artifact."
        );
      }
      if (activeVersion !== staged.version) {
        throw runtimeError(
          `Post-update health check failed: the activated binary is version ${activeVersion}, `
            + `but the staged/verified artifact was ${staged.version}. Refusing to trust a `
            + "different build than the one that passed preflight."
        );
      }
      // Existing managed Sessions may have been created by an earlier release.
      // Retarget those authenticated, Manifest-referenced wrappers to the
      // activated control plane before the replacement Controller starts so
      // the update cannot strand a live Session.
      const sessionCliRefresh = run(
        activeBinary,
        ["--json", "internal", "session-cli-refresh"],
        { cwd: process.cwd(), env: { ...environment, YUI_HOME: home }, shell: false }
      );
      assertSpawnOk(sessionCliRefresh, "refresh managed Session CLI wrappers");
      // Retain the exact path used by both doctor and version verification. The
      // replacement start must not resolve UPDATE_CLI_PATH or npm again.
      verifiedActivatedBinary = activeBinary;
      verifiedActivatedVersion = activeVersion;
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
      const sqliteSchemaHead = inspectSqliteSchemaHead(home);

      // A crash mid-switch leaves a durable progress marker. A marker of ANY phase
      // — `backing-up`, `promoting`, or `interrupted` — is only actionable as an
      // interrupted switch when the FILESYSTEM still corroborates it: the backup
      // exists AND the Home is not in place (missing/uninitialized), so the
      // authoritative data lives only at the backup and the recovery is a precise
      // restore. This gate now applies to `interrupted` too (R2-F3): a leftover
      // `interrupted` marker after a manual recovery — Home already restored, or
      // the backup already gone — must NOT be trusted to emit a restore path; we
      // ignore the stale marker and re-probe the real state below.
      const progress = readSwitchProgress(home);
      if (progress !== null) {
        const backupPresent = progress.backupPath !== undefined
          && existsSync(progress.backupPath);
        // The Home is "in place" only when storage is actually initialized there;
        // a missing/uninitialized Home after a mid-switch crash means the data is
        // at the backup.
        const homeInitialized = schema.status !== "uninitialized";
        if (backupPresent && !homeInitialized) {
          // Original at the backup, Home missing/uninitialized: recover by restore.
          // The Home is uninitialized here, so it is definitively not current.
          return {
            switched: false,
            interrupted: true,
            schemaCurrent: false,
            ...(sqliteSchemaHead === undefined ? {} : { sqliteSchemaHead }),
            ...(progress.backupPath === undefined ? {} : { backupPath: progress.backupPath })
          };
        }
        // Otherwise the marker is stale relative to the current filesystem (Home
        // intact, or no backup to restore). Do not emit a restore path from it —
        // fall through and reconcile against the receipt/schema below.
      }

      const correlation = correlateUpgradeReceipt(home);
      if (!correlation.corresponds) {
        return {
          switched: false,
          schemaCurrent: schema.status === "current",
          ...(sqliteSchemaHead === undefined ? {} : { sqliteSchemaHead })
        };
      }
      const receipt = correlation.receipt;
      return {
        switched: true,
        schemaCurrent: schema.status === "current",
        ...(sqliteSchemaHead === undefined ? {} : { sqliteSchemaHead }),
        ...(receipt.backupPath === undefined ? {} : { backupPath: receipt.backupPath })
      };
    },

    cleanup(staged: StagedPackage): void {
      if (staged.stagingPath !== undefined) {
        rmSync(staged.stagingPath, { recursive: true, force: true });
      }
    },

    // `runUpdate` is intentionally synchronous because the npm/staged-binary
    // ports use spawnSync. A short-lived child owns the async, exactly fenced
    // reconciliation first; lifecycle capture then uses structured live
    // Controller commands. Tests can replace these seams with deterministic
    // fakes without touching a real Controller.
    controllerStatus(home: string): UpdateControllerLifecycleStatus {
      reconcileControllerResourcesForUpdate(home, environment, spawn);
      return readControllerLifecycle(home, environment, spawn);
    },
    stopController(home: string, expectedPid: number): UpdateControllerStopResult {
      return stopControllerForUpdate(home, expectedPid, environment, spawn);
    },
    stopReplacementController,
    startController(home: string): void {
      if (verifiedActivatedBinary === undefined || verifiedActivatedVersion === undefined) {
        throw runtimeError(
          "Replacement Controller cannot start before the activated global binary has "
            + "passed doctor/version verification."
        );
      }
      restartControllerForUpdate(
        home,
        environment,
        spawn,
        verifiedActivatedBinary,
        verifiedActivatedVersion,
        stopReplacementController
      );
    },
    restoreController(home: string, identity: ControllerIdentity): void {
      restoreControllerIdentity(home, identity, environment, spawn);
    }
  };
}

/**
 * Read the generic durable SQLite ledger without asking the old parent binary
 * to understand the staged release's migration registry. The staged preflight
 * supplies the validated source and target heads used to interpret this value.
 */
function inspectSqliteSchemaHead(home: string): UpdateSqliteLedgerHead | undefined {
  const path = join(home, "yui.db");
  if (!existsSync(path)) return undefined;
  const db = new Database(path, { readonly: true, fileMustExist: true });
  try {
    db.pragma("query_only = ON");
    const rows = db.prepare(
      "SELECT version, checksum FROM schema_migrations ORDER BY version"
    ).all() as Array<{ version: unknown; checksum: unknown }>;
    if (rows.length === 0) throw new Error("SQLite migration ledger is empty.");
    for (let index = 0; index < rows.length; index += 1) {
      const row = rows[index]!;
      if (row.version !== index + 1
        || typeof row.checksum !== "string"
        || row.checksum.length === 0) {
        throw new Error("SQLite migration ledger is not a contiguous checksummed prefix.");
      }
    }
    const head = rows.at(-1)!;
    return {
      version: head.version as number,
      checksum: head.checksum as string
    };
  } finally {
    db.close();
  }
}

const UPDATE_CLI_PATH = fileURLToPath(new URL("../cli.js", import.meta.url));
const UPDATE_CLIENT_RUNTIME_PATH = fileURLToPath(new URL("../controller/clientRuntime.js", import.meta.url));
const UPDATE_CONTROLLER_RECONCILIATION_PATH = fileURLToPath(
  new URL("../controller/updateReconciliation.js", import.meta.url)
);

/**
 * Capture running state plus an authenticated exact process identity before
 * stopping. Public `controller status` is an inventory and intentionally
 * redacts argv, so current/orphan/stale/uncertain inventory states are never
 * guessed into "stopped".
 */
function readControllerLifecycle(
  home: string,
  environment: NodeJS.ProcessEnv,
  spawn: UpdateSpawner,
  cliBinary?: string
): UpdateControllerLifecycleStatus {
  const data = runControllerCommand(home, environment, spawn, "status", cliBinary);
  if (!Array.isArray(data.resources)) {
    throw new Error("Controller inventory is malformed; treating ownership as unknown-active.");
  }
  const resources = data.resources;
  if (
    data.warnings !== undefined
    && (!Array.isArray(data.warnings) || data.warnings.some((warning) => typeof warning !== "string"))
  ) {
    throw new Error("Controller inventory warnings are malformed; treating ownership as unknown-active.");
  }
  if (Array.isArray(data.warnings) && data.warnings.length > 0) {
    throw new Error(
      `Controller inventory is uncertain: ${data.warnings.join("; ")}`
    );
  }
  const resolvedHome = resolve(home);
  const homeResources = resources.filter((resource) => (
    isRecord(resource) && resource.yuiHome === resolvedHome
  ));
  const controllerResources = homeResources.filter((resource) => (
    resource.kind === "controller"
  ));
  const controllerArtifacts = homeResources.filter((resource) => (
    resource.kind === "artifact"
      && isRecord(resource.artifact)
      && (resource.artifact.artifactKind === "controller-discovery"
        || resource.artifact.artifactKind === "controller-socket")
  ));
  const currentResources = controllerResources.filter((resource) => (
    resource.state === "current"
  ));
  if (
    controllerArtifacts.length > 0
    || controllerResources.some((resource) => resource.state !== "current")
    || currentResources.length > 1
  ) {
    throw new Error(
      "Controller inventory found an orphaned, stale, invalid, or ambiguous resource; "
        + "treating ownership as unknown-active."
    );
  }
  const current = resources.find((resource) => (
    isRecord(resource)
      && resource.kind === "controller"
      && resource.state === "current"
      && resource.yuiHome === resolvedHome
  ));
  const processes = isRecord(current) && Array.isArray(current.processes)
    ? current.processes
    : [];
  const processInfo = processes.find((value) => isRecord(value));
  if (!isRecord(processInfo)) {
    if (current !== undefined) {
      throw new Error(
        "Controller inventory is current but has no process proof; treating ownership as unknown-active."
      );
    }
    return proveControllerAbsent(home, environment, spawn, cliBinary);
  }
  const identity = parseControllerIdentity(
    runControllerCommand(home, environment, spawn, "live-identity", cliBinary)
  );
  return {
    running: true,
    ...(isPositivePid(processInfo.pid) ? { pid: processInfo.pid } : {}),
    identity
  };
}

function proveControllerAbsent(
  home: string,
  environment: NodeJS.ProcessEnv,
  spawn: UpdateSpawner,
  cliBinary?: string
): UpdateControllerLifecycleStatus {
  try {
    runControllerCommand(home, environment, spawn, "live-identity", cliBinary);
  } catch (error) {
    if (controllerErrorCode(error) === "CONTROLLER_NOT_RUNNING") {
      return { running: false };
    }
    throw new Error(
      `Controller absence could not be authenticated: ${messageOf(error)}`,
      { cause: error }
    );
  }
  throw new Error(
    "A live Controller identity is reachable but inventory is currentless; treating ownership as unknown-active."
  );
}

function stopControllerForUpdate(
  home: string,
  expectedPid: number,
  environment: NodeJS.ProcessEnv,
  spawn: UpdateSpawner
): UpdateControllerStopResult {
  // Parent update owns this lifecycle boundary. Invoke the runtime client
  // directly in a short-lived child so a migratable old-schema Home is not
  // forced through the public `controller stop` command's current-schema gate.
  // The public command remains gated; this helper is reachable only from the
  // update-owned port and returns the runtime's structured confirmation.
  if (!isPositivePid(expectedPid)) {
    throw new Error("Controller stop requires the exact positive PID captured by status.");
  }
  const result = runSchemaIndependentControllerStop(home, environment, spawn, expectedPid);
  if (typeof result.stopped !== "boolean") {
    throw new Error("Controller stop returned no structured stopped confirmation.");
  }
  if (result.alreadyStopped !== undefined && result.alreadyStopped !== true) {
    throw new Error("Controller stop returned an invalid alreadyStopped confirmation.");
  }
  if (result.pid !== undefined && !isPositivePid(result.pid)) {
    throw new Error("Controller stop returned an invalid PID confirmation.");
  }
  if (result.stopped !== true || result.pid !== expectedPid) {
    throw new Error(
      `Controller stop did not confirm the captured PID ${expectedPid}; refusing an unfenced handoff.`
    );
  }
  return result;
}

/**
 * Stop a replacement only after the caller has authenticated this exact PID
 * against the restart/readiness boundary.  The client/runtime path sends the
 * PID fence to the Controller server itself, so a socket/discovery race cannot
 * silently turn this cleanup into a stop of a foreign owner.
 */
function stopReplacementControllerForUpdate(
  home: string,
  expectedPid: number,
  environment: NodeJS.ProcessEnv,
  spawn: UpdateSpawner
): UpdateControllerStopResult {
  if (!isPositivePid(expectedPid)) {
    throw unknownActiveControllerError("replacement PID was not a positive integer");
  }
  const result = runSchemaIndependentControllerStop(home, environment, spawn, expectedPid);
  if (
    result.stopped !== true
    || result.pid !== expectedPid
  ) {
    throw unknownActiveControllerError(
      `fenced stop did not confirm the authenticated replacement PID ${expectedPid}`
    );
  }
  return result;
}

/**
 * Stop only the Controller owned by parent update, without dispatching the
 * public CLI command. `stopFileTaskController` authenticates the discovery,
 * issues exactly one stop RPC, and drains the owned discovery before returning.
 */
function runSchemaIndependentControllerStop(
  home: string,
  environment: NodeJS.ProcessEnv,
  spawn: UpdateSpawner,
  expectedPid?: number
): UpdateControllerStopResult {
  const helper = [
    "const values = process.argv.slice(1);",
    "const expectedPid = values.length === 3 ? Number(values.pop()) : undefined;",
    "const home = values.pop();",
    "const runtimeModule = values.pop();",
    "(async () => {",
    "  const { stopFileTaskController } = await import(runtimeModule);",
    "  const data = await stopFileTaskController(home, {",
    "    environment: process.env,",
    "    ...(expectedPid === undefined ? {} : { expectedPid })",
    "  });",
    "  process.stdout.write(JSON.stringify({ ok: true, data }));",
    "})().catch((error) => {",
    "  const code = typeof error?.code === 'string' ? error.code : 'RUNTIME_ERROR';",
    "  const message = error instanceof Error ? error.message : String(error);",
    "  process.stderr.write(JSON.stringify({ ok: false, code, message }));",
    "  process.exitCode = 5;",
    "});"
  ].join(" ");
  const result = spawn(
    process.execPath,
    [
      "-e",
      helper,
      UPDATE_CLIENT_RUNTIME_PATH,
      home,
      ...(expectedPid === undefined ? [] : [String(expectedPid)])
    ],
    { cwd: process.cwd(), env: { ...environment, YUI_HOME: home }, shell: false }
  );
  if (result.error !== undefined || result.status !== 0) {
    const detail = result.stderr.toString("utf8").trim();
    throw new Error(
      `Controller stop failed (exit ${result.status ?? "null"})${detail.length === 0 ? "." : `: ${detail}`}`
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(result.stdout.toString("utf8"));
  } catch (error) {
    throw new Error("Controller stop returned an invalid structured result.", { cause: error });
  }
  if (!isRecord(parsed) || parsed.ok !== true || !isRecord(parsed.data)) {
    throw new Error("Controller stop returned an invalid structured result.");
  }
  const data = parsed.data;
  if (
    typeof data.stopped !== "boolean"
    || (data.alreadyStopped !== undefined && data.alreadyStopped !== true)
    || (data.pid !== undefined && !isPositivePid(data.pid))
  ) {
    throw new Error("Controller stop returned an invalid structured confirmation.");
  }
  return {
    stopped: data.stopped,
    ...(data.alreadyStopped === true ? { alreadyStopped: true } : {}),
    ...(data.pid === undefined ? {} : { pid: data.pid })
  };
}

function restartControllerForUpdate(
  home: string,
  environment: NodeJS.ProcessEnv,
  spawn: UpdateSpawner,
  activatedBinary: string,
  activatedVersion: string,
  stopReplacementController: (home: string, pid: number) => UpdateControllerStopResult
): void {
  let restart: { output?: string; data?: Record<string, unknown> };
  try {
    restart = runControllerCommandOutput(home, environment, spawn, "restart", activatedBinary);
  } catch (error) {
    // A restart transport/exit failure may have occurred after the activated
    // runtime spawned its replacement.  No PID ownership proof exists in that
    // case, so never fall through to old-identity restore.
    throw unknownActiveControllerError(
      `activated Controller restart outcome is unknown: ${messageOf(error)}`
    );
  }
  const replacementPid = parseReplacementPid(restart.data);
  let identityFailure: unknown;
  try {
    const identity = parseControllerIdentity(
      runControllerCommand(home, environment, spawn, "live-identity", activatedBinary)
    );
    assertActivatedControllerIdentity(identity, activatedBinary, activatedVersion);
  } catch (error) {
    identityFailure = error;
  }

  // Readiness is authenticated twice: the restart result carries the PID that
  // the activated runtime started, and an inventory/identity read through that
  // same binary proves that PID still owns this Home.  A mismatch may therefore
  // stop only the process proven to belong to this update; if that proof is
  // unavailable, fail closed with an explicit unknown-active blocker.
  let readiness: UpdateControllerLifecycleStatus;
  try {
    readiness = readControllerLifecycle(home, environment, spawn, activatedBinary);
    if (!readiness.running || readiness.pid !== replacementPid) {
      throw new Error(
        `replacement readiness PID ${readiness.pid === undefined ? "none" : readiness.pid} `
          + `does not match the authenticated restart PID ${replacementPid}`
      );
    }
    assertActivatedControllerIdentity(readiness.identity!, activatedBinary, activatedVersion);
  } catch (error) {
    throw stopMismatchedReplacementOrBlock(
      home,
      environment,
      spawn,
      activatedBinary,
      replacementPid,
      stopReplacementController,
      identityFailure ?? new Error(
        `replacement readiness could not authenticate PID ${replacementPid}: ${messageOf(error)}`
      )
    );
  }
  if (identityFailure !== undefined) {
    throw stopMismatchedReplacementOrBlock(
      home,
      environment,
      spawn,
      activatedBinary,
      replacementPid,
      stopReplacementController,
      identityFailure
    );
  }
}

function parseReplacementPid(data: Record<string, unknown> | undefined): number {
  if (
    data === undefined
    || data.restarted !== true
    || !isPositivePid(data.pid)
    || (data.previousPid !== undefined && !isPositivePid(data.previousPid))
  ) {
    throw unknownActiveControllerError(
      "activated Controller restart returned no authenticated replacement PID"
    );
  }
  return data.pid;
}

function stopMismatchedReplacementOrBlock(
  home: string,
  environment: NodeJS.ProcessEnv,
  spawn: UpdateSpawner,
  activatedBinary: string,
  replacementPid: number,
  stopReplacementController: (home: string, pid: number) => UpdateControllerStopResult,
  mismatch: unknown
): Error {
  try {
    const ownership = readControllerLifecycle(home, environment, spawn, activatedBinary);
    if (!ownership.running || ownership.pid !== replacementPid) {
      throw new Error(
        `authenticated replacement ownership was lost (expected PID ${replacementPid}, `
          + `found ${ownership.pid === undefined ? "none" : ownership.pid})`
      );
    }
    const stopped = stopReplacementController(home, replacementPid);
    if (stopped.stopped !== true || stopped.pid !== replacementPid) {
      throw new Error(
        `fenced replacement stop did not confirm PID ${replacementPid}`
      );
    }
  } catch (error) {
    return unknownActiveControllerError(
      `${messageOf(mismatch)}; cannot prove safe ownership-aware cleanup: ${messageOf(error)}`
    );
  }
  const error = new Error(
    `${messageOf(mismatch)} The replacement Controller PID ${replacementPid} was authenticated `
      + `as this update's owner and stopped; refusing replacement readiness.`
  );
  Object.assign(error, {
    code: "UPDATE_CONTROLLER_IDENTITY_MISMATCH",
    replacementPid,
    replacementStopped: true
  });
  return error;
}

function unknownActiveControllerError(reason: string): Error {
  const error = new Error(
    `Replacement Controller is unknown-active: ${reason}. Do not resume writes or restore `
      + "the old identity blindly."
  );
  Object.assign(error, { code: "UPDATE_CONTROLLER_UNKNOWN_ACTIVE" });
  return error;
}

/** Restore the captured process identity, never the staged/new `yui` launcher. */
function restoreControllerIdentity(
  home: string,
  identity: ControllerIdentity,
  environment: NodeJS.ProcessEnv,
  spawn: UpdateSpawner
): void {
  const launchEnvironment = { ...environment, YUI_HOME: home };
  // Spawn a detached child through a short-lived Node helper so the synchronous
  // update process can still use the authenticated, bounded readiness handshake
  // shared by Controller startup. No retry, sleep, or new identity inference is
  // hidden here.
  const helper = [
    "const { spawn } = require('node:child_process');",
    "const values = process.argv.slice(1);",
    "const version = values.pop();",
    "const args = JSON.parse(values.pop());",
    "const executable = values.pop();",
    "const home = values.pop();",
    "const runtimeModule = values.pop();",
    "(async () => {",
    "  const { ensureFileTaskControllerIdentity } = await import(runtimeModule);",
    "  await ensureFileTaskControllerIdentity(home, { executablePath: executable, args, version }, {",
    "    environment: process.env,",
    "    spawnController: (_home, launchEnv) => {",
    "      const child = spawn(executable, args, { detached: true, stdio: 'ignore', env: launchEnv });",
    "      child.unref();",
    "    }",
    "  });",
    "})().catch((error) => { process.stderr.write(String(error?.stack || error)); process.exitCode = 1; });"
  ].join(" ");
  const result = spawn(
    process.execPath,
    [
      "-e",
      helper,
      UPDATE_CLIENT_RUNTIME_PATH,
      home,
      identity.executablePath,
      JSON.stringify(identity.args),
      identity.version
    ],
    { cwd: process.cwd(), env: launchEnvironment, shell: false, stdio: "pipe" }
  );
  assertSpawnOk(result, "restore the previously running Controller identity");
}

function runControllerCommand(
  home: string,
  environment: NodeJS.ProcessEnv,
  spawn: UpdateSpawner,
  method: "status" | "live-identity",
  cliBinary?: string
): Record<string, unknown> {
  const command = cliBinary ?? process.execPath;
  const args = cliBinary === undefined
    ? [UPDATE_CLI_PATH, "--json", "controller", method]
    : ["--json", "controller", method];
  const result = spawn(
    command,
    args,
    {
      cwd: process.cwd(),
      env: {
        ...environment,
        YUI_HOME: home,
        // This exact lifecycle child is part of the update process that owns
        // the handover lock. Managed Sessions never receive this bypass.
        YUI_UPDATE_HANDOVER_OWNER_PID: String(process.pid)
      },
      shell: false
    }
  );
  if (result.error !== undefined || result.status !== 0) {
    const error = new Error(`Controller ${method} failed (exit ${result.status ?? "null"}).`);
    const code = controllerErrorCodeFromResult(result);
    if (code !== undefined) Object.assign(error, { code });
    throw error;
  }
  const parsed = JSON.parse(result.stdout.toString("utf8")) as unknown;
  if (!isRecord(parsed) || parsed.ok !== true || !isRecord(parsed.data)) {
    throw new Error(`Controller ${method} returned an invalid structured result.`);
  }
  return parsed.data;
}

function reconcileControllerResourcesForUpdate(
  home: string,
  environment: NodeJS.ProcessEnv,
  spawn: UpdateSpawner
): void {
  const helper = [
    "const values = process.argv.slice(1);",
    "const home = values.pop();",
    "const reconciliationModule = values.pop();",
    "(async () => {",
    "  const { reconcileControllerResourcesForUpdate } = await import(reconciliationModule);",
    "  const data = await reconcileControllerResourcesForUpdate(home, process.env);",
    "  process.stdout.write(JSON.stringify({ ok: true, data }));",
    "})().catch((error) => {",
    "  const message = error instanceof Error ? error.message : String(error);",
    "  process.stderr.write(JSON.stringify({ ok: false, code: 'RUNTIME_ERROR', message }));",
    "  process.exitCode = 5;",
    "});"
  ].join(" ");
  const result = spawn(
    process.execPath,
    ["-e", helper, UPDATE_CONTROLLER_RECONCILIATION_PATH, home],
    { cwd: process.cwd(), env: { ...environment, YUI_HOME: home }, shell: false }
  );
  if (result.error !== undefined || result.status !== 0) {
    const detail = structuredErrorMessage(result) ?? result.stderr.toString("utf8").trim();
    throw new Error(
      `Controller reconciliation failed (exit ${result.status ?? "null"})${
        detail.length === 0 ? "." : `: ${detail}`
      }`
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(result.stdout.toString("utf8"));
  } catch (error) {
    throw new Error("Controller reconciliation returned an invalid structured result.", {
      cause: error
    });
  }
  if (
    !isRecord(parsed)
    || parsed.ok !== true
    || !isRecord(parsed.data)
    || !Array.isArray(parsed.data.cleaned)
    || parsed.data.cleaned.some((id) => typeof id !== "string")
  ) {
    throw new Error("Controller reconciliation returned an invalid structured result.");
  }
}

function structuredErrorMessage(result: SpawnSyncReturns<Buffer>): string | undefined {
  for (const buffer of [result.stderr, result.stdout]) {
    try {
      const value: unknown = JSON.parse(buffer.toString("utf8"));
      if (isRecord(value) && typeof value.message === "string" && value.message.length > 0) {
        return value.message;
      }
    } catch {
      // Fall back to the child's raw stderr below.
    }
  }
  return undefined;
}

function parseControllerIdentity(value: Record<string, unknown>): ControllerIdentity {
  if (
    typeof value.executablePath !== "string"
    || value.executablePath.length === 0
    || !Array.isArray(value.args)
    || value.args.some((arg) => typeof arg !== "string")
    || typeof value.version !== "string"
    || value.version.length === 0
  ) {
    throw new Error(
      "Authenticated Controller identity is malformed; treating ownership as unknown-active."
    );
  }
  return {
    executablePath: value.executablePath,
    args: value.args as string[],
    version: value.version
  };
}

function controllerErrorCodeFromResult(result: SpawnSyncReturns<Buffer>): string | undefined {
  for (const buffer of [result.stdout, result.stderr]) {
    try {
      const parsed = JSON.parse(buffer.toString("utf8")) as unknown;
      if (isRecord(parsed) && typeof parsed.code === "string") return parsed.code;
    } catch {
      // The generic command failure below remains the structured blocker.
    }
  }
  return undefined;
}

function controllerErrorCode(error: unknown): string | undefined {
  return isRecord(error) && typeof error.code === "string" ? error.code : undefined;
}

function isPositivePid(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function runControllerCommandOutput(
  home: string,
  environment: NodeJS.ProcessEnv,
  spawn: UpdateSpawner,
  method: "stop" | "restart",
  cliBinary?: string
): { output?: string; data?: Record<string, unknown> } {
  const command = cliBinary ?? process.execPath;
  const args = cliBinary === undefined
    ? [UPDATE_CLI_PATH, "--json", "controller", method]
    : ["--json", "controller", method];
  const result = spawn(
    command,
    args,
    {
      cwd: process.cwd(),
      env: {
        ...environment,
        YUI_HOME: home,
        // The restart child participates in the handover owned by this parent
        // update process. Without the owner PID it waits on its parent's live
        // lock as though a foreign update owned the Home, then times out.
        YUI_UPDATE_HANDOVER_OWNER_PID: String(process.pid)
      },
      shell: false
    }
  );
  if (result.error !== undefined || result.status !== 0) {
    const detail = structuredErrorMessage(result) ?? result.stderr.toString("utf8").trim();
    const error = new Error(
      `Controller ${method} failed (exit ${result.status ?? "null"})${
        detail.length === 0 ? "." : `: ${detail}`
      }`
    );
    const code = controllerErrorCodeFromResult(result);
    if (code !== undefined) Object.assign(error, { code });
    throw error;
  }
  const parsed = JSON.parse(result.stdout.toString("utf8")) as unknown;
  if (!isRecord(parsed) || parsed.ok !== true) {
    throw new Error(`Controller ${method} returned an invalid structured result.`);
  }
  if (parsed.output !== undefined && typeof parsed.output !== "string") {
    throw new Error(`Controller ${method} returned an invalid output field.`);
  }
  if (parsed.data !== undefined && !isRecord(parsed.data)) {
    throw new Error(`Controller ${method} returned malformed structured data.`);
  }
  if (method === "restart") {
    if (parsed.output === undefined && parsed.data === undefined) {
      throw new Error(`Controller ${method} returned no output or structured data.`);
    }
    if (parsed.data !== undefined) {
      validateRestartEnvelopeData(parsed.data);
    }
  } else if (parsed.output === undefined) {
    throw new Error(`Controller ${method} returned no output.`);
  }
  return {
    ...(parsed.output === undefined ? {} : { output: parsed.output }),
    ...(parsed.data === undefined ? {} : { data: parsed.data })
  };
}

function validateRestartEnvelopeData(data: Record<string, unknown>): void {
  if (
    data.restarted !== true
    || !isPositivePid(data.pid)
    || (data.previousPid !== undefined && !isPositivePid(data.previousPid))
  ) {
    throw new Error("Controller restart returned malformed structured data.");
  }
}

/**
 * Authenticate a replacement Controller against the activated artifact. The
 * package version identifies the artifact, while the exact controller entrypoint
 * identifies which global installation supplied the running process.
 */
function assertActivatedControllerIdentity(
  identity: ControllerIdentity,
  activatedBinary: string,
  activatedVersion: string
): void {
  if (identity.version !== activatedVersion) {
    throw new Error(
      `Replacement Controller version ${identity.version} does not match the activated `
        + `binary version ${activatedVersion}; refusing readiness.`
    );
  }
  const expectedEntrypoint = activatedControllerEntrypoint(activatedBinary);
  if (identity.executablePath !== process.execPath
    || identity.args.length !== 1
    || identity.args[0] !== expectedEntrypoint) {
    throw new Error(
      "Replacement Controller launch identity does not match the activated global binary "
        + "runtime/entrypoint; refusing readiness."
    );
  }
}

/**
 * Resolve the Controller entrypoint beside the activated package's CLI.
 * Exported so the release workflow's recovery query can apply the exact same
 * entrypoint derivation as the production startup identity check (P1-1, rr23).
 */
export function activatedControllerEntrypoint(activatedBinary: string): string {
  let resolvedBinary: string;
  try {
    resolvedBinary = realpathSync(activatedBinary);
  } catch {
    // `verify` already checked existsSync. Keep the fallback deterministic for
    // test seams and fail closed later if the identity does not match it.
    resolvedBinary = resolve(activatedBinary);
  }
  const direct = join(dirname(resolvedBinary), "controller", "controllerMain.js");
  if (existsSync(direct)) return direct;

  // npm may expose a non-symlink launcher under <prefix>/bin. Resolve the
  // package's canonical global layout when it is present.
  const prefix = resolve(dirname(resolvedBinary), "..");
  const packageEntrypoint = join(
    prefix,
    "lib",
    "node_modules",
    PACKAGE_NAME,
    "dist",
    "controller",
    "controllerMain.js"
  );
  return existsSync(packageEntrypoint) ? packageEntrypoint : direct;
}

function interpretPreflight(result: SpawnSyncReturns<Buffer>): UpdatePreflight {
  // Require a valid `{ ok:true, data }` success envelope before trusting any
  // outcome (R3-F3). An error envelope, unparseable output, kill, or transport
  // error is not a safe preflight — block rather than proceed to a switch.
  const data = parseSuccessEnvelopeData(result);
  if (data === null) {
    return {
      status: "blocked",
      stage: "preflight",
      message:
        "The staged binary's preflight did not return a valid success envelope "
        + `(exit ${result.status ?? "null"}${result.signal === null ? "" : `, signal ${result.signal}`}); `
        + "refusing to proceed on an unverifiable preflight.",
      action: "Investigate the staged binary; do not force an update on an unverifiable preflight."
    };
  }
  const outcome = typeof data.outcome === "string" ? data.outcome : undefined;
  // EXIT/OUTCOME CONSISTENCY (P1-2): the one success-class internal preflight
  // outcome must exit 0. A user dry-run, legacy direct classification outcome,
  // or any other spelling is not this contract and is never promoted to green.
  if (outcome === "update-preflight" && result.status !== 0) {
    return {
      status: "blocked",
      stage: "preflight",
      message:
        `The staged binary reported outcome=${outcome} but exited with status `
        + `${result.status ?? "null"}; a safe preflight must exit 0. Refusing to proceed.`,
      action: "Investigate the staged binary; do not force an update on an inconsistent preflight."
    };
  }
  if (outcome === "update-preflight") {
    const parsed = parseUpdatePreflightResult(data);
    if (parsed !== null) return parsed;
    return {
      status: "blocked",
      stage: "preflight",
      message: "The staged binary returned a malformed update-preflight result; refusing to infer a storage path.",
      action: "Investigate the staged binary; do not force an update on a malformed preflight."
    };
  }
  if (outcome !== "blocked") {
    return {
      status: "blocked",
      stage: "preflight",
      message:
        `The staged binary returned unexpected outcome=${outcome ?? "missing"}; the internal `
        + "update-preflight contract was not satisfied.",
      action: "Use a staged binary that supports the update-preflight contract; do not force the update."
    };
  }
  const blockers = parseUpdateBlockers(data.blockers);
  return {
    status: "blocked",
    stage: typeof data.stage === "string" ? data.stage : "preflight",
    message: typeof data.message === "string" ? data.message : "Preflight was not safe.",
    action: typeof data.action === "string"
      ? data.action
      : "Resolve the reported condition and retry.",
    ...(blockers === undefined ? {} : { blockers }),
    ...(typeof data.retryCommand === "string" ? { retryCommand: data.retryCommand } : {}),
    ...(data.sceneUnchanged === true ? { sceneUnchanged: true } : {})
  };
}

/** Strictly parse the green states of the internal update preflight. */
function parseUpdatePreflightResult(data: Record<string, unknown>): UpdatePreflight | null {
  const status = data.status;
  const stepCount = data.stepCount;
  if (
    (status !== "already-current"
      && status !== "compatible"
      && status !== "in-place-migration"
      && status !== "migration-required")
    || !Number.isSafeInteger(stepCount)
    || (stepCount as number) < 0
  ) {
    return null;
  }
  const homeClassification = data.classification;
  if (!isRecord(homeClassification) || !isRecord(homeClassification.classification)) return null;
  const classification = homeClassification.classification;
  const expected = status === "already-current"
    ? { verdict: "USABLE", classificationStatus: "current" }
    : status === "compatible"
      ? { verdict: "COMPATIBLE", classificationStatus: "compatible-old" }
      : { verdict: "MIGRATABLE", classificationStatus: "migration-required" };
  if (
    classification.verdict !== expected.verdict
    || classification.status !== expected.classificationStatus
    || (status === "already-current"
      ? stepCount !== 0
      : classification.stepCount !== stepCount || (stepCount as number) < 1)
  ) {
    return null;
  }
  if (status === "already-current") return { status };
  const evidence = status === "compatible"
    ? `${stepCount as number} compatible step(s) classified and the compatible source validated in memory`
    : status === "in-place-migration"
      ? `${stepCount as number} SQLite migration step(s) classified for one in-place transaction and the offline runtime inventory confirmed clear`
      : `${stepCount as number} offline migration step(s) classified and the offline runtime inventory confirmed clear`;
  const summary =
    `${evidence}. `
    + "No staged Home or staged-output loader validation was performed during update preflight.";
  if (status === "in-place-migration") {
    const sqliteMigration = parseSqliteMigrationBoundary(data.sqliteMigration, stepCount as number);
    if (sqliteMigration === null) return null;
    return {
      status,
      summary,
      sqliteMigration
    };
  }
  return {
    status,
    summary
  };
}

function parseSqliteMigrationBoundary(
  value: unknown,
  stepCount: number
): UpdateSqliteMigrationBoundary | null {
  if (!isRecord(value)) return null;
  const currentVersion = value.currentVersion;
  const currentChecksum = value.currentChecksum;
  const targetVersion = value.targetVersion;
  const targetChecksum = value.targetChecksum;
  const pendingVersions = value.pendingVersions;
  if (
    !Number.isSafeInteger(currentVersion)
    || (currentVersion as number) < 1
    || typeof currentChecksum !== "string"
    || currentChecksum.length === 0
    || !Number.isSafeInteger(targetVersion)
    || (targetVersion as number) <= (currentVersion as number)
    || typeof targetChecksum !== "string"
    || targetChecksum.length === 0
    || !Array.isArray(pendingVersions)
    || pendingVersions.length !== stepCount
    || targetVersion !== (currentVersion as number) + stepCount
    || pendingVersions.some((version, index) =>
      !Number.isSafeInteger(version) || version !== (currentVersion as number) + index + 1)
  ) {
    return null;
  }
  return {
    current: {
      version: currentVersion as number,
      checksum: currentChecksum
    },
    target: {
      version: targetVersion as number,
      checksum: targetChecksum
    }
  };
}

function parseUpdateBlockers(value: unknown): readonly UpdateBlockerIdentity[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) return undefined;
  const parsed: UpdateBlockerIdentity[] = [];
  for (const item of value) {
    if (!isRecord(item) || typeof item.reason !== "string" || item.reason.length === 0) {
      return undefined;
    }
    const optional = ["taskId", "roleName", "runId", "nativeSessionId", "launchId"] as const;
    if (optional.some((key) => item[key] !== undefined && typeof item[key] !== "string")) {
      return undefined;
    }
    parsed.push({
      ...(typeof item.taskId === "string" ? { taskId: item.taskId } : {}),
      ...(typeof item.roleName === "string" ? { roleName: item.roleName } : {}),
      ...(typeof item.runId === "string" ? { runId: item.runId } : {}),
      ...(typeof item.nativeSessionId === "string"
        ? { nativeSessionId: item.nativeSessionId }
        : {}),
      ...(typeof item.launchId === "string" ? { launchId: item.launchId } : {}),
      reason: item.reason
    });
  }
  return parsed;
}

function interpretActivation(result: SpawnSyncReturns<Buffer>): StorageActivation {
  // A spawn transport error (could not even run) is a clean pre-switch failure.
  if (result.error !== undefined) {
    return {
      status: "ambiguous",
      detail: `the activation process could not be run: ${result.error.message}`
    };
  }
  // Require a valid `{ ok:true, data }` success envelope (R3-F3). Killed by a
  // signal, no parseable JSON, or an `ok:false`/malformed envelope: the child may
  // have died after the atomic switch but before printing a valid result. This is
  // AMBIGUOUS, never a false "recoverable/unchanged" (P1-2).
  const data = parseSuccessEnvelopeData(result);
  if (data === null) {
    const how = result.signal !== null
      ? `terminated by ${result.signal}`
      : result.status === null
        ? "terminated without an exit code"
        : `exited with status ${result.status} and no valid success envelope`;
    return {
      status: "ambiguous",
      detail: `the activation process ${how}`
    };
  }
  const outcome = typeof data.outcome === "string" ? data.outcome : undefined;
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
    if (data.migrationMode === "in-place" && data.backupPath === undefined) {
      return { status: "migrated-in-place" };
    }
    const backupPath = data.backupPath;
    if (
      typeof backupPath !== "string"
      || backupPath.length === 0
      || backupPath.trim() !== backupPath
      || backupPath.includes("\0")
      || !isAbsolute(backupPath)
    ) {
      return {
        status: "ambiguous",
        detail:
          "the activation process reported outcome=upgraded without a non-empty absolute backupPath"
      };
    }
    return {
      status: "migrated",
      backupPath
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
    // A post-verify blocker is emitted only after the atomic Home switch has
    // committed. Treat it as AMBIGUOUS in the parent update flow so a stopped
    // old Controller is never restored against the migrated Home; the receipt,
    // backup, and switch-progress marker are the recovery evidence.
    if (stage === "post-verify") {
      return {
        status: "ambiguous",
        detail: typeof data?.message === "string"
          ? data.message
          : "storage switched but post-switch verification did not complete"
      };
    }
    const blockers = parseUpdateBlockers(data.blockers);
    return {
      status: "blocked",
      stage,
      message: typeof data?.message === "string" ? data.message : "Storage activation was refused.",
      action: typeof data?.action === "string"
        ? data.action
        : "Resolve the reported condition and retry.",
      ...(blockers === undefined ? {} : { blockers }),
      ...(typeof data.retryCommand === "string" ? { retryCommand: data.retryCommand } : {}),
      ...(data.sceneUnchanged === true ? { sceneUnchanged: true } : {})
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
 * Extract the validated `data` object from a spawn result's `{ ok: true, data }`
 * JSON envelope, or `null` when the result is not a trustworthy success envelope.
 *
 * Returns `null` when the process errored, was killed, produced no parseable
 * JSON, the envelope's `ok` is not exactly `true`, or `data` is not an object
 * (R3-F3). It does NOT reject a non-zero exit on its own — the deliberate
 * non-zero exit for a `blocked`/unhealthy outcome still carries a valid success
 * envelope, and callers apply their own exit/outcome consistency rules. Every
 * caller must treat `null` as unresolved (fail-closed / ambiguous / blocked).
 */
function parseSuccessEnvelopeData(
  result: SpawnSyncReturns<Buffer>
): Record<string, unknown> | null {
  if (result.error !== undefined) return null;
  if (result.signal !== null || result.status === null) return null;
  let parsed: unknown;
  try {
    const text = result.stdout.toString("utf8").trim();
    if (text.length === 0) return null;
    parsed = JSON.parse(text) as unknown;
  } catch {
    return null;
  }
  // The top-level value must be a real object — never `null`, an array, or a
  // primitive. `JSON.parse("null")`/`"[]"`/`"5"` all parse successfully but are
  // not valid envelopes, and reading `.ok` off `null` would throw (R4-F1); guard
  // the shape first so a malformed child result becomes a clean `null` (which the
  // caller maps to blocked/ambiguous) rather than an uncaught TypeError.
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return null;
  }
  const envelope = parsed as Record<string, unknown>;
  // Require a success envelope: ok === true and a real data object. A `{ ok:false }`
  // error envelope, or one with a non-object `data`, is never a success (R3-F3).
  if (envelope.ok !== true) return null;
  if (typeof envelope.data !== "object" || envelope.data === null || Array.isArray(envelope.data)) {
    return null;
  }
  return envelope.data as Record<string, unknown>;
}

/**
 * Resolve the exact, CONCRETE version of the staged install, or `null` when no
 * concrete version can be determined. A dist-tag sentinel like `latest` (or any
 * non-semver-shaped value) is NOT a concrete version and yields `null` (R3-F1):
 * callers MUST fail closed rather than pin `@latest`, which would let activation
 * promote a different build than the one preflighted.
 */
function resolveStagedVersion(
  stagingPath: string,
  binaryPath: string,
  environment: NodeJS.ProcessEnv,
  spawn: UpdateSpawner
): string | null {
  // Prefer the staged package.json (deterministic, no extra process).
  const manifest = join(stagingPath, "lib", "node_modules", PACKAGE_NAME, "package.json");
  const fromManifest = readVersionFromPackageJson(manifest);
  if (fromManifest !== null) return fromManifest;
  // Fall back to asking the staged binary itself; `null` if it too cannot answer
  // with a successful, concrete version.
  return resolveBinaryVersion(binaryPath, environment, spawn);
}

/** Read a CONCRETE `version` from a package.json, or `null` when absent/non-concrete. */
function readVersionFromPackageJson(path: string): string | null {
  try {
    const value = JSON.parse(readFileSync(path, "utf8")) as { version?: unknown };
    if (typeof value.version !== "string") return null;
    const version = value.version.trim();
    return isConcreteVersion(version) ? version : null;
  } catch {
    return null;
  }
}

/**
 * Ask a `yui` binary for its version via `--json version`; returns the CONCRETE
 * version only from a valid `{ ok:true, data }` success envelope at exit 0
 * (R3-F1/R3-F3), else `null`. A non-zero exit, `ok:false`, missing/non-concrete
 * `version`, or unparseable output all yield `null` so the caller fails closed.
 */
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
  // A version probe is only trustworthy from a successful, zero-exit envelope.
  if (result.status !== 0) return null;
  const data = parseSuccessEnvelopeData(result);
  if (data === null || typeof data.version !== "string") return null;
  const version = data.version.trim();
  return isConcreteVersion(version) ? version : null;
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

/**
 * Fail closed unless the doctor result PROVES the migrated Home's storage is
 * healthy (P1-3 / R2-F2). The envelope and storage checks are validated BEFORE
 * the exit status is interpreted, because `yui --json doctor` deliberately exits
 * non-zero on unhealthy storage — so keying off the exit first would reduce a
 * precise structured verdict to a generic "exited with status N".
 *
 * Healthy requires ALL of:
 *  - a valid `{ ok: true, data: { storage, checks } }` success envelope,
 *  - `storage.healthy === true` with an empty `storage.blocking`,
 *  - every expected storage check present AND `ok`, and
 *  - exit status 0.
 * A parseable-but-unhealthy result (typically exit 5) throws a precise, recovery-
 * oriented blocker. An unparseable, non-success, or self-contradictory envelope
 * (e.g. `healthy: true` yet a non-`ok`/blocking check, or `ok: false`) fails
 * closed — an unverifiable health check must never pass silently.
 */
function assertDoctorStorageHealthy(result: SpawnSyncReturns<Buffer>): void {
  // 1) Envelope must be a parseable `{ ok:true, data:<object> }` success envelope.
  // A spawn transport error, kill, missing exit code, empty/garbage stdout, a
  // top-level `null`/array/primitive, or `ok !== true` is unverifiable -> fail
  // closed. Shared with the update ports' parser so `null`/primitive envelopes
  // can never crash the check (R4-F1).
  if (result.error !== undefined || result.signal !== null || result.status === null) {
    throw doctorUnverifiable(
      result.signal !== null
        ? `the doctor process was terminated by ${result.signal}`
        : result.error !== undefined
          ? `the doctor process could not be run: ${result.error.message}`
          : "the doctor process terminated without an exit code"
    );
  }
  const data = parseSuccessEnvelopeData(result);
  if (data === null) {
    throw doctorUnverifiable("the activated binary's `doctor` did not return a parseable success envelope");
  }
  const storage = data.storage as { healthy?: unknown; blocking?: unknown } | undefined;
  const checks = Array.isArray(data.checks) ? (data.checks as Record<string, unknown>[]) : null;
  if (storage === undefined || typeof storage.healthy !== "boolean" || checks === null) {
    throw doctorUnverifiable(
      "the activated binary's `doctor` did not return a parseable storage-health result"
    );
  }

  // 2) Require EVERY expected storage check to be present exactly once AND ok
  // (R3-F2). A `healthy: true` flag with an empty `blocking` array must NOT be
  // trusted when an expected check is missing, duplicated, or malformed — the
  // authoritative signal is the checks array itself, not the summary flag.
  const expectedNames = STORAGE_DOCTOR_CHECK_NAMES;
  const byName = new Map<string, Record<string, unknown>[]>();
  for (const c of checks) {
    if (typeof c.name === "string") {
      const list = byName.get(c.name) ?? [];
      list.push(c);
      byName.set(c.name, list);
    }
  }
  const missingOrMalformed: string[] = [];
  for (const name of expectedNames) {
    const entries = byName.get(name) ?? [];
    if (entries.length !== 1) {
      missingOrMalformed.push(`${name}=${entries.length === 0 ? "missing" : `duplicated x${entries.length}`}`);
      continue;
    }
    if (typeof entries[0].status !== "string") {
      missingOrMalformed.push(`${name}=malformed`);
    }
  }
  if (missingOrMalformed.length > 0) {
    throw doctorUnverifiable(
      `the doctor result is missing or has malformed storage checks (${missingOrMalformed.join("; ")}); `
        + "refusing to trust the health flag without every expected check present"
    );
  }

  // The blocking (non-ok) storage checks, from the now-complete authoritative set.
  const storageChecks = expectedNames.map((name) => (byName.get(name) as Record<string, unknown>[])[0]);
  const blockingChecks = storageChecks.filter((c) => c.status !== "ok");

  // `storage.blocking` MUST be a well-formed array of check-shaped objects (R4-F2).
  // A missing field, a non-array value (e.g. a string), or a malformed element is
  // an incomplete/unknown doctor result — fail closed rather than silently coerce
  // it to an empty array (which would let an unverifiable result read as healthy).
  if (!Array.isArray(storage.blocking)) {
    throw doctorUnverifiable(
      "the doctor result's storage.blocking is missing or not an array; the storage-health "
        + "result is incomplete and cannot be trusted"
    );
  }
  const declaredBlocking = storage.blocking as unknown[];
  const malformedDeclared = declaredBlocking.filter((entry) => {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) return true;
    const record = entry as Record<string, unknown>;
    return typeof record.name !== "string" || typeof record.status !== "string";
  });
  if (malformedDeclared.length > 0) {
    throw doctorUnverifiable(
      `the doctor result's storage.blocking has ${malformedDeclared.length} malformed entr(ies) `
        + "(each must be an object with string name/status); refusing to trust an unverifiable result"
    );
  }
  const declaredBlockingChecks = declaredBlocking as Record<string, unknown>[];

  // 3) Contradiction guard: `healthy: true` must agree with the checks. If it
  // claims healthy yet a storage check is non-ok (or it declares blocking checks),
  // the result is self-contradictory -> fail closed rather than trust the flag.
  if (storage.healthy === true && (blockingChecks.length > 0 || declaredBlockingChecks.length > 0)) {
    throw doctorUnverifiable(
      "the doctor result is self-contradictory (reports healthy storage yet lists a non-ok "
        + "storage check); refusing to trust it"
    );
  }

  // 4) Unhealthy (typically a deliberate non-zero exit): a precise blocker.
  if (storage.healthy !== true || blockingChecks.length > 0 || declaredBlockingChecks.length > 0) {
    const detail = [...blockingChecks, ...declaredBlockingChecks]
      .map((c) => `${String(c.name)}=${String(c.status)} (${String(c.detail)})`)
      .join("; ");
    throw runtimeError(
      "Post-update health check failed: the migrated Home is not healthy per the activated "
        + `binary's doctor: ${detail || "(no detail)"}. The storage did not come up cleanly on `
        + "the new version. Restore the timestamped backup to recover the original Home before "
        + "resuming writes."
    );
  }

  // 5) Healthy checks AND a healthy flag — but a non-zero exit still contradicts a
  // clean bill of health, so require exit 0 as the final gate (R2-F2).
  if (result.status !== 0) {
    throw doctorUnverifiable(
      `the doctor result reports healthy storage but the process exited with status ${result.status}; `
        + "a clean health check must exit 0"
    );
  }
}

/** A fail-closed post-update health-check error for an unverifiable doctor result. */
function doctorUnverifiable(reason: string): Error {
  return runtimeError(
    `Post-update health check failed: ${reason}, so the migrated Home cannot be confirmed `
      + "healthy. Investigate with `yui doctor` before resuming; if storage was migrated, restore "
      + "the timestamped backup to recover."
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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
