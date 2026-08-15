import assert from "node:assert/strict";
import test from "node:test";

import {
  diagnoseOverlap,
  overlapSubjectFromChangeSet
} from "../../dist/integration/overlapDiagnostics.js";
import { runTaskOverlapCommand } from "../../dist/commands/taskOverlapCommands.js";
import { createChangeSetManifest } from "../../dist/integration/changeSetManifest.js";
import { createWorkItemChangeSet } from "../../dist/integration/changeSet.js";

const BASE = "a".repeat(40);
const HEAD = "b".repeat(40);
const now = new Date("2026-08-13T00:00:00.000Z");

function subject(overrides) {
  return {
    taskId: `task-${overrides.changeSetId}`,
    workItemId: "work-item-1",
    projectId: "project-1",
    baseCommit: BASE,
    headCommit: HEAD,
    changedPaths: [],
    manifestTags: [],
    deletedPaths: [],
    ...overrides
  };
}

/** Qualified `taskId/changeSetId` reference matching the `subject` helper. */
function q(changeSetId) {
  return `task-${changeSetId}/${changeSetId}`;
}

test("subjects of different Projects never overlap", () => {
  const report = diagnoseOverlap([
    subject({ changeSetId: "change-set-1", projectId: "project-1", changedPaths: ["src/index.ts"] }),
    subject({ changeSetId: "change-set-2", projectId: "project-2", changedPaths: ["src/index.ts"] })
  ]);
  assert.equal(report.findings.length, 0);
});

test("no shared paths yields no findings", () => {
  const report = diagnoseOverlap([
    subject({ changeSetId: "change-set-1", changedPaths: ["src/a.ts"] }),
    subject({ changeSetId: "change-set-2", changedPaths: ["src/b.ts"] })
  ]);
  assert.equal(report.findings.length, 0);
  assert.deepEqual(report.reviewAreas, []);
});

test("shared paths without shared tags are path-only (low)", () => {
  const report = diagnoseOverlap([
    subject({ changeSetId: "change-set-1", changedPaths: ["src/runtime/engine.ts"] }),
    subject({ changeSetId: "change-set-2", changedPaths: ["src/runtime/engine.ts"] })
  ]);
  assert.equal(report.findings.length, 1);
  assert.equal(report.findings[0].kind, "path-only");
  assert.equal(report.findings[0].risk, "low");
  assert.deepEqual(report.findings[0].paths, ["src/runtime/engine.ts"]);
});

test("same public contract yields a high contract finding", () => {
  const report = diagnoseOverlap([
    subject({
      changeSetId: "change-set-1",
      changedPaths: ["src/index.ts"],
      manifestTags: ["contract"]
    }),
    subject({
      changeSetId: "change-set-2",
      changedPaths: ["src/index.ts"],
      manifestTags: ["contract"]
    })
  ]);
  const contract = report.findings.find((finding) => finding.kind === "contract");
  assert.ok(contract);
  assert.equal(contract.risk, "high");
  assert.deepEqual(contract.changeSetIds, [q("change-set-1"), q("change-set-2")]);
});

test("same migration files yield a high schema-migration finding", () => {
  const report = diagnoseOverlap([
    subject({
      changeSetId: "change-set-1",
      changedPaths: ["src/storage/migration/engine.ts"],
      manifestTags: ["migration"]
    }),
    subject({
      changeSetId: "change-set-2",
      changedPaths: ["src/storage/migration/engine.ts"],
      manifestTags: ["migration"]
    })
  ]);
  const finding = report.findings.find((item) => item.kind === "schema-migration");
  assert.ok(finding);
  assert.equal(finding.risk, "high");
});

test("schema-only overlap is medium; migration overlap is high", () => {
  const schemaOnly = diagnoseOverlap([
    subject({
      changeSetId: "change-set-1",
      changedPaths: ["src/storage/storageSchema.ts"],
      manifestTags: ["schema"]
    }),
    subject({
      changeSetId: "change-set-2",
      changedPaths: ["src/storage/storageSchema.ts"],
      manifestTags: ["schema"]
    })
  ]);
  assert.equal(schemaOnly.findings[0].kind, "schema-migration");
  assert.equal(schemaOnly.findings[0].risk, "medium");
});

