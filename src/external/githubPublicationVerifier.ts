import {
  createExecFileCommandRunner,
  createPinnedCommandRunner,
  type CommandRunner
} from "./pinnedCommandRunner.js";
import { redactLaunchText } from "../runtime/launchDiagnostics.js";
import type {
  PublicationVerificationInput,
  PublicationVerificationObservation,
  PublicationVerifier
} from "../task/publicationVerification.js";

const GIT_COMMIT = /^[0-9a-f]{40}$/iu;
const GITHUB_REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u;
const MAX_FAILURE_DETAIL_CHARS = 4_000;
const PULL_REQUEST_NUMBER = /^[1-9][0-9]*$/u;

export type GitHubCliPublicationVerifierOptions = Readonly<{
  runCommand?: CommandRunner;
  environmentPath?: string;
}>;

export function createGitHubCliPublicationVerifier(
  options: GitHubCliPublicationVerifierOptions = {}
): PublicationVerifier {
  const run = options.runCommand ?? createPinnedCommandRunner(
    createExecFileCommandRunner(),
    ["gh"],
    options.environmentPath
  );
  return {
    inspect: (input) => inspectGitHubPullRequest(run, input)
  };
}

async function inspectGitHubPullRequest(
  run: CommandRunner,
  input: PublicationVerificationInput
): Promise<PublicationVerificationObservation> {
  if (input.provider !== "github" || input.externalKind !== "pull-request") {
    throw new Error(
      `GitHub verifier cannot inspect ${input.provider}/${input.externalKind}.`
    );
  }
  if (!GITHUB_REPOSITORY.test(input.repository)) {
    throw new Error(`GitHub repository must use owner/name: ${input.repository}.`);
  }
  if (!PULL_REQUEST_NUMBER.test(input.externalId)) {
    throw new Error(`GitHub pull request id must be numeric: ${input.externalId}.`);
  }
  const result = await run("gh", [
    "pr", "view", input.externalId,
    "--repo", input.repository,
    "--json", "number,state,headRefOid,mergeCommit,mergedAt,url"
  ]);
  if (result.code !== 0) {
    if (result.code === 127) {
      throw new Error(
        "GitHub verification requires a trusted gh executable on PATH."
      );
    }
    const detail = boundedFailureDetail(
      redactLaunchText(result.stderr || result.stdout).trim()
    );
    throw new Error(
      `gh pr view failed for ${input.repository}#${input.externalId} `
      + `(exit ${result.code})${detail.length === 0 ? "" : `: ${detail}`}`
    );
  }
  return parseGitHubPullRequest(
    result.stdout,
    input.repository,
    input.externalId
  );
}

export function parseGitHubPullRequest(
  stdout: string,
  repository: string,
  externalId: string
): PublicationVerificationObservation {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout.trim());
  } catch {
    throw new Error("gh pr view returned invalid JSON.");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("gh pr view returned an invalid pull request object.");
  }
  const record = parsed as Record<string, unknown>;
  const number = typeof record.number === "number"
    ? String(record.number)
    : typeof record.number === "string" ? record.number : undefined;
  if (number !== externalId) {
    throw new Error(
      `gh pr view returned pull request ${number ?? "unknown"}, expected ${externalId}.`
    );
  }
  const state = githubState(record.state);
  const headCommit = gitCommit(record.headRefOid, "GitHub PR head commit");
  const remoteCommit = mergeCommit(record.mergeCommit);
  if (state === "merged" && remoteCommit === undefined) {
    throw new Error("Merged GitHub PR did not expose a merge commit.");
  }
  const externalUrl = optionalText(record.url);
  const mergedAt = optionalText(record.mergedAt);
  return {
    provider: "github",
    repository,
    externalKind: "pull-request",
    externalId,
    ...(externalUrl === undefined ? {} : { externalUrl }),
    state,
    headCommit,
    ...(remoteCommit === undefined ? {} : { remoteCommit }),
    ...(mergedAt === undefined ? {} : { mergedAt }),
    evidence: `gh pr view ${repository}#${externalId}: state=${state}; `
      + `head=${headCommit}; remote=${remoteCommit ?? "none"}`
  };
}

function githubState(value: unknown): "open" | "merged" | "closed" {
  if (typeof value !== "string") {
    throw new Error("GitHub PR state is unavailable.");
  }
  switch (value.toUpperCase()) {
    case "OPEN": return "open";
    case "MERGED": return "merged";
    case "CLOSED": return "closed";
    default: throw new Error(`GitHub PR state is unsupported: ${value}.`);
  }
}

function mergeCommit(value: unknown): string | undefined {
  if (value === null || value === undefined) return undefined;
  if (typeof value === "string") return gitCommit(value, "GitHub merge commit");
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new Error("GitHub merge commit is invalid.");
  }
  return gitCommit(
    (value as Record<string, unknown>).oid,
    "GitHub merge commit"
  );
}

function gitCommit(value: unknown, label: string): string {
  if (typeof value !== "string" || !GIT_COMMIT.test(value)) {
    throw new Error(`${label} must be a full 40-character Git SHA.`);
  }
  return value.toLowerCase();
}

function optionalText(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : undefined;
}

function boundedFailureDetail(value: string): string {
  return value.length <= MAX_FAILURE_DETAIL_CHARS
    ? value
    : `${value.slice(0, MAX_FAILURE_DETAIL_CHARS)}…`;
}
