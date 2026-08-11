/**
 * The storage upgrade orchestrator.
 *
 * This composes the generic migration engine (`../migration`) with the real
 * Home-bound target and the admission fence into the user-facing `yui upgrade`
 * and the storage half of `yui update`:
 *
 *   preflight (classify, read-only)
 *     -> plan (delegated to the engine; missing/future step = fail-closed)
 *     -> [offline only] authoritative active Run/Session/lifecycle inventory
 *     -> [execute] admission fence  (new writers refused)
 *          -> close pre-admitted writers + final offline inventory
 *     -> [execute] coordination lock (outside Home; shared with inbox publish)
 *          -> quiesce (record/stop prior Controller; verify no foreign writer /
 *             unfinished lifecycle)
 *          -> re-pin revision (under `.state.lock`)
 *          -> snapshot -> validate gate -> atomic switch + backup
 *     -> [execute] post-switch health check (fresh FileTaskStore loader)
 *     -> restore old Controller on pre-switch block, or start the replacement
 *        only after a committed switch and successful verification
 *
 * Compatible-old returns before constructing a migration target. The internal
 * update preflight returns after classification, compatible-source validation,
 * or the authoritative offline inventory appropriate to the classified path, so
 * it remains safe while the exact old Controller is still running and never
 * claims staged-output validation. User-facing
 * `--dry-run` runs the staged validation gate and succeeds only when the engine
 * itself returns `dry-run`; every other engine outcome is preserved as a blocker.
 *
 * Quiesce uses only explicit, deterministic signals — the public
 * `controller.stop`/shutdownAndDrain, the real `.state.lock`, unfinished runtime
 * lifecycle mailboxes — never a broad process kill and never a TTL/idle
 * heuristic. Any signal that is not clear fails closed and leaves the original
 * authoritative input byte-for-byte unchanged.
 */

import { spawn } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import {
  describeReport,
  runMigration,
  type MigrationRegistry,
  type MigrationReport,
  type StorageVersionState
} from "../migration/index.js";
import { validateCompatibleFileTaskStore } from "../compatibleTaskStore.js";
import {
  stopFileTaskController,
  ensureFileTaskController,
  ensureFileTaskControllerIdentity,
  type FileControllerClientOptions
} from "../../controller/clientRuntime.js";
import { callController } from "../../core/controllerClient.js";
import { FileTaskStore, STORAGE_STATE_FILE, withStorageWriteLock } from "../taskStore.js";
import {
  clearUpgradeFence,
  placeUpgradeFence,
  readUpgradeFence,
  UpgradeFenceError
} from "../upgradeFence.js";
import { withUpgradeCoordinationLock } from "../upgradeCoordination.js";
import {
  clearUpgradeReceipt,
  writeUpgradeReceipt,
  upgradeReceiptPath
} from "./upgradeReceipt.js";
import { switchProgressPath } from "./switchProgress.js";
import {
  classifyHome,
  type HomeClassification
} from "./homeClassification.js";
import {
  createHomeMigrationTarget,
  describeActiveRuntime,
  homeRuntimeIsActive,
  inspectHomeRuntime,
  type HomeSnapshot,
  type SwitchStep
} from "./homeMigrationTarget.js";
import {
  inspectOfflineUpgradeInventory,
  type OfflineUpgradeBlocker,
  type OfflineUpgradeInventory
} from "./offlineUpgradeInventory.js";

/** The precise stage at which an upgrade was blocked or failed. */
export type UpgradeBlockerStage =
  | "uninitialized"
  | "missing-step"
  | "future-version"
  | "corruption"
  | "active-sessions"
  | "active-runtime"
  | "drain-incomplete"
  | "coordination"
  | "validate"
  | "switch"
  | "switch-ambiguous"
  | "post-verify";

/** A fail-closed blocker before its owning classification is attached. */
type UpgradeBlocker = Readonly<{
  outcome: "blocked";
  stage: UpgradeBlockerStage;
  message: string;
  action: string;
  blockers?: readonly OfflineUpgradeBlocker[];
  retryCommand?: "yui update";
  sceneUnchanged?: true;
  /** True once the atomic Home switch committed; never restore the old Controller. */
  switchCommitted?: true;
  /** The exact backup retained for explicit recovery after a committed switch. */
  backupPath?: string;
  /** Named durable evidence for an ambiguous post-switch boundary. */
  recoveryEvidence?: Readonly<{
    backupPath?: string;
    receiptPath: string;
    progressPath: string;
  }>;
}>;

/** The structured result of an upgrade attempt. */
export type UpgradeResult = Readonly<
  | {
      outcome: "already-current";
      classification: HomeClassification;
      report: MigrationReport;
    }
  | {
      outcome: "compatible";
      classification: HomeClassification;
    }
  | {
      /** Internal update contract; never a staged-output validation result. */
      outcome: "update-preflight";
      status: "already-current" | "compatible" | "migration-required";
      stepCount: number;
      classification: HomeClassification;
    }
  | {
      outcome: "dry-run";
      classification: HomeClassification;
      report: MigrationReport;
    }
  | {
      outcome: "upgraded";
      classification: HomeClassification;
      report: MigrationReport;
      backupPath?: string;
    }
  | (UpgradeBlocker & {
      classification: HomeClassification;
      report?: MigrationReport;
    })
>;

