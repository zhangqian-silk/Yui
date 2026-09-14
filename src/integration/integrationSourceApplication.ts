import { execFile } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { promisify } from "node:util";
import type { GitWorkspacePort } from "../repository/gitWorkspace.js";
import type { TaskStore } from "../storage/taskStore.js";
import { queueLeaderWakeup } from "../scheduler/wakeupQueue.js";
import {
  recordIntegrationConflict, requireResolutionDecision, updateIntegrationAttempt,
  type IntegrationAttempt
} from "./integrationAttempt.js";

const execute = promisify(execFile);
type Workspace = Readonly<{ path: string; branch: string }>;

/** Each Git ref-changing command has an attempt-owned cursor and reflog action.
 * Re-entry consumes the exact branch ref transition, never clean HEAD alone.
 * Git's own in-progress metadata identifies an unfinished operation. Missing
 * evidence is a diagnosis for the Leader, not permission to replay an effect. */
export async function applyIntegrationSource(input: Readonly<{
  attempt: IntegrationAttempt;
  workspace: Workspace;
  remoteUrl?: string;
  git: GitWorkspacePort;
  store: TaskStore;
  now: () => Date;
}>): Promise<IntegrationAttempt> {
  let current = input.attempt;
  const { workspace, store, now } = input;
  const path = workspace.path;
  const source = current.source;
  const save = (patch: Parameters<typeof updateIntegrationAttempt>[1]) => {
    const next = updateIntegrationAttempt(current, patch, now());
    store.saveIntegrationAttempt(current.taskId, next);
    current = next;
  };
  const pause = (affectedPaths: string[], kind: string) => {
    const pending = recordIntegrationConflict(current, {
      affectedPaths, summary: `${kind} conflicts in ${current.targetRef}; resolve files and continue.`
    }, now());
    store.transaction(tx => {
      tx.saveIntegrationAttempt(current.taskId, pending);
      if (current.status !== "conflicted"
        || JSON.stringify(current.conflict?.affectedPaths) !== JSON.stringify(affectedPaths)) {
        queueLeaderWakeup(tx, current.taskId, `integration-conflicted:${current.id}`, now());
      }
    });
    return pending;
  };
  if (source.kind === "historical-change-sets") {
    throw new Error("Historical Integration source has no current application proof; preserve evidence and abort explicitly.");
  }
  if (source.kind === "work-item" && source.strategy === "manual") {
    if (current.candidateCommit !== undefined) {
      await assertIntegrationCandidate(path, current.candidateCommit);
      return current;
    }
    if (current.resolution?.action !== "manual-resolution") {
      const pending = requireResolutionDecision(current, {
        affectedPaths: [], summary: "Manual WorkItem integration; apply the result and record its rationale."
      }, now());
      store.saveIntegrationAttempt(current.taskId, pending);
      return pending;
    }
    await assertIntegrationCandidate(path);
    save({ status: "running", candidateCommit: await line(path, "rev-parse", "HEAD") });
    return current;
  }
  const sourceDigest = integrationSourceDigest(current, workspace);
  const commits = source.kind === "work-item" && source.strategy === "cherry-pick"
    ? (await command(path, ["rev-list", "--reverse", `${source.startCommit}..${source.resultCommit}`]))
      .trim().split("\n").filter(Boolean)
    : [source.kind === "upstream" ? source.remoteCommit : source.resultCommit];
  const kind = source.kind === "upstream" ? "rebase" : source.strategy;
  const branch = workspace.branch.startsWith("refs/") ? workspace.branch : `refs/heads/${workspace.branch}`;
  const active = await activeGitOperation(path);
  if (current.sourceProgress === undefined) {
    // Only a pristine candidate can establish this attempt's first receipt.
    // An unfinished operation without that receipt belongs to explicit recovery.
    const head = await line(path, "rev-parse", "HEAD");
    if (active !== undefined) {
      throw new Error("Active Git operation has no attempt-owned progress receipt; preserve it and choose explicit recovery.");
    } else if (head !== current.beforeCommit || current.status === "conflicted") {
      throw new Error("Integration source completion is unproven: no attempt-owned Git receipt. Preserve the candidate; do not replay.");
    } else {
      await assertIntegrationCandidate(path, current.beforeCommit);
    }
    save({ sourceProgress: {
      workspace: resolve(path), branch, sourceDigest, completedSteps: 0,
      head: current.beforeCommit
    } });
  }
  let progress = current.sourceProgress!;
  if (progress.workspace !== resolve(path) || progress.branch !== branch
    || progress.sourceDigest !== sourceDigest || progress.completedSteps > commits.length) {
    throw new Error("Integration source/workspace identity changed; no Git operation or check was started.");
  }
  if (current.candidateCommit !== undefined) {
    if (progress.completedSteps !== commits.length || progress.activeAction !== undefined
      || progress.head !== current.candidateCommit) {
      throw new Error("Integration candidate does not match its source application receipt.");
    }
    await assertIntegrationCandidate(path, current.candidateCommit);
    return current;
  }
  for (let index = progress.completedSteps; index < commits.length; index++) {
    const commit = commits[index]!;
    let fresh = false;
    if (progress.activeAction === undefined) {
      await assertIntegrationCandidate(path, progress.head);
      if (await succeeds(path, ["merge-base", "--is-ancestor", commit, progress.head])) {
        // Already-represented input is proven by ancestry, without a Git effect.
        save({ sourceProgress: { ...progress, completedSteps: index + 1 } });
        progress = current.sourceProgress!;
        continue;
      }
      if (source.kind === "upstream") {
        if (input.remoteUrl === undefined || input.git.fetchRemoteHeadIntoWorktree === undefined) {
          throw new Error("Upstream Integration has no remote fetch capability.");
        }
        const fetched = await input.git.fetchRemoteHeadIntoWorktree({
          repositoryPath: path, remoteUrl: input.remoteUrl, branch: source.branch
        });
        if (fetched.commit !== commit) {
          throw new Error(`Upstream moved: ${fetched.commit}; expected ${commit}.`);
        }
      }
      save({ sourceProgress: { ...progress, activeAction: actionId() } });
      progress = current.sourceProgress!;
      fresh = true;
    }
    const action = progress.activeAction!;
    const operation = await activeGitOperation(path);
    if (!fresh && operation === undefined) {
      await assertIntegrationCandidate(path);
      const provenEmpty = kind === "cherry-pick" && progress.emptyResolution === true
        && await line(path, "rev-parse", "HEAD") === progress.head
        && (await command(path, ["symbolic-ref", "HEAD"])).trim() === branch;
      if (!provenEmpty && !await hasExactRefReceipt(path, branch, progress.head, action)) {
        throw new Error("Git application outcome is unproven: exact attempt reflog receipt is missing; inspect or abort, never blindly replay.");
      }
    } else {
      if (operation !== undefined) {
        await assertOperation(path, kind, commit, progress.head, branch, source);
      }
      const unresolved = await conflicts(path);
      if (unresolved.length > 0) {
        return pause(unresolved, kind);
      }
      if (!fresh && current.status !== "conflicted") {
        throw new Error("Git operation is present but no paused conflict is recorded; inspect its execution before continuing.");
      }
      try {
        if (operation !== undefined) {
          if (kind === "rebase") {
            await command(path, ["rebase", "--continue"], action);
          } else if (kind === "merge") {
            await command(path, ["commit", "--no-edit"], action);
          } else {
            const empty = await succeeds(path, ["diff", "--cached", "--quiet"]);
            if (empty) {
              save({ sourceProgress: { ...progress, emptyResolution: true } });
              progress = current.sourceProgress!;
            }
            await command(path, ["cherry-pick", empty ? "--skip" : "--continue"], action);
          }
        } else if (kind === "rebase" && source.kind === "upstream") {
          await command(path, ["rebase", "--onto", commit, source.taskBaseCommit, workspace.branch], action);
        } else if (kind === "merge") {
          await command(path, ["merge", "--no-edit", "--no-ff", commit], action);
        } else if (kind === "ff") {
          await command(path, ["merge", "--ff-only", commit], action);
        } else {
          // Choose from a read, not from a failed mutating merge: a Git error
          // after a ref update is not proof that it is safe to cherry-pick.
          const fastForward = await succeeds(path, ["merge-base", "--is-ancestor", progress.head, commit]);
          await command(path, fastForward ? ["merge", "--ff-only", commit] : ["cherry-pick", commit], action);
        }
      } catch (error) {
        const affectedPaths = await conflicts(path);
        if (affectedPaths.length > 0) return pause(affectedPaths, kind);
        if (kind !== "cherry-pick" || await activeGitOperation(path) !== "cherry-pick"
          || !await succeeds(path, ["diff", "--cached", "--quiet"])) throw error;
        await assertOperation(path, kind, commit, progress.head, branch, source);
        save({ sourceProgress: { ...progress, emptyResolution: true } });
        progress = current.sourceProgress!;
        await command(path, ["cherry-pick", "--skip"], action);
      }
    }
    await assertIntegrationCandidate(path);
    const head = await line(path, "rev-parse", "HEAD");
    save({ status: "running", conflict: undefined, sourceProgress: {
      workspace: progress.workspace, branch, sourceDigest, completedSteps: index + 1, head
    } });
    progress = current.sourceProgress!;
  }
  await assertIntegrationCandidate(path, progress.head);
  save({ status: "running", conflict: undefined, candidateCommit: progress.head });
  return current;
}

