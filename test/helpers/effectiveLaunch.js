import {
  createAgentRun as createDomainAgentRun
} from "../../dist/run/agentRun.js";
import {
  createRoleAgentSession as createDomainRoleAgentSession,
  recordRoleAgentSession as recordDomainRoleAgentSession
} from "../../dist/executor/agentExecutor.js";
import { resolveEffectiveLaunch } from "../../dist/executor/effectiveLaunch.js";

const NOW = new Date("2026-08-02T00:00:00.000Z");

export function testEffectiveLaunch(input = {}) {
  const workspace = input.workspace;
  const workspaceRoot = typeof workspace === "object" && workspace !== null
    ? workspace.root
    : input.workspaceRoot ?? "/fixture/workspace";
  const agentId = input.agentId ?? "codex";
  const adapterId = input.adapterId ?? (agentId === "claude" ? "claude" : "codex");
  const config = {
    adapterId,
    ...(input.model === undefined ? {} : { model: input.model }),
    ...(input.effort === undefined ? {} : { effort: input.effort })
  };
  const taskScoped = typeof workspace === "object" && workspace !== null;
  const role = {
    schemaVersion: 3,
    ...(taskScoped ? { taskId: workspace.taskId ?? "task-1", status: "idle" } : {}),
    name: input.roleName ?? "fixture-role",
    activeAgentId: agentId,
    agentBindings: {
      [agentId]: { agentId, adapterId, config }
    },
    workspace: workspaceRoot,
    launchRevision: input.sourceDesiredRevision ?? 1,
    defaultAccess: input.access === "read" ? "read" : "write",
    createdAt: NOW.toISOString(),
    updatedAt: NOW.toISOString()
  };
  const writeProjectIds = taskScoped
    ? workspace.entries.filter(({ access }) => access === "write").map(({ projectId }) => projectId)
    : undefined;
  return resolveEffectiveLaunch({
    role,
    purpose: input.purpose ?? (input.access === "read" ? "review" : "execution"),
    ...(taskScoped ? { workspace, workItemWriteProjectIds: writeProjectIds } : {}),
    ...(input.purpose === "review"
      ? {
          reviewRoundId: input.reviewRoundId ?? "review-round-1",
          reviewBaseCommit: input.reviewBaseCommit ?? workspace.entries[0].baseCommit
        }
      : {})
  });
}

export function createAgentRun(...args) {
  const context = args[6] ?? {};
  const oldAgent = context.agent ?? {};
  const effective = context.effective ?? testEffectiveLaunch({
    agentId: oldAgent.agentId,
    adapterId: oldAgent.adapterId,
    model: oldAgent.model,
    effort: oldAgent.effort,
    workspace: context.workspace,
    purpose: context.purpose,
    reviewRoundId: context.reviewRoundId,
    reviewBaseCommit: context.reviewBaseCommit
  });
  const { agent: _agent, ...current } = context;
  return createDomainAgentRun(...args.slice(0, 6), { ...current, effective });
}

export function recordRoleAgentSession(set, input, now) {
  return recordDomainRoleAgentSession(set, {
    ...input,
    effective: input.effective ?? testEffectiveLaunch({
      agentId: input.agentId,
      adapterId: input.adapterId
    })
  }, now);
}

export function createRoleAgentSession(input, now) {
  return createDomainRoleAgentSession({
    ...input,
    effective: input.effective ?? testEffectiveLaunch({
      agentId: input.agentId,
      adapterId: input.adapterId
    })
  }, now);
}
