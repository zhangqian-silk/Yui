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
import type { WorkMailbox } from "../../coordination/workMailbox.js";
import type { Decision } from "../../decision/decision.js";
import type { TaskEvent } from "../../event/taskEvent.js";
import type { InputRequest } from "../../input/inputRequest.js";
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
import type { LeaderFailure } from "../../scheduler/leaderFailure.js";
import type { OperatorNotification } from "../../scheduler/operatorNotification.js";
import type { Task } from "../../task/task.js";
import type { WorkItem } from "../../workItem/workItem.js";
import type { ManagedWorkspace } from "../../worktree/managedWorkspace.js";
import { SqliteTaskStore } from "../sqliteStore.js";
import type { YuiConfig } from "../taskStore.js";

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
  activeRuns: Record<string, { schemaVersion: number; runId: string }>;
  messages: Record<string, Record<string, unknown>>;
  inputRequests: Record<string, Record<string, unknown>>;
  decisions: Record<string, Record<string, unknown>>;
  milestones: Record<string, Record<string, unknown>>;
  events: Record<string, Record<string, unknown>>;
  leaderFailure: Record<string, unknown> | null;
  operatorNotification: Record<string, unknown> | null;
  idHighWaterMarks: Record<string, number>;
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
    activeRuns: asObjectMap(record.activeRuns) as unknown as Record<string, { schemaVersion: number; runId: string }>,
    messages: asObjectMap(record.messages),
    inputRequests: asObjectMap(record.inputRequests),
    decisions: asObjectMap(record.decisions),
    milestones: asObjectMap(record.milestones),
    events: asObjectMap(record.events),
    leaderFailure: asNullableObject(record.leaderFailure),
    operatorNotification: asNullableObject(record.operatorNotification),
    idHighWaterMarks: asObject(record.idHighWaterMarks) as Record<string, number>
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
        // Active-run pointers: the document stores { schemaVersion, runId }
        // keyed by pointer; the store derives the pointer from the Run.
        for (const [pointer, value] of Object.entries(stored.activeRuns)) {
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
  const activeRunPointers: unknown[] = [];
  const messages: unknown[] = [];
  const inputRequests: unknown[] = [];
  const decisions: unknown[] = [];
  const milestones: unknown[] = [];
  const events: unknown[] = [];
  const leaderFailures: unknown[] = [];
  const operatorNotifications: unknown[] = [];

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
    activeRunPointers.push(...Object.values(stored.activeRuns));
    messages.push(...Object.values(stored.messages));
    inputRequests.push(...Object.values(stored.inputRequests));
    decisions.push(...Object.values(stored.decisions));
    milestones.push(...Object.values(stored.milestones));
    events.push(...Object.values(stored.events));
    if (stored.leaderFailure !== null) leaderFailures.push(stored.leaderFailure);
    if (stored.operatorNotification !== null) operatorNotifications.push(stored.operatorNotification);
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
  checksums.activeRunPointer = hashRecords(activeRunPointers);
  checksums.message = hashRecords(messages);
  checksums.inputRequest = hashRecords(inputRequests);
  checksums.decision = hashRecords(decisions);
  checksums.milestone = hashRecords(milestones);
  checksums.event = hashRecords(events);
  checksums.leaderFailure = hashRecords(leaderFailures);
  checksums.operatorNotification = hashRecords(operatorNotifications);

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
function rowToMailbox(row: {
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