export type RunStorageUpgradeOptions<Snapshot> = Readonly<{
  home: string;
  registry: MigrationRegistry<Snapshot>;
  latest: StorageVersionState;
  mode: "dry-run" | "execute" | "update-preflight";
  /**
   * The normal upgrade owns Controller capture/stop/start. The update parent
   * may instead externally quiesce the Home and ask this staged child to run
   * storage migration only; in that mode no Controller lifecycle probe or start
   * is performed from the temporary installation.
   */
  controllerLifecycle?: "owned" | "externally-quiesced";
  now?: () => Date;
  callerPid?: number;
  /** Overrides for the Controller stop/drain client (tests inject fakes). */
  controllerOptions?: FileControllerClientOptions;
  /**
   * Test seam: inspect whether the Controller was running before quiesce.
   * Defaults to the authenticated `controller.status` RPC; an absent
   * Controller is the only state treated as definitely stopped.
   */
  controllerStatus?: (home: string) => Promise<ControllerLifecycleStatus>;
  /** Test seam: stop+drain the Controller. Defaults to the real client. */
  stopController?: (
    home: string,
    expectedPid: number
  ) => Promise<void | ControllerStopResult>;
  /**
   * Test seam: start a Controller after a verified switch, or restore the old
   * Controller after a blocked pre-switch attempt. Defaults to the real client.
   */
  startController?: (home: string) => Promise<unknown>;
  /** Restore the exact Controller identity captured before quiesce. */
  restoreController?: (
    home: string,
    identity: ControllerLaunchIdentity
  ) => Promise<unknown>;
  /**
   * Test seam forwarded to the migration target's atomic switch to simulate a
   * failing promotion/rollback rename (P1-4). Production never sets it.
   */
  renameImpl?: (from: string, to: string) => void;
  /**
   * Test seam forwarded to the migration target's atomic switch to fault a
   * specific fsync/marker step around the two renames (F2). Production never
   * sets it.
   */
  switchFaultHook?: (step: SwitchStep) => void;
  /** Test-only injection for failures after the atomic switch commits. */
  postSwitchFaultHook?: (step: PostSwitchFaultStep) => void;
  /** Read-only authoritative offline blocker inventory; tests inject facts. */
  inspectOfflineInventory?: (home: string) => Promise<OfflineUpgradeInventory>;
}>;

/** Deterministic post-switch failure seams used by regression tests. */
export type PostSwitchFaultStep = "receipt-write" | "post-verify" | "receipt-clear";

type SwitchCommitState = {
  committed: boolean;
  backupPath?: string;
};

/** The lifecycle fact captured before an upgrade stops a Controller. */
export type ControllerLifecycleStatus = Readonly<{
  running: boolean;
  pid?: number;
  /** Exact executable/version captured before the Controller is stopped. */
  identity?: ControllerLaunchIdentity;
}>;

/** The executable, arguments, and version of a Controller before quiesce. */
export type ControllerLaunchIdentity = Readonly<{
  executablePath: string;
  args: readonly string[];
  version: string;
}>;

/** A stop result is successful only when the caller can prove `stopped:true`. */
export type ControllerStopResult = Readonly<{
  stopped: boolean;
  alreadyStopped?: boolean;
  pid?: number;
}>;

/**
 * Run the storage upgrade for one Home. Never throws for an expected blocker;
 * it returns a structured `blocked` result instead. It only throws on a truly
 * unexpected fault, and even then never after the atomic switch has committed.
 */
export async function runStorageUpgrade(
  options: RunStorageUpgradeOptions<HomeSnapshot>
): Promise<UpgradeResult> {
  const { home, registry, latest, mode } = options;
  const now = options.now ?? (() => new Date());
  const callerPid = options.callerPid ?? process.pid;

  // 1) Preflight — read-only classification.
  const classification = classifyHome({ home, registry, latest });

  // An uninitialized Home has no storage to migrate. The classifier reports it as
  // USABLE (nothing is wrong; doctor may present it as-is), but for the UPGRADE
  // path that verdict would collapse into a silent no-op against a Home that was
  // never `yui setup`. Return a structured, actionable blocker instead — never a
  // false success and never an unclassified runtime error (P2-7).
  if (classification.uninitialized === true) {
    return withClassification(
      {
        outcome: "blocked",
        stage: "uninitialized",
        message: "Yui storage is not initialized for this Home; there is nothing to upgrade.",
        action: "Run `yui setup` to initialize storage, then re-run the upgrade if needed."
      },
      classification
    );
  }

  const verdict = classification.classification.verdict;
  if (verdict === "CORRUPTED") {
    return withClassification(
      {
        outcome: "blocked",
        stage: "corruption",
        message: `Storage is corrupted: ${classification.classification.detail}`,
        action: "Restore from a backup or a healthy Home; upgrade cannot proceed."
      },
      classification
    );
  }
  if (verdict === "NEEDS_NEW_VERSION") {
    const blocker = classification.classification.blocker;
    return withClassification(
      {
        outcome: "blocked",
        stage: blocker.reason === "future-version" ? "future-version" : "missing-step",
        message: blocker.message,
        action: blocker.action
      },
      classification
    );
  }

  // An all-compatible chain is an online-load contract, not a migration plan.
  // Validate the declared old source shape and its in-memory normalization before
  // ANY mode reports compatible, including the internal update preflight. This is
  // read-only and safe while the exact old Controller is still running; it creates
  // no migration target or staged Home and touches no lifecycle state.
  if (verdict === "COMPATIBLE") {
    try {
      validateCompatibleFileTaskStore(home, { registry, latest });
      if (mode === "update-preflight") {
        return {
          outcome: "update-preflight",
          status: "compatible",
          stepCount: classification.classification.stepCount,
          classification
        };
      }
      return { outcome: "compatible", classification };
    } catch (error) {
      const detail = `Compatible source validation failed: ${messageOf(error)}`;
      const invalid: HomeClassification = {
        ...classification,
        classification: {
          verdict: "CORRUPTED",
          status: "unsupported",
          detail
        }
      };
      return withClassification(
        {
          outcome: "blocked",
          stage: "corruption",
          message: detail,
          action:
            "Do not activate the new binary. The declared old shape did not pass its strict read-only validator."
        },
        invalid
      );
    }
  }

  // `yui update` invokes this explicit internal contract while the exact old
  // Controller is still running. It performs classification for a current Home,
  // compatible-source validation above for a compatible Home, and classification
  // plus the authoritative offline inventory for a migration path. It never
  // constructs a migration target, so there is no staging copy, backup, fence,
  // runtime/Controller lifecycle probe, staged-output loader validation, or switch.
  if (mode === "update-preflight") {
    if (verdict === "USABLE") {
      return {
        outcome: "update-preflight",
        status: "already-current",
        stepCount: 0,
        classification
      };
    }
    // verdict === MIGRATABLE: a parent update may stop the old Controller only
    // after this authoritative offline inventory is clear.
    const inventory = await readOfflineInventory(options, home);
    if (inventory.total > 0) {
      return withClassification(offlineInventoryBlocker(inventory, true), classification);
    }
    return {
      outcome: "update-preflight",
      status: "migration-required",
      stepCount: classification.classification.stepCount,
      classification
    };
  }

  if (verdict === "MIGRATABLE") {
    const inventory = await readOfflineInventory(options, home);
    if (inventory.total > 0) {
      return withClassification(
        offlineInventoryBlocker(inventory, true),
        classification
      );
    }
  }

  const target = createHomeMigrationTarget({
    home,
    latest,
    now,
    callerPid,
    ...(options.renameImpl === undefined ? {} : { renameImpl: options.renameImpl }),
    ...(options.switchFaultHook === undefined ? {} : { switchFaultHook: options.switchFaultHook })
  });

  // 2) A USABLE (already-current) Home has nothing to migrate; the engine
  // confirms with a no-op and we never fence, drain, or switch.
  if (verdict === "USABLE") {
    const report = runMigration({ registry, target, latest, mode: "dry-run" });
    if (report.outcome === "already-current") {
      return { outcome: "already-current", classification, report };
    }
    // A USABLE verdict with a runnable plan cannot happen (USABLE == no-op), but
    // if the registry disagrees we fail closed rather than switch unexpectedly.
    return {
      ...withClassification(
        {
          outcome: "blocked",
          stage: "missing-step",
          message: "Classifier and planner disagree about whether an upgrade is needed.",
          action: "Re-run `yui doctor`; do not force an upgrade."
        },
        classification
      ),
      report
    };
  }

  // verdict === "MIGRATABLE": a complete offline step path exists and the
  // authoritative inventory was re-read clear before any lifecycle mutation.
  if (mode === "dry-run") {
    return dryRun(options, classification, target);
  }
  return execute(options, classification, target, callerPid, now);
}

