import { createHash, randomBytes } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

import { runUpdate, type StagedPackage, type UpdatePorts, type UpdateResult } from "../cli/updateOrchestrator.js";
import { activatedControllerEntrypoint } from "../cli/updatePorts.js";
import {
  restartFileTaskController,
  stopFileTaskController,
  type FileControllerClientOptions
} from "../controller/clientRuntime.js";
import {
  runProjectCommand,
  type ProjectCommandOptions,
  type ProjectCommandStore
} from "../commands/projectCommands.js";
import {
  createFileReleaseIdempotencyStore,
  type ReleaseIdempotencyStore
} from "./releaseIdempotencyStore.js";
import { isConcreteVersion } from "../domain/validation.js";
import { resolveProject } from "../repository/project.js";
import type { ReleaseStepPlan, ReleaseWorkflowSource } from "./releaseWorkflow.js";
import {
  resolveVerificationGate
} from "../verification/verificationGateService.js";
import { findL2ArtifactForCommit } from "../verification/gateArtifactStore.js";
import type { GateArtifactStorePort } from "../verification/gateArtifact.js";
import {
  createExecFileCommandRunner,
  createPinnedCommandRunner,
  resolveExecutable,
  type CommandRunner
} from "../external/pinnedCommandRunner.js";

export { resolveExecutable } from "../external/pinnedCommandRunner.js";
export type { CommandRunner } from "../external/pinnedCommandRunner.js";

/**
 * The outcome of one external step attempt. A `timeout` means the request may
 * or may not have landed. It MAY carry the authoritative identity the engine
 * can re-query by (for queryable effects); a Controller handoff failure
 * carries none, so the engine marks the step unknown and stops rather than
 * confirming it on binary health alone (P1-1, rr22).
 */
export type ReleaseStepEffect = Readonly<{
  outcome: "succeeded" | "failed" | "timeout";
  externalId?: string;
  externalIdentity?: Readonly<{ kind: string; value: string }>;
  logs?: readonly string[];
  error?: string;
}>;

export type ReleaseStepQuery = Readonly<{
  state: "exists" | "absent" | "unknown";
  externalId?: string;
}>;

/**
 * The single seam between the workflow engine and every external system.
 *
 * `executeStep` MUST be idempotent under the same `idempotencyKey`: a retried
 * attempt with the same key must not produce a second side effect. The engine
 * never calls `executeStep` for a step it has marked unknown; it re-queries by
 * the recorded identity instead.
 */
export type ReleaseWorkflowPorts = Readonly<{
  /**
   * The YUI Home this adapter drives. The engine compares it against a
   * Home-scoped grant so a cli-update grant cannot be replayed against another
   * Home. Fakes that never run a Home-scoped step may omit it.
   */
  home?: string;
  executeStep(input: Readonly<{
    step: ReleaseStepPlan;
    idempotencyKey: string;
    source: ReleaseWorkflowSource;
    params: Readonly<Record<string, string>>;
  }>): Promise<ReleaseStepEffect>;
  queryStepEffect(input: Readonly<{
    step: ReleaseStepPlan;
    source?: ReleaseWorkflowSource;
    /**
     * The recorded effect identity to re-query. A step that crashed before
     * recording an identity has none; the port then fails closed (unknown)
     * unless it can prove a disposition from the step plan itself.
     */
    externalIdentity?: Readonly<{ kind: string; value: string }>;
  }>): Promise<ReleaseStepQuery>;
}>;

/** The input of one step attempt; the idempotency key makes re-attempts safe. */
export type ReleaseStepInput = Readonly<{
  step: ReleaseStepPlan;
  idempotencyKey: string;
  source: ReleaseWorkflowSource;
  params: Readonly<Record<string, string>>;
}>;

const defaultRunCommand = createExecFileCommandRunner();

/**
 * The external commands the production adapter shells out to. Each one is
 * resolved to an absolute path once, at adapter construction time, so a PATH
 * change mid-run cannot swap `gh`/`git`/`npm`/`tar`/`sh` for another binary
 * (P1-2, rr22). The pinning is per-process at construction time, so a resume
 * process re-resolves from its own PATH.
 */
const PINNED_EXTERNAL_COMMANDS: readonly string[] = ["gh", "git", "npm", "tar", "sh"];

/**
 * Resolve an external command to its absolute executable path by walking the
 * given PATH. A command that is already absolute is returned unchanged. A
 * command that cannot be resolved returns undefined. Callers must fail closed
 * without invoking a mutable PATH fallback.
 */
/**
 * Wrap the default runner so every external command is pinned to the
 * absolute path resolved at construction. Injected runners (tests) are used
 * as-is: the pinning is a production-adapter guarantee.
 *
 * Exported for deterministic tests (P2, rr24): the negative cache must
 * survive a later PATH addition, so a command missing at construction stays
 * unresolvable for the adapter's lifetime.
 */
export function createPinnedRunner(base: CommandRunner): CommandRunner {
  return createPinnedCommandRunner(base, PINNED_EXTERNAL_COMMANDS);
}

/**
 * The injectable dependencies of the real adapter. Every external capability
 * is an existing atomic operation; the adapter only translates between the
 * step vocabulary and those operations.
 */
export type ReleaseWorkflowAdapterDeps = Readonly<{
  home: string;
  updatePorts: UpdatePorts;
  projectStore: ProjectCommandStore & GateArtifactStorePort;
  projectOptions?: ProjectCommandOptions;
  controllerOptions?: FileControllerClientOptions;
  /** Overridable for tests; defaults to child_process execFile. */
  runCommand?: CommandRunner;
  /**
   * Durable dedup store for idempotency keys. Defaults to a file-backed store
   * under `home`; tests may inject an in-memory store. A recorded successful
   * effect is replayed instead of re-executed, so a crash between the external
   * effect and its engine persistence cannot produce a second shell execution.
   */
  idempotencyStore?: ReleaseIdempotencyStore;
}>;

/**
 * The real adapter. It is NEVER exercised by the deterministic test suite
 * (fakes are); every branch dispatches to an existing atomic operation.
 */
