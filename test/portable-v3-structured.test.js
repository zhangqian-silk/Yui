import assert from "node:assert/strict";
import test from "node:test";

import {
  PORTABLE_EXPORT_ERROR_MESSAGE,
  projectPortableSnapshotV3,
  renderPortableSnapshotV3
} from "../dist/storage/portableExport.js";
import {
  PortableImportError,
  applyPortableImportPlanInTransaction,
  planPortableImport
} from "../dist/storage/portableImport.js";
import {
  MAX_PORTABLE_SNAPSHOT_BYTES,
  parsePortableSnapshotV3,
  snapshotPortableSnapshotV3
} from "../dist/storage/portableSchema.js";

const CREATED_AT = "2026-07-14T08:00:00.000Z";
const EXPORTED_AT = "2026-07-14T09:00:00.000Z";

const SOURCE_BINDING = {
  schemaVersion: 1,
  bindingId: "source-repository",
  kind: "repository",
  relativeSubpath: "projects/taskmux",
  label: "TaskMux repository"
};

const TARGET_BINDING = {
  schemaVersion: 1,
  bindingId: "target-repository",
  kind: "repository",
  relativeSubpath: "projects/restored-taskmux",
  label: "Restored TaskMux repository"
};

const REQUIREMENTS = [
  { schemaVersion: 1, agentId: "claude", adapterId: "claude" },
  { schemaVersion: 1, agentId: "codex", adapterId: "codex" }
];

function clone(value) {
  return structuredClone(value);
}

function taskReference() {
  return { lifecycle: "live", authority: "task", key: "task-1" };
}

function structuredBindings() {
  return {
    claude: {
      agentId: "claude",
      adapterId: "claude",
      config: {
        adapterId: "claude",
        model: "claude-opus",
        effort: "high",
        permission: {
          mode: "acceptEdits",
          allowedTools: ["Grep", "Read"]
        }
      }
    },
    codex: {
      agentId: "codex",
      adapterId: "codex",
      config: {
        adapterId: "codex",
        model: "gpt-5",
        effort: "high",
        search: true,
        permission: {
          sandbox: "workspace-write",
          approval: "never"
        }
      }
    }
  };
}

function globalRoleRecord() {
  return {
    schemaVersion: 1,
    lifecycle: "live",
    authority: "global-role",
    key: "operator",
    payload: {
      schemaVersion: 1,
      name: "operator",
      activeAgentId: "codex",
      agentBindings: structuredBindings(),
      description: "Coordinates the portable logical task graph.",
      createdAt: CREATED_AT,
      updatedAt: CREATED_AT
    },
    workspaceBindingIds: ["source-repository"],
    agentRequirementIds: ["claude", "codex"],
    references: []
  };
}

function taskRecord() {
  return {
    schemaVersion: 1,
    lifecycle: "live",
    authority: "task",
    key: "task-1",
    payload: {
      schemaVersion: 1,
      id: "task-1",
      title: "Portable structured role",
      description: "Portable task content remains user-authored semantic state.",
      archived: false,
      tags: ["portable", "structured-role"],
      createdAt: CREATED_AT,
      updatedAt: CREATED_AT
    },
    workspaceBindingIds: [],
    agentRequirementIds: [],
    references: []
  };
}

function taskRoleRecord() {
  return {
    schemaVersion: 1,
    lifecycle: "live",
    authority: "task-role",
    key: "task-1/leader",
    payload: {
      schemaVersion: 1,
      taskId: "task-1",
      name: "leader",
      activeAgentId: "claude",
      agentBindings: structuredBindings(),
      responsibilities: ["Coordinate the task work."],
      createdAt: CREATED_AT,
      updatedAt: CREATED_AT
    },
    workspaceBindingIds: ["source-repository"],
    agentRequirementIds: ["claude", "codex"],
    references: [taskReference()]
  };
}

