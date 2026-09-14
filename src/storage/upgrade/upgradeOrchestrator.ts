import {
  join
} from "node:path";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  rmSync
} from "node:fs";

import Database from "better-sqlite3";
import {
  inspectAgentHostCompatibility, describeAgentHostUpgradeBlockers, type AgentHostUpgradeBlocker
} from "../../runtime/agentHostCompatibility.js";

import {
  RUNTIME_OBSERVATION_TASK_EVENT,
  createRuntimeObservation,
  type RuntimeObservation
} from "../../runtime/runtimeObservation.js";
import {
  RUNTIME_PROCESS_EXIT_TASK_EVENT,
  validateRuntimeProcessExitObservation,
  type RuntimeProcessExitObservation
} from "../../runtime/processExitObservation.js";
import { validateAgentProfile } from "../../profile/agentProfile.js";
import { validateRoleSessionSet } from "../../executor/agentExecutor.js";
import { validateReviewRound } from "../../review/reviewRound.js";
import { validateRun } from "../../agentRun/agentRun.js";
import { validateDurableJob } from "../../job/durableJob.js";
import { validateWorkItem } from "../../workItem/workItem.js";
import { SqliteTaskStore } from "../sqliteStore.js";
import { storageBackupRoot } from "../homeLayout.js";
import {
  preflightUnifyHomeLayout,
  type UnifyHomePreflightBlocker
} from "../migrations/unifyHomeLayout.js";
import {
  preflightCollapseWorktreeLayout,
  type CollapseWorktreePreflightBlocker
} from "../migrations/collapseWorktreeLayout.js";
import { preflightNotificationOnlyWakes } from "../migrations/notificationOnlyWakes.js";
import {
  migrateSqliteSchema,
  storageMigrationPlan,
  type StorageMigrationStep
} from "../sqliteSchema.js";
import {
  CURRENT_DATABASE_FILENAME,
  inspectStorageSchema,
  type StorageSchemaState
} from "../storageSchema.js";
import {
  CURRENT_STORAGE_VERSION,
  MIN_SUPPORTED_STORAGE_VERSION
} from "../storageVersions.js";

export type HomeClassification = Readonly<{
  classification:
    | Readonly<{ verdict: "USABLE"; status: "current" }>
    | Readonly<{ verdict: "MIGRATABLE"; status: "migration-ready" }>
    | Readonly<{
        verdict: "NEEDS_NEW_VERSION";
        status: "unsupported";
        blocker: Readonly<{
          reason: "future-version" | "below-minimum";
          found: number;
          current: number;
          minimum: number;
          message: string;
          action: string;
        }>;
      }>
    | Readonly<{ verdict: "CORRUPTED"; status: "unsupported"; detail: string }>;
  storageVersion?: number;
  currentStorageVersion: number;
  minimumSupportedStorageVersion: number;
  uninitialized?: true;
}>;

export type StorageUpgradeReport = Readonly<{
  outcome: "already-current" | "upgrade-plan" | "upgraded";
  mode: "dry-run" | "execute";
  sourceVersion: number;
  targetVersion: number;
  steps: readonly StorageMigrationStep[];
  backupPath?: string;
}>;

export type UpgradeBlockerStage = "uninitialized" | "unsupported" | "corruption" | "in-flight" | "host-compatibility";

/**
 * A structured pre-migration blocker surfaced through the `blocked` result. Its
 * JSON shape is compatible with the updater's blocker contract (`reason` is the
 * field the updater preserves); `detail` carries the same operator-facing text
 * the migration would throw, and is also folded into the human `message`.
 */
export type UpgradePreflightBlocker = Readonly<{ reason: string; detail: string }>;

export type UpgradeResult = Readonly<
  | {
      outcome: "already-current";
      classification: HomeClassification;
      report: StorageUpgradeReport;
    }
  | {
      outcome: "upgrade-plan";
      classification: HomeClassification;
      report: StorageUpgradeReport;
    }
  | {
      outcome: "upgraded";
      classification: HomeClassification;
      report: StorageUpgradeReport;
    }
  | {
      outcome: "update-preflight";
      status: "already-current" | "migration-ready";
      stepCount: number;
      steps: readonly StorageMigrationStep[];
      classification: HomeClassification;
    }
  | {
      outcome: "blocked";
      stage: UpgradeBlockerStage;
      message: string;
      action: string;
      blockers?: readonly UpgradePreflightBlocker[];
      classification: HomeClassification;
      sceneUnchanged: true;
      hosts?: readonly AgentHostUpgradeBlocker[];
    }
  | {
      outcome: "failed";
      stage: "backup" | "migration";
      message: string;
      action: string;
      backupPath?: string;
      classification: HomeClassification;
      sceneUnchanged: boolean;
    }
