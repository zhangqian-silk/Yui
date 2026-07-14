import assert from "node:assert/strict";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  applyStagedDomainTransaction,
  replayPendingDomainTransactions,
  stageDomainTransaction
} from "../dist/storage/recoveryJournal.js";
import { executeDomainTransaction } from "../dist/storage/domainTransaction.js";

test("staging persists one schema-v3 journal with the exact before identity", (t) => {
  const home = mkdtempSync(join(tmpdir(), "taskmux-recovery-v3-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const target = join(home, "config.json");
  writeFileSync(target, "before\n", { mode: 0o600 });
  const before = lstatSync(target, { bigint: true });

  const journal = stageDomainTransaction(home, "v3-identity", [
    { type: "write", target, content: "after\n" }
  ]);
  const entry = JSON.parse(readFileSync(journal, "utf8"));

  assert.equal(entry.schemaVersion, 3);
  assert.equal(entry.phase, "preparing");
  assert.equal(entry.operations.length, 1);
  assert.deepEqual(entry.operations[0].expectedBefore, {
    kind: "file",
    sha256: entry.operations[0].expectedBefore.sha256,
    byteLength: Buffer.byteLength("before\n"),
    device: String(before.dev),
    inode: String(before.ino),
    birthtimeNs: String(before.birthtimeNs),
    uid: String(before.uid),
    mode: String(before.mode),
    nlink: String(before.nlink)
  });
});

test("recovery fails closed when a same-content target has a different exact identity", (t) => {
  const home = mkdtempSync(join(tmpdir(), "taskmux-recovery-v3-cas-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const target = join(home, "config.json");
  writeFileSync(target, "before\n", { mode: 0o600 });
  const journal = stageDomainTransaction(home, "identity-cas", [
    { type: "write", target, content: "after\n" }
  ]);

  unlinkSync(target);
  writeFileSync(target, "before\n", { mode: 0o600 });

  assert.throws(
    () => applyStagedDomainTransaction(home, "identity-cas"),
    (error) => error.name === "DomainTransactionRecoveryError"
  );
  assert.equal(existsSync(journal), true);
  assert.equal(readFileSync(target, "utf8"), "before\n");
});

test("immutable v3 receipt replacement fails closed without overwriting the foreign receipt", (t) => {
  const home = mkdtempSync(join(tmpdir(), "taskmux-recovery-v3-receipt-swap-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const target = join(home, "config.json");
  writeFileSync(target, "before\n", { mode: 0o600 });
  stageDomainTransaction(home, "receipt-swap", [
    { type: "write", target, content: "after\n" }
  ]);

  assert.throws(
    () => applyStagedDomainTransaction(home, "receipt-swap", {
      initialAfterWriteStaging: 1,
      recoveryAfterWriteStaging: 1
    }),
    (error) => error.name === "DomainTransactionRecoveryError"
  );
  const directory = join(home, "runtime", "domain-transactions");
  const latestName = readdirSync(directory)
    .filter((name) => name.startsWith("receipt-swap.receipt-"))
    .sort()
    .at(-1);
  assert.notEqual(latestName, undefined);
  const original = join(directory, `${latestName}.original`);
  renameSync(join(directory, latestName), original);
  writeFileSync(join(directory, latestName), "foreign receipt\n", { mode: 0o600 });

  assert.throws(
    () => replayPendingDomainTransactions(home),
    (error) => error.name === "DomainTransactionRecoveryError"
  );
  assert.equal(readFileSync(join(directory, latestName), "utf8"), "foreign receipt\n");
  assert.equal(readFileSync(target, "utf8"), "before\n");
});

test("replay resumes a crash between immutable metadata publications", (t) => {
  const home = mkdtempSync(join(tmpdir(), "taskmux-recovery-v3-metadata-crash-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const target = join(home, "config.json");
  writeFileSync(target, "before\n", { mode: 0o600 });
  stageDomainTransaction(home, "metadata-crash", [
    { type: "write", target, content: "after\n" }
  ]);

  assert.throws(
    () => applyStagedDomainTransaction(home, "metadata-crash", {
      initialAfterWriteStaging: 1,
      recoveryAfterWriteStaging: 1
    }),
    (error) => error.name === "DomainTransactionRecoveryError"
  );
  const receipts = readdirSync(join(home, "runtime", "domain-transactions"));
  assert.equal(receipts.includes("metadata-crash.json"), true);
  assert.equal(receipts.some((name) => name.startsWith("metadata-crash.receipt-")), true);

  assert.deepEqual(replayPendingDomainTransactions(home), ["metadata-crash"]);
  assert.equal(readFileSync(target, "utf8"), "after\n");
  assert.deepEqual(readdirSync(join(home, "runtime", "domain-transactions")), []);
});

test("synchronous recovery completes a legacy-file retirement after interruption", (t) => {
  const home = mkdtempSync(join(tmpdir(), "taskmux-recovery-v3-retirement-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const target = join(home, "config.json");
  writeFileSync(target, "before\n", { mode: 0o644 });
  stageDomainTransaction(home, "legacy-retirement", [
    { type: "write", target, content: "after\n" }
  ]);

  assert.equal(
    applyStagedDomainTransaction(home, "legacy-retirement", {
      initialAfterRetirement: 1
    }),
    "recovered"
  );
  assert.equal(readFileSync(target, "utf8"), "after\n");
  assert.deepEqual(readdirSync(join(home, "runtime", "domain-transactions")), []);
});

test("replays chained sibling mkdir and rmdir transitions with exact parent link counts", (t) => {
  const home = mkdtempSync(join(tmpdir(), "taskmux-recovery-v3-links-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  mkdirSync(join(home, "tasks"), { recursive: true });
  const first = join(home, "tasks", "task-1", "first", "one.json");
  const second = join(home, "tasks", "task-1", "second", "two.json");
  const journal = stageDomainTransaction(home, "sibling-mkdirs", [
    { type: "write", target: first, content: "one\n" },
    { type: "write", target: second, content: "two\n" }
  ]);

  assert.throws(
    () => applyStagedDomainTransaction(home, "sibling-mkdirs", {
      initialAfterWritePrepared: 2,
      recoveryAfterOperation: 1
    }),
    (error) => error.name === "DomainTransactionRecoveryError"
  );

  const prepared = latestDomainReceipt(home, "sibling-mkdirs");
  assert.equal(prepared.schemaVersion, 3);
  assert.equal(prepared.phase, "prepared");
  const siblingTransitions = prepared.parentTransitions.filter(
    (transition) => transition.parent === "tasks/task-1"
  );
  assert.equal(siblingTransitions.length, 2);
  assert.equal(BigInt(siblingTransitions[0].after.nlink), BigInt(siblingTransitions[0].before.nlink) + 1n);
  assert.equal(siblingTransitions[1].before.nlink, siblingTransitions[0].after.nlink);
  assert.equal(BigInt(siblingTransitions[1].after.nlink), BigInt(siblingTransitions[1].before.nlink) + 1n);

  assert.deepEqual(replayPendingDomainTransactions(home), ["sibling-mkdirs"]);
  assert.equal(readFileSync(first, "utf8"), "one\n");
  assert.equal(readFileSync(second, "utf8"), "two\n");

  const deleteJournal = stageDomainTransaction(home, "sibling-rmdirs", [
    { type: "delete", target: join(home, "tasks", "task-1") }
  ]);
  assert.ok(existsSync(deleteJournal));
  assert.equal(applyStagedDomainTransaction(home, "sibling-rmdirs"), "applied");
  assert.equal(existsSync(join(home, "tasks", "task-1")), false);
  assert.deepEqual(readdirSync(join(home, "tasks")), []);
});

test("writer fails closed if the TASKMUX_HOME pathname is swapped during workspace execution", (t) => {
  const home = mkdtempSync(join(tmpdir(), "taskmux-recovery-v3-root-swap-"));
  const originalHome = `${home}.original`;
  t.after(() => {
    rmSync(home, { recursive: true, force: true });
    rmSync(originalHome, { recursive: true, force: true });
  });
  writeFileSync(join(home, "config.json"), "before\n", { mode: 0o600 });

  assert.throws(
    () => executeDomainTransaction(home, "root-swap", (workingRoot) => {
      writeFileSync(join(workingRoot, "config.json"), "after\n");
      renameSync(home, originalHome);
      mkdirSync(home, { recursive: true });
      writeFileSync(join(home, "config.json"), "attacker\n", { mode: 0o600 });
    }),
    /TaskMux storage writer root path identity changed/
  );
  assert.equal(readFileSync(join(originalHome, "config.json"), "utf8"), "before\n");
  assert.equal(readFileSync(join(home, "config.json"), "utf8"), "attacker\n");
});

function latestDomainReceipt(home, id) {
  const directory = join(home, "runtime", "domain-transactions");
  const names = readdirSync(directory)
    .filter((name) => name === `${id}.json` || name.startsWith(`${id}.receipt-`))
    .sort();
  const entries = names.map((name) => JSON.parse(readFileSync(join(directory, name), "utf8")));
  return entries.reduce((latest, entry) =>
    latest === undefined || entry.revision > latest.revision ? entry : latest
  );
}