export function createReleaseWorkflowPorts(
  deps: ReleaseWorkflowAdapterDeps
): ReleaseWorkflowPorts {
  const run: CommandRunner = deps.runCommand !== undefined
    ? deps.runCommand
    : createPinnedRunner(defaultRunCommand);
  // Capture the same npm resolution used by the production pinned runner at
  // adapter construction.  The effect target must never be re-resolved from
  // a later PATH, which may belong to a replacement process or environment.
  const pinnedNpmPath = resolveExecutable("npm", process.env.PATH);
  const idempotency = deps.idempotencyStore ?? createFileReleaseIdempotencyStore(deps.home);

  async function executeStepOnce(
    { step, idempotencyKey, source, params }: ReleaseStepInput
  ): Promise<ReleaseStepEffect> {
    switch (step.kind) {
        case "cli-update": {
          // A cli-update is an irreversible global binary/Home change. It must
          // be bound to a concrete frozen version: a plan without one would
          // stage and activate whatever `latest` resolves to, which can move
          // between the plan and the activation. Fail closed before staging.
          const frozenVersion = params.version;
          if (frozenVersion === undefined || !isConcreteVersion(frozenVersion)) {
            return {
              outcome: "failed",
              error: frozenVersion === undefined
                ? "cli-update requires params.version: a concrete frozen version must be staged and activated."
                : `cli-update: params.version ${frozenVersion} is not a concrete version; refusing to stage a moving tag.`,
              logs: ["cli-update: refusing to update without a concrete frozen version"]
            };
          }
          // Stage the exact frozen version side-by-side and inspect it BEFORE
          // any activation: a registry that resolved a different version must
          // fail with the active CLI untouched.
          let staged: StagedPackage;
          try {
            staged = deps.updatePorts.stage(frozenVersion);
          } catch (error) {
            return {
              outcome: "failed",
              error: `cli-update: staging failed: ${error instanceof Error ? error.message : String(error)}`,
              logs: ["cli-update: staging failed before any activation"]
            };
          }
          if (staged.version !== frozenVersion) {
            try {
              deps.updatePorts.cleanup(staged);
            } catch {
              // Best-effort cleanup; staging is side-by-side so the live
              // install is untouched either way.
            }
            return {
              outcome: "failed",
              error: `cli-update: staged version ${staged.version} does not match frozen version ${frozenVersion}`,
              logs: [`cli-update: refusing to activate a version other than the frozen ${frozenVersion}`]
            };
          }
          // Reuse the inspected staged package so runUpdate activates exactly
          // what was inspected rather than staging a second artifact.
          const inspectedPorts: UpdatePorts = {
            ...deps.updatePorts,
            stage: () => staged
          };
          // P1-2 (rr23): persist the exact activation target (Home + global
          // npm prefix) to a durable file BEFORE the irreversible effect. A
          // hard-exit recovery query reads this file instead of deriving the
          // target from the resume caller's npm/PATH environment. Best-effort:
          // an unpinnable target or a failed write must not block the update.
          try {
            await persistCliUpdateIdentity(run, deps.home, idempotencyKey);
          } catch {
            // Best-effort persistence; the effect may still succeed.
          }
          const result: UpdateResult = runUpdate(inspectedPorts, { home: deps.home });
          if (result.outcome === "updated" || result.outcome === "already-current") {
            return {
              outcome: "succeeded",
              externalId: result.version,
              logs: [`cli-update: ${result.outcome} (${result.version})`]
            };
          }
          if (result.outcome === "aborted" && !result.recoverable) {
            // P1-2 (rr20): An aborted activation with recoverable=false means
            // npm activation began but its outcome is unknowable — the global
            // install may or may not have landed. Treat it as ambiguous:
            // persist a queryable identity so the engine never re-submits
            // blindly. Only recoverable:true aborts (old binary and Home
            // provably intact) are safe to retry as plain failures.
            //
            // P1 (rr21): A Controller ownership/handoff failure
            // (controllerOwnershipUnknown) is different: the replacement
            // Controller's identity could not be authenticated, so the
            // Controller lifecycle handoff is unresolved. A controller-home
            // query would confirm the global binary but NOT prove the
            // Controller handoff completed. Return timeout WITHOUT
            // externalIdentity so the engine marks the step as `unknown`
            // and stops — resume must not continue until the expected
            // Controller lifecycle/identity handoff is proven complete.
            if (result.controllerOwnershipUnknown === true) {
              return {
                outcome: "timeout",
                logs: [`cli-update Controller ownership unknown at phase ${result.phase}: ${result.message}`]
              };
            }
            // P1-2 (rr22): persist the EXACT activation target (the resolved
            // global prefix) alongside the Home, so a resume query checks the
            // same installation instead of re-deriving the target from the
            // caller's npm/PATH environment.
            const identity = await controllerHomeIdentity(run, deps.home);
            return {
              outcome: "timeout",
              ...(identity === undefined ? {} : { externalIdentity: identity }),
              logs: [`cli-update ambiguous at phase ${result.phase}: ${result.message}`]
            };
          }
          return {
            outcome: "failed",
            error: `cli-update aborted at phase ${result.phase}: ${result.message}`,
            logs: [`cli-update: ${result.message}`]
          };
        }
        case "controller-replace": {
          try {
            await stopFileTaskController(deps.home, deps.controllerOptions);
            const restarted = await restartFileTaskController(deps.home, deps.controllerOptions);
            const externalId = restarted.pid === undefined ? "restarted" : `pid:${restarted.pid}`;
            return {
              outcome: "succeeded",
              externalId,
              logs: [`controller-replace: previous pid ${restarted.previousPid ?? "-"} -> ${externalId}`]
            };
          } catch (error) {
            return {
              outcome: "failed",
              error: error instanceof Error ? error.message : String(error)
            };
          }
        }
        case "project-migrate": {
          const project = params.project;
          if (project === undefined) {
            return { outcome: "failed", error: "project-migrate requires params.project." };
          }
          try {
            const result = await runProjectCommand(
              ["migrate", project],
              deps.projectStore,
              deps.projectOptions
            );
            return {
              outcome: "succeeded",
              externalId: project,
              logs: [`project-migrate: ${result.output.trim()}`]
            };
          } catch (error) {
            return {
              outcome: "failed",
              error: error instanceof Error ? error.message : String(error)
            };
          }
        }
        case "pr-create-or-reuse": {
          // A commit SHA is not a valid head branch. Derive a proper branch
          // name when the caller does not supply one.
          const head = params.head ?? `release/${source.commit.slice(0, 12)}`;
          const repo = `${source.repository.owner}/${source.repository.name}`;
          const lookup = await findHeadPullRequest(run, head, repo);
          if (lookup.status === "failed") {
            // A failed lookup is fail-closed: never create a PR when the
            // reuse check could not complete.
            return {
              outcome: "failed",
              error: `pr-create-or-reuse: PR lookup failed: ${lookup.error}`,
              logs: ["pr-create-or-reuse: lookup failed; not creating a PR"]
            };
          }
          if (lookup.status === "found") {
            // A PR for the head branch is only reusable when its head is the
            // exact frozen source commit: a branch that moved, or a PR opened
            // from an older push, must not be reused for this release.
            if (lookup.headSha !== source.commit) {
              return {
                outcome: "failed",
                error: `pr-create-or-reuse: PR #${lookup.prNumber} head ${lookup.headSha} does not match frozen source commit ${source.commit}`,
                logs: ["pr-create-or-reuse: refusing to reuse a PR whose head is not the frozen source commit"]
              };
            }
            return {
              outcome: "succeeded",
              externalId: `pr:${lookup.prNumber}`,
              logs: [`pr-create-or-reuse: reused PR #${lookup.prNumber}`]
            };
          }
          // P2-2: Authoritatively resolve the proposed remote head before
          // creating a PR. A moved or missing head would create an external
          // PR for the wrong commit; fail closed before any external effect.
          const remoteHead = await resolveRemoteHead(run, repo, head);
          if (remoteHead === undefined) {
            return {
              outcome: "failed",
              error: `pr-create-or-reuse: cannot resolve remote head ${head} in ${repo}`,
              logs: ["pr-create-or-reuse: refusing to create a PR for an unresolvable head"]
            };
          }
          if (remoteHead !== source.commit) {
            return {
              outcome: "failed",
              error: `pr-create-or-reuse: remote head ${head} is ${remoteHead}, not the frozen source commit ${source.commit}`,
              logs: ["pr-create-or-reuse: refusing to create a PR for a head that moved"]
            };
          }
          const created = await run("gh", [
            "pr", "create", "--head", head,
            "--repo", repo,
            "--title", params.title ?? `Release ${head}`,
            "--body", params.body ?? `Automated release workflow ${idempotencyKey}`
          ]);
          if (created.code !== 0) {
            // A race may have opened the PR between our query and create.
            if (/already exists/i.test(created.stderr)) {
              const raced = await findHeadPullRequest(run, head, repo);
              if (raced.status === "found" && raced.headSha === source.commit) {
                return {
                  outcome: "succeeded",
                  externalId: `pr:${raced.prNumber}`,
                  logs: [`pr-create-or-reuse: reused PR #${raced.prNumber} after create race`]
                };
              }
            }
            return { outcome: "failed", error: created.stderr.trim() || "gh pr create failed" };
          }
          const match = created.stdout.match(/pull\/(\d+)/);
          const prNumber = match === null ? created.stdout.trim() : match[1];
          // P2-2: Verify the created PR's head SHA matches the frozen source
          // commit. A race or a branch move between create and now could
          // leave a PR pointing at a different commit.
          const verified = await run("gh", [
            "pr", "view", prNumber,
            "--repo", repo,
            "--json", "number,headRefOid"
          ]);
          if (verified.code !== 0) {
            return {
              outcome: "failed",
              error: `pr-create-or-reuse: created PR #${prNumber} but cannot verify its head: ${verified.stderr.trim() || "gh pr view failed"}`,
              logs: ["pr-create-or-reuse: created PR but head verification failed"]
            };
          }
          const headInfo = parsePrHeadEntry(verified.stdout);
          if (headInfo === undefined || headInfo.headSha !== source.commit) {
            return {
              outcome: "failed",
              error: `pr-create-or-reuse: created PR #${prNumber} head ${headInfo?.headSha ?? "unknown"} does not match frozen source commit ${source.commit}`,
              logs: ["pr-create-or-reuse: refusing to accept a PR whose head is not the frozen source commit"]
            };
          }
          return {
            outcome: "succeeded",
            externalId: `pr:${prNumber}`,
            logs: ["pr-create-or-reuse: created PR"]
          };
        }
        case "ci-confirm": {
          // Issue 08: when the step binds a Project with a VerificationPlan,
          // a local hermetic L2 GateArtifact for the exact frozen commit is
          // first-class release evidence. It is recorded as local evidence
          // (never disguised as CI); when absent or unverifiable, the step
          // falls back to the predeclared CI query below.
          const gateProjectId = params.projectId;
          if (gateProjectId !== undefined && gateProjectId !== "" && !gateProjectId.startsWith("-")) {
            const project = resolveProject(deps.projectStore.listProjects(), gateProjectId);
            if (project !== null) {
              const gate = resolveVerificationGate(project, process.env);
              if (gate !== undefined) {
                const artifact = await findL2ArtifactForCommit(deps.projectStore, {
                  projectId: project.id,
                  commit: source.commit,
                  planDigest: gate.planDigest,
                  toolchainDigest: gate.toolchainDigest,
                  targetRef: params.targetRef ?? "master"
                });
                if (artifact !== null) {
                  return {
                    outcome: "succeeded",
                    externalId: `gate:${artifact.key}`,
                    logs: [
                      `ci-confirm: local hermetic L2 gate artifact ${artifact.key} `
                        + `for ${source.commit} (plan ${gate.plan.id}@${gate.plan.version}); `
                        + `not CI evidence`
                    ]
                  };
                }
              }
            }
          }
          // Bind the CI query to the exact frozen source commit AND a
          // predeclared workflow + branch, so an unrelated successful
          // workflow run on the same SHA cannot satisfy the release gate.
          const ciWorkflow = params.workflow;
          if (ciWorkflow === undefined || ciWorkflow === "") {
            return {
              outcome: "failed",
              error: "ci-confirm requires params.workflow (the CI workflow filename, e.g. ci.yml)",
              logs: ["ci-confirm: refusing to query CI without a predeclared workflow binding"]
            };
          }
          if (ciWorkflow.startsWith("-")) {
            return {
              outcome: "failed",
              error: `ci-confirm: workflow must not start with '-': ${ciWorkflow}`,
              logs: ["ci-confirm: refusing an option-looking workflow name"]
            };
          }
          const ciBranch = params.branch;
          if (ciBranch === undefined || ciBranch === "") {
            return {
              outcome: "failed",
              error: "ci-confirm requires params.branch (the branch the CI workflow runs on)",
              logs: ["ci-confirm: refusing to query CI without a predeclared branch binding"]
            };
          }
          if (ciBranch.startsWith("-")) {
            return {
              outcome: "failed",
              error: `ci-confirm: branch must not start with '-': ${ciBranch}`,
              logs: ["ci-confirm: refusing an option-looking branch name"]
            };
          }
          const status = await run("gh", [
            "run", "list",
            "--commit", source.commit,
            "--workflow", ciWorkflow,
            "--branch", ciBranch,
            "--limit", "1",
            "--repo", `${source.repository.owner}/${source.repository.name}`,
            "--json", "conclusion,status",
            "--jq", ".[0] | {conclusion,status}"
          ]);
          if (status.code !== 0) {
            return { outcome: "failed", error: status.stderr.trim() || "gh run list failed" };
          }
          let parsed: { conclusion?: string; status?: string } | undefined;
          try {
            parsed = JSON.parse(status.stdout.trim());
          } catch {
            return { outcome: "failed", error: `ci-confirm: cannot parse gh run list output: ${status.stdout.trim()}` };
          }
          if (parsed === undefined || parsed === null) {
            return { outcome: "failed", error: `ci-confirm: no ${ciWorkflow} run found on ${ciBranch} for ${source.commit}` };
          }
          if (parsed.status !== "completed") {
            return { outcome: "failed", error: `CI not finished: ${parsed.status ?? "unknown"}` };
          }
          if (parsed.conclusion === "success") {
            return { outcome: "succeeded", externalId: `ci:${source.commit.slice(0, 7)}`, logs: [`ci-confirm: ${ciWorkflow} on ${ciBranch} @ ${source.commit}: ${parsed.conclusion}`] };
          }
          return { outcome: "failed", error: `CI conclusion: ${parsed.conclusion ?? "unknown"}` };
        }
        case "merge": {
          return mergePullRequest(run, source, params.pr, params);
        }
        case "version-tag": {
          const tag = params.tag;
          if (tag === undefined) {
            return { outcome: "failed", error: "version-tag requires params.tag." };
          }
          // P1-3: A tag that starts with '-' would be interpreted as a git
          // option. Reject it before any command runs.
          if (tag.startsWith("-")) {
            return {
              outcome: "failed",
              error: `version-tag: tag ${tag} must not start with '-' (would be interpreted as a git option)`,
              logs: ["version-tag: refusing to create a tag that looks like an option"]
            };
          }
          // The tag is created and pushed from inside the exact source
          // repository checkout, never the Controller's cwd.
          const cwd = params.repositoryPath;
          if (cwd === undefined) {
            return { outcome: "failed", error: "version-tag requires params.repositoryPath." };
          }
          // The checkout must be the granted source repository. An arbitrary
          // params.repositoryPath would push the release tag to that clone's
          // origin, so verify the remote before any local effect.
          // P1-5: Verify both the fetch URL and the push URL. `git push` uses
          // the push URL, which can differ from the fetch URL when pushurl is
          // configured. A mismatch would send the tag to the wrong remote.
          const fetchUrl = await run("git", ["remote", "get-url", "origin"], cwd);
          if (fetchUrl.code !== 0) {
            return {
              outcome: "failed",
              error: `version-tag: cannot read origin of ${cwd}: ${fetchUrl.stderr.trim() || "git remote get-url failed"}`,
              logs: ["version-tag: refusing to tag a checkout whose origin cannot be verified"]
            };
          }
          if (!remoteMatchesRepository(fetchUrl.stdout, source.repository)) {
            return {
              outcome: "failed",
              error: `version-tag: origin ${fetchUrl.stdout.trim()} is not the granted repository ${source.repository.owner}/${source.repository.name}`,
              logs: ["version-tag: refusing to tag a checkout whose origin is not the granted repository"]
            };
          }
          // P1-5: Verify ALL configured push URLs. `git push` writes to every
          // pushurl, so a matching first URL plus a foreign second URL would
          // still send the release tag to an unauthorized target.
          const pushUrls = await run("git", ["remote", "get-url", "--push", "--all", "origin"], cwd);
          if (pushUrls.code !== 0) {
            return {
              outcome: "failed",
              error: `version-tag: cannot read push URLs of ${cwd}: ${pushUrls.stderr.trim() || "git remote get-url --push --all failed"}`,
              logs: ["version-tag: refusing to tag a checkout whose push URLs cannot be verified"]
            };
          }
          const effectivePushUrls = pushUrls.stdout
            .split(/\r?\n/)
            .map((url) => url.trim())
            .filter((url) => url.length > 0);
          if (effectivePushUrls.length === 0) {
            return {
              outcome: "failed",
              error: `version-tag: origin of ${cwd} has no push URL`,
              logs: ["version-tag: refusing to tag a checkout with no push URL"]
            };
          }
          const foreignPushUrl = effectivePushUrls.find(
            (url) => !remoteMatchesRepository(url, source.repository)
          );
          if (foreignPushUrl !== undefined) {
            return {
              outcome: "failed",
              error: `version-tag: push URL ${foreignPushUrl} is not the granted repository ${source.repository.owner}/${source.repository.name}`,
              logs: ["version-tag: refusing to tag a checkout with a foreign push URL"]
            };
          }
          // Recovery convergence: a previous attempt may have created the
          // local tag before the push failed. Re-creating it would fail
          // ("tag already exists") and strand the recovery, so verify an
          // existing tag points at the frozen commit and proceed to push;
          // only create the tag when it is absent.
          // P1-3: Validate the tag is a well-formed ref name so it can never
          // be interpreted as an option or an unexpected revision.
          const refCheck = await run("git", ["check-ref-format", `refs/tags/${tag}`], cwd);
          if (refCheck.code !== 0) {
            return {
              outcome: "failed",
              error: `version-tag: tag ${tag} is not a valid git ref name`,
              logs: ["version-tag: refusing to create a tag that is not a valid ref"]
            };
          }
          // Resolve the explicit refs/tags/<tag> revision WITHOUT a `--`
          // separator: `--` would make git parse the revision as a path and
          // report a real existing tag as absent.
          const existing = await run("git", ["rev-parse", "--verify", "--quiet", `refs/tags/${tag}^{commit}`], cwd);
          if (existing.code === 0) {
            if (existing.stdout.trim() !== source.commit) {
              return {
                outcome: "failed",
                error: `version-tag: local tag ${tag} points at ${existing.stdout.trim()}, not the frozen commit ${source.commit}`,
                logs: ["version-tag: refusing to push a local tag that does not name the frozen commit"]
              };
            }
          } else {
            // Place -m and its value before the `--` separator so the tag
            // name and commit are the only operands; `--` after options keeps
            // the tag from ever being parsed as an option.
            const tagged = await run("git", ["tag", "-a", "-m", `Release ${tag}`, "--", tag, source.commit], cwd);
            if (tagged.code !== 0) {
              return { outcome: "failed", error: tagged.stderr.trim() || "git tag failed" };
            }
          }
          // P1-3: Use an explicit refspec so the tag is pushed to the exact
          // refs/tags/<tag> path, never interpreted as an option or a ref.
          const sent = await run("git", ["push", "origin", `refs/tags/${tag}:refs/tags/${tag}`], cwd);
          if (sent.code !== 0) {
            return { outcome: "timeout", externalIdentity: { kind: "git-tag", value: tag }, error: sent.stderr.trim() };
          }
          return { outcome: "succeeded", externalId: `tag:${tag}`, logs: [`version-tag: ${tag} @ ${source.commit}`] };
        }
        case "npm-publish": {
          const tarball = params.tarball;
          if (tarball === undefined) {
            return { outcome: "failed", error: "npm-publish requires params.tarball." };
          }
          // P1-6: Require a content-addressed source artifact for every
          // npm-publish. Without an artifact, the tarball is unbound: any
          // same-named file could be published, violating the exact-source
          // guarantee. The artifact's sha512 is verified before publishing.
          if (source.artifact === undefined) {
            return {
              outcome: "failed",
              error: "npm-publish: source.artifact is required (content-addressed tarball with sha512)",
              logs: ["npm-publish: refusing to publish without a frozen artifact"]
            };
          }
          const tarballName = tarball.split("/").pop() ?? tarball;
          if (tarballName !== source.artifact.name) {
            return {
              outcome: "failed",
              error: `npm-publish: tarball ${tarballName} does not match frozen artifact ${source.artifact.name}`,
              logs: ["npm-publish: refusing to publish a tarball that is not the frozen artifact"]
            };
          }
          // The frozen artifact is content-addressed: a same-named tarball
          // with different bytes would still publish the wrong package.
          // Verify the tarball's sha512 against the recorded integrity
          // before publishing, and fail closed when the file cannot be read.
          let bytes: Buffer;
          try {
            bytes = await readFile(tarball);
          } catch (error) {
            return {
              outcome: "failed",
              error: `npm-publish: cannot read tarball ${tarball}: ${error instanceof Error ? error.message : String(error)}`,
              logs: ["npm-publish: refusing to publish a tarball that cannot be verified"]
            };
          }
          const actualIntegrity = `sha512-${createHash("sha512").update(bytes).digest("base64")}`;
          if (actualIntegrity !== source.artifact.integrity) {
            return {
              outcome: "failed",
              error: `npm-publish: tarball integrity ${actualIntegrity} does not match frozen artifact ${source.artifact.integrity}`,
              logs: ["npm-publish: refusing to publish a tarball that is not the frozen artifact"]
            };
          }
          // Reject option-looking tarball paths before any subprocess sees
          // them: both `tar -xOf` (manifest inspection) and `npm publish`
          // would interpret a file named "--dry-run" as a flag, not an
          // operand, and report a normal result without any registry effect.
          if (tarball.startsWith("-")) {
            return {
              outcome: "failed",
              error: `npm-publish: tarball path must not start with '-': ${tarball}`,
              logs: ["npm-publish: refusing to publish an option-looking tarball path"]
            };
          }
          // P1-3 (rr22): Snapshot the verified bytes to a workflow-private,
          // read-only temp file. Both the manifest inspection and `npm
          // publish` read THIS snapshot, so a TOCTOU replacement of the
          // original path after the integrity check cannot change what is
          // published. The snapshot is removed once publish completes.
          const snapshot = await writeVerifiedTarballSnapshot(bytes);
          try {
            // Inspect the tarball manifest before publishing: the actual
            // package name/version must match the frozen declaration, not
            // just the file name or bytes. A same-named tarball with a
            // different manifest would publish the wrong package, and a
            // source without a frozen artifact still gets this check.
            const target = params.package ?? derivePackageName(source);
            const manifest = await readTarballManifest(run, snapshot);
            if (manifest === undefined) {
              return {
                outcome: "failed",
                error: `npm-publish: cannot read manifest of ${tarball}`,
                logs: ["npm-publish: refusing to publish a tarball whose manifest cannot be verified"]
              };
            }
            if (manifest.name !== target) {
              return {
                outcome: "failed",
                error: `npm-publish: tarball manifest ${manifest.name} does not match publish target ${target}`,
                logs: ["npm-publish: refusing to publish a tarball that is not the frozen package"]
              };
            }
            if (params.version !== undefined && manifest.version !== params.version) {
              return {
                outcome: "failed",
                error: `npm-publish: tarball version ${manifest.version} does not match frozen version ${params.version}`,
                logs: ["npm-publish: refusing to publish a tarball that is not the frozen version"]
              };
            }
            // P1 (rr25): resolve and persist the exact npm executable and
            // registry BEFORE the irreversible effect. A resume in a
            // different environment reads this durable receipt instead of
            // invoking its own npm/registry: a different mirror serving the
            // same version+integrity would otherwise falsely confirm this
            // publish. The registry is also passed to publish explicitly so
            // the receipt names the target the effect actually used.
            if (pinnedNpmPath === undefined) {
              return {
                outcome: "failed",
                error: "npm-publish: npm is not resolvable at adapter construction; refusing an unbound effect target",
                logs: ["npm-publish: refusing to publish without a pinned npm executable"]
              };
            }
            const registry = await resolveNpmPublishRegistry(
              run,
              manifest.name,
              manifest.publishConfig?.registry
            );
            if (registry === undefined) {
              return {
                outcome: "failed",
                error: "npm-publish: registry target could not be resolved; refusing an unbound effect target",
                logs: ["npm-publish: refusing to publish without a pinned registry"]
              };
            }
            try {
              await persistNpmPublishTarget(deps.home, idempotencyKey, {
                npmPath: pinnedNpmPath,
                registry
              });
            } catch (error) {
              return {
                outcome: "failed",
                error: `npm-publish: cannot persist effect target before publish: ${error instanceof Error ? error.message : String(error)}`,
                logs: ["npm-publish: refusing to publish when the durable target cannot be recorded"]
              };
            }
            const published = await run("npm", [
              "publish",
              "--registry",
              registry,
              "--",
              snapshot
            ]);
            if (published.code !== 0) {
              // A transport failure after the upload may have actually published
              // the package. Record the identity so the engine can query npm
              // authoritatively on resume instead of re-publishing blindly.
              if (isTransportFailure(published.stderr)) {
                return {
                  outcome: "failed",
                  externalIdentity: { kind: "npm-package", value: `${target}@${manifest.version}` },
                  error: published.stderr.trim() || "npm publish failed",
                  logs: ["npm-publish: transport failure after upload; querying registry on resume"]
                };
              }
              return { outcome: "failed", error: published.stderr.trim() || "npm publish failed" };
            }
            // Verify the publish result matches the frozen declaration. npm
            // reports the published id as "+ name@version"; a result naming a
            // different package or version must not satisfy the step, and a
            // result without a parseable confirmation is uncertain: the engine
            // re-queries the registry by the exact package identity on resume.
            const confirmation = parsePublishConfirmation(published.stdout);
            if (confirmation === undefined) {
              return {
                outcome: "timeout",
                externalIdentity: { kind: "npm-package", value: `${target}@${manifest.version}` },
                error: "npm-publish: publish result did not confirm the frozen package@version",
                logs: ["npm-publish: publish result unconfirmed; querying registry on resume"]
              };
            }
            if (confirmation.name !== target || confirmation.version !== manifest.version) {
              return {
                outcome: "failed",
                externalIdentity: { kind: "npm-package", value: `${target}@${manifest.version}` },
                error: `npm-publish: published ${confirmation.name}@${confirmation.version} does not match frozen ${target}@${manifest.version}`,
                logs: ["npm-publish: refusing to satisfy the step with a different publish result"]
              };
            }
            return {
              outcome: "succeeded",
              externalId: manifest.version,
              logs: [`npm-publish: ${tarball}`]
            };
          } finally {
            // Remove the private snapshot on every exit path (success,
            // failure, or throw) so the verified bytes never linger.
            await rm(snapshot, { force: true }).catch(() => {});
          }
        }
        case "fresh-install-smoke": {
          const version = params.version;
          // P2-3: Require a concrete, pinned version. Without one, npx
          // resolves to "latest" (or a moving range), which could install a
          // different release than the one this workflow just published.
          if (version === undefined || !isConcreteVersion(version)) {
            return {
              outcome: "failed",
              error: `fresh-install-smoke: params.version ${version ?? "(missing)"} is not a concrete pinned version (e.g. 1.2.3)`,
              logs: ["fresh-install-smoke: refusing to install a moving or unpinned version"]
            };
          }
          // Install the released scoped package derived from the exact source
          // repository, not an unscoped or stale name.
          const pkg = params.package ?? derivePackageName(source);
          // P2-3: Validate the package spec is not an option.
          if (pkg.startsWith("-")) {
            return {
              outcome: "failed",
              error: `fresh-install-smoke: package ${pkg} must not start with '-' (would be interpreted as an npx option)`,
              logs: ["fresh-install-smoke: refusing to install a package that looks like an option"]
            };
          }
          // P2-2 (rr19): Install in a fresh temp directory with an isolated
          // npm cache, so npx cannot reuse a local node_modules binary. Then
          // run the installed binary directly and verify the output matches
          // the pinned version.
          const smokeDir = await mkdtemp(join(tmpdir(), "yui-smoke-"));
          const smokeCache = join(smokeDir, "npm-cache");
          try {
            const install = await run("npm", [
              "install",
              "--prefix", smokeDir,
              "--cache", smokeCache,
              "--no-audit", "--no-fund",
              `${pkg}@${version}`
            ]);
            if (install.code !== 0) {
              return { outcome: "failed", error: install.stderr.trim() || `npm install ${pkg}@${version} failed` };
            }
            // Derive the binary name from the package name (scoped or unscoped).
            const binName = pkg.includes("/") ? pkg.split("/").pop()! : pkg;
            const binPath = join(smokeDir, "node_modules", ".bin", binName);
            const smoke = await run(binPath, ["--version"]);
            if (smoke.code !== 0) {
              return { outcome: "failed", error: smoke.stderr.trim() || "fresh-install smoke failed" };
            }
            const output = smoke.stdout.trim();
            if (output !== version) {
              return {
                outcome: "failed",
                error: `fresh-install-smoke: installed version ${output} does not match pinned ${version}`,
                logs: [`fresh-install-smoke: refusing to accept a version mismatch (got ${output}, want ${version})`]
              };
            }
            return { outcome: "succeeded", externalId: version, logs: [`fresh-install-smoke: ${output}`] };
          } finally {
            await rm(smokeDir, { recursive: true, force: true }).catch(() => {});
          }
        }
        case "post-verify": {
          const command = params.command;
          if (command === undefined) {
            return { outcome: "failed", error: "post-verify requires params.command." };
          }
          const verified = await run("sh", ["-c", command], params.cwd);
          if (verified.code !== 0) {
            return { outcome: "failed", error: verified.stderr.trim() || `post-verify exited ${verified.code}` };
          }
          return { outcome: "succeeded", logs: [`post-verify: ${command}`] };
        }
        default:
          return { outcome: "failed", error: `Unsupported step kind: ${String(step.kind)}` };
      }
    }

    return {
      home: deps.home,
      async executeStep(input) {
        // Adapter-level idempotency: a crash after the effect landed but
        // before the engine persisted it re-invokes executeStep under the
        // same key. Replay the recorded success instead of producing a
        // second shell execution. A store that cannot be read fails the
        // step, since at-most-once cannot be proven.
        let recorded: ReleaseStepEffect | undefined;
        try {
          recorded = await idempotency.load(input.idempotencyKey);
        } catch (error) {
          return {
            outcome: "failed",
            error: `idempotency store unreadable: ${error instanceof Error ? error.message : String(error)}`,
            logs: ["executeStep: refusing to run without the idempotency record"]
          };
        }
        if (recorded !== undefined) {
          return {
            ...recorded,
            logs: [
              ...(recorded.logs ?? []),
              `idempotent: replayed recorded effect for ${input.idempotencyKey}`
            ]
          };
        }
        const effect = await executeStepOnce(input);
        if (effect.outcome === "succeeded") {
          try {
            await idempotency.recordSuccess(input.idempotencyKey, effect);
          } catch (error) {
            // The effect landed but its dedup record is not durable. Never
            // report success: a crash before the engine persisted the step
            // would re-run the effect. Fail closed as ambiguous, carrying a
            // queryable identity when the step kind has one so the engine
            // re-queries authoritatively on resume instead of re-submitting.
            const identity = await queryIdentityFor(input.step, input.params, effect, input.source, deps.home, run);
            return {
              outcome: "timeout",
              ...(identity === undefined ? {} : { externalIdentity: identity }),
              error: `idempotency record not persisted: ${error instanceof Error ? error.message : String(error)}`,
              logs: [
                ...(effect.logs ?? []),
                "executeStep: effect landed but its idempotency record is not durable; failing closed"
              ]
            };
          }
        }
        return effect;
      },
      async queryStepEffect({ step, source, externalIdentity }) {
        // P2-1: Check the durable idempotency store first. A recorded success
        // proves the effect landed even when the engine has no
        // externalIdentity (e.g. a crash between executeStep and the engine's
        // completeStep save). Without this, a successfully executed step is
        // permanently stranded as unconfirmed.
        const durable = await idempotency.load(step.idempotencyKey);
        if (durable !== undefined) {
          return { state: "exists", externalId: durable.externalId };
        }
        if (externalIdentity === undefined) {
          // P2-1 (rr19/rr20): When no identity was recorded (a hard exit
          // between the external effect and the idempotency/identity
          // persistence), derive the identity from the frozen plan for kinds
          // that support it. This prevents a permanently stranded unconfirmed
          // step when the effect actually landed.
          if (step.kind === "cli-update") {
            // P1-2 (rr23): A hard-exit cli-update may only be queried against
            // the exact activation target persisted to a durable file BEFORE
            // the irreversible effect. Never derive the target from the resume
            // caller's npm/PATH environment: a different global prefix on
            // resume could confirm a different installation. With no durable
            // record (the process exited before the pre-effect persistence)
            // the effect is unprovable, so fail closed.
            externalIdentity = await readPersistedCliUpdateIdentity(deps.home, step.idempotencyKey);
            if (externalIdentity === undefined) return { state: "unknown" };
          } else {
            const derived = deriveIdentityFromPlan(step, source);
            if (derived !== undefined) {
              externalIdentity = derived;
            } else {
              // A step that crashed before recording an effect identity cannot be
              // re-queried by a stable handle. The step plan alone is not an
              // authoritative handle for every kind, so fail closed: the engine
              // treats the disposition as unconfirmed rather than re-submitting.
              return { state: "unknown" };
            }
          }
        }
        switch (externalIdentity.kind) {
        case "pull-request": {
          // P2-2: Bind the query to the source repository and require the
          // PR's head to be the exact frozen commit. A same-numbered PR in a
          // different repository, or one whose head moved, must not confirm
          // the effect.
          if (source === undefined) return { state: "unknown" };
          const repo = `${source.repository.owner}/${source.repository.name}`;
          const found = await run("gh", [
            "pr", "view", externalIdentity.value,
            "--repo", repo,
            "--json", "number,headRefOid"
          ]);
          if (found.code !== 0) {
            // A non-zero exit is ambiguous (the PR may be gone, or the
            // transport failed); fail closed rather than authorizing a
            // re-submission.
            return { state: "unknown" };
          }
          const headInfo = parsePrHeadEntry(found.stdout);
          if (headInfo === undefined || headInfo.headSha !== source.commit) {
            return { state: "unknown" };
          }
          return { state: "exists", externalId: `pr:${headInfo.prNumber}` };
        }
        case "git-tag": {
          // A local tag is not authoritative: query the remote so a tag that
          // was never pushed reads as absent. The query runs inside the
          // step's source repository checkout, never the Controller's cwd.
          // An empty result (exit 0, no output) is an authoritative absent;
          // a non-zero exit is a transport failure and reads as unknown.
          //
          // Re-attest the checkout before querying: an answer from a foreign
          // or unverifiable origin is worthless (and a foreign origin could
          // confirm a tag we never pushed). Without the bound source or the
          // checkout path the binding cannot be checked, so fail closed.
          // P1-5: Verify both fetch and push URLs.
          const checkoutPath = step.params?.repositoryPath;
          if (source === undefined || checkoutPath === undefined) {
            return { state: "unknown" };
          }
          const fetchUrl = await run("git", ["remote", "get-url", "origin"], checkoutPath);
          if (fetchUrl.code !== 0 || !remoteMatchesRepository(fetchUrl.stdout, source.repository)) {
            return { state: "unknown" };
          }
          // P1-5: Verify ALL configured push URLs in the recovery path too.
          const pushUrls = await run("git", ["remote", "get-url", "--push", "--all", "origin"], checkoutPath);
          if (pushUrls.code !== 0) {
            return { state: "unknown" };
          }
          const recoveryPushUrls = pushUrls.stdout
            .split(/\r?\n/)
            .map((url) => url.trim())
            .filter((url) => url.length > 0);
          if (recoveryPushUrls.length === 0
            || recoveryPushUrls.some((url) => !remoteMatchesRepository(url, source.repository))) {
            return { state: "unknown" };
          }
          const found = await run(
            "git",
            ["ls-remote", "--tags", "origin", `refs/tags/${externalIdentity.value}`],
            checkoutPath
          );
          if (found.code !== 0) {
            return { state: "unknown" };
          }
          if (found.stdout.trim().length > 0) {
            // Verify the tag points at the expected source commit. A tag that
            // points at a different commit is not the effect we recorded.
            // Prefer the peeled ref (refs/tags/name^{}): for an annotated tag
            // the direct line names the tag object, not the commit it
            // records, so its SHA differs from the source commit even when
            // the tag is ours. The peeled line names the commit the tag
            // ultimately points at; a lightweight tag has no peeled line and
            // the direct line's SHA is the commit itself.
            const lines = found.stdout
              .split(/\r?\n/)
              .map((line) => line.trim())
              .filter((line) => line.length > 0);
            const peeled = lines.find((line) => line.endsWith(`refs/tags/${externalIdentity.value}^{}`));
            const direct = lines.find((line) => line.endsWith(`refs/tags/${externalIdentity.value}`));
            const actualCommit = (peeled ?? direct)?.split(/\s+/)[0];
            if (source !== undefined && actualCommit !== undefined && actualCommit !== source.commit) {
              return { state: "unknown" };
            }
            return { state: "exists", externalId: `tag:${externalIdentity.value}` };
          }
          return { state: "absent" };
        }
        case "npm-package": {
          // The externalIdentity value may be "package" or "package@version".
          // Query the exact version, not the latest, so a newer concurrent
          // publish cannot confirm our step.
          const atIndex = externalIdentity.value.lastIndexOf("@");
          let pkg = externalIdentity.value;
          let expectedVersion: string | undefined;
          if (atIndex > 0) {
            pkg = externalIdentity.value.slice(0, atIndex);
            expectedVersion = externalIdentity.value.slice(atIndex + 1);
          }
          // Fall back to the step params for the expected version.
          if (expectedVersion === undefined) {
            expectedVersion = step.params?.version;
          }
          // Without an exact version, `npm view <pkg>` answers for whatever
          // the latest publish is — a concurrent release could confirm our
          // step with someone else's version. Fail closed instead of
          // querying the moving "latest" target.
          if (expectedVersion === undefined) {
            return { state: "unknown" };
          }
          // P1 (rr24): an npm-publish recovery query may only run against
          // the exact npm executable and registry persisted BEFORE the
          // original effect. Never fall back to the resume caller's
          // npm/registry: a different mirror serving the same
          // version+integrity would falsely confirm environment A's
          // publish. With no durable record (the process exited before the
          // pre-effect persistence, or the record is malformed) the effect
          // is unprovable, so fail closed.
          const persistedTarget = await readPersistedNpmPublishTarget(deps.home, step.idempotencyKey);
          if (persistedTarget === undefined) {
            return { state: "unknown" };
          }
          const view = (field: string) => run(
            persistedTarget.npmPath,
            ["view", `${pkg}@${expectedVersion}`, field, "--registry", persistedTarget.registry]
          );
          const found = await view("version");
          if (found.code === 0 && found.stdout.trim().length > 0) {
            const actualVersion = found.stdout.trim();
            // The published version must match the exact expected version.
            if (actualVersion !== expectedVersion) {
              return { state: "unknown" };
            }
            // P1-4 (rr22): a matching version string alone does not prove
            // the frozen artifact landed. Compare the published
            // `dist.integrity` with the frozen source artifact's integrity:
            // a version republished with different bytes is a conflict and
            // is never confirmed. Without a frozen integrity the published
            // bytes cannot be proven to be the granted artifact, so fail
            // closed there too.
            const frozenIntegrity = source?.artifact?.integrity;
            if (frozenIntegrity === undefined) {
              return { state: "unknown" };
            }
            const integrity = await view("dist.integrity");
            if (integrity.code !== 0 || integrity.stdout.trim().length === 0) {
              return { state: "unknown" };
            }
            if (integrity.stdout.trim() !== frozenIntegrity) {
              return { state: "unknown" };
            }
            return { state: "exists", externalId: actualVersion };
          }
          // A 404 means the package/version does not exist (absent).
          if (/E404|404 Not Found/i.test(found.stderr)) {
            return { state: "absent" };
          }
          // A non-404 failure is a transport error; fail closed.
          return { state: "unknown" };
        }
        case "controller-home": {
          // P1-2 (rr22): the identity value is a JSON envelope
          // {home, globalPrefix?} that pins the exact activation target;
          // legacy identities are bare Home path strings and re-derive the
          // prefix from the caller's environment.
          let queriedHome = deps.home;
          let pinnedPrefix: string | undefined;
          const parsedIdentity = parseControllerHomeIdentity(externalIdentity.value);
          if (parsedIdentity !== undefined) {
            if (parsedIdentity.globalPrefix === undefined) return { state: "unknown" };
            queriedHome = parsedIdentity.home;
            pinnedPrefix = parsedIdentity.globalPrefix;
          } else {
            queriedHome = externalIdentity.value;
          }
          // P1-3 (rr20): Query the GLOBAL install target — the same binary
          // `cli-update` activates via `npm install --global` — not the
          // current checkout module. A checkout that happens to be the target
          // version must not confirm a global install that is stale or never
          // activated. A pinned prefix is used as-is; only legacy/unpinned
          // identities re-derive via `npm prefix --global`, never PATH.
          let globalPrefix = pinnedPrefix;
          if (globalPrefix === undefined) {
            const prefixResult = await run("npm", ["prefix", "--global"]);
            if (prefixResult.code !== 0) return { state: "unknown" };
            globalPrefix = prefixResult.stdout.trim();
            if (globalPrefix.length === 0) return { state: "unknown" };
          }
          const globalYui = join(globalPrefix, "bin", "yui");
          const homeEnv = { YUI_HOME: queriedHome };
          const checked = await run(process.execPath, [globalYui, "--json", "doctor"], undefined, homeEnv);
          if (checked.code !== 0) return { state: "unknown" };
          const expectedVersion = step.params?.version;
          if (expectedVersion !== undefined) {
            const versioned = await run(process.execPath, [globalYui, "--version"], undefined, homeEnv);
            if (versioned.code !== 0 || versioned.stdout.trim() !== expectedVersion) {
              return { state: "unknown" };
            }
          }
          // P1-1 (rr22): binary health alone does not prove the Controller
          // lifecycle handoff completed. Require a current Controller for
          // this exact Home and, when a version is frozen, that the running
          // Controller's identity reports the expected version. A hard exit
          // during the stop/activate/verify/start window leaves no current
          // Controller (or a wrong-version one), so the query fails closed.
          const lifecycle = await queryControllerLifecycle(run, globalYui, queriedHome, expectedVersion);
          if (lifecycle !== "confirmed") return { state: "unknown" };
          return { state: "exists" };
        }
        default:
          return { state: "unknown" };
      }
    }
  };
}

