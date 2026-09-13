import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import {
  lstat,
  mkdir,
  open,
  rm,
  stat
} from "node:fs/promises";
import {
  dirname,
  join,
  relative,
  resolve,
  sep
} from "node:path";
import { promisify } from "node:util";

import { selectEnvironment } from "../agent/launchEnvironment.js";
import { controllerSocketPath } from "../core/controllerEndpoint.js";
import { durableJobIdempotencyKey, type DurableJob, type DurableJobStep } from "../job/durableJob.js";
import { readRuntimeIdentity } from "../release/runtimeRelease.js";
import type { GitWorkspaceRemoval } from "../repository/gitWorkspace.js";
import {
  NodeGitWorkspace,
  type GitWorkspacePort
} from "../repository/gitWorkspace.js";
import { acquireProjectMaintenanceLocks } from "../repository/projectMaintenanceLock.js";
import { taskWorkspaceRefSegment } from "../repository/taskWorkspaceIdentity.js";
import { integrationWorkspaceRoot } from "../repository/taskWorkspacePreparer.js";
import { ResourceRegistrar } from "../resources/resourceRegistrar.js";
import {
  FileTaskRuntimeIsolation,
  type TaskRuntimeIsolationPort,
  type TaskRuntimeIsolationPreparation
} from "../runtime/taskRuntimeIsolation.js";
import { managedIntegrationRuntimeRoot } from "../storage/homeLayout.js";
import type { TaskStore } from "../storage/taskStore.js";
import { advanceTaskProjectCommit } from "../task/task.js";
import { yuiTmuxServerName } from "../tmux/tmuxManager.js";
import {
  recordGateArtifactPotentialReuse,
  recordGateArtifactReuse
} from "../verification/gateArtifact.js";
import { touchGateArtifact } from "../verification/gateArtifactStore.js";
import {
  assertNoAdHocFullSuiteChecks,
  checkResultsFromGateArtifact,
  checkResultsFromGateJob,
  gateIdentityForCandidate,
  lookupReusableGateArtifact,
  recordGateArtifactFromJob,
  recordGateArtifactFromStepOutcomes,
  resolveVerificationGate,
  runGateStepsInProcess,
  type ResolvedVerificationGate
} from "../verification/verificationGateService.js";
import {
  planBootstrapJobSteps,
  planL2JobSteps
} from "../verification/verificationPlan.js";
import {
  createManagedWorkspace,
  type ManagedWorkspace
} from "../worktree/managedWorkspace.js";
import type { CheckResult } from "./checkResult.js";
import {
  recordIntegrationCheckJob,
  updateIntegrationAttempt,
  type IntegrationAttempt
} from "./integrationAttempt.js";
import {
  findReusableIntegrationCheckEvidence,
  INTEGRATION_RUNTIME_RELEASE_ENV
} from "./integrationCheckEvidenceReuse.js";
import {
  applyIntegrationSource,
  assertIntegrationCandidate,
  assertRecordedSourceCandidate
} from "./integrationSourceApplication.js";

const executeFile = promisify(execFile);

const INTEGRATION_OPERATIONAL_ENVIRONMENT_NAMES = [
  "PATH",
  "USER",
  "LOGNAME",
  "SHELL",
  "TERM",
  "COLORTERM",
  "LANG",
  "LANGUAGE",
  "LC_ALL",
  "LC_ADDRESS",
  "LC_COLLATE",
  "LC_CTYPE",
  "LC_IDENTIFICATION",
  "LC_MEASUREMENT",
  "LC_MESSAGES",
  "LC_MONETARY",
  "LC_NAME",
  "LC_NUMERIC",
  "LC_PAPER",
  "LC_TELEPHONE",
  "LC_TIME",
  "TZ",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
  "NODE_EXTRA_CA_CERTS",
  "CURL_CA_BUNDLE",
  "REQUESTS_CA_BUNDLE"
] as const;

export type IntegrationResult =
  | Readonly<{ status: "committed"; attempt: IntegrationAttempt; workspace: IntegrationWorkspace }>
  | Readonly<{ status: "blocked"; attempt: IntegrationAttempt; workspace: IntegrationWorkspace }>
  | Readonly<{ status: "conflicted"; attempt: IntegrationAttempt; workspace: IntegrationWorkspace }>
  | Readonly<{ status: "checks-running"; attempt: IntegrationAttempt; workspace: IntegrationWorkspace; job: DurableJob }>
  | Readonly<{ status: "failed"; attempt: IntegrationAttempt; workspace?: IntegrationWorkspace }>;

/**
 * The check DurableJob boundary. Production code asks the Controller socket
 * (jobClient); tests supply a fake. The Controller is the sole job owner, so
 * a Leader exit, Session replacement, or tmux pane loss never kills a
 * running check.
 */
export type IntegrationJobPort = Readonly<{
  startCheckJob(input: Readonly<{
    taskId: string;
    integrationId: string;
    projectId: string;
    head: string;
    workspace: string;
    env: Readonly<Record<string, string>>;
    steps: readonly DurableJobStep[];
  }>): Promise<DurableJob>;
  getJob(taskId: string, jobId: string): Promise<DurableJob>;
  cancelJob(taskId: string, jobId: string): Promise<void>;
}>;

export type IntegrationWorkspace = Readonly<{
  projectId: string;
  path: string;
  branch: string;
  baseCommit: string;
}>;

export class GitIntegrationService {
  readonly home: string;
  readonly environment: NodeJS.ProcessEnv;
  readonly runtimeIsolation: TaskRuntimeIsolationPort;
  #resourceRegistrarValue: ResourceRegistrar | undefined;

  constructor(
    home: string,
    readonly store: TaskStore,
    readonly git: GitWorkspacePort = new NodeGitWorkspace(),
    readonly now: () => Date = () => new Date(),
    environment: NodeJS.ProcessEnv = process.env,
    runtimeIsolation: TaskRuntimeIsolationPort = defaultIntegrationRuntimeIsolation(
      home,
      store.getHomeIdentity().homeId
    ),
    readonly jobPort?: IntegrationJobPort
  ) {
    this.home = resolve(home);
    this.environment = { ...environment };
    this.runtimeIsolation = runtimeIsolation;
  }

