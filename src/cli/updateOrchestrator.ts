/**
 * Side-by-side `yui update` orchestration for the current storage contract.
 *
 * The staged binary may only prove that the target Home already implements the
 * exact current contract. Updating never rewrites, normalizes, migrates, or
 * repairs storage. An older Home stays untouched so an Operator can inspect it
 * with its original Yui version and create a new current Task explicitly.
 */

/** A side-by-side staged package, isolated from the live global install. */
export type StagedPackage = Readonly<{
  binaryPath: string;
  version: string;
  stagingPath?: string;
}>;

/** Read-only verdict produced by the staged binary. */
export type UpdatePreflight = Readonly<
  | { status: "already-current" }
  | {
      status: "blocked";
      stage: string;
      message: string;
      action: string;
      blockers?: readonly UpdateBlockerIdentity[];
      retryCommand?: string;
      sceneUnchanged?: true;
    }
>;

export type UpdateBlockerIdentity = Readonly<{
  taskId?: string;
  roleName?: string;
  turnId?: string;
  nativeSessionId?: string;
  launchId?: string;
  reason: string;
}>;

/** Exact identity captured before stopping a running Controller. */
export type ControllerIdentity = Readonly<{
  executablePath: string;
  args: readonly string[];
  version: string;
}>;

export type UpdateControllerLifecycleStatus = Readonly<{
  running: boolean;
  pid?: number;
  identity?: ControllerIdentity;
}>;

export type UpdateControllerStopResult = Readonly<{
  stopped: boolean;
  alreadyStopped?: boolean;
  pid?: number;
}>;

/** Injected update effects. Storage mutation is deliberately absent. */
export type UpdatePorts = Readonly<{
  stage: (version?: string) => StagedPackage;
  preflight: (staged: StagedPackage, home: string) => UpdatePreflight;
  activateBinary: (staged: StagedPackage) => void;
  verify: (staged: StagedPackage, home: string) => void;
  cleanup: (staged: StagedPackage) => void;
  beginControllerHandover?: (home: string) => () => void;
  controllerStatus?: (home: string) => UpdateControllerLifecycleStatus;
  stopController?: (home: string, expectedPid: number) => UpdateControllerStopResult;
  startController?: (home: string) => void;
  restoreController?: (home: string, identity: ControllerIdentity) => void;
}>;

export type UpdateResult = Readonly<
  (
    | { outcome: "already-current"; version: string }
    | { outcome: "updated"; version: string; path: "current-fast" }
    | {
        outcome: "aborted";
        phase: UpdatePhase;
        message: string;
        action: string;
        recoverable: boolean;
        version?: string;
        blockers?: readonly UpdateBlockerIdentity[];
        retryCommand?: string;
        sceneUnchanged?: true;
        controllerOwnershipUnknown?: true;
      }
  ) & { cleanupWarning?: string }
>;

export type UpdatePhase =
  | "stage"
  | "preflight"
  | "coordination"
  | "activate-binary"
  | "post-verify";

type ControllerLifecycle = Readonly<{
  ensureRunning: boolean;
  wasRunning: boolean;
  identity?: ControllerIdentity;
}>;

export function runUpdate(
  ports: UpdatePorts,
  options: Readonly<{ home: string }>
): UpdateResult {
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
    result = runStagedUpdate(ports, staged, options.home);
  } finally {
    try {
      ports.cleanup(staged);
    } catch (error) {
      cleanupWarning = `Staging cleanup could not be completed: ${messageOf(error)}`;
    }
  }
  return cleanupWarning === undefined ? result : { ...result, cleanupWarning };
}

function runStagedUpdate(
  ports: UpdatePorts,
  staged: StagedPackage,
  home: string
): UpdateResult {
  let preflight: UpdatePreflight;
  try {
    preflight = ports.preflight(staged, home);
  } catch (error) {
    return {
      outcome: "aborted",
      phase: "preflight",
      message: `Preflight failed unexpectedly: ${messageOf(error)}`,
      action: "The current install and Home are unchanged. Inspect the staged binary and retry.",
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
      version: staged.version,
      ...(preflight.blockers === undefined ? {} : { blockers: preflight.blockers }),
      ...(preflight.retryCommand === undefined ? {} : { retryCommand: preflight.retryCommand }),
      ...(preflight.sceneUnchanged === true ? { sceneUnchanged: true } : {})
    };
  }

  let releaseHandover: (() => void) | undefined;
  try {
    releaseHandover = ports.beginControllerHandover?.(home);
  } catch (error) {
    return {
      outcome: "aborted",
      phase: "coordination",
      message: `Controller handover could not be acquired: ${messageOf(error)}`,
      action: "Wait for the other maintenance operation to finish, then retry; nothing was changed.",
      recoverable: true,
      version: staged.version
    };
  }

  try {
    const captured = captureControllerLifecycle(ports, staged.version, home);
    if ("outcome" in captured) return captured;
    return activateAndVerify(ports, staged, home, captured.lifecycle);
  } finally {
    releaseHandover?.();
  }
}

