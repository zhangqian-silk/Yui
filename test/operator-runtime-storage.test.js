import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createOperatorDelivery } from "../dist/operator/operatorDelivery.js";
import { executeDomainTransaction } from "../dist/storage/domainTransaction.js";
import { ensureStorageSchema } from "../dist/storage/storageSchema.js";
import { FileTaskStore } from "../dist/storage/taskStore.js";

function createHome(t) {
  const home = mkdtempSync(join(tmpdir(), "taskmux-operator-runtime-"));
  ensureStorageSchema(home);
  t.after(() => rmSync(home, { recursive: true, force: true }));
  return home;
}

test("persists pointer-only operator delivery records through the #34 domain transaction authority", (t) => {
  const home = createHome(t);
  const delivery = createOperatorDelivery(
    "delivery-1",
    1,
    "task-1",
    "input-1",
    new Date("2026-07-14T07:20:00.000Z")
  );

  executeDomainTransaction(home, "operator-delivery-1", (workingRoot) => {
    new FileTaskStore(workingRoot).saveOperatorDelivery(delivery);
  });

  const store = new FileTaskStore(home);
  assert.deepEqual(store.getOperatorDelivery("delivery-1"), delivery);
  assert.deepEqual(store.listOperatorDeliveries(), [delivery]);
  assert.equal(existsSync(join(home, "runtime", "inbox")), false);
});