>;

export type RunStorageUpgradeOptions = Readonly<{
  home: string;
  mode: "dry-run" | "execute" | "update-preflight";
  now?: Date;
}>;

/**
 * Upgrade one valid Home through the complete linear migration chain.
 *
 * Supported earlier versions are readable only here. Ordinary stores still
 * admit exactly {@link CURRENT_STORAGE_VERSION}; no old-shape normalizer or
 * dual read path enters runtime code. Execute mode is an offline primitive:
 * its caller must own the maintenance fence and keep the Controller quiesced
 * for the whole backup, migration, and validation interval.
 */
export async function runStorageUpgrade(options: RunStorageUpgradeOptions): Promise<UpgradeResult> {
  const state = inspectStorageSchema(options.home);
  if (state.status === "uninitialized") {
    return blocked(
      { ...corruptedClassification("Storage is not initialized."), uninitialized: true },
      "uninitialized",
      "Yui storage is not initialized for this Home.",
      "Run `yui setup` with a new Home."
    );
  }
  if (state.status === "invalid") {
    return blocked(
      corruptedClassification(state.detail),
      "corruption",
      `Storage is invalid: ${state.detail}`,
      "Preserve this Home for diagnosis and restore it from a known-good backup."
    );
  }
  if (state.status === "unsupported") {
    const classification = unsupportedClassification(state);
    return blocked(
      classification,
      "unsupported",
      classification.classification.verdict === "NEEDS_NEW_VERSION"
        ? classification.classification.blocker.message
        : "Storage is unsupported.",
      classification.classification.verdict === "NEEDS_NEW_VERSION"
        ? classification.classification.blocker.action
        : "Use a compatible Yui release."
    );
  }

  const incompatibleHosts = await inspectAgentHostCompatibility(options.home);
  if (incompatibleHosts.length > 0) {
    return {
      ...blocked(
        state.status === "current" ? currentClassification() : migratableClassification(state.currentVersion),
        "host-compatibility",
        `Existing Agent Hosts cannot safely use the target Controller/storage:\n${describeAgentHostUpgradeBlockers(incompatibleHosts)}`,
        "Keep the current Controller, Home and Host processes unchanged. Inspect the named Sessions and original pending "
          + "inputs/results; let current work settle, then use explicitly authorized Session replacement/cleanup at a safe "
          + "boundary before retrying the upgrade. This target cannot hot-patch legacy Host memory."
      ),
      hosts: incompatibleHosts
    };
  }

  if (state.status === "current") {
    try {
      validateCurrentStore(options.home);
    } catch (error) {
      return blocked(
        corruptedClassification(messageOf(error)),
        "corruption",
        `Current storage validation failed: ${messageOf(error)}`,
        "Preserve this Home for diagnosis and restore it from a known-good backup."
      );
    }
    const classification = currentClassification();
    if (options.mode === "update-preflight") {
      return {
        outcome: "update-preflight",
        status: "already-current",
        stepCount: 0,
        steps: [],
        classification
      };
    }
    return {
      outcome: "already-current",
      classification,
      report: {
        outcome: "already-current",
        mode: options.mode,
        sourceVersion: CURRENT_STORAGE_VERSION,
        targetVersion: CURRENT_STORAGE_VERSION,
        steps: []
      }
    };
  }

  const plan = storageMigrationPlan(state.currentVersion);
  if (plan === null) {
    return blocked(
      corruptedClassification(
        `No complete migration path exists from ${state.currentVersion} `
          + `to ${CURRENT_STORAGE_VERSION}.`
      ),
      "corruption",
      "The storage migration registry is incomplete.",
      "Install a Yui release that carries the complete migration chain."
    );
  }
  const classification = migratableClassification(state.currentVersion);

  // Genuine pre-migration safety check, shared by ALL migrating modes. The
  // unify-home data migration (18->19) physically relocates on-disk trees and
  // rewrites live launch pointers, so before any mode proceeds we run its READ-
  // ONLY preflight and refuse up front on the same conditions the migration would
  // throw on inside the apply transaction: a queued/running Job bound under a
  // relocating root, or a conflicting relocation target. The migration is applied
  // offline (after the operator has stopped this Home's writers), so the preflight
  // does not scan for live processes. Surfacing these here — before the Controller
  // is stopped or a backup is taken — is what makes `--dry-run` and the updater's
  // `--update-preflight` a genuine readiness signal rather than a mere list of
  // schema steps, while the in-transaction checks remain the authoritative guard
  // against anything that starts after this point.
  const migrationBlocked = preflightMigrationBlockers(options.home, plan, classification);
  if (migrationBlocked !== null) return migrationBlocked;

  if (options.mode === "update-preflight") {
    return {
      outcome: "update-preflight",
      status: "migration-ready",
      stepCount: plan.length,
      steps: plan,
      classification
    };
  }
  if (options.mode === "dry-run") {
    return {
      outcome: "upgrade-plan",
      classification,
      report: {
        outcome: "upgrade-plan",
        mode: "dry-run",
        sourceVersion: state.currentVersion,
        targetVersion: CURRENT_STORAGE_VERSION,
        steps: plan
      }
    };
  }

  let backupPath: string;
  try {
    backupPath = await createDatabaseBackup(
      options.home,
      state.currentVersion,
      options.now ?? new Date()
    );
  } catch (error) {
    return {
      outcome: "failed",
      stage: "backup",
      message: `Storage backup failed: ${messageOf(error)}`,
      action:
        "Storage was not modified. Resolve the backup path, permissions, or free-space problem "
        + "and rerun `yui upgrade`.",
      classification,
      sceneUnchanged: true
    };
  }
  let migrationCommitted = false;
  try {
    const database = new Database(join(options.home, CURRENT_DATABASE_FILENAME));
    try {
      database.pragma("journal_mode = WAL");
      database.pragma("synchronous = FULL");
      database.pragma("foreign_keys = ON");
      database.pragma("busy_timeout = 5000");
      migrateSqliteSchema(database, { mode: "apply" });
      migrationCommitted = true;
    } finally {
      database.close();
    }
    validateCurrentStore(options.home);
    rmSync(join(options.home, "schema.json"), { force: true });
  } catch (error) {
    const restoration = migrationCommitted
      ? tryRestoreDatabaseBackup(options.home, backupPath)
      : { restored: true as const };
    return {
      outcome: "failed",
      stage: "migration",
      message: `Storage migration failed: ${messageOf(error)}`,
      action: restoration.restored
        ? "The original database was restored from the timestamped backup. "
          + "Resolve the reported problem and rerun `yui upgrade`."
        : "Automatic restore also failed. Keep the Home quiesced and restore "
          + `${backupPath} manually before retrying. Restore error: ${restoration.error}`,
      backupPath,
      classification,
      sceneUnchanged: restoration.restored
    };
  }

  const finalState = inspectStorageSchema(options.home);
  if (finalState.status !== "current") {
    const restoration = tryRestoreDatabaseBackup(options.home, backupPath);
    return {
      outcome: "failed",
      stage: "migration",
      message: `Storage migration did not reach version ${CURRENT_STORAGE_VERSION}.`,
      action: restoration.restored
        ? "The original database was restored from the timestamped backup. "
          + "Inspect the migration registry before retrying."
        : "Automatic restore also failed. Keep the Home quiesced and restore "
          + `${backupPath} manually before retrying. Restore error: ${restoration.error}`,
      backupPath,
      classification,
      sceneUnchanged: restoration.restored
    };
  }
  return {
    outcome: "upgraded",
    classification: currentClassification(),
    report: {
      outcome: "upgraded",
      mode: "execute",
      sourceVersion: state.currentVersion,
      targetVersion: CURRENT_STORAGE_VERSION,
      steps: plan,
      backupPath
    }
  };
}

