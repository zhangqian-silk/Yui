import assert from "node:assert/strict";
import { once } from "node:events";
import test from "node:test";

import {
  createYuiWebServer,
  parseWebCommandOptions
} from "../../dist/web/webServer.js";

const now = new Date("2026-07-23T08:00:00.000Z");

function fixtureStore() {
  const tasks = [
    {
      schemaVersion: 1,
      id: "task-1",
      title: "Ship web dashboard",
      description: "Make task state visible without replacing the CLI.",
      priority: "high",
      tags: ["web", "release"],
      status: "active",
      createdAt: "2026-07-22T08:00:00.000Z",
      updatedAt: "2026-07-23T07:30:00.000Z"
    },
    {
      schemaVersion: 1,
      id: "task-2",
      title: "Document release",
      status: "completed",
      completionSummary: "Published the guide.",
      completedAt: "2026-07-23T06:00:00.000Z",
      completedBy: "leader",
      createdAt: "2026-07-21T08:00:00.000Z",
      updatedAt: "2026-07-23T06:00:00.000Z"
    }
  ];
  return {
    transaction(execute) { return execute(this); },
    listTasks() { return structuredClone(tasks); },
    getTask(id) { return structuredClone(tasks.find((task) => task.id === id) ?? null); },
    getTaskBrief(taskId) {
      return taskId === "task-1" ? {
        schemaVersion: 1,
        taskId,
        objective: "Deliver the web dashboard.",
        boundaries: ["Read-only"],
        currentFocus: "HTTP surface",
        leaderSummary: "Implementation underway.",
        updatedAt: "2026-07-23T07:20:00.000Z",
        updatedBy: "leader"
      } : null;
    },
    listRoles(taskId) {
      return taskId === "task-1" ? [{ name: "leader", status: "running", activeAgentId: "codex" }] : [];
    },
    listWorkItems(taskId) {
      return taskId === "task-1" ? [
        { id: "work-1", title: "Build API", assignee: "leader", status: "running", updatedAt: "2026-07-23T07:25:00.000Z" },
        { id: "work-2", title: "Write docs", assignee: "leader", status: "pending", updatedAt: "2026-07-23T07:10:00.000Z" }
      ] : [];
    },
    listAgentRuns(taskId) {
      return taskId === "task-1" ? [{
        id: "run-1",
        taskId,
        roleName: "leader",
        mode: "resume",
        input: "Finish the dashboard.",
        status: "yielded",
        summary: "Dashboard verified.",
        updatedAt: "2026-07-23T07:28:00.000Z"
      }] : [];
    },
    listInputRequests(taskId) {
      return taskId === "task-1" ? [{ id: "input-1", status: "open", question: "Choose a port", createdAt: "2026-07-23T07:00:00.000Z" }] : [];
    },
    listMessages(taskId) {
      return taskId === "task-1" ? [{
        id: "message-1",
        kind: "role-result",
        author: { type: "role", roleName: "leader" },
        body: "Dashboard verified.",
        createdAt: "2026-07-23T07:29:00.000Z"
      }] : [];
    },
    listDecisions(taskId) {
      return taskId === "task-1" ? [{
        id: "decision-1",
        taskId,
        title: "Keep it read-only",
        rationale: "FileTaskStore remains authoritative.",
        status: "active",
        updatedAt: "2026-07-23T07:15:00.000Z"
      }] : [];
    },
    listMilestones(taskId) {
      return taskId === "task-1" ? [{
        id: "milestone-1",
        taskId,
        title: "Dashboard verified",
        summary: "Browser checks pass.",
        createdAt: "2026-07-23T07:30:00.000Z"
      }] : [];
    }
  };
}

async function withServer(run) {
  const server = createYuiWebServer(fixtureStore(), { now: () => now });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address === "object");
  try {
    await run(`http://127.0.0.1:${address.port}`);
  } finally {
    server.close();
    await once(server, "close");
  }
}

test("web options default to a safe loopback listener and validate the port", () => {
  assert.deepEqual(parseWebCommandOptions([]), { host: "127.0.0.1", port: 4173 });
  assert.deepEqual(parseWebCommandOptions(["--port", "8090"]), { host: "127.0.0.1", port: 8090 });
  assert.throws(() => parseWebCommandOptions(["--host", "0.0.0.0"]), /loopback/i);
  assert.throws(() => parseWebCommandOptions(["--port", "0"]), /between 1 and 65535/i);
  assert.throws(() => parseWebCommandOptions(["--wat"]), /Web usage/);
});

