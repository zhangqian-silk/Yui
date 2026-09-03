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
import { validateReviewRound } from "../../review/reviewRound.js";
import { validateExecutionGroup } from "../../execution/legacyExecutionGroup.js";
import { validateTask } from "../../task/task.js";
import { validateIntegrationAttempt } from "../../integration/integrationAttempt.js";
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
  recordKind:
    | "workItem"
    | "turn"
    | "reviewRound"
    | "task"
    | "integrationAttempt"
    | "agentProfile";
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
    { fromAggregate: 24, toAggregate: 25, recordKind: "task", fromRecordVersion: 6, toRecordVersion: 7 },
    { fromAggregate: 25, toAggregate: 26, recordKind: "integrationAttempt", fromRecordVersion: 5, toRecordVersion: 6 },
    { fromAggregate: 26, toAggregate: 27, recordKind: "agentProfile", fromRecordVersion: 2, toRecordVersion: 3 },
    { fromAggregate: 27, toAggregate: 28, recordKind: "reviewRound", fromRecordVersion: 6, toRecordVersion: 7 },
    { fromAggregate: 28, toAggregate: 29, recordKind: "turn", fromRecordVersion: 3, toRecordVersion: 4 }
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
  else if (aggregate <= 28) expected.turn = 3;
  if (aggregate <= 24) expected.task = 6;
  if (aggregate <= 25) expected.integrationAttempt = 5;
  if (aggregate <= 26) expected.agentProfile = 2;
  if (aggregate <= 27) expected.reviewRound = 6;
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
      : manifest.aggregateSchemaVersion === 23
        ? 2
        : manifest.aggregateSchemaVersion <= 28 ? 3 : 4;
    for (const { payload } of database.prepare("SELECT payload FROM turns").all() as { payload: string }[]) {
      const turn = jsonRecord(payload, "Turn");
      if (![expectedTurn, 2, 3, 4].includes(turn.schemaVersion as number)) {
        throw new Error(`Turn payload version ${String(turn.schemaVersion)} does not match its manifest.`);
      }
    }
    const expectedReviewRound = manifest.aggregateSchemaVersion <= 27 ? 6 : 7;
    for (const { payload } of database.prepare("SELECT payload FROM review_rounds").all() as { payload: string }[]) {
      const round = jsonRecord(payload, "ReviewRound");
      if (![expectedReviewRound, 7].includes(round.schemaVersion as number)) {
        throw new Error(
          `ReviewRound payload version ${String(round.schemaVersion)} does not match its manifest.`
        );
      }
    }
    const expectedTask = manifest.aggregateSchemaVersion <= 24 ? 6 : 7;
    for (const { payload } of database.prepare("SELECT payload FROM task_records").all() as { payload: string }[]) {
      const task = jsonRecord(payload, "Task");
      if (![expectedTask, 7].includes(task.schemaVersion as number)) {
        throw new Error(`Task payload version ${String(task.schemaVersion)} does not match its manifest.`);
      }
    }
    const expectedIntegration = manifest.aggregateSchemaVersion <= 25 ? 5 : 6;
    for (const { payload } of database.prepare("SELECT payload FROM integration_attempts").all() as { payload: string }[]) {
      const attempt = jsonRecord(payload, "IntegrationAttempt");
      if (![expectedIntegration, 6].includes(attempt.schemaVersion as number)) {
        throw new Error(
          `IntegrationAttempt payload version ${String(attempt.schemaVersion)} does not match its manifest.`
        );
      }
    }
    const expectedProfile = manifest.aggregateSchemaVersion <= 26 ? 2 : 3;
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
      if (manifest.aggregateSchemaVersion <= 24) migrateTasks6To7(database);
      if (manifest.aggregateSchemaVersion <= 25) migrateIntegrations5To6(database, now);
      if (manifest.aggregateSchemaVersion <= 26) migrateAgentProfiles2To3(database);
      if (manifest.aggregateSchemaVersion <= 27) migrateReviewRounds6To7(database, now);
      if (manifest.aggregateSchemaVersion <= 28) migrateTurns(database, 3, 4);
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