function validateCurrentStore(home: string): void {
  const store = new SqliteTaskStore(home);
  try {
    store.getConfig();
    for (const profile of store.listAgentProfiles()) validateAgentProfile(profile);
    for (const sessions of store.listGlobalRoleSessionSets()) {
      validateRoleSessionSet(sessions);
    }
    for (const owner of store.listSessionOwners()) {
      if (owner.schemaVersion !== 2 || Object.hasOwn(owner, "launchId")) {
        throw new Error("Session owner runtime identity is invalid.");
      }
    }
    for (const taskId of store.listTasks().map(({ id }) => id)) {
      for (const job of store.listDurableJobs(taskId)) validateDurableJob(job);
      for (const item of store.listWorkItems(taskId)) validateWorkItem(item);
      for (const round of store.listReviewRounds(taskId)) validateReviewRound(round);
      for (const run of store.listRuns(taskId)) validateRun(run);
      for (const sessions of store.listRoleSessionSets(taskId)) {
        validateRoleSessionSet(sessions);
      }
      for (const event of store.listEvents(taskId)) {
        if (event.type === RUNTIME_OBSERVATION_TASK_EVENT) {
          createRuntimeObservation(
            JSON.parse(event.payload.observation ?? "") as RuntimeObservation
          );
        } else if (event.type === RUNTIME_PROCESS_EXIT_TASK_EVENT) {
          validateRuntimeProcessExitObservation(
            JSON.parse(event.payload.observation ?? "") as RuntimeProcessExitObservation
          );
        }
      }
    }
    const quickCheck = store.databaseHandle().pragma("quick_check", { simple: true });
    if (quickCheck !== "ok") {
      throw new Error(`SQLite quick_check failed: ${String(quickCheck)}.`);
    }
  } finally {
    store.close();
  }
}

