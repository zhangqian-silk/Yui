import { existsSync } from "node:fs";
import { join } from "node:path";

import { SqliteTaskStore } from "../sqliteStore.js";
import { inspectStorageSchema } from "../storageSchema.js";
import type { StorageVersionState } from "./recordVersions.js";

const CURRENT_DATABASE_FILENAME = "yui.db";

type CurrentStorageReport = Readonly<{
  outcome: "already-current";
  mode: "dry-run" | "execute";
  source: StorageVersionState;
  target: StorageVersionState;
}>;

/** Current-contract admission result; it is not a migration classification. */
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

export type UpgradeBlockerStage =
  | "uninitialized"
  | "unsupported"
  | "corruption";

export type UpgradeResult = Readonly<
  | {
      outcome: "already-current";
      classification: HomeClassification;
      report: CurrentStorageReport;
    }
  | {
      outcome: "update-preflight";
      status: "already-current";
      stepCount: 0;
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
}>;

/**
 * Current-only storage admission. Historical Homes are preserved byte-for-byte
 * and rejected; Yui never repairs, normalizes, or upgrades them in place.
 */
export async function runStorageUpgrade(
  options: RunStorageUpgradeOptions
): Promise<UpgradeResult> {
  const schema = inspectStorageSchema(options.home);
  const classification = classifyCurrentHome(schema, options.latest);
  if (schema.status === "uninitialized") {
    return blocked(
      classification,
      "uninitialized",
      "Yui storage is not initialized for this Home.",
      "Run `yui setup` with a new Home."
    );
  }
  if (schema.status === "invalid") {
    return blocked(
      classification,
      "corruption",
      `Storage schema is invalid: ${schema.detail}`,
      "Preserve this Home for diagnosis and initialize a new Home."
    );
  }
  if (schema.status === "unsupported") {
    return blocked(
      classification,
      "unsupported",
      `Storage contract is ${schema.direction}: ${schema.incompatibleComponent}.`,
      "Open the old Home only with its original Yui version to export a summary; then let the new Operator create a new Task in a new Home."
    );
  }
  if (!existsSync(join(options.home, CURRENT_DATABASE_FILENAME))) {
    return blocked(
      corruptedClassification(classification, "The current SQLite database is missing."),
      "corruption",
      "The current SQLite Home is incomplete: yui.db is missing.",
      "Preserve this Home for diagnosis and initialize a new Home."
    );
  }
  try {
    const store = new SqliteTaskStore(options.home);
    try {
      store.getConfig();
    } finally {
      store.close();
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return blocked(
      corruptedClassification(classification, message),
      "corruption",
      `Current storage validation failed: ${message}`,
      "Preserve this Home for diagnosis and initialize a new Home."
    );
  }
  if (options.mode === "update-preflight") {
    return {
      outcome: "update-preflight",
      status: "already-current",
      stepCount: 0,
      classification
    };
  }
  const report: CurrentStorageReport = {
    outcome: "already-current",
    mode: options.mode,
    source: options.latest,
    target: options.latest
  };
  return { outcome: "already-current", classification, report };
}

function classifyCurrentHome(
  schema: ReturnType<typeof inspectStorageSchema>,
  latest: StorageVersionState
): HomeClassification {
  const base = {
    latestLayoutVersion: latest.layout,
    latestAggregateVersion: latest.aggregate
  } as const;
  if (schema.status === "uninitialized") {
    return {
      ...base,
      classification: { verdict: "USABLE", status: "current" },
      uninitialized: true
    };
  }
  if (schema.status === "invalid") {
    return corruptedClassification({
      ...base,
      classification: { verdict: "CORRUPTED", status: "unsupported", detail: schema.detail }
    }, schema.detail);
  }
  if (schema.status === "unsupported") {
    const blocker = schema.direction === "newer"
      ? {
          reason: "future-version" as const,
          axis: schema.incompatibleComponent,
          ...(schema.recordFamily === undefined ? {} : { recordKind: schema.recordFamily }),
          found: schema.currentVersion,
          supported: schema.latestVersion,
          message: "Historical storage contracts are not supported by this release.",
          action: "Initialize a new Home."
        }
      : {
          reason: "missing-step" as const,
          axis: schema.incompatibleComponent,
          ...(schema.recordFamily === undefined ? {} : { recordKind: schema.recordFamily }),
          from: schema.currentVersion,
          to: schema.latestVersion,
          message: "Historical storage contracts are not supported by this release.",
          action: "Initialize a new Home."
        };
    return {
      ...base,
      classification: {
        verdict: "NEEDS_NEW_VERSION",
        status: "unsupported",
        blocker
      },
      layoutVersion: schema.currentLayoutVersion,
      aggregateVersion: schema.currentAggregateSchemaVersion,
      incompatibleComponent: schema.incompatibleComponent
    };
  }
  return {
    ...base,
    classification: { verdict: "USABLE", status: "current" },
    layoutVersion: schema.currentLayoutVersion,
    aggregateVersion: schema.currentAggregateSchemaVersion
  };
}

function corruptedClassification(
  classification: HomeClassification,
  detail: string
): HomeClassification {
  return {
    ...classification,
    classification: { verdict: "CORRUPTED", status: "unsupported", detail }
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