test("same CLI surface or snapshots yield a medium cli-surface finding", () => {
  const report = diagnoseOverlap([
    subject({
      changeSetId: "change-set-1",
      changedPaths: ["src/commands/taskCommands.ts"],
      manifestTags: ["command"]
    }),
    subject({
      changeSetId: "change-set-2",
      changedPaths: ["src/commands/taskCommands.ts"],
      manifestTags: ["command"]
    })
  ]);
  const finding = report.findings.find((item) => item.kind === "cli-surface");
  assert.ok(finding);
  assert.equal(finding.risk, "medium");

  const snapshot = diagnoseOverlap([
    subject({
      changeSetId: "change-set-3",
      changedPaths: ["test/__snapshots__/cli.test.js.snap"],
      manifestTags: ["snapshot"]
    }),
    subject({
      changeSetId: "change-set-4",
      changedPaths: ["test/__snapshots__/cli.test.js.snap"],
      manifestTags: ["snapshot"]
    })
  ]);
  assert.equal(snapshot.findings[0].kind, "cli-surface");
});

test("same package metadata yields a medium package-version finding", () => {
  const report = diagnoseOverlap([
    subject({
      changeSetId: "change-set-1",
      changedPaths: ["package.json"],
      manifestTags: ["package"]
    }),
    subject({
      changeSetId: "change-set-2",
      changedPaths: ["package.json"],
      manifestTags: ["package"]
    })
  ]);
  const finding = report.findings.find((item) => item.kind === "package-version");
  assert.ok(finding);
  assert.equal(finding.risk, "medium");
});

test("a deletion against a path the other side modifies is high-risk", () => {
  // The ordinary delete-vs-modify case: only the deleting side can record
  // the deletion, so the finding must not require both sides to be tagged.
  const report = diagnoseOverlap([
    subject({
      changeSetId: "change-set-1",
      changedPaths: ["src/old.ts"],
      manifestTags: ["deletion"],
      deletedPaths: ["src/old.ts"]
    }),
    subject({
      changeSetId: "change-set-2",
      changedPaths: ["src/old.ts", "src/new.ts"],
      manifestTags: [],
      deletedPaths: []
    })
  ]);
  const finding = report.findings.find((item) => item.kind === "high-risk-deletion");
  assert.ok(finding);
  assert.equal(finding.risk, "high");
  assert.deepEqual(finding.paths, ["src/old.ts"]);
  assert.match(finding.detail, /One ChangeSet deletes/);
  assert.ok(report.reviewAreas.some((area) => area.startsWith("high-risk deletion")));
});

test("the deletion finding triggers on recorded deleted paths, not on tags", () => {
  // A manifest records real deletedPaths even when its tag list omits the
  // derived deletion tag; the recorded data is the trigger.
  const report = diagnoseOverlap([
    subject({
      changeSetId: "change-set-1",
      changedPaths: ["src/old.ts"],
      manifestTags: [],
      deletedPaths: ["src/old.ts"]
    }),
    subject({
      changeSetId: "change-set-2",
      changedPaths: ["src/old.ts"],
      manifestTags: [],
      deletedPaths: []
    })
  ]);
  const finding = report.findings.find((item) => item.kind === "high-risk-deletion");
  assert.ok(finding);
  assert.equal(finding.risk, "high");
  assert.deepEqual(finding.paths, ["src/old.ts"]);
});

test("a pair can produce several findings across categories", () => {
  const report = diagnoseOverlap([
    subject({
      changeSetId: "change-set-1",
      changedPaths: ["src/index.ts", "src/runtime/engine.ts"],
      manifestTags: ["contract"]
    }),
    subject({
      changeSetId: "change-set-2",
      changedPaths: ["src/index.ts", "src/runtime/engine.ts"],
      manifestTags: ["contract"]
    })
  ]);
  const kinds = report.findings.map((finding) => finding.kind).sort();
  assert.deepEqual(kinds, ["contract", "path-only"]);
});

test("legacy ChangeSets without a manifest degrade to path-only", () => {
  const legacy = createWorkItemChangeSet({
    id: "change-set-1",
    taskId: "task-1",
    workItemId: "work-item-1",
    projectId: "project-1",
    baseCommit: BASE,
    headCommit: HEAD,
    branch: "yui/task-1/main",
    changedPaths: ["src/index.ts"]
  }, now);
  const modern = createWorkItemChangeSet({
    id: "change-set-2",
    taskId: "task-2",
    workItemId: "work-item-1",
    projectId: "project-1",
    baseCommit: BASE,
    headCommit: HEAD,
    branch: "yui/task-2/main",
    changedPaths: ["src/index.ts"],
    manifest: createChangeSetManifest({ tags: ["contract"], deletedPaths: [] })
  }, now);
  const report = diagnoseOverlap([legacy, modern].map(overlapSubjectFromChangeSet));
  assert.equal(report.findings.length, 1);
  assert.equal(report.findings[0].kind, "path-only");
});

