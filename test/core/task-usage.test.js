import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { projectTaskUsageMetrics } from "../../dist/runtime/taskUsageMetrics.js";
import { projectSessionTokenMetrics } from "../../dist/runtime/sessionTokenMetrics.js";
import { createRuntimeObservation, runtimeObservationTaskEventPayload } from "../../dist/runtime/runtimeObservation.js";
import { buildTaskObservabilityProjection } from "../../dist/scheduler/taskObservabilityProjection.js";
import { runExecutionAudit } from "../../dist/observability/executionAudit.js";
import { renderExecutionAudit } from "../../dist/commands/executionAuditCommands.js";
import { COMPONENTS_SCRIPT } from "../../dist/web/assets/client/components.js";

const origin = Date.parse("2026-09-13T00:00:00Z");
const at = seconds => new Date(origin + seconds * 1000).toISOString();
const task = { id: "task-1", status: "completed", createdAt: at(0), completedAt: at(30) };
let sequence = 0;
function event(kind, seconds, payload = {}, fence = {}) {
  const observation = createRuntimeObservation({
    schemaVersion: 4, eventId: `fixture-${++sequence}`, semanticKey: `fixture-${sequence}`,
    kind, authority: "provider-structured", receivedAt: at(seconds), observedAt: at(seconds),
    fence: { taskId: task.id, roleName: "leader", agentId: "codex",
      driverId: "openai/codex", nativeSessionId: "session-1", nativeTurnId: "turn-1", ...fence },
    payload
  });
  return { schemaVersion: 2, id: `event-${sequence}`, taskId: observation.fence.taskId,
    type: "runtime.observation", createdAt: at(seconds),
    payload: runtimeObservationTaskEventPayload(observation) };
}
const usage = (semantics, inputTokens, outputTokens = 0) => ({ semantics, inputTokens, outputTokens });
const token = (seconds, value, fence = {}, extra = {}) =>
  event("activity.observed", seconds, { activity: "model", usage: value, ...extra }, fence);
const project = (events, extra = {}) => projectTaskUsageMetrics({
  task, events, runs: [], now: new Date(at(30)), ...extra
});

test("Task usage preserves known zero, unknown history, replacements and exact request identity", () => {
  assert.equal(project([]).tokens.value, null);
  assert.equal(project([]).toolCalls.value, null);
  assert.equal(project([]).elapsedSeconds.value, 30, "direct Leader needs no Group or Run");
  const zero = token(1, usage("request-context", 0), {}, { activityId: "request-1" });
  assert.deepEqual([project([zero]).tokens.status, project([zero]).tokens.value], ["known", 0]);
  const events = [
    zero,
    token(2, usage("request-context", 12, 3), {}, { activityId: "request-1" }),
    token(3, usage("request-context", 12, 3), {}, { activityId: "request-1" }),
    token(4, usage("request-context", 5), { nativeSessionId: "replacement" }, { activityId: "request-1" }),
    token(5, usage("request-context", 999), { taskId: "task-2" }, { activityId: "request-1" })
  ];
  assert.equal(project(events).tokens.value, 20);
  assert.equal(project(events).sessions.length, 2);
  assert.deepEqual(project([...events].reverse()), project(events), "arrival order does not change the projection");
  const unknown = event("session.started", 6, {}, { nativeSessionId: "unobserved" });
  assert.equal(project([zero, unknown]).tokens.status, "partial");
  assert.equal(project([zero, unknown]).tokens.value, 0);
});

test("cumulative baselines never become request allocations or include pre-Task consumption", () => {
  const cumulative = [
    token(1, usage("cumulative-session", 100)),
    token(2, usage("cumulative-session", 150, 10)),
    token(3, usage("cumulative-session", 150, 10))
  ];
  assert.equal(project(cumulative).tokens.value, 60);
  assert.equal(project(cumulative).tokens.status, "partial", "nonzero first snapshot is an excluded baseline");
  assert.equal(project(cumulative.slice(0, 1)).tokens.value, null);
  assert.equal(project([
    token(0, usage("cumulative-session", 0)), ...cumulative
  ]).tokens.value, 160);
  assert.equal(project([...cumulative, token(4, usage("cumulative-session", 3))]).tokens.value, null);
  assert.equal(project([...cumulative, token(4, usage("request-context", 3), {}, { activityId: "mixed" })]).tokens.value, null);
  assert.equal(project([token(1, usage("remaining-context", 1000))]).tokens.value, null);
  assert.equal(project(cumulative, { workItemId: "work-1" }).tokens.value, null);
});

