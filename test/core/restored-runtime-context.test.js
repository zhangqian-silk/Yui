import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  buildLeaderContext,
  buildWorkerContext
} from "../../dist/context/dispatchContext.js";
import { compileRoleSessionContext } from "../../dist/context/roleSessionContext.js";

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

  assert.match(leader, /injected yui-leader/);
  assert.match(leader, /Description: Lead the implementation/);
  assert.match(leader, /Constraint: Keep changes focused/);
  assert.match(leader, /decide the next step/);
  assert.match(worker, /injected yui-worker/);
  assert.doesNotMatch(`${leader}\n${worker}`, /Role instruction:|Configured role skills:/);
  assert.doesNotMatch(`${leader}\n${worker}`, /session-bind|CODEX_THREAD_ID|session record/i);
});

test("Operator context exposes native developer instructions and a Skill reference", () => {
  const context = compileRoleSessionContext(undefined, {
    ...role,
    name: "operator"
  }, { scope: "global" });

  assert.match(context.developerInstructions, /global Yui Operator/);
  assert.match(context.developerInstructions, /injected yui-operator/);
  assert.equal(context.skills.length, 1);
  assert.equal(context.skills[0].id, "yui-operator");
  assert.match(context.skills[0].path, /skills\/yui-operator\/?$/);
});

test("configured Role policy and Skills stay in native session context, not dispatch text", (t) => {
  const home = mkdtempSync(join(tmpdir(), "yui-role-context-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const skillDir = join(home, "skills", "review-policy");
  mkdirSync(skillDir, { recursive: true });
  writeFileSync(join(skillDir, "SKILL.md"), "# Review policy\n\nPRIVATE SKILL BODY\n");
  const configuredRole = {
    ...role,
    name: "reviewer",
    systemPrompt: "PRIVATE ROLE POLICY",
    skills: ["review-policy"]
  };
  const context = compileRoleSessionContext(home, configuredRole, {
    scope: "task",
    taskId: "task-1"
  });
  const dispatch = buildWorkerContext({
    taskId: "task-1",
    role: configuredRole,
    input: "review the change"
  });

  assert.match(context.developerInstructions, /PRIVATE ROLE POLICY/);
  assert.deepEqual(context.skills.map(({ id }) => id), ["yui-worker", "review-policy"]);
  assert.equal(context.skills[1].content.includes("PRIVATE SKILL BODY"), true);
  assert.doesNotMatch(dispatch, /PRIVATE ROLE POLICY|PRIVATE SKILL BODY/);
});
