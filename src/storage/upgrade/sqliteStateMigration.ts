/**
 * state.json -> SQLite staged migration (task-21 §8, work-item-4).
 *
 * This module is the document-to-database population and verification seam for
 * the layout 6 -> 7 offline migration. It is deliberately side-effect-light:
 *
 *  - `populateSqliteFromState` opens a {@link SqliteTaskStore} on the sidecar
 *    `yui.db.staged` and bulk-loads every record family from the parsed
 *    `state.json` document, preserving the Home identity, revision, and ID
 *    high-water marks. The source document is never written.
 *  - `computeStateFamilyChecksums` / `computeDbFamilyChecksums` compute a
 *    per-family `{ count, hash }` over the canonical JSON of every record, so
 *    the staged database can be verified against an independent re-read of
 *    `state.json` (the Verify phase of §8.2).
 *  - `verifySqliteMigration` compares the two checksum maps and throws on any
 *    count or content mismatch, leaving the source untouched.
 *
 * The checksum is content-based: each record is canonicalised (sorted keys,
 * stable array ordering) and hashed individually; the per-family hash is the
 * sha256 of the sorted record hashes. This is order-independent (a map
 * serialised in any key order produces the same checksum) and catches any
 * dropped, duplicated, or mutated record.
 */
import { createHash } from "node:crypto";
import { join } from "node:path";
import Database from "better-sqlite3";

import type { ConfiguredAgent } from "../../agent/agent.js";
import type { TaskBrief } from "../../brief/taskBrief.js";
import { mailboxTargetKey } from "../../coordination/workMailbox.js";
import { managedWorkspaceKey, type ManagedWorkspaceOwner } from "../../worktree/managedWorkspace.js";
import type { MailboxTarget, WorkMailbox } from "../../coordination/workMailbox.js";
import type { Decision } from "../../decision/decision.js";
import type { TaskEvent } from "../../event/taskEvent.js";
import type { InputRequest } from "../../input/inputRequest.js";
import type { DurableJob } from "../../job/durableJob.js";
import type {
  GlobalRoleSessionSet,
  TaskRoleSessionSet
} from "../../executor/agentExecutor.js";
import type { TaskMessage } from "../../message/message.js";
import type { Milestone } from "../../milestone/milestone.js";
import type { AgentRun } from "../../run/agentRun.js";
import type { ReviewRound } from "../../review/reviewRound.js";
import type { Project } from "../../repository/project.js";
import type { HomeIdentity } from "../../repository/homeIdentity.js";
import type { AgentProfile } from "../../profile/agentProfile.js";
import type { ChangeSet } from "../../integration/changeSet.js";
import type { IntegrationAttempt } from "../../integration/integrationAttempt.js";
import type { IntegrationQueueEntry } from "../../integration/integrationQueueEntry.js";
import type { GlobalRole, TaskRole } from "../../role/role.js";
import type { CapabilityGrant } from "../../grant/capabilityGrant.js";
import type { ReleaseWorkflow } from "../../release/releaseWorkflow.js";
import type { LeaderFailure } from "../../scheduler/leaderFailure.js";
import type { OperatorNotification } from "../../scheduler/operatorNotification.js";
import type { Task } from "../../task/task.js";
import type { WorkItem } from "../../workItem/workItem.js";
import type { ManagedWorkspace } from "../../worktree/managedWorkspace.js";
import { SqliteTaskStore } from "../sqliteStore.js";
import { readStorageSchemaManifest } from "../storageSchema.js";
import { CURRENT_STORED_TASK_SCHEMA_VERSION, type YuiConfig } from "../taskStore.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A per-family content checksum: record count plus a sha256 content hash. */
export type FamilyChecksum = Readonly<{ count: number; hash: string }>;

/** A map of record-family name to its checksum. */
export type FamilyChecksumMap = Readonly<Record<string, FamilyChecksum>>;

/** The sidecar database filename used during staging. */
export const STAGED_DATABASE_FILENAME = "yui.db.staged";

/** The committed database filename. */
export const COMMITTED_DATABASE_FILENAME = "yui.db";

/**
 * Preserve SQLite-owned durable state that intentionally sits outside the
 * state.json-shaped Task aggregate snapshot. Volatile coordination locks and
 * derived projections are rebuilt or dropped at the offline boundary.
 */
export function copySqlitePassthroughState(
  home: string,
  sourceDatabaseFilename: string,
  targetDatabaseFilename: string
): void {
  if (sourceDatabaseFilename === targetDatabaseFilename) {
    throw new Error("SQLite passthrough copy requires distinct source and target databases.");
  }
  const source = new Database(join(home, sourceDatabaseFilename), { readonly: true });
  const target = new Database(join(home, targetDatabaseFilename));
  try {
    target.pragma("foreign_keys = ON");
    target.transaction(() => {
      mergeGlobalSequences(source, target);
      copyTableRows(source, target, "outbox");
      copyTableRows(source, target, "work_item_candidates");
      copyTableRows(source, target, "review_findings");
      copyTableRows(source, target, "telemetry");
      if (sqliteTableExists(source, "telemetry_aggregate")) {
        target.exec("DELETE FROM telemetry_aggregate");
        copyTableRows(source, target, "telemetry_aggregate");
      }
      copyTableRows(source, target, "session_owners");
      copyTableRows(source, target, "resource_registry");
      copyTableRows(source, target, "gate_artifacts");
      copyTableRows(source, target, "gate_artifact_logs");
    })();
  } finally {
    source.close();
    target.close();
  }
}

