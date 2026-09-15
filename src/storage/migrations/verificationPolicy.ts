import type Database from "better-sqlite3";
import { resolveHistoricalVerificationPlan } from "./verificationPlanV1.js";
import type { Project } from "../../repository/project.js";

/** Read-only: an admitted old gate keeps its original plan identity until it
 * settles. The cutover never relabels a running Job or replays its checks. */
export function preflightVerificationPolicy(db: Database.Database): void {
  const active = db.prepare(`SELECT task_id, integration_id FROM integration_attempts
    WHERE status IN ('running','validating')
      AND json_type(payload,'$.gatePlanDigest') IS NOT NULL LIMIT 1`)
    .get() as { task_id: string; integration_id: string } | undefined;
  if (active !== undefined) {
    throw new Error(`Verification policy cutover requires the admitted gate to settle: ${active.task_id}/${active.integration_id}. Preserve its Job and continue it with the current release before upgrading.`);
  }
}

/** Frozen 32→33 policy cutover. Only declared configuration representations
 * change; old execution artifacts/Job results and their logs remain evidence. */
export function migrateVerificationPolicy(db: Database.Database): void {
  preflightVerificationPolicy(db);
  const configRow = db.prepare("SELECT payload FROM config WHERE id=1").get() as { payload: string } | undefined;
  if (configRow !== undefined) {
    const config = JSON.parse(configRow.payload);
    const mode = config.leaderNextActionMode;
    const budget = config.leaderSemanticBudgetRuns;
    if ((mode != null && (typeof mode !== "string"
      || !["", "display", "warn", "enforce"].includes(mode.trim().toLowerCase())))
      || (budget != null && (!Number.isSafeInteger(budget) || budget < 1 || budget > 20))) {
      throw new Error("Invalid retired Leader policy; preserve the config for diagnosis.");
    }
  }
  const projects = db.prepare("SELECT id,payload FROM projects").all() as Array<{ id: string; payload: string }>;
  const saveProject = db.prepare("UPDATE projects SET payload=? WHERE id=?");
  for (const row of projects) {
    const project = JSON.parse(row.payload) as Project;
    // This frozen reader preserves validation and duplicate-plan rejection.
    resolveHistoricalVerificationPlan(project);
    let changed = false;
    const knowledge = project.knowledge.map(entry => {
      if (entry.status !== "active") return entry;
      let value: unknown;
      try { value = JSON.parse(entry.body); } catch { return entry; }
      if (typeof value !== "object" || value === null
        || (value as { kind?: unknown }).kind !== "verification-plan") return entry;
      const { mode: _mode, ...plan } = value as Record<string, unknown>;
      changed = true;
      return { ...entry, body: JSON.stringify({ ...plan, schemaVersion: 1 }) };
    });
    if (changed) saveProject.run(JSON.stringify({ ...project, knowledge }), row.id);
  }
  const invalidRerun = db.prepare(`SELECT task_id,integration_id FROM integration_attempts
    WHERE json_type(payload,'$.rerunChecks') IS NOT NULL
      AND json_type(payload,'$.rerunChecks') NOT IN ('true','false') LIMIT 1`).get();
  if (invalidRerun !== undefined) throw new Error("Invalid Integration check execution intent; preserve the record.");
  const artifacts = db.prepare(`SELECT key,payload FROM gate_artifacts
    WHERE json_type(payload,'$.potentialReuseCount') IS NOT NULL`).all() as Array<{ key: string; payload: string }>;
  for (const artifact of artifacts) {
    const count = JSON.parse(artifact.payload).potentialReuseCount;
    if (!Number.isSafeInteger(count) || count < 0) {
      throw new Error(`Invalid historical verification counter: ${artifact.key}. Preserve the artifact for diagnosis.`);
    }
  }
  db.exec(`
    UPDATE config SET payload=json_remove(payload,'$.leaderNextActionMode','$.leaderSemanticBudgetRuns');
    UPDATE integration_attempts SET payload=json_set(payload,'$.rerunChecks',json('false'))
      WHERE json_type(payload,'$.rerunChecks') IS NULL;
    UPDATE gate_artifacts SET payload=json_remove(payload,'$.potentialReuseCount');
  `);
}
