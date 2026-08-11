import assert from "node:assert/strict";
import test from "node:test";

import { ensureDistBuilt } from "../helpers/ensureBuild.js";

test("the tier boundary rebuilds even when dist/cli.js already exists", () => {
  let builderCalls = 0;
  const logs = [];
  const result = ensureDistBuilt({
    build: () => { builderCalls += 1; return { status: 0 }; },
    log: (message) => logs.push(message)
  });

  assert.equal(builderCalls, 1, "a present marker must not bypass the build boundary");
  assert.equal(result.built, true);
  assert.equal(result.exitCode, 0);
  assert.match(result.reason, /completed/);
  assert.ok(logs.some((line) => /fresh dist build/i.test(line)));
});

test("the tier boundary builds exactly once when dist is absent", () => {
  let builderCalls = 0;
  const result = ensureDistBuilt({
    build: () => { builderCalls += 1; return { status: 0 }; }
  });

  assert.equal(builderCalls, 1);
  assert.equal(result.built, true);
  assert.equal(result.exitCode, 0);
});

test("a missing builder fails closed rather than running a tier against unknown dist", () => {
  const result = ensureDistBuilt({});
  assert.equal(result.built, false);
  assert.equal(result.exitCode, 1);
  assert.match(result.reason, /no builder available/);
});

test("a nonzero build status is surfaced as a nonzero exit code", () => {
  const result = ensureDistBuilt({
    build: () => ({ status: 2 })
  });
  assert.equal(result.built, false);
  assert.equal(result.exitCode, 2);
  assert.match(result.reason, /exited with status 2/);
});

test("a build that fails to spawn is reported, not swallowed", () => {
  const result = ensureDistBuilt({
    build: () => ({ error: new Error("spawn npm ENOENT") })
  });
  assert.equal(result.built, false);
  assert.equal(result.exitCode, 1);
  assert.match(result.reason, /failed to start: spawn npm ENOENT/);
});

test("a null build status is a fail-closed error", () => {
  const result = ensureDistBuilt({
    build: () => ({ status: null })
  });
  assert.equal(result.built, false);
  assert.equal(result.exitCode, 1);
});