function describeOfflineBlockers(inventory: OfflineUpgradeInventory): string {
  const lines = inventory.blockers.map((blocker, index) => {
    const identity = [
      blocker.taskId === undefined ? undefined : `task=${blocker.taskId}`,
      blocker.roleName === undefined ? undefined : `role=${blocker.roleName}`,
      blocker.runId === undefined ? undefined : `run=${blocker.runId}`,
      blocker.nativeSessionId === undefined
        ? undefined
        : `nativeSession=${blocker.nativeSessionId}`,
      blocker.launchId === undefined ? undefined : `launch=${blocker.launchId}`
    ].filter((value): value is string => value !== undefined).join(" ");
    const reason = blocker.reason === "pending-inbox"
      ? "pending durable inbox"
      : blocker.reason === "pending-mailbox"
        ? "pending lifecycle mailbox"
        : blocker.reason;
    return `${index + 1}. ${identity.length === 0 ? "identity=unknown" : identity} ` +
      `reason=${reason}`;
  });
  return `Offline migration blocked by ${inventory.total} active runtime item(s). ` +
    lines.join("; ");
}

async function readOfflineInventory(
  options: RunStorageUpgradeOptions<HomeSnapshot>,
  home: string
): Promise<OfflineUpgradeInventory> {
  try {
    return await (options.inspectOfflineInventory
      ?? ((targetHome: string) => inspectOfflineUpgradeInventory(targetHome)))(home);
  } catch {
    return {
      total: 1,
      blockers: [{ reason: "native-session-unknown" }]
    };
  }
}

function offlineInventoryBlocker(
  inventory: OfflineUpgradeInventory,
  sceneUnchanged: boolean
): UpgradeBlocker {
  const lifecycleOnly = inventory.blockers.every(({ reason }) => (
    reason === "pending-mailbox" || reason === "pending-inbox"
  ));
  return {
    outcome: "blocked",
    stage: lifecycleOnly ? "drain-incomplete" : "active-sessions",
    message: describeOfflineBlockers(inventory),
    action: sceneUnchanged
      ? "No binary, Controller, fence, or Home change was made. Keep working; when every " +
        "listed runtime obligation is clear, re-run `yui update` so preflight is repeated."
      : "The Home was not switched. Let every listed runtime obligation settle, then re-run " +
        "`yui update`; do not kill, reset, rebind, or retry the blocked runtime blindly.",
    blockers: inventory.blockers,
    retryCommand: "yui update",
    ...(sceneUnchanged ? { sceneUnchanged: true } : {})
  };
}

/** Dry run: validate through the staged gate, then discard; never switch. */
function dryRun(
  options: RunStorageUpgradeOptions<HomeSnapshot>,
  classification: HomeClassification,
  target: ReturnType<typeof createHomeMigrationTarget>
): UpgradeResult {
  // Refuse to reuse a stale staging directory from an interrupted run.
  target.discardFreshOutput();
  const report = runMigration({
    registry: options.registry,
    target,
    latest: options.latest,
    mode: "dry-run"
  });
  target.discardFreshOutput();
  if (report.outcome === "dry-run") {
    return { outcome: "dry-run", classification, report };
  }
  if (report.outcome === "failed") {
    return { ...blockedFromFailedReport(report, classification), report };
  }
  // A dry-run success is proven only by the engine's exact `dry-run` variant,
  // which carries staged-output and loader-gate evidence. In particular, a live
  // runtime returns before read/transform/write/validate; preserve that outcome
  // as a blocker instead of wrapping it in a false outer success.
  return { ...blockedFromEngineReport(report, classification), report };
}