async function createDatabaseBackup(
  home: string,
  sourceVersion: number,
  now: Date
): Promise<string> {
  const source = join(home, CURRENT_DATABASE_FILENAME);
  if (!existsSync(source)) throw new Error("The authoritative yui.db is missing.");
  // Backups live inside Home so a single canonical root contains every
  // self-managed artifact; the upgrade fence still protects them from the
  // live database because they are a distinct partition from yui.db.
  const backupDirectory = storageBackupRoot(home);
  mkdirSync(backupDirectory, { recursive: true, mode: 0o700 });
  const timestamp = now.toISOString().replaceAll(":", "-");
  const backupPath = join(
    backupDirectory,
    `pre-storage-v${sourceVersion}-${timestamp}.db`
  );
  const database = new Database(source, { readonly: true, fileMustExist: true });
  try {
    await database.backup(backupPath);
  } finally {
    database.close();
  }
  return backupPath;
}

function restoreDatabaseBackup(home: string, backupPath: string): void {
  const databasePath = join(home, CURRENT_DATABASE_FILENAME);
  rmSync(`${databasePath}-wal`, { force: true });
  rmSync(`${databasePath}-shm`, { force: true });
  copyFileSync(backupPath, databasePath);
}

function tryRestoreDatabaseBackup(
  home: string,
  backupPath: string
): Readonly<{ restored: true } | { restored: false; error: string }> {
  try {
    restoreDatabaseBackup(home, backupPath);
    return { restored: true };
  } catch (error) {
    return { restored: false, error: messageOf(error) };
  }
}

function currentClassification(): HomeClassification {
  return {
    classification: { verdict: "USABLE", status: "current" },
    storageVersion: CURRENT_STORAGE_VERSION,
    currentStorageVersion: CURRENT_STORAGE_VERSION,
    minimumSupportedStorageVersion: MIN_SUPPORTED_STORAGE_VERSION
  };
}

function migratableClassification(storageVersion: number): HomeClassification {
  return {
    classification: { verdict: "MIGRATABLE", status: "migration-ready" },
    storageVersion,
    currentStorageVersion: CURRENT_STORAGE_VERSION,
    minimumSupportedStorageVersion: MIN_SUPPORTED_STORAGE_VERSION
  };
}

function unsupportedClassification(
  state: Extract<StorageSchemaState, { status: "unsupported" }>
): HomeClassification {
  const future = state.direction === "newer";
  const message = future
    ? `Storage version ${state.currentVersion} is newer than this CLI supports `
      + `(${CURRENT_STORAGE_VERSION}).`
    : `Storage version ${state.currentVersion} is older than the minimum supported `
      + `migration version ${MIN_SUPPORTED_STORAGE_VERSION}.`;
  const action = future
    ? "Use a newer Yui release."
    : "Preserve this Home for use with its matching historical Yui release, "
      + "or initialize a new Home with Yui 0.15.0 or later.";
  return {
    classification: {
      verdict: "NEEDS_NEW_VERSION",
      status: "unsupported",
      blocker: {
        reason: future ? "future-version" : "below-minimum",
        found: state.currentVersion,
        current: CURRENT_STORAGE_VERSION,
        minimum: MIN_SUPPORTED_STORAGE_VERSION,
        message,
        action
      }
    },
    storageVersion: state.currentVersion,
    currentStorageVersion: CURRENT_STORAGE_VERSION,
    minimumSupportedStorageVersion: MIN_SUPPORTED_STORAGE_VERSION
  };
}

