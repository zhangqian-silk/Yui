import assert from "node:assert/strict";
import test from "node:test";

import { runAgentCommand } from "../dist/commands/agentCommands.js";
import { FileTaskStore } from "../dist/storage/taskStore.js";

test("agent add infers a supported adapter from the Agent id", () => {
  const store = FileTaskStore.createEphemeralWorkspace("taskmux-agent-adapter-default-");
  try {
    assert.match(
      runAgentCommand(["add", "codex", "--command", "codex-wrapper"], store),
      /Added agent codex/
    );
    assert.equal(store.getConfiguredAgent("codex").adapterId, "codex");
  } finally {
    store.disposeEphemeralWorkspace();
  }
});

test("agent add still requires an adapter for a custom Agent id", () => {
  const store = FileTaskStore.createEphemeralWorkspace("taskmux-agent-adapter-required-");
  try {
    assert.throws(
      () => runAgentCommand(["add", "reviewer", "--command", "codex-wrapper"], store),
      /--adapter is required/
    );
  } finally {
    store.disposeEphemeralWorkspace();
  }
});
