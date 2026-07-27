import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createConfiguredAgent } from "../../dist/agent/agent.js";
import {
  AgentConfigurationCatalogService
} from "../../dist/executor/agentConfigurationCatalog.js";

const NOW = new Date("2026-07-27T08:00:00.000Z");

function agent(id = "codex") {
  return createConfiguredAgent(id, "codex", "codex", [], [], NOW);
}

function liveCatalog(agentId = "codex") {
  return {
    schemaVersion: 1,
    agentId,
    adapterId: "codex",
    cliVersion: "0.145.0",
    models: [
      {
        value: "gpt-5.6-sol",
        label: "GPT-5.6 Sol",
        isDefault: true,
        defaultEffort: "medium",
        efforts: [
          { value: "low", label: "low" },
          { value: "medium", label: "medium" },
          { value: "high", label: "high" }
        ]
      },
      {
        value: "gpt-5.6-terra",
        label: "GPT-5.6 Terra",
        isDefault: false,
        defaultEffort: "medium",
        efforts: [
          { value: "low", label: "low" },
          { value: "medium", label: "medium" }
        ]
      }
    ],
    fields: [
      {
        key: "permission.sandbox",
        choices: [
          { value: "read-only", label: "read-only" },
          { value: "workspace-write", label: "workspace-write" }
        ],
        allowCustom: false
      }
    ],
    warnings: []
  };
}

