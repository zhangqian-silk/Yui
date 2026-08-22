import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { SqliteTaskStore } from "../../dist/storage/sqliteStore.js";
import { createProject } from "../../dist/repository/project.js";
import { activateTask, createTask } from "../../dist/task/task.js";
import {
  assertTaskBaseFreshnessForCompletion,
  captureTaskBaseProvenance,
  inspectTaskBaseFreshness,
  recordTaskBaseProvenanceEvents
} from "../../dist/repository/taskBaseFreshness.js";
import { runTaskBaseStatusCommand } from "../../dist/commands/taskBaseCommands.js";

// A deterministic in-memory Git port: a commit graph plus stale local
// tracking refs and the (optionally newer) remote heads a refresh would fetch.
function createFakeGit(input) {
  const { commits, refs, tracking = new Map(), remoteHeads = new Map(), clean = true } = input;
  const parentsOf = (sha) => commits.get(sha)?.parents ?? [];
  const isAncestor = (ancestor, descendant) => {
    if (ancestor === descendant) return true;
    const seen = new Set();
    const queue = [descendant];
    while (queue.length > 0) {
      const current = queue.pop();
      if (current === ancestor) return true;
      if (seen.has(current)) continue;
      seen.add(current);
      queue.push(...parentsOf(current));
    }
    return false;
  };
  const mergeBase = (left, right) => {
    const leftAncestors = new Set();
    const queue = [left];
    while (queue.length > 0) {
      const current = queue.pop();
      if (leftAncestors.has(current)) continue;
      leftAncestors.add(current);
      queue.push(...parentsOf(current));
    }
    const otherQueue = [right];
    const otherSeen = new Set();
    while (otherQueue.length > 0) {
      const current = otherQueue.pop();
      if (leftAncestors.has(current)) return current;
      if (otherSeen.has(current)) continue;
      otherSeen.add(current);
      otherQueue.push(...parentsOf(current));
    }
    throw new Error("no common ancestor");
  };
  return {
    async inspect(_repositoryPath, baseRef) {
      const commit = refs.get(baseRef) ?? baseRef;
      return { root: "/repo", gitDirectory: "/repo/.git", baseRef, baseCommit: commit };
    },
    async inspectRemoteTracking({ remoteUrl }) {
      const tracked = tracking.get(remoteUrl);
      return tracked === undefined ? null : { remoteName: "origin", remoteUrl, ...tracked };
    },
    async fetchRemoteHeadIntoWorktree({ remoteUrl }) {
      const head = remoteHeads.get(remoteUrl);
      if (head === undefined) throw new Error(`fetch failed for ${remoteUrl}`);
      return { branch: "master", commit: head };
    },
    async isAncestor(_repositoryPath, ancestor, descendant) {
      return isAncestor(ancestor, descendant);
    },
    async mergeBase({ leftCommit, rightCommit }) {
      return mergeBase(leftCommit, rightCommit);
    },
    async changedFilesBetween({ fromCommit, toCommit }) {
      const from = new Set(commits.get(fromCommit)?.files ?? []);
      const to = new Set(commits.get(toCommit)?.files ?? []);
      return [...to].filter((file) => !from.has(file));
    },
    async isClean() {
      return clean;
    }
  };
}

function seedStore(home, now, projects, bindings) {
  const store = new SqliteTaskStore(home);
  for (const project of projects) store.saveProject(project);
  const task = activateTask(createTask(store.nextTaskId(), "Base freshness", now, {
    projectBindings: bindings
  }), now);
  store.saveTask(task);
  return { store, task };
}

const NOW = new Date("2026-08-22T00:00:00.000Z");
const REMOTE_URL = "https://example.invalid/org/repo.git";
const DOWN_URL = "https://down.invalid/org/repo.git";
const CREDENTIAL_URL = "https://user:secrettoken@example.invalid/org/repo.git";

// Task-27 graph: R is the common root, A is the Task base, B is a sibling
// squash-merge head carrying an unrelated file, C is a normal remote
// descendant of A, and D is a local descendant of C.
const GRAPH = new Map([
  ["R", { parents: [], files: ["app/file-a.txt"] }],
  ["A", { parents: ["R"], files: ["app/file-a.txt"] }],
  ["B", { parents: ["R"], files: ["app/file-a.txt", "unrelated.txt"] }],
  ["C", { parents: ["A"], files: ["app/file-a.txt", "remote-c.txt"] }],
  ["D", { parents: ["C"], files: ["app/file-a.txt", "remote-c.txt", "local-d.txt"] }]
]);