export function assertRecordedSourceCandidate(attempt: IntegrationAttempt, workspace: Workspace): void {
  if (attempt.source.kind === "work-item" && attempt.source.strategy === "manual"
    && attempt.resolution?.action === "manual-resolution") return;
  const progress = attempt.sourceProgress;
  const branch = workspace.branch.startsWith("refs/") ? workspace.branch : `refs/heads/${workspace.branch}`;
  if (progress === undefined || progress.activeAction !== undefined
    || progress.head !== attempt.candidateCommit || progress.workspace !== resolve(workspace.path)
    || progress.branch !== branch || progress.sourceDigest !== integrationSourceDigest(attempt, workspace)) {
    throw new Error("Integration candidate does not match its recorded source/workspace identity.");
  }
}

function integrationSourceDigest(attempt: IntegrationAttempt, workspace: Workspace): string {
  return createHash("sha256").update(JSON.stringify([
    attempt.taskId, attempt.id, attempt.projectId, attempt.targetRef, attempt.beforeCommit,
    attempt.source, resolve(workspace.path), workspace.branch
  ])).digest("hex");
}

export async function assertIntegrationCandidate(path: string, expectedHead?: string, expectedBranch?: string): Promise<void> {
  if (await activeGitOperation(path) !== undefined
    || (await command(path, ["status", "--porcelain=v1", "--untracked-files=all"])).trim() !== "") {
    throw new Error("Integration candidate must be clean, with no unfinished Git operation.");
  }
  const head = await line(path, "rev-parse", "HEAD");
  if (expectedHead !== undefined && head !== expectedHead) {
    throw new Error(`Integration candidate moved to ${head}; expected ${expectedHead}.`);
  }
  if (expectedBranch !== undefined) {
    const branch = expectedBranch.startsWith("refs/") ? expectedBranch : `refs/heads/${expectedBranch}`;
    if ((await command(path, ["symbolic-ref", "HEAD"])).trim() !== branch) {
      throw new Error("Integration candidate changed its owned branch.");
    }
  }
}

