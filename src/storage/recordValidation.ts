import { validateConfiguredAgent } from "../agent/agent.js";
import { validateRun } from "../agentRun/agentRun.js";
import { validateContextSnapshot } from "../context/contextSnapshot.js";
import { validateDecision } from "../decision/decision.js";
import { validateTaskEvent } from "../event/taskEvent.js";
import { validateRoleSessionSet, type RoleSessionSet } from "../executor/agentExecutor.js";
import { validateInputRequest } from "../input/inputRequest.js";
import { validateChangeSet, type ChangeSet } from "../integration/changeSet.js";
import { validateIntegrationAttempt } from "../integration/integrationAttempt.js";
import { validateDurableJob } from "../job/durableJob.js";
import { validateGlobalRoleMessage, validateTaskMessage } from "../message/message.js";
import { validateMilestone } from "../milestone/milestone.js";
import { validatePluginIntent } from "../plugins/pluginIntent.js";
import { validatePluginValidation } from "../plugins/pluginPackage.js";
import { validateAgentProfile } from "../profile/agentProfile.js";
import { validateProject } from "../repository/project.js";
import { validateEnvironmentPreparation, validateLocalResource } from "../resources/projectResource.js";
import { validateReviewRound } from "../review/reviewRound.js";
import { validateGlobalRole, validateTaskRole } from "../role/role.js";
import { createSessionOwnerIdentity, type SessionOwnerIdentity } from "../runtime/sessionOwnerIdentity.js";
import { validateTaskWake } from "../scheduler/taskWake.js";
import { validateTask } from "../task/task.js";
import { validateGateArtifact } from "../verification/gateArtifact.js";
import { validateWorkItem } from "../workItem/workItem.js";
import { validateManagedWorkspace } from "../worktree/managedWorkspace.js";
import { StorageRecordError, storedCapabilityGrant, storedPublicationReference, storedReleaseWorkflow } from "./taskStore.js";

const check = <T>(validate: (record: T) => unknown): ((record: unknown) => void) =>
  record => { validate(record as T); };

/** One current domain contract for saves, reads and explicit Home diagnostics.
 * Protocol-specific metadata/outbox/telemetry have their own readers. This is
 * validation only: historical formats belong exclusively to migrations. */
const validators = {
  task_records: check(validateTask),
  work_items: check(validateWorkItem),
  configured_agents: check(validateConfiguredAgent),
  agent_profiles: check(validateAgentProfile),
  projects: check(validateProject),
  task_roles: check(validateTaskRole),
  global_roles: check(validateGlobalRole),
  role_session_sets: check<RoleSessionSet>(validateRoleSessionSet),
  global_role_session_sets: check<RoleSessionSet>(validateRoleSessionSet),
  messages: check(validateTaskMessage),
  global_role_messages: check(validateGlobalRoleMessage),
  turns: check(validateRun),
  review_rounds: check(validateReviewRound),
  change_sets: check<ChangeSet>(validateChangeSet),
  integration_attempts: check(validateIntegrationAttempt),
  durable_jobs: check(validateDurableJob),
  context_snapshots: check(validateContextSnapshot),
  managed_workspaces: check(validateManagedWorkspace),
  input_requests: check(validateInputRequest),
  decisions: check(validateDecision),
  milestones: check(validateMilestone),
  events: check(validateTaskEvent),
  task_wakes: check(validateTaskWake),
  gate_artifacts: check(validateGateArtifact),
  capability_grants: check(storedCapabilityGrant),
  release_workflows: check(storedReleaseWorkflow),
  publication_references: check(storedPublicationReference),
  local_resources: check(validateLocalResource),
  environment_preparations: check(validateEnvironmentPreparation),
  plugin_intents: check(validatePluginIntent),
  plugin_validations: check(validatePluginValidation),
  session_owners: check((record: SessionOwnerIdentity) => {
    if (record.schemaVersion !== 2 || record.kind !== "yui-session-owner" || Object.hasOwn(record, "launchId")) {
      throw new Error("Session owner identity is invalid.");
    }
    createSessionOwnerIdentity({ ...record, recordedAt: new Date(record.recordedAt) });
  })
} as const;

export type StoredRecordTable = keyof typeof validators;
export const STORED_RECORD_TABLES = Object.freeze(Object.keys(validators) as StoredRecordTable[]);

export function validateStoredRecord(table: string, record: unknown): void {
  if (!Object.hasOwn(validators, table)) return;
  try {
    if (record === null || typeof record !== "object" || Array.isArray(record)) {
      throw new Error("Record must be an object.");
    }
    validators[table as StoredRecordTable](record);
  } catch (error) {
    const fields = record !== null && typeof record === "object" ? record as Record<string, unknown> : {};
    const identity = [fields.taskId, fields.id ?? fields.name ?? fields.pluginId]
      .filter((value): value is string => typeof value === "string")
      .map(value => JSON.stringify(value.slice(0, 160))).join("/");
    throw new StorageRecordError(`Invalid ${table} record${identity ? ` ${identity}` : ""}: ${error instanceof Error ? error.message : String(error)}`);
  }
}