  #resourceRegistrar(): ResourceRegistrar {
    return this.#resourceRegistrarValue ??= new ResourceRegistrar(this.home, this.now);
  }

  async integrate(
    taskId: string,
    integrationId: string,
    signal?: AbortSignal
  ): Promise<IntegrationResult> {
    let initial = requireIntegration(this.store, taskId, integrationId);
    if (!["running", "conflicted", "blocked", "validating"].includes(initial.status)) {
      throw new Error(`Integration cannot continue from ${initial.status}.`);
    }
    // The whole Integration is one Git transaction against the Project's
    // repository: worktree creation, cherry-picks, checks, and the target ref
    // CAS. A concurrent `project migrate` must not switch the catalog path or
    // remove the old checkout mid-Integration, so the per-Project maintenance
    // fence is held across every Git effect and released only on exit.
    const release = await acquireProjectMaintenanceLocks(this.home, [initial.projectId], { signal });
    try {
    // A concurrent abort may have settled the attempt while this caller was
    // acquiring the same Project fence. Never execute a pre-fence snapshot.
    const currentUnderFence = requireIntegration(this.store, taskId, integrationId);
    if (currentUnderFence.projectId !== initial.projectId
      || !["running", "conflicted", "blocked", "validating"].includes(currentUnderFence.status)) {
      throw new Error("Integration changed before execution admission; read its current record.");
    }
    initial = currentUnderFence;
    const task = this.store.getTask(initial.taskId);
    if (task === null || !task.projectBindings.some(
      ({ projectId }) => projectId === initial.projectId
    )) {
      throw new Error(`Integration Task Project is unavailable: ${initial.taskId}.`);
    }
    if (task.status !== "active" || task.executionGate.state !== "enabled") {
      throw new Error(`Integration Task is not active: ${task.id}/${task.status}.`);
    }
    const project = this.store.getProject(initial.projectId);
    if (project === null) throw new Error(`Project not found: ${initial.projectId}.`);
    if (project.status !== "active") throw new Error(`Integration Project is not active: ${project.id}.`);
    const taskWorkspace = this.store.getTaskWorkspace(task.id);
    const taskEntry = taskWorkspace?.entries.find(
      ({ projectId }) => projectId === project.id
    );
    const taskRepository = taskEntry?.path;
    if (taskWorkspace === null
      || taskWorkspace.owner.type !== "task"
      || taskEntry === undefined
      || taskRepository === undefined) {
      throw new Error(`Integration Task clone is unavailable: ${task.id}/${project.id}.`);
    }
    // Issue 08: a Project with a VerificationPlan gates through its plan
    // (bootstrap + L2) and reuses exact-SHA artifacts; an unconfigured
    // Project keeps the existing explicit check path unchanged.
    let prepared: Readonly<{ path: string; branch: string; baseCommit: string }>;
    let workspace: IntegrationWorkspace;
    let managedWorkspace: ManagedWorkspace;
    try {
      prepared = await this.git.ensureIntegrationWorktree({
        repositoryPath: taskRepository,
        container: integrationWorkspaceRoot(this.home, task.id, initial.id),
        directory: taskEntry.directory,
        taskSegment: taskWorkspaceRefSegment(task),
        integrationId: initial.id,
        baseRef: initial.beforeCommit
      });
      workspace = {
        projectId: project.id,
        path: prepared.path,
        branch: prepared.branch,
        baseCommit: prepared.baseCommit
      };
      const existingWorkspace = this.store.getIntegrationWorkspace(task.id, initial.id);
      if (existingWorkspace !== null && (
        resolve(existingWorkspace.root) !== resolve(prepared.path)
        || existingWorkspace.entries.length !== 1
        || existingWorkspace.entries[0]?.projectId !== project.id
        || existingWorkspace.entries[0]?.access !== "write"
        || existingWorkspace.entries[0]?.branch !== prepared.branch
      )) throw new Error("Integration managed workspace identity changed.");
      managedWorkspace = existingWorkspace ?? createManagedWorkspace({
        owner: {
          type: "integration-attempt",
          taskId: task.id,
          integrationAttemptId: initial.id
        },
        root: prepared.path,
        entries: [{
          projectId: project.id,
          directory: taskEntry.directory,
          access: "write",
          path: prepared.path,
          branch: prepared.branch,
          baseRef: initial.beforeCommit,
          baseCommit: prepared.baseCommit
        }]
      }, this.now());
      this.#resourceRegistrar().registerManagedWorkspace(managedWorkspace);
      this.store.saveManagedWorkspace(managedWorkspace);
    } catch (error) {
      return this.#fail(initial, error, "integration-preparation");
    }
    if (initial.status === "validating") {
      return await this.#recoverValidating(initial, workspace, managedWorkspace, taskRepository);
    }
    const gate = resolveVerificationGate(project, this.environment);
    let current = initial;

    // A check DurableJob is the source of truth for a running attempt that
    // already bound one: never re-apply commits or spawn a second job. The
    // job's terminal wakeup drives the resume through `integration continue`.
    try {
      current = await applyIntegrationSource({
        attempt: current, workspace, remoteUrl: project.remoteUrl,
        git: this.git, store: this.store, now: this.now
      });
      if (current.status === "conflicted" || current.status === "blocked") {
        return { status: current.status, attempt: current, workspace };
      }
      await assertIntegrationCandidate(prepared.path, current.candidateCommit, workspace.branch);
      if (current.jobId !== undefined || current.checkInputDigest !== undefined) {
        if (this.jobPort === undefined) throw new Error("Integration requires its Controller Job port to resume.");
        return await this.#startCheckJob(current, workspace, prepared.path, managedWorkspace, taskRepository, gate);
      }

      // Static preflight: fail before any expensive check when the target
      // moved or its worktree is dirty, so the check commands never run on a
      // target that cannot be advanced.  advanceTargetRef re-verifies both
      // after the checks, so a move during the gate is still fenced at CAS.
      await assertTargetReadyForChecks(taskRepository, current.targetRef, current.beforeCommit);
      if (gate !== undefined) {
        return await this.#runVerificationGate(
          current,
          workspace,
          prepared.path,
          managedWorkspace,
          taskRepository,
          gate
        );
      }
      if (this.jobPort !== undefined && current.checkCommands.length > 0) {
        return await this.#startCheckJob(
          current,
          workspace,
          prepared.path,
          managedWorkspace,
          taskRepository
        );
      }
      const spec = await this.#checkSpecification(current, managedWorkspace, gate);
      current = updateIntegrationAttempt(current, { checkInputDigest: spec.inputDigest }, this.now());
      this.store.saveIntegrationAttempt(task.id, current);
      const checkedHead = await gitLine(["-C", prepared.path, "rev-parse", "HEAD^{commit}"]);
      const checkResults = await this.#runChecks(current, managedWorkspace, prepared.path, spec.environment);
      await assertIntegrationCandidate(prepared.path, checkedHead, workspace.branch);
      if (checkResults.some((check) => check.outcome === "failed")) {
        current = updateIntegrationAttempt(current, {
          status: "failed",
          checks: checkResults
        }, this.now());
        this.store.saveIntegrationAttempt(task.id, current);
        return this.#terminalResult("failed", current, workspace);
      }
      const candidateCommit = await gitLine(["-C", prepared.path, "rev-parse", "HEAD^{commit}"]);
      current = updateIntegrationAttempt(current, {
        status: "validating",
        candidateCommit,
        checks: checkResults
      }, this.now());
      this.store.saveIntegrationAttempt(task.id, current);
      await advanceTargetRef(
        taskRepository,
        current.targetRef,
        candidateCommit,
        current.beforeCommit
      );
      const committed = this.#recordCommitted(current);
      return this.#terminalResult("committed", committed, workspace);
    } catch (error) {
      // Git/Job effects may already exist even if the following save failed.
      // Keep the last durable cursor/candidate for exact Agent-directed retry.
      current = requireIntegration(this.store, taskId, integrationId);
      if (current.status === "validating" && current.candidateCommit !== undefined) {
        const target = await resolveRef(taskRepository, current.targetRef);
        if (target === current.candidateCommit) {
          try {
            await assertIntegrationCandidate(workspace.path, current.candidateCommit, workspace.branch);
            await assertTargetReadyForChecks(
              taskRepository,
              current.targetRef,
              current.candidateCommit
            );
            const committed = this.#recordCommitted(current);
            return this.#terminalResult("committed", committed, workspace);
          } catch {
            // Preserve the original failure below; a target ref at the
            // candidate is insufficient when its checked-out tree is dirty or
            // incomplete after an interrupted CAS application.
          }
        }
      }
      const diagnosed = updateIntegrationAttempt(current, {
        summary: error instanceof Error ? error.message : String(error)
      }, this.now());
      this.store.saveIntegrationAttempt(taskId, diagnosed);
      return { status: diagnosed.status === "conflicted" ? "conflicted" : "blocked", attempt: diagnosed, workspace };
    }
    } finally {
      release();
    }
  }

  /** Abandon under the same fence as Git/CAS, not just a status whitelist.
   * A delivered validating candidate is recorded as committed; a provably
   * unadvanced one may be abandoned without requiring obsolete check settings. */
  async abort(
    taskId: string,
    integrationId: string,
    reason: string,
    authorize: (store: TaskStore, taskId: string) => unknown,
    signal?: AbortSignal
  ): Promise<IntegrationAttempt> {
    const initial = requireIntegration(this.store, taskId, integrationId);
    const release = await acquireProjectMaintenanceLocks(this.home, [initial.projectId], { signal });
    try {
      const attempt = requireIntegration(this.store, taskId, integrationId);
      authorize(this.store, taskId);
      const task = this.store.getTask(taskId);
      if (task?.status !== "active" || attempt.projectId !== initial.projectId
        || !task.projectBindings.some(binding => binding.projectId === attempt.projectId)) {
        throw new Error("Integration Task/Project is not available for abort.");
      }
      if (!["running", "blocked", "conflicted", "validating"].includes(attempt.status)) {
        throw new Error(`Integration cannot be aborted from ${attempt.status}: ${attempt.id}.`);
      }
      if (reason.trim() === "") throw new Error("Integration abort reason is required.");
      const jobs = this.store.listDurableJobs(taskId).filter(job =>
        job.owner.kind === "integration-attempt" && job.owner.integrationAttemptId === integrationId);
      const workspace = this.store.getIntegrationWorkspace(taskId, integrationId);
      if (jobs.some(job => job.taskId !== taskId || job.projectId !== attempt.projectId
        || job.workspace !== workspace?.root)) {
        throw new Error("Integration Job Project/workspace identity changed; inspect before abort.");
      }
      if (attempt.jobId !== undefined && !jobs.some(job => job.id === attempt.jobId)) {
        throw new Error("Integration Job binding does not match its owner; inspect before abort.");
      }
      if (attempt.status === "validating") {
        if (attempt.candidateCommit === undefined || attempt.checks === undefined) {
          throw new Error("Validating Integration has no candidate/check evidence; inspect before settlement.");
        }
        const main = this.store.getTaskWorkspace(taskId);
        const mainEntry = main?.entries.find(entry =>
          entry.projectId === attempt.projectId && entry.access === "write");
        const workspaceEntry = workspace?.entries.find(entry =>
          entry.projectId === attempt.projectId && entry.access === "write");
        const project = this.store.getProject(attempt.projectId);
        if (main?.owner.type !== "task" || mainEntry === undefined || workspace === null
          || project === null || project.status !== "active"
          || workspace.owner.type !== "integration-attempt" || workspace.owner.taskId !== taskId
          || workspace.owner.integrationAttemptId !== integrationId
          || workspaceEntry?.path !== workspace.root) {
          throw new Error("Integration target/workspace ownership is unavailable for settlement.");
        }
        if (jobs.some(job => ["queued", "running", "unknown-needs-attention"].includes(job.status))) {
          throw new Error("Validating Integration still has an active or unproven Job; settle that exact Job first.");
        }
        if (attempt.jobId !== undefined) {
          assertCheckJobIdentity(attempt, jobs.find(job => job.id === attempt.jobId)!, workspace.root);
        }
        const target = await resolveRef(mainEntry.path, attempt.targetRef);
        if (target === attempt.candidateCommit && target !== attempt.beforeCommit) {
          await assertTargetReadyForChecks(mainEntry.path, attempt.targetRef, target);
          return this.#recordCommitted(attempt, authorize);
        }
        if (target !== attempt.beforeCommit) {
          throw new Error(`Target moved to ${target}; cannot prove this Integration is unadvanced. Inspect before settlement.`);
        }
      }
      for (const job of jobs) {
        if (this.jobPort !== undefined && (job.status === "queued" || job.status === "running")) {
          await this.jobPort.cancelJob(taskId, job.id);
        }
      }
      return this.store.transaction(tx => {
        authorize(tx, taskId);
        const current = requireIntegration(tx, taskId, integrationId);
        if (JSON.stringify(current) !== JSON.stringify(attempt)) {
          throw new Error("Integration changed during abort; inspect its current record.");
        }
        const aborted = updateIntegrationAttempt(current, {
          status: "failed",
          checks: [...(current.checks ?? []), { name: "aborted", outcome: "failed", details: reason }]
        }, this.now());
        tx.saveIntegrationAttempt(taskId, aborted);
        return aborted;
      });
    } finally { release(); }
  }

  async cleanup(
    integration: IntegrationAttempt,
    options: Readonly<{ signal?: AbortSignal; authorize?: () => unknown }> = {}
  ): Promise<GitWorkspaceRemoval> {
    // The whole cleanup is one Git transaction against the Project's
    // repository, mirroring integrate(): a concurrent `project migrate` must
    // not switch the catalog path or remove the old checkout mid-cleanup.
    const release = await acquireProjectMaintenanceLocks(this.home, [integration.projectId], { signal: options.signal });
    try {
      options.authorize?.();
      const current = requireIntegration(this.store, integration.taskId, integration.id);
      if (current.projectId !== integration.projectId
        || !["committed", "superseded", "failed"].includes(current.status)) {
        throw new Error("Integration changed before cleanup; read its current record.");
      }
      integration = current;
      const activeJob = this.store.listDurableJobs(integration.taskId).find(job =>
        job.owner.kind === "integration-attempt" && job.owner.integrationAttemptId === integration.id
        && (job.status === "queued" || job.status === "running"
          || (job.status === "unknown-needs-attention" && job.acknowledgedAt === undefined)));
      if (activeJob !== undefined) {
        throw new Error(`Integration ${integration.id} has an active DurableJob: ${activeJob.id}/${activeJob.status}.`);
      }
      const task = this.store.getTask(integration.taskId);
      if (task === null || !task.projectBindings.some(
        ({ projectId }) => projectId === integration.projectId
      )) {
        throw new Error(`Integration Task Project is unavailable: ${integration.id}.`);
      }
      const project = this.store.getProject(integration.projectId);
      if (project === null) throw new Error(`Project not found: ${integration.projectId}.`);
      const taskRepository = this.store.getTaskWorkspace(task.id)?.entries.find(
        ({ projectId }) => projectId === project.id
      )?.path;
      if (taskRepository === undefined) {
        throw new Error(`Integration Task clone is unavailable: ${task.id}/${project.id}.`);
      }
      const managedWorkspace = this.store.getIntegrationWorkspace(
        integration.taskId,
        integration.id
      );
      if (managedWorkspace !== null) {
        const runtime = this.#runtimePreparation(integration, managedWorkspace);
        this.runtimeIsolation.cleanup(
          runtime,
          integration.status === "committed" ? "completion" : "failure"
        );
      }
      const recorded = managedWorkspace?.entries[0];
      const directory = recorded?.directory
        ?? task.projectBindings.find(
          ({ projectId }) => projectId === integration.projectId
        )?.directory;
      if (directory === undefined) {
        throw new Error(`Integration Project binding is unavailable: ${task.id}/${project.id}.`);
      }
      const result = await this.git.removeIntegrationWorktree({
        repositoryPath: taskRepository,
        container: recorded !== undefined
          ? dirname(recorded.path)
          : integrationWorkspaceRoot(this.home, task.id, integration.id),
        directory,
        taskSegment: taskWorkspaceRefSegment(task),
        integrationId: integration.id,
        discardChanges: integration.status === "failed"
      });
      if (result !== "dirty") {
        if (managedWorkspace !== null) {
          this.#resourceRegistrar().markWorkspaceDeleted(managedWorkspace);
        }
        await rm(integrationCheckDirectory(this.home, task.id, integration.id), {
          recursive: true,
          force: true
        });
        this.store.removeManagedWorkspace({
          type: "integration-attempt",
          taskId: integration.taskId,
          integrationAttemptId: integration.id
        });
      }
      return result;
    } finally {
      release();
    }
  }

  /**
   * Hand the check commands to a Controller-owned DurableJob. The job runs
   * the same isolated environment the in-process checks used; the attempt
   * stays `running` with its jobId until the job's terminal wakeup resumes
   * it, so a Leader exit mid-checks leaves no running/no-check zombie.
   */
  async #startCheckJob(
    attempt: IntegrationAttempt,
    workspace: IntegrationWorkspace,
    path: string,
    managedWorkspace: ManagedWorkspace,
    repositoryPath: string,
    gate?: ResolvedVerificationGate
  ): Promise<IntegrationResult> {
    if (attempt.status !== "running" || attempt.candidateCommit === undefined) {
      throw new Error(`Integration check admission requires a running, proven candidate: ${attempt.id}.`);
    }
    await assertIntegrationCandidate(path, attempt.candidateCommit, workspace.branch);
    await assertTargetReadyForChecks(repositoryPath, attempt.targetRef, attempt.beforeCommit);
    const { runtime, head, steps, environment, inputDigest, releaseId } =
      await this.#checkSpecification(attempt, managedWorkspace, gate);
    const ownedJobs = this.store.listDurableJobs(attempt.taskId).filter(job =>
      job.owner.kind === "integration-attempt" && job.owner.integrationAttemptId === attempt.id);
    if (gate === undefined && releaseId !== null && attempt.checkInputDigest === undefined
      && ownedJobs.length === 0 && attempt.jobId === undefined) {
      const reusable = findReusableIntegrationCheckEvidence({
        taskId: attempt.taskId,
        projectId: attempt.projectId,
        currentAttemptId: attempt.id,
        candidateCommit: head,
        checkCommands: attempt.checkCommands,
        runtimeReleaseId: releaseId,
        attempts: this.store.listIntegrationAttempts(attempt.taskId),
        jobs: this.store.listDurableJobs(attempt.taskId),
        logExists: (homeRelativePath) => existsSync(join(this.home, homeRelativePath)),
        logPathFor: (job, relativeLogPath) => (
          join(job.artifactsLocator, "logs", relativeLogPath)
        )
      });
      if (reusable !== null) {
        return this.#finalizeGateSuccess(
          updateIntegrationAttempt(attempt, { checkInputDigest: inputDigest }, this.now()),
          workspace,
          repositoryPath,
          head,
          [...reusable.checks]
        );
      }
    }
    if (attempt.checkInputDigest !== undefined && attempt.checkInputDigest !== inputDigest) {
      throw new Error("Integration check conditions changed since admission; inspect the original Job, then abort or start a new attempt.");
    }
    if (attempt.jobId !== undefined) {
      return this.#resumeCheckJob(attempt, workspace, path, repositoryPath, gate);
    }
    // Persist the gate identity before starting the job so a plan edit
    // during the gate never misattributes the evidence on resume.
    const persisted = updateIntegrationAttempt(attempt, {
      checkInputDigest: inputDigest,
      ...(gate === undefined ? {} : {
        gatePlanDigest: gate.planDigest,
        gateToolchainDigest: gate.toolchainDigest
      })
    }, this.now());
    this.store.saveIntegrationAttempt(attempt.taskId, persisted);
    // All domain admission and durable candidate identity precede Job effects.
    this.runtimeIsolation.activate(runtime);
    await prepareIntegrationRuntimeHome(runtime, this.home);
    const job = await this.jobPort!.startCheckJob({
      taskId: attempt.taskId,
      integrationId: attempt.id,
      projectId: attempt.projectId,
      head,
      workspace: path,
      env: environment,
      steps
    });
    assertCheckJobIdentity(persisted, job, path);
    const bound = recordIntegrationCheckJob(persisted, job.id, this.now());
    this.store.saveIntegrationAttempt(attempt.taskId, bound);
    if (job.status !== "queued" && job.status !== "running") {
      // Idempotent re-entry after a Leader exit in the bind window: the
      // Controller returned the already-terminal job. Converge through the
      // normal resume path instead of a checks-running zombie.
      return this.#resumeCheckJob(bound, workspace, path, repositoryPath, gate);
    }
    return { status: "checks-running", attempt: bound, workspace, job };
  }

  /**
   * Resume a running attempt whose check job is already bound. An active job
   * reports checks-running without side effects; a terminal job finalizes the
   * attempt through the same validating/committed or failed path as the
   * in-process checks. `unknown-needs-attention` fails closed: the attempt
   * fails and the target ref never advances.
   */
  async #resumeCheckJob(
    attempt: IntegrationAttempt,
    workspace: IntegrationWorkspace,
    path: string,
    repositoryPath: string,
    gate?: ResolvedVerificationGate
  ): Promise<IntegrationResult> {
    const job = await this.jobPort!.getJob(attempt.taskId, attempt.jobId!);
    assertCheckJobIdentity(attempt, job, path);
    await assertIntegrationCandidate(path, job.head, workspace.branch);
    await assertTargetReadyForChecks(repositoryPath, attempt.targetRef, attempt.beforeCommit);
    if (gate?.planDigest !== attempt.gatePlanDigest
      || gate?.toolchainDigest !== attempt.gateToolchainDigest) {
      throw new Error("Integration verification plan/toolchain changed; the original Job cannot prove the current gate.");
    }
    if (job.status === "queued" || job.status === "running") {
      return { status: "checks-running", attempt, workspace, job };
    }
    const checks = gate !== undefined
      ? checkResultsFromGateJob(job, this.home)
      : checkResultsFromJob(attempt, job);
    const managedWorkspace = this.store.getIntegrationWorkspace(attempt.taskId, attempt.id);
    if (managedWorkspace !== null) {
      const runtime = this.#runtimePreparation(attempt, managedWorkspace);
      this.runtimeIsolation.cleanup(
        runtime,
        checks.some((check) => check.outcome === "failed") ? "failure" : "completion"
      );
    }
    // The current plan/toolchain was matched to admission above. Record only
    // that exact identity, never reinterpret an old Job under a changed plan.
    if (gate !== undefined
      && (job.result?.outcome === "succeeded" || job.result?.outcome === "failed")) {
      const identity = gateIdentityForCandidate({
        projectId: attempt.projectId,
        gate,
        level: "L2",
        commit: job.head,
        targetRef: attempt.targetRef,
        baseHead: attempt.beforeCommit
      });
      try {
        const artifact = await recordGateArtifactFromJob(
          this.store,
          this.home,
          identity,
          gate.plan,
          job,
          this.now()
        );
        if (checks.every((check) => check.outcome !== "failed")) {
          checks.push(...checkResultsFromGateArtifact(artifact));
        }
      } catch (error) {
        // A failed artifact import (e.g. a lost job log) must not fake
        // evidence: the attempt fails closed without a reusable artifact.
        return this.#fail(
          attempt,
          error instanceof Error ? error : new Error(String(error)),
          "gate-artifact",
          workspace
        );
      }
    }
    if (checks.some((check) => check.outcome === "failed")) {
      const failed = updateIntegrationAttempt(attempt, {
        status: "failed",
        checks
      }, this.now());
      this.store.saveIntegrationAttempt(attempt.taskId, failed);
      return this.#terminalResult("failed", failed, workspace);
    }
    return this.#finalizeGateSuccess(attempt, workspace, repositoryPath, job.head, checks);
  }

  async #runChecks(
    attempt: IntegrationAttempt,
    workspace: ManagedWorkspace,
    path: string,
    environment: Readonly<Record<string, string>>
  ): Promise<CheckResult[]> {    if (attempt.checkCommands.length === 0) return [];
    const runtime = this.#runtimePreparation(attempt, workspace);
    this.runtimeIsolation.activate(runtime);
    let cleanupReason: "completion" | "failure" = "failure";
    try {
      await prepareIntegrationRuntimeHome(runtime, this.home);
      const checks = await runChecks(
        path,
        attempt.checkCommands,
        this.home,
        attempt.taskId,
        attempt.id,
        environment
      );
      cleanupReason = checks.some(({ outcome }) => outcome === "failed")
        ? "failure"
        : "completion";
      return checks;
    } finally {
      this.runtimeIsolation.cleanup(runtime, cleanupReason);
    }
  }

  /**
   * Issue 08: the VerificationPlan gate for a configured Project.
   *
   * Enforce mode rejects ad-hoc full-suite checks before the gate. Reuse mode
   * returns an existing successful artifact for the same identity tuple
   * (project + exact commit + plan digest + toolchain digest + target
   * boundary); record mode always runs and only counts shadow potential
   * reuses. The gate itself runs as bootstrap + L2 DurableJob steps (or
   * in-process when no Controller job port is available) and records a
   * self-contained GateArtifact. The final CAS in
   * {@link #finalizeGateSuccess} still fences a target that moves during the
   * gate.
   */
  async #runVerificationGate(
    attempt: IntegrationAttempt,
    workspace: IntegrationWorkspace,
    path: string,
    managedWorkspace: ManagedWorkspace,
    repositoryPath: string,
    gate: ResolvedVerificationGate
  ): Promise<IntegrationResult> {
    const spec = await this.#checkSpecification(attempt, managedWorkspace, gate);
    attempt = updateIntegrationAttempt(attempt, {
      checkInputDigest: spec.inputDigest,
      gatePlanDigest: gate.planDigest, gateToolchainDigest: gate.toolchainDigest
    }, this.now());
    this.store.saveIntegrationAttempt(attempt.taskId, attempt);
    if (gate.mode === "enforce") {
      try {
        assertNoAdHocFullSuiteChecks(gate.plan, attempt.checkCommands);
      } catch (error) {
        return this.#fail(
          attempt,
          error instanceof Error ? error : new Error(String(error)),
          "verification-plan",
          workspace
        );
      }
    }
    const candidateCommit = await gitLine(["-C", path, "rev-parse", "HEAD^{commit}"]);
    const identity = gateIdentityForCandidate({
      projectId: attempt.projectId,
      gate,
      level: "L2",
      commit: candidateCommit,
      targetRef: attempt.targetRef,
      baseHead: attempt.beforeCommit
    });
    if (gate.mode !== "record") {
      const existing = await lookupReusableGateArtifact(this.store, identity);
      if (existing !== null) {
        touchGateArtifact(this.store, recordGateArtifactReuse(existing, this.now()));
        const checks = checkResultsFromGateArtifact(existing, true);
        return this.#finalizeGateSuccess(
          attempt,
          workspace,
          repositoryPath,
          candidateCommit,
          checks
        );
      }
    } else {
      // Record mode: observe the potential reuse without skipping the gate.
      const existing = await lookupReusableGateArtifact(this.store, identity);
      if (existing !== null) {
        touchGateArtifact(this.store, recordGateArtifactPotentialReuse(existing, this.now()));
      }
    }
    if (this.jobPort !== undefined) {
      return this.#startCheckJob(
        attempt,
        workspace,
        path,
        managedWorkspace,
        repositoryPath,
        gate
      );
    }
    // Jobless fallback (queue processing without a Controller): run the
    // plan gate in-process and record the artifact directly.
    const runtime = this.#runtimePreparation(attempt, managedWorkspace);
    this.runtimeIsolation.activate(runtime);
    let cleanupReason: "completion" | "failure" = "failure";
    try {
      await prepareIntegrationRuntimeHome(runtime, this.home);
      const steps = [
        ...planBootstrapJobSteps(gate.plan, path),
        ...planL2JobSteps(gate.plan, path)
      ];
      const outcomes = await runGateStepsInProcess(
        path,
        steps,
        spec.environment,
        integrationCheckDirectory(this.home, attempt.taskId, attempt.id),
        candidateCommit
      );
      const succeeded = outcomes.length === steps.length
        && outcomes.every((outcome) =>
          outcome.exitCode === 0 && outcome.signal === null && !outcome.timedOut
        );
      const artifact = await recordGateArtifactFromStepOutcomes(
        this.store,
        identity,
        gate.plan,
        outcomes,
        succeeded,
        this.now()
      );
      const checks = checkResultsFromGateArtifact(artifact);
      cleanupReason = succeeded ? "completion" : "failure";
      if (!succeeded) {
        const failed = updateIntegrationAttempt(
          attempt,
          { status: "failed", checks },
          this.now()
        );
        this.store.saveIntegrationAttempt(attempt.taskId, failed);
        return this.#terminalResult("failed", failed, workspace);
      }
      return this.#finalizeGateSuccess(
        attempt,
        workspace,
        repositoryPath,
        candidateCommit,
        checks
      );
    } finally {
      this.runtimeIsolation.cleanup(runtime, cleanupReason);
    }
  }

  async #finalizeGateSuccess(
    attempt: IntegrationAttempt,
    workspace: IntegrationWorkspace,
    repositoryPath: string,
    candidateCommit: string,
    checks: CheckResult[]
  ): Promise<IntegrationResult> {
    await assertIntegrationCandidate(workspace.path, candidateCommit, workspace.branch);
    const validating = updateIntegrationAttempt(attempt, {
      status: "validating",
      candidateCommit,
      checks
    }, this.now());
    this.store.saveIntegrationAttempt(attempt.taskId, validating);
    await advanceTargetRef(
      repositoryPath,
      validating.targetRef,
      candidateCommit,
      validating.beforeCommit
    );
    const committed = this.#recordCommitted(validating);
    return this.#terminalResult("committed", committed, workspace);
  }

  #runtimePreparation(
    _attempt: IntegrationAttempt,
    workspace: ManagedWorkspace
  ): TaskRuntimeIsolationPreparation {
    return this.runtimeIsolation.preflight({
      workspace,
      allowExactActive: true
    });
  }

  /** The same specification is compared before first execution, bound-Job
   * consumption and an unadvanced validating CAS. Computing it is read-only:
   * a changed condition must not recreate a completed runtime or start a Job. */
  async #checkSpecification(
    attempt: IntegrationAttempt,
    managedWorkspace: ManagedWorkspace,
    gate?: ResolvedVerificationGate
  ) {
    const runtime = this.#runtimePreparation(attempt, managedWorkspace);
    const head = attempt.candidateCommit;
    if (head === undefined) throw new Error("Integration check specification requires a candidate.");
    const steps: DurableJobStep[] = gate === undefined
      ? attempt.checkCommands.map((command, index) => ({
          name: `check-${index + 1}`, command, timeoutMs: 30 * 60_000
        }))
      : [...planBootstrapJobSteps(gate.plan, managedWorkspace.root),
          ...planL2JobSteps(gate.plan, managedWorkspace.root)]
        .map(step => ({ ...step, timeoutMs: 30 * 60_000 }));
    const releaseId = integrationRuntimeReleaseIdentity(this.home);
    const environment = Object.freeze({
      ...integrationCheckEnvironment(this.environment, runtime, this.home),
      ...(releaseId === null ? {} : { [INTEGRATION_RUNTIME_RELEASE_ENV]: releaseId })
    });
    const inputDigest = durableJobIdempotencyKey({
      owner: { kind: "integration-attempt", integrationAttemptId: attempt.id },
      projectId: attempt.projectId, head, workspace: managedWorkspace.root,
      env: environment, steps
    });
    return { runtime, head, steps, environment, inputDigest, releaseId };
  }

  async #recoverValidating(
    attempt: IntegrationAttempt,
    workspace: IntegrationWorkspace,
    managedWorkspace: ManagedWorkspace,
    repositoryPath: string
  ): Promise<IntegrationResult> {
    if (attempt.candidateCommit === undefined || attempt.checks === undefined) {
      return this.#fail(
        attempt,
        new Error("Validating Integration is missing its candidate commit or checks."),
        "integration-recovery",
        workspace
      );
    }
    const target = await resolveRef(repositoryPath, attempt.targetRef);
    // An already-applied CAS is a delivery fact, not a request to validate
    // again under today's settings. No-op candidates still need current checks.
    if (target !== attempt.candidateCommit || target === attempt.beforeCommit) {
      if (target !== attempt.beforeCommit) {
        throw new Error(`Target moved to ${target}; Integration CAS outcome needs inspection.`);
      }
      await assertIntegrationCandidate(workspace.path, attempt.candidateCommit, workspace.branch);
      assertRecordedSourceCandidate(attempt, workspace);
      const project = this.store.getProject(attempt.projectId);
      if (project === null) throw new Error("Integration Project is unavailable for check validation.");
      const gate = resolveVerificationGate(project, this.environment);
      const spec = await this.#checkSpecification(attempt, managedWorkspace, gate);
      if (attempt.checkInputDigest !== spec.inputDigest
        || gate?.planDigest !== attempt.gatePlanDigest
        || gate?.toolchainDigest !== attempt.gateToolchainDigest) {
        throw new Error("Integration check conditions changed after validation; preserve the evidence and abort or use a new attempt.");
      }
      if (attempt.jobId !== undefined) {
        const job = this.store.getDurableJob(attempt.taskId, attempt.jobId);
        if (job === null || job.status !== "succeeded") {
          throw new Error("Validating Integration has no successful bound Job evidence.");
        }
        assertCheckJobIdentity(attempt, job, workspace.path);
      }
      await advanceTargetRef(repositoryPath, attempt.targetRef, attempt.candidateCommit, attempt.beforeCommit);
    }
    await assertTargetReadyForChecks(
      repositoryPath,
      attempt.targetRef,
      attempt.candidateCommit
    );
    const committed = this.#recordCommitted(attempt);
    return this.#terminalResult("committed", committed, workspace);
  }

  #recordCommitted(
    attempt: IntegrationAttempt,
    authorize?: (store: TaskStore, taskId: string) => unknown
  ): IntegrationAttempt {
    if (attempt.candidateCommit === undefined) {
      throw new Error(`Committed Integration has no candidate commit: ${attempt.id}.`);
    }
    const candidateCommit = attempt.candidateCommit;
    return this.store.transaction((tx) => {
      authorize?.(tx, attempt.taskId);
      const task = tx.getTask(attempt.taskId);
      if (task === null) throw new Error(`Task not found: ${attempt.taskId}.`);
      const binding = task.projectBindings.find(
        ({ projectId }) => projectId === attempt.projectId
      );
      if (binding === undefined) {
        throw new Error(`Task Project binding not found: ${task.id}/${attempt.projectId}.`);
      }
      if (binding.currentCommit !== candidateCommit) {
        tx.saveTask(advanceTaskProjectCommit(
          task,
          attempt.projectId,
          attempt.beforeCommit,
          candidateCommit,
          this.now()
        ));
      }
      const committed = updateIntegrationAttempt(
        attempt,
        {
          status: "committed",
          afterCommit: candidateCommit,
          summary: integrationSummary(attempt)
        },
        this.now()
      );
      tx.saveIntegrationAttempt(attempt.taskId, committed);
      return committed;
    });
  }

  #fail(
    attempt: IntegrationAttempt,
    error: unknown,
    checkName: string,
    workspace?: IntegrationWorkspace
  ): IntegrationResult {
    const failed = updateIntegrationAttempt(attempt, {
      status: "failed",
      checks: [
        ...(attempt.checks ?? []),
        {
          name: checkName,
          outcome: "failed",
          details: error instanceof Error ? error.message : String(error)
        }
      ]
    }, this.now());
    this.store.saveIntegrationAttempt(attempt.taskId, failed);
    return this.#terminalResult("failed", failed, workspace);
  }

  #terminalResult(
    status: "committed" | "failed",
    attempt: IntegrationAttempt,
    workspace?: IntegrationWorkspace
  ): IntegrationResult {
    if (status === "committed") {
      if (workspace === undefined) {
        throw new Error(`Committed Integration has no workspace: ${attempt.id}.`);
      }
      return { status, attempt, workspace };
    }
    return {
      status,
      attempt,
      ...(workspace === undefined ? {} : { workspace })
    };
  }
}

