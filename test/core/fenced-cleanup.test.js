import assert from "node:assert/strict";
import test from "node:test";

import {
  CLEANUP_PASS_ID,
  classifyForCleanup,
  isCleanableDisposition,
  isValidOwnershipToken,
  registerFencedCleanup,
  runFencedCleanup
} from "../helpers/fencedCleanup.js";

const OWNED_TOKEN = "a".repeat(64);
const FOREIGN_TOKEN = "b".repeat(64);

function ownedResource(id, overrides = {}) {
  return {
    id,
    disposition: "safe",
    domain: { kind: "ephemeral-test", token: OWNED_TOKEN },
    ...overrides
  };
}

test("only safe/review dispositions are cleanable", () => {
  assert.equal(isCleanableDisposition("safe"), true);
  assert.equal(isCleanableDisposition("review"), true);
  assert.equal(isCleanableDisposition("protected"), false);
  assert.equal(isCleanableDisposition("report-only"), false);
  assert.equal(isCleanableDisposition(undefined), false);
});

test("only a non-empty string is a valid ownership token", () => {
  assert.equal(isValidOwnershipToken(OWNED_TOKEN), true);
  assert.equal(isValidOwnershipToken(""), false);
  assert.equal(isValidOwnershipToken(undefined), false);
  assert.equal(isValidOwnershipToken(null), false);
  assert.equal(isValidOwnershipToken(123), false);
});

test("classify cleans an owned ephemeral-test resource when the exact token is supplied", () => {
  const decision = classifyForCleanup(ownedResource("r1"), { expectedToken: OWNED_TOKEN });
  assert.equal(decision.action, "clean");
});

test("classify refuses to clean when NO token is supplied (fail-closed)", () => {
  // Previously an omitted token weakened the rule to domain-only; now a missing
  // token means nothing is ever cleaned.
  const decision = classifyForCleanup(ownedResource("r1"));
  assert.equal(decision.action, "skip");
  assert.match(decision.reason, /missing ephemeral-test ownership token/);
});

test("classify refuses to clean when an empty token is supplied", () => {
  const decision = classifyForCleanup(ownedResource("r1"), { expectedToken: "" });
  assert.equal(decision.action, "skip");
  assert.match(decision.reason, /missing ephemeral-test ownership token/);
});

test("there is no option to disable the ephemeral-test domain fence", () => {
  // Even if a caller tries to pass the old escape hatch, an unmarked domain is
  // still skipped: the fence cannot be turned off.
  const decision = classifyForCleanup(
    { id: "r1", disposition: "safe", domain: { kind: "unmarked" } },
    { expectedToken: OWNED_TOKEN, requireEphemeralDomain: false }
  );
  assert.equal(decision.action, "skip");
  assert.match(decision.reason, /unmarked domain/);
});

test("classify skips a protected resource without touching it", () => {
  const decision = classifyForCleanup(
    ownedResource("r1", { disposition: "protected" }),
    { expectedToken: OWNED_TOKEN }
  );
  assert.equal(decision.action, "skip");
  assert.match(decision.reason, /not cleanable/);
});

test("classify skips an unmarked domain (fail-closed)", () => {
  const decision = classifyForCleanup(
    { id: "r1", disposition: "safe", domain: { kind: "unmarked" } },
    { expectedToken: OWNED_TOKEN }
  );
  assert.equal(decision.action, "skip");
  assert.match(decision.reason, /unmarked domain/);
});

test("classify skips a resource with no domain at all", () => {
  const decision = classifyForCleanup(
    { id: "r1", disposition: "safe" },
    { expectedToken: OWNED_TOKEN }
  );
  assert.equal(decision.action, "skip");
  assert.match(decision.reason, /unmarked domain/);
});

test("classify skips a foreign ephemeral-test token", () => {
  const decision = classifyForCleanup(ownedResource("r1"), { expectedToken: FOREIGN_TOKEN });
  assert.equal(decision.action, "skip");
  assert.match(decision.reason, /foreign ephemeral-test token/);
});

test("runFencedCleanup cleans owned resources and reports success", async () => {
  const cleaned = [];
  const result = await runFencedCleanup({
    resources: [ownedResource("r1"), ownedResource("r2")],
    expectedToken: OWNED_TOKEN,
    clean: async (resource) => { cleaned.push(resource.id); }
  });
  assert.equal(result.ok, true);
  assert.deepEqual(result.cleaned, ["r1", "r2"]);
  assert.deepEqual(cleaned, ["r1", "r2"]);
  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.skipped, []);
});

test("runFencedCleanup with a missing token touches nothing AND reports a FAILED outcome", async () => {
  const touched = [];
  const result = await runFencedCleanup({
    resources: [ownedResource("r1"), ownedResource("r2")],
    // expectedToken deliberately omitted
    clean: async (resource) => { touched.push(resource.id); }
  });
  // Still touches nothing …
  assert.deepEqual(touched, []);
  assert.deepEqual(result.cleaned, []);
  // … every resource is skipped for the missing token …
  assert.equal(result.skipped.length, 2);
  assert.ok(result.skipped.every((entry) => /missing ephemeral-test ownership token/.test(entry.reason)));
  // … but the pass is a FAILURE, not a silent success: a pass-level error is
  // recorded so registered teardown fails instead of leaking owned resources.
  assert.equal(result.ok, false);
  const passError = result.errors.find((entry) => entry.id === CLEANUP_PASS_ID);
  assert.ok(passError, "expected a pass-level cleanup error");
  assert.match(passError.message, /missing ephemeral-test ownership token/);
  assert.match(passError.message, /failed cleanup outcome/);
});

