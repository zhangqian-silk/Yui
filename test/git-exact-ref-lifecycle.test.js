import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import {
  GitExactRefLifecycleCoordinator
} from "../dist/worktree/gitExactRefLifecycle.js";
import {
  createGitRepositoryLineage
} from "../dist/worktree/gitResourceLedger.js";

const SHA1_A = "a".repeat(40);
const SHA1_B = "b".repeat(40);
const fixtureUuid = (sequence) =>
  `00000000-0000-4000-8000-${String(sequence).padStart(12, "0")}`;

test("the coordinator's trusted clock blocks an expired owner before the physical Git effect", (t) => {
  const fixture = createFixture();
  t.after(fixture.cleanup);
  const fullRef = "refs/heads/trusted-clock";
  writeText(fixture.pathFor(fullRef), `${SHA1_A}\n`);

  const clock = createFakeClock(0);
  const lifecycle = new GitExactRefLifecycleCoordinator(fixture.home, clock.now);
  const operation = lifecycle.prepareExactRefRetirement({
    operationId: fixtureUuid(201),
    repository: fixture.repository(),
    fullRef,
    expectedOid: SHA1_A
  });
  const claim = lifecycle.claim(
    operation.operationId,
    fixtureUuid(202),
    10
  );
  lifecycle.begin(operation.operationId, claim);

  clock.set(10);
  assert.throws(
    () => lifecycle.execute(operation.operationId, claim),
    /lease has expired|claim/i
  );
  assert.equal(readFileSync(fixture.pathFor(fullRef), "utf8"), `${SHA1_A}\n`);
  const stranded = lifecycle.get(operation.operationId);
  assert.equal(stranded.phase, "effect-started");
  assert.deepEqual(stranded.claim, claim);
  assert.equal(stranded.receipt, null);
});

test("an owner that expires after the physical Git effect cannot publish completion", (t) => {
  const fixture = createFixture();
  t.after(fixture.cleanup);
  const fullRef = "refs/heads/post-effect-expiry";
  writeText(fixture.pathFor(fullRef), `${SHA1_B}\n`);

  const clock = createFakeClock(0);
  const lifecycle = new GitExactRefLifecycleCoordinator(fixture.home, clock.now);
  const operation = lifecycle.prepareExactRefRetirement({
    operationId: fixtureUuid(203),
    repository: fixture.repository(),
    fullRef,
    expectedOid: SHA1_B
  });
  const ownerA = fixtureUuid(204);
  const ownerB = fixtureUuid(205);
  const claimA = lifecycle.claim(operation.operationId, ownerA, 10);
  lifecycle.begin(operation.operationId, claimA);

  clock.script(9, 10);
  assert.throws(
    () => lifecycle.execute(operation.operationId, claimA),
    /lease has expired|claim/i
  );
  assert.equal(existsSync(fixture.pathFor(fullRef)), false);
  const stranded = lifecycle.get(operation.operationId);
  assert.equal(stranded.phase, "effect-started");
  assert.deepEqual(stranded.claim, claimA);
  assert.equal(stranded.receipt, null);

  clock.set(11);
  assert.deepEqual(
    lifecycle.recover(ownerB, 1_000),
    [{ operationId: operation.operationId, status: "completed" }]
  );
  const completed = lifecycle.get(operation.operationId);
  assert.equal(completed.phase, "completed");
  assert.equal(completed.claim.ownerId, ownerB);
  assert.equal(completed.claim.generation, 2);
  assert.equal(completed.claim.fencingToken, 3);
  assert.equal(existsSync(fixture.pathFor(fullRef)), false);
  assert.deepEqual(lifecycle.verifyCompleted(operation.operationId), completed.receipt);
});