function assertCheckJobIdentity(attempt: IntegrationAttempt, job: DurableJob, path: string): void {
  if (job.taskId !== attempt.taskId
    || job.owner.kind !== "integration-attempt" || job.owner.integrationAttemptId !== attempt.id
    || job.projectId !== attempt.projectId || job.workspace !== path
    || job.head !== attempt.candidateCommit
    || (attempt.jobId !== undefined && job.id !== attempt.jobId)
    || attempt.checkInputDigest === undefined
    || durableJobIdempotencyKey(job) !== attempt.checkInputDigest) {
    throw new Error("Integration Job identity does not match its admitted Task, source candidate, Project, workspace and check specification.");
  }
  if (job.status === "succeeded") {
    const results = job.result?.steps;
    if (job.result?.outcome !== "succeeded" || results?.length !== job.steps.length
      || job.steps.some((step, index) => {
        const result = results[index];
        return result?.name !== step.name || result.head !== job.head
          || result.exitCode !== 0 || result.signal !== null || result.timedOut;
      })) throw new Error("Integration Job success lacks exact candidate step evidence.");
  }
}

function integrationSummary(attempt: IntegrationAttempt): string {
  const unchanged = attempt.beforeCommit === attempt.candidateCommit;
  if (attempt.source.kind === "upstream") {
    return unchanged
      ? `Upstream ${attempt.source.remoteCommit} was already represented; Task head was unchanged.`
      : `Rebased Task changes onto upstream ${attempt.source.remoteCommit}.`;
  }
  if (attempt.source.kind === "historical-change-sets") {
    return unchanged
      ? "Historical Integration was already represented; Task head was unchanged."
      : "Historical Integration advanced the Task head.";
  }
  if (attempt.source.strategy === "manual") {
    const decision = attempt.resolution;
    if (decision?.action !== "manual-resolution") {
      throw new Error(`Manual Integration has no Task-control resolution decision: ${attempt.id}.`);
    }
    return unchanged
      ? `WorkItem ${attempt.source.workItemId} was intentionally not applied; `
        + `Task head was unchanged. Rationale: ${decision.rationale}`
      : `Integrated WorkItem ${attempt.source.workItemId} with manual resolution. `
        + `Rationale: ${decision.rationale}`;
  }
  return unchanged
    ? `WorkItem ${attempt.source.workItemId} result was already represented; Task head was unchanged.`
    : `Integrated WorkItem ${attempt.source.workItemId} with ${attempt.source.strategy}.`;
}