test("suggested order puts schema/migration-bearing ChangeSets first", () => {
  const report = diagnoseOverlap([
    subject({ changeSetId: "change-set-1", changedPaths: ["src/runtime/a.ts"] }),
    subject({
      changeSetId: "change-set-2",
      changedPaths: ["src/storage/migration/engine.ts"],
      manifestTags: ["migration"]
    }),
    subject({ changeSetId: "change-set-3", changedPaths: ["src/runtime/b.ts"] })
  ]);
  assert.equal(report.suggestedOrder[0], q("change-set-2"));
  assert.deepEqual([...report.suggestedOrder].sort(), [
    q("change-set-1"),
    q("change-set-2"),
    q("change-set-3")
  ]);
});

test("suggested order is deterministic and breaks ties by id", () => {
  const first = diagnoseOverlap([
    subject({ changeSetId: "change-set-2", changedPaths: ["src/a.ts"] }),
    subject({ changeSetId: "change-set-1", changedPaths: ["src/b.ts"] })
  ]);
  const second = diagnoseOverlap([
    subject({ changeSetId: "change-set-1", changedPaths: ["src/b.ts"] }),
    subject({ changeSetId: "change-set-2", changedPaths: ["src/a.ts"] })
  ]);
  assert.deepEqual(first.suggestedOrder, second.suggestedOrder);
  assert.deepEqual(first.suggestedOrder, [q("change-set-1"), q("change-set-2")]);
});

test("review areas list high and medium finding categories only", () => {
  const report = diagnoseOverlap([
    subject({
      changeSetId: "change-set-1",
      changedPaths: ["src/index.ts"],
      manifestTags: ["contract"]
    }),
    subject({
      changeSetId: "change-set-2",
      changedPaths: ["src/index.ts", "src/runtime/engine.ts"],
      manifestTags: ["contract"]
    })
  ]);
  assert.ok(report.reviewAreas.some((area) => area.startsWith("public contract")));
  assert.ok(!report.reviewAreas.some((area) => area.startsWith("path overlap")));
});

function changeSetRecord(overrides) {
  return createWorkItemChangeSet({
    id: overrides.id,
    taskId: overrides.taskId,
    workItemId: overrides.workItemId ?? "work-item-1",
    projectId: overrides.projectId ?? "project-1",
    baseCommit: overrides.baseCommit ?? BASE,
    headCommit: overrides.headCommit ?? HEAD,
    branch: `yui/${overrides.taskId}/main`,
    changedPaths: overrides.changedPaths,
    ...(overrides.manifest === undefined ? {} : { manifest: overrides.manifest })
  }, now);
}

function overlapStore(changeSetsByTask) {
  return {
    listTasks: () => Object.keys(changeSetsByTask).map((id) => ({ id })),
    listChangeSets: (taskId) => changeSetsByTask[taskId] ?? [],
    listProjects: () => [
      { id: "project-1", name: "app", aliases: [] },
      { id: "project-2", name: "lib", aliases: [] }
    ]
  };
}

test("task overlap reports no ChangeSets for an empty store", async () => {
  const result = await runTaskOverlapCommand([], overlapStore({}));
  assert.match(result.output, /No ChangeSets match/);
});

test("task overlap reports contract overlap across Tasks", async () => {
  const manifest = createChangeSetManifest({ tags: ["contract"], deletedPaths: [] });
  const store = overlapStore({
    "task-1": [changeSetRecord({
      id: "change-set-1", taskId: "task-1", changedPaths: ["src/index.ts"], manifest
    })],
    "task-2": [changeSetRecord({
      id: "change-set-2", taskId: "task-2", changedPaths: ["src/index.ts"], manifest
    })]
  });
  const result = await runTaskOverlapCommand([], store);
  assert.match(result.output, /\[high\] contract/);
  assert.match(result.output, /Suggested integration order/);
  assert.match(result.output, /public contract/);
});