function activateAndVerify(
  ports: UpdatePorts,
  staged: StagedPackage,
  home: string,
  lifecycle: ControllerLifecycle
): UpdateResult {
  try {
    ports.activateBinary(staged);
  } catch (error) {
    return restoreControllerOrReport(ports, home, lifecycle, {
      outcome: "aborted",
      phase: "activate-binary",
      message: `Failed to activate the new binary: ${messageOf(error)}`,
      action: binaryActivationUncertainAction(),
      recoverable: false,
      version: staged.version
    });
  }

  try {
    ports.verify(staged, home);
  } catch (error) {
    return restoreControllerOrReport(ports, home, lifecycle, {
      outcome: "aborted",
      phase: "post-verify",
      message: `Post-update health check failed: ${messageOf(error)}`,
      action: binaryHealthUncertainAction(),
      recoverable: false,
      version: staged.version
    });
  }

  if (lifecycle.ensureRunning) {
    try {
      ports.startController!(home);
    } catch (error) {
      const unknownActive = isUnknownActiveControllerFailure(error);
      const failure: Extract<UpdateResult, { outcome: "aborted" }> = {
        outcome: "aborted",
        phase: "post-verify",
        message: `${unknownActive
          ? "Replacement Controller ownership could not be authenticated safely"
          : "The replacement Controller could not start after activation and verification"}: ${messageOf(error)}.`,
        action: unknownActive
          ? unknownActiveControllerAction(home)
          : lifecycle.wasRunning
            ? "Keep the Home quiesced and restore the captured Controller identity before retrying."
            : "Verify the activated binary, then start the Controller explicitly.",
        recoverable: false,
        version: staged.version,
        controllerOwnershipUnknown: true
      };
      return unknownActive
        ? failure
        : restoreControllerOrReport(ports, home, lifecycle, failure);
    }
  }

  return { outcome: "updated", version: staged.version, path: "current-fast" };
}

function captureControllerLifecycle(
  ports: UpdatePorts,
  version: string,
  home: string
): { lifecycle: ControllerLifecycle } | Extract<UpdateResult, { outcome: "aborted" }> {
  const supplied = [
    ports.controllerStatus,
    ports.stopController,
    ports.startController,
    ports.restoreController
  ].some((port) => port !== undefined);
  if (!supplied) {
    return { lifecycle: { ensureRunning: false, wasRunning: false } };
  }
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
      action: "Provide status, exact stop, replacement start, and exact restore operations.",
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
      action: "Inspect Controller ownership and retry after its status is known.",
      recoverable: true,
      version
    };
  }
  if (!isControllerLifecycleStatus(status)) {
    return malformedControllerResult(version, "Controller status was malformed.");
  }
  if (!status.running) {
    return { lifecycle: { ensureRunning: true, wasRunning: false } };
  }
  if (!isPositivePid(status.pid) || !isControllerIdentity(status.identity)) {
    return malformedControllerResult(
      version,
      "The running Controller did not expose an exact PID and launch identity."
    );
  }

  let stopped: UpdateControllerStopResult;
  try {
    stopped = ports.stopController(home, status.pid);
  } catch (error) {
    return {
      outcome: "aborted",
      phase: "preflight",
      message: `Controller stop/drain failed: ${messageOf(error)}`,
      action: "Inspect the captured Controller before retrying; binary activation was not attempted.",
      recoverable: true,
      version
    };
  }
  if (!isControllerStopResult(stopped) || stopped.stopped !== true || stopped.pid !== status.pid) {
    return malformedControllerResult(
      version,
      `Controller stop did not confirm captured PID ${status.pid}.`
    );
  }
  return {
    lifecycle: {
      ensureRunning: true,
      wasRunning: true,
      identity: status.identity
    }
  };
}

function malformedControllerResult(
  version: string,
  message: string
): Extract<UpdateResult, { outcome: "aborted" }> {
  return {
    outcome: "aborted",
    phase: "preflight",
    message,
    action: "Refusing an unfenced Controller handoff; inspect ownership and retry.",
    recoverable: true,
    version
  };
}

function restoreControllerOrReport(
  ports: UpdatePorts,
  home: string,
  lifecycle: ControllerLifecycle,
  failure: Extract<UpdateResult, { outcome: "aborted" }>
): UpdateResult {
  if (!lifecycle.wasRunning) return failure;
  try {
    ports.restoreController!(home, lifecycle.identity!);
    return failure;
  } catch (error) {
    return {
      ...failure,
      message: `${failure.message} Captured Controller restore failed: ${messageOf(error)}.`,
      action: `${failure.action} Keep the Home quiesced and resolve the restore failure.`,
      recoverable: false
    };
  }
}

function binaryActivationUncertainAction(): string {
  return "Binary activation began and its result is unknown. Reinstall Yui, then verify `yui version` and `yui doctor` before resuming the Controller.";
}

function binaryHealthUncertainAction(): string {
  return "The activated binary failed health verification. Reinstall Yui and verify `yui version` and `yui doctor` before resuming the Controller.";
}

function unknownActiveControllerAction(home: string): string {
  return `A replacement Controller may be active under unknown ownership for ${home}. Keep it quiesced, authenticate its PID, and stop only that proven owner before retrying.`;
}

function isUnknownActiveControllerFailure(error: unknown): boolean {
  return isRecord(error) && error.code === "UPDATE_CONTROLLER_UNKNOWN_ACTIVE";
}

function isControllerLifecycleStatus(value: unknown): value is UpdateControllerLifecycleStatus {
  return isRecord(value) && typeof value.running === "boolean";
}

function isControllerStopResult(value: unknown): value is UpdateControllerStopResult {
  return isRecord(value) && typeof value.stopped === "boolean";
}

function isPositivePid(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
