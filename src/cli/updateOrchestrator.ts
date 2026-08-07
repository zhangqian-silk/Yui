/**
 * The `yui update` orchestration.
 *
 * The previous implementation ran `npm install --global` *first*, which is
 * self-contradictory with "on failure the old CLI and Home are both unchanged":
 * once the global package is replaced there is nothing to fall back to. This
 * orchestrator replaces that with a side-by-side staging flow:
 *
 *   stage (side-by-side, never touches the live install)
 *     -> preflight  (the STAGED new binary inspects the target Home read-only)
 *     -> [only if safe] activate storage  (recoverable: backup + no auto-downgrade
 *                                           once the new version resumes writes)
 *     -> activate binary  (promote the staged package to the live install)
 *     -> post-verify  (the new binary's real loader + reference-graph health check)
 *
 * ## Rollback boundary (NARROWED — no versioned binary pointer is introduced)
 *
 * This release deliberately does NOT introduce a stable launcher or a versioned
 * binary pointer, so it does NOT claim binary+Home dual-resource atomicity. The
 * guarantees it DOES make, precisely:
 *
 *  - **Staging is isolated.** `stage` installs side-by-side and never mutates the
 *    live global install, so a stage/preflight failure leaves the old binary and
 *    the Home byte-for-byte unchanged.
 *  - **Storage activation is recoverable until writes resume.** The Home switch is
 *    atomic with a timestamped backup (see the migration engine). Before the new
 *    version resumes writes, recovery is a single restore of that backup.
 *  - **No auto-downgrade after writes.** Once the new version has resumed writes
 *    (a new Controller/first write against the migrated Home), the tool never
 *    auto-reverts; the migrated Home is authoritative.
 *
 * The one window it CANNOT make atomic is: storage already switched to the new
 * schema, but binary promotion then fails. Because the axes are version-gated,
 * the old binary fail-closes on the new Home rather than misreading it; recovery
 * is to restore the timestamped Home backup (the exact command is printed), after
 * which the old binary works again. This is stated in the failure output, not
 * hidden behind a false atomicity claim.
 */

import { isAbsolute } from "node:path";

import { switchProgressPath } from "../storage/upgrade/switchProgress.js";
import { upgradeReceiptPath } from "../storage/upgrade/upgradeReceipt.js";

/** A side-by-side staged package, isolated from the live global install. */
export type StagedPackage = Readonly<{
  /** Absolute path to the staged `yui` binary. */
  binaryPath: string;
  /** The staged package version (for reporting). */
  version: string;
  /** The staging root to remove on cleanup. */
  stagingPath?: string;
}>;

/** Read-only preflight verdict produced by the staged binary against the Home. */
export type UpdatePreflight = Readonly<
  | { status: "already-current" }
  | { status: "migratable"; summary: string }
  | { status: "blocked"; stage: string; message: string; action: string }
>;

/** The result of promoting the staged storage into place (recoverable step). */
export type StorageActivation = Readonly<
  | { status: "already-current" }
  | { status: "migrated"; backupPath?: string }
  | { status: "blocked"; stage: string; message: string; action: string }
  /**
   * The activation child did not return a parseable success/failure receipt
   * (e.g. killed by SIGTERM/OOM after the atomic switch, or crashed before
   * printing its JSON). The storage state is UNKNOWN: the switch may or may not
   * have committed. Never treat this as recoverable-and-unchanged (P1-2); the
   * orchestrator resolves the true state from the on-disk receipt + backup +
   * schema and reports an explicit manual recovery.
   */
  | { status: "ambiguous"; detail: string }
>;

/** The exact Controller launch identity captured before an update stops it. */
export type ControllerIdentity = Readonly<{
  /** Executable that owns the Controller process (for example `node`). */
  executablePath: string;
  /** Exact launch arguments for that executable, including the Controller entrypoint. */
  args: readonly string[];
  /** Version reported by the running Controller before the update. */
  version: string;
}>;