/**
 * Preserve valid historical Review semantics while retiring the removed
 * strategy/resolution protocol. Terminal rounds keep their authoritative
 * result and store the old Group as opaque evidence. An active old Group
 * cannot be reinterpreted as the new immutable producer unit, so the Round
 * and its active Turns are explicitly failed with an append-only audit event.
 */
function migrateReviewRounds6To7(database: Database.Database, now: Date): void {
  const timestamp = now.toISOString();
  const rows = database.prepare(
    "SELECT task_id, review_round_id, payload FROM review_rounds"
  ).all() as { task_id: string; review_round_id: string; payload: string }[];
  for (const row of rows) {
    const round = jsonRecord(row.payload, "ReviewRound");
    if (round.schemaVersion === 7) continue;
    if (round.schemaVersion !== 6) {
      throw new Error(
        `ReviewRound ${row.review_round_id} cannot migrate from version `
        + `${String(round.schemaVersion)}.`
      );
    }
    const legacyGroup = round.executionGroup;
    if (legacyGroup !== undefined) {
      if (typeof legacyGroup !== "object" || legacyGroup === null || Array.isArray(legacyGroup)) {
        throw new Error(`ReviewRound ${row.review_round_id} has invalid legacy ExecutionGroup.`);
      }
      validateExecutionGroup(legacyGroup as never);
    }
    const activeLegacyGroup = legacyGroup !== undefined
      && (round.status === "pending" || round.status === "running");
    const {
      executionGroup: _executionGroup,
      legacyExecutionGroup: _legacyExecutionGroup,
      ...base
    } = round;
    const summary = "The pre-v7 Review ExecutionGroup protocol was retired during storage upgrade; request a current Review.";
    const migrated = {
      ...base,
      schemaVersion: 7,
      ...(legacyGroup === undefined ? {} : { legacyExecutionGroup: legacyGroup }),
      ...(activeLegacyGroup
        ? {
            status: "failed",
            summary,
            report: summary,
            checks: [],
            endedAt: timestamp
          }
        : {})
    };
    validateReviewRound(migrated as never);
    const rowTimestamp = activeLegacyGroup
      ? timestamp
      : typeof migrated.endedAt === "string"
        ? migrated.endedAt
        : typeof round.createdAt === "string"
          ? round.createdAt
          : timestamp;
    database.prepare(
      "UPDATE review_rounds SET status = ?, payload = ?, updated_at = ? "
      + "WHERE task_id = ? AND review_round_id = ?"
    ).run(
      migrated.status,
      JSON.stringify(migrated),
      rowTimestamp,
      row.task_id,
      row.review_round_id
    );
    if (!activeLegacyGroup) continue;

    const terminalizedTurnIds: string[] = [];
    const turns = database.prepare(
      "SELECT turn_id, payload FROM turns WHERE task_id = ?"
    ).all(row.task_id) as { turn_id: string; payload: string }[];
    for (const turnRow of turns) {
      const turn = jsonRecord(turnRow.payload, "Turn");
      if (turn.status !== "active" || turn.reviewRoundId !== row.review_round_id) continue;
      const terminal = {
        ...turn,
        status: "failed",
        result: {
          schemaVersion: 1,
          output: summary,
          completedAt: timestamp,
          failureReason: "cancelled"
        },
        updatedAt: timestamp
      };
      database.prepare(
        "UPDATE turns SET status = 'failed', payload = ?, updated_at = ? "
        + "WHERE task_id = ? AND turn_id = ?"
      ).run(JSON.stringify(terminal), timestamp, row.task_id, turnRow.turn_id);
      database.prepare("DELETE FROM active_turns WHERE task_id = ? AND turn_id = ?")
        .run(row.task_id, turnRow.turn_id);
      terminalizedTurnIds.push(turnRow.turn_id);
    }
    appendMigrationAuditEvent(database, row.task_id, timestamp, {
      reviewRoundId: row.review_round_id,
      executionGroupId: typeof (legacyGroup as Record<string, unknown>).id === "string"
        ? (legacyGroup as Record<string, unknown>).id as string
        : "unknown",
      terminalizedTurnIds: terminalizedTurnIds.join(",") || "none",
      reason: "legacy-review-execution-protocol-retired"
    });
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
    if (to === 4) validateTurn(migrated as never);
    database.prepare(
      "UPDATE turns SET payload = ? WHERE task_id = ? AND turn_id = ?"
    ).run(JSON.stringify(migrated), row.task_id, row.turn_id);
  }
}