test("WorkItem attribution requires an exact Run and never counts child mirrors twice", () => {
  const run = { id: "run-1", taskId: task.id, roleName: "worker", workItemId: "work-1",
    effective: { agentId: "codex", adapterId: "codex" } };
  const fence = { roleName: "worker", runId: "run-1", nativeSessionId: "worker-session" };
  const events = [
    token(1, usage("request-context", 20), fence, { activityId: "request-1" }),
    token(2, usage("request-context", 20), { ...fence, continuationId: "child-1" }, { activityId: "request-1" }),
    token(3, usage("request-context", 7), {}, { activityId: "direct" })
  ];
  assert.equal(project(events, { runs: [run] }).tokens.value, 27);
  assert.equal(project(events, { runs: [run] }).tokens.status, "partial");
  assert.equal(project(events, { runs: [run], workItemId: "work-1" }).tokens.value, 20);
  assert.equal(project(events, { runs: [run], workItemId: "work-1" }).sessions[0].metrics.cumulativeTotal.totalTokens, 20);
  assert.equal(project(events, { runs: [], workItemId: "work-1" }).tokens.value, null);
  const conflicting = token(4, usage("request-context", 21), { ...fence, runId: "run-2" }, { activityId: "request-1" });
  assert.equal(project([...events, conflicting], { runs: [run], workItemId: "work-1" }).tokens.value, null);
  const mirror = token(5, usage("request-context", 27), { roleName: "mirror" }, { activityId: "mirror" });
  assert.equal(project([events[2], mirror]).tokens.value, null, "shared native counter is not two independent Roles");
  assert.equal(projectSessionTokenMetrics(events.slice(0, 2), {
    taskId: task.id, roleName: fence.roleName, agentId: "codex", driverId: "openai/codex",
    nativeSessionId: fence.nativeSessionId
  }).cumulativeTotal.totalTokens, 20, "Session cards exclude child mirrors too");
  const tool = { operation: "tool", operationId: "call-1" };
  const conflictingTool = [
    event("operation.started", 6, tool, fence),
    event("operation.completed", 7, tool, { ...fence, runId: "run-2" })
  ];
  assert.equal(project(conflictingTool, { runs: [run] }).toolCalls.value, 1);
  assert.equal(project(conflictingTool, { runs: [run], workItemId: "work-1" }).toolCalls.value, null);
});

test("retained tools and native intervals are partial evidence, not Group wall clock", () => {
  const turn = { nativeTurnId: "turn-1" };
  const events = [
    event("operation.started", 1, { operation: "tool", operationId: "call-1" }, turn),
    event("operation.failed", 2, { operation: "tool", operationId: "call-1" }, turn),
    event("operation.completed", 3, { operation: "tool", operationId: "call-1" }, turn),
    event("turn.accepted", 5, {}, turn),
    event("turn.completed", 15, {}, turn),
    event("turn.accepted", 5, {}, { ...turn, roleName: "worker", nativeSessionId: "session-2" }),
    event("turn.completed", 15, {}, { ...turn, roleName: "worker", nativeSessionId: "session-2" })
  ];
  const result = project(events);
  assert.equal(result.toolCalls.value, 1);
  assert.equal(result.toolCalls.status, "partial");
  assert.equal(result.executionSeconds.value, 20);
  assert.equal(result.executionSeconds.status, "partial");
  assert.equal(result.elapsedSeconds.value, 30);
  assert.equal(project([events[3]]).executionSeconds.value, null, "missing terminal cannot run forever");
  assert.equal(project([event("turn.completed", 15, {}, turn)]).executionSeconds.value, null);
  const overlapping = [
    event("turn.accepted", 10, {}, { nativeTurnId: "turn-2" }),
    event("turn.completed", 15.125, {}, { nativeTurnId: "turn-2" })
  ];
  assert.equal(project([...events, ...overlapping]).executionSeconds.value, 20.125);
  assert.equal(project([], { task: { ...task, status: "active", completedAt: undefined } }).elapsedSeconds.value, 30);
  assert.equal(project([], { task: { ...task, status: "archived" } }).elapsedSeconds.value, 30);
  assert.equal(project([], { task: { ...task, status: "cancelled", completedAt: undefined } }).elapsedSeconds.value, null);
});

