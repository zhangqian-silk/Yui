import { existsSync } from "node:fs";
import { join } from "node:path";

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
import { validateTurn } from "../../turn/turn.js";
import { validateWorkItem } from "../../workItem/workItem.js";
import { SqliteTaskStore } from "../sqliteStore.js";
import {
  inspectStorageSchema,
  type StorageSchemaState
} from "../storageSchema.js";
import type { StorageVersionState } from "./recordVersions.js";

const CURRENT_DATABASE_FILENAME = "yui.db";

type CurrentStorageReport = Readonly<{
  outcome: "already-current";
  mode: "dry-run" | "execute";
  source: StorageVersionState;
  target: StorageVersionState;
}>;

export type HomeClassification = Readonly<{
  classification:
    | Readonly<{ verdict: "USABLE"; status: "current" }>
    | Readonly<{
        verdict: "NEEDS_NEW_VERSION";
        status: "unsupported";
        blocker: Readonly<{
          reason: "future-version" | "missing-step";
          axis: "layout" | "aggregate" | "record";
          recordKind?: string;
          found?: number;
          supported?: number;
          from?: number;
          to?: number;
          message: string;
          action: string;
        }>;
      }>
    | Readonly<{ verdict: "CORRUPTED"; status: "unsupported"; detail: string }>;
  layoutVersion?: number;
  aggregateVersion?: number;
  latestLayoutVersion: number;
  latestAggregateVersion: number;
  incompatibleComponent?: "layout" | "aggregate" | "record";
  uninitialized?: true;
}>;

export type UpgradeBlockerStage = "uninitialized" | "unsupported" | "corruption";

export type UpgradeResult = Readonly<
  | { outcome: "already-current"; classification: HomeClassification; report: CurrentStorageReport }
  | {
      outcome: "update-preflight";
      status: "already-current";
      stepCount: 0;
      steps: readonly [];
      classification: HomeClassification;
    }
  | {
      outcome: "blocked";
      stage: UpgradeBlockerStage;
      message: string;
      action: string;
      classification: HomeClassification;
      sceneUnchanged: true;
    }
>;

export type RunStorageUpgradeOptions = Readonly<{
  home: string;
  latest: StorageVersionState;
  mode: "dry-run" | "execute" | "update-preflight";
  now?: Date;
}>;

/**
 * Validate the one supported storage contract.
 *
 * Aggregate 31 deliberately has no historical migration path. `upgrade`
 * remains as a read-only compatibility/preflight surface for current Homes;
 * every non-current contract is rejected without touching the Home.
 */
export async function runStorageUpgrade(options: RunStorageUpgradeOptions): Promise<UpgradeResult> {
  const schema = inspectStorageSchema(options.home);
  if (schema.status === "uninitialized") {
    return blocked(
      { ...currentClassification(options.latest), uninitialized: true },
      "uninitialized",
      "Yui storage is not initialized for this Home.",
      "Run `yui setup` with a new Home."
    );
  }
  if (schema.status === "invalid") {
    return blocked(
      corruptedClassification(options.latest, schema.detail),
      "corruption",
      `Storage schema is invalid: ${schema.detail}`,
      "Preserve this Home for diagnosis and restore it from a known-good backup."
    );
  }
  if (!existsSync(join(options.home, CURRENT_DATABASE_FILENAME))) {
    return blocked(
      corruptedClassification(options.latest, "The SQLite database is missing."),
      "corruption",
      "The SQLite Home is incomplete: yui.db is missing.",
      "Preserve this Home for diagnosis and restore it from a known-good backup."
    );
  }
  if (schema.status === "unsupported") {
    const classification = unsupportedClassification(schema, options.latest);
    return blocked(
      classification,
      "unsupported",
      "This Home does not exactly match the current storage contract; this release provides no migration path.",
      schema.direction === "newer"
        ? "Use a newer Yui release that supports this exact Home."
        : "Open it with its matching Yui version, or initialize a new Home."
    );
  }

  try {
    validateCurrentStore(options.home);
  } catch (error) {
    return blocked(
      corruptedClassification(options.latest, messageOf(error)),
      "corruption",
      `Current storage validation failed: ${messageOf(error)}`,
      "Preserve this Home for diagnosis and restore it from a known-good backup."
    );
  }

  const classification = currentClassification(options.latest);
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
      source: options.latest,
      target: options.latest
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
      if (owner.schemaVersion !== 2
        || typeof owner.runtimeGenerationId !== "string"
        || Object.hasOwn(owner, "launchId")) {
        throw new Error("Session owner runtime generation identity is invalid.");
      }
    }
    for (const taskId of store.listTasks().map(({ id }) => id)) {
      for (const item of store.listWorkItems(taskId)) validateWorkItem(item);
      for (const round of store.listReviewRounds(taskId)) validateReviewRound(round);
      for (const turn of store.listTurns(taskId)) validateTurn(turn);
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
  } finally {
    store.close();
  }
}

function currentClassification(latest: StorageVersionState): HomeClassification {
  return {
    classification: { verdict: "USABLE", status: "current" },
    layoutVersion: latest.layout,
    aggregateVersion: latest.aggregate,
    latestLayoutVersion: latest.layout,
    latestAggregateVersion: latest.aggregate
  };
}

function unsupportedClassification(
  schema: Extract<StorageSchemaState, { status: "unsupported" }>,
  latest: StorageVersionState
): HomeClassification {
  const axis = schema.incompatibleComponent;
  const found = schema.currentVersion;
  const supported = schema.latestVersion;
  const future = schema.direction === "newer";
  const action = future
    ? "Use a newer Yui release that supports this exact Home."
    : "Open it with its matching Yui version, or initialize a new Home.";
  return {
    classification: {
      verdict: "NEEDS_NEW_VERSION",
      status: "unsupported",
      blocker: {
        reason: future ? "future-version" : "missing-step",
        axis,
        ...(schema.recordFamily === undefined ? {} : { recordKind: schema.recordFamily }),
        ...(future ? { found, supported } : { from: found, to: supported }),
        message: future
          ? "The Home is newer than this Yui release."
          : "This release provides no migration path for the older Home.",
        action
      }
    },
    layoutVersion: schema.currentLayoutVersion,
    aggregateVersion: schema.currentAggregateSchemaVersion,
    latestLayoutVersion: latest.layout,
    latestAggregateVersion: latest.aggregate,
    incompatibleComponent: axis
  };
}

function corruptedClassification(
  latest: StorageVersionState,
  detail: string
): HomeClassification {
  return {
    classification: { verdict: "CORRUPTED", status: "unsupported", detail },
    latestLayoutVersion: latest.layout,
    latestAggregateVersion: latest.aggregate
  };
}

function blocked(
  classification: HomeClassification,
  stage: UpgradeBlockerStage,
  message: string,
  action: string
): Extract<UpgradeResult, { outcome: "blocked" }> {
  return { outcome: "blocked", stage, message, action, classification, sceneUnchanged: true };
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
