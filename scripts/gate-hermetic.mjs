#!/usr/bin/env node
// Hermetic gate runner: the L2 executable form of the PR gate
// (see docs/testing/verification-levels.md). Runs install, build, lint, the
// deterministic suite, and package structure smoke inside an isolated HOME,
// XDG tree, git identity, temp dir, and npm cache, then persists one per-SHA
// JSON record. Every failing step fails the gate; history is not re-run.
//
// Usage:
//   node scripts/gate-hermetic.mjs [--ref <sha>] [--record <path|->]
//                                  [--npm-cache <path>]
//
// The commit is gated in a fresh detached clone. The source checkout only
// answers git questions and must be clean because this runner and its helper
// are loaded from it. --ref, when supplied, must resolve to source HEAD.

import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  GATE_STEPS,
  assertCleanSourceCheckout,
  buildGateRecord,
  createGateDomain,
  isFullSha,
  planGateCheckout,
  recordPathPrefixes,
  shortTmpBase
} from "../test/helpers/gateHermetic.js";

function parseArgs(argv) {
  const options = { record: "gate-record.json" };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--ref" || arg === "--record" || arg === "--npm-cache") {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith("--")) {
        throw new Error(`${arg} requires a value`);
      }
      if (arg === "--ref") options.ref = value;
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

function runSteps(checkout, hermetic, capture) {
  return GATE_STEPS.map((step) => {
    const started = Date.now();
    const result = run(checkout, step.command, hermetic, { capture });
    return {
      name: step.name,
      status: result.status === 0 ? "pass" : "fail",
      durationMs: Date.now() - started
    };
  });
}

function writeRecord(record, recordPath) {
  const serialized = `${JSON.stringify(record, null, 2)}\n`;
  if (recordPath === "-") {
    process.stdout.write(serialized);
  } else {
    writeFileSync(recordPath, serialized, "utf8");
  }
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const recordToStdout = options.record === "-";
  const summary = (line) => {
    (recordToStdout ? process.stderr : process.stdout).write(`${line}\n`);
  };
  const sourceCheckout = process.cwd();
  const root = mkdtempSync(join(tmpdir(), "yui-gate-"));
  // Keep Controller/tmux Unix socket paths below their platform limit.
  const gateTmp = mkdtempSync(join(shortTmpBase(), "yui-gate-tmp-"));

  try {
    const hermetic = createGateDomain(root, gateTmp, options);
    const npmVersionResult = spawnSync("npm", ["--version"], {
      env: hermetic,
      encoding: "utf8"
    });
    const npmVersion = npmVersionResult.status === 0
      ? npmVersionResult.stdout.trim()
      : "unknown";

    assertCleanSourceCheckout(sourceCheckout, {
      env: hermetic,
      except: recordPathPrefixes(sourceCheckout, options.record)
    });

    const headSha = git(sourceCheckout, ["rev-parse", "HEAD"], hermetic);
    const candidateSha = options.ref === undefined
      ? headSha
      : git(sourceCheckout, ["rev-parse", options.ref], hermetic);
    if (options.ref !== undefined && candidateSha !== headSha) {
      throw new Error(
        `--ref ${options.ref} resolves to ${candidateSha} but the source checkout is at ${headSha}; `
        + "check out the SHA first, or omit --ref."
      );
    }
    if (!isFullSha(candidateSha)) {
      throw new Error(`candidate did not resolve to a full SHA: ${JSON.stringify(candidateSha)}`);
    }

    const plan = planGateCheckout({ root, sha: candidateSha, source: sourceCheckout });
    git(sourceCheckout, plan.cloneArgs, hermetic);
    git(plan.checkout, plan.detachArgs, hermetic);

    const checks = runSteps(plan.checkout, hermetic, recordToStdout);
    const record = buildGateRecord({
      sha: candidateSha,
      ref: options.ref ?? candidateSha,
      checks,
      hermetic,
      npmVersion
    });
    writeRecord(record, options.record);

    if (record.result === "pass") {
      summary(
        `GATE PASS sha=${candidateSha} record=${options.record === "-" ? "stdout" : options.record}`
      );
      return 0;
    }
    const failing = checks.filter((check) => check.status === "fail").map((check) => check.name);
    summary(`GATE FAIL sha=${candidateSha} failing: ${failing.join(", ")}`);
    return 1;
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(gateTmp, { recursive: true, force: true });
  }
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.exitCode = main();
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
