#!/usr/bin/env node
// Executable entrypoint for the five explicit Yui test tiers.
//
// Usage:
//   node scripts/run-test-tier.mjs <tier> [-- <extra node --test args>]
//   node scripts/run-test-tier.mjs list
//
// This selects and runs the tests classified into one tier. It does NOT
// reclassify historical tests: the default `npm test` remains the full
// deterministic regression suite (Unit + Isolated Integration + local Mock
// Agent Session, no real model). Deterministic files and nested privileged
// scenario manifests are resolved by test/helpers/testTierManifest.js.
//
// The runner is the fail-closed gate for the privileged tiers: Provider E2E and
// Release E2E refuse to run unless their explicit opt-in env var is set, and
// every registered privileged scenario runs through one mandatory fixture that
// establishes assertIsolationReady before its body is reachable.
// Gating keys on the tier being privileged (having an opt-in env), NOT on
// whether it calls a model: Release E2E is privileged yet, on its normal path,
// creates no Session and calls no model. No fallback, no guessing.
//
// This is a supported entrypoint, so every non-empty tier first runs the
// canonical TypeScript build. A present dist/cli.js is not a freshness proof.

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { ensureDistBuilt } from "../test/helpers/ensureBuild.js";
import {
  MOCK_TRANSPORT_DISCLAIMER,
  TEST_TIER_IDS,
  TEST_TIERS,
  resolveTier,
  tierIsPrivileged
} from "../test/helpers/testTiers.js";
import { resolveTierTestPlan } from "../test/helpers/testTierManifest.js";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function printTierTable() {
  process.stdout.write("Yui test tiers:\n");
  for (const id of TEST_TIER_IDS) {
    const tier = TEST_TIERS[id];
    const plan = resolveTierTestPlan(id, repoRoot);
    process.stdout.write(
      `  ${tier.title} (${id})\n`
      + `    creates Session: ${tier.createsSession ? "yes" : "no"}; `
      + `calls model: ${tier.callsModel ? "yes" : "no"}; `
      + `disposable runtime: ${tier.createsDisposableRuntime ? "yes" : "no"}; `
      + `preflight required: ${tier.requiresIsolationPreflight ? "yes" : "no"}\n`
      + (tier.optInEnv ? `    privileged opt-in: ${tier.optInEnv}=1\n` : "")
      + `    tests: ${plan.labels.length === 0 ? "(none registered yet)" : plan.labels.join(", ")}\n`
    );
  }
  process.stdout.write(`\nNote: ${MOCK_TRANSPORT_DISCLAIMER}\n`);
  process.stdout.write(
    "Default `npm test` runs the full deterministic suite (no model). "
    + "These entrypoints select explicitly-classified tiers.\n"
  );
}

function optedIn(tier, environment) {
  if (tier.optInEnv === null) return true;
  const value = environment[tier.optInEnv];
  return value === "1" || value === "true";
}

function nodeTestArguments(rest) {
  if (rest.length === 0) return [];
  if (rest[0] !== "--") {
    throw new Error(
      "Extra node --test arguments must follow the tier separator: <tier> -- <args>."
    );
  }
  return rest.slice(1);
}

function main() {
  const [, , rawTier, ...rest] = process.argv;

  if (rawTier === undefined || rawTier === "list" || rawTier === "--list") {
    printTierTable();
    process.exit(0);
  }

  let tier;
  let extraTestArguments;
  try {
    tier = resolveTier(rawTier);
    extraTestArguments = nodeTestArguments(rest);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  }

  // Fail-closed gate: a privileged tier (one with an opt-in env) must be
  // explicitly opted into. This keys on privilege, not on model calls, so
  // Release E2E — privileged but non-model on its normal path — is still gated,
  // and the message never overstates that it "calls a model".
  if (tierIsPrivileged(tier.id) && !optedIn(tier, process.env)) {
    const capability = tier.callsModel
      ? "may call a real model"
      : "touches real npm/home/namespace release resources";
    process.stderr.write(
      `BLOCKED: tier ${tier.id} ${capability} and is not opted in.\n`
      + `Set ${tier.optInEnv}=1 to run it, and ensure each test passes the isolation\n`
      + "preflight (assertIsolationReady) against a disposable launcher/home/npm namespace.\n"
    );
    process.exit(1);
  }

  if (tier.requiresIsolationPreflight) {
    process.stderr.write(
      `NOTE: tier ${tier.id} runs only through the mandatory privilegedTest fixture;\n`
      + "its scenario body is unreachable until assertIsolationReady passes.\n"
    );
  }

  let plan;
  try {
    plan = resolveTierTestPlan(tier.id, repoRoot);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  }
  const manifest = plan.files;
  const missing = manifest.filter((path) => !existsSync(path));
  if (missing.length > 0) {
    process.stderr.write(
      `Tier ${tier.id} manifest references missing files:\n`
      + missing.map((path) => `  - ${path}`).join("\n") + "\n"
    );
    process.exit(1);
  }

  if (manifest.length === 0) {
    process.stdout.write(
      `Tier ${tier.title} (${tier.id}): no tests registered yet — nothing to run.\n`
    );
    process.exit(0);
  }

  // Supported entrypoint contract: always establish a fresh src -> dist
  // boundary before running a tier. Existence alone cannot detect stale output.
  const buildOutcome = ensureDistBuilt({
    build: () => spawnSync("npm", ["run", "build"], { cwd: repoRoot, stdio: "inherit" }),
    log: (message) => process.stderr.write(`${message}\n`)
  });
  if (buildOutcome.exitCode !== 0) {
    process.stderr.write(`Cannot run tier ${tier.id}: ${buildOutcome.reason}\n`);
    process.exit(buildOutcome.exitCode);
  }

  // Deterministic, color-free output, mirroring the default `npm test` env, plus
  // an explicit tier marker tests/adapters can read.
  const environment = {
    ...process.env,
    ...plan.environment,
    NO_COLOR: "1",
    YUI_TEST_TIER: tier.id
  };
  delete environment.FORCE_COLOR;
  // An inherited opt-out must never disable ordinary tier isolation. Dedicated
  // managed-identity tests may set it only on their own child process.
  delete environment.YUI_TEST_KEEP_SESSION_ENV;

  const result = spawnSync(
    process.execPath,
    [
      "--import",
      join(repoRoot, "test/helpers/scrubSessionEnv.js"),
      "--test",
      ...extraTestArguments,
      ...manifest
    ],
    { cwd: repoRoot, stdio: "inherit", env: environment }
  );
  if (result.error) {
    process.stderr.write(`${result.error.message}\n`);
    process.exit(1);
  }
  process.exit(result.status ?? 1);
}

main();
