import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdtempSync, mkdirSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import { yuiTmuxServerName } from "../../dist/tmux/tmuxManager.js";
import {
  CHECKOUT_DEV_HOME,
  CHECKOUT_LOCAL_LAUNCHER,
  MANAGED_LAUNCHER_MARKER,
  RUN_ROOT_OWNER_MARKER,
  assertIsolationReady,
  createOwnedRunRoot,
  evaluateIsolationPreflight,
  evaluatePhysicalContainment,
  gatherRunRootOwnership,
  recordActiveSessionObservation
} from "../helpers/isolationPreflight.js";

// The total number of invariants the evaluator checks. Kept as a named constant
// so the "accepts a fully isolated descriptor" test documents the exact count.
const TOTAL_CHECKS = 11;

// A fully isolated descriptor that must pass every invariant. Individual tests
// mutate exactly one fact to prove each rejection in isolation.
function isolatedDescriptor(overrides = {}) {
  const checkoutRoot = "/checkout/yui";
  const temporaryBase = "/tmp";
  const runRoot = "/tmp/yui-run-abc";
  const yuiHome = join(runRoot, "yui-home");
  return {
    checkoutRoot,
    runRoot,
    runRootOwnership: {
      isTemporary: true,
      ownedByRun: true,
      temporaryBase,
      evidence: "mkdtemp under /tmp by this run"
    },
    launcher: {
      path: join(checkoutRoot, CHECKOUT_LOCAL_LAUNCHER),
      exists: true,
      isSymbolicLink: false,
      isRegularFile: true,
      secondLine: MANAGED_LAUNCHER_MARKER
    },
    yuiHome,
    workspace: join(runRoot, "workspace"),
    npmPrefix: join(runRoot, "npm-prefix"),
    globalNpmPrefix: "/usr/local",
    tmuxServer: yuiTmuxServerName(yuiHome),
    protectedHomes: [join(checkoutRoot, CHECKOUT_DEV_HOME), "/home/dev/.yui"],
    activeSessionObservation: { observed: true, sessions: [], source: "test observer" },
    ...overrides
  };
}

function checkNamed(result, name) {
  const check = result.checks.find((entry) => entry.name === name);
  assert.ok(check, `expected a check named ${name}`);
  return check;
}

test("accepts a fully isolated Provider/Release descriptor", () => {
  const result = evaluateIsolationPreflight(isolatedDescriptor());
  assert.equal(result.ok, true, result.rejections.join("\n"));
  assert.deepEqual(result.rejections, []);
  // Every declared invariant is present and passing.
  assert.equal(result.checks.length, TOTAL_CHECKS);
  assert.ok(result.checks.every((check) => check.ok));
});

test("rejects a bare `yui` resolved through PATH", () => {
  const result = evaluateIsolationPreflight(isolatedDescriptor({
    launcher: {
      path: "yui",
      exists: true,
      isSymbolicLink: false,
      isRegularFile: true,
      secondLine: MANAGED_LAUNCHER_MARKER
    }
  }));
  assert.equal(result.ok, false);
  assert.equal(checkNamed(result, "launcher-absolute-path").ok, false);
  assert.equal(checkNamed(result, "launcher-checkout-local").ok, false);
});

test("rejects the make-link global launcher (a symlink)", () => {
  const result = evaluateIsolationPreflight(isolatedDescriptor({
    launcher: {
      path: "/home/dev/.local/bin/yui",
      exists: true,
      isSymbolicLink: true,
      isRegularFile: false,
      secondLine: null
    }
  }));
  assert.equal(result.ok, false);
  assert.equal(checkNamed(result, "launcher-regular-file").ok, false);
  assert.equal(checkNamed(result, "launcher-checkout-local").ok, false);
});

test("rejects a launcher without the managed marker", () => {
  const result = evaluateIsolationPreflight(isolatedDescriptor({
    launcher: {
      path: join("/checkout/yui", CHECKOUT_LOCAL_LAUNCHER),
      exists: true,
      isSymbolicLink: false,
      isRegularFile: true,
      secondLine: "#!/bin/sh"
    }
  }));
  assert.equal(result.ok, false);
  assert.equal(checkNamed(result, "launcher-managed-marker").ok, false);
});

