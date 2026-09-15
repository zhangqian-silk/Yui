import type Database from "better-sqlite3";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import type { IntegrationAttempt } from "../../integration/integrationAttempt.js";
import { durableJobIdempotencyKey, type DurableJob } from "../../job/durableJob.js";
import type { Project } from "../../repository/project.js";
import type { Task } from "../../task/task.js";
import { resolveHistoricalVerificationPlan } from "./verificationPlanV1.js";
import type { ManagedWorkspace } from "../../worktree/managedWorkspace.js";
import {
  historicalGateJobSteps,
  historicalVerificationPlanDigest
} from "./historicalVerificationPlan.js";

/** Classify only known v19 Git conflicts. Manual strategy and CAS blockers
 * keep their meaning. Never synthesize candidate/Job success or edit history. */
export function migrateIntegrationContinuation(db: Database.Database): void {
  const rows = db.prepare("SELECT task_id, integration_id, payload FROM integration_attempts").all() as {
    task_id: string; integration_id: string; payload: string;
  }[];
  const update = db.prepare("UPDATE integration_attempts SET status = ?, payload = ? WHERE task_id = ? AND integration_id = ?");
  for (const row of rows) {
    const attempt = JSON.parse(row.payload);
    if (attempt.schemaVersion !== 6) continue;
    const proven = migrateBoundFastForward(db, attempt);
    if (proven !== undefined) {
      update.run(proven.status, JSON.stringify(proven), row.task_id, row.integration_id);
      continue;
    }
    if (attempt.status !== "blocked") continue;
    const source = attempt.source;
    const summary = attempt.conflict?.summary;
    if (typeof summary !== "string") continue;
    const ordinary = (source?.kind === "upstream" && source.strategy === "rebase"
      && summary.startsWith("Upstream rebase conflicts"))
      || (source?.kind === "work-item" && source.strategy === "merge"
        && summary.startsWith("WorkItem merge conflicts"))
      || (source?.kind === "work-item" && source.strategy === "cherry-pick"
        && summary.startsWith(`WorkItem ${source.workItemId} commit `)
        && summary.includes(" conflicts with "));
    if (!ordinary) continue;
    update.run("conflicted", JSON.stringify({ ...attempt, status: "conflicted" }), row.task_id, row.integration_id);
  }
}

/** v19 bound a Job only after successful source application. For FF, its
 * exact checked head IS the immutable source result, so the existing records
 * prove application without inventing a reflog action or a successful result.
 * Other old source strategies need evidence not available in these DB records.
 * Keep this interpretation at the migration boundary, never in runtime reads. */
function migrateBoundFastForward(db: Database.Database, attempt: IntegrationAttempt): IntegrationAttempt | undefined {
  if (!["running", "validating"].includes(attempt.status) || attempt.jobId === undefined
    || attempt.source.kind !== "work-item" || attempt.source.strategy !== "ff") return;
  const read = <T>(sql: string, ...keys: string[]): T | undefined => {
    const row = db.prepare(sql).get(...keys) as { payload: string } | undefined;
    return row === undefined ? undefined : JSON.parse(row.payload) as T;
  };
  const task = read<Task>("SELECT payload FROM task_records WHERE task_id = ?", attempt.taskId);
  const project = read<Project>("SELECT payload FROM projects WHERE id = ?", attempt.projectId);
  const job = read<DurableJob>("SELECT payload FROM durable_jobs WHERE task_id = ? AND job_id = ?", attempt.taskId, attempt.jobId);
  const workspaces = (db.prepare("SELECT payload FROM managed_workspaces WHERE task_id = ?").all(attempt.taskId) as { payload: string }[])
    .map(row => JSON.parse(row.payload) as ManagedWorkspace);
  const workspace = workspaces.find(w => w.owner.type === "integration-attempt"
    && w.owner.taskId === attempt.taskId && w.owner.integrationAttemptId === attempt.id);
  const main = workspaces.find(w => w.owner.type === "task" && w.owner.taskId === attempt.taskId);
  const entry = workspace?.entries.find(e => e.projectId === attempt.projectId && e.access === "write");
  const mainEntry = main?.entries.find(e => e.projectId === attempt.projectId && e.access === "write");
  const binding = task?.projectBindings.find(b => b.projectId === attempt.projectId);
  if (task?.id !== attempt.taskId || project?.id !== attempt.projectId || binding === undefined
    || workspace === undefined || entry === undefined || mainEntry === undefined
    || workspace.entries.length !== 1 || entry.path !== workspace.root
    || entry.baseCommit !== attempt.beforeCommit
    || job?.id !== attempt.jobId || job.taskId !== attempt.taskId
    || job.owner.kind !== "integration-attempt" || job.owner.integrationAttemptId !== attempt.id
    || job.projectId !== attempt.projectId || job.workspace !== workspace.root
    || job.operation.targetId !== job.workspace
    || job.head !== attempt.source.resultCommit
    || (attempt.candidateCommit !== undefined && attempt.candidateCommit !== job.head)
    || job.operation.inputDigest !== durableJobIdempotencyKey(job)) return;
  let steps = attempt.checkCommands.map((command, index) => ({
    name: `check-${index + 1}`, command, timeoutMs: 30 * 60_000
  }));
  if (attempt.gatePlanDigest !== undefined) {
    const plan = resolveHistoricalVerificationPlan(project);
    if (plan === undefined || historicalVerificationPlanDigest(plan) !== attempt.gatePlanDigest) return;
    steps = historicalGateJobSteps(plan).map(step => ({
      ...step, timeoutMs: 30 * 60_000
    }));
  }
  const inputDigest = durableJobIdempotencyKey(job);
  if (inputDigest !== durableJobIdempotencyKey({ ...job, steps })) return;
  const branch = entry.branch;
  return {
    ...attempt,
    candidateCommit: job.head,
    checkInputDigest: inputDigest,
    sourceProgress: {
      workspace: resolve(workspace.root), branch: fullRef(branch), head: job.head,
      completedSteps: 1,
      sourceDigest: createHash("sha256").update(JSON.stringify([
        attempt.taskId, attempt.id, attempt.projectId, attempt.targetRef,
        attempt.beforeCommit, attempt.source, resolve(workspace.root), branch
      ])).digest("hex")
    }
  };
}

function fullRef(branch: string): string {
  return branch.startsWith("refs/") ? branch : `refs/heads/${branch}`;
}