test("successful runtime discovery updates cache and preserves model-specific efforts", async (t) => {
  const home = mkdtempSync(join(tmpdir(), "yui-agent-catalog-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  let calls = 0;
  const service = new AgentConfigurationCatalogService(home, {
    environment: {},
    now: () => NOW,
    discover: async () => {
      calls += 1;
      return liveCatalog();
    }
  });

  const resolved = await service.resolve({ agent: agent(), cwd: "/tmp/project" });

  assert.equal(calls, 1);
  assert.equal(resolved.source, "live");
  assert.equal(resolved.catalog.models[0].efforts[2].value, "high");
  const cacheRoot = join(home, "cache", "agent-capabilities", "v1", "codex");
  const [cacheFile] = readdirSync(cacheRoot);
  const cached = JSON.parse(readFileSync(join(cacheRoot, cacheFile), "utf8"));
  assert.equal(cached.catalog.models[1].efforts.length, 2);
  assert.equal(cached.fetchedAt, NOW.toISOString());
});

test("failed discovery uses the last matching successful cache and reports the live failure", async (t) => {
  const home = mkdtempSync(join(tmpdir(), "yui-agent-catalog-cache-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const configured = agent();
  await new AgentConfigurationCatalogService(home, {
    environment: {},
    now: () => NOW,
    discover: async () => liveCatalog()
  }).resolve({ agent: configured, cwd: "/tmp/project" });

  const later = new Date("2026-07-27T09:00:00.000Z");
  const resolved = await new AgentConfigurationCatalogService(home, {
    environment: {},
    now: () => later,
    discover: async () => {
      throw Object.assign(new Error("catalog request timed out"), { code: "ETIMEDOUT" });
    }
  }).resolve({ agent: configured, cwd: "/tmp/project" });

  assert.equal(resolved.source, "cache");
  assert.equal(resolved.fetchedAt, NOW.toISOString());
  assert.equal(resolved.catalog.models[0].value, "gpt-5.6-sol");
  assert.deepEqual(resolved.failure, {
    code: "timeout",
    message: "catalog request timed out"
  });
});

test("cache is isolated by runtime context and no-cache failure returns a custom-capable fallback", async (t) => {
  const home = mkdtempSync(join(tmpdir(), "yui-agent-catalog-context-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const configured = agent();
  await new AgentConfigurationCatalogService(home, {
    environment: {},
    now: () => NOW,
    discover: async () => liveCatalog()
  }).resolve({
    agent: configured,
    cwd: "/tmp/project-a",
    config: { adapterId: "codex", profile: "work" }
  });

  const resolved = await new AgentConfigurationCatalogService(home, {
    environment: {},
    now: () => NOW,
    discover: async () => {
      throw new Error("offline");
    }
  }).resolve({
    agent: configured,
    cwd: "/tmp/project-b",
    config: { adapterId: "codex", profile: "personal" }
  });

  assert.equal(resolved.source, "fallback");
  assert.equal(resolved.catalog.models.length, 0);
  assert.equal(resolved.catalog.fields.find(({ key }) => key === "model").allowCustom, true);
  assert.equal(resolved.failure.code, "probe-failed");
});

test("cache is isolated by the effective native configuration root derived from HOME", async (t) => {
  const home = mkdtempSync(join(tmpdir(), "yui-agent-catalog-native-home-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const configured = agent();
  await new AgentConfigurationCatalogService(home, {
    environment: { HOME: "/accounts/a" },
    now: () => NOW,
    discover: async () => ({
      ...liveCatalog(),
      models: [{
        ...liveCatalog().models[0],
        value: "home-a-model",
        label: "Home A Model"
      }]
    })
  }).resolve({ agent: configured, cwd: "/tmp/project" });

  const resolved = await new AgentConfigurationCatalogService(home, {
    environment: { HOME: "/accounts/b" },
    now: () => NOW,
    discover: async () => {
      throw new Error("offline");
    }
  }).resolve({ agent: configured, cwd: "/tmp/project" });

  assert.equal(resolved.source, "fallback");
  assert.equal(resolved.catalog.models.length, 0);
});

test("an incomplete live catalog never replaces the previous successful cache", async (t) => {
  const home = mkdtempSync(join(tmpdir(), "yui-agent-catalog-incomplete-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const configured = agent();
  await new AgentConfigurationCatalogService(home, {
    environment: {},
    now: () => NOW,
    discover: async () => liveCatalog()
  }).resolve({ agent: configured, cwd: "/tmp/project" });

  const resolved = await new AgentConfigurationCatalogService(home, {
    environment: {},
    now: () => new Date("2026-07-27T10:00:00.000Z"),
    discover: async () => ({ ...liveCatalog(), models: [] })
  }).resolve({ agent: configured, cwd: "/tmp/project" });

  assert.equal(resolved.source, "cache");
  assert.equal(resolved.catalog.models[0].value, "gpt-5.6-sol");
  assert.match(resolved.failure.message, /model/i);
});

test("a cache write failure does not discard a successful live catalog", async (t) => {
  const home = mkdtempSync(join(tmpdir(), "yui-agent-catalog-readonly-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  writeFileSync(join(home, "cache"), "not a directory");

  const resolved = await new AgentConfigurationCatalogService(home, {
    environment: {},
    now: () => NOW,
    discover: async () => liveCatalog()
  }).resolve({ agent: agent(), cwd: "/tmp/project" });

  assert.equal(resolved.source, "live");
  assert.equal(resolved.catalog.models[0].value, "gpt-5.6-sol");
  assert.match(resolved.catalog.warnings.at(-1), /cache could not be updated/i);
});

test("cache identity uses bound environment values without persisting their names or secrets", async (t) => {
  const home = mkdtempSync(join(tmpdir(), "yui-agent-catalog-secret-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const configured = createConfiguredAgent(
    "codex",
    "codex",
    "codex",
    [],
    [{
      target: "OPENAI_API_KEY",
      source: "process",
      sourceName: "YUI_TEST_OPENAI_API_KEY",
      required: true
    }],
    NOW
  );
  await new AgentConfigurationCatalogService(home, {
    environment: { YUI_TEST_OPENAI_API_KEY: "secret-value-must-not-be-cached" },
    now: () => NOW,
    discover: async () => liveCatalog()
  }).resolve({ agent: configured, cwd: "/tmp/project" });

  const cacheRoot = join(home, "cache", "agent-capabilities", "v1", "codex");
  const contents = readFileSync(join(cacheRoot, readdirSync(cacheRoot)[0]), "utf8");
  assert.doesNotMatch(contents, /secret-value-must-not-be-cached|YUI_TEST_OPENAI_API_KEY/);
});