function mergeGlobalSequences(source: Database.Database, target: Database.Database): void {
  if (!sqliteTableExists(source, "global_sequences")) return;
  const rows = source.prepare(
    "SELECT name, high_water FROM global_sequences"
  ).all() as Array<{ name: string; high_water: number }>;
  const merge = target.prepare(
    `INSERT INTO global_sequences (name, high_water) VALUES (?, ?)
     ON CONFLICT(name) DO UPDATE SET
       high_water = MAX(global_sequences.high_water, excluded.high_water)`
  );
  for (const row of rows) merge.run(row.name, row.high_water);
}

function copyTableRows(
  source: Database.Database,
  target: Database.Database,
  table: string
): void {
  if (!sqliteTableExists(source, table) || !sqliteTableExists(target, table)) return;
  const columns = source.prepare(
    `PRAGMA table_info(${quoteSqliteIdentifier(table)})`
  ).all().map((row) => (row as { name: string }).name);
  if (columns.length === 0) return;
  const quotedColumns = columns.map(quoteSqliteIdentifier);
  const rows = source.prepare(
    `SELECT ${quotedColumns.join(", ")} FROM ${quoteSqliteIdentifier(table)}`
  ).iterate() as IterableIterator<Record<string, unknown>>;
  const insert = target.prepare(
    `INSERT INTO ${quoteSqliteIdentifier(table)} (${quotedColumns.join(", ")}) `
    + `VALUES (${columns.map(() => "?").join(", ")})`
  );
  for (const row of rows) insert.run(...columns.map((column) => row[column]));
}

function sqliteTableExists(db: Database.Database, table: string): boolean {
  return db.prepare(
    "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?"
  ).get(table) !== undefined;
}

function quoteSqliteIdentifier(value: string): string {
  return `"${value.replaceAll("\"", "\"\"")}"`;
}

// ---------------------------------------------------------------------------
// Canonical JSON and hashing
// ---------------------------------------------------------------------------

/**
 * Deterministic JSON serialisation: object keys are sorted recursively so that
 * two semantically-equal objects serialise identically regardless of key
 * insertion order. Arrays preserve their order.
 */
function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  return `{${keys
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
    .join(",")}}`;
}

/**
 * Compute a per-family checksum over a set of records. Each record is hashed
 * individually (over its canonical JSON); the family hash is the sha256 of
 * the sorted per-record hashes, making the result independent of record
 * ordering.
 */
function hashRecords(records: readonly unknown[]): FamilyChecksum {
  const hashes = records
    .map((record) => createHash("sha256").update(canonicalJson(record)).digest("hex"))
    .sort();
  const hash = createHash("sha256").update(hashes.join("\n")).digest("hex");
  return { count: records.length, hash };
}

// ---------------------------------------------------------------------------
// Document shape helpers
// ---------------------------------------------------------------------------