test("dashboard API summarizes tasks and exposes one consolidated task detail", async () => {
  await withServer(async (origin) => {
    const dashboardResponse = await fetch(`${origin}/api/dashboard`);
    assert.equal(dashboardResponse.status, 200);
    assert.equal(dashboardResponse.headers.get("cache-control"), "no-store");
    assert.equal(dashboardResponse.headers.get("x-content-type-options"), "nosniff");
    const dashboard = await dashboardResponse.json();
    assert.equal(dashboard.generatedAt, now.toISOString());
    assert.deepEqual(dashboard.counts, { total: 2, draft: 0, active: 1, completed: 1, archived: 0, openInputs: 1 });
    assert.equal(dashboard.tasks[0].id, "task-1");
    assert.deepEqual(dashboard.tasks[0].workItems, { total: 2, pending: 1, running: 1, completed: 0, failed: 0 });

    const detailResponse = await fetch(`${origin}/api/tasks/task-1`);
    assert.equal(detailResponse.status, 200);
    const detail = await detailResponse.json();
    assert.equal(detail.task.title, "Ship web dashboard");
    assert.equal(detail.brief.objective, "Deliver the web dashboard.");
    assert.equal(detail.roles[0].status, "running");
    assert.equal(detail.openInputs[0].question, "Choose a port");
    assert.equal(detail.runs[0].summary, "Dashboard verified.");
    assert.equal(detail.messages[0].author.roleName, "leader");
    assert.equal(detail.decisions[0].title, "Keep it read-only");
    assert.equal(detail.milestones[0].title, "Dashboard verified");
  });
});

test("web server serves the application shell and rejects unsupported routes and methods", async () => {
  await withServer(async (origin) => {
    const shell = await fetch(origin);
    assert.equal(shell.status, 200);
    assert.match(shell.headers.get("content-type"), /^text\/html/);
    assert.match(await shell.text(), /Yui Control Room/);

    const missingTask = await fetch(`${origin}/api/tasks/task-404`);
    assert.equal(missingTask.status, 404);
    assert.deepEqual(await missingTask.json(), { error: "Task not found." });

    const missingRoute = await fetch(`${origin}/api/nope`);
    assert.equal(missingRoute.status, 404);
    assert.deepEqual(await missingRoute.json(), { error: "Not found." });

    const mutation = await fetch(`${origin}/api/dashboard`, { method: "POST" });
    assert.equal(mutation.status, 405);
    assert.equal(mutation.headers.get("allow"), "GET, HEAD");
  });
});

test("web shell composes modular i18n, theme, layout, and client assets", async () => {
  await withServer(async (origin) => {
    const shell = await fetch(origin).then((response) => response.text());
    assert.match(shell, /id="locale-select"/);
    assert.match(shell, /id="theme-select"/);
    assert.match(shell, /data-i18n="page\.title"/);

    const assets = [
      ["/assets/css/tokens.css", "text/css"],
      ["/assets/css/layout.css", "text/css"],
      ["/assets/css/components.css", "text/css"],
      ["/assets/css/responsive.css", "text/css"],
      ["/assets/js/i18n.js", "text/javascript"],
      ["/assets/js/theme.js", "text/javascript"],
      ["/assets/js/view.js", "text/javascript"],
      ["/assets/app.js", "text/javascript"]
    ];
    for (const [path, contentType] of assets) {
      const response = await fetch(`${origin}${path}`);
      assert.equal(response.status, 200, path);
      assert.match(response.headers.get("content-type"), new RegExp(`^${contentType}`), path);
      assert.ok((await response.text()).length > 40, path);
    }

    const i18n = await fetch(`${origin}/assets/js/i18n.js`).then((response) => response.text());
    assert.match(i18n, /"en"/);
    assert.match(i18n, /"zh-CN"/);
    const tokens = await fetch(`${origin}/assets/css/tokens.css`).then((response) => response.text());
    assert.match(tokens, /data-theme="control-room"/);
    assert.match(tokens, /data-theme="paper"/);
  });
});