/** Execute: fence -> coordination/quiesce -> re-pin -> switch -> post-verify. */
async function execute(
  options: RunStorageUpgradeOptions<HomeSnapshot>,
  classification: HomeClassification,
  target: ReturnType<typeof createHomeMigrationTarget>,
  callerPid: number,
  now: () => Date
): Promise<UpgradeResult> {
  const { home } = options;

  // 3) Admission fence — from here, new baseline CLI and Controller writers are
  // refused at the storage commit choke point. The fencing process is exempt.
  // A live foreign fence is expected coordination contention, not a generic
  // runtime failure. Return a structured blocker without removing or retrying
  // the other upgrader's fence.
  let releaseFence: (() => void) | undefined;
  try {
    releaseFence = placeUpgradeFence(home, {
      reason: "storage upgrade in progress",
      createdAt: now().toISOString(),
      ownerPid: callerPid
    });
  } catch (error) {
    if (!(error instanceof UpgradeFenceError)) throw error;
    return withClassification(
      {
        outcome: "blocked",
        stage: "coordination",
        message: `Upgrade coordination could not be acquired: ${error.message}`,
        action:
          "Another upgrade is already coordinating this Home. Wait for it to finish, then retry; "
          + "do not remove its live fence or retry blindly."
      },
      classification
    );
  }

  const externallyQuiesced = options.controllerLifecycle === "externally-quiesced";
  let controllerWasRunning = false;
  let controllerStopConfirmed = false;
  let controllerIdentity: ControllerLaunchIdentity | undefined;
  let result: UpgradeResult | undefined;
  let unexpected: unknown;
  const switchState: SwitchCommitState = { committed: false };
  try {
    if (!externallyQuiesced) {
      // Record the lifecycle fact before stopping anything. An unavailable or
      // malformed status is unknown, not "stopped"; fail closed without attempting
      // a blind stop/retry.
      const controllerStatus = options.controllerStatus
        ?? ((h: string) => defaultControllerStatus(h, options.controllerOptions));
      let status: ControllerLifecycleStatus | undefined;
      try {
        status = await controllerStatus(home);
      } catch (error) {
        result = withClassification(
          controllerLifecycleBlocker(
            "Controller status could not be verified",
            error
          ),
          classification
        );
      }
      if (result === undefined && !isControllerLifecycleStatus(status)) {
        result = withClassification(
          controllerLifecycleBlocker(
            "Controller status was malformed",
            new Error("expected a boolean running field")
          ),
          classification
        );
      }
      if (result === undefined && status!.running && !isControllerLaunchIdentity(status!.identity)) {
        result = withClassification(
          controllerLifecycleBlocker(
            "Controller launch identity could not be authenticated",
            new Error("executable/argv/version identity is unavailable")
          ),
          classification
        );
      }
      if (result === undefined && status!.running && !isPositivePid(status!.pid)) {
        result = withClassification(
          controllerLifecycleBlocker(
            "Controller PID could not be authenticated",
            new Error("a positive status PID is unavailable for fenced stop")
          ),
          classification
        );
      }
      if (result === undefined) {
        controllerWasRunning = status!.running;
        controllerIdentity = status!.running ? status!.identity : undefined;
        controllerStopConfirmed = !controllerWasRunning;
      }

      // 4) Quiesce — drain the Controller with the public stop, then require that
      // no foreign writer, no live Controller, and no unfinished runtime lifecycle
      // remain. Any unclear signal fails closed with the source unchanged. A stop
      // request is issued at most once; timeout/rejection is a structured blocker,
      // never a retry loop.
      const stopController = options.stopController
        ?? ((h: string, expectedPid: number) => defaultStopController(
          h,
          expectedPid,
          options.controllerOptions
        ));
      if (result === undefined && controllerWasRunning) {
        try {
          const expectedPid = status!.pid!;
          const stopped = await stopController(home, expectedPid);
          if (!confirmedControllerStopped(stopped, expectedPid)) {
            result = withClassification(
              controllerLifecycleBlocker(
                "Controller stop did not confirm a drained process",
                new Error(`stop did not confirm captured PID ${expectedPid} with stopped:true`)
              ),
              classification
            );
          } else {
            controllerStopConfirmed = true;
          }
        } catch (error) {
          result = withClassification(
            controllerLifecycleBlocker("Controller stop/drain failed", error),
            classification
          );
        }
      }
    } else {
      // The parent update already captured and drained the old Controller. This
      // staged child must not inspect or start one from its temporary install.
      controllerStopConfirmed = true;
    }

    if (result === undefined) {
      // Close the only admission race left by the read-only preflight. A writer
      // which acquired `.state.lock` before the fence must finish before this
      // pin; every later commit sees the fence and fails. Re-read the complete
      // offline inventory only after that boundary and before staging/switching.
      try {
        repinRevision(home);
      } catch (error) {
        result = withClassification(
          {
            outcome: "blocked",
            stage: "active-runtime",
            message:
              `The pre-fence writer window is undeterminable and could not be closed safely: ` +
              `${messageOf(error)}.`,
            action:
              "The Home was not switched. Inspect the exact storage-lock owner and retry only " +
              "after it is settled; do not remove a live lock or retry blindly."
          },
          classification
        );
      }
    }

    if (result === undefined) {
      const inventory = await readOfflineInventory(options, home);
      if (inventory.total > 0) {
        result = withClassification(
          offlineInventoryBlocker(inventory, false),
          classification
        );
      }
    }

    if (result === undefined) {
      try {
        result = executeFenced(options, classification, target, callerPid, now, switchState);
      } catch (error) {
        // Any exception after the atomic rename is a post-switch ambiguity. It
        // must not cross the generic restore path: the old Controller is unsafe
        // against a Home whose authority has already moved.
        if (switchState.committed) {
          result = withClassification(
            postSwitchAmbiguity(home, switchState.backupPath, error),
            classification
          );
        } else {
          unexpected = error;
        }
      }
    }
  } finally {
    try {
      releaseFence!();
    } catch (error) {
      if (switchState.committed && result === undefined) {
        result = withClassification(
          postSwitchAmbiguity(home, switchState.backupPath, error),
          classification
        );
      } else if (unexpected === undefined) {
        unexpected = error;
      }
    }
  }

  // Restoring the old Controller must happen after the upgrade fence is
  // released, otherwise its startup scheduler would be blocked by our own
  // fence. A thrown unexpected fault remains a throw, but the old lifecycle is
  // still restored exactly once before it escapes.
  if (unexpected !== undefined) {
    if (switchState.committed) {
      return withClassification(
        postSwitchAmbiguity(home, switchState.backupPath, unexpected),
        classification
      );
    }
    if (controllerWasRunning && controllerStopConfirmed) {
      await restoreController(home, options, unexpected, controllerIdentity);
    }
    throw unexpected;
  }
  if (result === undefined) {
    throw new Error("Storage upgrade did not produce a result.");
  }

  if (result.outcome === "upgraded") {
    const startController = options.startController
      ?? ((h: string) => defaultStartController(h, options.controllerOptions));
    if (!externallyQuiesced && controllerWasRunning) {
      try {
        // New Controller startup is deliberately after switch + post-verify.
        await startController(home);
      } catch (error) {
        // Keep the completion receipt and backup as durable evidence when the
        // storage switch is verified but the replacement Controller cannot be
        // started. The old Controller is not safe to resume on the new Home.
        return {
          ...withClassification(
            postSwitchAmbiguity(home, result.backupPath, new Error(
              `The replacement Controller could not start after the committed switch: ${messageOf(error)}`
            )),
            classification
          ),
          report: result.report
        };
      }
    }
    // No further uncertainty remains once the replacement Controller (when one
    // existed) is ready; clear the receipt only at this final boundary.
    try {
      options.postSwitchFaultHook?.("receipt-clear");
      clearUpgradeReceipt(home);
    } catch (error) {
      return {
        ...withClassification(
          postSwitchAmbiguity(home, result.backupPath, error),
          classification
        ),
        report: result.report
      };
    }
    return result;
  }

  if (
    !externallyQuiesced
    &&
    controllerWasRunning
    && controllerStopConfirmed
    && result.outcome === "blocked"
    // Once the switch committed (post-verify) or became ambiguous, the old
    // Controller is not safe to resume against this Home.
    && result.stage !== "post-verify"
    && result.stage !== "switch-ambiguous"
  ) {
    try {
      // A blocked/failed pre-switch attempt leaves the old Home authoritative;
      // restore the Controller that was running before quiesce, once and only
      // once. Ambiguous switch is excluded: its Home authority is unknown.
      await restoreController(
        home,
        options,
        new Error(result.message),
        controllerIdentity
      );
    } catch (error) {
      return {
        ...withClassification(
          {
            outcome: "blocked",
            stage: "active-runtime",
            message:
              `${result.message} The previously running Controller could not be restored: `
              + `${messageOf(error)}.`,
            action:
              "Keep the old Home quiesced and resolve the Controller startup failure; "
              + "do not resume writes until the Controller and Home are verified."
          },
          classification
        ),
        ...(result.report === undefined ? {} : { report: result.report })
      };
    }
  }
  return result;
}

