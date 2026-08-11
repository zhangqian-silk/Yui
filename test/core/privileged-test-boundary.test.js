import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { MANAGED_LAUNCHER_MARKER } from "../helpers/isolationPreflight.js";
import {
  runPrivilegedScenarioBoundary,
  runPrivilegedTestBoundary
} from "../helpers/privilegedTest.js";
import { readPrivilegedScenarioManifest } from "../helpers/testTierManifest.js";

function fakeCheckout(t, marker = MANAGED_LAUNCHER_MARKER) {
  const checkoutRoot = mkdtempSync(join(tmpdir(), "yui-privileged-checkout-"));
  const launcher = join(checkoutRoot, "output/dev/bin/yui");
  mkdirSync(join(checkoutRoot, "output/dev/bin"), { recursive: true });
  writeFileSync(launcher, `#!/bin/sh\n${marker}\n`);
  t.after(() => rmSync(checkoutRoot, { recursive: true, force: true }));
  return checkoutRoot;
}

function deferredTestContext() {
  const teardowns = [];
  return {
    context: { after: (callback) => teardowns.push(callback) },
    async teardown() {
      for (const callback of teardowns.reverse()) await callback();
    }
  };
}

function boundaryInput(checkoutRoot, overrides = {}) {
  return {
    tier: "provider-e2e",
    checkoutRoot,
    globalNpmPrefix: "/global/npm-prefix",
    protectedHomes: [join(checkoutRoot, "output/dev/home")],
    observeActiveSessions: async () => ({
      sessions: [],
      source: "explicit fixture observation"
    }),
    cleanup: async () => {},
    ...overrides
  };
}

function privilegedScenarioFixture(t) {
  const root = mkdtempSync(join(tmpdir(), "yui-privileged-scenario-"));
  const tierDirectory = join(root, "provider-e2e");
  const evaluatedMarker = join(root, "scenario-evaluated");
  const bodyMarker = join(root, "scenario-body-ran");
  const cleanupMarker = join(root, "scenario-cleanup-ran");
  mkdirSync(tierDirectory);
  writeFileSync(join(tierDirectory, "scenario.mjs"), `
import { writeFileSync } from "node:fs";
writeFileSync(${JSON.stringify(evaluatedMarker)}, "evaluated\\n");
export async function observeActiveSessions() {
  throw new Error("scenario-owned observation must never be called");
}
export async function cleanup() {
  writeFileSync(${JSON.stringify(cleanupMarker)}, "cleanup\\n");
}
export async function run(_testContext, context) {
  if (context.preflight?.ok !== true) throw new Error("scenario ran before preflight");
  writeFileSync(${JSON.stringify(bodyMarker)}, "body\\n");
}
`);
  const manifestPath = join(tierDirectory, "manifest.json");
  writeFileSync(manifestPath, JSON.stringify([
    { name: "side-effect probe", module: "scenario.mjs" }
  ]));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const [entry] = readPrivilegedScenarioManifest("provider-e2e", manifestPath);
  return { entry, evaluatedMarker, bodyMarker, cleanupMarker };
}

function scenarioBoundaryInput(checkoutRoot, entry) {
  return {
    tier: "provider-e2e",
    checkoutRoot,
    globalNpmPrefix: "/global/npm-prefix",
    protectedHomes: [join(checkoutRoot, "output/dev/home")],
    scenarioName: entry.name,
    modulePath: entry.modulePath
  };
}

test("privileged body runs only after the fixture establishes a passing preflight", async (t) => {
  const checkoutRoot = fakeCheckout(t);
  const deferred = deferredTestContext();
  const events = [];
  let ownedRoot;

  try {
    await runPrivilegedTestBoundary(
      deferred.context,
      boundaryInput(checkoutRoot, {
        observeActiveSessions: async (context) => {
          ownedRoot = context.runRoot;
          events.push("observe");
          assert.equal(existsSync(context.yuiHome), false);
          return { sessions: [], source: "explicit fixture observation" };
        },
        cleanup: async () => events.push("cleanup")
      }),
      async (_testContext, context) => {
        events.push("body");
        assert.equal(context.preflight.ok, true);
        assert.equal(existsSync(context.yuiHome), false, "Home side effects begin after this gate");
      }
    );
    assert.deepEqual(events, ["observe", "body"]);
  } finally {
    await deferred.teardown();
  }
  assert.deepEqual(events, ["observe", "body", "cleanup"]);
  assert.equal(existsSync(ownedRoot), false, "creator-owned root must be removed");
});

