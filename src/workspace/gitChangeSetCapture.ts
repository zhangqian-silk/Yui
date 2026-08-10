import { execFile } from "node:child_process";
import { promisify } from "node:util";

const executeFile = promisify(execFile);

export type ManagedGitChange = Readonly<{
  headCommit: string;
  changedPaths: readonly string[];
}>;

export async function captureManagedGitChanges(input: Readonly<{
  path: string;
  branch: string;
  baseCommit: string;
  commitMessage: string;
  identity: string;
  requireClean?: boolean;
  expectedHead?: string;
}>): Promise<ManagedGitChange | null> {
  await assertManagedHead(input);
  const status = await git([
    "-C", input.path, "status", "--porcelain=v1", "--untracked-files=all"
  ]);
  if (status.trim().length > 0) {
    if (input.requireClean === true) {
      throw new Error(`Managed workspace must be clean before capture: ${input.identity}.`);
    }
    await git(["-C", input.path, "add", "--all"]);
    await git([
      "-C", input.path,
      "-c", "user.name=Yui",
      "-c", "user.email=yui@local",
      "commit", "-m", input.commitMessage
    ]);
  }
  const headCommit = await assertManagedHead(input);
  if (headCommit === input.baseCommit) return null;
  const changedPaths = (await git([
    "-C", input.path,
    "diff", "--name-only", "-z",
    input.baseCommit,
    headCommit
  ])).split("\0").filter(Boolean);
  return { headCommit, changedPaths };
}

async function assertManagedHead(input: Readonly<{
  path: string;
  branch: string;
  baseCommit: string;
  identity: string;
  expectedHead?: string;
}>): Promise<string> {
  const currentBranch = (await git([
    "-C", input.path, "symbolic-ref", "--quiet", "--short", "HEAD"
  ])).trim();
  if (currentBranch !== input.branch) {
    throw new Error(
      `Managed workspace left its managed branch: expected ${
        input.branch
      }, found ${currentBranch} (${input.identity}).`
    );
  }
  const headCommit = await gitLine(["-C", input.path, "rev-parse", "HEAD^{commit}"]);
  if (input.expectedHead !== undefined && headCommit !== input.expectedHead) {
    throw new Error(
      `Managed workspace HEAD no longer matches its Candidate snapshot: ${input.identity}.`
    );
  }
  if (!await gitSucceeds([
    "-C", input.path,
    "merge-base", "--is-ancestor",
    input.baseCommit,
    headCommit
  ])) {
    throw new Error(
      `Managed workspace HEAD does not descend from its recorded base: ${input.identity}.`
    );
  }
  return headCommit;
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

async function gitSucceeds(args: readonly string[]): Promise<boolean> {
  try {
    await git(args);
    return true;
  } catch {
    return false;
  }
}