/**
 * Map a terminal check job back to the attempt's CheckResult[] shape. The
 * runner stops at the first failing step, so unreached checks are "skipped"
 * except for an unproven (unknown) job, which fails closed on the first
 * missing step so the attempt never passes without evidence. A job that ended
 * without a single failing step (cancelled before any step, or any other
 * non-succeeded outcome) also fails closed: the target ref must never advance
 * on an unproven check.
 */
function checkResultsFromJob(
  attempt: IntegrationAttempt,
  job: DurableJob
): CheckResult[] {
  const steps = new Map((job.result?.steps ?? []).map((step) => [step.name, step]));
  const checks: CheckResult[] = attempt.checkCommands.map((command, index) => {
    const name = `check-${index + 1}`;
    const step = steps.get(name);
    const logPath = step === undefined
      ? undefined
      : `${job.artifactsLocator}/logs/${step.logPath}`;
    const outputReference = logPath === undefined ? {} : { logPath };
    if (step !== undefined && !step.timedOut && step.exitCode === 0 && step.signal === null) {
      return { name: command, outcome: "passed", ...outputReference };
    }
    if (step !== undefined) {
      const reason = step.timedOut
        ? "Command timed out after 1800 seconds."
        : step.signal !== null
          ? `Command terminated by ${step.signal}.`
          : `Command exited with code ${step.exitCode}.`;
      return { name: command, outcome: "failed", details: reason, ...outputReference };
    }
    if (job.result?.outcome === "unknown-needs-attention") {
      return {
        name: command,
        outcome: "failed",
        details: `Check job unknown-needs-attention: ${job.result.unknownReason ?? "runner outcome is unproven"}.`
      };
    }
    return { name: command, outcome: "skipped" };
  });
  if (
    checks.length > 0
    && !checks.some((check) => check.outcome === "failed")
    && job.result?.outcome !== "succeeded"
  ) {
    checks[0] = {
      name: checks[0]!.name,
      outcome: "failed",
      details: failClosedJobDetails(job)
    };
  }
  return checks;
}

