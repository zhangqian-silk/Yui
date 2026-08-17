import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  completeGateArtifact,
  createGateArtifact,
  gateArtifactKey,
  gateArtifactRef,
  isReusableGateArtifact,
  parseGateArtifactRef,
  recordGateArtifactPotentialReuse,
  recordGateArtifactReuse,
  verifyGateArtifactLogs
} from "../../dist/verification/gateArtifact.js";
import {
  findGateArtifact,
  findL2ArtifactForCommit,
  gateArtifactLogsRoot,
  importGateArtifactSteps,
  loadGateArtifact,
  pruneGateArtifacts,
  saveGateArtifact
} from "../../dist/verification/gateArtifactStore.js";
import {
  gateArtifactCoversCheckCommands,
  verifyGateArtifactForReview
} from "../../dist/verification/verificationGateService.js";

const now = new Date("2026-08-17T00:00:00.000Z");
const COMMIT = "0123456789abcdef0123456789abcdef01234567";
const BASE = "fedcba9876543210fedcba9876543210fedcba98";
const PLAN_DIGEST = "a".repeat(64);
const TOOLCHAIN_DIGEST = "b".repeat(64);

function identity(overrides = {}) {
  return {
    projectId: "project-1",
    level: "L2",
    commit: COMMIT,
    planDigest: PLAN_DIGEST,
    toolchainDigest: TOOLCHAIN_DIGEST,
    boundary: { targetRef: "master", baseHead: BASE },
    ...overrides
  };
}

/**
 * Build and persist a complete artifact with real logs. Returns the artifact
 * and the home directory so tests can corrupt/remove logs.
 */
async function buildArtifact(home, identityValue, options = {}) {
  const created = createGateArtifact(identityValue, {
    planId: "yui-core",
    planVersion: "1.0.0",
    generator: "yui"
  }, now);
  const sourceLogs = join(home, "source-logs");
  mkdirSync(sourceLogs, { recursive: true });
  const steps = options.steps ?? [
    { name: "gate-1", command: "npm run lint", exitCode: 0, content: "lint ok\n" },
    { name: "gate-2", command: "npm run build", exitCode: 0, content: "build ok\n" }
  ];
  const inputs = steps.map((step, index) => {
    const logName = `${String(index + 1).padStart(3, "0")}-${step.name}.log`;
    const sourceLogPath = join(sourceLogs, logName);
    writeFileSync(sourceLogPath, step.content);
    return {
      name: step.name,
      command: step.command,
      ...(step.argv === undefined ? {} : { argv: step.argv }),
      outcome: step.exitCode === 0 ? "passed" : "failed",
      exitCode: step.exitCode,
      signal: null,
      timedOut: false,
      durationMs: 100,
      sourceLogPath,
      logName
    };
  });
  const imported = await importGateArtifactSteps(home, created, inputs);
  const succeeded = options.succeeded ?? steps.every((step) => step.exitCode === 0);
  const artifact = completeGateArtifact(created, imported, succeeded ? "succeeded" : "failed", now);
  saveGateArtifact(home, artifact);
  return artifact;
}

