import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { NodeGitWorkspace } from "../../dist/repository/gitWorkspace.js";
import { sanitizedTestEnv } from "../helpers/sanitizedEnv.mjs";

const env = sanitizedTestEnv({
  GIT_AUTHOR_NAME: "Yui Test", GIT_AUTHOR_EMAIL: "yui-test@example.com",
  GIT_COMMITTER_NAME: "Yui Test", GIT_COMMITTER_EMAIL: "yui-test@example.com",
  GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null"
});
// The implementation's Git children must use the same isolated configuration.
for (const [key, value] of Object.entries(env)) {
  if (key.startsWith("GIT_")) process.env[key] = value;
}
function git(cwd, ...args) {
  return execFileSync("git", args, { cwd, env, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }).trim();
}

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "yui-refresh-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const remote = join(root, "remote.git");
  const seed = join(root, "seed");
  const checkout = join(root, "checkout");
  git(root, "init", "--bare", "--initial-branch=main", remote);
  git(root, "clone", remote, seed);
  writeFileSync(join(seed, "file"), "initial\n");
  git(seed, "add", "file");
  git(seed, "commit", "-m", "initial");
  git(seed, "push", "origin", "main");
  git(root, "clone", remote, checkout);
  const before = git(seed, "rev-parse", "HEAD");
  writeFileSync(join(seed, "file"), "advanced\n");
  git(seed, "commit", "-am", "advance");
  git(seed, "push", "origin", "main");
  const after = git(seed, "rev-parse", "HEAD");
  return { root, remote, seed, checkout, before, after,
    input: { repositoryPath: checkout, remoteUrl: remote, stableRef: "main" } };
}

test("refresh keeps HEAD and the configured tracking ref consistent, including tracking-only repair", async (t) => {
  const f = fixture(t);
  const workspace = new NodeGitWorkspace();
  const refreshed = await workspace.refresh(f.input);
  assert.equal(refreshed.changed, true);
  assert.equal(git(f.checkout, "rev-parse", "HEAD"), f.after);
  assert.equal(git(f.checkout, "rev-parse", "refs/remotes/origin/main"), f.after);
  assert.equal(git(f.checkout, "rev-list", "--count", "@{upstream}..HEAD"), "0");

  // The mapping, not the remote name or a default branch, owns the destination.
  git(f.checkout, "remote", "rename", "origin", "source");
  git(f.checkout, "config", "remote.source.fetch", "+refs/heads/*:refs/remotes/mapped/releases/*");
  git(f.checkout, "update-ref", "refs/remotes/mapped/releases/main", f.before);
  const config = git(f.checkout, "config", "--local", "--list");
  const unchangedRef = git(f.checkout, "rev-parse", "refs/remotes/source/main");
  const repaired = await workspace.refresh(f.input);
  assert.equal(repaired.changed, false);
  assert.equal(repaired.tracking.status, "updated");
  assert.equal(repaired.tracking.ref, "refs/remotes/mapped/releases/main");
  assert.equal(git(f.checkout, "rev-parse", repaired.tracking.ref), f.after);
  assert.equal(git(f.checkout, "config", "--local", "--list"), config);
  assert.equal(git(f.checkout, "rev-parse", "refs/remotes/source/main"), unchangedRef);
  assert.equal((await workspace.inspectRemoteTracking({
    repositoryPath: f.checkout, remoteUrl: f.remote, branch: "main"
  })).ref, repaired.tracking.ref);
  assert.equal((await workspace.refresh(f.input)).tracking.status, "current");
  assert.equal(git(f.checkout, "for-each-ref", "--format=%(refname)", "refs/yui"), "");
});

test("a tracking race after fast-forward reports partial progress without overwriting the competing ref", async (t) => {
  const f = fixture(t);
  git(f.checkout, "fetch", "--no-tags", f.remote, "main");
  const competitor = git(f.checkout, "commit-tree", `${f.after}^{tree}`, "-p", f.after, "-m", "competitor");
  let raced = false;
  class RacingWorkspace extends NodeGitWorkspace {
    async isClean(path) {
      const clean = await super.isClean(path);
      if (!raced && git(path, "rev-parse", "HEAD") === f.after) {
        raced = true;
        git(path, "update-ref", "refs/remotes/origin/main", competitor);
      }
      return clean;
    }
  }
  await assert.rejects(new RacingWorkspace().refresh(f.input), (error) => {
    assert.equal(error.name, "GitWorkspaceRefreshError");
    assert.equal(error.result.fromCommit, f.before);
    assert.equal(error.result.toCommit, f.after);
    assert.equal(error.result.changed, true);
    assert.equal(error.result.tracking.status, "failed");
    assert.equal(error.result.tracking.toCommit, competitor);
    return true;
  });
  assert.equal(git(f.checkout, "rev-parse", "HEAD"), f.after);
  assert.equal(git(f.checkout, "rev-parse", "refs/remotes/origin/main"), competitor);
});
