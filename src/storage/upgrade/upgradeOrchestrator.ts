import { existsSync } from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3";

import {
  validateConfiguredAgent,
  type ConfiguredAgent
} from "../../agent/agent.js";
import {
  migrateAgentProfileV2ToV3,
  validateAgentProfile,
  type AgentProfileV2
} from "../../profile/agentProfile.js";
import { validateGlobalRole, type GlobalRole } from "../../role/role.js";
import { validateTurn } from "../../turn/turn.js";
import { validateWorkItem } from "../../workItem/workItem.js";
import { validateExecutionGroup } from "../../execution/executionGroup.js";
import { SqliteTaskStore } from "../sqliteStore.js";
import {
  inspectStorageSchema,
  readStorageSchemaManifest,
  writeCurrentStorageManifest,
  type ParsedStorageManifest
} from "../storageSchema.js";
import { validateYuiConfig, type YuiConfig } from "../taskStore.js";
import type { StorageVersionState } from "./recordVersions.js";

const CURRENT_DATABASE_FILENAME = "yui.db";
const FIRST_SUPPORTED_AGGREGATE_VERSION = 21;

export type StorageUpgradeStep = Readonly<{
  fromAggregate: number;
  toAggregate: number;
  recordKind: "workItem" | "turn" | "agentProfile";
  fromRecordVersion: number;
  toRecordVersion: number;
}>;

type CurrentStorageReport = Readonly<{
  outcome: "already-current";
  mode: "dry-run" | "execute";
  source: StorageVersionState;
  target: StorageVersionState;
}>;

type MigrationStorageReport = Readonly<{
  outcome: "upgraded" | "upgrade-plan";
  mode: "dry-run" | "execute";
  source: Readonly<{ layout: number; aggregate: number }>;
  target: Readonly<{ layout: number; aggregate: number }>;
  steps: readonly StorageUpgradeStep[];
}>;

