import assert from "node:assert/strict";
import test from "node:test";

import {
  selectAgentModelAndEffort,
  selectAgentEffort
} from "../../dist/cli/agentConfigurationPicker.js";

function resolved(input = {}) {
  return {
    source: "live",
    attemptedAt: "2026-07-27T08:00:00.000Z",
    fetchedAt: "2026-07-27T08:00:00.000Z",
    catalog: {
      schemaVersion: 1,
      agentId: "codex",
      adapterId: "codex",
      cliVersion: "0.145.0",
      models: [
        {
          value: "gpt-default",
          label: "GPT Default",
          isDefault: true,
          defaultEffort: "medium",
          efforts: [
            { value: "low", label: "low" },
            { value: "medium", label: "medium" }
          ]
        },
        {
          value: "gpt-frontier",
          label: "GPT Frontier",
          isDefault: false,
          defaultEffort: "high",
          efforts: [
            { value: "medium", label: "medium" },
            { value: "high", label: "high" },
            { value: "xhigh", label: "xhigh" }
          ]
        }
      ],
      fields: [],
      warnings: []
    },
    ...input
  };
}

function io(answers) {
  const writes = [];
  const prompts = [];
  return {
    writes,
    prompts,
    interactive: true,
    json: false,
    width: 100,
    write: (value) => writes.push(value),
    question: async (prompt) => {
      prompts.push(prompt);
      return answers.shift();
    }
  };
}

test("model selection is followed by only that model's supported effort choices", async () => {
  const terminal = io(["gpt-frontier", "xhigh"]);

  const result = await selectAgentModelAndEffort(resolved(), terminal, {});

  assert.deepEqual(result, {
    kind: "selected",
    model: "gpt-frontier",
    effort: "xhigh"
  });
  assert.match(terminal.writes[0], /GPT Default/);
  assert.match(terminal.writes[0], /GPT Frontier/);
  assert.match(terminal.writes[1], /xhigh/);
  assert.doesNotMatch(terminal.writes[1], /\blow\b/);
});

test("CLI default clears both overrides while showing the resolved defaults", async () => {
  const terminal = io(["default", "default"]);

  const result = await selectAgentModelAndEffort(resolved(), terminal, {
    currentModel: "retired-model",
    currentEffort: "max"
  });

  assert.deepEqual(result, {
    kind: "selected",
    model: undefined,
    effort: undefined
  });
  assert.match(terminal.writes[0], /CLI default[\s\S]*GPT Default/);
  assert.match(terminal.writes[1], /CLI default[\s\S]*medium/);
  assert.match(terminal.writes[0], /retired-model[\s\S]*current/i);
});

test("blank preserves an explicitly pinned model even when it is the CLI default model", async () => {
  const terminal = io(["", ""]);

  const result = await selectAgentModelAndEffort(resolved(), terminal, {
    currentModel: "gpt-default",
    currentEffort: "medium"
  });

  assert.deepEqual(result, {
    kind: "selected",
    model: "gpt-default",
    effort: "medium"
  });
  assert.match(terminal.writes[0], /CLI default[\s\S]*GPT Default/);
});

test("changing model defaults effort back to the selected model's CLI default", async () => {
  const terminal = io(["gpt-default", ""]);

  const result = await selectAgentModelAndEffort(resolved(), terminal, {
    currentModel: "gpt-frontier",
    currentEffort: "xhigh"
  });

  assert.deepEqual(result, {
    kind: "selected",
    model: "gpt-default",
    effort: undefined
  });
  assert.doesNotMatch(terminal.writes[1], /xhigh[\s\S]*current/i);
});

test("custom model keeps all observed efforts as explicitly unverified suggestions", async () => {
  const terminal = io(["custom", "vendor/model-next", "xhigh"]);

  const result = await selectAgentModelAndEffort(resolved(), terminal, {});

  assert.deepEqual(result, {
    kind: "selected",
    model: "vendor/model-next",
    effort: "xhigh"
  });
  assert.match(terminal.writes[1], /unverified/i);
  assert.match(terminal.writes[1], /\blow\b/);
  assert.match(terminal.writes[1], /\bxhigh\b/);
});

test("effort-only selection uses the current model and cache failures are visible", async () => {
  const terminal = io(["high"]);
  const result = await selectAgentEffort(resolved({
    source: "cache",
    fetchedAt: "2026-07-27T07:00:00.000Z",
    failure: { code: "timeout", message: "request timed out" }
  }), terminal, {
    model: "gpt-frontier",
    currentEffort: "medium"
  });

  assert.deepEqual(result, { kind: "selected", effort: "high" });
  assert.match(terminal.writes[0], /cached options/i);
  assert.match(terminal.writes[0], /request timed out/i);
});