test("rejects a missing run-root ownership proof (no arbitrary absolute parent)", () => {
  const result = evaluateIsolationPreflight(isolatedDescriptor({
    runRootOwnership: undefined
  }));
  assert.equal(result.ok, false);
  const check = checkNamed(result, "run-root-owned-temporary");
  assert.equal(check.ok, false);
  assert.match(check.detail, /ownership proof is missing/);
  // Because the run root is not provably owned, the derived checks fail closed
  // too rather than trusting the same parent.
  assert.equal(checkNamed(result, "yui-home-disposable").ok, false);
  assert.equal(checkNamed(result, "npm-prefix-isolated").ok, false);
});

test("rejects an incomplete/ambiguous ownership proof", () => {
  const result = evaluateIsolationPreflight(isolatedDescriptor({
    // ownedByRun omitted → ambiguous → rejected.
    runRootOwnership: { isTemporary: true, temporaryBase: "/tmp" }
  }));
  assert.equal(result.ok, false);
  const check = checkNamed(result, "run-root-owned-temporary");
  assert.equal(check.ok, false);
  assert.match(check.detail, /ownership proof is incomplete/);
});

test("rejects a run root that does not resolve inside its declared temporary base", () => {
  const result = evaluateIsolationPreflight(isolatedDescriptor({
    runRoot: "/var/data/not-temp",
    runRootOwnership: {
      isTemporary: true,
      ownedByRun: true,
      temporaryBase: "/tmp"
    },
    // Keep the derived paths under the (bogus) run root so ONLY the ownership
    // proof is what fails.
    yuiHome: "/var/data/not-temp/yui-home",
    workspace: "/var/data/not-temp/workspace",
    npmPrefix: "/var/data/not-temp/npm-prefix",
    tmuxServer: yuiTmuxServerName("/var/data/not-temp/yui-home")
  }));
  assert.equal(result.ok, false);
  const check = checkNamed(result, "run-root-owned-temporary");
  assert.equal(check.ok, false);
  assert.match(check.detail, /strictly inside its temporary base/);
});

test("rejects a shared YUI_HOME (checkout dev home)", () => {
  const result = evaluateIsolationPreflight(isolatedDescriptor({
    yuiHome: join("/checkout/yui", CHECKOUT_DEV_HOME)
  }));
  assert.equal(result.ok, false);
  assert.equal(checkNamed(result, "yui-home-disposable").ok, false);
});

test("rejects a YUI_HOME outside the disposable run root", () => {
  const result = evaluateIsolationPreflight(isolatedDescriptor({
    yuiHome: "/home/dev/somewhere-else"
  }));
  assert.equal(result.ok, false);
  assert.equal(checkNamed(result, "yui-home-disposable").ok, false);
});

test("rejects the global npm prefix", () => {
  const result = evaluateIsolationPreflight(isolatedDescriptor({
    npmPrefix: "/usr/local",
    globalNpmPrefix: "/usr/local"
  }));
  assert.equal(result.ok, false);
  assert.equal(checkNamed(result, "npm-prefix-isolated").ok, false);
});

test("rejects when the global npm prefix cannot be resolved", () => {
  const result = evaluateIsolationPreflight(isolatedDescriptor({
    globalNpmPrefix: null
  }));
  assert.equal(result.ok, false);
  assert.equal(checkNamed(result, "npm-prefix-isolated").ok, false);
});

test("rejects a smuggled tmux namespace that is not derived from the home", () => {
  const result = evaluateIsolationPreflight(isolatedDescriptor({
    tmuxServer: "yui-deadbeefdeadbeefdeadbeef"
  }));
  assert.equal(result.ok, false);
  assert.equal(checkNamed(result, "namespace-unique").ok, false);
});