/** Execute the fenced, coordinated migration after Controller quiesce. */
function executeFenced(
  options: RunStorageUpgradeOptions<HomeSnapshot>,
  classification: HomeClassification,
  target: ReturnType<typeof createHomeMigrationTarget>,
  callerPid: number,
  now: () => Date,
  switchState: SwitchCommitState
): UpgradeResult {
  const { home, registry, latest } = options;
  try {
    // The read-only drain proof, revision pin, complete-home copy, and both
    // switch renames share one sibling coordination lock with inbox publish.
    return withUpgradeCoordinationLock(home, () => {
      const quiesce = verifyQuiesced(home, callerPid);
      if (quiesce !== null) return withClassification(quiesce, classification);

      // Re-pin the final revision under the write lock, after drain, so the
      // snapshot reflects the last committed state (no check-then-migrate race).
      repinRevision(home);

      // Snapshot -> validate gate -> atomic switch + timestamped backup.
      target.discardFreshOutput();
      const report = runMigration({ registry, target, latest, mode: "execute" });
      if (report.outcome === "failed") {
        target.discardFreshOutput();
        return { ...blockedFromFailedReport(report, classification), report };
      }
      if (report.outcome === "switch-ambiguous") {
        // The switch was left partially applied. Do not write a completion
        // receipt; the interrupted switch-progress marker is the durable signal.
        return { ...blockedFromSwitchAmbiguous(report, classification), report };
      }
      if (report.outcome !== "migrated") {
        target.discardFreshOutput();
        return { ...blockedFromEngineReport(report, classification), report };
      }

      // From this line onward the old Home has moved to its backup and the new
      // Home is authoritative. Set the guard before any receipt/health work so
      // even an injected post-switch failure cannot restore the old Controller.
      switchState.committed = true;
      switchState.backupPath = report.switch.backupPath;

      // The atomic switch has COMMITTED. Keep a durable receipt until the
      // post-switch loader and (when applicable) replacement Controller both
      // succeed; this closes the activation ambiguity window.
      options.postSwitchFaultHook?.("receipt-write");
      writeUpgradeReceipt(home, {
        switched: true,
        homePath: home,
        completedAt: now().toISOString(),
        targetLayoutVersion: latest.layout,
        targetAggregateVersion: latest.aggregate,
        ...(report.switch.backupPath === undefined
          ? {}
          : { backupPath: report.switch.backupPath })
      });

      options.postSwitchFaultHook?.("post-verify");
      const postVerify = postSwitchHealthCheck(home);
      if (postVerify !== null) {
        return {
          ...withClassification(
            postSwitchAmbiguity(home, report.switch.backupPath, new Error(postVerify.message)),
            classification
          ),
          report
        };
      }
      return {
        outcome: "upgraded",
        classification,
        report,
        ...(report.switch.backupPath === undefined
          ? {}
          : { backupPath: report.switch.backupPath })
      };
    });
  } catch (error) {
    if (!(error instanceof UpgradeFenceError)) throw error;
    return withClassification(
      {
        outcome: "blocked",
        stage: "coordination",
        message: `Upgrade coordination could not be acquired: ${error.message}`,
        action:
          "Wait for the other writer or switch recovery to finish, then retry; "
          + "the authoritative Home was not switched by this attempt."
      },
      classification
    );
  }
}

