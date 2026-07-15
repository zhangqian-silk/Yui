import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  createRoleSessionSet,
  recordRoleAgentSession
} from "../dist/executor/agentExecutor.js";
import {
  runExportCommand,
  runImportCommand
} from "../dist/commands/maintenanceCommands.js";
import { createGlobalRole, createRole } from "../dist/role/role.js";
import { executeDomainTransaction } from "../dist/storage/domainTransaction.js";
import { FileTaskStore } from "../dist/storage/taskStore.js";
import { createTask } from "../dist/task/task.js";

const now = new Date("2026-07-14T00:00:00.000Z");
const hash = "a".repeat(64);

function binding() {
  return { agentId: "codex", adapterId: "codex", config: { adapterId: "codex" } };
}

function configuredAgent() {
  return {
    schemaVersion: 2,
    id: "codex",
    adapterId: "codex",
    command: "codex",
    baseArgs: [],
    environment: [],
    createdAt: now.toISOString(),
    updatedAt: now.toISOString()
  };
}

function sessionSet(owner, nativeSessionId) {
  return recordRoleAgentSession(
    createRoleSessionSet(owner, "codex", now),
    {
      agentId: "codex",
      adapterId: "codex",
      nativeSessionId,
      policy: "fixed",
      status: "ready",
      sessionRoot: `/sessions/${nativeSessionId}`,
      worktreeRoot: "/repo",
      configFingerprint: {
        overall: hash,
        replayable: hash,
        permission: hash,
        sessionBound: hash
      },
      permissionEnvelope: { adapterId: "codex" }
    },
    now
  );
}

test("portable maintenance export and import preserve semantic Roles while excluding sessions", () => {
  const source = FileTaskStore.createEphemeralWorkspace("taskmux-role-export-source-");
  const target = FileTaskStore.createEphemeralWorkspace("taskmux-role-export-target-");
  const outputDir = mkdtempSync(join(tmpdir(), "taskmux-role-export-output-"));
  const output = join(outputDir, "snapshot.json");
  try {
    source.saveConfiguredAgent(configuredAgent());
    source.saveConfig({
      schemaVersion: 1,
      defaultAgent: "codex",
      defaultWorkspace: "/repo"
    });
    target.saveConfiguredAgent(configuredAgent());
    target.saveConfig({ schemaVersion: 1, defaultWorkspace: "/target-repo" });

    const globalRole = createGlobalRole("operator", [binding()], "codex", "/repo", now);
    source.saveGlobalRoleWithSessionSet(
      globalRole,
      sessionSet({ scope: "global", roleName: "operator" }, "global-native")
    );

    source.saveTask(createTask("task-1", "round trip", now));
    const taskRole = createRole("task-1", "leader", [binding()], "codex", "/repo", now);
    source.saveRoleWithSessionSet(
      "task-1",
      taskRole,
      sessionSet({ scope: "task", taskId: "task-1", roleName: "leader" }, "task-native")
    );
    source.saveTranscript("task-1", "leader", "role transcript\n");

    assert.match(runExportCommand(["--output", output], source), /Exported TaskMux portable data/);
    const snapshot = JSON.parse(readFileSync(output, "utf8"));
    assert.equal(snapshot.schemaVersion, 3);
    assert.doesNotMatch(JSON.stringify(snapshot), /global-native|task-native|sessionRoot|worktreeRoot|\/repo/);

    const imported = executeDomainTransaction(
      target.rootDirectory(),
      "portable-role-roundtrip",
      (workingRoot) => runImportCommand(
        [output, "--workspace-map", "default=default"],
        new FileTaskStore(workingRoot)
      )
    );
    assert.match(imported, /Imported TaskMux portable data/);
    assert.equal(target.getGlobalRole("operator").workspace, "/target-repo");
    assert.equal(target.getRole("task-1", "leader").workspace, "/target-repo");
    assert.equal(target.getGlobalRoleSessionSet("operator"), null);
    assert.equal(target.getRoleSessionSet("task-1", "leader"), null);
    assert.equal(target.readTranscript("task-1", "leader"), "role transcript\n");
    assert.equal(target.nativeSessionIdentityClaims().size, 0);
  } finally {
    source.disposeEphemeralWorkspace();
    target.disposeEphemeralWorkspace();
    rmSync(outputDir, { recursive: true, force: true });
  }
});

test("maintenance export refuses destinations inside TaskMux storage", () => {
  const source = FileTaskStore.createEphemeralWorkspace("taskmux-role-export-boundary-");
  try {
    assert.throws(
      () => runExportCommand(["--output", join(source.rootDirectory(), "snapshot.json")], source),
      /outside TASKMUX_HOME/i
    );
  } finally {
    source.disposeEphemeralWorkspace();
  }
});