test("an empty token is likewise a FAILED cleanup outcome", async () => {
  const result = await runFencedCleanup({
    resources: [ownedResource("r1")],
    expectedToken: "",
    clean: async () => {}
  });
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((entry) => entry.id === CLEANUP_PASS_ID));
});

test("runFencedCleanup never invokes the cleaner for unmarked/protected/foreign resources", async () => {
  const touched = [];
  const result = await runFencedCleanup({
    resources: [
      ownedResource("owned"),
      { id: "unmarked", disposition: "safe", domain: { kind: "unmarked" } },
      { id: "protected", disposition: "protected", domain: { kind: "ephemeral-test", token: OWNED_TOKEN } },
      ownedResource("foreign", { domain: { kind: "ephemeral-test", token: FOREIGN_TOKEN } }),
      { id: "report-only", disposition: "report-only" }
    ],
    expectedToken: OWNED_TOKEN,
    clean: async (resource) => { touched.push(resource.id); }
  });
  // Exactly one resource — the owned one — is ever passed to the cleaner.
  assert.deepEqual(touched, ["owned"]);
  assert.deepEqual(result.cleaned, ["owned"]);
  assert.deepEqual(result.skipped.map((entry) => entry.id).sort(), ["foreign", "protected", "report-only", "unmarked"]);
  assert.equal(result.ok, true);
});

test("a cleanup error is remembered but does not strand other resources", async () => {
  const cleaned = [];
  const result = await runFencedCleanup({
    resources: [ownedResource("first"), ownedResource("boom"), ownedResource("third")],
    expectedToken: OWNED_TOKEN,
    clean: async (resource) => {
      if (resource.id === "boom") throw new Error("resource changed since scan");
      cleaned.push(resource.id);
    }
  });
  assert.equal(result.ok, false);
  // The pass keeps converging past the failure.
  assert.deepEqual(cleaned, ["first", "third"]);
  assert.deepEqual(result.cleaned, ["first", "third"]);
  assert.equal(result.errors.length, 1);
  assert.equal(result.errors[0].id, "boom");
  assert.match(result.errors[0].message, /changed since scan/);
});

test("registerFencedCleanup runs a fail-closed pass from teardown and surfaces the result", async () => {
  // Simulate node:test TestContext.after by capturing the registered hook.
  let hook;
  const fakeContext = { after: (fn) => { hook = fn; } };
  let observed;
  const touched = [];

  registerFencedCleanup(
    fakeContext,
    async () => ({
      resources: [
        ownedResource("owned"),
        { id: "foreign", disposition: "safe", domain: { kind: "ephemeral-test", token: FOREIGN_TOKEN } }
      ],
      expectedToken: OWNED_TOKEN,
      clean: async (resource) => { touched.push(resource.id); }
    }),
    { onResult: (result) => { observed = result; } }
  );

  assert.equal(typeof hook, "function");
  await hook();

  assert.deepEqual(touched, ["owned"]);
  assert.equal(observed.ok, true);
  assert.deepEqual(observed.cleaned, ["owned"]);
  assert.deepEqual(observed.skipped.map((entry) => entry.id), ["foreign"]);
});

test("registerFencedCleanup throws from teardown when a cleanup error remains", async () => {
  let hook;
  const fakeContext = { after: (fn) => { hook = fn; } };
  registerFencedCleanup(
    fakeContext,
    async () => ({
      resources: [ownedResource("boom")],
      expectedToken: OWNED_TOKEN,
      clean: async () => { throw new Error("still wedged"); }
    })
  );
  await assert.rejects(() => hook(), /fenced cleanup left errors: boom: still wedged/);
});

test("REGRESSION: registerFencedCleanup teardown FAILS when the token is missing (no silent leak)", async () => {
  // The reproduced blocker: default teardown must not pass while owned resources
  // are skipped for a missing token. It touches nothing, but it throws.
  let hook;
  const fakeContext = { after: (fn) => { hook = fn; } };
  let observed;
  const touched = [];
  registerFencedCleanup(
    fakeContext,
    async () => ({
      resources: [ownedResource("owned-1"), ownedResource("owned-2")],
      // expectedToken deliberately omitted — the factory could not resolve one.
      clean: async (resource) => { touched.push(resource.id); }
    }),
    { onResult: (result) => { observed = result; } }
  );
  await assert.rejects(() => hook(), /missing ephemeral-test ownership token/);
  // Nothing was touched, and the surfaced result is an explicit failure.
  assert.deepEqual(touched, []);
  assert.equal(observed.ok, false);
  assert.ok(observed.errors.some((entry) => entry.id === CLEANUP_PASS_ID));
});

test("registered teardown does NOT throw for intentional foreign/protected skips with a valid token", async () => {
  // The complement: with a valid token present, skipping resources that are
  // simply not ours (foreign token, protected, report-only) is a clean pass.
  let hook;
  const fakeContext = { after: (fn) => { hook = fn; } };
  let observed;
  registerFencedCleanup(
    fakeContext,
    async () => ({
      resources: [
        { id: "foreign", disposition: "safe", domain: { kind: "ephemeral-test", token: FOREIGN_TOKEN } },
        { id: "protected", disposition: "protected", domain: { kind: "ephemeral-test", token: OWNED_TOKEN } },
        { id: "report-only", disposition: "report-only" }
      ],
      expectedToken: OWNED_TOKEN,
      clean: async () => {}
    }),
    { onResult: (result) => { observed = result; } }
  );
  // Does not throw.
  await hook();
  assert.equal(observed.ok, true);
  assert.deepEqual(observed.cleaned, []);
  assert.deepEqual(observed.skipped.map((entry) => entry.id).sort(), ["foreign", "protected", "report-only"]);
  assert.deepEqual(observed.errors, []);
});
