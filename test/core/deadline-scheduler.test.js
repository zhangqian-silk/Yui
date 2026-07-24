import assert from "node:assert/strict";
import test from "node:test";

import { nearestDeadlineBatch } from "../../dist/coordination/deadlineScheduler.js";

test("nearest deadline coalesces equal keys and ignores invalid timestamps", () => {
  assert.deepEqual(nearestDeadlineBatch([
    { key: "task:later", at: 20 },
    { key: "task:first", at: 10 },
    { key: "task:first", at: 10 },
    { key: "task:invalid", at: Number.NaN }
  ]), {
    at: 10,
    keys: ["task:first"]
  });
  assert.equal(nearestDeadlineBatch([{ key: "x", at: Number.NaN }]), null);
});