test("rejects a missing active-Session observation (fail-closed, not assumed-empty)", () => {
  const result = evaluateIsolationPreflight(isolatedDescriptor({
    activeSessionObservation: undefined
  }));
  assert.equal(result.ok, false);
  const check = checkNamed(result, "no-active-production-session");
  assert.equal(check.ok, false);
  assert.match(check.detail, /observation is missing or unconfirmed/);
});

test("rejects an unconfirmed observation (observed:false) rather than trusting its empty list", () => {
  const result = evaluateIsolationPreflight(isolatedDescriptor({
    activeSessionObservation: { observed: false, sessions: [] }
  }));
  assert.equal(result.ok, false);
  assert.equal(checkNamed(result, "no-active-production-session").ok, false);
});

test("accepts only an explicit observation of zero Sessions", () => {
  const result = evaluateIsolationPreflight(isolatedDescriptor({
    activeSessionObservation: { observed: true, sessions: [], source: "tmux ls" }
  }));
  assert.equal(result.ok, true, result.rejections.join("\n"));
  assert.equal(checkNamed(result, "no-active-production-session").ok, true);
});

test("rejects running while an active production Session exists", () => {
  const result = evaluateIsolationPreflight(isolatedDescriptor({
    activeSessionObservation: { observed: true, sessions: ["task-9/worker"] }
  }));
  assert.equal(result.ok, false);
  assert.equal(checkNamed(result, "no-active-production-session").ok, false);
});

test("aggregates every failure reason at once (no early exit / no fallback)", () => {
  const result = evaluateIsolationPreflight({
    checkoutRoot: "/checkout/yui",
    runRoot: "relative-run-root",
    runRootOwnership: undefined,
    launcher: { path: "yui", exists: false, isSymbolicLink: false, isRegularFile: false, secondLine: null },
    yuiHome: "/etc",
    workspace: "also-relative",
    npmPrefix: "/usr/local",
    globalNpmPrefix: "/usr/local",
    tmuxServer: "not-derived",
    protectedHomes: [],
    activeSessionObservation: undefined
  });
  assert.equal(result.ok, false);
  // Many invariants fail together; the report lists them rather than stopping
  // at the first.
  assert.ok(result.rejections.length >= 8, `expected many rejections, got ${result.rejections.length}`);
});

test("recordActiveSessionObservation demands a real array and marks it observed", () => {
  assert.throws(() => recordActiveSessionObservation({}), /explicit sessions array/);
  const observation = recordActiveSessionObservation({ sessions: [], source: "tmux ls" });
  assert.equal(observation.observed, true);
  assert.deepEqual(observation.sessions, []);
  assert.equal(observation.source, "tmux ls");
});

// ---------------------------------------------------------------------------
// Blocker 1 regressions: creator-bound ownership + physical containment.
//
// These drive the real filesystem (a fresh temp base per test) because the
// vulnerability is physical: a symlink run root and lexically-nested paths that
// escape via symlinks both pass a purely lexical check. Each test cleans up its
// own temp base.
// ---------------------------------------------------------------------------