/**
 * The result of a PR head lookup. A failed lookup (transport error) is
 * distinguished from "no PR found" so the caller can fail closed. A found
 * PR carries its head object id: reuse requires it to equal the frozen
 * source commit, not just the head branch name.
 */
type PrLookupResult =
  | { readonly status: "found"; readonly prNumber: string; readonly headSha: string }
  | { readonly status: "not-found" }
  | { readonly status: "failed"; readonly error: string };

/**
 * Finds the open PR for a head ref. Prefers `gh pr view --head`; older gh
 * versions that lack the flag fall back to `gh pr list --head`. A non-zero
 * exit from both commands is a failed lookup (transport error), not an
 * authoritative "no PR found". Both paths request the head object id so the
 * caller can prove the PR names the frozen source commit before reuse.
 */
/**
 * Resolves the SHA a remote head branch currently points at, or undefined
 * when the branch cannot be resolved or the answer is not a 40-hex commit.
 * Used to prove the proposed PR head is the exact frozen source commit
 * before creating an external PR.
 */
async function resolveRemoteHead(
  run: CommandRunner,
  repo: string,
  head: string
): Promise<string | undefined> {
  const slash = repo.indexOf("/");
  if (slash <= 0) return undefined;
  const owner = repo.slice(0, slash);
  const name = repo.slice(slash + 1);
  const viewed = await run("gh", [
    "api",
    `repos/${owner}/${name}/git/ref/heads/${head}`,
    "--jq", ".object.sha"
  ]);
  if (viewed.code !== 0) return undefined;
  const sha = viewed.stdout.trim();
  return /^[0-9a-f]{40}$/i.test(sha) ? sha : undefined;
}

