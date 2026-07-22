import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  buildLeaderContext,
  buildWorkerContext
} from "../../dist/context/dispatchContext.js";
import { prepareGlobalRoleLaunch } from "../../dist/operator/operatorContext.js";

const role = {
  schemaVersion: 2,
  taskId: "task-1",
  name: "leader",
  activeAgentId: "codex",
  agentBindings: {
    codex: { agentId: "codex", adapterId: "codex", config: { adapterId: "codex" } }
  },
  workspace: "/tmp/workspace",
  status: "idle",
  description: "Lead the implementation",
  constraints: ["Keep changes focused"],
  createdAt: new Date(0).toISOString(),
  updatedAt: new Date(0).toISOString()
};

test("dispatch contexts contain the real assignment but no session-bind bootstrap prompt", () => {
  const leader = buildLeaderContext({
    taskId: "task-1",
    role,
    input: "decide the next step"
  });
  const worker = buildWorkerContext({
    taskId: "task-1",
    role: { ...role, name: "worker" },
    input: "implement the bounded change"
  });

  assert.match(leader, /Yui Leader/);
  assert.match(leader, /Description: Lead the implementation/);
  assert.match(leader, /Constraint: Keep changes focused/);
  assert.match(leader, /decide the next step/);
  assert.match(worker, /Yui Worker/);
  assert.doesNotMatch(`${leader}\n${worker}`, /session-bind|CODEX_THREAD_ID|session record/i);
});

test("Operator launch keeps Codex argv prompt-free and exposes instructions separately", (t) => {
  const home = mkdtempSync(join(tmpdir(), "yui-operator-context-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const launch = prepareGlobalRoleLaunch({
    ...role,
    name: "operator",
    args: [],
    env: {}
  }, { yuiHome: home, baseEnv: {} });

  assert.deepEqual(launch.args, []);
  assert.equal(launch.env.YUI_ROLE, "operator");
  assert.ok(launch.contextPath);
  assert.match(readFileSync(launch.contextPath, "utf8"), /Yui Operator runtime/);
  assert.match(launch.systemPrompt, /Yui Operator instructions/);
});