test("task overlap qualifies same-local-id ChangeSets from different Tasks", async () => {
  // Two Tasks both minted change-set-1: bare ids would collide and the CLI
  // would resolve the first subject for both.  Qualified refs keep them
  // distinct through findings, ordering, and rendering.
  const manifest = createChangeSetManifest({ tags: ["contract"], deletedPaths: [] });
  const store = overlapStore({
    "task-1": [changeSetRecord({
      id: "change-set-1", taskId: "task-1", changedPaths: ["src/index.ts"], manifest
    })],
    "task-2": [changeSetRecord({
      id: "change-set-1", taskId: "task-2", changedPaths: ["src/index.ts"], manifest
    })]
  });
  const result = await runTaskOverlapCommand([], store);
  const contract = result.data.report.findings.find((item) => item.kind === "contract");
  assert.ok(contract, "the same-local-id pair must surface a contract finding");
  assert.deepEqual(contract.changeSetIds, ["task-1/change-set-1", "task-2/change-set-1"]);
  assert.deepEqual(result.data.report.suggestedOrder, [
    "task-1/change-set-1",
    "task-2/change-set-1"
  ]);
  // The CLI renders both qualified refs and resolves each to its own Task.
  assert.match(result.output, /task-1\/change-set-1/);
  assert.match(result.output, /task-2\/change-set-1/);
  assert.doesNotMatch(result.output, /change-set-1 vs change-set-1/);
});

test("task overlap filters by project, base, and task", async () => {
  const manifest = createChangeSetManifest({ tags: ["contract"], deletedPaths: [] });
  const store = overlapStore({
    "task-1": [changeSetRecord({
      id: "change-set-1", taskId: "task-1", changedPaths: ["src/index.ts"], manifest
    })],
    "task-2": [changeSetRecord({
      id: "change-set-2", taskId: "task-2", changedPaths: ["src/index.ts"], manifest
    })]
  });
  const single = await runTaskOverlapCommand(["--task", "task-1"], store);
  assert.equal(single.data.report.findings.length, 0);
  const otherBase = await runTaskOverlapCommand(["--base", "c".repeat(40)], store);
  assert.match(otherBase.output, /No ChangeSets match/);
  const otherProject = await runTaskOverlapCommand(["--project", "project-2"], store);
  assert.match(otherProject.output, /No ChangeSets match/);
});

test("task overlap resolves --project by ID, name, and alias", async () => {
  const manifest = createChangeSetManifest({ tags: ["contract"], deletedPaths: [] });
  const store = overlapStore({
    "task-1": [changeSetRecord({
      id: "change-set-1", taskId: "task-1", changedPaths: ["src/index.ts"], manifest
    })],
    "task-2": [changeSetRecord({
      id: "change-set-2", taskId: "task-2", changedPaths: ["src/index.ts"], manifest,
      projectId: "project-2"
    })]
  });
  // Filter by project name ("app" is the name of project-1 in the test store).
  const byName = await runTaskOverlapCommand(["--project", "app"], store);
  assert.match(byName.output, /change-set-1/);
  assert.doesNotMatch(byName.output, /change-set-2/);
  // Filter by project ID.
  const byId = await runTaskOverlapCommand(["--project", "project-1"], store);
  assert.match(byId.output, /change-set-1/);
  assert.doesNotMatch(byId.output, /change-set-2/);
  // Unknown project reference is rejected.
  await assert.rejects(
    () => runTaskOverlapCommand(["--project", "nonexistent"], store),
    /Project not found: nonexistent/
  );
});

test("task overlap degrades legacy ChangeSets to path-only", async () => {
  const manifest = createChangeSetManifest({ tags: ["contract"], deletedPaths: [] });
  const store = overlapStore({
    "task-1": [changeSetRecord({
      id: "change-set-1", taskId: "task-1", changedPaths: ["src/index.ts"]
    })],
    "task-2": [changeSetRecord({
      id: "change-set-2", taskId: "task-2", changedPaths: ["src/index.ts"], manifest
    })]
  });
  const result = await runTaskOverlapCommand([], store);
  assert.match(result.output, /\[low\] path-only/);
  assert.doesNotMatch(result.output, /\[high\] contract/);
});

test("task overlap uses the latest ChangeSet per Task and WorkItem", async () => {
  const manifest = createChangeSetManifest({ tags: ["contract"], deletedPaths: [] });
  const older = changeSetRecord({
    id: "change-set-1", taskId: "task-1", changedPaths: ["src/old.ts"], manifest
  });
  const newer = changeSetRecord({
    id: "change-set-2", taskId: "task-1", changedPaths: ["src/index.ts"], manifest
  });
  const store = overlapStore({
    "task-1": [older, newer],
    "task-2": [changeSetRecord({
      id: "change-set-3", taskId: "task-2", changedPaths: ["src/index.ts"], manifest
    })]
  });
  const result = await runTaskOverlapCommand([], store);
  assert.equal(result.data.report.subjects.length, 2);
  assert.ok(result.data.report.subjects.some((s) => s.changeSetId === "change-set-2"));
  assert.ok(!result.data.report.subjects.some((s) => s.changeSetId === "change-set-1"));
});