test("an exact-ref lifecycle operation is domain-durable, fenced, and cannot execute after its lease expires", (t) => {
  const fixture = createFixture();
  t.after(fixture.cleanup);
  const fullRef = "refs/heads/topic";
  const reflogPath = fixture.pathFor(`logs/${fullRef}`);
  writeText(fixture.pathFor(fullRef), `${SHA1_A}\n`);
  writeText(reflogPath, "original reflog\n");

  const clock = createFakeClock(0);
  const lifecycle = new GitExactRefLifecycleCoordinator(fixture.home, clock.now);
  const operation = lifecycle.prepareExactRefRetirement({
    operationId: fixtureUuid(206),
    repository: fixture.repository(),
    fullRef,
    expectedOid: SHA1_A
  });
  assert.equal(operation.resource.repository.repositoryLineageId, fixture.repository().repositoryLineageId);
  assert.match(operation.resource.resourceKey, /^[0-9a-f]{64}$/);
  assert.equal(operation.phase, "prepared");

  const ownerA = fixtureUuid(207);
  const ownerB = fixtureUuid(208);
  const claimed = lifecycle.claim(operation.operationId, ownerA, 10);
  assert.equal(lifecycle.get(operation.operationId).phase, "claimed");
  clock.set(1);
  assert.throws(
    () => lifecycle.claim(operation.operationId, ownerB, 1_000),
    /active claim/i
  );
  clock.set(5);
  lifecycle.begin(operation.operationId, claimed);

  clock.set(11);
  assert.throws(
    () => lifecycle.execute(operation.operationId, claimed),
    /lease has expired|claim/i
  );
  assert.equal(readFileSync(fixture.pathFor(fullRef), "utf8"), `${SHA1_A}\n`);

  const replacement = lifecycle.claim(operation.operationId, ownerB, 1_000);
  clock.set(12);
  lifecycle.begin(operation.operationId, replacement);
  clock.set(13);
  const receipt = lifecycle.execute(operation.operationId, replacement);
  assert.equal(receipt.status, "retired");
  assert.equal(existsSync(fixture.pathFor(fullRef)), false);

  const completed = lifecycle.get(operation.operationId);
  assert.equal(completed.phase, "completed");
  assert.deepEqual(lifecycle.verifyCompleted(operation.operationId), receipt);

  writeText(reflogPath, "changed reflog\n");
  assert.throws(
    () => lifecycle.verifyCompleted(operation.operationId),
    /reflog/i
  );
});

test("recovery never begins a prepared exact-ref retirement", (t) => {
  const fixture = createFixture();
  t.after(fixture.cleanup);
  const fullRef = "refs/heads/recover-prepared";
  const reflogPath = fixture.pathFor(`logs/${fullRef}`);
  writeText(fixture.pathFor(fullRef), `${SHA1_A}\n`);
  writeText(reflogPath, "original reflog\n");

  const lifecycle = new GitExactRefLifecycleCoordinator(fixture.home, createFakeClock(0).now);
  const request = {
    operationId: fixtureUuid(209),
    repository: fixture.repository(),
    fullRef,
    expectedOid: SHA1_A
  };
  const prepared = lifecycle.prepareExactRefRetirement(request);
  assert.deepEqual(lifecycle.prepareExactRefRetirement(request), prepared);

  assert.deepEqual(
    lifecycle.recover(fixtureUuid(210), 1_000),
    [{ operationId: prepared.operationId, status: "not-started-skipped" }]
  );
  assert.deepEqual(lifecycle.get(prepared.operationId), prepared);
  assert.deepEqual(lifecycle.prepareExactRefRetirement(request), prepared);
  assert.equal(readFileSync(fixture.pathFor(fullRef), "utf8"), `${SHA1_A}\n`);
  assert.equal(readFileSync(reflogPath, "utf8"), "original reflog\n");
  assert.equal(
    existsSync(join(fixture.home, "runtime", "git-lifecycle", "exact-ref-ledger")),
    false
  );
});

test("recovery never takes over a claimed but unstarted exact-ref retirement", (t) => {
  const fixture = createFixture();
  t.after(fixture.cleanup);
  const fullRef = "refs/heads/recover-claimed";
  const reflogPath = fixture.pathFor(`logs/${fullRef}`);
  writeText(fixture.pathFor(fullRef), `${SHA1_B}\n`);
  writeText(reflogPath, "original reflog\n");

  const clock = createFakeClock(0);
  const lifecycle = new GitExactRefLifecycleCoordinator(fixture.home, clock.now);
  const operation = lifecycle.prepareExactRefRetirement({
    operationId: fixtureUuid(211),
    repository: fixture.repository(),
    fullRef,
    expectedOid: SHA1_B
  });
  const claim = lifecycle.claim(
    operation.operationId,
    fixtureUuid(212),
    10
  );
  const claimed = lifecycle.get(operation.operationId);

  assert.deepEqual(
    lifecycle.recover(claim.ownerId, 1_000),
    [{ operationId: operation.operationId, status: "active-lease-skipped" }]
  );
  assert.deepEqual(lifecycle.get(operation.operationId), claimed);
  assert.equal(readFileSync(fixture.pathFor(fullRef), "utf8"), `${SHA1_B}\n`);

  clock.set(10);
  assert.deepEqual(
    lifecycle.recover(fixtureUuid(213), 1_000),
    [{ operationId: operation.operationId, status: "not-started-skipped" }]
  );
  assert.deepEqual(lifecycle.get(operation.operationId), claimed);
  assert.equal(readFileSync(fixture.pathFor(fullRef), "utf8"), `${SHA1_B}\n`);
  assert.equal(readFileSync(reflogPath, "utf8"), "original reflog\n");
  assert.equal(
    existsSync(join(fixture.home, "runtime", "git-lifecycle", "exact-ref-ledger")),
    false
  );
});

