import assert from "node:assert/strict";
import test from "node:test";

import {
  createPromptEnvelope,
  createRuntimeBinding,
  createSessionLaunchRequest
} from "../../dist/runtime/index.js";

const NOW = new Date("2026-07-22T08:00:00.000Z");

test("runtime values retain only portable identities and an opaque host reference", () => {
  const owner = { scope: "task", taskId: " task-1 ", roleName: " leader " };
  const binding = createRuntimeBinding({
    id: " runtime-1 ",
    launchId: " launch-1 ",
    owner,
    agentId: " codex-personal ",
    adapterId: " codex ",
    hostRef: " host-session-1 ",
    nativeSessionId: " thread-1 "
  });

  assert.deepEqual(binding, {
    id: "runtime-1",
    launchId: "launch-1",
    owner: { scope: "task", taskId: "task-1", roleName: "leader" },
    agentId: "codex-personal",
    adapterId: "codex",
    hostRef: "host-session-1",
    nativeSessionId: "thread-1"
  });
  assert.notEqual(binding.owner, owner);
});

test("session launch requests distinguish fresh and resumable native sessions without a bootstrap prompt", () => {
  const fresh = createSessionLaunchRequest({
    mode: "new",
    launchId: "launch-1",
    owner: { scope: "global", roleName: "operator" },
    agentId: "codex-personal",
    adapterId: "codex",
    workspace: " /repo "
  });
  const resumed = createSessionLaunchRequest({
    mode: "resume",
    launchId: "launch-2",
    owner: { scope: "task", taskId: "task-1", roleName: "leader" },
    agentId: "codex-personal",
    adapterId: "codex",
    workspace: "/repo",
    nativeSessionId: " thread-1 "
  });

  assert.equal(fresh.workspace, "/repo");
  assert.equal("initialPrompt" in fresh, false);
  assert.equal("nativeSessionId" in fresh, false);
  assert.equal(resumed.mode, "resume");
  assert.equal(resumed.nativeSessionId, "thread-1");
});

test("prompt envelopes preserve delivery identity while copying their source", () => {
  const source = { kind: "input-request", taskId: " task-1 ", localId: "input-1" };
  const envelope = createPromptEnvelope({
    id: "input-request:task-1/input-1",
    source,
    text: " Choose a database. ",
    createdAt: NOW
  });

  assert.deepEqual(envelope, {
    id: "input-request:task-1/input-1",
    source: { kind: "input-request", taskId: "task-1", localId: "input-1" },
    text: "Choose a database.",
    createdAt: NOW.toISOString()
  });
  assert.notEqual(envelope.source, source);

  assert.throws(
    () => createPromptEnvelope({
      id: "prompt-1",
      source,
      text: "Choose a database.",
      createdAt: NOW
    }),
    /does not match its source/u
  );
  assert.throws(
    () => createPromptEnvelope({
      id: "input-request:task-2/input-1",
      source,
      text: "Choose a database.",
      createdAt: NOW
    }),
    /does not match its source/u
  );
});

test("runtime constructors reject ambiguous or unsafe identities", () => {
  assert.throws(
    () => createSessionLaunchRequest({
      mode: "resume",
      launchId: "launch-1",
      owner: { scope: "task", taskId: "task-1", roleName: "leader" },
      agentId: "codex",
      adapterId: "codex",
      workspace: "/repo",
      nativeSessionId: " "
    }),
    /Native session id is required/u
  );
  assert.throws(
    () => createRuntimeBinding({
      id: "runtime/1",
      launchId: "launch-1",
      owner: { scope: "global", roleName: "operator" },
      agentId: "codex",
      adapterId: "codex",
      hostRef: "host-1"
    }),
    /Runtime binding id is invalid/u
  );
  assert.throws(
    () => createPromptEnvelope({
      id: "prompt-1",
      source: { kind: "unknown", taskId: "task-1", localId: "source-1" },
      text: "Prompt",
      createdAt: NOW
    }),
    /Prompt source kind is invalid/u
  );
});