async function findHeadPullRequest(
  run: CommandRunner,
  head: string,
  repo: string
): Promise<PrLookupResult> {
  const viewed = await run("gh", [
    "pr", "view", "--head", head,
    "--repo", repo,
    "--json", "number,headRefOid"
  ]);
  if (viewed.code === 0) {
    const found = parsePrHeadEntry(viewed.stdout);
    if (found !== undefined) {
      return { status: "found", prNumber: found.prNumber, headSha: found.headSha };
    }
  }
  // A non-zero exit from `gh pr view` may mean "no PR for head" (exit 1 with
  // empty stdout) or a transport failure. The list fallback disambiguates.
  const listed = await run("gh", [
    "pr", "list", "--head", head,
    "--repo", repo,
    "--state", "open",
    "--json", "number,headRefOid"
  ]);
  if (listed.code === 0) {
    const found = parsePrHeadList(listed.stdout);
    if (found !== undefined) {
      return { status: "found", prNumber: found.prNumber, headSha: found.headSha };
    }
    // Authoritative empty result: no open PR for this head.
    return { status: "not-found" };
  }
  // Both commands failed: transport error, not "no PR found".
  return {
    status: "failed",
    error: listed.stderr.trim() || viewed.stderr.trim() || "gh PR lookup failed"
  };
}