function structuredSnapshot() {
  return {
    schemaVersion: 3,
    exportedAt: EXPORTED_AT,
    workspaceBindings: [clone(SOURCE_BINDING)],
    agentRequirements: clone(REQUIREMENTS),
    semantic: [globalRoleRecord(), taskRecord(), taskRoleRecord()]
  };
}

function semanticKey(record) {
  return `${record.lifecycle}\0${record.authority}\0${record.key}`;
}

function exportReader(snapshot) {
  const recordBuckets = new Map();
  for (const record of snapshot.semantic) {
    const bucket = recordBuckets.get(record.authority) ?? [];
    bucket.push(clone(record));
    recordBuckets.set(record.authority, bucket);
  }
  const reads = [];
  const excludedAuthorities = new Set([
    "configured-agent",
    "role-session-set",
    "native-session-identity-ledger",
    "role-worktree",
    "active-agent-run",
    "role-runtime-operation",
    "derived-index"
  ]);
  return {
    reads,
    listAuthorityIds() {
      return [
        "role-session-set",
        "task-role",
        "active-agent-run",
        "task",
        "global-role",
        "role-worktree",
        "derived-index"
      ];
    },
    readAuthorityRecords(authority) {
      reads.push(authority);
      if (excludedAuthorities.has(authority)) {
        throw new Error("host-only values must never be read by portable export");
      }
      return clone(recordBuckets.get(authority) ?? []);
    },
    readWorkspaceBindings() {
      return [
        {
          schemaVersion: 1,
          bindingId: "unused",
          kind: "named",
          relativeSubpath: "unused",
          label: "Unused binding"
        },
        clone(SOURCE_BINDING)
      ];
    },
    readAgentRequirements() {
      return [
        { schemaVersion: 1, agentId: "unused", adapterId: "claude" },
        ...clone(REQUIREMENTS)
      ];
    }
  };
}

function importTarget() {
  const semantic = new Map();
  const bindings = new Map([[TARGET_BINDING.bindingId, {
    descriptor: clone(TARGET_BINDING),
    witness: "target-repository-v1"
  }]]);
  const requirements = new Map(REQUIREMENTS.map((value) => [value.agentId, clone(value)]));

  return {
    semantic,
    bindings,
    readWorkspaceBinding(bindingId) {
      const state = bindings.get(bindingId);
      return state === undefined ? null : clone(state);
    },
    readAgentRequirement(agentId) {
      const requirement = requirements.get(agentId);
      return requirement === undefined ? null : clone(requirement);
    },
    readSemantic(identity) {
      const record = semantic.get(`${identity.lifecycle}\0${identity.authority}\0${identity.key}`);
      return record === undefined ? null : clone(record);
    },
    applySemanticBatch(_records, creates) {
      for (const record of creates) semantic.set(semanticKey(record), clone(record));
    }
  };
}

test("structured Role semantic state exports canonically without touching host/runtime authorities", () => {
  const expected = snapshotPortableSnapshotV3(structuredSnapshot());
  assert.ok(expected);

  const reader = exportReader(expected);
  const rendered = renderPortableSnapshotV3(reader, EXPORTED_AT);

  assert.deepEqual(rendered.snapshot, expected);
  assert.deepEqual(parsePortableSnapshotV3(rendered.manifest), expected);
  assert.deepEqual(reader.reads, ["task-role", "task", "global-role"]);
  assert.deepEqual(rendered.snapshot.semantic.map((record) => record.authority), [
    "global-role",
    "task",
    "task-role"
  ]);
  assert.deepEqual(JSON.parse(JSON.stringify(rendered.snapshot.agentRequirements)), REQUIREMENTS);
  assert.deepEqual(JSON.parse(JSON.stringify(rendered.snapshot.workspaceBindings)), [SOURCE_BINDING]);
  assert.equal(Object.isFrozen(rendered.snapshot), true);
  assert.equal(Object.isFrozen(rendered.snapshot.semantic[0].payload), true);
  assert.doesNotMatch(rendered.manifest, /role-session-set|worktree|runtime|derived-index/);
});