/** Lifecycle fact captured before a binary-only update quiesces the Home. */
export type UpdateControllerLifecycleStatus = Readonly<{
  running: boolean;
  pid?: number;
  /** Required when `running` is true so restoration cannot silently use the new binary. */
  identity?: ControllerIdentity;
}>;

/** Structured stop result; a running Controller is stopped at most once. */
export type UpdateControllerStopResult = Readonly<{
  stopped: boolean;
  alreadyStopped?: boolean;
  pid?: number;
}>;

/**
 * A read-only probe of the target Home's storage state, used to resolve an
 * ambiguous activation. `switched` is a durable receipt the activation writes
 * the instant its atomic switch commits; `backupPath` locates the pre-switch
 * Home; `schemaCurrent` says whether the Home now loads at the current version.
 */
export type StorageStateProbe = Readonly<{
  /** A completion receipt was found (the switch provably committed). */
  switched: boolean;
  /**
   * A partially-applied, interrupted switch was found (P1-4): the original was
   * moved to the backup but neither promotion nor rollback completed, so the Home
   * path may be missing. This is the strongest "restore the backup" signal.
   */
  interrupted?: boolean;
  /** The timestamped backup of the pre-switch Home, when known. */
  backupPath?: string;
  /** Whether the on-disk Home is now at the current, loadable schema. */
  schemaCurrent: boolean;
}>;

/**
 * Injected side effects. The real implementations spawn npm and the staged
 * binary; tests inject fakes so the ordering and recovery guarantees are
 * verifiable without a destructive global install.
 */
export type UpdatePorts = Readonly<{
  /** Install the latest package side-by-side; never touch the live install. */
  stage: () => StagedPackage;
  /** Run the staged binary's read-only preflight against the target Home. */
  preflight: (staged: StagedPackage, home: string) => UpdatePreflight;
  /** Promote the staged storage into place (atomic switch + backup). */
  activateStorage: (staged: StagedPackage, home: string) => StorageActivation;
  /** Promote the SAME staged artifact to the live global install (P1-3). */
  activateBinary: (staged: StagedPackage) => void;
  /**
   * New-binary health check over the migrated Home; throws on failure. Runs the
   * ACTUALLY-ACTIVATED global binary (not the staging path) and confirms its
   * version/identity matches the staged artifact (P1-3).
   */
  verify: (staged: StagedPackage, home: string) => void;
  /**
   * Read-only probe of the Home's storage state, to resolve an ambiguous
   * activation from the durable receipt + backup + current schema (P1-2).
   */
  probeStorage: (home: string) => StorageStateProbe;
  /** Best-effort staging cleanup. */
  cleanup: (staged: StagedPackage) => void;
  /**
   * Optional Controller lifecycle owner for the parent update orchestration.
   * When any lifecycle seam is supplied, all four seams are required so a
   * failed pre-switch update never falls back to a staged/new Controller.
   */
  controllerStatus?: (home: string) => UpdateControllerLifecycleStatus;
  stopController?: (home: string) => UpdateControllerStopResult;
  /** Start the replacement only after binary activation and post-health verification. */
  startController?: (home: string) => void;
  /** Restore the exact identity captured before the update (never the staged binary). */
  restoreController?: (home: string, identity: ControllerIdentity) => void;
}>;

/** The structured outcome of an update attempt. */
export type UpdateResult = Readonly<
  (
    | { outcome: "already-current"; version: string }
    | { outcome: "updated"; version: string; storageBackupPath?: string }
    | {
        outcome: "aborted";
        phase: UpdatePhase;
        message: string;
        action: string;
        /** True while the old binary and Home are provably still intact. */
        recoverable: boolean;
        version?: string;
        storageBackupPath?: string;
      }
    /**
     * The storage activation's outcome could not be determined: the switch may or
     * may not have committed. This is NEITHER a clean recovery NOR a completed
     * update — it demands manual verification. Carries the best available evidence
     * (receipt/backup/schema) and the precise steps to resolve it (P1-2).
     */
    | {
        outcome: "ambiguous";
        phase: UpdatePhase;
        message: string;
        action: string;
        version?: string;
        storageBackupPath?: string;
        /** Whether the on-disk Home is now at the current, loadable schema. */
        schemaCurrent: boolean;
        /** Whether a durable completion receipt was found. */
        switched: boolean;
      }
  ) & {
    /** Best-effort staging cleanup failed after the update result was known. */
    cleanupWarning?: string;
  }