/**
 * Verify the Home is quiesced after the Controller drain. Returns `null` when
 * clear, or a fail-closed blocker when any live runtime or unfinished lifecycle
 * obligation remains. Never kills anything.
 *
 * The source may still be at an older schema here, so it reads runtime signals
 * and the raw `state.json` mailboxes directly rather than through the
 * version-gated store.
 */
function verifyQuiesced(home: string, callerPid: number): UpgradeBlocker | null {
  const signals = inspectHomeRuntime(home, callerPid);
  if (homeRuntimeIsActive(signals)) {
    return {
      outcome: "blocked",
      stage: "active-runtime",
      message: `Cannot upgrade: ${describeActiveRuntime(signals)}`,
      action:
        "Stop all Yui activity for this Home (and clear any stale .state.lock / "
        + "runtime/controller.json only after confirming no process owns it), then retry."
    };
  }

  // Unfinished runtime lifecycle obligations block. This is TWO independent
  // durable lanes (per task-1 / message-8 §3, either non-empty fails closed):
  //  1. the aggregate `state.json` mailboxes (runtime lifecycle lanes), and
  //  2. the DURABLE runtime inbox `runtime/inbox/*` — authoritative, not-yet-
  //     applied native-hook events. A healthy Controller drains the inbox, but
  //     the no-Controller / stale-event path (fully supported) reaches here with
  //     inbox entries still on disk, and those must not be silently discarded by
  //     an atomic switch. We prove the inbox empty READ-ONLY (never acknowledging
  //     or quarantining as part of the check — that would mutate the source).
  const pendingRuntime = countPendingRuntimeMailboxes(home);
  const pendingInbox = countPendingDurableInbox(home);
  if (pendingRuntime > 0 || pendingInbox > 0) {
    const parts: string[] = [];
    if (pendingRuntime > 0) parts.push(`${pendingRuntime} pending mailbox(es)`);
    if (pendingInbox > 0) parts.push(`${pendingInbox} pending durable inbox entr(ies)`);
    return {
      outcome: "blocked",
      stage: "drain-incomplete",
      message: `Runtime lifecycle work is not drained (${parts.join("; ")}).`,
      action:
        "Let the Controller finish draining the runtime inbox and mailboxes (or start it so it "
        + "can), then retry the upgrade. The authoritative Home is unchanged."
    };
  }
  return null;
}

/**
 * Count runtime lifecycle mailboxes with pending/processing work, read directly
 * from the raw `state.json` so it works on a not-yet-migrated source. A mailbox
 * is a runtime lifecycle lane when its target kind is `role-runtime` or
 * `global-role-runtime`; it has work when `pending` or `processing` is set.
 */
function countPendingRuntimeMailboxes(home: string): number {
  let raw: string;
  try {
    raw = readFileSync(join(home, STORAGE_STATE_FILE), "utf8");
  } catch {
    return 0;
  }
  let mailboxes: Record<string, unknown>;
  try {
    const state = JSON.parse(raw) as { mailboxes?: unknown };
    if (typeof state.mailboxes !== "object" || state.mailboxes === null) return 0;
    mailboxes = state.mailboxes as Record<string, unknown>;
  } catch {
    return 0;
  }
  let count = 0;
  for (const value of Object.values(mailboxes)) {
    if (typeof value !== "object" || value === null) continue;
    const mailbox = value as {
      target?: { kind?: unknown };
      pending?: unknown;
      processing?: unknown;
    };
    const kind = mailbox.target?.kind;
    const isRuntimeLane = kind === "role-runtime" || kind === "global-role-runtime";
    const hasWork = mailbox.pending !== null || mailbox.processing !== null;
    if (isRuntimeLane && hasWork) count += 1;
  }
  return count;
}

/**
 * Count pending entries in the DURABLE runtime inbox, READ-ONLY (R3-F4). This
 * proves the inbox is drained before an atomic switch replaces the whole Home,
 * so authoritative not-yet-applied native-hook events are never silently lost.
 *
 * It deliberately does NOT go through `FileRuntimeEventInbox.list()`, which
 * quarantines malformed entries as a side effect — the quiesce check must not
 * mutate the source. Instead it counts, purely by directory listing:
 *  - any committed event file (`*.json`) in `runtime/inbox`,
 *  - any in-progress temporary write (`.<id>.tmp-*`) in `runtime/inbox`, and
 *  - any quarantined-but-unresolved entry under `runtime/inbox-invalid`.
 * Any of these being non-zero means lifecycle work is not fully drained. A
 * missing inbox directory (or an unreadable one) counts as zero pending here for
 * the inbox itself, but an unreadable directory is surfaced as a conservative
 * single pending entry so an undeterminable inbox fails closed rather than open.
 */
function countPendingDurableInbox(home: string): number {
  const inboxDir = join(home, "runtime", "inbox");
  const invalidDir = join(home, "runtime", "inbox-invalid");
  let count = 0;
  count += countInboxDirectoryEntries(inboxDir, /* countTemporary */ true);
  count += countInboxDirectoryEntries(invalidDir, /* countTemporary */ true);
  return count;
}