/** Parses `gh pr view --json number,headRefOid` output. */
function parsePrHeadEntry(stdout: string): { prNumber: string; headSha: string } | undefined {
  try {
    return prHeadFromJson(JSON.parse(stdout.trim()) as unknown);
  } catch {
    return undefined;
  }
}

/** Parses the first entry of `gh pr list --json number,headRefOid` output. */
function parsePrHeadList(stdout: string): { prNumber: string; headSha: string } | undefined {
  try {
    const parsed: unknown = JSON.parse(stdout.trim());
    if (!Array.isArray(parsed) || parsed.length === 0) return undefined;
    return prHeadFromJson(parsed[0]);
  } catch {
    return undefined;
  }
}

function prHeadFromJson(value: unknown): { prNumber: string; headSha: string } | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const record = value as Record<string, unknown>;
  if (typeof record.number !== "number" || !Number.isFinite(record.number)) return undefined;
  if (typeof record.headRefOid !== "string" || record.headRefOid.length === 0) return undefined;
  return { prNumber: String(record.number), headSha: record.headRefOid };
}

async function mergePullRequest(
  run: CommandRunner,
  source: ReleaseWorkflowSource,
  number: string | undefined,
  params: Readonly<Record<string, string>>
): Promise<ReleaseStepEffect> {
  if (number === undefined) {
    return { outcome: "failed", error: "merge requires params.pr or a prior PR externalId." };
  }
  // P1-4: Restrict the merge method to explicit values. "auto" and "queue"
  // would let GitHub choose the method, which could produce a merge commit
  // when the caller expected a rebase or squash.
  const method = params.method ?? "squash";
  if (method !== "merge" && method !== "rebase" && method !== "squash") {
    return {
      outcome: "failed",
      error: `merge: method ${method} is not allowed; use merge, rebase, or squash`,
      logs: ["merge: refusing to merge with an unrestricted method"]
    };
  }
  // Strip the "pr:" display prefix; the CLI expects a bare number.
  const prNumber = number.startsWith("pr:") ? number.slice(3) : number;
  // Only a canonical positive decimal PR number is accepted. Anything else
  // (flags, URLs, branch names, empty) would be passed to `gh pr merge` and
  // could inject admin flags or select the wrong PR.
  if (!/^[1-9][0-9]*$/.test(prNumber)) {
    return {
      outcome: "failed",
      error: `merge: PR number must be a positive integer: ${number}`,
      logs: ["merge: refusing to merge with an invalid PR selector"]
    };
  }
  const merged = await run("gh", [
    "pr", "merge", prNumber,
    "--repo", `${source.repository.owner}/${source.repository.name}`,
    "--match-head-commit", source.commit,
    `--${method}`,
    ...(params.admin === "true" ? ["--admin"] : [])
  ]);
  if (merged.code !== 0) {
    return { outcome: "failed", error: merged.stderr.trim() || "gh pr merge failed" };
  }
  return { outcome: "succeeded", externalId: `merge:${prNumber}`, logs: [`merge: PR #${prNumber}`] };
}