>;

/** The precise phase an update aborted in. */
export type UpdatePhase =
  | "stage"
  | "preflight"
  | "coordination"
  | "activate-storage"
  | "activate-binary"
  | "post-verify";

type UpdateControllerLifecycle = Readonly<{
  wasRunning: boolean;
  stopped: boolean;
  identity?: ControllerIdentity;
}>;

/**
 * Run the update orchestration. Never performs an irreversible step before the
 * read-only preflight has proven the Home is safe, and reports the precise phase
 * plus a recovery action on any failure.
 */
export function runUpdate(
  ports: UpdatePorts,
  options: Readonly<{ home: string }>
): UpdateResult {
  const home = options.home;

  // 1) Stage side-by-side. A failure here leaves the live install untouched.
  let staged: StagedPackage;
  try {
    staged = ports.stage();
  } catch (error) {
    return {
      outcome: "aborted",
      phase: "stage",
      message: `Failed to stage the new package: ${messageOf(error)}`,
      action: "The current install and Home are unchanged. Fix the staging error and retry.",
      recoverable: true
    };
  }

  let result: UpdateResult;
  let cleanupWarning: string | undefined;
  try {
    result = runStagedUpdate(ports, staged, home);
  } finally {
    try {
      ports.cleanup(staged);
    } catch (error) {
      // Cleanup is deliberately best-effort. Once the orchestrator has
      // determined an update/abort/ambiguous result, a staging I/O failure must
      // not replace that authoritative outcome or turn it into a generic error.
      cleanupWarning = `Staging cleanup could not be completed: ${messageOf(error)}`;
    }
  }
  return cleanupWarning === undefined ? result : { ...result, cleanupWarning };
}

