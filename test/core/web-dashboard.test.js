import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { get } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import WebSocket from "ws";

import {
  createYuiWebServer,
  parseWebCommandOptions
} from "../../dist/web/webServer.js";

const now = new Date("2026-07-23T08:00:00.000Z");

function effectiveLaunch() {
  return {
    schemaVersion: 1,
    provenance: "resolved",
    sourceDesiredRevision: 2,
    agentId: "codex",
    adapterId: "codex",
    model: "gpt-5.6-sol",
    effort: "max",
    access: "read",
    yolo: false,
    search: false,
    permission: { sandbox: "read-only", approval: "never" },
    writeProjectIds: [],
    workspace: { root: "/tasks/task-1", entries: [] },
    context: {}
  };
}

function fixtureStore() {
  const tasks = [
    {
      schemaVersion: 2,
      id: "task-1",
      title: "Ship web dashboard",
      description: "Make task state visible without replacing the CLI.",
      priority: "high",
      tags: ["web", "release"],
      projectBindings: [{
        projectId: "project-1",
        directory: "fixture",
        baseRef: "master"
      }],
      status: "active",
      createdAt: "2026-07-22T08:00:00.000Z",
      updatedAt: "2026-07-23T07:30:00.000Z"
    },
    {
      schemaVersion: 2,
      id: "task-2",
      title: "Document release",
      projectBindings: [],
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
    listProjects() {
      return [{
        schemaVersion: 2,
        id: "project-1",
        name: "Yui Web",
        aliases: [],
        path: "/repos/yui",
        stableBranch: "master",
        developmentBranch: "develop",
        knowledge: [],
        createdAt: "2026-07-01T08:00:00.000Z",
        updatedAt: "2026-07-01T08:00:00.000Z"
      }];
    },
    getTaskBrief(taskId) {
      return taskId === "task-1" ? {
        schemaVersion: 2,
        taskId,
        objective: "Deliver the web dashboard.",
        boundaries: ["Read-only"],
        technicalApproach: "Expose the Task read model without duplicating its authority.",
        currentFocus: "HTTP surface",
        leaderSummary: "Implementation underway.",
        updatedAt: "2026-07-23T07:20:00.000Z",
        updatedBy: "leader"
      } : null;
    },
    listRoles(taskId) {
      return taskId === "task-1" ? [{
        schemaVersion: 3,
        taskId,
        name: "leader",
        status: "running",
        launchRevision: 3,
        defaultAccess: "write",
        activeAgentId: "codex",
        agentBindings: {
          codex: {
            agentId: "codex",
            adapterId: "codex",
            config: { adapterId: "codex", model: "gpt-5.6-sol", effort: "max" }
          }
        },
        workspace: "/tasks/task-1",
        createdAt: "2026-07-22T08:00:00.000Z",
        updatedAt: "2026-07-23T07:30:00.000Z"
      }] : [];
    },
    getTaskRoleSessionSet(taskId, roleName) {
      return taskId === "task-1" && roleName === "leader" ? {
        schemaVersion: 2,
        owner: { scope: "task", taskId, roleName },
        activeAgentId: "codex",
        sessions: {
          codex: {
            schemaVersion: 3,
            agentId: "codex",
            adapterId: "codex",
            nativeSessionId: "thread-1",
            policy: "fixed",
            effective: effectiveLaunch(),
            status: "ready",
            recentCompletedTurnIds: [],
            createdAt: "2026-07-23T07:00:00.000Z",
            updatedAt: "2026-07-23T07:30:00.000Z"
          }
        },
        inFlight: null,
        pendingTurnCompletion: null,
        updatedAt: "2026-07-23T07:30:00.000Z"
      } : null;
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
        purpose: "execution",
        effective: effectiveLaunch(),
        input: "Finish the dashboard.",
        status: "yielded",
        summary: "Dashboard verified.",
        updatedAt: "2026-07-23T07:28:00.000Z"
      }] : [];
    },
    listReviewRounds(taskId) {
      return taskId === "task-1" ? [{
        schemaVersion: 2,
        id: "review-round-1",
        taskId,
        workItemId: "work-1",
        candidateId: "candidate-1",
        reviewerRoleName: "reviewer",
        reviewBaseProvenance: "frozen-candidate",
        reviewBaseCommit: "a".repeat(40),
        requestedBy: "leader",
        status: "completed",
        summary: "No material findings.",
        checks: [{ name: "npm test", outcome: "passed" }],
        evidenceCommit: "b".repeat(40),
        createdAt: "2026-07-23T07:20:00.000Z",
        endedAt: "2026-07-23T07:27:00.000Z"
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

async function withServer(run, dependencies = {}) {
  const server = createYuiWebServer(fixtureStore(), {
    now: () => now,
    ...dependencies
  });
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

function requestWithHost(origin, host, path = "/") {
  const url = new URL(origin);
  return new Promise((resolve, reject) => {
    const request = get({
      hostname: url.hostname,
      port: url.port,
      path,
      headers: { host }
    }, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () => resolve({
        status: response.statusCode,
        body: Buffer.concat(chunks).toString("utf8")
      }));
    });
    request.on("error", reject);
  });
}

test("web options default to a safe loopback listener and validate the port", () => {
  assert.deepEqual(parseWebCommandOptions([]), { host: "127.0.0.1", port: 4173 });
  assert.deepEqual(parseWebCommandOptions(["--port", "8090"]), { host: "127.0.0.1", port: 8090 });
  assert.throws(() => parseWebCommandOptions(["--host", "0.0.0.0"]), /loopback/i);
  assert.throws(() => parseWebCommandOptions(["--port", "0"]), /between 1 and 65535/i);
  assert.throws(() => parseWebCommandOptions(["--wat"]), /Web usage/);
});

test("web rejects a non-loopback Host before exposing its token or terminal", async () => {
  let opened = 0;
  await withServer(async (origin) => {
    const port = new URL(origin).port;
    for (const loopbackHost of [`localhost:${port}`, `[::1]:${port}`]) {
      assert.equal((await requestWithHost(origin, loopbackHost)).status, 200);
    }
    const hostileHost = `evil.example:${port}`;
    const page = await requestWithHost(origin, hostileHost);
    assert.equal(page.status, 403);
    assert.doesNotMatch(page.body, /yui-web-token/u);

    const socket = new WebSocket(
      `${origin.replace(/^http/u, "ws")}/api/terminal?scope=global&role=operator&cols=80&rows=24&token=test-token`,
      {
        origin: `http://${hostileHost}`,
        headers: { host: hostileHost }
      }
    );
    const status = await new Promise((resolve, reject) => {
      socket.once("open", () => reject(new Error("Hostile terminal unexpectedly opened.")));
      socket.once("error", () => {});
      socket.once("unexpected-response", (_request, response) => {
        response.resume();
        resolve(response.statusCode);
      });
    });
    assert.equal(status, 403);
  }, {
    token: "test-token",
    terminal: {
      async open() {
        opened += 1;
        throw new Error("terminal should not open");
      }
    }
  });
  assert.equal(opened, 0);
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
    assert.deepEqual(dashboard.tasks[0].projectNames, ["Yui Web"]);
    assert.deepEqual(dashboard.tasks[0].workItems, { total: 2, pending: 1, running: 1, completed: 0, failed: 0 });

    const detailResponse = await fetch(`${origin}/api/tasks/task-1`);
    assert.equal(detailResponse.status, 200);
    const detail = await detailResponse.json();
    assert.equal(detail.task.title, "Ship web dashboard");
    assert.deepEqual(detail.task.projectNames, ["Yui Web"]);
    assert.equal(detail.brief.objective, "Deliver the web dashboard.");
    assert.match(detail.brief.technicalApproach, /Task read model/);
    assert.equal(detail.roles[0].status, "running");
    assert.equal(detail.roles[0].effectiveLaunch.sourceDesiredRevision, 2);
    assert.equal(detail.roles[0].launchDrift, true);
    assert.equal(detail.openInputs[0].question, "Choose a port");
    assert.equal(detail.runs[0].summary, "Dashboard verified.");
    assert.equal(detail.runs[0].effective.access, "read");
    assert.equal(detail.reviewRounds[0].reviewBaseCommit, "a".repeat(40));
    assert.equal(detail.reviewRounds[0].evidenceCommit, "b".repeat(40));
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

test("web input answers require the page token and use the durable mutation port", async () => {
  const calls = [];
  await withServer(async (origin) => {
    const body = JSON.stringify({ choiceKey: "csv" });
    const rejected = await fetch(`${origin}/api/tasks/task-1/inputs/input-1/answer`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body
    });
    assert.equal(rejected.status, 403);

    const answered = await fetch(`${origin}/api/tasks/task-1/inputs/input-1/answer`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-yui-web-token": "test-token"
      },
      body
    });
    assert.equal(answered.status, 200);
    assert.deepEqual(await answered.json(), {
      request: { id: "input-1", taskId: "task-1", status: "answered" }
    });
  }, {
    token: "test-token",
    async answerInput(input) {
      calls.push(input);
      return { id: input.inputId, taskId: input.taskId, status: "answered" };
    }
  });

  assert.deepEqual(calls, [{
    taskId: "task-1",
    inputId: "input-1",
    answer: { choiceKey: "csv" }
  }]);
});

test("web terminal upgrades to one injected PTY bridge and detaches it on close", async () => {
  const events = {
    writes: [],
    resizes: [],
    closed: 0,
    data: undefined,
    exit: undefined
  };
  const terminal = {
    async open(request) {
      assert.deepEqual(request, {
        scope: "task",
        taskId: "task-1",
        roleName: "leader",
        columns: 100,
        rows: 30
      });
      return {
        readOnly: false,
        history: { limit: 2_000, target: 100_000 },
        onData(listener) {
          events.data = listener;
          return () => { events.data = undefined; };
        },
        onExit(listener) {
          events.exit = listener;
          return () => { events.exit = undefined; };
        },
        write(data) { events.writes.push(data); },
        resize(columns, rows) { events.resizes.push([columns, rows]); },
        close() { events.closed += 1; }
      };
    }
  };

  await withServer(async (origin) => {
    const wsOrigin = origin.replace(/^http/, "ws");
    const socket = new WebSocket(
      `${wsOrigin}/api/terminal?scope=task&task=task-1&role=leader&cols=100&rows=30&token=test-token`,
      { origin }
    );
    const messages = [];
    socket.on("message", (payload) => messages.push(JSON.parse(String(payload))));
    await once(socket, "open");
    while (messages.length === 0) await once(socket, "message");
    assert.deepEqual(messages.shift(), {
      type: "ready",
      readOnly: false,
      history: { limit: 2_000, target: 100_000 }
    });

    events.data("native output");
    while (messages.length === 0) await once(socket, "message");
    assert.deepEqual(messages.shift(), { type: "data", data: "native output" });

    socket.send(JSON.stringify({ type: "input", data: "/status\r" }));
    socket.send(JSON.stringify({ type: "resize", columns: 120, rows: 40 }));
    while (events.writes.length === 0 || events.resizes.length === 0) {
      await new Promise((resolve) => setImmediate(resolve));
    }
    assert.deepEqual(events.writes, ["/status\r"]);
    assert.deepEqual(events.resizes, [[120, 40]]);

    socket.close();
    await once(socket, "close");
  }, { token: "test-token", terminal });

  assert.equal(events.closed, 1);
});

test("web terminal closes cleanly when the PTY exited before subscriptions attach", async () => {
  let closed = 0;
  const terminal = {
    async open() {
      return {
        readOnly: false,
        onData() { return () => {}; },
        onExit(listener) {
          listener({ exitCode: 9 });
          return () => {};
        },
        write() {},
        resize() {},
        close() { closed += 1; }
      };
    }
  };

  await withServer(async (origin) => {
    const socket = new WebSocket(
      `${origin.replace(/^http/, "ws")}/api/terminal?scope=global&role=operator&cols=80&rows=24&token=test-token`,
      { origin }
    );
    const messages = [];
    socket.on("message", (payload) => messages.push(JSON.parse(String(payload))));
    await once(socket, "close");
    assert.deepEqual(messages, [{ type: "exit", exitCode: 9 }]);
  }, { token: "test-token", terminal });

  assert.equal(closed, 1);
});

test("web terminal closes a late PTY when the browser disconnects during Role startup", async () => {
  let resolveOpen;
  const pendingOpen = new Promise((resolve) => {
    resolveOpen = resolve;
  });
  let closed = 0;
  const terminal = {
    async open() { return pendingOpen; }
  };

  await withServer(async (origin) => {
    const socket = new WebSocket(
      `${origin.replace(/^http/, "ws")}/api/terminal?scope=global&role=operator&cols=80&rows=24&token=test-token`,
      { origin }
    );
    await once(socket, "open");
    socket.close();
    await once(socket, "close");
    resolveOpen({
      readOnly: false,
      onData() { return () => {}; },
      onExit() { return () => {}; },
      write() {},
      resize() {},
      close() { closed += 1; }
    });
    await new Promise((resolve) => setImmediate(resolve));
  }, { token: "test-token", terminal });

  assert.equal(closed, 1);
});

test("web shell composes modular i18n, theme, layout, and client assets", async () => {
  await withServer(async (origin) => {
    const shell = await fetch(origin).then((response) => response.text());
    assert.match(shell, /id="locale-select"/);
    assert.match(shell, /id="theme-select"/);
    assert.match(shell, /id="operator-terminal"/);
    assert.match(shell, /id="terminal-panel"/);
    assert.match(shell, /name="yui-web-token" content="[^"]+"/);
    assert.doesNotMatch(shell, /__YUI_WEB_TOKEN__/);
    assert.match(shell, /data-i18n="page\.title"/);

    const assets = [
      ["/assets/css/tokens.css", "text/css"],
      ["/assets/css/layout.css", "text/css"],
      ["/assets/css/components.css", "text/css"],
      ["/assets/css/responsive.css", "text/css"],
      ["/assets/js/i18n.js", "text/javascript"],
      ["/assets/js/theme.js", "text/javascript"],
      ["/assets/js/view.js", "text/javascript"],
      ["/assets/app.js", "text/javascript"],
      ["/assets/vendor/xterm.mjs", "text/javascript"],
      ["/assets/vendor/addon-fit.mjs", "text/javascript"],
      ["/assets/vendor/xterm.css", "text/css"]
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

    const scripts = [
      ["/assets/app.js", "app.mjs"],
      ["/assets/js/view.js", "view.mjs"]
    ];
    const directory = mkdtempSync(join(tmpdir(), "yui-web-syntax-"));
    try {
      for (const [path, filename] of scripts) {
        writeFileSync(join(directory, filename), await fetch(`${origin}${path}`).then((response) => response.text()));
        const checked = spawnSync(process.execPath, ["--check", join(directory, filename)], {
          encoding: "utf8"
        });
        assert.equal(checked.status, 0, checked.stderr);
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