/**
 * A publish that failed after the upload (a transport error) is ambiguous:
 * the registry may have accepted the package. Such a failure carries an
 * externalIdentity so the engine queries the registry on resume instead of
 * re-publishing. A pre-upload failure (auth, bad tarball) is definite.
 */
function isTransportFailure(stderr: string): boolean {
  return /timeout|timed out|network|ECONN|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|fetch failed|socket/i.test(stderr);
}

/** The scoped package name for a source repository: @owner/name. */
function derivePackageName(source: ReleaseWorkflowSource): string {
  return `@${source.repository.owner}/${source.repository.name}`;
}

/**
 * The queryable identity for a succeeded effect whose idempotency record could
 * not be persisted. The engine re-queries by this identity on resume instead
 * of re-submitting the effect. Only kinds with a `queryStepEffect` case can
 * be re-queried; the rest return undefined and the caller fails closed
 * without an identity (the engine then treats the step as failed rather than
 * re-running an unrecorded success).
 */
async function queryIdentityFor(
  step: ReleaseStepPlan,
  params: Readonly<Record<string, string>>,
  effect: ReleaseStepEffect,
  source: ReleaseWorkflowSource,
  home: string,
  run: CommandRunner
): Promise<Readonly<{ kind: string; value: string }> | undefined> {
  switch (step.kind) {
    case "cli-update":
      // queryStepEffect verifies the installed version against step.params.
      // P1-2 (rr22): pin the resolved global prefix so a resume query checks
      // the same activation target instead of re-deriving it from the
      // caller's npm/PATH environment.
      return await controllerHomeIdentity(run, home);
    case "version-tag": {
      const tag = effect.externalId?.replace(/^tag:/, "") ?? params.tag;
      return tag === undefined || tag.length === 0
        ? undefined
        : { kind: "git-tag", value: tag };
    }
    case "npm-publish": {
      const version = effect.externalId;
      if (version === undefined || version.length === 0) return undefined;
      const pkg = params.package ?? derivePackageName(source);
      return { kind: "npm-package", value: `${pkg}@${version}` };
    }
    case "pr-create-or-reuse": {
      const pr = effect.externalId?.replace(/^pr:/, "");
      return pr === undefined || pr.length === 0
        ? undefined
        : { kind: "pull-request", value: pr };
    }
    default:
      return undefined;
  }
}

