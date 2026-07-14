import assert from "node:assert/strict";
import test from "node:test";

import {
  listGlobalInputRequests,
  resolveGlobalInputRequest
} from "../dist/input/globalInputQuery.js";

function request(taskId, id, createdAt, status = "open") {
  return { taskId, id, createdAt, status };
}

test("global inbox is an ordered query over task-owned requests, not a duplicate durable store", () => {
  const byTask = new Map([
    ["task-b", [request("task-b", "input-2", "2026-07-14T07:40:01.000Z")]],
    ["task-a", [
      request("task-a", "input-2", "2026-07-14T07:40:00.000Z"),
      request("task-a", "input-1", "2026-07-14T07:40:00.000Z"),
      request("task-a", "closed", "2026-07-14T07:40:02.000Z", "answered")
    ]]
  ]);
  const store = {
    listTasks: () => [{ id: "task-b" }, { id: "task-a" }],
    listInputRequests: (taskId) => byTask.get(taskId) ?? [],
    getInputRequest: (taskId, requestId) =>
      (byTask.get(taskId) ?? []).find((value) => value.id === requestId) ?? null
  };

  assert.deepEqual(
    listGlobalInputRequests(store).map((value) => `${value.taskId}/${value.id}`),
    ["task-a/input-1", "task-a/input-2", "task-b/input-2"]
  );
  assert.equal(listGlobalInputRequests(store, { includeTerminal: true }).length, 4);
  assert.equal(resolveGlobalInputRequest(store, "input-1").taskId, "task-a");
  assert.throws(() => resolveGlobalInputRequest(store, "input-2"), /ambiguous/i);
  assert.equal(resolveGlobalInputRequest(store, "input-2", "task-b").taskId, "task-b");
});