/** Run the staged flow; cleanup is owned by the caller so warnings are retained. */
function runStagedUpdate(
  ports: UpdatePorts,
  staged: StagedPackage,
  home: string
): UpdateResult {
  // 2) Preflight — the staged binary inspects the Home read-only; no switch.
  // A preflight port that throws unexpectedly (e.g. an I/O fault) is not a safe
  // green light: treat it as a blocked preflight (recoverable, no switch) rather
  // than letting the exception escape (R4-F1).
  let preflight: UpdatePreflight;
  try {
    preflight = ports.preflight(staged, home);
  } catch (error) {
    return {
      outcome: "aborted",
      phase: "preflight",
      message: `Preflight failed unexpectedly: ${messageOf(error)}`,
      action: "The current install and Home are unchanged. Investigate the staged binary and retry.",
      recoverable: true,
      version: staged.version
    };
  }
  if (preflight.status === "blocked") {
    return {
      outcome: "aborted",
      phase: "preflight",
      message: preflight.message,
      action: preflight.action,
      recoverable: true,
      version: staged.version
    };
  }

  // Capture and stop the old Controller exactly once after preflight but
  // before either storage activation or binary promotion. This parent update
  // process remains the sole lifecycle owner for both binary-only and
  // migratable updates.
  const lifecycle = captureControllerLifecycle(ports, staged.version, home);
  if ("outcome" in lifecycle) return lifecycle;

  if (preflight.status === "already-current") {
    // Nothing to migrate; promote the binary and verify. Storage is untouched.
    return activateAndVerify(ports, staged, home, undefined, lifecycle.lifecycle);
  }

  // 3) Activate storage — recoverable: atomic switch + timestamped backup. An
  // activation port that throws unexpectedly may have committed the switch
  // before failing, so its state is UNKNOWN — resolve it as ambiguous from the
  // durable on-disk evidence, never let the exception escape as a false clean
  // failure (R4-F1 / P1-2).
  let activation: StorageActivation;
  try {
    activation = ports.activateStorage(staged, home);
  } catch (error) {
    return resolveAmbiguousActivation(
      ports,
      staged,
      home,
      `the activation step threw unexpectedly: ${messageOf(error)}`
    );
  }
  if (activation.status === "blocked") {
    const failure: UpdateResult = {
      outcome: "aborted",
      phase: "activate-storage",
      message: activation.message,
      action: activation.action,
      // The engine guarantees the source Home is unchanged on a blocked/failed
      // migration, and the binary has not been promoted, so this is recoverable.
      recoverable: true,
      version: staged.version
    };
    // The child was externally quiesced by this parent. A clean pre-switch
    // refusal therefore restores the exact captured identity; an ambiguous
    // activation is handled separately and never restores blindly.
    return restoreBeforeSwitchOrReport(
      ports,
      home,
      lifecycle.lifecycle,
      undefined,
      failure
    );
  }
  if (activation.status === "ambiguous") {
    // The activation child left no parseable receipt: the switch may or may not
    // have committed. Resolve the true state from the durable on-disk evidence
    // and report an explicit manual recovery — never a false "recoverable".
    return resolveAmbiguousActivation(ports, staged, home, activation.detail);
  }
  if (activation.status === "migrated" && !isValidBackupPath(activation.backupPath)) {
    // A migrated/upgraded success without a concrete backup path violates
    // the recoverable storage-activation contract. Resolve it through the
    // existing durable receipt/schema probe instead of inferring that the
    // Home was untouched.
    return resolveAmbiguousActivation(
      ports,
      staged,
      home,
      "the activation reported migrated without a non-empty absolute backupPath"
    );
  }
  const backupPath = activation.status === "migrated" ? activation.backupPath : undefined;

  // 4/5) Promote the binary, then post-verify with the new binary's loader.
  return activateAndVerify(ports, staged, home, backupPath, lifecycle.lifecycle);
}

/**
 * Promote the staged binary and run the new-binary health check. This is the
 * last, non-atomic step: after storage has switched, binary promotion cannot be
 * made atomic with it, so a failure here is reported with the exact backup-based
 * recovery and is NOT auto-reverted once the new version would resume writes.
 */
function activateAndVerify(
  ports: UpdatePorts,
  staged: StagedPackage,
  home: string,
  storageBackupPath: string | undefined,
  lifecycle?: UpdateControllerLifecycle
): UpdateResult {
  try {
    ports.activateBinary(staged);
  } catch (error) {
    const failure: UpdateResult = {
      outcome: "aborted",
      phase: "activate-binary",
      message: `Failed to activate the new binary: ${messageOf(error)}`,
      action: storageBackupPath === undefined
        ? binaryActivationUncertainAction()
        : postSwitchRecoveryAction(home, storageBackupPath),
      // Once binary activation begins, its outcome is not knowable from a
      // failed npm process. Home-not-switched is useful evidence, but it does
      // not prove the current installation remains usable.
      recoverable: false,
      version: staged.version,
      ...(storageBackupPath === undefined ? {} : { storageBackupPath })
    };
    return restoreBeforeSwitchOrReport(ports, home, lifecycle, storageBackupPath, failure);
  }

  try {
    ports.verify(staged, home);
  } catch (error) {
    const failure: UpdateResult = {
      outcome: "aborted",
      phase: "post-verify",
      message: `Post-update health check failed: ${messageOf(error)}`,
      action: storageBackupPath === undefined
        ? binaryHealthUncertainAction()
        : postSwitchRecoveryAction(home, storageBackupPath),
      recoverable: false,
      version: staged.version,
      ...(storageBackupPath === undefined ? {} : { storageBackupPath })
    };
    return restoreBeforeSwitchOrReport(ports, home, lifecycle, storageBackupPath, failure);
  }

  if (lifecycle?.wasRunning === true) {
    try {
      ports.startController!(home);
    } catch (error) {
      const failure: UpdateResult = {
        outcome: "aborted",
        phase: "post-verify",
        message:
          `The replacement Controller could not start after activation and health verification: `
          + `${messageOf(error)}.`,
        action: storageBackupPath === undefined
          ? "The Home was not migrated. Keep writes quiesced and restore the previously running Controller identity before retrying."
          : postSwitchRecoveryAction(home, storageBackupPath),
        recoverable: false,
        version: staged.version,
        ...(storageBackupPath === undefined ? {} : { storageBackupPath })
      };
      return restoreBeforeSwitchOrReport(ports, home, lifecycle, storageBackupPath, failure);
    }
  }

  return storageBackupPath === undefined
    ? { outcome: "updated", version: staged.version }
    : { outcome: "updated", version: staged.version, storageBackupPath };
}

