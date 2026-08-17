import assert from "node:assert/strict";
import test from "node:test";

import {
  VERIFICATION_PLAN_KIND,
  normalizeVerificationPlan,
  planBootstrapJobSteps,
  planL1JobSteps,
  planL2JobSteps,
  resolveProjectVerificationPlan,
  selectL1Checks,
  toolchainDigest,
  verificationPlanDigest,
  verificationPlanKnowledgeBody,
  verificationStepCommand
} from "../../dist/verification/verificationPlan.js";
import { addProjectKnowledge, createProject } from "../../dist/repository/project.js";

const now = new Date("2026-08-17T00:00:00.000Z");

function planBody(overrides = {}) {
  return {
    kind: VERIFICATION_PLAN_KIND,
    id: "yui-core",
    version: "1.0.0",
    mode: "record",
    toolchain: { node: ">=20", platform: "linux" },
    bootstrap: [
      { name: "deps", argv: ["npm", "ci"] }
    ],
    l1: {
      categories: [
        {
          id: "src",
          paths: ["src"],
          checks: [{ name: "unit", argv: ["npm", "test"] }]
        }
      ]
    },
    l2: {
      steps: [
        { name: "lint", argv: ["npm", "run", "lint"] },
        { name: "build", argv: ["npm", "run", "build"] }
      ]
    },
    ...overrides
  };
}

function plan(overrides = {}) {
  return normalizeVerificationPlan(planBody(overrides));
}

// --- Normalization ---------------------------------------------------------

test("normalize accepts a well-formed plan and defaults mode to record", () => {
  const normalized = plan({ mode: undefined });
  assert.equal(normalized.mode, "record");
  assert.equal(normalized.schemaVersion, 1);
  assert.equal(normalized.kind, VERIFICATION_PLAN_KIND);
  assert.equal(normalized.bootstrap.length, 1);
  assert.equal(normalized.l2.steps.length, 2);
});

test("normalize rejects a non-object body", () => {
  assert.throws(() => normalizeVerificationPlan("nope"), /must be an object/);
  assert.throws(() => normalizeVerificationPlan(null), /must be an object/);
  assert.throws(() => normalizeVerificationPlan([]), /must be an object/);
});

test("normalize rejects the wrong kind", () => {
  assert.throws(
    () => normalizeVerificationPlan({ ...planBody(), kind: "gate-plan" }),
    /kind must be/
  );
});

test("normalize rejects an unsupported schemaVersion", () => {
  assert.throws(
    () => normalizeVerificationPlan({ ...planBody(), schemaVersion: 2 }),
    /schemaVersion must be 1/
  );
});

test("normalize rejects an invalid mode", () => {
  assert.throws(
    () => normalizeVerificationPlan({ ...planBody(), mode: "shadow" }),
    /mode is invalid/
  );
});

test("normalize accepts record, reuse, and enforce modes", () => {
  for (const mode of ["record", "reuse", "enforce"]) {
    assert.equal(plan({ mode }).mode, mode);
  }
});

test("normalize rejects an empty L2 step set", () => {
  assert.throws(
    () => normalizeVerificationPlan({ ...planBody(), l2: { steps: [] } }),
    /l2 requires at least one step/
  );
});

test("normalize rejects duplicate step names within one section", () => {
  assert.throws(
    () => normalizeVerificationPlan({
      ...planBody(),
      l2: {
        steps: [
          { name: "build", argv: ["npm", "run", "build"] },
          { name: "build", argv: ["npm", "test"] }
        ]
      }
    }),
    /step names must be unique/
  );
});

test("normalize rejects a step without argv", () => {
  assert.throws(
    () => normalizeVerificationPlan({
      ...planBody(),
      l2: { steps: [{ name: "build", command: "npm run build" }] }
    }),
    /requires a non-empty argv/
  );
});

test("normalize rejects an absolute step cwd", () => {
  assert.throws(
    () => normalizeVerificationPlan({
      ...planBody(),
      l2: { steps: [{ name: "build", argv: ["npm", "run", "build"], cwd: "/tmp" }] }
    }),
    /cwd must be workspace-relative/
  );
});

