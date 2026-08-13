#!/usr/bin/env node
// Hermetic gate runner: the L2 executable form of the PR gate
// (see docs/testing/verification-levels.md). Runs the full gate — install,
// build, lint, the deterministic suite, and package structure smoke — inside
// an isolated HOME, XDG tree, git identity, temp dir, and npm cache, with a
// sanitized PATH, and persists a per-SHA JSON record of the result.
//
// Usage:
//   node scripts/gate-hermetic.mjs [--ref <sha>] [--base <sha>]
//                                  [--record <path|->] [--npm-cache <path>]
//
// The candidate is always gated in a fresh detached worktree at the resolved
// HEAD (or --ref): the source checkout is only used for git operations, so
// uncommitted or untracked content can never enter the gated tree and a dirty
// checkout cannot produce pass evidence labeled with a clean SHA.
//
// With --base, on a candidate failure the base SHA is gated in a second
// worktree and the two records are classified at failure level (the test
// step carries stable failing-test fingerprints parsed from its TAP stream):
// the run exits non-zero only for introduced failures, and the --record file
// ends up as the self-contained combined record (candidate record, base SHA
// and record, classification, disposition) rather than the candidate-only
// record.

import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  GATE_STEPS,
  buildCombinedGateRecord,
  buildGateRecord,
  buildHermeticEnvironment,
  classifyGateResults,
  gateExitCode,
  parseTapFailureFingerprints,
  planCandidateCheckout,
  shortTmpBase,
  writeHermeticGitConfig
} from "../test/helpers/gateHermetic.js";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function parseArgs(argv) {
  const options = { record: "gate-record.json" };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--ref" || arg === "--base" || arg === "--record" || arg === "--npm-cache") {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith("--")) {
        throw new Error(`${arg} requires a value`);
      }
      if (arg === "--ref") options.ref = value;
      else if (arg === "--base") options.base = value;
      else if (arg === "--record") options.record = value;
      else options.npmCache = value;
      index += 1;
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  return options;
}

function run(cwd, command, env, { capture = false } = {}) {
  const result = spawnSync(command, {
    cwd,
    env,
    shell: true,
    encoding: "buffer",
    stdio: capture ? ["inherit", "pipe", "pipe"] : "inherit"
  });
  if (capture) {
    if (result.stdout) process.stderr.write(result.stdout);
    if (result.stderr) process.stderr.write(result.stderr);
  }
  return result;
}

function git(cwd, args, env) {
  const result = spawnSync("git", args, { cwd, env, encoding: "utf8" });
  if (result.status !== 0) {
    const detail = (result.stderr ?? "").trim() || `exit ${result.status}`;
    throw new Error(`git ${args.join(" ")} failed: ${detail}`);
  }
  return result.stdout.trim();
}

function readTapFailures(basename, hermetic, checkout) {
  try {
    const tap = readFileSync(join(hermetic.TMPDIR, basename), "utf8");
    return parseTapFailureFingerprints(tap, { checkout });
  } catch {
    // No TAP evidence (the runner crashed before writing it): the check
    // keeps an empty failure list, which classifies as unprovable identity
    // (fail-closed).
    return [];
  }
}

function runSteps(checkout, hermetic, recordToStdout) {
  const checks = [];
  for (const step of GATE_STEPS) {
    const started = Date.now();
    const result = run(checkout, step.command, hermetic, { capture: recordToStdout });
    const check = {
      name: step.name,
      status: result.status === 0 ? "pass" : "fail",
      durationMs: Date.now() - started
    };
    if (check.status === "fail" && step.tapDestination !== undefined) {
      check.failures = readTapFailures(step.tapDestination, hermetic, checkout);
    }
    checks.push(check);
  }
  return checks;
}

function gateCheckout({ checkout, sha, ref, hermetic, recordToStdout, npmVersion }) {
  const checks = runSteps(checkout, hermetic, recordToStdout);
  return buildGateRecord({ sha, ref, checks, hermetic, npmVersion });
}

function prepareHermetic(root, tmpHome, options) {
  const hermetic = buildHermeticEnvironment(root, {
    npmCache: options.npmCache,
    tmpdir: tmpHome
  });
  for (const dir of [
    hermetic.HOME,
    hermetic.XDG_CONFIG_HOME,
    hermetic.XDG_CACHE_HOME,
    hermetic.XDG_DATA_HOME,
    hermetic.TMPDIR,
    hermetic.npm_config_cache
  ]) {
    mkdirSync(dir, { recursive: true });
  }
  writeHermeticGitConfig(hermetic.GIT_CONFIG_GLOBAL);
  return hermetic;
}