function asObject(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

function asObjectMap(value: unknown): Record<string, Record<string, unknown>> {
  const record = asObject(value);
  const result: Record<string, Record<string, unknown>> = {};
  for (const [key, entry] of Object.entries(record)) {
    if (entry !== null && typeof entry === "object" && !Array.isArray(entry)) {
      result[key] = entry as Record<string, unknown>;
    }
  }
  return result;
}

/** Read a persisted map whose values are opaque strings without silently
 * dropping malformed entries during an offline migration. */
function asStringMap(value: unknown, label: string): Record<string, string> {
  const record = asObject(value);
  const result: Record<string, string> = {};
  for (const [key, entry] of Object.entries(record)) {
    if (typeof entry !== "string") {
      throw new Error(`${label}.${key} must be a string.`);
    }
    result[key] = entry;
  }
  return result;
}

function asNullableObject(value: unknown): Record<string, unknown> | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

/** The subset of StoredTask the migration reads (structural, not validated). */
interface StoredTaskShape {
  task: Record<string, unknown>;
  brief: Record<string, unknown> | null;
  roles: Record<string, Record<string, unknown>>;
  managedWorkspaces: Record<string, Record<string, unknown>>;
  roleSessionSets: Record<string, Record<string, unknown>>;
  workItems: Record<string, Record<string, unknown>>;
  agentRuns: Record<string, Record<string, unknown>>;
  reviewRounds: Record<string, Record<string, unknown>>;
  changeSets: Record<string, Record<string, unknown>>;
  integrationAttempts: Record<string, Record<string, unknown>>;
  integrationQueue: Record<string, Record<string, unknown>>;
  durableJobs: Record<string, Record<string, unknown>>;
  jobCallerKeyHashes: Record<string, string>;
  activeRuns: Record<string, { schemaVersion: number; runId: string }>;
  messages: Record<string, Record<string, unknown>>;
  inputRequests: Record<string, Record<string, unknown>>;
  decisions: Record<string, Record<string, unknown>>;
  milestones: Record<string, Record<string, unknown>>;
  events: Record<string, Record<string, unknown>>;
  leaderFailure: Record<string, unknown> | null;
  operatorNotification: Record<string, unknown> | null;
  idHighWaterMarks: Record<string, number>;
  capabilityGrants: Record<string, Record<string, unknown>>;
  releaseWorkflows: Record<string, Record<string, unknown>>;
}

function asStoredTask(value: unknown): StoredTaskShape {
  const record = asObject(value);
  return {
    task: asObject(record.task),
    brief: asNullableObject(record.brief),
    roles: asObjectMap(record.roles),
    managedWorkspaces: asObjectMap(record.managedWorkspaces),
    roleSessionSets: asObjectMap(record.roleSessionSets),
    workItems: asObjectMap(record.workItems),
    agentRuns: asObjectMap(record.agentRuns) as Record<string, Record<string, unknown>>,
    reviewRounds: asObjectMap(record.reviewRounds),
    changeSets: asObjectMap(record.changeSets),
    integrationAttempts: asObjectMap(record.integrationAttempts),
    integrationQueue: asObjectMap(record.integrationQueue),
    durableJobs: asObjectMap(record.durableJobs),
    jobCallerKeyHashes: asStringMap(
      record.jobCallerKeyHashes,
      "jobCallerKeyHashes"
    ),
    activeRuns: asObjectMap(record.activeRuns) as unknown as Record<string, { schemaVersion: number; runId: string }>,
    messages: asObjectMap(record.messages),
    inputRequests: asObjectMap(record.inputRequests),
    decisions: asObjectMap(record.decisions),
    milestones: asObjectMap(record.milestones),
    events: asObjectMap(record.events),
    leaderFailure: asNullableObject(record.leaderFailure),
    operatorNotification: asNullableObject(record.operatorNotification),
    idHighWaterMarks: asObject(record.idHighWaterMarks) as Record<string, number>,
    capabilityGrants: asObjectMap(record.capabilityGrants),
    releaseWorkflows: asObjectMap(record.releaseWorkflows)
  };
}

function tasksOf(state: Record<string, unknown>): Record<string, StoredTaskShape> {
  const result: Record<string, StoredTaskShape> = {};
  for (const [taskId, raw] of Object.entries(asObject(state.tasks))) {
    result[taskId] = asStoredTask(raw);
  }
  return result;
}

// ---------------------------------------------------------------------------
// Population (Snapshot -> Stage)
// ---------------------------------------------------------------------------

/**
 * Populate a fresh SQLite database from the parsed `state.json` document.
 *
 * The database is opened with the `migration` option (fence bypass) because
 * the staged load runs while the upgrade fence is active. Every record family
 * is saved through the canonical {@link SqliteTaskStore} methods so the
 * typed-column projections and payload contents match what a live store would
 * produce. The Home identity, revision, and ID high-water marks are preserved
 * so the opened store continues from the same counters.
 *
 * This function NEVER writes `state.json`; it only creates/populates the
 * sidecar database file.
 */
export function populateSqliteFromState(
  home: string,
  state: Record<string, unknown>,
  databaseFilename: string
): void {
  const retiredActiveRuns: Array<Readonly<{
    taskId: string;
    pointer: string;
    value: Readonly<{ schemaVersion: number; runId: string }>;
    updatedAt: string;
  }>> = [];
  const store = new SqliteTaskStore(home, { databaseFilename, migration: true });
  try {
    store.transaction(() => {
      // Home identity + revision continuity.
      const identity = asNullableObject(state.homeIdentity) as HomeIdentity | null;
      const revision = typeof state.revision === "number" ? state.revision : 0;
      if (identity !== null) {
        store.migrationSetHomeMeta(identity, revision);
      }

      // Config singleton.
      const config = asNullableObject(state.config) as YuiConfig | null;
      if (config !== null) store.saveConfig(config);

      // Global record families.
      for (const agent of Object.values(asObjectMap(state.configuredAgents))) {
        store.saveConfiguredAgent(agent as unknown as ConfiguredAgent);
      }
      for (const project of Object.values(asObjectMap(state.projects))) {
        store.saveProject(project as unknown as Project);
      }
      for (const profile of Object.values(asObjectMap(state.agentProfiles))) {
        store.saveAgentProfile(profile as unknown as AgentProfile);
      }
      for (const role of Object.values(asObjectMap(state.globalRoles))) {
        store.saveGlobalRole(role as unknown as GlobalRole);
      }
      for (const sessions of Object.values(asObjectMap(state.globalRoleSessionSets))) {
        store.saveGlobalRoleSessionSet(sessions as unknown as GlobalRoleSessionSet);
      }

      // Tasks and their per-task families.
      const tasks = tasksOf(state);
      for (const [taskId, stored] of Object.entries(tasks)) {
        store.saveTask(stored.task as unknown as Task);
        if (stored.brief !== null) {
          store.saveTaskBrief(taskId, stored.brief as unknown as TaskBrief);
        }
        for (const role of Object.values(stored.roles)) {
          store.saveRole(taskId, role as unknown as TaskRole);
        }
        for (const workspace of Object.values(stored.managedWorkspaces)) {
          store.saveManagedWorkspace(workspace as unknown as ManagedWorkspace);
        }
        for (const sessions of Object.values(stored.roleSessionSets)) {
          store.saveRoleSessionSet(sessions as unknown as TaskRoleSessionSet);
        }
        for (const item of Object.values(stored.workItems)) {
          store.saveWorkItem(taskId, item as unknown as WorkItem);
        }
        for (const run of Object.values(stored.agentRuns)) {
          store.saveAgentRun(run as unknown as AgentRun);
        }
        for (const round of Object.values(stored.reviewRounds)) {
          store.saveReviewRound(taskId, round as unknown as ReviewRound);
        }
        for (const changeSet of Object.values(stored.changeSets)) {
          store.saveChangeSet(taskId, changeSet as unknown as ChangeSet);
        }
        for (const attempt of Object.values(stored.integrationAttempts)) {
          store.saveIntegrationAttempt(taskId, attempt as unknown as IntegrationAttempt);
        }
        for (const entry of Object.values(stored.integrationQueue)) {
          store.saveIntegrationQueueEntry(taskId, entry as unknown as IntegrationQueueEntry);
        }
        for (const job of Object.values(stored.durableJobs)) {
          store.saveDurableJob(taskId, job as unknown as DurableJob);
        }
        for (const [key, hash] of Object.entries(stored.jobCallerKeyHashes)) {
          const separator = key.indexOf("\0");
          if (separator <= 0 || separator === key.length - 1
            || key.indexOf("\0", separator + 1) !== -1) {
            throw new Error(
              `Job caller key hash identity is invalid: ${taskId}/${key}.`
            );
          }
          store.setJobCallerKeyHash(
            taskId,
            key.slice(0, separator),
            key.slice(separator + 1),
            hash
          );
        }
        // Active-run pointers: the document stores { schemaVersion, runId }
        // keyed by pointer; the store derives the pointer from the Run.
        for (const [pointer, value] of Object.entries(stored.activeRuns)) {
          if (stored.task.status === "retired") {
            retiredActiveRuns.push({
              taskId,
              pointer,
              value,
              updatedAt: typeof stored.task.updatedAt === "string"
                ? stored.task.updatedAt
                : new Date().toISOString()
            });
            continue;
          }
          const run = stored.agentRuns[value.runId];
          if (run === undefined) {
            throw new Error(
              `Active run pointer ${taskId}/${pointer} references missing agent run ${value.runId}.`
            );
          }
          if (pointer.startsWith("/execution-lane/")) {
            store.saveActiveExecutionLaneRun(run as unknown as AgentRun);
          } else {
            store.saveActiveAgentRun(run as unknown as AgentRun);
          }
        }
        for (const message of Object.values(stored.messages)) {
          store.saveMessage(taskId, message as unknown as TaskMessage);
        }
        for (const request of Object.values(stored.inputRequests)) {
          store.saveInputRequest(taskId, request as unknown as InputRequest);
        }
        for (const decision of Object.values(stored.decisions)) {
          store.saveDecision(taskId, decision as unknown as Decision);
        }
        for (const milestone of Object.values(stored.milestones)) {
          store.saveMilestone(taskId, milestone as unknown as Milestone);
        }
        for (const event of Object.values(stored.events)) {
          store.saveEvent(taskId, event as unknown as TaskEvent);
        }
        if (stored.leaderFailure !== null) {
          store.saveLeaderFailure(stored.leaderFailure as unknown as LeaderFailure);
        }
        if (stored.operatorNotification !== null) {
          store.saveOperatorNotification(stored.operatorNotification as unknown as OperatorNotification);
        }
        // Per-task ID high-water marks.
        for (const [kind, highWater] of Object.entries(stored.idHighWaterMarks)) {
          if (typeof highWater === "number" && Number.isFinite(highWater)) {
            store.migrationSeedIdSequence(taskId, kind, highWater);
          }
        }
        // Capability grants and release workflows (task-15 record families).
        for (const grant of Object.values(stored.capabilityGrants)) {
          store.saveCapabilityGrant(taskId, grant as unknown as CapabilityGrant);
        }
        for (const workflow of Object.values(stored.releaseWorkflows)) {
          store.saveReleaseWorkflow(taskId, workflow as unknown as ReleaseWorkflow);
        }
      }

      // Work mailboxes.
      for (const mailbox of Object.values(asObjectMap(state.mailboxes))) {
        store.saveWorkMailbox(mailbox as unknown as WorkMailbox);
      }

      // Global ID high-water marks, derived from existing task/project ids.
      seedGlobalSequences(store, state);
    });
  } finally {
    store.close();
  }
  persistRetiredActiveRunPointers(home, databaseFilename, retiredActiveRuns);
}

/**
 * A retired Task is an explicit isolation boundary. Its active-run rows are
 * retained byte-for-byte at the logical record level even when their Run is
 * missing; normal Tasks continue through the referentially strict store path.
 */
function persistRetiredActiveRunPointers(
  home: string,
  databaseFilename: string,
  pointers: readonly Readonly<{
    taskId: string;
    pointer: string;
    value: Readonly<{ schemaVersion: number; runId: string }>;
    updatedAt: string;
  }>[]
): void {
  if (pointers.length === 0) return;
  const db = new Database(join(home, databaseFilename));
  try {
    const insert = db.prepare(
      `INSERT INTO active_runs (task_id, pointer, run_id, payload, updated_at)
       VALUES (?, ?, ?, ?, ?)`
    );
    db.transaction(() => {
      for (const entry of pointers) {
        if (typeof entry.value.runId !== "string") {
          throw new Error(
            `Retired Task active run pointer ${entry.taskId}/${entry.pointer} `
            + "cannot be represented because runId is not a string."
          );
        }
        insert.run(
          entry.taskId,
          entry.pointer,
          entry.value.runId,
          JSON.stringify(entry.value),
          entry.updatedAt
        );
      }
    })();
  } finally {
    db.close();
  }
}

/**
 * Seed `global_sequences` from the numeric suffixes of existing task and
 * project ids so the next allocated id never collides with a historical one.
 * Ids that do not match `<kind>-<n>` are ignored (legacy formats).
 */
function seedGlobalSequences(store: SqliteTaskStore, state: Record<string, unknown>): void {
  const taskMax = maxIdSuffix(Object.keys(asObject(state.tasks)), "task");
  const projectMax = maxIdSuffix(Object.keys(asObject(state.projects)), "project");
  if (taskMax > 0) store.migrationSeedGlobalSequence("task", taskMax);
  if (projectMax > 0) store.migrationSeedGlobalSequence("project", projectMax);
}

function maxIdSuffix(ids: readonly string[], prefix: string): number {
  let max = 0;
  const pattern = new RegExp(`^${prefix}-(\\d+)$`, "u");
  for (const id of ids) {
    const match = pattern.exec(id);
    if (match !== null) {
      const value = Number.parseInt(match[1]!, 10);
      if (Number.isSafeInteger(value)) max = Math.max(max, value);
    }
  }
  return max;
}

// ---------------------------------------------------------------------------
// State-side checksums (the source of truth)
// ---------------------------------------------------------------------------

/**
 * Compute per-family checksums from the parsed `state.json` document. This is
 * the expected checksum set; the staged database is verified against it.
 */
export function computeStateFamilyChecksums(
  state: Record<string, unknown>
): FamilyChecksumMap {
  const checksums: Record<string, FamilyChecksum> = {};

  checksums.config = hashRecords(
    asNullableObject(state.config) === null ? [] : [asObject(state.config)]
  );
  checksums.configuredAgent = hashRecords(Object.values(asObjectMap(state.configuredAgents)));
  checksums.project = hashRecords(Object.values(asObjectMap(state.projects)));
  checksums.agentProfile = hashRecords(Object.values(asObjectMap(state.agentProfiles)));
  checksums.globalRole = hashRecords(Object.values(asObjectMap(state.globalRoles)));
  checksums.globalRoleSessionSet = hashRecords(
    Object.values(asObjectMap(state.globalRoleSessionSets))
  );

  // Flatten the per-task families across all tasks.
  const tasks = tasksOf(state);
  const taskRecords: unknown[] = [];
  const briefs: unknown[] = [];
  const roles: unknown[] = [];
  const workspaces: unknown[] = [];
  const roleSessionSets: unknown[] = [];
  const workItems: unknown[] = [];
  const agentRuns: unknown[] = [];
  const reviewRounds: unknown[] = [];
  const changeSets: unknown[] = [];
  const integrationAttempts: unknown[] = [];
  const integrationQueue: unknown[] = [];
  const durableJobs: unknown[] = [];
  const jobCallerKeyHashes: unknown[] = [];
  const activeRunPointers: unknown[] = [];
  const messages: unknown[] = [];
  const inputRequests: unknown[] = [];
  const decisions: unknown[] = [];
  const milestones: unknown[] = [];
  const events: unknown[] = [];
  const leaderFailures: unknown[] = [];
  const operatorNotifications: unknown[] = [];
  const capabilityGrants: unknown[] = [];
  const releaseWorkflows: unknown[] = [];

  for (const stored of Object.values(tasks)) {
    taskRecords.push(stored.task);
    if (stored.brief !== null) briefs.push(stored.brief);
    roles.push(...Object.values(stored.roles));
    workspaces.push(...Object.values(stored.managedWorkspaces));
    roleSessionSets.push(...Object.values(stored.roleSessionSets));
    workItems.push(...Object.values(stored.workItems));
    agentRuns.push(...Object.values(stored.agentRuns));
    reviewRounds.push(...Object.values(stored.reviewRounds));
    changeSets.push(...Object.values(stored.changeSets));
    integrationAttempts.push(...Object.values(stored.integrationAttempts));
    integrationQueue.push(...Object.values(stored.integrationQueue));
    durableJobs.push(...Object.values(stored.durableJobs));
    for (const [key, hash] of Object.entries(stored.jobCallerKeyHashes)) {
      const separator = key.indexOf("\0");
      if (separator <= 0 || separator === key.length - 1
        || key.indexOf("\0", separator + 1) !== -1) {
        throw new Error(
          `Job caller key hash identity is invalid: ${stored.task.id}/${key}.`
        );
      }
      jobCallerKeyHashes.push({
        taskId: stored.task.id,
        key,
        hash
      });
    }
    activeRunPointers.push(...Object.values(stored.activeRuns));
    messages.push(...Object.values(stored.messages));
    inputRequests.push(...Object.values(stored.inputRequests));
    decisions.push(...Object.values(stored.decisions));
    milestones.push(...Object.values(stored.milestones));
    events.push(...Object.values(stored.events));
    if (stored.leaderFailure !== null) leaderFailures.push(stored.leaderFailure);
    if (stored.operatorNotification !== null) operatorNotifications.push(stored.operatorNotification);
    capabilityGrants.push(...Object.values(stored.capabilityGrants));
    releaseWorkflows.push(...Object.values(stored.releaseWorkflows));
  }

  checksums.task = hashRecords(taskRecords);
  checksums.taskBrief = hashRecords(briefs);
  checksums.taskRole = hashRecords(roles);
  checksums.managedWorkspace = hashRecords(workspaces);
  checksums.taskRoleSessionSet = hashRecords(roleSessionSets);
  checksums.workItem = hashRecords(workItems);
  checksums.agentRun = hashRecords(agentRuns);
  checksums.reviewRound = hashRecords(reviewRounds);
  checksums.changeSet = hashRecords(changeSets);
  checksums.integrationAttempt = hashRecords(integrationAttempts);
  checksums.integrationQueue = hashRecords(integrationQueue);
  checksums.durableJob = hashRecords(durableJobs);
  checksums.jobCallerKeyHash = hashRecords(jobCallerKeyHashes);
  checksums.activeRunPointer = hashRecords(activeRunPointers);
  checksums.message = hashRecords(messages);
  checksums.inputRequest = hashRecords(inputRequests);
  checksums.decision = hashRecords(decisions);
  checksums.milestone = hashRecords(milestones);
  checksums.event = hashRecords(events);
  checksums.leaderFailure = hashRecords(leaderFailures);
  checksums.operatorNotification = hashRecords(operatorNotifications);
  checksums.capabilityGrant = hashRecords(capabilityGrants);
  checksums.releaseWorkflow = hashRecords(releaseWorkflows);

  checksums.workMailbox = hashRecords(Object.values(asObjectMap(state.mailboxes)));

  return checksums;
}

// ---------------------------------------------------------------------------
// Database-side checksums (the staged output)
// ---------------------------------------------------------------------------

interface PayloadRow {
  payload: string;
}

function hashPayloadTable(db: Database.Database, sql: string): FamilyChecksum {
  const rows = db.prepare(sql).all() as PayloadRow[];
  return hashRecords(rows.map((row) => JSON.parse(row.payload) as unknown));
}

/** Reconstruct a WorkMailbox from the normalised mailboxes table columns. */
export function rowToMailbox(row: {
  target_kind: string;
  task_id: string | null;
  role_name: string | null;
  next_sequence: number;
  processing: string | null;
  pending: string | null;
}): Record<string, unknown> {
  let target: Record<string, unknown>;
  switch (row.target_kind) {
    case "operator":
      target = { kind: "operator" };
      break;
    case "task":
      target = { kind: "task", taskId: row.task_id };
      break;
    case "role":
      target = { kind: "role", taskId: row.task_id, roleName: row.role_name };
      break;
    case "role-runtime":
      target = { kind: "role-runtime", taskId: row.task_id, roleName: row.role_name };
      break;
    case "global-role-runtime":
      target = { kind: "global-role-runtime", roleName: row.role_name };
      break;
    default:
      target = { kind: row.target_kind };
  }
  return {
    schemaVersion: 1,
    target,
    nextSequence: row.next_sequence,
    processing: row.processing === null ? null : JSON.parse(row.processing) as unknown,
    pending: row.pending === null ? null : JSON.parse(row.pending) as unknown
  };
}

/**
 * Compute per-family checksums from the SQLite database. The database is
 * opened read-only; this is the independent verification read.
 */
export function computeDbFamilyChecksums(
  home: string,
  databaseFilename: string
): FamilyChecksumMap {
  const dbPath = join(home, databaseFilename);
  const db = new Database(dbPath, { readonly: true });
  try {
    const checksums: Record<string, FamilyChecksum> = {};

    checksums.config = hashPayloadTable(db, "SELECT payload FROM config");
    checksums.configuredAgent = hashPayloadTable(db, "SELECT payload FROM configured_agents");
    checksums.project = hashPayloadTable(db, "SELECT payload FROM projects");
    checksums.agentProfile = hashPayloadTable(db, "SELECT payload FROM agent_profiles");
    checksums.globalRole = hashPayloadTable(db, "SELECT payload FROM global_roles");
    checksums.globalRoleSessionSet = hashPayloadTable(
      db,
      "SELECT payload FROM global_role_session_sets"
    );

    checksums.task = hashPayloadTable(db, "SELECT payload FROM task_records");
    checksums.taskBrief = hashPayloadTable(
      db,
      "SELECT brief AS payload FROM task_records WHERE brief IS NOT NULL"
    );
    checksums.taskRole = hashPayloadTable(db, "SELECT payload FROM task_roles");
    checksums.managedWorkspace = hashPayloadTable(db, "SELECT payload FROM managed_workspaces");
    checksums.taskRoleSessionSet = hashPayloadTable(db, "SELECT payload FROM role_session_sets");
    checksums.workItem = hashPayloadTable(db, "SELECT payload FROM work_items");
    checksums.agentRun = hashPayloadTable(db, "SELECT payload FROM agent_runs");
    checksums.reviewRound = hashPayloadTable(db, "SELECT payload FROM review_rounds");
    checksums.changeSet = hashPayloadTable(db, "SELECT payload FROM change_sets");
    checksums.integrationAttempt = hashPayloadTable(
      db,
      "SELECT payload FROM integration_attempts"
    );
    checksums.integrationQueue = hashPayloadTable(
      db,
      "SELECT payload FROM integration_queue"
    );
    checksums.durableJob = hashPayloadTable(
      db,
      "SELECT payload FROM durable_jobs"
    );
    const callerHashRows = db.prepare(
      "SELECT task_id, role_name, agent_id, hash FROM job_caller_key_hashes"
    ).all() as Array<{
      task_id: string;
      role_name: string;
      agent_id: string;
      hash: string;
    }>;
    checksums.jobCallerKeyHash = hashRecords(callerHashRows.map((row) => ({
      taskId: row.task_id,
      key: `${row.role_name}\0${row.agent_id}`,
      hash: row.hash
    })));
    checksums.activeRunPointer = hashPayloadTable(db, "SELECT payload FROM active_runs");
    checksums.message = hashPayloadTable(db, "SELECT payload FROM messages");
    checksums.inputRequest = hashPayloadTable(db, "SELECT payload FROM input_requests");
    checksums.decision = hashPayloadTable(db, "SELECT payload FROM decisions");
    checksums.milestone = hashPayloadTable(db, "SELECT payload FROM milestones");
    checksums.event = hashPayloadTable(db, "SELECT payload FROM events");
    checksums.leaderFailure = hashPayloadTable(
      db,
      "SELECT payload FROM task_projections WHERE kind = 'leader-failure' AND payload IS NOT NULL"
    );
    checksums.operatorNotification = hashPayloadTable(
      db,
      "SELECT payload FROM task_projections WHERE kind = 'operator-notification' AND payload IS NOT NULL"
    );
    checksums.capabilityGrant = hashPayloadTable(db, "SELECT payload FROM capability_grants");
    checksums.releaseWorkflow = hashPayloadTable(db, "SELECT payload FROM release_workflows");

    // Mailboxes are reconstructed from typed columns (no payload column).
    const mailboxRows = db.prepare(
      "SELECT target_kind, task_id, role_name, next_sequence, processing, pending FROM mailboxes ORDER BY target_key"
    ).all() as Array<{
      target_kind: string;
      task_id: string | null;
      role_name: string | null;
      next_sequence: number;
      processing: string | null;
      pending: string | null;
    }>;
    checksums.workMailbox = hashRecords(mailboxRows.map(rowToMailbox));

    return checksums;
  } finally {
    db.close();
  }
}

// ---------------------------------------------------------------------------
// Verification (Verify phase of §8.2)
// ---------------------------------------------------------------------------

/**
 * Compare the per-family checksums of the source document against those of the
 * staged database. Throws on any count or content mismatch, naming every
 * divergent family. The source document is never modified.
 */
export function verifySqliteChecksums(
  state: Record<string, unknown>,
  home: string,
  databaseFilename: string
): void {
  const expected = computeStateFamilyChecksums(state);
  const actual = computeDbFamilyChecksums(home, databaseFilename);
  const families = new Set([...Object.keys(expected), ...Object.keys(actual)]);
  const mismatches: string[] = [];
  for (const family of families) {
    const e = expected[family];
    const a = actual[family];
    if (e === undefined || a === undefined || e.count !== a.count || e.hash !== a.hash) {
      mismatches.push(
        `${family} (expected ${e === undefined ? "absent" : `${e.count}/${e.hash.slice(0, 12)}`}, ` +
        `found ${a === undefined ? "absent" : `${a.count}/${a.hash.slice(0, 12)}`})`
      );
    }
  }
  if (mismatches.length > 0) {
    throw new Error(
      `SQLite migration checksum mismatch for ${mismatches.length} family/families: ${mismatches.join("; ")}`
    );
  }
}

// ---------------------------------------------------------------------------
// SQLite -> Snapshot reconstruction (record-migration source, Issue 01 Phase 2)
// ---------------------------------------------------------------------------

/**
 * Reconstruct the state.json-shaped snapshot from a committed SQLite database.
 *
 * This is the reverse of {@link populateSqliteFromState}: it reads every
 * record family from `yui.db` and rebuilds the nested document shape the
 * generic migration engine's record transforms operate on. Payloads are read
 * RAW (`JSON.parse` without the strict current-version parsers) so a record
 * family at an older persisted version survives the round-trip with its
 * original `schemaVersion` intact — the strict parsers only understand the
 * current version and would reject the very records the migration is meant to
 * transform.
 *
 * The database is opened read-only; this function never writes.
 */
export function readStateFromSqlite(home: string): Record<string, unknown> {
  const dbPath = join(home, COMMITTED_DATABASE_FILENAME);
  const db = new Database(dbPath, { readonly: true });
  try {
    const manifest = readStorageSchemaManifest(home);
    const storedTaskVersion = typeof manifest.recordVersions?.storedTask === "number"
      ? manifest.recordVersions.storedTask
      : CURRENT_STORED_TASK_SCHEMA_VERSION;

    // Home identity + revision continuity.
    const meta = db.prepare(
      "SELECT home_identity, revision FROM home_meta WHERE id = 1"
    ).get() as { home_identity: string; revision: number };

    const state: Record<string, unknown> = {
      // The state document's `schemaVersion` is the Yui aggregate version,
      // sourced from the durable manifest (the version contract). The
      // `home_meta.aggregate_version` column is the SQLite database's own
      // schema version (SQLITE_AGGREGATE_VERSION), a different fact.
      schemaVersion: manifest.aggregateSchemaVersion,
      revision: meta.revision,
      homeIdentity: JSON.parse(meta.home_identity) as unknown,
      configuredAgents: {},
      projects: {},
      agentProfiles: {},
      globalRoles: {},
      globalRoleSessionSets: {},
      tasks: {},
      mailboxes: {}
    };

    // Config singleton (absent on a fresh, never-configured Home).
    const configRow = db.prepare("SELECT payload FROM config WHERE id = 1").get() as
      | { payload: string }
      | undefined;
    if (configRow !== undefined) {
      state.config = JSON.parse(configRow.payload) as unknown;
    }

    // Global record families.
    loadGlobalPayloadMap(db, "configured_agents", state, "configuredAgents", (record) => record.id as string);
    loadGlobalPayloadMap(db, "projects", state, "projects", (record) => record.id as string);
    loadGlobalPayloadMap(db, "agent_profiles", state, "agentProfiles", (record) => record.id as string);
    loadGlobalPayloadMap(db, "global_roles", state, "globalRoles", (record) => record.name as string);
    loadGlobalPayloadMap(
      db,
      "global_role_session_sets",
      state,
      "globalRoleSessionSets",
      (record) => (record.owner as Record<string, unknown>).roleName as string
    );

    // Tasks: the StoredTask aggregate wrapper. The wrapper `schemaVersion` is
    // not persisted in the database (records live in flat tables), so it is
    // taken from the manifest's declared `storedTask` version — the version
    // the database was created with — so the version scanner and the migration
    // engine see a consistent source.
    const tasks = state.tasks as Record<string, Record<string, unknown>>;
    const taskRows = db.prepare(
      "SELECT task_id, payload, brief FROM task_records"
    ).all() as Array<{ task_id: string; payload: string; brief: string | null }>;
    for (const row of taskRows) {
      tasks[row.task_id] = {
        schemaVersion: storedTaskVersion,
        task: JSON.parse(row.payload) as unknown,
        brief: row.brief === null ? null : (JSON.parse(row.brief) as unknown),
        roles: {},
        managedWorkspaces: {},
        roleSessionSets: {},
        workItems: {},
        agentRuns: {},
        reviewRounds: {},
        changeSets: {},
        integrationAttempts: {},
        integrationQueue: {},
        durableJobs: {},
        jobCallerKeyHashes: {},
        activeRuns: {},
        messages: {},
        inputRequests: {},
        decisions: {},
        milestones: {},
        events: {},
        leaderFailure: null,
        operatorNotification: null,
        idHighWaterMarks: {},
        capabilityGrants: {},
        releaseWorkflows: {}
      };
    }

    // Per-task record families, keyed by their state.json map keys.
    loadTaskPayloadMap(db, "task_roles", tasks, "roles", (record) => record.name as string);
    loadTaskPayloadMap(
      db,
      "managed_workspaces",
      tasks,
      "managedWorkspaces",
      (record) => managedWorkspaceKey(record.owner as ManagedWorkspaceOwner)
    );
    loadTaskPayloadMap(
      db,
      "role_session_sets",
      tasks,
      "roleSessionSets",
      (record) => (record.owner as Record<string, unknown>).roleName as string
    );
    loadTaskPayloadMap(db, "work_items", tasks, "workItems", (record) => record.id as string);
    loadTaskPayloadMap(db, "agent_runs", tasks, "agentRuns", (record) => record.id as string);
    loadTaskPayloadMap(db, "review_rounds", tasks, "reviewRounds", (record) => record.id as string);
    loadTaskPayloadMap(db, "change_sets", tasks, "changeSets", (record) => record.id as string);
    loadTaskPayloadMap(
      db,
      "integration_attempts",
      tasks,
      "integrationAttempts",
      (record) => record.id as string
    );
    loadTaskPayloadMap(
      db,
      "integration_queue",
      tasks,
      "integrationQueue",
      (record) => record.id as string
    );
    loadTaskPayloadMap(db, "durable_jobs", tasks, "durableJobs", (record) => record.id as string);
    loadTaskPayloadMap(db, "messages", tasks, "messages", (record) => record.id as string);
    loadTaskPayloadMap(db, "input_requests", tasks, "inputRequests", (record) => record.id as string);
    loadTaskPayloadMap(db, "decisions", tasks, "decisions", (record) => record.id as string);
    loadTaskPayloadMap(db, "milestones", tasks, "milestones", (record) => record.id as string);
    loadTaskPayloadMap(db, "events", tasks, "events", (record) => record.id as string);
    loadTaskPayloadMap(
      db,
      "capability_grants",
      tasks,
      "capabilityGrants",
      (record) => record.id as string
    );
    loadTaskPayloadMap(
      db,
      "release_workflows",
      tasks,
      "releaseWorkflows",
      (record) => record.id as string
    );

    // Job caller key hashes: keyed by `${roleName}\0${agentId}`.
    const callerHashRows = db.prepare(
      "SELECT task_id, role_name, agent_id, hash FROM job_caller_key_hashes"
    ).all() as Array<{ task_id: string; role_name: string; agent_id: string; hash: string }>;
    for (const row of callerHashRows) {
      const stored = requireTaskAggregate(tasks, row.task_id, "jobCallerKeyHashes");
      (stored.jobCallerKeyHashes as Record<string, string>)[`${row.role_name}\0${row.agent_id}`] = row.hash;
    }

    // Active-run pointers: keyed by pointer, value is the persisted payload.
    const activeRunRows = db.prepare(
      "SELECT task_id, pointer, payload FROM active_runs"
    ).all() as Array<{ task_id: string; pointer: string; payload: string }>;
    for (const row of activeRunRows) {
      const stored = requireTaskAggregate(tasks, row.task_id, "activeRuns");
      (stored.activeRuns as Record<string, unknown>)[row.pointer] = JSON.parse(row.payload) as unknown;
    }

    // Leader failure / operator notification projections.
    const projectionRows = db.prepare(
      "SELECT task_id, kind, payload FROM task_projections WHERE payload IS NOT NULL"
    ).all() as Array<{ task_id: string; kind: string; payload: string }>;
    for (const row of projectionRows) {
      const stored = requireTaskAggregate(tasks, row.task_id, row.kind);
      if (row.kind === "leader-failure") {
        stored.leaderFailure = JSON.parse(row.payload) as unknown;
      } else {
        stored.operatorNotification = JSON.parse(row.payload) as unknown;
      }
    }

    // Per-task ID high-water marks.
    const idSeqRows = db.prepare(
      "SELECT task_id, kind, high_water FROM id_sequences"
    ).all() as Array<{ task_id: string; kind: string; high_water: number }>;
    for (const row of idSeqRows) {
      const stored = requireTaskAggregate(tasks, row.task_id, "idHighWaterMarks");
      (stored.idHighWaterMarks as Record<string, number>)[row.kind] = row.high_water;
    }

    // Work mailboxes: reconstructed from typed columns (no payload column).
    const mailboxRows = db.prepare(
      "SELECT target_kind, task_id, role_name, next_sequence, processing, pending FROM mailboxes ORDER BY target_key"
    ).all() as Array<{
      target_kind: string;
      task_id: string | null;
      role_name: string | null;
      next_sequence: number;
      processing: string | null;
      pending: string | null;
    }>;
    const mailboxes = state.mailboxes as Record<string, unknown>;
    for (const row of mailboxRows) {
      const mailbox = rowToMailbox(row);
      mailboxes[mailboxTargetKey(mailbox.target as MailboxTarget)] = mailbox;
    }

    return state;
  } finally {
    db.close();
  }
}

/** Load a global (non-task-scoped) payload table into a keyed map on `state`. */
function loadGlobalPayloadMap(
  db: Database.Database,
  table: string,
  state: Record<string, unknown>,
  stateKey: string,
  keyOf: (record: Record<string, unknown>) => string
): void {
  const rows = db.prepare(`SELECT payload FROM ${table}`).all() as Array<{ payload: string }>;
  const target = state[stateKey] as Record<string, unknown>;
  for (const row of rows) {
    const record = JSON.parse(row.payload) as Record<string, unknown>;
    target[keyOf(record)] = record;
  }
}

/** Load a task-scoped payload table into the matching family map of each task. */
function loadTaskPayloadMap(
  db: Database.Database,
  table: string,
  tasks: Record<string, Record<string, unknown>>,
  familyKey: string,
  keyOf: (record: Record<string, unknown>) => string
): void {
  const rows = db.prepare(`SELECT task_id, payload FROM ${table}`).all() as Array<{
    task_id: string;
    payload: string;
  }>;
  for (const row of rows) {
    const stored = requireTaskAggregate(tasks, row.task_id, table);
    const family = stored[familyKey] as Record<string, unknown>;
    const record = JSON.parse(row.payload) as Record<string, unknown>;
    family[keyOf(record)] = record;
  }
}

/** Resolve a task's StoredTask aggregate, or throw on an orphaned child row. */
function requireTaskAggregate(
  tasks: Record<string, Record<string, unknown>>,
  taskId: string,
  context: string
): Record<string, unknown> {
  const stored = tasks[taskId];
  if (stored === undefined) {
    throw new Error(
      `SQLite reconstruction found ${context} row for unknown task ${taskId}.`
    );
  }
  return stored;
}