test("partial boundaries, cache subsets and diagnostic values cannot fabricate totals", () => {
  const zero = token(1, usage("request-context", 0), {}, { activityId: "request-1" });
  const missing = event("activity.observed", 2, {
    activity: "model", sourceId: "missing-request", observationQuality: "partial"
  });
  assert.equal(project([zero, missing]).tokens.value, null);
  const diagnostic = token(2, usage("request-context", 999), {}, { activityId: "diagnostic" });
  const observation = JSON.parse(diagnostic.payload.observation);
  observation.authority = "diagnostic";
  diagnostic.payload = runtimeObservationTaskEventPayload(createRuntimeObservation(observation));
  assert.equal(project([zero, diagnostic]).tokens.value, 0);
  assert.equal(projectSessionTokenMetrics([zero, diagnostic], {
    taskId: task.id, roleName: "leader", agentId: "codex", driverId: "openai/codex",
    nativeSessionId: "session-1"
  }).cumulativeTotal.totalTokens, 0);
  const subsets = token(3, { ...usage("request-context", 100, 20), cachedInputTokens: 50, reasoningTokens: 10 },
    {}, { activityId: "request-1" });
  assert.equal(project([zero, subsets]).tokens.value, 120);
  const otherSession = event("session.started", 4, {}, { nativeSessionId: "missing-tokens" });
  assert.equal(project([zero, otherSession]).tokens.status, "partial");
});

test("CLI/Web cost and audit share lifetime evidence; reads never collect or write", t => {
  const home = mkdtempSync(join(tmpdir(), "yui-usage-audit-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const events = [token(1, usage("request-context", 0), {}, { activityId: "zero" })];
  const facts = { task, workItems: [], executionGroups: [], runs: [], events, now: new Date(at(30)) };
  const cost = buildTaskObservabilityProjection(facts).cost;
  const store = {
    getHomeIdentity: () => ({ homeId: "fixture" }), listTasks: () => [task],
    getTask: id => id === task.id ? task : null, listEvents: id => id === task.id ? events : [],
    listRuns: () => []
  };
  const report = runExecutionAudit(home, { taskId: task.id, since: new Date(at(10)), until: new Date(at(20)) },
    { openStore: () => store, directorySize: () => 0 });
  assert.equal(report.usage.status, "ok");
  for (const key of ["tokens", "toolCalls", "elapsedSeconds", "executionSeconds", "coverage", "sessions"]) {
    assert.deepEqual(report.usage.data[0][key], cost[key]);
  }
  assert.match(renderExecutionAudit(report), /Task lifetime.*audit time window not applied/u);
  assert.match(renderExecutionAudit(report), /tokens=0; tools=unknown/u);

  // Execute the actual shipped DOM builder, not a parallel formatter.
  const node = (_tag, _className, text) => ({
    textContent: text == null ? "" : String(text), childNodes: [],
    append(...children) { this.childNodes.push(...children); }
  });
  const context = vm.createContext({ node, formatDateTime: value => value });
  vm.runInContext(COMPONENTS_SCRIPT.replace(/^import .*;\n/gm, "").replace(/^export /gm, ""), context);
  const translate = key => key === "detail.unobserved" ? "unknown" : key;
  const card = context.observabilityMetricCard({ cost, context: {}, dag: {} }, translate);
  const texts = element => [element.textContent, ...element.childNodes.flatMap(texts)];
  const visible = texts(card).join(" ");
  assert.match(visible, /unknown/u);
  assert.doesNotMatch(visible, /0\*|undefineds|\[object Object\]/u);
  assert.equal(context.usageMetricText(cost.tokens, translate), "0");
  assert.match(context.usageMetricText({ value: 0, status: "partial" }, translate), /0.*partial/u);
  assert.equal(events.length, 1);
});
