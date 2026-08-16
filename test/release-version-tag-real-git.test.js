// Real local-Git regressions for the version-tag port (review-round-15 P1-2/P1-3).
//
// These tests drive the real adapter against real disposable Git repositories:
// a bare local stand-in for origin, a working clone, and the actual git binary
// for every command. The only test seam is a URL redirect applied to transport
// commands (push/ls-remote/fetch) so the github.com-shaped remote URL never
// touches the network; `git remote get-url` answers with the configured URL
// untouched, exactly as it would against the real host.

import test from "node:test";
import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { createReleaseWorkflowPorts } from "../dist/release/releaseWorkflowPorts.js";
import { createInMemoryReleaseIdempotencyStore } from "../dist/release/releaseIdempotencyStore.js";

const exec = promisify(execFile);
const REMOTE_URL = "https://github.com/acme/widget.git";

async function realRun(command, args, cwd) {
  try {
    const { stdout, stderr } = await exec(command, args, { cwd, maxBuffer: 16 * 1024 * 1024 });
    return { code: 0, stdout, stderr };
  } catch (error) {
    const failure = error;
    return {
      code: typeof failure.code === "number" ? failure.code : 1,
      stdout: failure.stdout ?? "",
      stderr: failure.stderr ?? failure.message ?? String(error)
    };
  }
}

function gitFixture(t, { pushUrls = [REMOTE_URL] } = {}) {
  const root = mkdtempSync(join(tmpdir(), "yui-version-tag-real-git-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const origin = join(root, "origin.git");
  const work = join(root, "work");
  execFileSync("git", ["init", "-q", "--bare", "--initial-branch=main", origin]);
  execFileSync("git", ["clone", "-q", origin, work]);
  execFileSync("git", ["-C", work, "config", "user.email", "release-test@example.com"]);
  execFileSync("git", ["-C", work, "config", "user.name", "Release Test"]);
  writeFileSync(join(work, "README.md"), "fixture\n");
  execFileSync("git", ["-C", work, "add", "."]);
  execFileSync("git", ["-C", work, "commit", "-qm", "initial"]);
  // Point origin at the github.com-shaped URL. Transport commands are
  // redirected to the local bare repo by the runner below.
  execFileSync("git", ["-C", work, "remote", "set-url", "origin", REMOTE_URL]);
  for (const url of pushUrls) {
    execFileSync("git", ["-C", work, "remote", "set-url", "--add", "--push", "origin", url]);
  }
  const commit = execFileSync("git", ["-C", work, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();

  // Redirect only transport verbs so `git remote get-url` still reports the
  // configured github.com URL while push/ls-remote/fetch stay on disk.
  const runCommand = async (command, args, cwd) => {
    const effective = [...args];
    if (command === "git" && ["push", "ls-remote", "fetch"].includes(effective[0])) {
      effective.unshift("-c", `url.${origin}.insteadOf=${REMOTE_URL}`);
    }
    return realRun(command, effective, cwd);
  };

  const ports = createReleaseWorkflowPorts({
    home: "/tmp/release-version-tag-real-git-home",
    updatePorts: {},
    projectStore: {},
    idempotencyStore: createInMemoryReleaseIdempotencyStore(),
    runCommand
  });
  return { root, origin, work, commit, ports };
}

function tagStep(ports, commit, work, tag) {
  return ports.executeStep({
    step: {
      id: "tag",
      kind: "version-tag",
      idempotencyKey: "task-1/release-workflow-1/tag",
      params: { tag },
      irreversibility: "irreversible"
    },
    idempotencyKey: "task-1/release-workflow-1/tag",
    source: { repository: { owner: "acme", name: "widget" }, commit },
    params: { tag, repositoryPath: work }
  });
}

function remoteTags(origin) {
  return execFileSync("git", ["--git-dir", origin, "tag", "-l"], { encoding: "utf8" })
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

test("P1-2: version-tag creates and pushes a new annotated tag at the frozen commit", async (t) => {
  const { origin, work, commit, ports } = gitFixture(t);

  const effect = await tagStep(ports, commit, work, "v1.2.3");

  assert.equal(effect.outcome, "succeeded", JSON.stringify(effect));
  assert.equal(effect.externalId, "tag:v1.2.3");
  assert.deepEqual(remoteTags(origin), ["v1.2.3"]);
  // The remote tag must name the frozen commit, peeled to the commit itself.
  const peeled = execFileSync(
    "git", ["--git-dir", origin, "rev-parse", "v1.2.3^{}"], { encoding: "utf8" }
  ).trim();
  assert.equal(peeled, commit);
});

test("P1-2: version-tag reuses an existing local tag that already names the frozen commit", async (t) => {
  const { origin, work, commit, ports } = gitFixture(t);
  // A previous attempt created the local tag before the push failed.
  execFileSync("git", ["-C", work, "tag", "-a", "-m", "Release v1.2.3", "v1.2.3", commit]);

  const effect = await tagStep(ports, commit, work, "v1.2.3");

  assert.equal(effect.outcome, "succeeded", JSON.stringify(effect));
  assert.deepEqual(remoteTags(origin), ["v1.2.3"]);
});

test("P1-2: version-tag rejects an option-looking tag without any git mutation", async (t) => {
  const { origin, work, commit, ports } = gitFixture(t);

  const effect = await tagStep(ports, commit, work, "-evil");

  assert.equal(effect.outcome, "failed");
  assert.match(effect.error ?? "", /must not start with '-'/);
  assert.deepEqual(remoteTags(origin), [], "no tag is pushed for an option-looking name");
  assert.equal(
    execFileSync("git", ["-C", work, "tag", "-l"], { encoding: "utf8" }).trim(),
    "",
    "no local tag is created for an option-looking name"
  );
});

test("P1-3: a foreign push URL blocks the tag before any local effect or push", async (t) => {
  // Two push URLs: one matching the granted repository, one foreign. git push
  // would write to both, so the step must refuse before creating anything.
  const { origin, work, commit, ports } = gitFixture(t, {
    pushUrls: [REMOTE_URL, "git@github.com:attacker/evil.git"]
  });

  const effect = await tagStep(ports, commit, work, "v1.2.3");

  assert.equal(effect.outcome, "failed");
  assert.match(effect.error ?? "", /push URL|not the granted repository/);
  assert.deepEqual(remoteTags(origin), [], "the matching remote receives no tag");
  assert.equal(
    execFileSync("git", ["-C", work, "tag", "-l"], { encoding: "utf8" }).trim(),
    "",
    "no local tag is created while a foreign push URL is configured"
  );
});
