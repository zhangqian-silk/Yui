import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import {
  readPrivilegedScenarioManifest,
  resolveTierTestPlan
} from "../helpers/testTierManifest.js";

const repoRoot = resolve(import.meta.dirname, "../..");

test("default npm test structurally selects only root and core deterministic tests", () => {
  const packageJson = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8"));
  assert.match(packageJson.scripts.test, /--test test\/\*\.test\.js test\/core\/\*\.test\.js$/);
  assert.doesNotMatch(packageJson.scripts.test, /test\/privileged/);
});

test("Provider and Release manifests are nested, explicit, and truthfully empty", () => {
  for (const tier of ["provider-e2e", "release-e2e"]) {
    const plan = resolveTierTestPlan(tier, repoRoot);
    assert.deepEqual(plan.files, []);
    assert.deepEqual(plan.labels, []);
  }
  assert.deepEqual(
    JSON.parse(readFileSync(join(repoRoot, "test/privileged/provider-e2e/manifest.json"), "utf8")),
    []
  );
  assert.deepEqual(
    JSON.parse(readFileSync(join(repoRoot, "test/privileged/release-e2e/manifest.json"), "utf8")),
    []
  );
});

test("a privileged manifest cannot escape its tier directory", (t) => {
  const root = mkdtempSync(join(tmpdir(), "yui-privileged-manifest-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const manifest = join(root, "manifest.json");
  writeFileSync(manifest, JSON.stringify([
    { name: "escape", module: "../provider-side-effect.mjs" }
  ]));
  assert.throws(
    () => readPrivilegedScenarioManifest("provider-e2e", manifest),
    /inside its manifest directory/
  );
});

test("a privileged manifest cannot escape through a symlinked scenario module", (t) => {
  const root = mkdtempSync(join(tmpdir(), "yui-privileged-manifest-symlink-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const tierDirectory = join(root, "provider-e2e");
  mkdirSync(tierDirectory);
  const outsideModule = join(root, "provider-side-effect.mjs");
  writeFileSync(outsideModule, "export const outside = true;\n");
  symlinkSync(outsideModule, join(tierDirectory, "scenario.mjs"));
  const manifest = join(tierDirectory, "manifest.json");
  writeFileSync(manifest, JSON.stringify([
    { name: "symlink escape", module: "scenario.mjs" }
  ]));

  assert.throws(
    () => readPrivilegedScenarioManifest("provider-e2e", manifest),
    /physically inside its manifest directory/
  );
});