async function assertOperation(
  path: string, kind: string, commit: string, before: string, branch: string,
  source: IntegrationAttempt["source"]
): Promise<void> {
  const active = await activeGitOperation(path);
  if (active !== kind) throw new Error(`Integration expected ${kind}, found ${active ?? "no active Git operation"}.`);
  if (kind === "rebase") {
    const directory = await gitPath(path, "rebase-merge");
    // Yui invokes the merge backend explicitly. A legacy apply-backend
    // operation cannot be silently treated as the same execution.
    const [onto, original, headName] = await Promise.all(
      ["onto", "orig-head", "head-name"].map(name => readFile(resolve(directory, name), "utf8"))
    );
    if (source.kind !== "upstream" || onto.trim() !== commit
      || original.trim() !== before || headName.trim() !== branch) {
      throw new Error("Active rebase does not belong to this Integration source and target.");
    }
  } else {
    const activeSource = await line(path, "rev-parse", kind === "merge" ? "MERGE_HEAD" : "CHERRY_PICK_HEAD");
    if (activeSource !== commit || await line(path, "rev-parse", "HEAD") !== before
      || (await command(path, ["symbolic-ref", "HEAD"])).trim() !== branch) {
      throw new Error("Active Git operation does not belong to this Integration step.");
    }
  }
}

