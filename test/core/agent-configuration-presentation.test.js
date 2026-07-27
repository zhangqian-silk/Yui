import assert from "node:assert/strict";
import test from "node:test";

import {
  renderAgentConfigurationCatalog
} from "../../dist/output/agentConfigurationPresentation.js";

test("agent capability presentation exposes models, efforts, other fields, and source", () => {
  const output = renderAgentConfigurationCatalog({
    source: "cache",
    attemptedAt: "2026-07-27T00:00:01.000Z",
    fetchedAt: "2026-07-27T00:00:00.000Z",
    failure: { code: "timeout", message: "request timed out" },
    catalog: {
      schemaVersion: 1,
      agentId: "codex",
      adapterId: "codex",
      cliVersion: "1.2.3",
      warnings: [],
      models: [{
        value: "frontier",
        label: "Frontier",
        isDefault: true,
        resolvedModel: "frontier",
        defaultEffort: "medium",
        efforts: [
          { value: "low", label: "Low" },
          { value: "high", label: "High" }
        ]
      }],
      fields: [{
        key: "permission.sandbox",
        allowCustom: false,
        choices: [
          { value: "read-only", label: "Read only" },
          { value: "workspace-write", label: "Workspace write" }
        ]
      }]
    }
  });

  assert.match(output, /Agent capabilities: codex \(codex 1\.2\.3\)/);
  assert.match(output, /Frontier.*default/);
  assert.match(output, /low, high/);
  assert.match(output, /permission\.sandbox/);
  assert.match(output, /read-only, workspace-write/);
  assert.match(output, /cached options.*may be stale/i);
});