test("recovery skips an active effect-started exact-ref retirement", (t) => {
  const fixture = createFixture();
  t.after(fixture.cleanup);
  const fullRef = "refs/heads/recover-active";
  writeText(fixture.pathFor(fullRef), `${SHA1_A}\n`);

  const clock = createFakeClock(0);
  const lifecycle = new GitExactRefLifecycleCoordinator(fixture.home, clock.now);
  const operation = lifecycle.prepareExactRefRetirement({
    operationId: fixtureUuid(214),
    repository: fixture.repository(),
    fullRef,
    expectedOid: SHA1_A
  });
  const claim = lifecycle.claim(
    operation.operationId,
    fixtureUuid(215),
    1_000
  );
  const started = lifecycle.begin(operation.operationId, claim);

  assert.deepEqual(
    lifecycle.recover(claim.ownerId, 1_000),
    [{ operationId: operation.operationId, status: "active-lease-skipped" }]
  );
  assert.deepEqual(lifecycle.get(operation.operationId), started);
  assert.equal(readFileSync(fixture.pathFor(fullRef), "utf8"), `${SHA1_A}\n`);

  assert.deepEqual(
    lifecycle.recover(fixtureUuid(216), 1_000),
    [{ operationId: operation.operationId, status: "active-lease-skipped" }]
  );
  assert.deepEqual(lifecycle.get(operation.operationId), started);
});

test("recovery claims an interrupted operation before resuming its exact-ref journal", (t) => {
  const fixture = createFixture();
  t.after(fixture.cleanup);
  const fullRef = "refs/heads/recover";
  writeText(fixture.pathFor(fullRef), `${SHA1_B}\n`);

  const clock = createFakeClock(0);
  const lifecycle = new GitExactRefLifecycleCoordinator(fixture.home, clock.now);
  const operation = lifecycle.prepareExactRefRetirement({
    operationId: fixtureUuid(217),
    repository: fixture.repository(),
    fullRef,
    expectedOid: SHA1_B
  });
  const firstClaim = lifecycle.claim(
    operation.operationId,
    fixtureUuid(218),
    10
  );
  clock.set(1);
  lifecycle.begin(operation.operationId, firstClaim);
  clock.set(2);
  assert.throws(
    () => lifecycle.execute(operation.operationId, firstClaim, {
      faultInjection: { crashAfterJournalStage: true }
    }),
    /after journal stage/i
  );
  assert.equal(existsSync(fixture.pathFor(fullRef)), true);

  clock.set(11);
  const recovered = lifecycle.recover(
    fixtureUuid(219),
    1_000
  );
  assert.deepEqual(recovered, [{ operationId: operation.operationId, status: "completed" }]);
  assert.equal(existsSync(fixture.pathFor(fullRef)), false);
  const completed = lifecycle.get(operation.operationId);
  assert.equal(completed.phase, "completed");
  assert.notEqual(completed.claim.ownerId, firstClaim.ownerId);
  assert.equal(completed.claim.generation, 2);
});

function createFixture() {
  const root = mkdtempSync(join(tmpdir(), "taskmux-git-lifecycle-"));
  const home = join(root, "home");
  const commonDir = join(root, "repo.git");
  mkdirSync(home, { recursive: true });
  mkdirSync(join(commonDir, "refs", "heads"), { recursive: true });
  writeFileSync(join(commonDir, "HEAD"), `${SHA1_A}\n`, { mode: 0o600 });
  return {
    home,
    pathFor(relative) {
      return join(commonDir, relative);
    },
    repository() {
      return createGitRepositoryLineage({
        repositoryLineageId: fixtureUuid(220),
        commonDir,
        objectFormat: "sha1"
      });
    },
    cleanup() {
      rmSync(root, { recursive: true, force: true });
    }
  };
}

function writeText(path, content) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content, { mode: 0o600 });
}

function createFakeClock(initialMilliseconds) {
  let milliseconds = Date.parse("2026-07-14T00:00:00.000Z") + initialMilliseconds;
  let scriptedMilliseconds = [];
  return {
    now: () => new Date(scriptedMilliseconds.shift() ?? milliseconds),
    set: (nextMilliseconds) => {
      milliseconds = Date.parse("2026-07-14T00:00:00.000Z") + nextMilliseconds;
      scriptedMilliseconds = [];
    },
    script: (...nextMilliseconds) => {
      scriptedMilliseconds = nextMilliseconds.map(
        (next) => Date.parse("2026-07-14T00:00:00.000Z") + next
      );
    }
  };
}