test("normalize rejects non-string env values", () => {
  assert.throws(
    () => normalizeVerificationPlan({
      ...planBody(),
      bootstrap: [{ name: "deps", argv: ["npm", "ci"], env: { CI: true } }]
    }),
    /env values must be strings/
  );
});

test("normalize rejects duplicate L1 category ids", () => {
  assert.throws(
    () => normalizeVerificationPlan({
      ...planBody(),
      l1: {
        categories: [
          { id: "src", paths: ["src"], checks: [{ name: "a", argv: ["true"] }] },
          { id: "src", paths: ["lib"], checks: [{ name: "b", argv: ["true"] }] }
        ]
      }
    }),
    /category ids must be unique/
  );
});

// --- Digest stability and invalidation -------------------------------------

test("the plan digest is stable across normalization passes", () => {
  const first = verificationPlanDigest(plan());
  const second = verificationPlanDigest(normalizeVerificationPlan(planBody()));
  assert.equal(first, second);
  assert.match(first, /^[a-f0-9]{64}$/u);
});

test("the plan digest excludes mode, TTL, and documentation fields", () => {
  const baseline = verificationPlanDigest(plan());
  assert.equal(verificationPlanDigest(plan({ mode: "reuse" })), baseline);
  assert.equal(verificationPlanDigest(plan({ mode: "enforce" })), baseline);
  assert.equal(verificationPlanDigest(plan({ artifactTtlDays: 30 })), baseline);
  assert.equal(
    verificationPlanDigest(plan({ excludedRealResourceChecks: ["npm publish"] })),
    baseline
  );
});

test("changing the plan id or version invalidates the digest", () => {
  const baseline = verificationPlanDigest(plan());
  assert.notEqual(verificationPlanDigest(plan({ id: "yui-core-v2" })), baseline);
  assert.notEqual(verificationPlanDigest(plan({ version: "2.0.0" })), baseline);
});

test("changing bootstrap, L1, or L2 invalidates the digest", () => {
  const baseline = verificationPlanDigest(plan());
  assert.notEqual(
    verificationPlanDigest(plan({ bootstrap: [{ name: "deps", argv: ["npm", "ci", "--omit=dev"] }] })),
    baseline
  );
  assert.notEqual(
    verificationPlanDigest(plan({
      l1: { categories: [{ id: "src", paths: ["src"], checks: [{ name: "unit", argv: ["npm", "test", "--silent"] }] }] }
    })),
    baseline
  );
  assert.notEqual(
    verificationPlanDigest(plan({
      l2: { steps: [{ name: "build", argv: ["npm", "run", "build:release"] }] }
    })),
    baseline
  );
});

test("changing the declared toolchain invalidates the digest", () => {
  const baseline = verificationPlanDigest(plan());
  assert.notEqual(
    verificationPlanDigest(plan({ toolchain: { node: ">=22", platform: "linux" } })),
    baseline
  );
});

test("the toolchain digest changes with the runtime identity", () => {
  const planValue = plan();
  const baseline = toolchainDigest(planValue, {
    node: "v20.0.0",
    npm: "10.0.0",
    platform: "linux",
    arch: "x64"
  });
  assert.notEqual(
    toolchainDigest(planValue, { node: "v22.0.0", npm: "10.0.0", platform: "linux", arch: "x64" }),
    baseline
  );
  assert.notEqual(
    toolchainDigest(planValue, { node: "v20.0.0", npm: "10.0.0", platform: "darwin", arch: "x64" }),
    baseline
  );
  assert.notEqual(
    toolchainDigest(planValue, { node: "v20.0.0", npm: "10.0.0", platform: "linux", arch: "arm64" }),
    baseline
  );
  // The same runtime identity reproduces the digest.
  assert.equal(
    toolchainDigest(planValue, { node: "v20.0.0", npm: "10.0.0", platform: "linux", arch: "x64" }),
    baseline
  );
});

// --- L1 selection -----------------------------------------------------------