/**
 * Capture the old Controller before a binary-only update mutates the install.
 * A partial lifecycle port set is rejected rather than silently selecting a
 * staged/new `ensureFileTaskController` for restoration.
 */
function captureControllerLifecycle(
  ports: UpdatePorts,
  version: string,
  home: string
): { lifecycle: UpdateControllerLifecycle } | Extract<UpdateResult, { outcome: "aborted" }> {
  const supplied = [
    ports.controllerStatus,
    ports.stopController,
    ports.startController,
    ports.restoreController
  ].some((port) => port !== undefined);
  if (!supplied) return { lifecycle: { wasRunning: false, stopped: false } };
  if (
    ports.controllerStatus === undefined
    || ports.stopController === undefined
    || ports.startController === undefined
    || ports.restoreController === undefined
  ) {
    return {
      outcome: "aborted",
      phase: "preflight",
      message: "Controller lifecycle ownership is incomplete for this update.",
      action:
        "Provide status, stop, replacement-start, and exact-identity restore seams; refusing to activate a binary without a complete lifecycle owner.",
      recoverable: true,
      version
    };
  }

  let status: UpdateControllerLifecycleStatus;
  try {
    status = ports.controllerStatus(home);
  } catch (error) {
    return {
      outcome: "aborted",
      phase: "preflight",
      message: `Controller status could not be verified: ${messageOf(error)}`,
      action:
        "Do not activate the binary while Controller ownership is unknown; inspect the Controller and retry once status is verified.",
      recoverable: true,
      version
    };
  }
  if (!isControllerLifecycleStatus(status)) {
    return {
      outcome: "aborted",
      phase: "preflight",
      message: "Controller status was malformed; expected a boolean running field.",
      action: "Inspect the Controller status provider and retry; no binary activation was attempted.",
      recoverable: true,
      version
    };
  }
  if (!status.running) return { lifecycle: { wasRunning: false, stopped: false } };
  if (!isControllerIdentity(status.identity)) {
    return {
      outcome: "aborted",
      phase: "preflight",
      message:
        "The Controller is running but its executable/version identity could not be captured.",
      action:
        "Refusing to stop a Controller that cannot be restored exactly; provide its executable path, arguments, and version, then retry.",
      recoverable: true,
      version
    };
  }

  let stopped: UpdateControllerStopResult;
  try {
    stopped = ports.stopController(home);
  } catch (error) {
    return {
      outcome: "aborted",
      phase: "preflight",
      message: `Controller stop/drain failed: ${messageOf(error)}`,
      action:
        "The Controller may still be active or draining. Do not retry stop blindly; inspect it and retry once the Home is quiesced.",
      recoverable: true,
      version
    };
  }
  if (!isControllerStopResult(stopped) || stopped.stopped !== true) {
    return {
      outcome: "aborted",
      phase: "preflight",
      message: "Controller stop did not return the required stopped:true confirmation.",
      action:
        "Keep the Home quiesced and inspect the Controller; no binary activation was attempted and no stop retry was issued.",
      recoverable: true,
      version
    };
  }
  return {
    lifecycle: {
      wasRunning: true,
      stopped: true,
      identity: status.identity
    }
  };
}

