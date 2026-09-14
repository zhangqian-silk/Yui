import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import {
  acquireProjectMaintenanceLock, isProjectMaintenanceFenced, projectMaintenanceLockPath
} from "../../dist/repository/projectMaintenanceLock.js";
import { acquireArtifactCommitLock, artifactCommitLockPath } from "../../dist/artifacts/artifactCommitLock.js";
import { createReleaseWorkflowPorts } from "../../dist/release/releaseWorkflowPorts.js";
import { currentFileLockOwner } from "../../dist/core/fileLockOwner.js";
import { isForeignHandoverLockHeld } from "../../dist/release/runtimeRelease.js";

test("unverifiable lock owners never authorize reclaim or a protected operation", async t => {
  const home = mkdtempSync(join(tmpdir(), "yui-current-locks-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const project = projectMaintenanceLockPath(home, "project-1");
  const artifact = artifactCommitLockPath(home, "task-1");
  for (const path of [project, artifact]) {
    mkdirSync(path, { recursive: true });
    writeFileSync(join(path, "owner"), `${process.pid}\n`);
    const old = new Date(Date.now() - 10_000);
    utimesSync(path, old, old);
  }
  assert.equal(isProjectMaintenanceFenced(home, "project-1"), true);
  await assert.rejects(acquireProjectMaintenanceLock(home, "project-1", {
    wait: async () => assert.fail("Unknown ownership should diagnose, not wait or steal.")
  }), /unverified.*lock|lock.*identity/i);
  assert.throws(() => acquireArtifactCommitLock(home, "task-1"), /unverified.*lock|lock.*identity/i);
  for (const path of [project, artifact]) {
    assert.equal(readFileSync(join(path, "owner"), "utf8"), `${process.pid}\n`);
  }
  // Missing publication is also not proof that a lock has no live creator.
  rmSync(join(project, "owner"));
  const old = new Date(Date.now() - 10_000);
  utimesSync(project, old, old);
  assert.equal(isProjectMaintenanceFenced(home, "project-1"), true);
  await assert.rejects(acquireProjectMaintenanceLock(home, "project-1"), /unverified.*lock|lock.*identity/i);
  assert.equal(existsSync(project), true);
  const exactOwner = currentFileLockOwner();
  writeFileSync(join(project, "owner"), exactOwner);
  mkdirSync(join(home, "runtime"));
  writeFileSync(join(home, "runtime", "handover.lock"), JSON.stringify({
    pid: process.pid, processStartIdentity: exactOwner.split(":")[1]
  }));
  const read = fs.readFileSync;
  fs.readFileSync = (path, ...args) => {
    if (String(path) === `/proc/${process.pid}/stat`) {
      throw Object.assign(new Error("fixture: process identity unreadable"), { code: "EACCES" });
    }
    return read(path, ...args);
  };
  syncBuiltinESMExports();
  try {
    assert.equal(isProjectMaintenanceFenced(home, "project-1"), true);
    assert.equal(isForeignHandoverLockHeld(home, process.pid), true,
      "Unavailable OS evidence cannot admit even an apparent handover parent.");
  } finally {
    fs.readFileSync = read;
    syncBuiltinESMExports();
  }
});

test("PR lookup uses one exact query and distinguishes absence from unprovable results", async () => {
  const commit = "a".repeat(40);
  const entry = { number: 42, headRefOid: commit };
  async function probe(listOutput, listCode = 0) {
    const calls = [];
    const ports = createReleaseWorkflowPorts({
      home: "/unused-in-memory-home",
      idempotencyStore: { load: async () => undefined, recordSuccess: async () => {} },
      runCommand: async (command, args) => {
        calls.push([command, ...args]);
        if (args[0] === "pr" && args[1] === "list") return { code: listCode, stdout: listOutput, stderr: "" };
        if (args[0] === "api") return { code: 0, stdout: commit, stderr: "" };
        if (args[0] === "pr" && args[1] === "create") {
          return { code: 0, stdout: "https://github.com/fixture/repo/pull/42", stderr: "" };
        }
        if (args[0] === "pr" && args[1] === "view" && args[2] === "42") {
          return { code: 0, stdout: JSON.stringify(entry), stderr: "" };
        }
        return { code: 1, stdout: "", stderr: "unknown flag: --head" };
      }
    });
    const result = await ports.executeStep({
      step: { id: "pr", kind: "pr-create-or-reuse", idempotencyKey: "fixture/pr" },
      idempotencyKey: "fixture/pr",
      source: { repository: { owner: "fixture", name: "repo" }, commit },
      params: { head: "release/test" }
    });
    return { result, calls };
  }
  for (const invalid of ["not-json", "{}", JSON.stringify([{}]), JSON.stringify([entry, { ...entry, number: 43 }])]) {
    const { result, calls } = await probe(invalid);
    assert.equal(result.outcome, "failed");
    assert.deepEqual(calls.map(call => call.slice(0, 3)), [["gh", "pr", "list"]],
      "An invalid or ambiguous lookup must not reach PR creation or try an unsupported command.");
  }
  const unavailable = await probe("[]", 1);
  assert.equal(unavailable.result.outcome, "failed");
  assert.equal(unavailable.calls.length, 1);
  const reused = await probe(JSON.stringify([entry]));
  assert.equal(reused.result.outcome, "succeeded");
  assert.equal(reused.calls.length, 1);
  const created = await probe("[]");
  assert.equal(created.result.outcome, "succeeded");
  assert.deepEqual(created.calls.map(call => call.slice(0, 3)), [
    ["gh", "pr", "list"], ["gh", "api", "repos/fixture/repo/git/ref/heads/release/test"],
    ["gh", "pr", "create"], ["gh", "pr", "view"]
  ]);
});
