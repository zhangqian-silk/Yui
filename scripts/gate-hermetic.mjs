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
// Without --ref, gates the current checkout in place. With --ref, gates a
// temporary git worktree at that SHA (the record still lands in the invoker's
// cwd). With --base, on a candidate failure the base SHA is gated in a second
// worktree and the two records are classified into introduced, pre-existing,
// and fixed checks: the run exits non-zero only for introduced failures.

import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  GATE_STEPS,
  buildGateRecord,
  buildHermeticEnvironment,
  classifyGateResults,
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

function runSteps(checkout, hermetic, recordToStdout) {
  const checks = [];
  for (const step of GATE_STEPS) {
    const started = Date.now();
    const result = run(checkout, step.command, hermetic, { capture: recordToStdout });
    checks.push({
      name: step.name,
      status: result.status === 0 ? "pass" : "fail",
      durationMs: Date.now() - started
    });
  }
  return checks;
}

function gateCheckout({ checkout, sha, ref, hermetic, recordToStdout, npmVersion }) {
  const checks = runSteps(checkout, hermetic, recordToStdout);
  return buildGateRecord({ sha, ref, checks, hermetic, npmVersion });
}

function prepareHermetic(root, options) {
  const hermetic = buildHermeticEnvironment(root, { npmCache: options.npmCache });
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
  const worktrees = [];
  let exitCode = 0;

  try {
    const hermetic = prepareHermetic(root, options);
    const npmVersionResult = spawnSync("npm", ["--version"], {
      env: hermetic,
      encoding: "utf8"
    });
    const npmVersion = npmVersionResult.status === 0
      ? npmVersionResult.stdout.trim()
      : "unknown";

    let candidateCheckout = sourceCheckout;
    let candidateSha;
    if (options.ref !== undefined) {
      candidateSha = git(sourceCheckout, ["rev-parse", options.ref], hermetic);
      candidateCheckout = join(root, "worktree-candidate");
      git(sourceCheckout, ["worktree", "add", "--detach", candidateCheckout, candidateSha], hermetic);
      worktrees.push(candidateCheckout);
    } else {
      candidateSha = git(sourceCheckout, ["rev-parse", "HEAD"], hermetic);
    }

    const candidate = gateCheckout({
      checkout: candidateCheckout,
      sha: candidateSha,
      ref: options.ref ?? candidateSha,
      hermetic,
      recordToStdout,
      npmVersion
    });
    writeRecord(candidate, options.record);

    if (candidate.result === "pass") {
      summary(
        `GATE PASS sha=${candidateSha} record=${options.record === "-" ? "stdout" : options.record}`
      );
      return;
    }

    const failing = candidate.checks
      .filter((check) => check.status !== "pass")
      .map((check) => check.name);

    if (options.base === undefined) {
      summary(`GATE FAIL sha=${candidateSha} failing: ${failing.join(", ")}`);
      summary(
        "Re-run with --base <merge-base-sha> to classify introduced vs pre-existing failures."
      );
      exitCode = 1;
      return;
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
    writeRecord(base, join(root, "base-record.json"));

    const classification = classifyGateResults(candidate, base);
    summary(`GATE FAIL sha=${candidateSha} base=${baseSha} failing: ${failing.join(", ")}`);
    summary(`  introduced:   ${classification.introduced.join(", ") || "(none)"}`);
    summary(`  pre-existing: ${classification.preExisting.join(", ") || "(none)"}`);
    summary(`  fixed:        ${classification.fixed.join(", ") || "(none)"}`);
    if (classification.introduced.length > 0) {
      exitCode = 1;
    } else {
      summary("No introduced failures: the candidate failures are pre-existing on the base.");
    }
  } finally {
    for (const worktree of worktrees) {
      spawnSync("git", ["worktree", "remove", "--force", worktree], {
        cwd: sourceCheckout,
        env: process.env
      });
    }
    rmSync(root, { recursive: true, force: true });
  }
  process.exitCode = exitCode;
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(
      `GATE ERROR: ${error instanceof Error ? error.message : String(error)}\n`
    );
    process.exitCode = 1;
  });
}