test.beforeEach((t) => {
  const home = mkdtempSync(join(tmpdir(), "yui-gate-artifact-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  t.context = { home };
});

// --- Key identity -----------------------------------------------------------

test("the same identity tuple always maps to the same key", () => {
  const first = gateArtifactKey(identity());
  const second = gateArtifactKey(identity());
  assert.equal(first, second);
  assert.match(first, /^[a-f0-9]{64}$/u);
});

test("any tuple change produces a different key", () => {
  const baseline = gateArtifactKey(identity());
  assert.notEqual(gateArtifactKey(identity({ projectId: "project-2" })), baseline);
  assert.notEqual(gateArtifactKey(identity({ commit: "1".repeat(40) })), baseline);
  assert.notEqual(gateArtifactKey(identity({ planDigest: "c".repeat(64) })), baseline);
  assert.notEqual(gateArtifactKey(identity({ toolchainDigest: "d".repeat(64) })), baseline);
  assert.notEqual(
    gateArtifactKey(identity({ boundary: { targetRef: "release", baseHead: BASE } })),
    baseline
  );
  assert.notEqual(
    gateArtifactKey(identity({ boundary: { targetRef: "master", baseHead: "1".repeat(40) } })),
    baseline
  );
});

test("an L1 identity has no boundary", () => {
  const l1 = identity({ level: "L1", boundary: undefined });
  const artifact = createGateArtifact(l1, { planId: "p", planVersion: "1", generator: "yui" }, now);
  assert.equal(artifact.boundary, undefined);
  assert.equal(artifact.level, "L1");
});

test("an L2 artifact requires a boundary", () => {
  assert.throws(
    () => createGateArtifact(identity({ boundary: undefined }), { planId: "p", planVersion: "1", generator: "yui" }, now),
    /An L2 GateArtifact requires a target boundary/
  );
});

// --- Save/load round-trip ---------------------------------------------------

test("a saved artifact loads back with its full identity and steps", async (t) => {
  const { home } = t.context;
  const artifact = await buildArtifact(home, identity());
  const loaded = loadGateArtifact(home, "project-1", artifact.key);
  assert.notEqual(loaded, null);
  assert.equal(loaded.key, artifact.key);
  assert.equal(loaded.commit, COMMIT);
  assert.equal(loaded.planDigest, PLAN_DIGEST);
  assert.equal(loaded.status, "complete");
  assert.equal(loaded.outcome, "succeeded");
  assert.equal(loaded.steps.length, 2);
  assert.equal(loaded.steps[0].logDigest.length, 64);
  assert.equal(loaded.steps[0].logBytes, "lint ok\n".length);
});

test("findGateArtifact resolves an artifact by its identity tuple", async (t) => {
  const { home } = t.context;
  const artifact = await buildArtifact(home, identity());
  const found = findGateArtifact(home, identity());
  assert.notEqual(found, null);
  assert.equal(found.key, artifact.key);
  assert.equal(findGateArtifact(home, identity({ commit: "1".repeat(40) })), null);
});

// --- Log integrity ----------------------------------------------------------

test("verifyGateArtifactLogs passes when every log exists and matches its digest", async (t) => {
  const { home } = t.context;
  const artifact = await buildArtifact(home, identity());
  const verification = await verifyGateArtifactLogs(
    artifact,
    gateArtifactLogsRoot(home, "project-1", artifact.key)
  );
  assert.equal(verification.ok, true);
  assert.deepEqual([...verification.missing], []);
  assert.deepEqual([...verification.corrupted], []);
});

test("a missing log invalidates the artifact", async (t) => {
  const { home } = t.context;
  const artifact = await buildArtifact(home, identity());
  rmSync(join(gateArtifactLogsRoot(home, "project-1", artifact.key), artifact.steps[0].logPath));
  const verification = await verifyGateArtifactLogs(
    artifact,
    gateArtifactLogsRoot(home, "project-1", artifact.key)
  );
  assert.equal(verification.ok, false);
  assert.deepEqual([...verification.missing], ["gate-1"]);
});

test("a corrupted log invalidates the artifact", async (t) => {
  const { home } = t.context;
  const artifact = await buildArtifact(home, identity());
  writeFileSync(
    join(gateArtifactLogsRoot(home, "project-1", artifact.key), artifact.steps[1].logPath),
    "tampered\n"
  );
  const verification = await verifyGateArtifactLogs(
    artifact,
    gateArtifactLogsRoot(home, "project-1", artifact.key)
  );
  assert.equal(verification.ok, false);
  assert.deepEqual([...verification.corrupted], ["gate-2"]);
});

test("only a complete successful artifact is reusable", async (t) => {
  const { home } = t.context;
  const succeeded = await buildArtifact(home, identity());
  assert.equal(isReusableGateArtifact(succeeded), true);

  const failed = await buildArtifact(home, identity({ commit: "1".repeat(40) }), {
    steps: [{ name: "gate-1", command: "npm run lint", exitCode: 1, content: "lint failed\n" }]
  });
  assert.equal(isReusableGateArtifact(failed), false);

  const incomplete = createGateArtifact(identity({ commit: "2".repeat(40) }), {
    planId: "p", planVersion: "1", generator: "yui"
  }, now);
  assert.equal(isReusableGateArtifact(incomplete), false);
});

// --- Reuse counters ---------------------------------------------------------

test("recordGateArtifactReuse increments the reuse counter on a successful artifact", async (t) => {
  const { home } = t.context;
  const artifact = await buildArtifact(home, identity());
  const reused = recordGateArtifactReuse(artifact, now);
  assert.equal(reused.reuseCount, 1);
  const reusedAgain = recordGateArtifactReuse(reused, now);
  assert.equal(reusedAgain.reuseCount, 2);
  // The original is untouched (immutable records).
  assert.equal(artifact.reuseCount, 0);
});

test("recordGateArtifactReuse rejects an incomplete or failed artifact", async (t) => {
  const { home } = t.context;
  const failed = await buildArtifact(home, identity(), {
    steps: [{ name: "gate-1", command: "npm run lint", exitCode: 1, content: "fail\n" }]
  });
  assert.throws(() => recordGateArtifactReuse(failed, now), /Only a complete successful/);
});

test("recordGateArtifactPotentialReuse counts shadow observations in record mode", async (t) => {
  const { home } = t.context;
  const artifact = await buildArtifact(home, identity());
  const observed = recordGateArtifactPotentialReuse(artifact, now);
  assert.equal(observed.potentialReuseCount, 1);
  assert.equal(observed.reuseCount, 0);
});

// --- Evidence refs ----------------------------------------------------------

test("gate-artifact refs round-trip through their prefix", () => {
  const ref = gateArtifactRef("abc123");
  assert.equal(ref, "gate-artifact:abc123");
  assert.equal(parseGateArtifactRef(ref), "abc123");
  assert.equal(parseGateArtifactRef("review-round:r1"), undefined);
});

// --- Review verification ----------------------------------------------------

test("verifyGateArtifactForReview passes a complete artifact with intact logs", async (t) => {
  const { home } = t.context;
  const artifact = await buildArtifact(home, identity());
  const verification = await verifyGateArtifactForReview(home, "project-1", artifact.key, {
    commit: COMMIT
  });
  assert.equal(verification.ok, true);
  assert.equal(verification.artifact.key, artifact.key);
});

test("verifyGateArtifactForReview rejects a commit mismatch", async (t) => {
  const { home } = t.context;
  const artifact = await buildArtifact(home, identity());
  const verification = await verifyGateArtifactForReview(home, "project-1", artifact.key, {
    commit: "1".repeat(40)
  });
  assert.equal(verification.ok, false);
  assert.match(verification.reason, /does not match/);
});

test("verifyGateArtifactForReview rejects a missing artifact", async (t) => {
  const { home } = t.context;
  const verification = await verifyGateArtifactForReview(home, "project-1", "deadbeef");
  assert.equal(verification.ok, false);
  assert.match(verification.reason, /not found/);
});

test("verifyGateArtifactForReview rejects an artifact whose logs were lost", async (t) => {
  const { home } = t.context;
  const artifact = await buildArtifact(home, identity());
  rmSync(join(gateArtifactLogsRoot(home, "project-1", artifact.key), artifact.steps[0].logPath));
  const verification = await verifyGateArtifactForReview(home, "project-1", artifact.key);
  assert.equal(verification.ok, false);
  assert.match(verification.reason, /logs failed verification/);
});

// --- Evidence coverage ------------------------------------------------------

test("gateArtifactCoversCheckCommands covers exact commands on the exact commit", async (t) => {
  const { home } = t.context;
  const artifact = await buildArtifact(home, identity());
  const ref = gateArtifactRef(artifact.key);
  assert.equal(
    await gateArtifactCoversCheckCommands(home, "project-1", ref, ["npm run lint", "npm run build"], COMMIT),
    true
  );
  assert.equal(
    await gateArtifactCoversCheckCommands(home, "project-1", ref, ["npm run lint"], COMMIT),
    true
  );
});

test("gateArtifactCoversCheckCommands fails on a different commit or an unknown command", async (t) => {
  const { home } = t.context;
  const artifact = await buildArtifact(home, identity());
  const ref = gateArtifactRef(artifact.key);
  assert.equal(
    await gateArtifactCoversCheckCommands(home, "project-1", ref, ["npm run lint"], "1".repeat(40)),
    false
  );
  assert.equal(
    await gateArtifactCoversCheckCommands(home, "project-1", ref, ["npm run deploy"], COMMIT),
    false
  );
  assert.equal(
    await gateArtifactCoversCheckCommands(home, "project-1", "review-round:r1", ["npm run lint"], COMMIT),
    false
  );
});

// --- Retention --------------------------------------------------------------

test("pruneGateArtifacts deletes only unreferenced artifacts older than the TTL", async (t) => {
  const { home } = t.context;
  const old = await buildArtifact(home, identity());
  const recent = await buildArtifact(home, identity({ commit: "1".repeat(40) }));
  const referenced = await buildArtifact(home, identity({ commit: "2".repeat(40) }));

  // The "recent" artifact was reused yesterday, so its lastUsedAt is inside
  // the TTL window even though all three were created at the same instant.
  const yesterday = new Date(now.getTime() + 99 * 24 * 60 * 60 * 1000);
  saveGateArtifact(home, recordGateArtifactReuse(recent, yesterday));

  const referencedKeys = new Set([referenced.key]);
  const result = pruneGateArtifacts(home, "project-1", {
    now: new Date(now.getTime() + 100 * 24 * 60 * 60 * 1000),
    ttlMs: 30 * 24 * 60 * 60 * 1000,
    isReferenced: (key) => referencedKeys.has(key)
  });
  assert.equal(result.deleted, 1);
  assert.equal(result.retained, 2);
  assert.equal(loadGateArtifact(home, "project-1", old.key), null);
  assert.notEqual(loadGateArtifact(home, "project-1", recent.key), null);
  assert.notEqual(loadGateArtifact(home, "project-1", referenced.key), null);
});

test("pruneGateArtifacts re-checks references at deletion time", async (t) => {
  const { home } = t.context;
  const artifact = await buildArtifact(home, identity());
  // The artifact is old, but a reference appears between the sweep decision
  // and the delete: the deletion-time check must retain it.
  const result = pruneGateArtifacts(home, "project-1", {
    now: new Date(now.getTime() + 100 * 24 * 60 * 60 * 1000),
    ttlMs: 30 * 24 * 60 * 60 * 1000,
    isReferenced: () => true
  });
  assert.equal(result.deleted, 0);
  assert.notEqual(loadGateArtifact(home, "project-1", artifact.key), null);
});

// --- Release L2 lookup ------------------------------------------------------

test("findL2ArtifactForCommit matches project, commit, plan, toolchain, and target ref", async (t) => {
  const { home } = t.context;
  const artifact = await buildArtifact(home, identity());
  const found = await findL2ArtifactForCommit(home, {
    projectId: "project-1",
    commit: COMMIT,
    planDigest: PLAN_DIGEST,
    toolchainDigest: TOOLCHAIN_DIGEST,
    targetRef: "master"
  });
  assert.notEqual(found, null);
  assert.equal(found.key, artifact.key);

  // A different target ref does not match (base head is intentionally not
  // part of the release match).
  assert.equal(await findL2ArtifactForCommit(home, {
    projectId: "project-1",
    commit: COMMIT,
    planDigest: PLAN_DIGEST,
    toolchainDigest: TOOLCHAIN_DIGEST,
    targetRef: "release"
  }), null);
});