test("active Session evidence rejects before the privileged body is reachable", async (t) => {
  const checkoutRoot = fakeCheckout(t);
  const deferred = deferredTestContext();
  let bodyCalls = 0;
  try {
    await assert.rejects(
      runPrivilegedTestBoundary(
        deferred.context,
        boundaryInput(checkoutRoot, {
          observeActiveSessions: async () => ({
            sessions: ["task-foreign/leader/session-live"],
            source: "explicit fixture observation"
          })
        }),
        async () => { bodyCalls += 1; }
      ),
      /active production Session/
    );
  } finally {
    await deferred.teardown();
  }
  assert.equal(bodyCalls, 0);
});

test("missing preflight evidence rejects before the privileged body is reachable", async (t) => {
  const checkoutRoot = fakeCheckout(t);
  const deferred = deferredTestContext();
  let bodyCalls = 0;
  try {
    await assert.rejects(
      runPrivilegedTestBoundary(
        deferred.context,
        boundaryInput(checkoutRoot, { observeActiveSessions: undefined }),
        async () => { bodyCalls += 1; }
      ),
      /observeActiveSessions is required/
    );
  } finally {
    await deferred.teardown();
  }
  assert.equal(bodyCalls, 0);
});

test("invalid launcher evidence rejects before the privileged body is reachable", async (t) => {
  const checkoutRoot = fakeCheckout(t, "# not-a-managed-launcher");
  const deferred = deferredTestContext();
  let bodyCalls = 0;
  try {
    await assert.rejects(
      runPrivilegedTestBoundary(
        deferred.context,
        boundaryInput(checkoutRoot),
        async () => { bodyCalls += 1; }
      ),
      /launcher-managed-marker/
    );
  } finally {
    await deferred.teardown();
  }
  assert.equal(bodyCalls, 0);
});

test("a failing preflight never evaluates its manifested scenario and still cleans its owned root", async (t) => {
  const checkoutRoot = fakeCheckout(t);
  const fixture = privilegedScenarioFixture(t);
  const deferred = deferredTestContext();
  let ownedRoot;

  try {
    await assert.rejects(
      runPrivilegedScenarioBoundary(
        deferred.context,
        scenarioBoundaryInput(checkoutRoot, fixture.entry),
        {
          observeActiveSessions: async (context) => {
            ownedRoot = context.runRoot;
            return {
              sessions: ["task-production/leader/native-live"],
              source: "explicit runner-owned test observation"
            };
          }
        }
      ),
      /active production Session/u
    );
    assert.equal(existsSync(fixture.evaluatedMarker), false);
    assert.equal(existsSync(fixture.bodyMarker), false);
  } finally {
    await deferred.teardown();
  }

  assert.equal(existsSync(fixture.evaluatedMarker), false);
  assert.equal(existsSync(fixture.bodyMarker), false);
  assert.equal(existsSync(fixture.cleanupMarker), false);
  assert.equal(existsSync(ownedRoot), false, "pre-registered cleanup removes the exact owned root");
});

test("a passing preflight imports and runs its scenario before registered cleanup", async (t) => {
  const checkoutRoot = fakeCheckout(t);
  const fixture = privilegedScenarioFixture(t);
  const deferred = deferredTestContext();
  let ownedRoot;

  try {
    await runPrivilegedScenarioBoundary(
      deferred.context,
      scenarioBoundaryInput(checkoutRoot, fixture.entry),
      {
        observeActiveSessions: async (context) => {
          ownedRoot = context.runRoot;
          return {
            sessions: [],
            source: "explicit runner-owned test observation"
          };
        }
      }
    );
    assert.equal(existsSync(fixture.evaluatedMarker), true);
    assert.equal(existsSync(fixture.bodyMarker), true);
    assert.equal(existsSync(fixture.cleanupMarker), false);
    assert.equal(existsSync(ownedRoot), true);
  } finally {
    await deferred.teardown();
  }

  assert.equal(existsSync(fixture.cleanupMarker), true);
  assert.equal(existsSync(ownedRoot), false, "scenario cleanup precedes exact root removal");
});