function withTempBase(fn) {
  // Canonicalize so realpath comparisons inside the helper are stable even when
  // the OS temp dir is itself a symlink (e.g. macOS /tmp -> /private/tmp).
  const base = realpathSync(mkdtempSync(join(tmpdir(), "yui-preflight-test-")));
  try {
    return fn(base);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
}

test("createOwnedRunRoot creates an exact owned temp root that proves itself at preflight", () => {
  withTempBase((base) => {
    const owned = createOwnedRunRoot({ temporaryBase: base });
    // The supported normal path returns a real directory under the temp base,
    // its canonical path, and the token that proves ownership.
    assert.equal(owned.ownership.isTemporary, true);
    assert.equal(owned.ownership.ownedByRun, true);
    assert.equal(owned.canonicalRunRoot, realpathSync(owned.runRoot));

    // Re-proving the SAME root with the SAME token succeeds …
    const proof = gatherRunRootOwnership({
      runRoot: owned.canonicalRunRoot,
      temporaryBase: base,
      expectedToken: owned.token
    });
    assert.equal(proof.ownedByRun, true);

    // … but the exact created root is only owned when the token matches.
    const wrongToken = gatherRunRootOwnership({
      runRoot: owned.canonicalRunRoot,
      temporaryBase: base,
      expectedToken: "0".repeat(64)
    });
    assert.equal(wrongToken.ownedByRun, false);
    assert.match(wrongToken.evidence, /token does not match/);
  });
});

test("REGRESSION: an unrelated pre-existing temp directory is NOT owned (no receipt)", () => {
  withTempBase((base) => {
    // A foreign directory that merely exists lexically under the temp base.
    const foreign = join(base, "someone-elses-dir");
    mkdirSync(foreign);
    const proof = gatherRunRootOwnership({
      runRoot: foreign,
      temporaryBase: base,
      expectedToken: "any-token-we-like"
    });
    // Existence under tmp is NOT proof this run created it.
    assert.equal(proof.ownedByRun, false);
    assert.match(proof.evidence, /no creator-bound ownership receipt/);

    // Even planting a receipt with a DIFFERENT token is refused.
    writeFileSync(join(foreign, RUN_ROOT_OWNER_MARKER), JSON.stringify({ token: "not-ours" }));
    const stillForeign = gatherRunRootOwnership({
      runRoot: foreign,
      temporaryBase: base,
      expectedToken: "ours"
    });
    assert.equal(stillForeign.ownedByRun, false);
  });
});

test("REGRESSION: a symlink run root pointing at the checkout is rejected (the reproduced escape)", () => {
  withTempBase((base) => {
    // Simulate the WorkItem checkout with a real directory outside the run root.
    const fakeCheckout = realpathSync(mkdtempSync(join(tmpdir(), "yui-fake-checkout-")));
    try {
      // A symlink UNDER a fresh temp base that points at the checkout. Lexically
      // it looks like `<base>/run-root`; physically it is the checkout.
      const symlinkRunRoot = join(base, "run-root");
      symlinkSync(fakeCheckout, symlinkRunRoot);

      const proof = gatherRunRootOwnership({
        runRoot: symlinkRunRoot,
        temporaryBase: base,
        expectedToken: "whatever"
      });
      // The old code followed the symlink via statSync and returned ownedByRun
      // true; now a symlink run root is refused outright.
      assert.equal(proof.ownedByRun, false);
      assert.match(proof.evidence, /symbolic link/);
    } finally {
      rmSync(fakeCheckout, { recursive: true, force: true });
    }
  });
});

test("REGRESSION: assertIsolationReady rejects derived paths that symlink-escape a real owned root", () => {
  withTempBase((base) => {
    const escapeTarget = realpathSync(mkdtempSync(join(tmpdir(), "yui-escape-target-")));
    try {
      const owned = createOwnedRunRoot({ temporaryBase: base });
      const runRoot = owned.canonicalRunRoot;

      // A YUI_HOME that lexically sits inside the owned run root, but whose
      // parent component is a symlink OUT to escapeTarget.
      const trap = join(runRoot, "home-link");
      symlinkSync(escapeTarget, trap);
      const escapingHome = join(trap, "yui-home");

      const checkoutRoot = join(base, "checkout");
      mkdirSync(join(checkoutRoot, "output", "dev", "bin"), { recursive: true });
      const launcherPath = join(checkoutRoot, CHECKOUT_LOCAL_LAUNCHER);
      writeFileSync(launcherPath, `#!/usr/bin/env node\n${MANAGED_LAUNCHER_MARKER}\n`);

      assert.throws(
        () => assertIsolationReady({
          checkoutRoot,
          runRoot,
          runRootOwnership: owned.ownership,
          launcherPath,
          yuiHome: escapingHome,
          workspace: join(runRoot, "workspace"),
          npmPrefix: join(runRoot, "npm-prefix"),
          globalNpmPrefix: "/usr/local",
          activeSessionObservation: { observed: true, sessions: [], source: "test" }
        }),
        /physical-containment:yui-home|physically escapes/
      );
    } finally {
      rmSync(escapeTarget, { recursive: true, force: true });
    }
  });
});

test("assertIsolationReady accepts a fully valid exact-created owned root end to end", () => {
  withTempBase((base) => {
    const owned = createOwnedRunRoot({ temporaryBase: base });
    const runRoot = owned.canonicalRunRoot;
    const checkoutRoot = join(base, "checkout");
    mkdirSync(join(checkoutRoot, "output", "dev", "bin"), { recursive: true });
    const launcherPath = join(checkoutRoot, CHECKOUT_LOCAL_LAUNCHER);
    writeFileSync(launcherPath, `#!/usr/bin/env node\n${MANAGED_LAUNCHER_MARKER}\n`);

    const yuiHome = join(runRoot, "yui-home");
    const result = assertIsolationReady({
      checkoutRoot,
      runRoot,
      runRootOwnership: owned.ownership,
      launcherPath,
      yuiHome,
      workspace: join(runRoot, "workspace"),
      npmPrefix: join(runRoot, "npm-prefix"),
      globalNpmPrefix: "/usr/local",
      tmuxServer: yuiTmuxServerName(yuiHome),
      activeSessionObservation: { observed: true, sessions: [], source: "test" }
    });
    assert.equal(result.ok, true, result.rejections.join("\n"));
    // The physical containment checks are present and passing.
    assert.ok(result.checks.some((c) => c.name === "physical-containment:yui-home" && c.ok));
    assert.ok(result.checks.some((c) => c.name === "physical-containment:npm-prefix" && c.ok));
  });
});

test("evaluatePhysicalContainment rejects a lexically-nested but physically-escaping path", () => {
  withTempBase((base) => {
    const owned = createOwnedRunRoot({ temporaryBase: base });
    const runRoot = owned.canonicalRunRoot;
    const escapeTarget = realpathSync(mkdtempSync(join(tmpdir(), "yui-escape-")));
    try {
      const trap = join(runRoot, "link");
      symlinkSync(escapeTarget, trap);
      const result = evaluatePhysicalContainment({
        canonicalRunRoot: runRoot,
        paths: {
          good: join(runRoot, "sub", "leaf"),
          bad: join(trap, "leaf")
        }
      });
      assert.equal(result.ok, false);
      assert.equal(result.checks.find((c) => c.name === "physical-containment:good").ok, true);
      assert.equal(result.checks.find((c) => c.name === "physical-containment:bad").ok, false);
    } finally {
      rmSync(escapeTarget, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// Candidate 3 regressions: two run-root defects.
//
// (1) canonicalizeExisting caught ALL realpathSync failures and stripped the
//     component, so a DANGLING symlink (its target does not yet exist) was
//     mistaken for an ordinary not-yet-created leaf and a derived YUI_HOME below
//     it passed physical containment. A symlink is an existing component even
//     when its target is absent, so it must fail closed.
// (2) createOwnedRunRoot accepted a traversal prefix (`../escaped-run-`) and
//     mkdtempSync created the directory OUTSIDE the requested base before
//     ownership later reported false.
// ---------------------------------------------------------------------------

test("REGRESSION: a derived YUI_HOME below a DANGLING symlink fails physical containment (target absent)", () => {
  withTempBase((base) => {
    const owned = createOwnedRunRoot({ temporaryBase: base });
    const runRoot = owned.canonicalRunRoot;

    // A symlink inside the owned run root whose target does NOT exist yet. The
    // link itself exists; realpathSync throws ENOENT resolving it, but lstat
    // says it is present, so it must not be treated as an ordinary missing leaf.
    const danglingTarget = join(base, "does-not-exist-yet");
    const danglingLink = join(runRoot, "home-link");
    symlinkSync(danglingTarget, danglingLink);
    const escapingHome = join(danglingLink, "yui-home");

    // evaluatePhysicalContainment must refuse the path (fail closed) …
    const contain = evaluatePhysicalContainment({
      canonicalRunRoot: runRoot,
      paths: { "yui-home": escapingHome }
    });
    assert.equal(contain.ok, false);
    assert.equal(contain.checks.find((c) => c.name === "physical-containment:yui-home").ok, false);

    // … and an ordinary not-yet-created leaf under the real run root still passes.
    const contain2 = evaluatePhysicalContainment({
      canonicalRunRoot: runRoot,
      paths: { workspace: join(runRoot, "not-created-yet", "workspace") }
    });
    assert.equal(contain2.ok, true);

    // End to end: assertIsolationReady must reject the dangling-link YUI_HOME.
    const checkoutRoot = join(base, "checkout");
    mkdirSync(join(checkoutRoot, "output", "dev", "bin"), { recursive: true });
    const launcherPath = join(checkoutRoot, CHECKOUT_LOCAL_LAUNCHER);
    writeFileSync(launcherPath, `#!/usr/bin/env node\n${MANAGED_LAUNCHER_MARKER}\n`);
    assert.throws(
      () => assertIsolationReady({
        checkoutRoot,
        runRoot,
        runRootOwnership: owned.ownership,
        launcherPath,
        yuiHome: escapingHome,
        workspace: join(runRoot, "workspace"),
        npmPrefix: join(runRoot, "npm-prefix"),
        globalNpmPrefix: "/usr/local",
        activeSessionObservation: { observed: true, sessions: [], source: "test" }
      }),
      /physical-containment:yui-home|physically escapes|refusing symlink escape/
    );
  });
});

test("REGRESSION: a derived YUI_HOME below an EACCES-blocked directory fails closed (same uid)", () => {
  withTempBase((base) => {
    const owned = createOwnedRunRoot({ temporaryBase: base });
    const runRoot = owned.canonicalRunRoot;

    // An escape symlink to an outside target, placed BEHIND a directory we will
    // chmod 000. The blocked dir denies traversal, so realpathSync(escape) and
    // lstatSync(escape) both throw EACCES (not ENOENT) for the same uid. The
    // Candidate-4 bug stripped on any lstat failure and wrongly reported the
    // path contained; the fix must fail closed (null) on a non-ENOENT error.
    const outsideTarget = join(base, "outside-target");
    mkdirSync(outsideTarget);
    const blocked = join(runRoot, "blocked");
    mkdirSync(blocked);
    const escape = join(blocked, "escape");
    symlinkSync(outsideTarget, escape);
    const escapingHome = join(escape, "yui-home");

    // Gate on ESTABLISHED POSIX permission semantics: if chmod 000 does not
    // actually deny traversal for this process (e.g. running as root, or a
    // filesystem that ignores mode bits), we cannot establish the EACCES
    // precondition, so skip rather than assert a condition we did not create.
    // This does not weaken Linux non-root coverage, where the deny holds.
    let denialEstablished = false;
    try {
      chmodSync(blocked, 0o000);
      try {
        // If we can still resolve through the blocked dir, denial did not take.
        realpathSync(escape);
        denialEstablished = false;
      } catch (error) {
        denialEstablished = error?.code === "EACCES" || error?.code === "EPERM";
      }

      if (!denialEstablished) {
        // Restore happens in finally; nothing to assert on this platform.
        return;
      }

      // evaluatePhysicalContainment must reject the escape symlink and the
      // derived YUI_HOME below it — both are behind the blocked dir, so their
      // existing components are unresolvable (EACCES, not ENOENT) → fail closed.
      const contain = evaluatePhysicalContainment({
        canonicalRunRoot: runRoot,
        paths: {
          escape,
          "yui-home": escapingHome,
          "blocked-child": join(blocked, "child")
        }
      });
      assert.equal(contain.ok, false);
      assert.equal(contain.checks.find((c) => c.name === "physical-containment:escape").ok, false);
      assert.equal(contain.checks.find((c) => c.name === "physical-containment:yui-home").ok, false);
      // A not-yet-created child THROUGH the blocked dir is refused too: its
      // existing ancestor (blocked) denies traversal, so it is ambiguous, not a
      // clean ENOENT missing leaf.
      assert.equal(contain.checks.find((c) => c.name === "physical-containment:blocked-child").ok, false);
    } finally {
      // Exact cleanup: restore permissions so withTempBase can remove the tree.
      chmodSync(blocked, 0o700);
    }
  });
});

test("a valid not-yet-created ordinary leaf is still accepted end to end", () => {
  withTempBase((base) => {
    const owned = createOwnedRunRoot({ temporaryBase: base });
    const runRoot = owned.canonicalRunRoot;
    const checkoutRoot = join(base, "checkout");
    mkdirSync(join(checkoutRoot, "output", "dev", "bin"), { recursive: true });
    const launcherPath = join(checkoutRoot, CHECKOUT_LOCAL_LAUNCHER);
    writeFileSync(launcherPath, `#!/usr/bin/env node\n${MANAGED_LAUNCHER_MARKER}\n`);

    // A YUI_HOME several segments deep that does not exist yet, with NO symlink
    // anywhere on the path — the legitimate "about to be created" case.
    const yuiHome = join(runRoot, "deep", "not", "created", "yui-home");
    const result = assertIsolationReady({
      checkoutRoot,
      runRoot,
      runRootOwnership: owned.ownership,
      launcherPath,
      yuiHome,
      workspace: join(runRoot, "workspace"),
      npmPrefix: join(runRoot, "npm-prefix"),
      globalNpmPrefix: "/usr/local",
      tmuxServer: yuiTmuxServerName(yuiHome),
      activeSessionObservation: { observed: true, sessions: [], source: "test" }
    });
    assert.equal(result.ok, true, result.rejections.join("\n"));
    assert.ok(result.checks.some((c) => c.name === "physical-containment:yui-home" && c.ok));
  });
});

test("REGRESSION: createOwnedRunRoot rejects a traversal prefix and creates NOTHING outside the base", () => {
  // Everything is confined to a dedicated test-owned OUTER directory. The
  // requested base is a nested child of it, so a traversal prefix
  // (`../escaped-run-`) would land in the OUTER directory — which we own and can
  // enumerate safely. We NEVER enumerate the shared tmpdir().
  const outer = realpathSync(mkdtempSync(join(tmpdir(), "yui-traversal-outer-")));
  try {
    const base = join(outer, "base");
    mkdirSync(base);

    // Snapshot the owned outer directory before the attempt.
    const before = new Set(readdirSync(outer));

    assert.throws(
      () => createOwnedRunRoot({ temporaryBase: base, prefix: "../escaped-run-" }),
      /unsafe run-root prefix|single path segment/
    );

    // Nothing new appeared in the owned outer directory (where a traversal would
    // have landed) …
    const after = readdirSync(outer).filter((entry) => !before.has(entry));
    assert.deepEqual(
      after,
      [],
      `expected no new entry in the owned outer dir ${outer}, found ${JSON.stringify(after)}`
    );
    // … and the requested base itself gained no run root either.
    assert.deepEqual(readdirSync(base), []);
  } finally {
    rmSync(outer, { recursive: true, force: true });
  }
});

test("createOwnedRunRoot rejects other unsafe prefixes (absolute, nested segment, dot)", () => {
  withTempBase((base) => {
    for (const prefix of ["/abs-run-", "nested/run-", "..", ".", "a/b"]) {
      assert.throws(
        () => createOwnedRunRoot({ temporaryBase: base, prefix }),
        /unsafe run-root prefix|single path segment/,
        `expected ${JSON.stringify(prefix)} to be rejected`
      );
    }
    // A valid single-segment prefix still works and lands inside the base.
    const owned = createOwnedRunRoot({ temporaryBase: base, prefix: "ok-run-" });
    assert.equal(owned.ownership.ownedByRun, true);
    assert.ok(existsSync(owned.canonicalRunRoot));
    assert.equal(dirname(owned.canonicalRunRoot), base);
  });
});