function failClosedJobDetails(job: DurableJob): string {
  const outcome = job.result?.outcome ?? job.status;
  if (outcome === "cancelled") {
    return "Check job was cancelled before it proved the checks.";
  }
  if (outcome === "timed-out") {
    return "Check job timed out before it proved the checks.";
  }
  return `Check job ended ${outcome} without proving the checks.`;
}

async function runChecks(
  path: string,
  commands: readonly string[],
  home: string,
  taskId: string,
  integrationId: string,
  environment: Readonly<Record<string, string>>
): Promise<CheckResult[]> {  if (commands.length === 0) return [];
  const outputDirectory = integrationCheckDirectory(home, taskId, integrationId);
  await rm(outputDirectory, { recursive: true, force: true });
  await mkdir(outputDirectory, { recursive: true, mode: 0o700 });
  const results: CheckResult[] = [];
  for (const [index, command] of commands.entries()) {
    const absoluteLogPath = join(
      outputDirectory,
      `${String(index + 1).padStart(3, "0")}.log`
    );
    const logPath = relative(home, absoluteLogPath).split(sep).join("/");
    const result = await runCheck(path, command, absoluteLogPath, logPath, environment);
    results.push(result);
    if (result.outcome === "failed") break;
  }
  return results;
}

type CheckCompletion = Readonly<{
  code: number | null;
  signal: NodeJS.Signals | null;
  error?: Error;
  timedOut: boolean;
}>;

