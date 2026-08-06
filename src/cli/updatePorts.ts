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
import { STORAGE_DOCTOR_CHECK_NAMES } from "../doctor/doctor.js";
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
      // package.json, else the staged binary itself). If neither yields a concrete
      // version, FAIL the stage (R2-F1): we must never fall back to a bare
      // `@latest`, which would let activation promote — and verify wave through —
      // a different build than the one that passed preflight.
      const version = resolveStagedVersion(stagingPath, binaryPath, environment, spawn);
      if (version === null) {
        // Clean up the staging dir; the live install is untouched, so this is a
        // fully recoverable pre-activation failure.
        rmSync(stagingPath, { recursive: true, force: true });
        throw runtimeError(
          "Failed to resolve the exact staged package version (neither the staged package.json "
            + "nor `yui --json version` returned a concrete version). Refusing to proceed with a "
            + "`@latest` fallback that could promote a different build than the one preflighted."
        );
      }
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
      // Promote the SAME resolved artifact, pinned by exact version — never a bare
      // `@latest` (R2-F1: `stage` guarantees `staged.version` is a concrete
      // version, so there is no `latest` sentinel to fall back to).
      const spec = `${PACKAGE_NAME}@${staged.version}`;
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
      // POST-VERIFY PARSES THE MACHINE-READABLE RESULT FIRST, THEN THE EXIT STATUS
      // (R2-F2). `yui --json doctor` deliberately sets a non-zero exit when storage
      // is unhealthy, so interpreting the exit status before the envelope would
      // reduce a precise "storage unsupported/corrupted" verdict to a generic
      // "exited with status 5". We therefore parse+validate the structured storage
      // health first: only a valid success envelope with every expected storage
      // check present-and-ok, no blocking checks, AND exit 0 is healthy.
      const doctor = spawn(
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
            ...(progress.backupPath === undefined ? {} : { backupPath: progress.backupPath })
          };
        }
        // Otherwise the marker is stale relative to the current filesystem (Home
        // intact, or no backup to restore). Do not emit a restore path from it —
        // fall through and reconcile against the receipt/schema below.
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
    stage: typeof data.stage === "string" ? data.stage : "preflight",
    message: typeof data.message === "string" ? data.message : "Preflight was not safe.",
    action: typeof data.action === "string"
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

/**
 * True for a concrete, pinnable package version — a semver-shaped `X.Y.Z` with an
 * optional pre-release/build suffix. Rejects dist-tag sentinels (`latest`, `next`,
 * …), empty/whitespace, and anything not anchored to a numeric `major.minor.patch`
 * so a sentinel can never be spliced into an activation spec (R3-F1).
 */
function isConcreteVersion(value: string): boolean {
  return /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(value.trim());
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

function describe(data: Record<string, unknown> | undefined): string {
  const report = data?.report as Record<string, unknown> | undefined;
  const steps = Array.isArray(report?.steps) ? report?.steps.length : 0;
  return `${steps} migration step(s) validated`;
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
