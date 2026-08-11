import { resolve } from "node:path";

import { privilegedScenarioTest } from "../helpers/privilegedTest.js";
import { readPrivilegedScenarioManifest } from "../helpers/testTierManifest.js";
import { tierIsPrivileged } from "../helpers/testTiers.js";

const repoRoot = resolve(import.meta.dirname, "../..");
const tier = process.env.YUI_TEST_TIER;
const manifestPath = process.env.YUI_TEST_PRIVILEGED_MANIFEST;

if (!tierIsPrivileged(tier) || typeof manifestPath !== "string") {
  throw new Error("Privileged tier driver requires the runner-owned tier and manifest.");
}

for (const entry of readPrivilegedScenarioManifest(tier, manifestPath)) {
  privilegedScenarioTest(entry.name, {
    tier,
    checkoutRoot: repoRoot,
    modulePath: entry.modulePath
  });
}