test("structured v3 import maps workspace bindings and becomes idempotent after one transaction", () => {
  const source = snapshotPortableSnapshotV3(structuredSnapshot());
  assert.ok(source);
  const manifest = renderPortableSnapshotV3(exportReader(source), EXPORTED_AT).manifest;
  const target = importTarget();
  const mappings = [{
    schemaVersion: 1,
    sourceBindingId: SOURCE_BINDING.bindingId,
    targetBindingId: TARGET_BINDING.bindingId
  }];

  const firstPlan = planPortableImport(manifest, mappings, target);
  assert.deepEqual(firstPlan.entries.map((entry) => entry.action), ["create", "create", "create"]);
  assert.deepEqual(applyPortableImportPlanInTransaction(firstPlan, target), {
    schemaVersion: 1,
    created: 3,
    noOp: 0
  });

  const importedGlobalRole = target.semantic.get("live\0global-role\0operator");
  const importedTaskRole = target.semantic.get("live\0task-role\0task-1/leader");
  assert.deepEqual(importedGlobalRole.workspaceBindingIds, [TARGET_BINDING.bindingId]);
  assert.deepEqual(importedTaskRole.workspaceBindingIds, [TARGET_BINDING.bindingId]);
  assert.deepEqual(importedTaskRole.payload.agentBindings, taskRoleRecord().payload.agentBindings);
  assert.equal(Object.hasOwn(importedTaskRole.payload.agentBindings.codex.config, "command"), false);
  assert.equal(Object.hasOwn(importedTaskRole.payload.agentBindings.codex.config, "env"), false);

  const replayPlan = planPortableImport(manifest, mappings, target);
  assert.deepEqual(replayPlan.entries.map((entry) => entry.action), ["no-op", "no-op", "no-op"]);
  assert.deepEqual(applyPortableImportPlanInTransaction(replayPlan, target), {
    schemaVersion: 1,
    created: 0,
    noOp: 3
  });
});

test("v3 rejects incomplete, duplicate, missing, incompatible, and drifted workspace mappings", () => {
  const source = snapshotPortableSnapshotV3(structuredSnapshot());
  assert.ok(source);
  const manifest = renderPortableSnapshotV3(exportReader(source), EXPORTED_AT).manifest;
  const mapping = {
    schemaVersion: 1,
    sourceBindingId: SOURCE_BINDING.bindingId,
    targetBindingId: TARGET_BINDING.bindingId
  };

  assert.throws(
    () => planPortableImport(manifest, [], importTarget()),
    (error) => error instanceof PortableImportError && error.code === "INVALID_MAPPING"
  );
  assert.throws(
    () => planPortableImport(manifest, [mapping, mapping], importTarget()),
    (error) => error instanceof PortableImportError && error.code === "INVALID_MAPPING"
  );
  assert.throws(
    () => planPortableImport(manifest, [{
      ...mapping,
      targetBindingId: "missing-target"
    }], importTarget()),
    (error) => error instanceof PortableImportError && error.code === "REQUIREMENT_MISMATCH"
  );

  const wrongKind = importTarget();
  wrongKind.bindings.set(TARGET_BINDING.bindingId, {
    descriptor: { ...TARGET_BINDING, kind: "named" },
    witness: "wrong-kind"
  });
  assert.throws(
    () => planPortableImport(manifest, [mapping], wrongKind),
    (error) => error instanceof PortableImportError && error.code === "INVALID_MAPPING"
  );

  const drifted = importTarget();
  const plan = planPortableImport(manifest, [mapping], drifted);
  drifted.bindings.set(TARGET_BINDING.bindingId, {
    descriptor: clone(TARGET_BINDING),
    witness: "target-repository-v2"
  });
  assert.throws(
    () => applyPortableImportPlanInTransaction(plan, drifted),
    (error) => error instanceof PortableImportError && error.code === "IMPORT_DRIFT"
  );
});