test("a diverged remote base is classified and blocks delivery (Task-27 path)", async (t) => {
  const home = mkdtempSync(join(tmpdir(), "yui-base-freshness-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const project = createProject("project-1", "demo", "/repo", { stable: "master", development: "master" }, NOW, { remoteUrl: REMOTE_URL });
  const { store, task } = seedStore(home, NOW, [project], [{ projectId: "project-1", directory: "app", baseRef: "master" }]);
  const git = createFakeGit({
    commits: GRAPH,
    refs: new Map([["master", "A"]]),
    tracking: new Map([[REMOTE_URL, { ref: "refs/remotes/origin/master", commit: "A" }]]),
    remoteHeads: new Map([[REMOTE_URL, "B"]])
  });

  const stale = await inspectTaskBaseFreshness(task.id, store, { git });
  assert.equal(stale.entries[0].status, "up-to-date");
  assert.equal(stale.entries[0].source, "local-tracking");

  const refreshed = await inspectTaskBaseFreshness(task.id, store, { git, refresh: true });
  const entry = refreshed.entries[0];
  assert.equal(entry.status, "diverged");
  assert.equal(entry.source, "remote-refresh");
  assert.equal(entry.trackedCommit, "B");
  assert.ok(entry.remoteOnlyChangedFiles.includes("unrelated.txt"));
  assert.match(entry.risk ?? "", /diverged/u);

  await assert.rejects(
    runTaskBaseStatusCommand([task.id, "--refresh"], store, { git }),
    /diverged/u
  );
  assert.throws(() => assertTaskBaseFreshnessForCompletion(refreshed), /diverged/u);
  store.close();
});

test("up-to-date, behind, and ahead bases are distinguished", async (t) => {
  const home = mkdtempSync(join(tmpdir(), "yui-base-freshness-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const project = createProject("project-1", "demo", "/repo", { stable: "master", development: "master" }, NOW, { remoteUrl: REMOTE_URL });
  const { store, task } = seedStore(home, NOW, [project], [{ projectId: "project-1", directory: "app", baseRef: "master" }]);

  const upToDate = createFakeGit({
    commits: GRAPH,
    refs: new Map([["master", "A"]]),
    tracking: new Map([[REMOTE_URL, { ref: "refs/remotes/origin/master", commit: "A" }]])
  });
  assert.equal((await inspectTaskBaseFreshness(task.id, store, { git: upToDate })).entries[0].status, "up-to-date");

  const behind = createFakeGit({
    commits: GRAPH,
    refs: new Map([["master", "A"]]),
    tracking: new Map([[REMOTE_URL, { ref: "refs/remotes/origin/master", commit: "A" }]]),
    remoteHeads: new Map([[REMOTE_URL, "C"]])
  });
  const behindReport = await inspectTaskBaseFreshness(task.id, store, { git: behind, refresh: true });
  assert.equal(behindReport.entries[0].status, "behind");
  assert.ok(behindReport.entries[0].remoteOnlyChangedFiles.includes("remote-c.txt"));

  const ahead = createFakeGit({
    commits: GRAPH,
    refs: new Map([["master", "D"]]),
    tracking: new Map([[REMOTE_URL, { ref: "refs/remotes/origin/master", commit: "C" }]]),
    remoteHeads: new Map([[REMOTE_URL, "C"]])
  });
  assert.equal((await inspectTaskBaseFreshness(task.id, store, { git: ahead, refresh: true })).entries[0].status, "ahead");
  store.close();
});

test("offline and unreachable remotes stay explicit instead of looking clean", async (t) => {
  const home = mkdtempSync(join(tmpdir(), "yui-base-freshness-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const offline = createProject("project-1", "offline", "/repo", { stable: "master", development: "master" }, NOW);
  const unreachable = createProject("project-2", "unreachable", "/repo", { stable: "master", development: "master" }, NOW, { remoteUrl: DOWN_URL });
  const { store, task } = seedStore(home, NOW, [offline, unreachable], [
    { projectId: "project-1", directory: "offline-app", baseRef: "master" },
    { projectId: "project-2", directory: "remote-app", baseRef: "master" }
  ]);
  const git = createFakeGit({
    commits: GRAPH,
    refs: new Map([["master", "A"]]),
    tracking: new Map(),
    remoteHeads: new Map([[REMOTE_URL, "B"]])
  });

  const report = await inspectTaskBaseFreshness(task.id, store, { git, refresh: true });
  const offlineEntry = report.entries.find((entry) => entry.projectId === "project-1");
  const unknownEntry = report.entries.find((entry) => entry.projectId === "project-2");
  assert.equal(offlineEntry.status, "not-applicable");
  assert.equal(unknownEntry.status, "unknown");
  assert.equal(unknownEntry.source, "remote-refresh");
  assert.match(unknownEntry.error ?? "", /fetch failed/u);

  // A refreshed unknown is a hard block; an unrefreshed one only warns.
  assert.throws(() => assertTaskBaseFreshnessForCompletion(report), /could not be refreshed/u);
  const staleUnknown = await inspectTaskBaseFreshness(task.id, store, { git });
  const warnings = assertTaskBaseFreshnessForCompletion(staleUnknown);
  assert.ok(warnings.some((warning) => warning.includes("unknown")));
  store.close();
});

test("creation-time provenance is recorded and projected back", async (t) => {
  const home = mkdtempSync(join(tmpdir(), "yui-base-freshness-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const project = createProject("project-1", "demo", "/repo", { stable: "master", development: "master" }, NOW, { remoteUrl: REMOTE_URL });
  const { store, task } = seedStore(home, NOW, [project], [{ projectId: "project-1", directory: "app", baseRef: "master" }]);
  const git = createFakeGit({
    commits: GRAPH,
    refs: new Map([["master", "A"]]),
    tracking: new Map([[REMOTE_URL, { ref: "refs/remotes/origin/master", commit: "A" }]])
  });

  const provenance = await captureTaskBaseProvenance({
    git,
    project,
    binding: task.projectBindings[0],
    baseRef: "master",
    baseCommit: "A"
  });
  assert.equal(provenance.source, "local-tracking");
  assert.equal(provenance.trackingCommit, "A");
  assert.equal(provenance.remoteConfigured, true);
  store.transaction((tx) => recordTaskBaseProvenanceEvents(tx, task.id, [provenance], NOW));

  const report = await inspectTaskBaseFreshness(task.id, store, { git });
  const entry = report.entries[0];
  assert.equal(entry.observedSource, "local-tracking");
  assert.equal(entry.observedTrackingCommit, "A");
  assert.equal(entry.observedAt, NOW.toISOString());

  // Tasks created before provenance existed get a compatibility projection.
  const legacyTask = activateTask(createTask(store.nextTaskId(), "Legacy", NOW, {
    projectBindings: [{ projectId: "project-1", directory: "app", baseRef: "master" }]
  }), NOW);
  store.saveTask(legacyTask);
  const legacyGit = createFakeGit({
    commits: GRAPH,
    refs: new Map([["master", "A"]]),
    tracking: new Map()
  });
  const legacy = await inspectTaskBaseFreshness(legacyTask.id, store, { git: legacyGit });
  assert.equal(legacy.entries[0].source, "compatibility-projection");
  assert.equal(legacy.entries[0].status, "unknown");
  assert.equal(legacy.entries[0].observedAt, undefined);
  store.close();
});

test("remote credentials are redacted in provenance and errors", async (t) => {
  const home = mkdtempSync(join(tmpdir(), "yui-base-freshness-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const project = createProject("project-1", "private", "/repo", { stable: "master", development: "master" }, NOW, { remoteUrl: CREDENTIAL_URL });
  const { store, task } = seedStore(home, NOW, [project], [{ projectId: "project-1", directory: "app", baseRef: "master" }]);
  const git = createFakeGit({
    commits: GRAPH,
    refs: new Map([["master", "A"]]),
    tracking: new Map([[CREDENTIAL_URL, { ref: "refs/remotes/origin/master", commit: "A" }]])
  });

  const provenance = await captureTaskBaseProvenance({
    git,
    project,
    binding: task.projectBindings[0],
    baseRef: "master",
    baseCommit: "A"
  });
  assert.doesNotMatch(provenance.remoteUrl ?? "", /secrettoken/u);
  assert.match(provenance.remoteUrl ?? "", /redacted/u);

  const report = await inspectTaskBaseFreshness(task.id, store, { git, refresh: true });
  assert.doesNotMatch(JSON.stringify(report), /secrettoken/u);
  store.close();
});