function corruptedClassification(detail: string): HomeClassification {
  return {
    classification: { verdict: "CORRUPTED", status: "unsupported", detail },
    currentStorageVersion: CURRENT_STORAGE_VERSION,
    minimumSupportedStorageVersion: MIN_SUPPORTED_STORAGE_VERSION
  };
}

function blocked(
  classification: HomeClassification,
  stage: UpgradeBlockerStage,
  message: string,
  action: string
): Extract<UpgradeResult, { outcome: "blocked" }> {
  return {
    outcome: "blocked",
    stage,
    message,
    action,
    classification,
    sceneUnchanged: true
  };
}

/**
 * Run each data migration's registered READ-ONLY preflight against the
 * current (pre-upgrade) database and, when any finds a blocker, return a
 * `blocked` result the caller surfaces before touching the Controller or the
 * Home. Returns `null` when the plan carries no registered readiness check,
 * or when every preflight is clear.
 *
 * Both the 23->24 unify and the 24->25 collapse migrations physically relocate
 * managed worktrees and share the same blocker shape (in-flight Job, conflicting
 * relocation target). When a Home is upgraded across both in one run, their
 * blockers are aggregated so the operator sees their readiness problems together.
 * Notification retirement separately rejects unsettled execution references.
 *
 * The database is opened read-only so the checks cannot mutate the authoritative
 * store, and the handle is always closed. An unexpected failure to evaluate a
 * preflight is itself a fail-closed blocker: we must not advance to an
 * irreversible migration on an unverifiable readiness signal.
 */
function preflightMigrationBlockers(
  home: string,
  plan: readonly StorageMigrationStep[],
  classification: HomeClassification
): Extract<UpgradeResult, { outcome: "blocked" }> | null {
  const relocatesUnify = plan.some((step) => step.name === "unify-home-layout");
  const relocatesCollapse = plan.some((step) => step.name === "collapse-worktree-layout");
  const retiresRunWakes = plan.some((step) => step.name === "notification-only-wakes");
  if (!relocatesUnify && !relocatesCollapse && !retiresRunWakes) return null;

  type MigrationBlocker = UnifyHomePreflightBlocker | CollapseWorktreePreflightBlocker;
  let blockers: MigrationBlocker[];
  try {
    const database = new Database(join(home, CURRENT_DATABASE_FILENAME), {
      readonly: true,
      fileMustExist: true
    });
    try {
      blockers = [];
      if (relocatesUnify) blockers.push(...preflightUnifyHomeLayout(database).blockers);
      if (relocatesCollapse) blockers.push(...preflightCollapseWorktreeLayout(database).blockers);
      if (retiresRunWakes) preflightNotificationOnlyWakes(database);
    } finally {
      database.close();
    }
  } catch (error) {
    return {
      ...blocked(
        classification,
        "in-flight",
        `The storage migration readiness check could not be completed: ${messageOf(error)}`,
        "Resolve the named execution or resource boundary, preserving original input and results. "
          + "Confirm the relevant Runs and Jobs are settled, then rerun the upgrade."
      )
    };
  }
  if (blockers.length === 0) return null;

  return {
    outcome: "blocked",
    stage: "in-flight",
    message:
      "Refusing to migrate: the Home is not safe to relocate under the current layout yet. "
      + blockers.map((entry) => entry.detail).join("; ") + ".",
    action:
      "Resolve the reported condition(s) — let a queued/running Job finish or cancel it, and "
      + "clear any conflicting relocation target — then rerun the upgrade. The migration is applied "
      + "offline, so first confirm the Controller and any execution writers for this Home are "
      + "stopped. The authoritative Home is unchanged.",
    blockers: blockers.map((entry) => ({ reason: entry.reason, detail: entry.detail })),
    classification,
    sceneUnchanged: true
  };
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