function restoreBeforeSwitchOrReport(
  ports: UpdatePorts,
  home: string,
  lifecycle: UpdateControllerLifecycle | undefined,
  storageBackupPath: string | undefined,
  failure: Extract<UpdateResult, { outcome: "aborted" }>
): UpdateResult {
  // Once storage switched, the old Controller is never safe to restore. Keep
  // the failure structured and point at all durable recovery evidence instead.
  if (storageBackupPath !== undefined || lifecycle?.wasRunning !== true) return failure;
  try {
    ports.restoreController!(home, lifecycle.identity!);
    return failure;
  } catch (error) {
    return {
      outcome: "aborted",
      phase: "post-verify",
      message:
        `${failure.message} The previously running Controller identity could not be restored: `
        + `${messageOf(error)}.`,
      action:
        "Keep the Home quiesced and resolve the exact old Controller restore failure before retrying; do not start the staged/new Controller blindly.",
      recoverable: false,
      version: "version" in failure ? failure.version : undefined
    };
  }
}

function postSwitchRecoveryAction(home: string, backupPath: string): string {
  return `The storage switch is committed (backup at ${backupPath}); do not restore the old Controller. `
    + `Inspect the backup, receipt marker "${upgradeReceiptPath(home)}", and switch-progress marker `
    + `"${switchProgressPath(home)}". Verify the migrated Home, then either finish the update or `
    + `restore the backup explicitly with mv "${backupPath}" "${home}".`;
}

function binaryActivationUncertainAction(): string {
  return "The Home was not migrated, but binary activation began and its outcome is unknown; "
    + "do not assume the current install is usable. Reinstall Yui, verify `yui version` and "
    + "`yui doctor`, then retry `yui update` before resuming writes.";
}

function binaryHealthUncertainAction(): string {
  return "The Home was not migrated, but the activated binary failed health verification; do not "
    + "assume the current install is usable. Reinstall Yui, verify `yui version` and `yui doctor`, "
    + "then retry `yui update` before resuming writes.";
}

function isControllerLifecycleStatus(value: unknown): value is UpdateControllerLifecycleStatus {
  return isRecord(value) && typeof value.running === "boolean";
}

function isControllerStopResult(value: unknown): value is UpdateControllerStopResult {
  return isRecord(value) && typeof value.stopped === "boolean";
}

function isControllerIdentity(value: unknown): value is ControllerIdentity {
  return isRecord(value)
    && typeof value.executablePath === "string"
    && value.executablePath.length > 0
    && Array.isArray(value.args)
    && value.args.every((arg) => typeof arg === "string")
    && typeof value.version === "string"
    && value.version.length > 0;
}

/**
 * Resolve an ambiguous storage activation (P1-2): the activation child left no
 * parseable receipt, so the switch may or may not have committed. Probe the
 * durable on-disk evidence and report an explicit manual recovery — this is
 * NEVER reported as recoverable-and-unchanged.
 *
 * The verdict is driven by the completion receipt first (the switch writes it the
 * instant it commits), then corroborated by the on-disk schema:
 *  - receipt present  -> the switch committed; point at the backup and require
 *    the operator to verify the migrated Home before resuming (the binary was
 *    never promoted, so the old binary fail-closes on the new schema).
 *  - no receipt, schema already current -> most likely the switch never ran
 *    (or fully reverted); still require an explicit re-run rather than asserting
 *    "unchanged", because stdout was lost.
 *  - no receipt, schema not current -> genuinely indeterminate; give the
 *    operator the exact files to inspect.
 */
