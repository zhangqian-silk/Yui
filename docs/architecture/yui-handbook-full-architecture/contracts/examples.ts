import {
  type BriefRecord, type Candidate, type OperationRecord, type PluginManifest,
  type RoleRecord, type SessionRecord, type Submission, type Review,
  type TaskRecord, type ExecutionGroup, recipientForProblem
} from './model';

export const task: TaskRecord = {
  id: 'task-1', title: '整理授权资料并形成说明', state: 'draft',
  leaderRoleId: 'leader-1', briefRef: { id: 'brief-1', revision: 1 },
  projectRefs: [], revision: 1, createdAt: '2026-09-05T09:00:00Z',
  updatedAt: '2026-09-05T09:00:00Z'
};
export const brief: BriefRecord = {
  id: 'brief-1', taskId: task.id, revision: 1, objective: '形成可交付说明',
  currentFocus: '先理解材料'
};
export const role: RoleRecord = {
  id: 'worker-1', kind: 'worker', taskId: task.id, revision: 1,
  current: {
    selection: { agentId: 'configured-agent-a', settings: {} },
    instructions: '完成被委派的责任并保存结果。', skillRefs: [], resourceGrantRefs: []
  }
};
export const oldSession: SessionRecord = {
  id: 'session-1', roleId: role.id, effective: role.current,
  implementation: { pluginId: 'example/runtime', generation: 'g1', version: '1.0', artifactDigest: 'sha256:example-a' },
  statefulDependencies: []
};
export const nextRole: RoleRecord = {
  ...role, revision: 2,
  current: { ...role.current, selection: { agentId: 'configured-agent-b', settings: {} } }
};
// oldSession keeps its actual configuration; changing Role does not rewrite it.
export const candidate: Candidate = {
  id: 'candidate-1', taskId: task.id, workItemId: 'work-1',
  source: { kind: 'turn', turnId: 'turn-1' },
  summary: '已形成说明',
  artifacts: [{ kind: 'content', id: 'artifact-1', digest: 'sha256:example-report', locator: 'artifacts/report.md' }],
  contextRefs: [{ id: brief.id, revision: brief.revision }]
};
export const progressUpdate: BriefRecord = { ...brief, revision: 2, currentFocus: '等待负责人阅读说明' };
// A progress write does not edit candidate or impose automatic invalidation.
export const review: Review = {
  id: 'review-1', taskId: task.id, candidateId: candidate.id, reviewerTurnId: 'review-turn-1'
};
export const group: ExecutionGroup = {
  id: 'group-1', assignment: { objective: '独立检查同一材料', contextRefs: [], permittedResourceRefs: [] },
  attempts: [
    { replica: 0, attempt: 0, turnId: 'a0' },
    { replica: 1, attempt: 0, turnId: 'b0' },
    { replica: 1, attempt: 1, turnId: 'b1' }
  ], selectedResultTurns: ['a0', 'b1']
};
export const outputFailureAfterEffect: OperationRecord = {
  id: 'op-1', requestId: 'req-1', requestDigest: 'sha256:input', actorId: 'leader-1',
  capability: 'example.publish', state: 'finished', outcome: 'failed', effect: 'confirmed',
  receiptRefs: ['external-receipt-1'], partialResultRefs: ['published-id-1'], errorRef: 'output-schema-error'
};
export const waiting: Submission = { kind: 'pending', attemptId: 'attempt-1' };
export const plugin: PluginManifest = {
  id: 'task-tools/format-reader', version: '1.0', apiVersion: '1', entrypoint: 'dist/main.js',
  provides: ['format.read'], requires: [], permissions: ['task-files:read'], reloadMode: 'hot'
};
export const leaderProblemRecipient = recipientForProblem('leader');
// @ts-expect-error Task has no domain-specific lifecycle.
export const invalidState: TaskRecord['state'] = 'researching';
// @ts-expect-error A result candidate cannot masquerade as a code-retention handle.
export const invalidSource: Candidate['source'] = { kind: 'plugin-pin', generation: 'g1' };
// @ts-expect-error Operator has no system-generated recovery path.
recipientForProblem('operator');