test("v3 rejects host-bound adapters, session/runtime state, command/env/probe fields, and paths", () => {
  const cases = [
    ["native ledger", (value) => { value.nativeSessionIdentities = {}; }],
    ["absolute workspace path", (value) => { value.workspaceBindings[0].relativeSubpath = "/host/worktree"; }],
    ["agent requirement session id", (value) => { value.agentRequirements[1].sessionId = "session-1"; }],
    ["agent command", (value) => {
      value.semantic[0].payload.agentBindings.codex.config.command = "taskmux host-command";
    }],
    ["agent environment", (value) => {
      value.semantic[0].payload.agentBindings.codex.config.env = { HOME: "/host/home" };
    }],
    ["agent probe pin", (value) => {
      value.semantic[0].payload.agentBindings.codex.config.probe = "host-probe";
    }],
    ["role runtime state", (value) => {
      value.semantic[2].payload.runtimeOperationId = "runtime-operation-1";
    }],
    ["task worktree", (value) => {
      value.semantic[1].payload.worktreeRoot = "/host/worktree";
    }],
    ["derived record", (value) => {
      value.semantic[1].authority = "derived-index";
      value.semantic[1].key = "index";
    }]
  ];

  for (const [label, mutate] of cases) {
    const candidate = structuredSnapshot();
    mutate(candidate);
    assert.equal(snapshotPortableSnapshotV3(candidate), null, label);
  }

  let accessorCalls = 0;
  const hostile = structuredSnapshot();
  Object.defineProperty(hostile.semantic[0].payload, "name", {
    enumerable: true,
    get() {
      accessorCalls += 1;
      throw new Error("must not run");
    }
  });
  assert.equal(snapshotPortableSnapshotV3(hostile), null);
  assert.equal(accessorCalls, 0);
});

test("export and import redact operational failures rather than leaking callback details", () => {
  const reader = exportReader(snapshotPortableSnapshotV3(structuredSnapshot()));
  reader.listAuthorityIds = () => ["unknown-fixture-secret"];
  assert.throws(
    () => projectPortableSnapshotV3(reader, EXPORTED_AT),
    (error) => error instanceof Error && error.message === PORTABLE_EXPORT_ERROR_MESSAGE
  );

  const target = importTarget();
  const readAgentRequirement = target.readAgentRequirement;
  target.readAgentRequirement = (agentId) => agentId === "claude"
    ? { schemaVersion: 1, agentId: "claude", adapterId: "different-adapter" }
    : readAgentRequirement(agentId);
  assert.throws(
    () => planPortableImport(JSON.stringify(structuredSnapshot()), [{
      schemaVersion: 1,
      sourceBindingId: SOURCE_BINDING.bindingId,
      targetBindingId: TARGET_BINDING.bindingId
    }], target),
    (error) => error instanceof PortableImportError && error.code === "REQUIREMENT_MISMATCH"
  );
});

