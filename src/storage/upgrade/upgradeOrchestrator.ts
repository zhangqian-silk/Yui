/**
 * The storage upgrade orchestrator.
 *
 * This composes the generic migration engine (`../migration`) with the real
 * Home-bound target and the admission fence into the user-facing `yui upgrade`
 * and the storage half of `yui update`:
 *
 *   preflight (classify, read-only)
 *     -> plan (delegated to the engine; missing/future step = fail-closed)
 *     -> [execute] admission fence  (new writers refused)
 *     -> [execute] quiesce          (controller.stop drains; then verify no
 *                                     foreign writer / no unfinished lifecycle)
 *     -> [execute] re-pin revision  (under the write lock, after drain)
 *     -> snapshot -> validate gate -> [execute] atomic switch + backup
 *     -> [execute] post-switch health check (fresh FileTaskStore loader)
 *
 * `--dry-run` runs preflight + plan + the staged validation gate, then discards
 * the staged output and never switches. Every failure reports a precise blocker
 * stage and a recovery action, and never leaves the authoritative Home switched.
 *
 * Quiesce uses only explicit, deterministic signals — the public
 * `controller.stop`/shutdownAndDrain, the real `.state.lock`, unfinished runtime
 * lifecycle mailboxes — never a broad process kill and never a TTL/idle
 * heuristic. Any signal that is not clear fails closed and leaves the original
 * authoritative input byte-for-byte unchanged.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  describeReport,
  runMigration,
  type MigrationRegistry,
  type MigrationReport,
  type StorageVersionState
} from "../migration/index.js";
import {
  stopFileTaskController,
  type FileControllerClientOptions
} from "../../controller/clientRuntime.js";
import { FileTaskStore, STORAGE_STATE_FILE, withStorageWriteLock } from "../taskStore.js";
import {
  clearUpgradeFence,
  placeUpgradeFence,
  readUpgradeFence
} from "../upgradeFence.js";
import {
  clearUpgradeReceipt,
  writeUpgradeReceipt
} from "./upgradeReceipt.js";
import {
  classifyHome,
  type HomeClassification
} from "./homeClassification.js";
import {
  createHomeMigrationTarget,
  describeActiveRuntime,
  homeRuntimeIsActive,
  inspectHomeRuntime,
  type HomeSnapshot
} from "./homeMigrationTarget.js";

/** The precise stage at which an upgrade was blocked or failed. */
export type UpgradeBlockerStage =
  | "missing-step"
  | "future-version"
  | "corruption"
  | "active-runtime"
  | "drain-incomplete"
  | "validate"
  | "switch"
  | "post-verify";

/** A fail-closed blocker before its owning classification is attached. */
type UpgradeBlocker = Readonly<{
  outcome: "blocked";
  stage: UpgradeBlockerStage;
  message: string;
  action: string;
}>;

/** The structured result of an upgrade attempt. */
export type UpgradeResult = Readonly<
  | {
      outcome: "already-current";
      classification: HomeClassification;
      report: MigrationReport;
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
  mode: "dry-run" | "execute";
  now?: () => Date;
  callerPid?: number;
  /** Overrides for the Controller stop/drain client (tests inject fakes). */
  controllerOptions?: FileControllerClientOptions;
  /** Test seam: stop+drain the Controller. Defaults to the real client. */
  stopController?: (home: string) => Promise<void>;
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

  const target = createHomeMigrationTarget({ home, latest, now, callerPid });

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

  // verdict === "MIGRATABLE": a complete step path exists.
  if (mode === "dry-run") {
    return dryRun(options, classification, target);
  }
  return execute(options, classification, target, callerPid, now);
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
  if (report.outcome === "failed") {
    return { ...blockedFromFailedReport(report, classification), report };
  }
  return { outcome: "dry-run", classification, report };
}