/**
 * Derive an authoritative query identity from the frozen step plan when no
 * identity was recorded (a hard exit between the external effect and the
 * idempotency/identity persistence). Only kinds whose identity is fully
 * determined by the immutable plan + source can be recovered this way.
 */
function deriveIdentityFromPlan(
  step: ReleaseStepPlan,
  source: ReleaseWorkflowSource | undefined
): Readonly<{ kind: string; value: string }> | undefined {
  switch (step.kind) {
    case "version-tag": {
      const tag = step.params?.tag;
      if (tag === undefined || tag.length === 0) return undefined;
      return { kind: "git-tag", value: tag };
    }
    default:
      return undefined;
  }
}
const CANONICAL_REMOTE_HOST = "github.com";

/**
 * Whether a git remote URL names the granted repository on the canonical host.
 * Accepts the common spellings (https://github.com/owner/name(.git),
 * ssh://git@github.com/owner/name(.git), git@github.com:owner/name(.git)) and
 * compares the host, owner, and name case-insensitively, matching GitHub's
 * repository identity. A URL on any other host is rejected even when its
 * owner/name path matches.
 */
function remoteMatchesRepository(
  remoteUrl: string,
  repository: { owner: string; name: string }
): boolean {
  const trimmed = remoteUrl.trim();
  if (trimmed.length === 0) return false;
  let rest = trimmed;
  let host: string;
  const schemeIndex = rest.indexOf("://");
  if (schemeIndex !== -1) {
    // scheme://[user@]host[:port]/path
    rest = rest.slice(schemeIndex + 3);
    const slashIndex = rest.indexOf("/");
    if (slashIndex === -1) return false;
    host = rest.slice(0, slashIndex);
    rest = rest.slice(slashIndex + 1);
  } else {
    // scp-like: [user@]host:path
    const colonIndex = rest.indexOf(":");
    if (colonIndex === -1) return false;
    host = rest.slice(0, colonIndex);
    rest = rest.slice(colonIndex + 1);
  }
  // Strip userinfo and port from the authority before comparing.
  const canonicalHost = host.split("@").pop()!.split(":")[0]!.trim().toLowerCase();
  if (canonicalHost !== CANONICAL_REMOTE_HOST) return false;
  rest = rest.replace(/\.git$/, "").replace(/\/+$/, "");
  const segments = rest.split("/").filter((segment) => segment.length > 0);
  if (segments.length < 2) return false;
  const owner = segments[segments.length - 2]!;
  const name = segments[segments.length - 1]!;
  return owner.toLowerCase() === repository.owner.toLowerCase()
    && name.toLowerCase() === repository.name.toLowerCase();
}

/**
 * Reads package/package.json out of an npm tarball via the injected command
 * runner. Returns undefined when the tarball cannot be read or the manifest
 * is not a package.json with a non-empty name and version, so the caller can
 * fail closed without publishing an unverified artifact.
 */
async function readTarballManifest(
  run: CommandRunner,
  tarball: string
): Promise<{
  name: string;
  version: string;
  publishConfig?: { registry?: string };
} | undefined> {
  const extracted = await run("tar", ["-xOf", tarball, "package/package.json"]);
  if (extracted.code !== 0) return undefined;
  try {
    const manifest = JSON.parse(extracted.stdout) as {
      name?: unknown;
      version?: unknown;
      publishConfig?: unknown;
    };
    if (typeof manifest.name !== "string" || manifest.name.length === 0) return undefined;
    if (typeof manifest.version !== "string" || manifest.version.length === 0) return undefined;
    const publishConfig = isRecord(manifest.publishConfig)
      && typeof manifest.publishConfig.registry === "string"
      && manifest.publishConfig.registry.trim().length > 0
      ? { registry: manifest.publishConfig.registry.trim() }
      : undefined;
    return {
      name: manifest.name,
      version: manifest.version,
      ...(publishConfig === undefined ? {} : { publishConfig })
    };
  } catch {
    return undefined;
  }
}

/**
 * Parses the `npm publish` result line ("+ name@version") and returns the
 * published id. Takes the last such line (the publish summary); undefined
 * when the output carries no parseable confirmation.
 */
function parsePublishConfirmation(
  stdout: string
): { name: string; version: string } | undefined {
  const lines = stdout.split(/\r?\n/);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index]!.trim();
    if (!line.startsWith("+")) continue;
    const body = line.slice(1).trim();
    const at = body.lastIndexOf("@");
    if (at <= 0) continue;
    const name = body.slice(0, at);
    const version = body.slice(at + 1);
    if (name.length === 0 || version.length === 0 || /\s/.test(version)) continue;
    return { name, version };
  }
  return undefined;
}

/**
 * Resolve the global npm prefix the same way the update port activates it
 * (`npm prefix --global` + `bin/yui`). Returns undefined when the prefix
 * cannot be resolved, callers must fail closed rather than persist a Home-only
 * identity that would be re-derived from a different environment.
 */
async function resolveGlobalPrefix(run: CommandRunner): Promise<string | undefined> {
  const result = await run("npm", ["prefix", "--global"]);
  if (result.code !== 0) return undefined;
  const prefix = result.stdout.trim();
  return prefix.length > 0 ? prefix : undefined;
}

/**
 * The controller-home query identity for a cli-update effect. The value is a
 * JSON envelope carrying the Home and — when resolvable — the exact global
 * prefix that was activated, so a resume query checks the same installation
 * instead of re-deriving the target from the caller's npm/PATH environment
 * (P1-2, rr22). Legacy identities are bare Home path strings; the query
 * accepts both shapes via {@link parseControllerHomeIdentity}.
 */
async function controllerHomeIdentity(
  run: CommandRunner,
  home: string
): Promise<Readonly<{ kind: string; value: string }> | undefined> {
  const globalPrefix = await resolveGlobalPrefix(run);
  if (globalPrefix === undefined) return undefined;
  return {
    kind: "controller-home",
    value: JSON.stringify({
      home,
      globalPrefix
    })
  };
}

/**
 * The durable pre-effect record path for a cli-update attempt: the exact
 * activation target (Home + global npm prefix) keyed by the step's
 * idempotency key. Written before the irreversible effect and never deleted,
 * so a hard-exit recovery query can re-query the same installation (P1-2,
 * rr23).
 */
function cliUpdateIdentityPath(home: string, idempotencyKey: string): string {
  return join(home, "release", "cli-update-identity", `${idempotencyKey}.json`);
}

