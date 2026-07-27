import assert from "node:assert/strict";
import test from "node:test";

import { resolveProfileWizardArguments } from "../../dist/cli/profileWizard.js";

function catalog() {
  return {
    source: "live",
    attemptedAt: "2026-07-27T08:00:00.000Z",
    fetchedAt: "2026-07-27T08:00:00.000Z",
    catalog: {
      schemaVersion: 1,
      agentId: "codex",
      adapterId: "codex",
      models: [
        {
          value: "gpt-default",
          label: "GPT Default",
          isDefault: true,
          defaultEffort: "medium",
          efforts: [
            { value: "medium", label: "medium" },
            { value: "high", label: "high" }
          ]
        },
        {
          value: "gpt-frontier",
          label: "GPT Frontier",
          isDefault: false,
          defaultEffort: "high",
          efforts: [
            { value: "high", label: "high" },
            { value: "xhigh", label: "xhigh" }
          ]
        }
      ],
      fields: [],
      warnings: []
    }
  };
}

function ports() {
  const calls = [];
  return {
    calls,
    call: async (method, params) => {
      calls.push({ method, params });
      if (method === "agent.list") return [{
        id: "codex",
        adapterId: "codex",
        command: "codex"
      }];
      if (method === "agent.capabilities") return catalog();
      if (method === "profile.show") return {
        id: "reviewer",
        agentId: "codex",
        model: "gpt-frontier",
        effort: "xhigh"
      };
      throw new Error(`Unexpected call: ${method}`);
    }
  };
}

function io(answers) {
  const writes = [];
  return {
    writes,
    interactive: true,
    json: false,
    width: 100,
    write: (value) => writes.push(value),
    question: async () => answers.shift()
  };
}

test("Profile add uses the shared runtime model then effort picker", async () => {
  const terminal = io(["gpt-frontier", "high"]);
  const selection = ports();

  const result = await resolveProfileWizardArguments(
    ["profile", "add", "security", "--agent", "codex"],
    selection,
    terminal
  );

  assert.deepEqual(result, {
    kind: "resolved",
    args: [
      "profile", "add", "security", "--agent", "codex",
      "--model", "gpt-frontier", "--effort", "high"
    ]
  });
  assert.deepEqual(
    selection.calls.filter(({ method }) => method === "agent.capabilities").length,
    1
  );
});

test("Profile update can clear model and effort together through runtime defaults", async () => {
  const result = await resolveProfileWizardArguments(
    ["profile", "update", "reviewer"],
    ports(),
    io(["default", "default"])
  );

  assert.deepEqual(result, {
    kind: "resolved",
    args: [
      "profile", "update", "reviewer",
      "--clear-model", "--clear-effort"
    ]
  });
});

test("Profile wizard stays out of explicit and non-interactive commands", async () => {
  const explicit = ["profile", "update", "reviewer", "--model", "custom"];
  assert.deepEqual(
    await resolveProfileWizardArguments(explicit, ports(), io([])),
    { kind: "unchanged", args: explicit }
  );
  const terminal = io([]);
  terminal.interactive = false;
  assert.deepEqual(
    await resolveProfileWizardArguments(["profile", "update", "reviewer"], ports(), terminal),
    { kind: "unchanged", args: ["profile", "update", "reviewer"] }
  );
});
