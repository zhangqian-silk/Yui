import type { DurableJob } from "../job/durableJob.js";
import type { CheckResult } from "./checkResult.js";
import type { IntegrationAttempt } from "./integrationAttempt.js";

/** Internal, Controller-derived release fence carried by Integration jobs. */
export const INTEGRATION_RUNTIME_RELEASE_ENV = "YUI_INTEGRATION_RUNTIME_RELEASE_ID";

export type ReusableIntegrationCheckEvidence = Readonly<{
  sourceAttempt: IntegrationAttempt;
  sourceJob: DurableJob;
  checks: readonly CheckResult[];
}>;

/**
 * Find exact reusable evidence without creating cache state. Every identity
 * field is read from the existing IntegrationAttempt and DurableJob records.
 */
export function findReusableIntegrationCheckEvidence(input: Readonly<{
  taskId: string;
  projectId: string;
  currentAttemptId: string;
  candidateCommit: string;
  checkCommands: readonly string[];
  runtimeReleaseId: string;
  attempts: readonly IntegrationAttempt[];
  jobs: readonly DurableJob[];
  logExists?: (path: string) => boolean;
  logPathFor?: (job: DurableJob, relativeLogPath: string) => string;
}>): ReusableIntegrationCheckEvidence | null {
  const attempts = [...input.attempts]
    .filter((attempt) => (
      attempt.taskId === input.taskId
      && attempt.id !== input.currentAttemptId
      && attempt.projectId === input.projectId
      && sameOrderedText(attempt.checkCommands, input.checkCommands)
    ))
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  for (const attempt of attempts) {
    if (attempt.jobId === undefined) continue;
    const job = input.jobs.find((candidate) => (
      candidate.id === attempt.jobId
      && candidate.taskId === input.taskId
      && candidate.owner.kind === "integration-attempt"
      && candidate.owner.integrationAttemptId === attempt.id
    ));
    const resultSteps = job?.result?.steps ?? [];
    const logPaths = resultSteps.map((step) => (
      input.logPathFor?.(job!, step.logPath) ?? step.logPath
    ));
    if (job === undefined
      || job.projectId !== input.projectId
      || job.head !== input.candidateCommit
      || job.status !== "succeeded"
      || job.result?.outcome !== "succeeded"
      || job.env[INTEGRATION_RUNTIME_RELEASE_ENV] !== input.runtimeReleaseId
      || job.steps.length !== input.checkCommands.length
      || job.steps.some((step, index) => (
        step.name !== `check-${index + 1}`
        || step.command !== input.checkCommands[index]
      ))
      || resultSteps.length !== input.checkCommands.length
      || resultSteps.some((step, index) => (
        step.name !== `check-${index + 1}`
        || step.exitCode !== 0
        || step.signal !== null
        || step.timedOut
        || step.head !== input.candidateCommit
        || (input.logExists !== undefined && !input.logExists(logPaths[index]!))
      ))) {
      continue;
    }
    const checks: CheckResult[] = resultSteps.map((step, index) => ({
      name: input.checkCommands[index]!,
      outcome: "passed",
      details: `Reused successful check evidence from ${attempt.id}/${job.id}.`,
      logPath: logPaths[index]!
    }));
    return Object.freeze({ sourceAttempt: attempt, sourceJob: job, checks });
  }
  return null;
}

function sameOrderedText(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}