/**
 * Persist a cli-update's exact activation target BEFORE the irreversible
 * effect. A hard exit between this write and the engine's identity persistence
 * still leaves a durable receipt recovery can read. Best-effort by contract:
 * callers wrap this in try/catch and proceed with the update regardless.
 */
async function persistCliUpdateIdentity(
  run: CommandRunner,
  home: string,
  idempotencyKey: string
): Promise<void> {
  const identity = await controllerHomeIdentity(run, home);
  if (identity === undefined) return;
  const target = cliUpdateIdentityPath(home, idempotencyKey);
  await mkdir(dirname(target), { recursive: true });
  // Write to a temp file in the same directory and rename: the rename is
  // atomic on the same filesystem, so a crash never leaves a torn record.
  const temp = `${target}.${randomBytes(8).toString("hex")}.tmp`;
  await writeFile(temp, identity.value, { flag: "wx" });
  await rename(temp, target);
}

/**
 * Read the durable pre-effect activation target for a hard-exit cli-update
 * recovery query. Returns undefined when the record is absent or malformed;
 * the caller then fails closed rather than deriving the target from the resume
 * caller's environment (P1-2, rr23).
 */
async function readPersistedCliUpdateIdentity(
  home: string,
  idempotencyKey: string
): Promise<Readonly<{ kind: string; value: string }> | undefined> {
  let raw: string;
  try {
    raw = await readFile(cliUpdateIdentityPath(home, idempotencyKey), "utf8");
  } catch {
    return undefined;
  }
  const parsed = parseControllerHomeIdentity(raw);
  if (parsed === undefined || parsed.globalPrefix === undefined) return undefined;
  return { kind: "controller-home", value: JSON.stringify(parsed) };
}

/**
 * The durable pre-effect record path for an npm-publish attempt: the exact
 * npm executable and registry the publish ran against, keyed by the step's
 * idempotency key. Written before the irreversible effect and never deleted,
 * so a resume recovery query re-queries the same registry through the same
 * npm binary instead of trusting the resume caller's environment (P1, rr24).
 */
function npmPublishTargetPath(home: string, idempotencyKey: string): string {
  return join(home, "release", "npm-publish-target", `${idempotencyKey}.json`);
}

/**
 * Persist an npm-publish's exact executable and registry BEFORE the
 * irreversible effect. A hard exit between this write and the engine's
 * identity persistence still leaves a durable receipt recovery can read.
 */
async function persistNpmPublishTarget(
  home: string,
  idempotencyKey: string,
  targetValue: Readonly<{ npmPath: string; registry: string }>
): Promise<void> {
  const target = npmPublishTargetPath(home, idempotencyKey);
  await mkdir(dirname(target), { recursive: true });
  // Write to a temp file in the same directory and rename: the rename is
  // atomic on the same filesystem, so a crash never leaves a torn record.
  const temp = `${target}.${randomBytes(8).toString("hex")}.tmp`;
  await writeFile(temp, JSON.stringify(targetValue), { flag: "wx" });
  await rename(temp, target);
}

/** Resolve the registry npm publish will use for the verified package. */
async function resolveNpmPublishRegistry(
  run: CommandRunner,
  packageName: string,
  publishConfigRegistry?: string
): Promise<string | undefined> {
  if (publishConfigRegistry !== undefined && publishConfigRegistry.trim().length > 0) {
    return publishConfigRegistry.trim();
  }
  const scope = packageName.startsWith("@")
    ? packageName.slice(0, packageName.indexOf("/"))
    : undefined;
  if (scope !== undefined) {
    const scoped = await run("npm", ["config", "get", `${scope}:registry`]);
    const scopedRegistry = normalizeNpmRegistry(scoped.stdout, scoped.code);
    if (scopedRegistry !== undefined) return scopedRegistry;
  }
  const defaultRegistry = await run("npm", ["config", "get", "registry"]);
  return normalizeNpmRegistry(defaultRegistry.stdout, defaultRegistry.code);
}

function normalizeNpmRegistry(stdout: string, code: number): string | undefined {
  if (code !== 0) return undefined;
  const value = stdout.trim();
  return value.length === 0 || value === "undefined" ? undefined : value;
}

/**
 * Read the durable pre-effect npm executable and registry for an
 * npm-publish recovery query. Returns undefined when the record is absent
 * or malformed; the caller then fails closed rather than querying the
 * resume caller's npm/registry (P1, rr24).
 */
async function readPersistedNpmPublishTarget(
  home: string,
  idempotencyKey: string
): Promise<Readonly<{ npmPath: string; registry: string }> | undefined> {
  let raw: string;
  try {
    raw = await readFile(npmPublishTargetPath(home, idempotencyKey), "utf8");
  } catch {
    return undefined;
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (
      !isRecord(parsed)
      || typeof parsed.npmPath !== "string" || parsed.npmPath.length === 0
      || typeof parsed.registry !== "string" || parsed.registry.length === 0
    ) {
      return undefined;
    }
    return { npmPath: parsed.npmPath, registry: parsed.registry };
  } catch {
    return undefined;
  }
}

/**
 * Parse a controller-home identity value. Accepts the JSON envelope
 * {home, globalPrefix?} written by {@link controllerHomeIdentity}; a legacy
 * bare Home path string (or any unparseable value) yields undefined so the
 * caller treats the raw value as the Home.
 */
function parseControllerHomeIdentity(
  value: string
): { home: string; globalPrefix?: string } | undefined {
  try {
    const parsed: unknown = JSON.parse(value);
    if (!isRecord(parsed) || typeof parsed.home !== "string" || parsed.home.length === 0) {
      return undefined;
    }
    return {
      home: parsed.home,
      ...(typeof parsed.globalPrefix === "string" && parsed.globalPrefix.length > 0
        ? { globalPrefix: parsed.globalPrefix }
        : {})
    };
  } catch {
    return undefined;
  }
}

/**
 * Verify the replacement Controller's lifecycle identity for a controller-
 * home recovery query (P1-1, rr22/rr23). Binary health (`doctor`/`version`)
 * alone does not prove the Controller handoff completed: a hard exit during
 * the stop/activate/verify/start window can leave the global binary healthy
 * with no current Controller (or a wrong-version one). This requires a
 * `current` Controller resource for the exact Home and, when a version is
 * frozen, that the running Controller's authenticated identity matches the
 * activated artifact on ALL THREE production startup checks
 * ({@link assertActivatedControllerIdentity}): the Node.js executable path,
 * the exact Controller entrypoint derived from the pinned global binary, and
 * the package version. A same-version Controller launched from a foreign
 * installation — or a malformed identity — fails closed. Anything unprovable
 * returns "unknown" so the step is never confirmed.
 */
async function queryControllerLifecycle(
  run: CommandRunner,
  globalYui: string,
  home: string,
  expectedVersion: string | undefined
): Promise<"confirmed" | "unknown"> {
  const homeEnv = { YUI_HOME: home };
  const status = await run(process.execPath, [globalYui, "--json", "controller", "status"], undefined, homeEnv);
  if (status.code !== 0) return "unknown";
  let envelope: unknown;
  try {
    envelope = JSON.parse(status.stdout);
  } catch {
    return "unknown";
  }
  if (!isRecord(envelope) || envelope.ok !== true || !isRecord(envelope.data)) return "unknown";
  const resources = envelope.data.resources;
  if (!Array.isArray(resources)) return "unknown";
  const resolvedHome = resolve(home);
  const current = resources.find((resource) => (
    isRecord(resource)
    && resource.kind === "controller"
    && resource.state === "current"
    && typeof resource.yuiHome === "string"
    && resolve(resource.yuiHome) === resolvedHome
  ));
  if (current === undefined) return "unknown";
  if (expectedVersion !== undefined) {
    const identity = await run(process.execPath, [globalYui, "--json", "controller", "identity"], undefined, homeEnv);
    if (identity.code !== 0) return "unknown";
    let identityEnvelope: unknown;
    try {
      identityEnvelope = JSON.parse(identity.stdout);
    } catch {
      return "unknown";
    }
    if (!isRecord(identityEnvelope) || identityEnvelope.ok !== true || !isRecord(identityEnvelope.data)) {
      return "unknown";
    }
    const data = identityEnvelope.data;
    if (data.version !== expectedVersion) return "unknown";
    if (typeof data.executablePath !== "string" || data.executablePath !== process.execPath) {
      return "unknown";
    }
    if (!Array.isArray(data.args)
      || data.args.length !== 1
      || typeof data.args[0] !== "string"
      || data.args[0] !== activatedControllerEntrypoint(globalYui)) {
      return "unknown";
    }
  }
  return "confirmed";
}

/**
 * Write the verified tarball bytes to a workflow-private temp file with a
 * random name and read-only permissions (P1-3, rr22). The manifest
 * inspection and `npm publish` both read this snapshot, so replacing the
 * original path after the integrity check cannot change what is published.
 * The caller removes the snapshot once publish completes.
 */
async function writeVerifiedTarballSnapshot(bytes: Buffer): Promise<string> {
  const snapshot = join(tmpdir(), `yui-release-snapshot-${randomBytes(12).toString("hex")}.tgz`);
  // "wx" fails if the random name already exists, so a pre-existing file
  // (or symlink) can never be overwritten or followed.
  await writeFile(snapshot, bytes, { flag: "wx" });
  await chmod(snapshot, 0o400);
  return snapshot;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