async function runCheck(
  cwd: string,
  command: string,
  absoluteLogPath: string,
  logPath: string,
  environment: Readonly<Record<string, string>>
): Promise<CheckResult> {
  const output = await open(absoluteLogPath, "w", 0o600);
  let completion: CheckCompletion;
  try {
    completion = await spawnCheck(command, cwd, output.fd, environment);
  } finally {
    await output.close();
  }
  const outputSize = (await stat(absoluteLogPath)).size;
  const outputReference = outputSize === 0
    ? {}
    : { logPath };
  if (outputSize === 0) await rm(absoluteLogPath, { force: true });
  if (
    completion.error === undefined
    && !completion.timedOut
    && completion.code === 0
  ) {
    return {
      name: command,
      outcome: "passed",
      ...outputReference
    };
  }
  const diagnostic = outputSize === 0
    ? undefined
    : await lastCompleteDiagnosticLine(absoluteLogPath);
  return {
    name: command,
    outcome: "failed",
    details: [
      checkFailureReason(completion),
      ...(diagnostic === undefined ? [] : [diagnostic])
    ].join(" "),
    ...outputReference
  };
}

async function spawnCheck(
  command: string,
  cwd: string,
  outputFd: number,
  environment: Readonly<Record<string, string>>
): Promise<CheckCompletion> {
  let child;
  try {
    child = spawn("/bin/sh", ["-lc", command], {
      cwd,
      env: environment,
      stdio: ["ignore", outputFd, outputFd]
    });
  } catch (error) {
    return {
      code: null,
      signal: null,
      error: error instanceof Error ? error : new Error(String(error)),
      timedOut: false
    };
  }
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    child.kill("SIGTERM");
  }, 30 * 60_000);
  timeout.unref();
  const completion = await new Promise<Omit<CheckCompletion, "timedOut">>((resolve) => {
    child.once("error", (error) => {
      resolve({ code: null, signal: null, error });
    });
    child.once("close", (code, signal) => {
      resolve({ code, signal });
    });
  });
  clearTimeout(timeout);
  return { ...completion, timedOut };
}