function writeRecord(record, recordPath) {
  if (recordPath === "-") {
    process.stdout.write(`${JSON.stringify(record, null, 2)}\n`);
    return;
  }
  writeFileSync(recordPath, `${JSON.stringify(record, null, 2)}\n`, "utf8");
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const recordToStdout = options.record === "-";
  const summary = (line) => {
    (recordToStdout ? process.stderr : process.stdout).write(`${line}\n`);
  };
  const sourceCheckout = process.cwd();
  const root = mkdtempSync(join(tmpdir(), "yui-gate-"));
  // TMPDIR lives outside the (possibly deep) gate root: Unix domain sockets
  // are capped at 108 chars on Linux, and the suite's Controller/tmux sockets
  // are addressed under TMPDIR.
  const tmpHome = mkdtempSync(join(shortTmpBase(), "yui-gate-tmp-"));
  const worktrees = [];

  try {
    const hermetic = prepareHermetic(root, tmpHome, options);
    const npmVersionResult = spawnSync("npm", ["--version"], {
      env: hermetic,
      encoding: "utf8"
    });
    const npmVersion = npmVersionResult.status === 0
      ? npmVersionResult.stdout.trim()
      : "unknown";

    let candidateSha;
    if (options.ref !== undefined) {
      candidateSha = git(sourceCheckout, ["rev-parse", options.ref], hermetic);
    } else {
      candidateSha = git(sourceCheckout, ["rev-parse", "HEAD"], hermetic);
    }
    // Always gate a fresh detached worktree at the resolved SHA: the source
    // checkout only answers git questions, so dirty or untracked content can
    // never be part of the gated tree.
    const candidatePlan = planCandidateCheckout({ root, sha: candidateSha });
    git(sourceCheckout, candidatePlan.addArgs, hermetic);
    worktrees.push(candidatePlan.checkout);

    const candidate = gateCheckout({
      checkout: candidatePlan.checkout,
      sha: candidateSha,
      ref: options.ref ?? candidateSha,
      hermetic,
      recordToStdout,
      npmVersion
    });

    // With --base, the candidate-only record is superseded by the combined
    // record once the base is gated; without --base (or on a green candidate)
    // the candidate record is the final record.
    if (candidate.result === "pass" || options.base === undefined) {
      writeRecord(candidate, options.record);
    }

    if (candidate.result === "pass") {
      summary(
        `GATE PASS sha=${candidateSha} record=${options.record === "-" ? "stdout" : options.record}`
      );
      return 0;
    }

    const failing = candidate.checks
      .filter((check) => check.status !== "pass")
      .map((check) => check.name);

    if (options.base === undefined) {
      summary(`GATE FAIL sha=${candidateSha} failing: ${failing.join(", ")}`);
      summary(
        "Re-run with --base <merge-base-sha> to classify introduced vs pre-existing failures."
      );
      return 1;
    }

    const baseSha = git(sourceCheckout, ["rev-parse", options.base], hermetic);
    const baseCheckout = join(root, "worktree-base");
    git(sourceCheckout, ["worktree", "add", "--detach", baseCheckout, baseSha], hermetic);
    worktrees.push(baseCheckout);
    const base = gateCheckout({
      checkout: baseCheckout,
      sha: baseSha,
      ref: baseSha,
      hermetic,
      recordToStdout,
      npmVersion
    });

    const classification = classifyGateResults(candidate, base);
    const combined = buildCombinedGateRecord({ candidate, base, baseSha, classification });
    writeRecord(combined, options.record);

    summary(`GATE FAIL sha=${candidateSha} base=${baseSha} failing: ${failing.join(", ")}`);
    summary(`  introduced:   ${classification.introduced.join(", ") || "(none)"}`);
    summary(`  pre-existing: ${classification.preExisting.join(", ") || "(none)"}`);
    summary(`  fixed:        ${classification.fixed.join(", ") || "(none)"}`);
    summary(`  disposition:  ${combined.disposition}`);
    if (classification.introduced.length === 0) {
      summary("No introduced failures: the candidate failures are pre-existing on the base.");
    }
    return gateExitCode(candidate, classification);
  } finally {
    for (const worktree of worktrees) {
      spawnSync("git", ["worktree", "remove", "--force", worktree], {
        cwd: sourceCheckout,
        env: process.env
      });
    }
    rmSync(root, { recursive: true, force: true });
    rmSync(tmpHome, { recursive: true, force: true });
  }
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then(
    (code) => {
      process.exitCode = code;
    },
    (error) => {
      process.stderr.write(
        `GATE ERROR: ${error instanceof Error ? error.message : String(error)}\n`
      );
      process.exitCode = 1;
    }
  );
}
