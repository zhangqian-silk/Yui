#!/usr/bin/env node
// Hermetic gate runner: the L2 executable form of the PR gate
// (see docs/testing/verification-levels.md). Runs the full gate — install,
// build, lint, the deterministic suite, and package structure smoke — inside
// an isolated HOME, XDG tree, git identity, temp dir, and npm cache, with a
// sanitized PATH, and persists a per-SHA JSON record of the result.
//
// Usage:
//   node scripts/gate-hermetic.mjs [--ref <sha>] [--base <sha>]
//                                  [--base-ref <ref>] [--record <path|->]
//                                  [--npm-cache <path>]
//
// The candidate is always gated in a fresh detached worktree at the resolved
// HEAD (or --ref): the source checkout is only used for git operations, so
// uncommitted or untracked content can never enter the gated tree. The
// runner and helper are still loaded from the caller's checkout, though, so
// the gate first refuses to run on a dirty source checkout, and --ref must
// resolve to the source HEAD: gating a different SHA would label its result
// with code that did not produce it.
//
// With --base (an exact SHA) or --base-ref (a ref whose merge base with HEAD
// is resolved, fail-closed, before any gating), on a candidate failure the
// base is gated in a second worktree and its own hermetic domain (separate
// HOME, XDG tree, git config, TMPDIR, npm cache, and TAP file), so neither
// side can leave writable state that changes the other's result. The two
// records are classified at failure level (the test step carries stable
// failing-test fingerprints parsed from its TAP stream): the run exits
// non-zero only for introduced failures, and the --record file ends up as
// the self-contained combined record (candidate record, base SHA and record,
// classification, disposition) rather than the candidate-only record.

import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  GATE_STEPS,
  assertCleanSourceCheckout,
  buildCombinedGateRecord,
  buildGateRecord,
  classifyGateResults,
  createGateSideDomain,
  gateExitCode,
  isFullSha,
  parseTapFailureFingerprints,
  planCandidateCheckout,
  recordPathPrefixes,
  resolveMergeBase,
  shortTmpBase
} from "../test/helpers/gateHermetic.js";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function parseArgs(argv) {
  const options = { record: "gate-record.json" };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (
      arg === "--ref"
      || arg === "--base"
      || arg === "--base-ref"
      || arg === "--record"
      || arg === "--npm-cache"
    ) {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith("--")) {
        throw new Error(`${arg} requires a value`);
      }
      if (arg === "--ref") options.ref = value;
      else if (arg === "--base") options.base = value;
      else if (arg === "--base-ref") options.baseRef = value;
      else if (arg === "--record") options.record = value;
      else options.npmCache = value;
      index += 1;
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  if (options.base !== undefined && options.baseRef !== undefined) {
    throw new Error("--base and --base-ref are mutually exclusive");
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
  const worktrees = [];
  const tmpHomes = [];

  try {
    // The candidate and the base gate in separate hermetic domains: each
    // side gets its own HOME, XDG tree, git config, TMPDIR, npm cache, and
    // TAP file. A candidate must never be able to leave writable state that
    // changes the base's result (or vice versa), because the --base
    // classification compares the two records: shared state would let one
    // side poison the other and misclassify an introduced failure as
    // pre-existing.
    const candidateRoot = join(root, "candidate");
    const candidateTmp = mkdtempSync(join(shortTmpBase(), "yui-gate-tmp-candidate-"));
    tmpHomes.push(candidateTmp);
    const hermetic = createGateSideDomain(candidateRoot, candidateTmp, options, "candidate");
    const npmVersionResult = spawnSync("npm", ["--version"], {
      env: hermetic,
      encoding: "utf8"
    });
    const npmVersion = npmVersionResult.status === 0
      ? npmVersionResult.stdout.trim()
      : "unknown";

    // The runner and helper are loaded from this checkout, so modified code
    // here could produce pass evidence labeled with the HEAD SHA. Refuse to
    // gate on a dirty checkout (the gate's own record output is exempt).
    assertCleanSourceCheckout(sourceCheckout, {
      env: hermetic,
      except: recordPathPrefixes(sourceCheckout, options.record)
    });

    let candidateSha;
    if (options.ref !== undefined) {
      candidateSha = git(sourceCheckout, ["rev-parse", options.ref], hermetic);
      // The runner and helper are loaded from this checkout, so gating a
      // different SHA would label its result with code that did not produce
      // it. Fail closed: --ref must resolve to the source HEAD.
      const headSha = git(sourceCheckout, ["rev-parse", "HEAD"], hermetic);
      if (candidateSha !== headSha) {
        throw new Error(
          `--ref ${options.ref} resolves to ${candidateSha} but the source checkout is at ${headSha}; `
          + "the runner and helper are loaded from the source checkout, so gating a different SHA "
          + "would label its result with code that did not produce it. Check out the SHA first, or omit --ref."
        );
      }
    } else {
      candidateSha = git(sourceCheckout, ["rev-parse", "HEAD"], hermetic);
    }
    if (!isFullSha(candidateSha)) {
      throw new Error(`candidate did not resolve to a full SHA: ${JSON.stringify(candidateSha)}`);
    }

    // Resolve the base before gating anything: an unresolvable merge base
    // (a shallow checkout, a missing ref) exits before the candidate is
    // gated, so an empty or partial base SHA can never reach a record.
    let baseSha;
    if (options.baseRef !== undefined) {
      baseSha = resolveMergeBase(sourceCheckout, options.baseRef, { env: hermetic });
      if (baseSha === null) {
        throw new Error(
          `cannot resolve merge base with ${options.baseRef}`
          + " (shallow checkout or missing ref; fetch full history first)"
        );
      }
    } else if (options.base !== undefined) {
      baseSha = git(sourceCheckout, ["rev-parse", options.base], hermetic);
      if (!isFullSha(baseSha)) {
        throw new Error(`base did not resolve to a full SHA: ${JSON.stringify(baseSha)}`);
      }
    }

    // Always gate a fresh detached worktree at the resolved SHA: the source
    // checkout only answers git questions, so dirty or untracked content can
    // never be part of the gated tree.
    const candidatePlan = planCandidateCheckout({ root: candidateRoot, sha: candidateSha });
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

    // With a base, the candidate-only record is superseded by the combined
    // record once the base is gated; without a base (or on a green candidate)
    // the candidate record is the final record.
    if (candidate.result === "pass" || baseSha === undefined) {
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

    if (baseSha === undefined) {
      summary(`GATE FAIL sha=${candidateSha} failing: ${failing.join(", ")}`);
      summary(
        "Re-run with --base <merge-base-sha> to classify introduced vs pre-existing failures."
      );
      return 1;
    }

    // The base gates in its own hermetic domain, isolated from the
    // candidate's writable state: the candidate must not be able to leave
    // state in HOME, the XDG tree, the npm cache, or TMPDIR that changes
    // the base's result (and vice versa).
    const baseRoot = join(root, "base");
    const baseTmp = mkdtempSync(join(shortTmpBase(), "yui-gate-tmp-base-"));
    tmpHomes.push(baseTmp);
    const baseHermetic = createGateSideDomain(baseRoot, baseTmp, options, "base");

    const baseCheckout = join(baseRoot, "worktree-base");
    git(sourceCheckout, ["worktree", "add", "--detach", baseCheckout, baseSha], hermetic);
    worktrees.push(baseCheckout);
    const base = gateCheckout({
      checkout: baseCheckout,
      sha: baseSha,
      ref: baseSha,
      hermetic: baseHermetic,
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
    for (const tmpHome of tmpHomes) {
      rmSync(tmpHome, { recursive: true, force: true });
    }
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
