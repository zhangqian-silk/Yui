import assert from "node:assert/strict";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
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

test("synchronously rolls a staged transaction forward after a mid-apply interruption", (t) => {
  const home = mkdtempSync(join(tmpdir(), "taskmux-domain-atomicity-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const taskDir = join(home, "tasks", "task-1");
  mkdirSync(taskDir, { recursive: true });
  const requestFile = join(taskDir, "input-requests", "input-1.json");
  const resolutionFile = join(taskDir, "input-resolutions", "resolution-1.json");
  const eventFile = join(taskDir, "events.jsonl");
  mkdirSync(join(taskDir, "input-requests"), { recursive: true });
  writeFileSync(requestFile, "old request\n");

  stageDomainTransaction(home, "mid-apply", [
    { type: "write", target: requestFile, content: "terminal request\n" },
    { type: "write", target: resolutionFile, content: "resolution\n" },
    { type: "write", target: eventFile, content: "pointer-only event\n" }
  ]);

  const result = applyStagedDomainTransaction(home, "mid-apply", {
    initialAfterOperation: 1
  });

  assert.equal(result, "recovered");
  assert.equal(readFileSync(requestFile, "utf8"), "terminal request\n");
  assert.equal(readFileSync(resolutionFile, "utf8"), "resolution\n");
  assert.equal(readFileSync(eventFile, "utf8"), "pointer-only event\n");
  assert.deepEqual(readdirSync(join(home, "runtime", "domain-transactions")), []);
});

test("retains the journal and raises a fail-closed error when synchronous recovery also fails", (t) => {
  const home = mkdtempSync(join(tmpdir(), "taskmux-domain-fail-closed-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const taskDir = join(home, "tasks", "task-1");
  mkdirSync(taskDir, { recursive: true });
  const first = join(taskDir, "first.json");
  const second = join(taskDir, "second.json");
  writeFileSync(first, "before\n");
  stageDomainTransaction(home, "persistent-failure", [
    { type: "write", target: first, content: "after\n" },
    { type: "write", target: second, content: "after\n" }
  ]);

  assert.throws(
    () => applyStagedDomainTransaction(home, "persistent-failure", {
      initialAfterOperation: 1,
      recoveryAfterOperation: 1
    }),
    (error) => error.name === "DomainTransactionRecoveryError"
  );
  assert.equal(
    existsSync(join(home, "runtime", "domain-transactions", "persistent-failure.json")),
    true
  );

  assert.deepEqual(replayPendingDomainTransactions(home), ["persistent-failure"]);
  assert.equal(readFileSync(first, "utf8"), "after\n");
  assert.equal(readFileSync(second, "utf8"), "after\n");
});

test("turns journal parse and cleanup failures into fixed fail-closed errors", (t) => {
  const home = mkdtempSync(join(tmpdir(), "taskmux-domain-journal-boundary-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const target = join(home, "tasks", "task-1", "task.json");
  const malformedJournal = stageDomainTransaction(home, "malformed-journal", [
    { type: "write", target, content: "after\n" }
  ]);
  writeFileSync(malformedJournal, "{ malformed json\n");

  assert.throws(
    () => applyStagedDomainTransaction(home, "malformed-journal"),
    (error) => {
      assert.equal(error.name, "DomainTransactionRecoveryError");
      assert.equal(error.message, "Domain transaction malformed-journal could not complete synchronous recovery.");
      assert.doesNotMatch(error.message, new RegExp(home));
      return true;
    }
  );

  rmSync(malformedJournal, { force: true });
  stageDomainTransaction(home, "cleanup-failure", [
    { type: "write", target, content: "after\n" }
  ]);
  assert.throws(
    () => applyStagedDomainTransaction(home, "cleanup-failure", { failBeforeJournalRemove: true }),
    (error) => error.name === "DomainTransactionRecoveryError"
  );
  assert.equal(
    existsSync(join(home, "runtime", "domain-transactions", "cleanup-failure.json")),
    true
  );
});
