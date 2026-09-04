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
const GITLAB_REPOSITORY =
  /^[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)+$/u;
const MAX_FAILURE_DETAIL_CHARS = 4_000;
const MERGE_REQUEST_IID = /^[1-9][0-9]*$/u;

export type GitLabCliPublicationVerifierOptions = Readonly<{
  runCommand?: CommandRunner;
  environmentPath?: string;
}>;

export function createGitLabCliPublicationVerifier(
  options: GitLabCliPublicationVerifierOptions = {}
): PublicationVerifier {
  const run = options.runCommand ?? createPinnedCommandRunner(
    createExecFileCommandRunner(),
    ["glab"],
    options.environmentPath
  );
  return {
    inspect: (input) => inspectGitLabMergeRequest(run, input)
  };
}

async function inspectGitLabMergeRequest(
  run: CommandRunner,
  input: PublicationVerificationInput
): Promise<PublicationVerificationObservation> {
  if (input.provider !== "gitlab" || input.externalKind !== "merge-request") {
    throw new Error(
      `GitLab verifier cannot inspect ${input.provider}/${input.externalKind}.`
    );
  }
  if (!GITLAB_REPOSITORY.test(input.repository)) {
    throw new Error(
      `GitLab repository must use namespace/project: ${input.repository}.`
    );
  }
  if (!MERGE_REQUEST_IID.test(input.externalId)) {
    throw new Error(
      `GitLab merge request id must be numeric: ${input.externalId}.`
    );
  }
  const hostname = gitLabHostname(input.externalUrl);
  const endpoint = `projects/${encodeURIComponent(input.repository)}`
    + `/merge_requests/${input.externalId}`;
  const result = await run("glab", [
    "api",
    endpoint,
    ...(hostname === undefined ? [] : ["--hostname", hostname])
  ]);
  if (result.code !== 0) {
    if (result.code === 127) {
      throw new Error(
        "GitLab verification requires a trusted glab executable on PATH."
      );
    }
    const detail = boundedFailureDetail(
      redactLaunchText(result.stderr || result.stdout).trim()
    );
    throw new Error(
      `glab api failed for ${input.repository}!${input.externalId} `
      + `(exit ${result.code})${detail.length === 0 ? "" : `: ${detail}`}`
    );
  }
  return parseGitLabMergeRequest(
    result.stdout,
    input.repository,
    input.externalId,
    hostname ?? "gitlab.com"
  );
}

export function parseGitLabMergeRequest(
  stdout: string,
  repository: string,
  externalId: string,
  expectedHost?: string
): PublicationVerificationObservation {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout.trim());
  } catch {
    throw new Error("glab api returned invalid JSON.");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("glab api returned an invalid merge request object.");
  }
  const record = parsed as Record<string, unknown>;
  const iid = typeof record.iid === "number"
    ? String(record.iid)
    : typeof record.iid === "string" ? record.iid : undefined;
  if (iid !== externalId) {
    throw new Error(
      `glab api returned merge request ${iid ?? "unknown"}, expected ${externalId}.`
    );
  }
  const state = gitLabState(record.state);
  const headCommit = gitCommit(record.sha, "GitLab MR head commit");
  const remoteCommit = firstCommit(
    record.merge_commit_sha,
    record.squash_commit_sha
  );
  if (state === "merged" && remoteCommit === undefined) {
    throw new Error("Merged GitLab MR did not expose an integrated commit.");
  }
  const externalUrl = optionalText(record.web_url);
  assertGitLabReference(record.references, repository, externalId);
  if (externalUrl !== undefined && expectedHost !== undefined) {
    assertGitLabWebUrl(externalUrl, expectedHost, repository, externalId);
  }
  const mergedAt = optionalText(record.merged_at);
  return {
    provider: "gitlab",
    repository,
    externalKind: "merge-request",
    externalId,
    ...(externalUrl === undefined ? {} : { externalUrl }),
    state,
    headCommit,
    ...(remoteCommit === undefined ? {} : { remoteCommit }),
    ...(mergedAt === undefined ? {} : { mergedAt }),
    evidence: `glab api ${repository}!${externalId}: state=${state}; `
      + `head=${headCommit}; remote=${remoteCommit ?? "none"}`
  };
}

function gitLabState(value: unknown): "open" | "merged" | "closed" {
  if (typeof value !== "string") throw new Error("GitLab MR state is unavailable.");
  switch (value.toLowerCase()) {
    case "opened": return "open";
    case "merged": return "merged";
    case "closed": return "closed";
    default: throw new Error(`GitLab MR state is unsupported: ${value}.`);
  }
}

function assertGitLabReference(
  value: unknown,
  repository: string,
  externalId: string
): void {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("GitLab MR repository reference is unavailable.");
  }
  const full = optionalText((value as Record<string, unknown>).full);
  if (full !== `${repository}!${externalId}`) {
    throw new Error(
      `GitLab MR repository reference ${full ?? "unknown"} does not match `
      + `${repository}!${externalId}.`
    );
  }
}

function assertGitLabWebUrl(
  value: string,
  expectedHost: string,
  repository: string,
  externalId: string
): void {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("GitLab MR web URL is invalid.");
  }
  const expectedSuffix = `/${repository}/-/merge_requests/${externalId}`;
  if ((url.protocol !== "https:" && url.protocol !== "http:")
    || url.host.toLowerCase() !== expectedHost.toLowerCase()
    || !url.pathname.endsWith(expectedSuffix)) {
    throw new Error(
      `GitLab MR web URL does not match ${expectedHost}/${repository}!${externalId}.`
    );
  }
}

function firstCommit(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (value === null || value === undefined || value === "") continue;
    return gitCommit(value, "GitLab integrated commit");
  }
  return undefined;
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

function gitLabHostname(externalUrl: string | undefined): string | undefined {
  if (externalUrl === undefined) return undefined;
  let url: URL;
  try {
    url = new URL(externalUrl);
  } catch {
    throw new Error(`GitLab external URL is invalid: ${externalUrl}.`);
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error(`GitLab external URL protocol is invalid: ${url.protocol}.`);
  }
  return url.hostname === "gitlab.com" ? undefined : url.host;
}

function boundedFailureDetail(value: string): string {
  return value.length <= MAX_FAILURE_DETAIL_CHARS
    ? value
    : `${value.slice(0, MAX_FAILURE_DETAIL_CHARS)}…`;
}