export type HomeClassification = Readonly<{
  classification:
    | Readonly<{ verdict: "USABLE"; status: "current" }>
    | Readonly<{ verdict: "MIGRATABLE"; status: "migration-ready" }>
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
  | { outcome: "upgrade-plan"; classification: HomeClassification; report: MigrationStorageReport }
  | { outcome: "upgraded"; classification: HomeClassification; report: MigrationStorageReport }
  | {
      outcome: "update-preflight";
      status: "already-current" | "migration-ready";
      stepCount: number;
      steps: readonly StorageUpgradeStep[];
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
  | {
      outcome: "failed";
      stage: "migration";
      message: string;
      action: string;
      classification: HomeClassification;
      sceneUnchanged: false;
    }
>;

export type RunStorageUpgradeOptions = Readonly<{
  home: string;
  latest: StorageVersionState;
  mode: "dry-run" | "execute" | "update-preflight";
  now?: Date;
}>;

/** Upgrade valid SQLite Homes through the explicit adjacent aggregate graph. */
export async function runStorageUpgrade(options: RunStorageUpgradeOptions): Promise<UpgradeResult> {
  const schema = inspectStorageSchema(options.home);
  if (schema.status === "uninitialized") {
    return blocked(
      uninitializedClassification(options.latest),
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

  let manifest: ParsedStorageManifest;
  try {
    manifest = readStorageSchemaManifest(options.home);
  } catch (error) {
    return blocked(
      corruptedClassification(options.latest, messageOf(error)),
      "corruption",
      `Storage schema is invalid: ${messageOf(error)}`,
      "Preserve this Home for diagnosis and restore it from a known-good backup."
    );
  }

  if (schema.status === "current") {
    const classification = currentClassification(options.latest);
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

  const plan = migrationPlan(manifest, options.latest);
  if (plan === null) {
    return blocked(
      unsupportedClassification(manifest, options.latest),
      "unsupported",
      "This Home has no complete migration path to the current storage contract.",
      "Open it with a Yui version that supports its exact contract, or restore a supported Home."
    );
  }
  const classification = migratableClassification(manifest, options.latest);
  try {
    validateMigrationDatabase(options.home, manifest);
  } catch (error) {
    return blocked(
      corruptedClassification(options.latest, messageOf(error), manifest),
      "corruption",
      `Historical storage validation failed: ${messageOf(error)}`,
      "Preserve this Home for diagnosis and restore it from a known-good backup."
    );
  }
  if (options.mode === "update-preflight") {
    return {
      outcome: "update-preflight",
      status: "migration-ready",
      stepCount: plan.length,
      steps: plan,
      classification
    };
  }
  const report: MigrationStorageReport = {
    outcome: options.mode === "dry-run" ? "upgrade-plan" : "upgraded",
    mode: options.mode,
    source: { layout: manifest.storageVersion, aggregate: manifest.aggregateSchemaVersion },
    target: { layout: options.latest.layout, aggregate: options.latest.aggregate },
    steps: plan
  };
  if (options.mode === "dry-run") {
    return { outcome: "upgrade-plan", classification, report };
  }

  const migrationTime = options.now ?? new Date();
  try {
    applyMigration(options.home, manifest, migrationTime);
    writeCurrentStorageManifest(options.home, migrationTime);
    validateCurrentStore(options.home);
  } catch (error) {
    return {
      outcome: "failed",
      stage: "migration",
      message: `Storage migration failed: ${messageOf(error)}`,
      action: "Keep the Home quiesced. The adjacent migration is idempotent; resolve the reported failure and rerun `yui upgrade`.",
      classification: corruptedClassification(options.latest, messageOf(error), manifest),
      sceneUnchanged: false
    };
  }
  return { outcome: "upgraded", classification: currentClassification(options.latest), report };
}

function migrationPlan(
  manifest: ParsedStorageManifest,
  latest: StorageVersionState
): readonly StorageUpgradeStep[] | null {
  if (manifest.storageVersion !== latest.layout
    || manifest.aggregateSchemaVersion < FIRST_SUPPORTED_AGGREGATE_VERSION
    || manifest.aggregateSchemaVersion > latest.aggregate
    || manifest.recordVersions === undefined
    || !recordVersionsMatchAggregate(manifest.recordVersions, manifest.aggregateSchemaVersion, latest)) {
    return null;
  }
  const all: readonly StorageUpgradeStep[] = [
    { fromAggregate: 21, toAggregate: 22, recordKind: "workItem", fromRecordVersion: 13, toRecordVersion: 14 },
    { fromAggregate: 22, toAggregate: 23, recordKind: "turn", fromRecordVersion: 1, toRecordVersion: 2 },
    { fromAggregate: 23, toAggregate: 24, recordKind: "turn", fromRecordVersion: 2, toRecordVersion: 3 },
    { fromAggregate: 24, toAggregate: 25, recordKind: "agentProfile", fromRecordVersion: 2, toRecordVersion: 3 }
  ];
  return all.filter(({ fromAggregate }) => fromAggregate >= manifest.aggregateSchemaVersion);
}

function recordVersionsMatchAggregate(
  actual: Readonly<Record<string, number>>,
  aggregate: number,
  latest: StorageVersionState
): boolean {
  const expected = Object.fromEntries(
    Object.entries(latest.record).map(([kind, entry]) => [kind, entry.version])
  ) as Record<string, number>;
  if (aggregate <= 21) expected.workItem = 13;
  if (aggregate <= 22) expected.turn = 1;
  else if (aggregate === 23) expected.turn = 2;
  if (aggregate <= 24) expected.agentProfile = 2;
  const actualKinds = Object.keys(actual).sort();
  const expectedKinds = Object.keys(expected).sort();
  return actualKinds.length === expectedKinds.length
    && actualKinds.every((kind, index) => (
      kind === expectedKinds[index] && actual[kind] === expected[kind]
    ));
}

function validateMigrationDatabase(home: string, manifest: ParsedStorageManifest): void {
  const database = new Database(join(home, CURRENT_DATABASE_FILENAME), {
    readonly: true,
    fileMustExist: true
  });
  try {
    assertDatabaseHealthy(database);
    for (const { payload } of database.prepare("SELECT payload FROM work_items").all() as { payload: string }[]) {
      const item = jsonRecord(payload, "WorkItem");
      const expected = manifest.aggregateSchemaVersion <= 21 ? 13 : 14;
      if (item.schemaVersion !== expected && item.schemaVersion !== 14) {
        throw new Error(`WorkItem payload version ${String(item.schemaVersion)} does not match its manifest.`);
      }
      if (!Array.isArray(item.executionGroups)) throw new Error("WorkItem executionGroups are invalid.");
    }
    const expectedTurn = manifest.aggregateSchemaVersion <= 22
      ? 1
      : manifest.aggregateSchemaVersion === 23 ? 2 : 3;
    for (const { payload } of database.prepare("SELECT payload FROM turns").all() as { payload: string }[]) {
      const turn = jsonRecord(payload, "Turn");
      if (![expectedTurn, 2, 3].includes(turn.schemaVersion as number)) {
        throw new Error(`Turn payload version ${String(turn.schemaVersion)} does not match its manifest.`);
      }
    }
    const expectedProfile = manifest.aggregateSchemaVersion <= 24 ? 2 : 3;
    for (const { payload } of database.prepare("SELECT payload FROM agent_profiles").all() as { payload: string }[]) {
      const profile = jsonRecord(payload, "AgentProfile");
      if (![expectedProfile, 3].includes(profile.schemaVersion as number)) {
        throw new Error(
          `AgentProfile payload version ${String(profile.schemaVersion)} does not match its manifest.`
        );
      }
    }
  } finally {
    database.close();
  }
}

function applyMigration(home: string, manifest: ParsedStorageManifest, now: Date): void {
  const database = new Database(join(home, CURRENT_DATABASE_FILENAME), { fileMustExist: true });
  try {
    database.pragma("journal_mode = WAL");
    database.pragma("synchronous = FULL");
    database.pragma("foreign_keys = ON");
    database.pragma("busy_timeout = 5000");
    assertDatabaseHealthy(database);
    database.transaction(() => {
      if (manifest.aggregateSchemaVersion <= 21) migrateWorkItems13To14(database, now);
      if (manifest.aggregateSchemaVersion <= 22) migrateTurns(database, 1, 2);
      if (manifest.aggregateSchemaVersion <= 23) migrateTurns(database, 2, 3);
      if (manifest.aggregateSchemaVersion <= 24) migrateAgentProfiles2To3(database);
    }).immediate();
  } finally {
    database.close();
  }
}

function migrateWorkItems13To14(database: Database.Database, now: Date): void {
  const timestamp = now.toISOString();
  const retiredTurns: Array<Readonly<{ taskId: string; turnId: string }>> = [];
  const legacyGroupsByWorkItem = new Map<string, Set<string>>();
  const rows = database.prepare(
    "SELECT task_id, work_item_id, payload FROM work_items"
  ).all() as { task_id: string; work_item_id: string; payload: string }[];
  for (const row of rows) {
    const item = jsonRecord(row.payload, "WorkItem");
    if (item.schemaVersion === 14) continue;
    if (item.schemaVersion !== 13 || !Array.isArray(item.executionGroups)) {
      throw new Error(`WorkItem ${row.work_item_id} cannot migrate from version ${String(item.schemaVersion)}.`);
    }
    const legacyGroups = item.executionGroups as Record<string, unknown>[];
    for (const group of legacyGroups) validateExecutionGroup(group as never);
    const groupIds = new Set(legacyGroups.flatMap((group) => (
      typeof group.id === "string" ? [group.id] : []
    )));
    if (groupIds.size !== legacyGroups.length) {
      throw new Error(`WorkItem ${row.work_item_id} has invalid legacy ExecutionGroup identity.`);
    }
    legacyGroupsByWorkItem.set(`${row.task_id}\u0000${row.work_item_id}`, groupIds);
    const hadCurrentLegacyExecution = typeof item.currentExecutionGroupId === "string"
      && groupIds.has(item.currentExecutionGroupId);
    const {
      currentExecutionGroupId: _currentExecutionGroupId,
      executionGroups: _executionGroups,
      legacyExecutionGroups: _legacyExecutionGroups,
      ...base
    } = item;
    const terminalize = item.status === "running" && hadCurrentLegacyExecution;
    const migrated = {
      ...base,
      schemaVersion: 14,
      executionGroups: [],
      ...(legacyGroups.length === 0 ? {} : { legacyExecutionGroups: legacyGroups }),
      ...(terminalize
        ? {
            status: "failed",
            outcome: "The pre-v14 WorkItem execution model was retired during storage upgrade; redispatch this WorkItem.",
            revision: typeof item.revision === "number" ? item.revision + 1 : item.revision,
            updatedAt: timestamp,
            endedAt: timestamp
          }
        : {})
    };
    validateWorkItem(migrated as never);
    database.prepare(
      "UPDATE work_items SET status = ?, payload = ?, updated_at = ? WHERE task_id = ? AND work_item_id = ?"
    ).run(migrated.status, JSON.stringify(migrated), migrated.updatedAt, row.task_id, row.work_item_id);
  }

  const turns = database.prepare(
    "SELECT task_id, turn_id, status, payload FROM turns"
  ).all() as { task_id: string; turn_id: string; status: string; payload: string }[];
  for (const row of turns) {
    const turn = jsonRecord(row.payload, "Turn");
    const key = `${row.task_id}\u0000${String(turn.workItemId ?? "")}`;
    const legacyGroups = legacyGroupsByWorkItem.get(key);
    if (turn.status !== "active"
      || typeof turn.executionGroupId !== "string"
      || !legacyGroups?.has(turn.executionGroupId)) continue;
    const terminal = {
      ...turn,
      status: "failed",
      result: {
        schemaVersion: 1,
        output: "Turn retired because its pre-v14 WorkItem execution model was migrated.",
        completedAt: timestamp,
        failureReason: "cancelled"
      },
      updatedAt: timestamp
    };
    database.prepare(
      "UPDATE turns SET status = 'failed', payload = ?, updated_at = ? WHERE task_id = ? AND turn_id = ?"
    ).run(JSON.stringify(terminal), timestamp, row.task_id, row.turn_id);
    retiredTurns.push({ taskId: row.task_id, turnId: row.turn_id });
  }
  for (const retired of retiredTurns) {
    database.prepare("DELETE FROM active_turns WHERE task_id = ? AND turn_id = ?")
      .run(retired.taskId, retired.turnId);
  }
}

function migrateTurns(database: Database.Database, from: number, to: number): void {
  const rows = database.prepare("SELECT task_id, turn_id, payload FROM turns").all() as {
    task_id: string;
    turn_id: string;
    payload: string;
  }[];
  for (const row of rows) {
    const turn = jsonRecord(row.payload, "Turn");
    if (typeof turn.schemaVersion === "number" && turn.schemaVersion >= to) continue;
    if (turn.schemaVersion !== from) {
      throw new Error(`Turn ${row.turn_id} cannot migrate from version ${String(turn.schemaVersion)}.`);
    }
    const migrated = { ...turn, schemaVersion: to };
    if (to === 3) validateTurn(migrated as never);
    database.prepare(
      "UPDATE turns SET payload = ? WHERE task_id = ? AND turn_id = ?"
    ).run(JSON.stringify(migrated), row.task_id, row.turn_id);
  }
}

function migrateAgentProfiles2To3(database: Database.Database): void {
  const rows = database.prepare("SELECT id, payload FROM agent_profiles").all() as {
    id: string;
    payload: string;
  }[];
  const needsRuntimeAgent = rows.some(({ payload }) => {
    const profile = jsonRecord(payload, "AgentProfile");
    return profile.schemaVersion === 2
      && (profile.model !== undefined || profile.effort !== undefined);
  });
  const runtimeAgent = needsRuntimeAgent
    ? migrationProfileRuntimeAgent(database)
    : undefined;
  for (const row of rows) {
    const profile = jsonRecord(row.payload, "AgentProfile");
    if (profile.schemaVersion === 3) continue;
    if (profile.schemaVersion !== 2) {
      throw new Error(
        `AgentProfile ${row.id} cannot migrate from version ${String(profile.schemaVersion)}.`
      );
    }
    const migrated = migrateAgentProfileV2ToV3(
      profile as AgentProfileV2,
      runtimeAgent
    );
    database.prepare("UPDATE agent_profiles SET payload = ? WHERE id = ?")
      .run(JSON.stringify(migrated), row.id);
  }
}

function migrationProfileRuntimeAgent(
  database: Database.Database
): Readonly<{ agentId: string }> {
  const row = database.prepare("SELECT payload FROM global_roles WHERE name = 'worker'")
    .get() as { payload?: unknown } | undefined;
  if (typeof row?.payload === "string") {
    const worker = validateGlobalRole(
      jsonRecord(row.payload, "Global Role worker") as GlobalRole
    );
    const binding = worker.agentBindings[worker.activeAgentId];
    if (binding === undefined) {
      throw new Error(
        `AgentProfile migration Global Role worker active Agent is not bound: ${worker.activeAgentId}.`
      );
    }
    const agent = migrationConfiguredAgent(database, binding.agentId, "Global Role worker");
    if (agent.adapterId !== binding.adapterId) {
      throw new Error(
        `AgentProfile migration Global Role worker Agent adapter does not match its binding: `
        + `${binding.agentId}.`
      );
    }
    return { agentId: worker.activeAgentId };
  }

  const configRow = database.prepare("SELECT payload FROM config WHERE id = 1")
    .get() as { payload?: unknown } | undefined;
  if (typeof configRow?.payload !== "string") {
    throw new Error("AgentProfile migration requires the Yui config singleton.");
  }
  const config = jsonRecord(configRow.payload, "Yui config") as YuiConfig;
  validateYuiConfig(config);
  if (config.defaultAgent === undefined) {
    const configuredAgents = database.prepare(
      "SELECT id FROM configured_agents ORDER BY id"
    ).all() as { id: string }[];
    if (configuredAgents.length === 1) {
      const agent = migrationConfiguredAgent(
        database,
        configuredAgents[0].id,
        "sole configured"
      );
      return { agentId: agent.id };
    }
    throw new Error(
      "AgentProfile migration requires Global Role worker, config.defaultAgent, "
      + "or exactly one configured Agent for legacy model or effort values; "
      + `found ${configuredAgents.length} configured Agents.`
    );
  }
  migrationConfiguredAgent(database, config.defaultAgent, "config.defaultAgent");
  return { agentId: config.defaultAgent };
}

function migrationConfiguredAgent(
  database: Database.Database,
  agentId: string,
  source: string
): ConfiguredAgent {
  const agentRow = database.prepare("SELECT payload FROM configured_agents WHERE id = ?")
    .get(agentId) as { payload?: unknown } | undefined;
  if (typeof agentRow?.payload !== "string") {
    throw new Error(
      `AgentProfile migration ${source} Agent is not configured: ${agentId}.`
    );
  }
  const agent = jsonRecord(agentRow.payload, "Configured Agent");
  validateConfiguredAgent(agent as ConfiguredAgent);
  return agent as ConfiguredAgent;
}

function assertDatabaseHealthy(database: Database.Database): void {
  const quick = database.pragma("quick_check") as { quick_check?: string }[];
  if (quick.length !== 1 || quick[0]?.quick_check !== "ok") {
    throw new Error("SQLite quick_check failed.");
  }
  for (const table of ["home_meta", "config", "work_items", "turns", "active_turns"]) {
    const row = database.prepare(
      "SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = ?"
    ).get(table) as { present?: number } | undefined;
    if (row?.present !== 1) throw new Error(`SQLite table is missing: ${table}.`);
  }
  for (const singleton of ["home_meta", "config"]) {
    const row = database.prepare(`SELECT COUNT(*) AS count FROM ${singleton} WHERE id = 1`)
      .get() as { count?: number } | undefined;
    if (row?.count !== 1) throw new Error(`SQLite singleton row is missing: ${singleton}.`);
  }
}

function validateCurrentStore(home: string): void {
  const store = new SqliteTaskStore(home);
  try {
    store.getConfig();
    for (const profile of store.listAgentProfiles()) validateAgentProfile(profile);
    for (const taskId of store.listTasks().map(({ id }) => id)) {
      for (const item of store.listWorkItems(taskId)) validateWorkItem(item);
      for (const turn of store.listTurns(taskId)) validateTurn(turn);
    }
  } finally {
    store.close();
  }
}

function jsonRecord(raw: string, label: string): Record<string, unknown> {
  const value = JSON.parse(raw) as unknown;
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} payload is not an object.`);
  }
  return value as Record<string, unknown>;
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

function uninitializedClassification(latest: StorageVersionState): HomeClassification {
  return { ...currentClassification(latest), uninitialized: true };
}

function migratableClassification(
  manifest: ParsedStorageManifest,
  latest: StorageVersionState
): HomeClassification {
  return {
    classification: { verdict: "MIGRATABLE", status: "migration-ready" },
    layoutVersion: manifest.storageVersion,
    aggregateVersion: manifest.aggregateSchemaVersion,
    latestLayoutVersion: latest.layout,
    latestAggregateVersion: latest.aggregate,
    incompatibleComponent: "aggregate"
  };
}

function unsupportedClassification(
  manifest: ParsedStorageManifest,
  latest: StorageVersionState
): HomeClassification {
  const future = manifest.storageVersion > latest.layout
    || manifest.aggregateSchemaVersion > latest.aggregate;
  const axis = manifest.storageVersion !== latest.layout ? "layout" : "aggregate";
  const found = axis === "layout" ? manifest.storageVersion : manifest.aggregateSchemaVersion;
  const supported = axis === "layout" ? latest.layout : latest.aggregate;
  return {
    classification: {
      verdict: "NEEDS_NEW_VERSION",
      status: "unsupported",
      blocker: future
        ? {
            reason: "future-version",
            axis,
            found,
            supported,
            message: "The Home is newer than this Yui release.",
            action: "Use a Yui release that supports this Home."
          }
        : {
            reason: "missing-step",
            axis,
            from: found,
            to: supported,
            message: "The adjacent migration graph has no complete path for this Home.",
            action: "Use an intermediate Yui release that supports this Home."
          }
    },
    layoutVersion: manifest.storageVersion,
    aggregateVersion: manifest.aggregateSchemaVersion,
    latestLayoutVersion: latest.layout,
    latestAggregateVersion: latest.aggregate,
    incompatibleComponent: axis
  };
}

function corruptedClassification(
  latest: StorageVersionState,
  detail: string,
  manifest?: ParsedStorageManifest
): HomeClassification {
  return {
    classification: { verdict: "CORRUPTED", status: "unsupported", detail },
    ...(manifest === undefined ? {} : {
      layoutVersion: manifest.storageVersion,
      aggregateVersion: manifest.aggregateSchemaVersion
    }),
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