function resolveAmbiguousActivation(
  ports: UpdatePorts,
  staged: StagedPackage,
  home: string,
  detail: string
): UpdateResult {
  let probe: StorageStateProbe;
  try {
    probe = ports.probeStorage(home);
  } catch (error) {
    // Even the probe failed: report maximum uncertainty with the raw evidence.
    return {
      outcome: "ambiguous",
      phase: "activate-storage",
      message: `Storage activation result is unknown (${detail}); probing the Home also failed: ${messageOf(error)}.`,
      action:
        `Do NOT assume the update succeeded or was a no-op. Manually inspect ${home} and any `
        + `"${home}.backup-*" sibling, "${upgradeReceiptPath(home)}", and `
        + `"${switchProgressPath(home)}"; if a receipt exists the `
        + `switch committed — verify the migrated Home with "yui doctor" before resuming, otherwise `
        + `restore the newest backup with mv before re-running "yui update".`,
      version: staged.version,
      schemaCurrent: false,
      switched: false
    };
  }

  if (probe.interrupted === true) {
    // A partially-applied, interrupted switch: the original was moved to the
    // backup and neither promotion nor rollback completed, so the Home path may
    // be missing. This is the strongest "restore the backup now" signal — never a
    // "verify the migrated Home" or a "recoverable no-op".
    return {
      outcome: "ambiguous",
      phase: "activate-storage",
      message:
        `Storage switch was INTERRUPTED mid-rename (${detail}); the Home may be missing and was `
        + `NOT left intact. The new binary was NOT promoted.`,
      action:
        `Restore the timestamped backup to recover the original Home: `
        + `mv "${probe.backupPath ?? "<home>.backup-*"}" "${home}". Do NOT resume writes until it is `
        + `restored; inspect "${switchProgressPath(home)}" for the interrupted phase, then re-run "yui update".`,
      version: staged.version,
      schemaCurrent: probe.schemaCurrent,
      switched: false,
      ...(probe.backupPath === undefined ? {} : { storageBackupPath: probe.backupPath })
    };
  }

  if (probe.switched) {
    // The switch provably committed; the binary was not promoted.
    return {
      outcome: "ambiguous",
      phase: "activate-storage",
      message:
        `Storage was switched (a completion receipt is present) but the activation process `
        + `did not confirm success (${detail}). The new binary was NOT promoted.`,
      action:
        `Verify the migrated Home before resuming writes: run "yui doctor"`
        + `${probe.backupPath === undefined ? "" : ` (its timestamped backup is ${probe.backupPath})`}. `
        + `Inspect "${upgradeReceiptPath(home)}" and "${switchProgressPath(home)}" before deciding. `
        + `If it is healthy, finish by re-running "yui update" to promote the binary; if not, restore `
        + `the backup with mv "${probe.backupPath ?? "<home>.backup-*"}" "${home}". Do NOT resume `
        + `writes with the old binary against the migrated Home.`,
      version: staged.version,
      schemaCurrent: probe.schemaCurrent,
      switched: true,
      ...(probe.backupPath === undefined ? {} : { storageBackupPath: probe.backupPath })
    };
  }

  // No receipt: the switch most likely never committed, but stdout was lost so we
  // cannot assert "unchanged". Require an explicit, verified re-run.
  return {
    outcome: "ambiguous",
    phase: "activate-storage",
    message:
      `Storage activation did not confirm a result (${detail}) and no completion receipt was found`
      + `${probe.schemaCurrent ? "; the Home currently loads at the current schema" : ""}.`,
    action:
      `The switch most likely did not commit, but this was not confirmed. Verify with "yui doctor" `
      + `and check for any "${home}.backup-*" sibling, "${upgradeReceiptPath(home)}", and `
      + `"${switchProgressPath(home)}" before retrying; then re-run "yui update". Do `
      + `NOT assume the update completed.`,
    version: staged.version,
    schemaCurrent: probe.schemaCurrent,
    switched: false
  };
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isValidBackupPath(value: unknown): value is string {
  return typeof value === "string"
    && value.length > 0
    && value.trim() === value
    && !value.includes("\0")
    && isAbsolute(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