async function prepareIntegrationRuntimeHome(runtime: TaskRuntimeIsolationPreparation, home: string): Promise<void> {
  const homeDirectory = join(runtime.descriptor.roots.data, "home");
  try {
    await mkdir(homeDirectory, { mode: 0o700 });
  } catch (error) {
    if (!isNodeCode(error, "EEXIST")) throw error;
  }
  const homeMetadata = await lstat(homeDirectory);
  if (!homeMetadata.isDirectory() || homeMetadata.isSymbolicLink()) {
    throw new Error("Integration runtime HOME is not an owned directory.");
  }
  // The tmux socket endpoint is the one approved short-path IPC exception; every
  // other temp consumer (TMPDIR/TMP/TEMP) stays on the Home-side runtime tmp.
  const tmuxSocketRoot = integrationTmuxSocketRoot(home);
  try {
    await mkdir(tmuxSocketRoot, { mode: 0o700 });
  } catch (error) {
    if (!isNodeCode(error, "EEXIST")) throw error;
  }
}

function integrationCheckEnvironment(
  source: NodeJS.ProcessEnv,
  runtime: TaskRuntimeIsolationPreparation,
  home: string
): Readonly<Record<string, string>> {
  const homeDirectory = join(runtime.descriptor.roots.data, "home");
  const tmuxSocketRoot = integrationTmuxSocketRoot(home);
  return Object.freeze({
    ...selectEnvironment(source, INTEGRATION_OPERATIONAL_ENVIRONMENT_NAMES),
    PATH: source.PATH || `${dirname(process.execPath)}:/usr/local/bin:/usr/bin:/bin`,
    HOME: homeDirectory,
    TMPDIR: runtime.descriptor.roots.temporary,
    TMP: runtime.descriptor.roots.temporary,
    TEMP: runtime.descriptor.roots.temporary,
    TMUX_TMPDIR: tmuxSocketRoot,
    ...runtime.environment
  });
}

function isNodeCode(error: unknown, code: string): boolean {
  return typeof error === "object"
    && error !== null
    && "code" in error
    && (error as { code?: unknown }).code === code;
}

function defaultIntegrationRuntimeIsolation(
  home: string,
  homeId: string
): TaskRuntimeIsolationPort {
  const controlHome = resolve(home);
  const runtimeRoot = managedIntegrationRuntimeRoot(controlHome);
  return new FileTaskRuntimeIsolation({
    // The integration check's provider data/cache/tmp live in a dedicated Home
    // partition — the same isolation contract every Task runtime obeys — not in
    // a system-wide `/tmp` root. Only the tmux socket ENDPOINT stays a short
    // `/tmp` path (see `integrationCheckEnvironment`) for the `sockaddr_un`
    // budget; ordinary runtime state is now Yui-managed under Home.
    runtimeRoot,
    pathLayout: "compact",
    controlPlane: {
      yuiHome: controlHome,
      managedRuntimeRoot: runtimeRoot,
      controllerSocketPath: controllerSocketPath(homeId),
      tmuxNamespace: yuiTmuxServerName(controlHome),
      globalInstallPaths: [process.execPath]
    }
  });
}

/**
 * Short `/tmp` directory that holds ONLY the integration check's tmux socket
 * endpoint. tmux uses a `sockaddr_un` path whose length budget cannot absorb a
 * deep Home path, so this single IPC endpoint is the one approved exception to
 * the unified-Home contract. All other integration runtime state (data, cache,
 * ordinary temp) lives in the Home partition from `managedIntegrationRuntimeRoot`.
 */
