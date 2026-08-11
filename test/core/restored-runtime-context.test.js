import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  buildLeaderContext,
  buildWorkerContext,
  ensureWorkerRunCompletionRequirement
} from "../../dist/context/dispatchContext.js";
import { compileRoleSessionContext } from "../../dist/context/roleSessionContext.js";

const role = {
  schemaVersion: 3,
  taskId: "task-1",
  name: "leader",
  activeAgentId: "codex",
  agentBindings: {
    codex: {
      agentId: "codex",
      adapterId: "codex",
      config: { adapterId: "codex", permission: { strategy: "bypass" } }
    }
  },
  workspace: "/tmp/workspace",
  launchRevision: 1,
  defaultAccess: "write",
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
    workItem: {
      id: "work-item-1",
      writeProjectIds: ["project-backend"]
    },
    workspace: {
      root: "/tmp/workspace",
      entries: [
        {
          projectId: "project-backend",
          directory: "backend",
          access: "write"
        },
        {
          projectId: "project-frontend",
          directory: "frontend",
          access: "read"
        }
      ]
    },
    input: "implement the bounded change"
  });

  assert.match(leader, /injected yui-leader/);
  assert.match(leader, /Description: Lead the implementation/);
  assert.match(leader, /Constraint: Keep changes focused/);
  assert.match(leader, /decide the next step/);
  assert.match(worker, /injected yui-worker/);
  assert.match(worker, /WorkItem: work-item-1/);
  assert.match(worker, /Writable Projects:\n- backend \(project-backend\)/);
  assert.match(worker, /Context-only Projects:\n- frontend \(project-frontend\)/);
  assert.match(worker, /ask the Task Leader to expand/i);
  assert.match(worker, /yui task context task-1/);
  assert.match(worker, /yui task run yield <current-run-id>/);
  assert.match(worker, /final response alone does neither/i);
  assert.doesNotMatch(`${leader}\n${worker}`, /Role instruction:|Configured role skills:/);
  assert.doesNotMatch(`${leader}\n${worker}`, /session-bind|CODEX_THREAD_ID|session record/i);
});

test("Worker completion requirement is idempotent without trusting a user-authored marker", () => {
  const input = "Discuss this literal text: Yui Role Run completion requirement:";
  const ensured = ensureWorkerRunCompletionRequirement(input);

  assert.equal(
    ensured.match(/Yui Role Run completion requirement:/g)?.length,
    2
  );
  assert.equal(ensureWorkerRunCompletionRequirement(ensured), ensured);
});

test("Claude Worker completion requires the exact explicit yield transport", () => {
  const worker = buildWorkerContext({
    taskId: "task-1",
    role: {
      ...role,
      name: "worker",
      activeAgentId: "claude",
      agentBindings: {
        claude: {
          agentId: "claude",
          adapterId: "claude",
          config: { adapterId: "claude", permission: { strategy: "bypass" } }
        }
      }
    },
    input: "return the bounded result"
  });

  assert.match(worker, /yui task run yield <current-run-id> --summary-file -/u);
  assert.match(worker, /final response alone does neither/iu);
  assert.doesNotMatch(worker, /managed Stop hook|final assistant message/iu);
});

test("Codex and Claude Worker handoffs require truthful uncertain evidence", () => {
  const evidencePatterns = [
    /exact Run, WorkItem, and native Session identity/iu,
    /actions actually performed/iu,
    /changed paths and commit\/worktree state/iu,
    /checks actually run and their outcomes/iu,
    /provider, runtime, or permission errors/iu,
    /last confirmed lifecycle boundary/iu,
    /work not performed/iu,
    /unresolved assumptions or decisions/iu,
    /residual risks/iu,
    /confidence/iu,
    /bounded next options/iu
  ];

  for (const adapterId of ["codex", "claude"]) {
    const worker = buildWorkerContext({
      taskId: "task-1",
      role: {
        ...role,
        name: "reviewer",
        activeAgentId: adapterId,
        agentBindings: {
          [adapterId]: {
            agentId: adapterId,
            adapterId,
            config: { adapterId, permission: { strategy: "bypass" } }
          }
        }
      },
      input: "return the bounded review"
    });

    assert.match(
      worker,
      /uncertain, incomplete, blocked, or requiring Leader judgment/iu
    );
    for (const pattern of evidencePatterns) assert.match(worker, pattern);
    assert.match(
      worker,
      /immutable Run evidence and a Candidate, or Review evidence only/iu
    );
    assert.match(
      worker,
      /never implies Leader acceptance, WorkItem completion, ChangeSet capture, Integration, or Task completion/iu
    );
    assert.match(
      worker,
      /Review Runs report findings, verification gaps, and limits; the Leader decides disposition/iu
    );
    assert.match(
      worker,
      /If the exact yield is denied[\s\S]*do not retry[\s\S]*broaden permissions[\s\S]*wrapper[\s\S]*mutate Yui state[\s\S]*invent delivery evidence/iu
    );
    assert.match(worker, /yield command must be your final tool action/iu);
  }
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

test("non-Operator global Roles use neutral context without Task orchestration Skills", () => {
  for (const name of ["leader", "reviewer"]) {
    const context = compileRoleSessionContext(undefined, {
      ...role,
      name
    }, { scope: "global" });

    assert.match(context.developerInstructions, new RegExp(`global Yui Role ${name}`));
    assert.doesNotMatch(
      context.developerInstructions,
      /Task|yui-(?:leader|worker|reviewer)/
    );
    assert.deepEqual(context.skills, []);
  }
});

test("Task review Runs select reviewer policy by purpose instead of Role name", () => {
  const configuredName = "quality-gate";
  const execution = compileRoleSessionContext(undefined, {
    ...role,
    name: configuredName
  }, { scope: "task", taskId: "task-1" });
  const review = compileRoleSessionContext(undefined, {
    ...role,
    name: configuredName
  }, { scope: "task", taskId: "task-1" }, { purpose: "review" });

  assert.deepEqual(execution.skills.map(({ id }) => id), ["yui-worker"]);
  assert.deepEqual(review.skills.map(({ id }) => id), ["yui-reviewer"]);
  assert.match(review.developerInstructions, /injected yui-reviewer/u);
  assert.doesNotMatch(review.developerInstructions, /injected yui-worker/u);
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
  assert.equal(
    compileRoleSessionContext(home, configuredRole, {
      scope: "task",
      taskId: "task-1"
    }).managedContextFile,
    context.managedContextFile
  );
  assert.notEqual(
    compileRoleSessionContext(home, configuredRole, {
      scope: "task",
      taskId: "task-2"
    }).managedContextFile,
    context.managedContextFile
  );
  assert.doesNotMatch(dispatch, /PRIVATE ROLE POLICY|PRIVATE SKILL BODY/);
});