function appendMigrationAuditEvent(
  database: Database.Database,
  taskId: string,
  occurredAt: string,
  payload: Readonly<Record<string, string>>
): void {
  const sequence = database.prepare(
    `INSERT INTO id_sequences (task_id, kind, high_water) VALUES (?, 'event', 1)
     ON CONFLICT(task_id, kind) DO UPDATE SET high_water = high_water + 1
     RETURNING high_water`
  ).get(taskId) as { high_water: number };
  const event = {
    schemaVersion: 2,
    id: `event-${sequence.high_water}`,
    taskId,
    type: "review.legacy-execution-terminalized",
    payload,
    createdAt: occurredAt
  };
  database.prepare(
    "INSERT INTO events (task_id, event_id, type, occurred_at, payload) "
    + "VALUES (?, ?, ?, ?, ?)"
  ).run(taskId, event.id, event.type, occurredAt, JSON.stringify(event));
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

function migrateTasks6To7(database: Database.Database): void {
  const projectBranches = new Map<string, string>();
  for (const row of database.prepare("SELECT id, payload FROM projects").all() as {
    id: string;
    payload: string;
  }[]) {
    const project = jsonRecord(row.payload, "Project");
    if (typeof project.developmentBranch === "string") {
      projectBranches.set(row.id, project.developmentBranch);
    }
  }
  const workspaceEntries = new Map<string, Map<string, Record<string, unknown>>>();
  for (const row of database.prepare(
    "SELECT task_id, payload FROM managed_workspaces WHERE owner_kind = 'task'"
  ).all() as { task_id: string; payload: string }[]) {
    const workspace = jsonRecord(row.payload, "ManagedWorkspace");
    if (!Array.isArray(workspace.entries)) continue;
    workspaceEntries.set(row.task_id, new Map(
      (workspace.entries as Record<string, unknown>[])
        .filter((entry) => typeof entry.projectId === "string")
        .map((entry) => [entry.projectId as string, entry])
    ));
  }
  const latestCommitted = new Map<string, Readonly<{ id: string; commit: string }>>();
  for (const row of database.prepare(
    "SELECT task_id, integration_id, payload FROM integration_attempts"
  ).all() as { task_id: string; integration_id: string; payload: string }[]) {
    const attempt = jsonRecord(row.payload, "IntegrationAttempt");
    if (attempt.status !== "committed"
      || typeof attempt.projectId !== "string"
      || typeof attempt.candidateCommit !== "string") continue;
    const key = `${row.task_id}\u0000${attempt.projectId}`;
    const previous = latestCommitted.get(key);
    if (previous === undefined
      || previous.id.localeCompare(row.integration_id, undefined, { numeric: true }) < 0) {
      latestCommitted.set(key, {
        id: row.integration_id,
        commit: attempt.candidateCommit
      });
    }
  }
  const rows = database.prepare(
    "SELECT task_id, payload FROM task_records"
  ).all() as { task_id: string; payload: string }[];
  for (const row of rows) {
    const task = jsonRecord(row.payload, "Task");
    if (task.schemaVersion === 7) continue;
    if (task.schemaVersion !== 6 || !Array.isArray(task.projectBindings)) {
      throw new Error(`Task ${row.task_id} cannot migrate from version ${String(task.schemaVersion)}.`);
    }
    const entries = workspaceEntries.get(row.task_id);
    const projectBindings = (task.projectBindings as Record<string, unknown>[]).map((binding) => {
      if (typeof binding.projectId !== "string") return binding;
      const entry = entries?.get(binding.projectId);
      const recordedBase = typeof entry?.baseCommit === "string"
        ? entry.baseCommit
        : typeof binding.baseRef === "string" && isCommit(binding.baseRef)
          ? binding.baseRef
          : undefined;
      const currentCommit = latestCommitted.get(
        `${row.task_id}\u0000${binding.projectId}`
      )?.commit ?? recordedBase;
      const baseRef = typeof binding.baseRef === "string" && isCommit(binding.baseRef)
        ? projectBranches.get(binding.projectId) ?? binding.baseRef
        : binding.baseRef;
      return {
        ...binding,
        baseRef,
        ...(recordedBase === undefined || currentCommit === undefined
          ? {}
          : { baseCommit: recordedBase, currentCommit })
      };
    });
    const migrated = { ...task, schemaVersion: 7, projectBindings };
    validateTask(migrated as never);
    database.prepare(
      "UPDATE task_records SET payload = ? WHERE task_id = ?"
    ).run(JSON.stringify(migrated), row.task_id);
  }
}

function migrateIntegrations5To6(database: Database.Database, now: Date): void {
  const timestamp = now.toISOString();
  const rows = database.prepare(
    "SELECT task_id, integration_id, payload FROM integration_attempts"
  ).all() as { task_id: string; integration_id: string; payload: string }[];
  for (const row of rows) {
    const attempt = jsonRecord(row.payload, "IntegrationAttempt");
    if (attempt.schemaVersion === 6) continue;
    if (attempt.schemaVersion !== 5
      || typeof attempt.expectedHead !== "string"
      || !Array.isArray(attempt.changeSetIds)
      || attempt.changeSetIds.length === 0) {
      throw new Error(
        `IntegrationAttempt ${row.integration_id} cannot migrate from version ${
          String(attempt.schemaVersion)
        }.`
      );
    }
    const active = ["running", "blocked", "validating"].includes(String(attempt.status));
    const {
      expectedHead,
      changeSetIds,
      conflict: _conflict,
      resolution: _resolution,
      endedAt: previousEndedAt,
      ...base
    } = attempt;
    const status = active ? "failed" : attempt.status;
    const candidateCommit = typeof attempt.candidateCommit === "string"
      ? attempt.candidateCommit
      : undefined;
    const migrated = {
      ...base,
      schemaVersion: 6,
      source: {
        kind: "historical-change-sets",
        changeSetIds
      },
      beforeCommit: expectedHead,
      status,
      ...(status === "committed" && candidateCommit !== undefined
        ? {
            afterCommit: candidateCommit,
            summary: "Migrated committed Integration with historical ChangeSet provenance."
          }
        : {}),
      ...(active
        ? {
            checks: [
              ...(Array.isArray(attempt.checks) ? attempt.checks : []),
              {
                name: "storage-migration",
                outcome: "failed",
                details: "The pre-v6 Integration source model was retired; create a new Integration."
              }
            ],
            updatedAt: timestamp,
            endedAt: timestamp
          }
        : previousEndedAt === undefined ? {} : { endedAt: previousEndedAt })
    };
    validateIntegrationAttempt(migrated as never);
    const migratedRecord = migrated as unknown as Record<string, unknown>;
    database.prepare(
      `UPDATE integration_attempts
       SET status = ?, payload = ?, updated_at = ?
       WHERE task_id = ? AND integration_id = ?`
    ).run(
      migrated.status,
      JSON.stringify(migrated),
      typeof migratedRecord.updatedAt === "string"
        ? migratedRecord.updatedAt
        : timestamp,
      row.task_id,
      row.integration_id
    );
  }
}

function isCommit(value: string): boolean {
  return /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/iu.test(value);
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
      for (const round of store.listReviewRounds(taskId)) validateReviewRound(round);
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