/**
 * Count durable entries in one inbox directory. A `.json` file or (when
 * `countTemporary`) a `.tmp-` in-progress write is pending. Returns 0 when the
 * directory is provably absent; returns 1 (fail-closed) when it exists but cannot
 * be listed, so an undeterminable inbox never reads as "empty".
 */
function countInboxDirectoryEntries(directory: string, countTemporary: boolean): number {
  let entries: string[];
  try {
    entries = readdirSync(directory);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return 0;
    return 1; // present but unreadable: fail closed.
  }
  let count = 0;
  for (const name of entries) {
    if (name.endsWith(".json")) count += 1;
    else if (countTemporary && name.includes(".tmp-")) count += 1;
    else if (!name.startsWith(".")) count += 1; // any other real entry (e.g. quarantined copies).
  }
  return count;
}

/**
 * Re-read and pin the committed revision under the write lock, after drain. It
 * takes the same lock the store uses (via {@link withStorageWriteLock}, which is
 * not version-gated) and reads the committed revision without mutating, so it
 * serializes the snapshot against the last committed write without a store.
 */
function repinRevision(home: string): number {
  return withStorageWriteLock(home, () => readCommittedRevision(home));
}

function readCommittedRevision(home: string): number {
  try {
    const raw = readFileSync(join(home, STORAGE_STATE_FILE), "utf8");
    const value = JSON.parse(raw) as { revision?: unknown };
    return Number.isInteger(value.revision) ? (value.revision as number) : 0;
  } catch {
    return 0;
  }
}

/** Post-switch health check: a fresh loader must parse the promoted Home. */
function postSwitchHealthCheck(home: string): UpgradeBlocker | null {
  try {
    const store = new FileTaskStore(home);
    store.getConfig();
    store.listTasks();
    store.listProjects();
    store.listConfiguredAgents();
    store.listWorkMailboxes();
    return null;
  } catch (error) {
    return {
      outcome: "blocked",
      stage: "post-verify",
      message:
        `Post-switch health check failed: ${error instanceof Error ? error.message : String(error)}`,
      action:
        "The migrated Home did not load. Restore the timestamped backup to recover the "
        + "original Home; do not resume writes until the backup is restored."
    };
  }
}

function blockedFromFailedReport(
  report: Extract<MigrationReport, { outcome: "failed" }>,
  classification: HomeClassification
): Extract<UpgradeResult, { outcome: "blocked" }> {
  const stage: UpgradeBlockerStage = report.stage === "switch" ? "switch" : "validate";
  return withClassification(
    {
      outcome: "blocked",
      stage,
      message: `Migration failed at ${report.stage}: ${report.error}`,
      action:
        "The source Home is unchanged. Delete any staged output and retry; if it recurs, "
        + "restore from backup and report the failure."
    },
    classification
  );
}

/**
 * Build a blocker for a partially-applied, ambiguous switch: the original was
 * moved to the backup but neither the promotion nor its rollback completed. This
 * is reported at the `switch` stage with the exact backup-restore command and an
 * explicit statement that the Home is NOT unchanged (P1-4).
 */
function blockedFromSwitchAmbiguous(
  report: Extract<MigrationReport, { outcome: "switch-ambiguous" }>,
  classification: HomeClassification
): Extract<UpgradeResult, { outcome: "blocked" }> {
  return withClassification(
    {
      outcome: "blocked",
      stage: "switch-ambiguous",
      message: `Storage switch is AMBIGUOUS and partially applied: ${report.error}`,
      action:
        `Do NOT assume the Home is unchanged. The original Home is at ${report.backupPath}; `
        + `restore it to recover: mv "${report.backupPath}" "${report.homePath}". The interrupted `
        + `switch marker "${switchProgressPath(report.homePath)}" records this ambiguity; verify `
        + `with "yui doctor" after restoring.`
    },
    classification
  );
}

/**
 * A structured blocker for failures after the atomic Home switch. The receipt
 * and progress marker are named explicitly so an operator can reconcile the
 * committed Home; the generic old-Controller restore path must never run here.
 */
function postSwitchAmbiguity(
  home: string,
  backupPath: string | undefined,
  error: unknown
): UpgradeBlocker {
  const receiptPath = upgradeReceiptPath(home);
  const progressPath = switchProgressPath(home);
  const backup = backupPath === undefined ? "the timestamped Home backup" : `backup ${backupPath}`;
  return {
    outcome: "blocked",
    stage: "post-verify",
    switchCommitted: true,
    ...(backupPath === undefined ? {} : { backupPath }),
    recoveryEvidence: {
      ...(backupPath === undefined ? {} : { backupPath }),
      receiptPath,
      progressPath
    },
    message:
      `The storage switch committed, but post-switch completion could not be confirmed: `
      + `${messageOf(error)}. The old Controller was not restored.`,
    action:
      `Do not start the old Controller against the migrated Home. Inspect ${backup}, receipt `
      + `"${receiptPath}", and switch-progress marker "${progressPath}"; verify the Home, then `
      + (backupPath === undefined
        ? "complete or explicitly recover the switch before resuming writes."
        : `restore the backup explicitly with mv "${backupPath}" "${home}" if verification fails.`)
  };
}

function blockedFromEngineReport(
  report: MigrationReport,
  classification: HomeClassification
): Extract<UpgradeResult, { outcome: "blocked" }> {
  return withClassification(
    {
      outcome: "blocked",
      stage: report.outcome === "active-runtime" ? "active-runtime" : "missing-step",
      message: describeReport(report),
      action: "Resolve the reported condition and retry the upgrade."
    },
    classification
  );
}

function withClassification(
  blocker: UpgradeBlocker,
  classification: HomeClassification
): Extract<UpgradeResult, { outcome: "blocked" }> {
  return { ...blocker, classification };
}

