import assert from "node:assert/strict";
import {
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import {
  digestExactRefInvocation,
  parseExactRefInvocationPlan
} from "../dist/worktree/gitCommand.js";
import {
  canonicalExactRefResourceIdentity,
  createGitRepositoryLineage,
  GitResourceLedger,
  MAX_EXACT_REF_RETIREMENT_JOURNAL_BYTES
} from "../dist/worktree/gitResourceLedger.js";
import {
  MAX_AUTHORITATIVE_RECORD_BYTES
} from "../dist/storage/storageLimits.js";
import {
  recoverExactRefRetirements,
  retireExactRef
} from "../dist/worktree/exactRefRetirement.js";
import {
  createGitLifecycleClaim,
  parseGitLifecycleClaim
} from "../dist/worktree/gitLifecycleClaim.js";

const SHA1_A = "a".repeat(40);
const SHA1_B = "b".repeat(40);
const SHA1_C = "c".repeat(40);
const fixtureUuid = (sequence) =>
  `00000000-0000-4000-8000-${String(sequence).padStart(12, "0")}`;
const LINEAGE_ID = fixtureUuid(101);

test("exact-ref catalog binds the digest to a repository lineage and rejects non-local refs", () => {
  const effect = {
    kind: "exact-ref-delete",
    objectFormat: "sha1",
    fullRef: "refs/heads/topic",
    expectedOid: SHA1_A
  };
  const plan = parseExactRefInvocationPlan({ repositoryLineageId: LINEAGE_ID, effect });
  assert.deepEqual(plan, { repositoryLineageId: LINEAGE_ID, effect });
  assert.notEqual(
    digestExactRefInvocation(plan),
    digestExactRefInvocation({ ...plan, repositoryLineageId: fixtureUuid(102) })
  );
  assert.throws(
    () => parseExactRefInvocationPlan({ repositoryLineageId: LINEAGE_ID, effect: { ...effect, fullRef: "refs/tags/topic" } }),
    /local branch ref/i
  );
});

test("resource ledger binds canonical identity to one live repository lineage", (t) => {
  const fixture = createFixture();
  t.after(fixture.cleanup);
  const ledger = new GitResourceLedger(fixture.ledgerRoot);
  const first = ledger.ensureExactRefResource(fixture.repository(), "refs/heads/topic");
  const second = ledger.ensureExactRefResource(fixture.repository(), "refs/heads/topic");

  assert.deepEqual(second, first);
  assert.equal(
    first.canonicalResourceIdentity,
    canonicalExactRefResourceIdentity(fixture.repository(), "refs/heads/topic")
  );
  assert.match(first.resourceKey, /^[0-9a-f]{64}$/);
  assert.throws(
    () => ledger.ensureExactRefResource(
      createGitRepositoryLineage({
        repositoryLineageId: fixtureUuid(102),
        commonDir: fixture.commonDir,
        objectFormat: "sha1"
      }),
      "refs/heads/topic"
    ),
    /lineage|identity|ledger/i
  );
});

test("retirement removes a loose exact ref while preserving its reflog bytes and identity", (t) => {
  const fixture = createFixture();
  t.after(fixture.cleanup);
  const fullRef = "refs/heads/topic";
  const looseRef = fixture.pathFor(fullRef);
  const reflog = fixture.pathFor(`logs/${fullRef}`);
  writeText(looseRef, `${SHA1_A}\n`);
  writeText(reflog, "old reflog bytes\n");
  const reflogBytes = readFileSync(reflog);
  const reflogIdentity = statSync(reflog, { bigint: true });

  const receipt = retireExactRef({
    ledgerRoot: fixture.ledgerRoot,
    repository: fixture.repository(),
    operationId: fixtureUuid(103),
    fullRef,
    expectedOid: SHA1_A
  });

  assert.equal(existsSync(looseRef), false);
  assert.deepEqual(readFileSync(reflog), reflogBytes);
  assert.equal(statSync(reflog, { bigint: true }).ino, reflogIdentity.ino);
  assert.equal(receipt.status, "retired");
});

test("loose-ref retirement persists an anchored identity and rejects ABA changes before and after Git locks", (t) => {
  const staged = createFixture();
  t.after(staged.cleanup);
  const fullRef = "refs/heads/loose-aba";
  const looseRef = staged.pathFor(fullRef);
  writeText(looseRef, `${SHA1_A}\n`);

  assert.throws(
    () => retireExactRef({
      ledgerRoot: staged.ledgerRoot,
      repository: staged.repository(),
      operationId: fixtureUuid(104),
      fullRef,
      expectedOid: SHA1_A,
      faultInjection: { crashAfterJournalStage: true }
    }),
    /after journal stage/i
  );
  const [stagedJournalPath] = pendingEntries(staged.ledgerRoot);
  assert.ok(stagedJournalPath);
  const stagedJournal = JSON.parse(readFileSync(stagedJournalPath, "utf8"));
  assert.deepEqual(
    Object.keys(stagedJournal.loose.identity).sort(),
    ["birthtimeNs", "dev", "ino", "mode", "nlink", "uid"]
  );
  for (const value of Object.values(stagedJournal.loose.identity)) {
    assert.match(value, /^(?:0|[1-9][0-9]*)$/);
  }

  rmSync(looseRef);
  writeText(looseRef, `${SHA1_A}\n`);
  assert.throws(
    () => recoverExactRefRetirements({ ledgerRoot: staged.ledgerRoot, repository: staged.repository() }),
    /loose ref changed/i
  );
  assert.equal(readFileSync(looseRef, "utf8"), `${SHA1_A}\n`);

  const heldLock = createFixture();
  t.after(heldLock.cleanup);
  const heldRef = "refs/heads/loose-held-lock";
  const heldLoose = heldLock.pathFor(heldRef);
  writeText(heldLoose, `${SHA1_B}\n`);
  assert.throws(
    () => retireExactRef({
      ledgerRoot: heldLock.ledgerRoot,
      repository: heldLock.repository(),
      operationId: fixtureUuid(105),
      fullRef: heldRef,
      expectedOid: SHA1_B,
      faultInjection: {
        afterLocksAcquired() {
          rmSync(heldLoose);
          writeText(heldLoose, `${SHA1_B}\n`);
        }
      }
    }),
    /loose ref changed/i
  );
  assert.equal(readFileSync(heldLoose, "utf8"), `${SHA1_B}\n`);
  assert.equal(existsSync(`${heldLoose}.lock`), false);

  const unprovable = createFixture();
  t.after(unprovable.cleanup);
  const unprovableRef = "refs/heads/loose-unprovable";
  const unprovableLoose = unprovable.pathFor(unprovableRef);
  writeText(unprovableLoose, `${SHA1_C}\n`);
  assert.throws(
    () => retireExactRef({
      ledgerRoot: unprovable.ledgerRoot,
      repository: unprovable.repository(),
      operationId: fixtureUuid(106),
      fullRef: unprovableRef,
      expectedOid: SHA1_C,
      faultInjection: { crashAfterJournalStage: true }
    }),
    /after journal stage/i
  );
  const [unprovableJournalPath] = pendingEntries(unprovable.ledgerRoot);
  const unprovableJournal = JSON.parse(readFileSync(unprovableJournalPath, "utf8"));
  delete unprovableJournal.loose.identity;
  writeFileSync(unprovableJournalPath, `${JSON.stringify(unprovableJournal, null, 2)}\n`);
  assert.throws(
    () => recoverExactRefRetirements({ ledgerRoot: unprovable.ledgerRoot, repository: unprovable.repository() }),
    /loose witness|identity/i
  );
  assert.equal(readFileSync(unprovableLoose, "utf8"), `${SHA1_C}\n`);
});

test("exact-ref retirement rejects checked-out target refs in main and linked worktrees before and after locks", (t) => {
  const main = createFixture();
  t.after(main.cleanup);
  const mainRef = "refs/heads/main-head-target";
  const mainLoose = main.pathFor(mainRef);
  writeText(mainLoose, `${SHA1_A}\n`);
  writeText(main.pathFor("HEAD"), `ref: ${mainRef}\n`);
  assert.throws(
    () => retireExactRef({
      ledgerRoot: main.ledgerRoot,
      repository: main.repository(),
      operationId: fixtureUuid(107),
      fullRef: mainRef,
      expectedOid: SHA1_A
    }),
    /HEAD|checked out/i
  );
  assert.equal(readFileSync(mainLoose, "utf8"), `${SHA1_A}\n`);

  const linked = createFixture();
  t.after(linked.cleanup);
  const linkedRef = "refs/heads/linked-head-target";
  const linkedPacked = linked.pathFor("packed-refs");
  const linkedInput = Buffer.from(`${SHA1_B} ${linkedRef}\n`, "utf8");
  writeFileSync(linkedPacked, linkedInput);
  mkdirSync(linked.pathFor("worktrees/reviewer"), { recursive: true });
  writeText(linked.pathFor("worktrees/reviewer/HEAD"), `ref: ${linkedRef}\n`);
  assert.throws(
    () => retireExactRef({
      ledgerRoot: linked.ledgerRoot,
      repository: linked.repository(),
      operationId: fixtureUuid(108),
      fullRef: linkedRef,
      expectedOid: SHA1_B
    }),
    /HEAD|checked out/i
  );
  assert.deepEqual(readFileSync(linkedPacked), linkedInput);
  const linkedHead = linked.pathFor("worktrees/reviewer/HEAD");
  writeText(linkedHead, "not a valid HEAD\n");
  assert.throws(
    () => retireExactRef({
      ledgerRoot: linked.ledgerRoot,
      repository: linked.repository(),
      operationId: fixtureUuid(109),
      fullRef: linkedRef,
      expectedOid: SHA1_B
    }),
    /HEAD/i
  );
  assert.deepEqual(readFileSync(linkedPacked), linkedInput);
  const foreignLinkedHead = join(linked.root, "foreign-linked-head");
  writeText(foreignLinkedHead, `${SHA1_A}\n`);
  rmSync(linkedHead);
  symlinkSync(foreignLinkedHead, linkedHead);
  assert.throws(
    () => retireExactRef({
      ledgerRoot: linked.ledgerRoot,
      repository: linked.repository(),
      operationId: fixtureUuid(110),
      fullRef: linkedRef,
      expectedOid: SHA1_B
    }),
    /HEAD/i
  );
  assert.deepEqual(readFileSync(linkedPacked), linkedInput);

  const hostile = createFixture();
  t.after(hostile.cleanup);
  const hostileRef = "refs/heads/hostile-head";
  const hostileLoose = hostile.pathFor(hostileRef);
  const hostileHead = hostile.pathFor("HEAD");
  const foreignHead = join(hostile.root, "foreign-head");
  writeText(hostileLoose, `${SHA1_C}\n`);
  writeText(foreignHead, `ref: ${hostileRef}\n`);
  rmSync(hostileHead);
  symlinkSync(foreignHead, hostileHead);
  assert.throws(
    () => retireExactRef({
      ledgerRoot: hostile.ledgerRoot,
      repository: hostile.repository(),
      operationId: fixtureUuid(111),
      fullRef: hostileRef,
      expectedOid: SHA1_C
    }),
    /HEAD/i
  );
  assert.equal(readFileSync(hostileLoose, "utf8"), `${SHA1_C}\n`);
  rmSync(hostileHead);
  writeText(hostileHead, "not a valid HEAD\n");
  assert.throws(
    () => retireExactRef({
      ledgerRoot: hostile.ledgerRoot,
      repository: hostile.repository(),
      operationId: fixtureUuid(112),
      fullRef: hostileRef,
      expectedOid: SHA1_C
    }),
    /HEAD/i
  );
  assert.equal(readFileSync(hostileLoose, "utf8"), `${SHA1_C}\n`);

  const hostileWorktreePath = createFixture();
  t.after(hostileWorktreePath.cleanup);
  const hostileWorktreeRef = "refs/heads/hostile-worktree-path";
  const hostileWorktreeLoose = hostileWorktreePath.pathFor(hostileWorktreeRef);
  writeText(hostileWorktreeLoose, `${SHA1_A}\n`);
  const foreignWorktrees = join(hostileWorktreePath.root, "foreign-worktrees");
  mkdirSync(foreignWorktrees);
  symlinkSync(foreignWorktrees, hostileWorktreePath.pathFor("worktrees"));
  assert.throws(
    () => retireExactRef({
      ledgerRoot: hostileWorktreePath.ledgerRoot,
      repository: hostileWorktreePath.repository(),
      operationId: fixtureUuid(113),
      fullRef: hostileWorktreeRef,
      expectedOid: SHA1_A
    }),
    /worktree/i
  );
  assert.equal(readFileSync(hostileWorktreeLoose, "utf8"), `${SHA1_A}\n`);

  const afterLocks = createFixture();
  t.after(afterLocks.cleanup);
  const afterLocksRef = "refs/heads/head-after-lock";
  const afterLocksLoose = afterLocks.pathFor(afterLocksRef);
  writeText(afterLocksLoose, `${SHA1_A}\n`);
  assert.throws(
    () => retireExactRef({
      ledgerRoot: afterLocks.ledgerRoot,
      repository: afterLocks.repository(),
      operationId: fixtureUuid(114),
      fullRef: afterLocksRef,
      expectedOid: SHA1_A,
      faultInjection: {
        afterLocksAcquired() {
          writeText(afterLocks.pathFor("HEAD"), `ref: ${afterLocksRef}\n`);
        }
      }
    }),
    /HEAD|checked out/i
  );
  assert.equal(readFileSync(afterLocksLoose, "utf8"), `${SHA1_A}\n`);
  assert.equal(existsSync(`${afterLocksLoose}.lock`), false);
});

test("packed-refs retirement uses UTF-8 byte offsets, Git locks, and crash recovery", (t) => {
  const fixture = createFixture();
  t.after(fixture.cleanup);
  const fullRef = "refs/heads/retire";
  const packed = fixture.pathFor("packed-refs");
  const input = Buffer.from([
    "# pack-refs with: peeled fully-peeled sorted",
    "# before-café",
    `${SHA1_A} refs/heads/é-before`,
    `${SHA1_B} ${fullRef}`,
    `^${SHA1_C}`,
    `${SHA1_C} refs/heads/after`,
    ""
  ].join("\n"), "utf8");
  const expected = Buffer.from([
    "# pack-refs with: peeled fully-peeled sorted",
    "# before-café",
    `${SHA1_A} refs/heads/é-before`,
    `${SHA1_C} refs/heads/after`,
    ""
  ].join("\n"), "utf8");
  writeFileSync(packed, input);

  assert.throws(
    () => retireExactRef({
      ledgerRoot: fixture.ledgerRoot,
      repository: fixture.repository(),
      operationId: fixtureUuid(115),
      fullRef,
      expectedOid: SHA1_B,
      faultInjection: { crashAfterPackedTemporaryWrite: true }
    }),
    /injected/i
  );
  assert.equal(existsSync(`${packed}.lock`), true);
  assert.equal(existsSync(`${fixture.pathFor(fullRef)}.lock`), true);

  assert.deepEqual(
    recoverExactRefRetirements({ ledgerRoot: fixture.ledgerRoot, repository: fixture.repository() }).map((entry) => entry.status),
    ["retired"]
  );
  assert.deepEqual(readFileSync(packed), expected);
  assert.equal(existsSync(`${packed}.lock`), false);
  assert.equal(existsSync(`${fixture.pathFor(fullRef)}.lock`), false);
});

test("packed-ref retirement journals fit the authoritative record ceiling before staging", (t) => {
  const fixture = createFixture();
  t.after(fixture.cleanup);
  const fullRef = "refs/heads/journal-boundary";
  const packed = fixture.pathFor("packed-refs");
  const targetLine = Buffer.from(`${SHA1_A} ${fullRef}\n`, "utf8");
  const probeAfter = Buffer.from("#\n", "utf8");
  writeFileSync(packed, Buffer.concat([targetLine, probeAfter]));

  assert.throws(
    () => retireExactRef({
      ledgerRoot: fixture.ledgerRoot,
      repository: fixture.repository(),
      operationId: fixtureUuid(116),
      fullRef,
      expectedOid: SHA1_A,
      faultInjection: { crashAfterJournalStage: true }
    }),
    /after journal stage/i
  );
  const [probePath] = pendingEntries(fixture.ledgerRoot);
  assert.ok(probePath);
  const probeJournal = JSON.parse(readFileSync(probePath, "utf8"));
  rmSync(probePath, { force: true });

  const journalBytesForAfter = (afterBytes) => {
    const model = structuredClone(probeJournal);
    model.packed.afterBytesBase64 = "";
    model.packed.beforeBytes = targetLine.length + afterBytes;
    return Buffer.byteLength(`${JSON.stringify(model, null, 2)}\n`, "utf8") +
      4 * Math.ceil(afterBytes / 3);
  };
  let minimum = probeAfter.length;
  let maximum = MAX_AUTHORITATIVE_RECORD_BYTES;
  while (minimum < maximum) {
    const midpoint = Math.floor((minimum + maximum + 1) / 2);
    if (journalBytesForAfter(midpoint) <= MAX_EXACT_REF_RETIREMENT_JOURNAL_BYTES) {
      minimum = midpoint;
    } else {
      maximum = midpoint - 1;
    }
  }
  const largestRecoverableAfterBytes = minimum;
  const oversizedAfterBytes = largestRecoverableAfterBytes + 1;
  assert.ok(journalBytesForAfter(largestRecoverableAfterBytes) < MAX_AUTHORITATIVE_RECORD_BYTES);
  assert.ok(journalBytesForAfter(oversizedAfterBytes) >= MAX_AUTHORITATIVE_RECORD_BYTES);

  const ledger = new GitResourceLedger(fixture.ledgerRoot);
  const resource = ledger.ensureExactRefResource(fixture.repository(), fullRef);
  const boundaryPath = ledger.exactRefRetirementPaths(
    resource,
    fixtureUuid(117)
  ).pendingPath;
  ledger.stageExactRefRetirement(
    resource,
    fixtureUuid(117),
    "x".repeat(MAX_EXACT_REF_RETIREMENT_JOURNAL_BYTES)
  );
  assert.equal(statSync(boundaryPath).size, MAX_EXACT_REF_RETIREMENT_JOURNAL_BYTES);
  assert.throws(
    () => ledger.stageExactRefRetirement(
      resource,
      fixtureUuid(118),
      "x".repeat(MAX_EXACT_REF_RETIREMENT_JOURNAL_BYTES + 1)
    ),
    /journal.*authoritative|authoritative.*journal/i
  );
  rmSync(boundaryPath, { force: true });

  const maximumAfter = packedComment(largestRecoverableAfterBytes);
  writeFileSync(packed, Buffer.concat([targetLine, maximumAfter]));
  assert.throws(
    () => retireExactRef({
      ledgerRoot: fixture.ledgerRoot,
      repository: fixture.repository(),
      operationId: fixtureUuid(119),
      fullRef,
      expectedOid: SHA1_A,
      faultInjection: { crashAfterJournalStage: true }
    }),
    /after journal stage/i
  );
  const [maximumJournalPath] = pendingEntries(fixture.ledgerRoot);
  assert.ok(maximumJournalPath);
  assert.ok(statSync(maximumJournalPath).size < MAX_AUTHORITATIVE_RECORD_BYTES);
  assert.deepEqual(
    recoverExactRefRetirements({ ledgerRoot: fixture.ledgerRoot, repository: fixture.repository() })
      .map((entry) => entry.status),
    ["retired"]
  );

  writeFileSync(packed, Buffer.concat([targetLine, packedComment(oversizedAfterBytes)]));
  assert.throws(
    () => retireExactRef({
      ledgerRoot: fixture.ledgerRoot,
      repository: fixture.repository(),
      operationId: fixtureUuid(120),
      fullRef,
      expectedOid: SHA1_A,
      faultInjection: { crashAfterJournalStage: true }
    }),
    /journal.*authoritative|authoritative.*journal/i
  );
  assert.deepEqual(pendingEntries(fixture.ledgerRoot), []);
});

test("recovery fails closed for a moved pending journal, old lease claim, and hostile reflog", (t) => {
  const fixture = createFixture();
  t.after(fixture.cleanup);
  const fullRef = "refs/heads/topic";
  const looseRef = fixture.pathFor(fullRef);
  const reflog = fixture.pathFor(`logs/${fullRef}`);
  writeText(looseRef, `${SHA1_A}\n`);

  assert.throws(
    () => retireExactRef({
      ledgerRoot: fixture.ledgerRoot,
      repository: fixture.repository(),
      operationId: fixtureUuid(121),
      fullRef,
      expectedOid: SHA1_A,
      faultInjection: { crashAfterJournalStage: true }
    }),
    /after journal stage/i
  );
  const [staged] = pendingEntries(fixture.ledgerRoot);
  const ledger = new GitResourceLedger(fixture.ledgerRoot);
  const foreign = ledger.ensureExactRefResource(fixture.repository(), "refs/heads/elsewhere");
  const foreignPath = ledger.exactRefRetirementPaths(foreign, fixtureUuid(121)).pendingPath;
  renameSync(staged, foreignPath);
  assert.throws(
    () => recoverExactRefRetirements({ ledgerRoot: fixture.ledgerRoot, repository: fixture.repository() }),
    /path|resource|identity/i
  );
  assert.equal(readFileSync(looseRef, "utf8"), `${SHA1_A}\n`);

  const claim = createGitLifecycleClaim({
    operationId: fixtureUuid(122),
    ownerId: fixtureUuid(123),
    generation: 2,
    fencingToken: 3,
    leaseExpiresAt: "2026-07-14T00:00:01.000Z"
  });
  assert.deepEqual(parseGitLifecycleClaim(claim), claim);
  assert.throws(
    () => parseGitLifecycleClaim({ ...claim, fencingToken: 2 }),
    /fencing|claim/i
  );

  mkdirSync(dirname(reflog), { recursive: true });
  symlinkSync(join(fixture.root, "foreign-reflog"), reflog);
  assert.throws(
    () => retireExactRef({
      ledgerRoot: fixture.ledgerRoot,
      repository: fixture.repository(),
      operationId: fixtureUuid(124),
      fullRef,
      expectedOid: SHA1_A
    }),
    /reflog/i
  );
  rmSync(reflog, { force: true });
  writeText(join(fixture.root, "foreign-reflog"), "foreign\n");
  linkSync(join(fixture.root, "foreign-reflog"), reflog);
  assert.throws(
    () => retireExactRef({
      ledgerRoot: fixture.ledgerRoot,
      repository: fixture.repository(),
      operationId: fixtureUuid(125),
      fullRef,
      expectedOid: SHA1_A
    }),
    /reflog/i
  );
});

function createFixture() {
  const root = mkdtempSync(join(tmpdir(), "taskmux-git-foundation-"));
  const commonDir = join(root, "repo.git");
  const ledgerRoot = join(root, "ledger");
  mkdirSync(join(commonDir, "refs", "heads"), { recursive: true });
  writeFileSync(join(commonDir, "HEAD"), `${SHA1_A}\n`, { mode: 0o600 });
  return {
    root,
    commonDir,
    ledgerRoot,
    pathFor(relative) {
      return join(commonDir, relative);
    },
    repository() {
      return createGitRepositoryLineage({
        repositoryLineageId: LINEAGE_ID,
        commonDir,
        objectFormat: "sha1"
      });
    },
    cleanup() {
      rmSync(root, { recursive: true, force: true });
    }
  };
}

function writeText(path, text) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text, { mode: 0o600 });
}

function packedComment(bytes) {
  assert.ok(bytes >= 2);
  return Buffer.concat([Buffer.from("#", "utf8"), Buffer.alloc(bytes - 2, 0x78), Buffer.from("\n", "utf8")]);
}

function pendingEntries(root) {
  const directory = join(root, "pending-exact-ref-retirements");
  if (!existsSync(directory)) return [];
  return collect(directory);
}

function collect(directory) {
  const entries = [];
  for (const name of readdirSync(directory).sort()) {
    const path = join(directory, name);
    if (statSync(path).isDirectory()) entries.push(...collect(path));
    else entries.push(path);
  }
  return entries;
}