/** Execute: fence -> quiesce -> re-pin -> switch -> post-verify. */
async function execute(
  options: RunStorageUpgradeOptions<HomeSnapshot>,
  classification: HomeClassification,
  target: ReturnType<typeof createHomeMigrationTarget>,
  callerPid: number,
  now: () => Date
): Promise<UpgradeResult> {
  const { home, registry, latest } = options;

  // 3) Admission fence — from here, new baseline CLI and Controller writers are
  // refused at the storage commit choke point. The fencing process is exempt.
  const releaseFence = placeUpgradeFence(home, {
    reason: "storage upgrade in progress",
    createdAt: now().toISOString(),
    ownerPid: callerPid
  });

  try {
    // 4) Quiesce — drain the Controller with the public stop, then require that
    // no foreign writer, no live Controller, and no unfinished runtime lifecycle
    // remain. Any unclear signal fails closed with the source unchanged.
    const stopController = options.stopController
      ?? ((h: string) => defaultStopController(h, options.controllerOptions));
    await stopController(home);

    const quiesce = verifyQuiesced(home, callerPid);
    if (quiesce !== null) {
      target.discardFreshOutput();
      return withClassification(quiesce, classification);
    }

    // 5) Re-pin the final revision under the write lock, after drain, so the
    // snapshot reflects the last committed state (no check-then-migrate race).
    // The fence exempts this process, so the lock is obtainable.
    repinRevision(home);

    // 6) Snapshot -> validate gate -> atomic switch + timestamped backup.
    target.discardFreshOutput();
    const report = runMigration({ registry, target, latest, mode: "execute" });
    if (report.outcome === "failed") {
      target.discardFreshOutput();
      return { ...blockedFromFailedReport(report, classification), report };
    }
    if (report.outcome !== "migrated") {
      // Blocked/active-runtime detected inside the engine: never switched.
      target.discardFreshOutput();
      return { ...blockedFromEngineReport(report, classification), report };
    }

    // The atomic switch has COMMITTED. Drop a durable, out-of-band receipt before
    // doing anything else, so that if this process is killed before it can report
    // success (SIGTERM/OOM after switch), a later reader can still prove the
    // switch happened and locate the backup — closing the activation-ambiguity
    // gap (P1-2). The receipt is cleared only on a clean, verified return.
    writeUpgradeReceipt(home, {
      switched: true,
      completedAt: now().toISOString(),
      ...(report.switch.backupPath === undefined
        ? {}
        : { backupPath: report.switch.backupPath })
    });

    // 7) Post-switch health check with a fresh loader over the promoted Home.
    const postVerify = postSwitchHealthCheck(home);
    if (postVerify !== null) {
      // Switch committed but the migrated Home did not load: keep the receipt so
      // the ambiguity is recorded, and report the backup-based manual recovery.
      return { ...withClassification(postVerify, classification), report };
    }

    // Fully verified: the migrated Home loads. Clear the receipt — there is no
    // ambiguity to record.
    clearUpgradeReceipt(home);
    return {
      outcome: "upgraded",
      classification,
      report,
      ...(report.switch.backupPath === undefined
        ? {}
        : { backupPath: report.switch.backupPath })
    };
  } finally {
    releaseFence();
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

  // Unfinished runtime lifecycle obligations (inbox/mailbox not drained) block.
  const pendingRuntime = countPendingRuntimeMailboxes(home);
  if (pendingRuntime > 0) {
    return {
      outcome: "blocked",
      stage: "drain-incomplete",
      message: `Runtime lifecycle work is not drained (${pendingRuntime} pending mailbox(es)).`,
      action: "Let the Controller finish draining, then retry the upgrade."
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
): UpgradeResult {
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

function blockedFromEngineReport(
  report: MigrationReport,
  classification: HomeClassification
): UpgradeResult {
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
  controllerOptions: FileControllerClientOptions | undefined
): Promise<void> {
  await stopFileTaskController(home, controllerOptions ?? {});
}

/** Read the current fence for a Home (re-exported for command wiring). */
export { readUpgradeFence, clearUpgradeFence };
/** Read/locate the completion receipt (re-exported for update orchestration). */
export { readUpgradeReceipt, upgradeReceiptPath } from "./upgradeReceipt.js";