async function defaultStopController(
  home: string,
  expectedPid: number,
  controllerOptions: FileControllerClientOptions | undefined
): Promise<ControllerStopResult> {
  return stopFileTaskController(home, {
    ...(controllerOptions ?? {}),
    expectedPid
  });
}

async function defaultStartController(
  home: string,
  controllerOptions: FileControllerClientOptions | undefined
): Promise<unknown> {
  return ensureFileTaskController(home, controllerOptions ?? {});
}

async function defaultControllerStatus(
  home: string,
  controllerOptions: FileControllerClientOptions | undefined
): Promise<ControllerLifecycleStatus> {
  const call = controllerOptions?.call ?? callController;
  let raw: unknown;
  try {
    raw = await call(home, "controller.status", {});
  } catch (error) {
    // ENOENT/CONTROLLER_NOT_RUNNING is the only definitive stopped fact. A
    // transport timeout or invalid discovery is unknown-active and must block;
    // never infer a stopped Controller from a stale or malformed artifact.
    if (controllerErrorCode(error) === "CONTROLLER_NOT_RUNNING") {
      return { running: false };
    }
    if (
      controllerOptions?.call === undefined
      && controllerErrorCode(error) === "CONTROLLER_DISCOVERY_INVALID"
    ) {
      return controllerStatusFromRuntime(home, error);
    }
    throw error;
  }
  if (!isRecord(raw) || typeof raw.running !== "boolean") {
    throw new Error("Controller status response is invalid.");
  }
  const identity = raw.running
    ? await authenticatedControllerIdentity(home, call, raw)
    : undefined;
  return {
    running: raw.running,
    ...(identity === undefined ? {} : { identity }),
    ...(isPositivePid(raw.pid) ? { pid: raw.pid } : {})
  };
}

function controllerStatusFromRuntime(
  home: string,
  cause: unknown
): ControllerLifecycleStatus {
  const runtime = inspectHomeRuntime(home);
  // A malformed/stale artifact is accepted as stopped only when the
  // layout-agnostic runtime probe proves its named process is dead. Unknown or
  // live discovery remains unknown-active; it never receives an inferred
  // executable/argv/version identity.
  if (runtime.liveController === null) return { running: false };
  throw new Error(
    `Controller runtime discovery could not be resolved: ${messageOf(cause)}`,
    { cause }
  );
}

function confirmedControllerStopped(
  value: void | ControllerStopResult,
  expectedPid: number
): boolean {
  // Existing test seams historically returned void after a successful drain;
  // retain that narrow compatibility while requiring explicit confirmation for
  // any structured result.
  return value === undefined || (
    isRecord(value)
    && value.stopped === true
    && value.pid === expectedPid
  );
}

function isControllerLifecycleStatus(value: unknown): value is ControllerLifecycleStatus {
  return isRecord(value) && typeof value.running === "boolean";
}

function controllerLifecycleBlocker(
  prefix: string,
  error: unknown
): UpgradeBlocker {
  return {
    outcome: "blocked",
    stage: "active-runtime",
    message: `${prefix}: ${messageOf(error)}.`,
    action:
      "The Controller may still be active or draining. Do not retry stop blindly; "
      + "inspect the Controller and runtime, then retry once the Home is quiesced."
  };
}

async function restoreController(
  home: string,
  options: RunStorageUpgradeOptions<HomeSnapshot>,
  cause: unknown,
  identity: ControllerLaunchIdentity | undefined
): Promise<void> {
  if (identity === undefined) {
    throw new Error(
      "The previously running Controller identity was not captured; refusing to restore with a new executable.",
      { cause }
    );
  }
  const restore = options.restoreController
    ?? ((h: string, i: ControllerLaunchIdentity) => defaultRestoreController(
      h,
      i,
      options.controllerOptions
    ));
  try {
    await restore(home, identity);
  } catch (error) {
    throw new Error(
      `Storage upgrade failed and the previously running Controller could not be restored: `
        + `${messageOf(error)}`,
      { cause }
    );
  }
}

async function authenticatedControllerIdentity(
  home: string,
  call: typeof callController,
  status: Record<string, unknown>
): Promise<ControllerLaunchIdentity> {
  const inline = status.identity;
  if (isControllerLaunchIdentity(inline)) return inline;
  const raw = await call(home, "controller.identity", {});
  if (!isControllerLaunchIdentity(raw)) {
    throw new Error(
      "Authenticated Controller identity is unavailable; refusing to stop an un-restorable process."
    );
  }
  if (typeof status.version === "string" && raw.version !== status.version) {
    throw new Error(
      `Controller identity version ${raw.version} does not match status version ${status.version}.`
    );
  }
  return raw;
}

/** Start the exact captured process command and await an authenticated readiness proof. */
async function defaultRestoreController(
  home: string,
  identity: ControllerLaunchIdentity,
  controllerOptions: FileControllerClientOptions | undefined
): Promise<void> {
  await ensureFileTaskControllerIdentity(home, identity, {
    ...(controllerOptions ?? {}),
    spawnController: (_restoredHome, environment) => {
      const child = spawn(identity.executablePath, [...identity.args], {
        env: environment,
        detached: true,
        stdio: "ignore"
      });
      child.unref();
    }
  });
}

function controllerErrorCode(error: unknown): string | undefined {
  return isRecord(error) && typeof error.code === "string" ? error.code : undefined;
}

function isPositivePid(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function isControllerLaunchIdentity(value: unknown): value is ControllerLaunchIdentity {
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

/** Read the current fence for a Home (re-exported for command wiring). */
export { readUpgradeFence, clearUpgradeFence };
/** Read/locate the completion receipt (re-exported for update orchestration). */
export {
  readUpgradeReceipt,
  correlateUpgradeReceipt,
  upgradeReceiptPath
} from "./upgradeReceipt.js";