function integrationTmuxSocketRoot(home: string): string {
  const uid = typeof process.getuid === "function" ? process.getuid() : 0;
  const homeDigest = createHash("sha256").update(resolve(home)).digest("hex").slice(0, 16);
  return join("/tmp", `yi-${uid.toString(36)}-${homeDigest}`);
}

/**
 * Reuse is enabled only for an immutable installed release. Development
 * checkouts have no content-addressed release identity, so they return.
 */
function integrationRuntimeReleaseIdentity(home: string): string | null {
  try {
    const receipt = readRuntimeIdentity(home);
    const release = receipt?.activeRelease;
    if (receipt === null
      || receipt.mode !== "primary"
      || receipt.dualOwner
      || release === null
      || release === undefined
      || receipt.packageDigest !== release.packageDigest
      || receipt.buildId !== release.buildId) {
      return null;
    }
    return release.releaseId;
  } catch {
    return null;
  }
}

function checkFailureReason(completion: CheckCompletion): string {
  if (completion.timedOut) return "Command timed out after 1800 seconds.";
  if (completion.error !== undefined) {
    return `Command failed to start: ${completion.error.message}`;
  }
  if (completion.code !== null) return `Command exited with code ${completion.code}.`;
  if (completion.signal !== null) return `Command terminated by ${completion.signal}.`;
  return "Command failed.";
}

async function lastCompleteDiagnosticLine(path: string): Promise<string | undefined> {
  const handle = await open(path, "r");
  try {
    const info = await handle.stat();
    const length = Math.min(info.size, 64 * 1024);
    if (length === 0) return undefined;
    const buffer = Buffer.alloc(length);
    await handle.read(buffer, 0, length, info.size - length);
    let text = buffer.toString("utf8");
    if (info.size > length) {
      const firstLineEnd = text.indexOf("\n");
      if (firstLineEnd < 0) return undefined;
      text = text.slice(firstLineEnd + 1);
    }
    const line = text.split(/\r?\n/u).map((value) => value.trim()).filter(Boolean).at(-1);
    return line === undefined || line.length > 1_000 ? undefined : line;
  } finally {
    await handle.close();
  }
}

function integrationCheckDirectory(
  home: string,
  taskId: string,
  integrationId: string
): string {
  return join(home, "artifacts", "integration-checks", taskId, integrationId);
}

async function git(args: readonly string[]): Promise<string> {
  try {
    const result = await executeFile("git", [...args], {
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
      timeout: 120_000
    });
    return result.stdout;
  } catch (error) {
    const stderr = typeof error === "object" && error !== null && "stderr" in error
      ? String((error as { stderr?: unknown }).stderr).trim()
      : "";
    throw new Error(stderr.length === 0 ? "Git command failed." : `Git command failed: ${stderr}`, {
      cause: error
    });
  }
}

async function gitLine(args: readonly string[]): Promise<string> {
  const value = (await git(args)).trim();
  if (!/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/u.test(value)) {
    throw new Error("Git returned an invalid commit.");
  }
  return value;
}

function requireIntegration(
  store: TaskStore,
  taskId: string,
  id: string
): IntegrationAttempt {
  const attempt = store.getIntegrationAttempt(taskId, id);
  if (attempt === null) {
    throw new Error(`Integration Attempt not found: ${taskId}/${id}.`);
  }
  return attempt;
}

function fullTargetRef(value: string): string {
  if (value.startsWith("refs/")) return value;
  if (value.startsWith("-") || /[\r\n]/u.test(value)) {
    throw new Error("Integration target ref is invalid.");
  }
  return `refs/heads/${value}`;
}

async function resolveRef(repositoryPath: string, ref: string): Promise<string> {
  return gitLine([
    "-C", repositoryPath, "rev-parse", "--verify", "--end-of-options",
    `${fullTargetRef(ref)}^{commit}`
  ]);
}

/**
 * Static preflight before the (potentially expensive) checks: the target ref
 * must still equal the expected head and a checked-out target worktree must be
 * clean.  A failure here means the check commands must not turn.  The post-check
 * {@link advanceTargetRef} re-verifies both before the CAS, so a target that
 * moves during the gate is still fenced.
 */
async function assertTargetReadyForChecks(
  repositoryPath: string,
  targetRef: string,
  expectedHead: string
): Promise<void> {
  const current = await resolveRef(repositoryPath, targetRef);
  if (current !== expectedHead) {
    throw new Error(`Target moved to ${current}; expected ${expectedHead}.`);
  }
  const checkedOutPaths = await checkedOutWorktreePaths(repositoryPath, fullTargetRef(targetRef));
  if (checkedOutPaths.length > 1) {
    throw new Error(`Integration target is checked out in multiple worktrees: ${targetRef}.`);
  }
  if (checkedOutPaths.length === 1) {
    const status = await git([
      "-C", checkedOutPaths[0], "status", "--porcelain=v1", "--untracked-files=all"
    ]);
    if (status.trim().length > 0) {
      throw new Error(`Integration target worktree is not clean: ${checkedOutPaths[0]}.`);
    }
  }
}

async function advanceTargetRef(
  repositoryPath: string,
  targetRef: string,
  candidateCommit: string,
  expectedHead: string
): Promise<void> {
  const ref = fullTargetRef(targetRef);
  const checkedOutPaths = await checkedOutWorktreePaths(repositoryPath, ref);
  if (checkedOutPaths.length === 0) {
    await git([
      "-C", repositoryPath, "update-ref",
      ref,
      candidateCommit,
      expectedHead
    ]);
    return;
  }
  if (checkedOutPaths.length > 1) {
    throw new Error(`Integration target is checked out in multiple worktrees: ${targetRef}.`);
  }
  const checkout = checkedOutPaths[0]!;
  const status = await git([
    "-C", checkout, "status", "--porcelain=v1", "--untracked-files=all"
  ]);
  if (status.trim().length > 0) {
    throw new Error(`Integration target worktree is not clean: ${checkout}.`);
  }
  const current = await gitLine(["-C", checkout, "rev-parse", "HEAD^{commit}"]);
  if (current !== expectedHead) {
    throw new Error(`Target moved to ${current}; expected ${expectedHead}.`);
  }
  // The candidate may be a rebased upstream result and therefore need not be
  // a descendant of the old Task head. Advance the branch with a real
  // compare-and-swap, then update only this checkout's index and worktree.
  // `read-tree` never moves the ref, so an external ref change is not
  // overwritten while the checked-out files are synchronized.
  await git([
    "-C", repositoryPath, "update-ref",
    ref,
    candidateCommit,
    expectedHead
  ]);
  await git(["-C", checkout, "read-tree", "--reset", "-u", candidateCommit]);
  const advanced = await resolveRef(repositoryPath, targetRef);
  if (advanced !== candidateCommit) {
    throw new Error(`Integration target did not advance to candidate: ${targetRef}.`);
  }
  const finalStatus = await git([
    "-C", checkout, "status", "--porcelain=v1", "--untracked-files=all"
  ]);
  if (finalStatus.trim().length > 0) {
    throw new Error(`Integration target worktree became dirty: ${checkout}.`);
  }
}

async function checkedOutWorktreePaths(
  repositoryPath: string,
  targetRef: string
): Promise<string[]> {
  const porcelain = (await git([
    "-C", repositoryPath, "worktree", "list", "--porcelain"
  ])).trim();
  if (porcelain.length === 0) return [];
  return porcelain.split(/\n\n+/u).flatMap((record) => {
    const lines = record.split("\n");
    const path = lines.find((line) => line.startsWith("worktree "))?.slice("worktree ".length);
    const branch = lines.find((line) => line.startsWith("branch "))?.slice("branch ".length);
    return path !== undefined && branch === targetRef ? [path] : [];
  });
}