test("portable v3 library shares one UTF-8 8 MiB cap across parse, plan/apply, and export", () => {
  const utf8Manifest = JSON.stringify({
    schemaVersion: 3,
    exportedAt: EXPORTED_AT,
    workspaceBindings: [{
      schemaVersion: 1,
      bindingId: "unicode",
      kind: "repository",
      relativeSubpath: "unicode",
      label: "界"
    }],
    agentRequirements: [],
    semantic: []
  });
  const utf8Bytes = Buffer.byteLength(utf8Manifest, "utf8");
  assert.ok(utf8Bytes > utf8Manifest.length);
  assert.ok(parsePortableSnapshotV3(utf8Manifest));
  assert.equal(parsePortableSnapshotV3(utf8Manifest, {
    maxBytes: utf8Manifest.length
  }), null);

  const target = importTarget();
  const defaultPlan = planPortableImport(utf8Manifest, [{
    schemaVersion: 1,
    sourceBindingId: "unicode",
    targetBindingId: TARGET_BINDING.bindingId
  }], target);
  assert.deepEqual(applyPortableImportPlanInTransaction(defaultPlan, target), {
    schemaVersion: 1,
    created: 0,
    noOp: 0
  });
  assert.throws(
    () => planPortableImport(utf8Manifest, [{
      schemaVersion: 1,
      sourceBindingId: "unicode",
      targetBindingId: TARGET_BINDING.bindingId
    }], target, { maxBytes: utf8Bytes - 1 }),
    (error) => error instanceof PortableImportError && error.code === "INVALID_SNAPSHOT"
  );

  const emptyManifest = JSON.stringify({
    schemaVersion: 3,
    exportedAt: EXPORTED_AT,
    workspaceBindings: [],
    agentRequirements: [],
    semantic: []
  });
  const exactManifest = `${emptyManifest}${" ".repeat(
    MAX_PORTABLE_SNAPSHOT_BYTES - Buffer.byteLength(emptyManifest, "utf8")
  )}`;
  const tooLargeManifest = `${exactManifest} `;
  assert.equal(Buffer.byteLength(exactManifest, "utf8"), MAX_PORTABLE_SNAPSHOT_BYTES);
  assert.equal(Buffer.byteLength(tooLargeManifest, "utf8"), MAX_PORTABLE_SNAPSHOT_BYTES + 1);
  assert.ok(parsePortableSnapshotV3(exactManifest, {
    maxBytes: MAX_PORTABLE_SNAPSHOT_BYTES
  }));
  assert.equal(parsePortableSnapshotV3(tooLargeManifest), null);
  assert.equal(parsePortableSnapshotV3(utf8Manifest, {
    maxBytes: MAX_PORTABLE_SNAPSHOT_BYTES + 1
  }), null);
  assert.throws(
    () => planPortableImport(utf8Manifest, [{
      schemaVersion: 1,
      sourceBindingId: "unicode",
      targetBindingId: TARGET_BINDING.bindingId
    }], target, { maxBytes: MAX_PORTABLE_SNAPSHOT_BYTES + 1 }),
    (error) => error instanceof PortableImportError && error.code === "INVALID_SNAPSHOT"
  );
  const exactPlan = planPortableImport(exactManifest, [], target, {
    maxBytes: MAX_PORTABLE_SNAPSHOT_BYTES
  });
  assert.deepEqual(applyPortableImportPlanInTransaction(exactPlan, target), {
    schemaVersion: 1,
    created: 0,
    noOp: 0
  });

  const invalidMaxBytes = [-1, Number.MAX_SAFE_INTEGER + 1, Number.NaN, Number.POSITIVE_INFINITY];
  for (const maxBytes of invalidMaxBytes) {
    assert.equal(parsePortableSnapshotV3(utf8Manifest, { maxBytes }), null);
    assert.throws(
      () => planPortableImport(utf8Manifest, [{
        schemaVersion: 1,
        sourceBindingId: "unicode",
        targetBindingId: TARGET_BINDING.bindingId
      }], target, { maxBytes }),
      (error) => error instanceof PortableImportError && error.code === "INVALID_SNAPSHOT"
    );
  }

  const emptyReader = {
    listAuthorityIds: () => [],
    readAuthorityRecords: () => [],
    readWorkspaceBindings: () => [],
    readAgentRequirements: () => []
  };
  const rendered = renderPortableSnapshotV3(emptyReader, EXPORTED_AT);
  const renderedBytes = Buffer.byteLength(rendered.manifest, "utf8");
  assert.doesNotThrow(() => renderPortableSnapshotV3(emptyReader, EXPORTED_AT, renderedBytes));
  assert.throws(
    () => renderPortableSnapshotV3(emptyReader, EXPORTED_AT, renderedBytes - 1),
    (error) => error instanceof Error && error.message === PORTABLE_EXPORT_ERROR_MESSAGE
  );
  for (const maxBytes of [...invalidMaxBytes, MAX_PORTABLE_SNAPSHOT_BYTES + 1]) {
    assert.throws(
      () => renderPortableSnapshotV3(emptyReader, EXPORTED_AT, maxBytes),
      (error) => error instanceof Error && error.message === PORTABLE_EXPORT_ERROR_MESSAGE
    );
  }
});
