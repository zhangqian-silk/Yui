import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  CodexAppServerAttemptExecutor,
  parseAttemptResult
} from "../../dist/execution/codexAppServerExecutor.js";
import { createAgentProfile } from "../../dist/profile/agentProfile.js";
import { loadYuiSkillContexts } from "../../dist/context/roleSessionContext.js";

test("Codex App Server driver forks the Leader thread and captures only structured result plus provider IDs", async () => {
  const root = mkdtempSync(join(tmpdir(), "yui-app-server-"));
  const command = join(root, "fake-codex");
  const skillPath = join(root, "skills", "source-review");
  mkdirSync(skillPath, { recursive: true });
  writeFileSync(join(skillPath, "SKILL.md"), "# Source review\n");
  writeFileSync(command, `#!${process.execPath}
const readline = require("node:readline");
const lines = readline.createInterface({ input: process.stdin });
function send(value) { process.stdout.write(JSON.stringify(value) + "\\n"); }
lines.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") {
    send({ id: message.id, result: { userAgent: "fake", codexHome: "/tmp", platformFamily: "unix", platformOs: "linux" } });
  } else if (message.method === "thread/fork") {
    if (message.params.threadId !== "leader-thread") process.exit(2);
    if (message.params.cwd !== ${JSON.stringify(root)}) process.exit(3);
    if ("deferGoalContinuation" in message.params) process.exit(7);
    if (!message.params.developerInstructions.includes("Inspect source evidence.")) process.exit(5);
    if (!message.params.developerInstructions.includes(${JSON.stringify(join(skillPath, "SKILL.md"))})) process.exit(6);
    send({ id: message.id, result: {
      thread: { id: "child-thread", sessionId: "session-tree" },
      model: "fake", modelProvider: "fake", cwd: ${JSON.stringify(root)}
    } });
  } else if (message.method === "turn/start") {
    if (message.params.sandboxPolicy.type !== "readOnly") process.exit(4);
    const prompt = message.params.input[0].text;
    if (!prompt.includes("Follow the Profile instruction sentinel.")) process.exit(8);
    if (!prompt.includes(${JSON.stringify(join(skillPath, "SKILL.md"))})) process.exit(9);
    send({ id: message.id, result: { turn: { id: "turn-1" } } });
    send({ method: "turn/completed", params: {
      threadId: "child-thread",
      turn: {
        id: "turn-1",
        status: "completed",
        error: null,
        items: [{ type: "agentMessage", id: "message-1", text: JSON.stringify({
          summary: "Inspected the requested source.",
          checks: [{ name: "read", outcome: "passed" }]
        }) }]
      }
    } });
  }
});
`);
  chmodSync(command, 0o700);
  const profile = createAgentProfile({
    id: "explorer",
    agentId: "codex",
    description: "Inspect source evidence.",
    instructions: "Follow the Profile instruction sentinel.",
    skills: ["source-review"],
    defaultAccess: "read"
  }, new Date("2026-07-26T00:00:00.000Z"));
  let started;
  const response = await new CodexAppServerAttemptExecutor(command, process.env).execute({
    executor: "fork",
    input: "Inspect source.",
    cwd: root,
    access: "read",
    profile,
    skills: loadYuiSkillContexts(root, ["yui-worker", "source-review"]),
    parentThreadId: "leader-thread"
  }, (ref) => { started = ref; });

  assert.deepEqual(started, {
    sessionId: "session-tree",
    threadId: "child-thread",
    turnId: "turn-1"
  });
  assert.deepEqual(response, {
    providerRef: started,
    result: {
      summary: "Inspected the requested source.",
      checks: [{ name: "read", outcome: "passed" }]
    }
  });
});

test("Attempt result parsing rejects plain text and malformed checks", () => {
  assert.throws(
    () => parseAttemptResult("looks successful"),
    /not valid JSON/
  );
  assert.throws(
    () => parseAttemptResult(JSON.stringify({
      summary: "looks successful",
      checks: "passed"
    })),
    /checks must be an array/
  );
  assert.throws(
    () => parseAttemptResult(JSON.stringify({
      summary: "looks successful",
      checks: [{ name: "", outcome: "passed" }]
    })),
    /Attempt check is invalid/
  );
});

test("a second CLI connection interrupts the active turn through its shared control socket", async () => {
  const root = mkdtempSync(join(tmpdir(), "yui-app-server-interrupt-"));
  const command = join(root, "fake-codex");
  const socketPath = join(root, "attempt.sock");
  writeFileSync(command, `#!${process.execPath}
const net = require("node:net");
const readline = require("node:readline");
const args = process.argv.slice(2);
function send(stream, value) { stream.write(JSON.stringify(value) + "\\n"); }
if (args.includes("--listen")) {
  const url = args[args.indexOf("--listen") + 1];
  const path = url.slice("unix://".length);
  let turnSocket;
  const server = net.createServer((socket) => {
    const lines = readline.createInterface({ input: socket });
    lines.on("line", (line) => {
      const message = JSON.parse(line);
      if (message.method === "initialize") {
        send(socket, { id: message.id, result: {
          userAgent: "fake", codexHome: "/tmp", platformFamily: "unix", platformOs: "linux"
        } });
      } else if (message.method === "thread/start") {
        send(socket, { id: message.id, result: {
          thread: { id: "thread-1", sessionId: "session-1" }
        } });
      } else if (message.method === "turn/start") {
        turnSocket = socket;
        send(socket, { id: message.id, result: { turn: { id: "turn-1" } } });
      } else if (message.method === "turn/interrupt") {
        send(socket, { id: message.id, result: {} });
        send(turnSocket, { method: "turn/completed", params: {
          threadId: "thread-1",
          turn: { id: "turn-1", status: "interrupted", error: null, items: [] }
        } });
      }
    });
  });
  server.listen(path);
} else if (args.includes("proxy")) {
  const path = args[args.indexOf("--sock") + 1];
  const socket = net.connect(path);
  process.stdin.pipe(socket);
  socket.pipe(process.stdout);
}
`);
  chmodSync(command, 0o700);
  const profile = createAgentProfile({
    id: "worker",
    agentId: "codex",
    defaultAccess: "read"
  }, new Date("2026-07-26T00:00:00.000Z"));
  let markStarted;
  const started = new Promise((resolve) => { markStarted = resolve; });
  const executor = new CodexAppServerAttemptExecutor(command, process.env);
  const execution = executor.execute({
    executor: "session",
    input: "Wait for interruption.",
    cwd: root,
    access: "read",
    profile,
    skills: loadYuiSkillContexts(root, ["yui-worker"]),
    controlSocketPath: socketPath
  }, (providerRef) => { markStarted(providerRef); });
  const providerRef = await started;
  const interrupted = assert.rejects(execution, /Codex turn interrupted/);

  await new CodexAppServerAttemptExecutor(command, process.env).interrupt(
    providerRef.threadId,
    providerRef.turnId,
    socketPath
  );
  await interrupted;
});
