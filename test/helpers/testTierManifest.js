import { existsSync, readFileSync, realpathSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";

const DETERMINISTIC_TIER_FILES = Object.freeze({
  unit: Object.freeze([
    "test/core/test-tier-contract.test.js",
    "test/core/isolation-preflight.test.js",
    "test/core/test-evidence-report.test.js",
    "test/core/fenced-cleanup.test.js",
    "test/core/scrub-session-env.test.js",
    "test/core/ensure-build.test.js",
    "test/core/mock-agent-protocol.test.js",
    "test/core/mock-provider-command.test.js",
    "test/core/privileged-test-boundary.test.js",
    "test/core/test-tier-manifest.test.js",
    "test/core/test-tier-runner.test.js"
  ]),
  "isolated-integration": Object.freeze([
    "test/isolated-runtime-e2e.test.js"
  ]),
  "mock-agent-session": Object.freeze([
    "test/mock-agent-session.test.js"
  ])
});

const PRIVILEGED_MANIFESTS = Object.freeze({
  "provider-e2e": "test/privileged/provider-e2e/manifest.json",
  "release-e2e": "test/privileged/release-e2e/manifest.json"
});

const PRIVILEGED_DRIVER = "test/privileged/privileged-tier.test.js";

/**
 * Resolves the exact files for one tier. Provider/Release scenarios live in
 * nested manifests that the default package glob cannot select. A non-empty
 * privileged manifest runs only the single mandatory preflight driver.
 */
export function resolveTierTestPlan(tierId, repoRoot) {
  const deterministic = DETERMINISTIC_TIER_FILES[tierId];
  if (deterministic !== undefined) {
    return Object.freeze({
      files: Object.freeze(deterministic.map((path) => join(repoRoot, path))),
      labels: deterministic,
      environment: Object.freeze({})
    });
  }

  const relativeManifest = PRIVILEGED_MANIFESTS[tierId];
  if (relativeManifest === undefined) {
    throw new Error(`No test manifest is defined for tier ${tierId}.`);
  }
  const manifestPath = join(repoRoot, relativeManifest);
  const scenarios = readPrivilegedScenarioManifest(tierId, manifestPath);
  if (scenarios.length === 0) {
    return Object.freeze({
      files: Object.freeze([]),
      labels: Object.freeze([]),
      environment: Object.freeze({})
    });
  }
  return Object.freeze({
    files: Object.freeze([join(repoRoot, PRIVILEGED_DRIVER)]),
    labels: Object.freeze(scenarios.map((scenario) => scenario.name)),
    environment: Object.freeze({
      YUI_TEST_PRIVILEGED_MANIFEST: manifestPath
    })
  });
}

export function readPrivilegedScenarioManifest(tierId, manifestPath) {
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(manifestPath, "utf8"));
  } catch (error) {
    throw new Error(
      `Cannot read ${tierId} scenario manifest ${manifestPath}: ${error instanceof Error ? error.message : String(error)}`
    );
  }
  if (!Array.isArray(parsed)) {
    throw new Error(`${tierId} scenario manifest must be a JSON array.`);
  }
  const directory = resolve(manifestPath, "..");
  const physicalDirectory = realpathSync(directory);
  const names = new Set();
  return Object.freeze(parsed.map((entry, index) => {
    if (
      entry === null
      || typeof entry !== "object"
      || Array.isArray(entry)
      || typeof entry.name !== "string"
      || entry.name.trim() !== entry.name
      || entry.name.length === 0
      || typeof entry.module !== "string"
      || entry.module.trim() !== entry.module
      || entry.module.length === 0
      || isAbsolute(entry.module)
    ) {
      throw new Error(`${tierId} scenario manifest entry ${index} is invalid.`);
    }
    if (names.has(entry.name)) {
      throw new Error(`${tierId} scenario manifest repeats name: ${entry.name}.`);
    }
    names.add(entry.name);
    const modulePath = resolve(directory, entry.module);
    const fromDirectory = relative(directory, modulePath);
    if (
      fromDirectory.length === 0
      || fromDirectory.startsWith("..")
      || isAbsolute(fromDirectory)
      || !modulePath.endsWith(".mjs")
    ) {
      throw new Error(`${tierId} scenario module must be a .mjs file inside its manifest directory.`);
    }
    if (!existsSync(modulePath)) {
      throw new Error(`${tierId} scenario module does not exist: ${modulePath}.`);
    }
    const physicalModulePath = realpathSync(modulePath);
    const physicalFromDirectory = relative(physicalDirectory, physicalModulePath);
    if (
      physicalFromDirectory.length === 0
      || physicalFromDirectory.startsWith("..")
      || isAbsolute(physicalFromDirectory)
    ) {
      throw new Error(
        `${tierId} scenario module must resolve physically inside its manifest directory.`
      );
    }
    return Object.freeze({ name: entry.name, modulePath: physicalModulePath });
  }));
}