async function activeGitOperation(path: string): Promise<string | undefined> {
  for (const dir of ["rebase-merge", "rebase-apply"]) {
    try {
      await readFile(resolve(await gitPath(path, dir), "head-name"));
      return "rebase";
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  if (await succeeds(path, ["rev-parse", "--verify", "MERGE_HEAD"])) return "merge";
  if (await succeeds(path, ["rev-parse", "--verify", "CHERRY_PICK_HEAD"])) return "cherry-pick";
  // REBASE_HEAD is deliberately ignored: it can outlive a finished rebase.
  return undefined;
}

async function hasExactRefReceipt(path: string, branch: string, before: string, action: string): Promise<boolean> {
  if ((await command(path, ["symbolic-ref", "HEAD"])).trim() !== branch) return false;
  const head = await line(path, "rev-parse", "HEAD");
  const log = await readFile(await gitPath(path, `logs/${branch}`), "utf8");
  const last = log.trimEnd().split("\n").at(-1) ?? "";
  const [transition, message] = last.split("\t");
  const [oldHead, newHead] = (transition ?? "").split(" ");
  return oldHead === before && newHead === head
    && (message === action || message?.startsWith(`${action}:`) === true
      || message?.startsWith(`${action} (finish):`) === true);
}

const actionId = () => `yui-integration-${randomBytes(16).toString("hex")}`;
async function gitPath(path: string, name: string): Promise<string> {
  const value = (await command(path, ["rev-parse", "--git-path", name])).trim();
  return isAbsolute(value) ? value : resolve(path, value);
}
async function conflicts(path: string): Promise<string[]> {
  return (await command(path, ["diff", "--name-only", "--diff-filter=U"])).trim().split("\n").filter(Boolean);
}
async function line(path: string, ...args: string[]): Promise<string> {
  return (await command(path, args)).trim();
}
async function succeeds(path: string, args: string[], action?: string): Promise<boolean> {
  try { await command(path, args, action); return true; } catch { return false; }
}
async function command(path: string, args: string[], action?: string): Promise<string> {
  try {
    return (await execute("git", [
      "-C", path, "-c", "user.name=Yui", "-c", "user.email=yui@local",
      "-c", "core.editor=true", "-c", "rebase.backend=merge", ...args
    ], {
      encoding: "utf8", maxBuffer: 16 * 1024 * 1024, timeout: 120_000,
      env: { ...process.env, ...(action === undefined ? {} : { GIT_REFLOG_ACTION: action }) }
    })).stdout;
  } catch (error) {
    throw new Error(`Integration Git failed: ${(error as { stderr?: string }).stderr?.trim() ?? String(error)}`, { cause: error });
  }
}