test("L1 selection matches changed paths by prefix and de-duplicates steps", () => {
  const selected = selectL1Checks(plan({
    l1: {
      categories: [
        { id: "src", paths: ["src"], checks: [{ name: "unit", argv: ["npm", "test"] }] },
        { id: "docs", paths: ["docs"], checks: [{ name: "docs", argv: ["npm", "run", "docs"] }] }
      ]
    }
  }), ["src/foo.ts", "src/bar.ts"]);
  assert.deepEqual(selected.map((step) => step.name), ["unit"]);
});

test("L1 selection returns nothing when no category matches", () => {
  const selected = selectL1Checks(plan(), ["README.md"]);
  assert.deepEqual(selected, []);
});

// --- Job step mapping -------------------------------------------------------

test("plan steps map to DurableJob steps with stable names and argv", () => {
  const bootstrap = planBootstrapJobSteps(plan());
  assert.equal(bootstrap.length, 1);
  assert.equal(bootstrap[0].name, "bootstrap-1");
  assert.deepEqual([...bootstrap[0].argv], ["npm", "ci"]);
  assert.equal(bootstrap[0].command, "npm ci");

  const l2 = planL2JobSteps(plan());
  assert.deepEqual(l2.map((step) => step.name), ["gate-1", "gate-2"]);
  assert.deepEqual([...l2[0].argv], ["npm", "run", "lint"]);

  const l1 = planL1JobSteps(plan().l1.categories[0].checks);
  assert.equal(l1[0].name, "l1-1");
});

test("verificationStepCommand quotes argv tokens that need it", () => {
  assert.equal(verificationStepCommand({ name: "x", argv: ["npm", "run", "lint"] }), "npm run lint");
  assert.equal(
    verificationStepCommand({ name: "x", argv: ["node", "-e", "console.log('hi')"] }),
    "node -e 'console.log('\\''hi'\\'')'"
  );
  assert.equal(
    verificationStepCommand({ name: "x", argv: ["sh", "-c", "echo hi"], shell: true }),
    "sh -c echo hi"
  );
});

// --- Knowledge resolution ---------------------------------------------------

function projectWithKnowledge(bodies) {
  let project = createProject("project-1", "fixture", "/tmp/repo", { stable: "master", development: "master" }, now);
  for (const [index, body] of bodies.entries()) {
    project = addProjectKnowledge(project, `knowledge-${index + 1}`, `Knowledge ${index + 1}`, body, now);
  }
  return project;
}

test("resolveProjectVerificationPlan reads a plan from active knowledge", () => {
  const project = projectWithKnowledge([verificationPlanKnowledgeBody(plan())]);
  const resolved = resolveProjectVerificationPlan(project);
  assert.notEqual(resolved, undefined);
  assert.equal(resolved.id, "yui-core");
  assert.equal(resolved.version, "1.0.0");
});

test("resolveProjectVerificationPlan ignores free-text and non-plan JSON knowledge", () => {
  const project = projectWithKnowledge([
    "Just some free-text Project knowledge.",
    JSON.stringify({ kind: "other", note: "not a plan" })
  ]);
  assert.equal(resolveProjectVerificationPlan(project), undefined);
});

test("resolveProjectVerificationPlan fails closed on multiple plans", () => {
  const project = projectWithKnowledge([
    verificationPlanKnowledgeBody(plan()),
    verificationPlanKnowledgeBody(plan({ id: "other-plan" }))
  ]);
  assert.throws(
    () => resolveProjectVerificationPlan(project),
    /declares multiple VerificationPlans/
  );
});

test("resolveProjectVerificationPlan fails closed on a malformed plan body", () => {
  const project = projectWithKnowledge([
    JSON.stringify({ kind: VERIFICATION_PLAN_KIND, id: "broken" })
  ]);
  assert.throws(() => resolveProjectVerificationPlan(project), /VerificationPlan/);
});

test("a Project without knowledge has no plan (unstructured explicit-check mode)", () => {
  const project = createProject("project-1", "fixture", "/tmp/repo", { stable: "master", development: "master" }, now);
  assert.equal(resolveProjectVerificationPlan(project), undefined);
});
