import { readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { runReleaseWorkflow } from "../dist/release/releaseWorkflowEngine.js";
import { FileTaskStore } from "../dist/storage/taskStore.js";

const [root, taskId, workflowId, barrier] = process.argv.slice(2);
if (root === undefined || taskId === undefined || workflowId === undefined || barrier === undefined) {
  throw new Error("round8 concurrent worker requires root, Task, workflow, and barrier paths");
}

const inner = new FileTaskStore(root);
let capturedGrant = false;
const store = {
  rootDirectory: () => inner.rootDirectory(),
  getReleaseWorkflow: (...args) => inner.getReleaseWorkflow(...args),
  saveReleaseWorkflow: (...args) => inner.saveReleaseWorkflow(...args),
  getCapabilityGrant: (...args) => {
    const grant = inner.getCapabilityGrant(...args);
    if (!capturedGrant) {
      capturedGrant = true;
      writeFileSync(join(barrier, `${process.pid}-${workflowId}.ready`), "ready\n");
      const deadline = Date.now() + 5_000;
      while (readdirSync(barrier).filter((name) => name.endsWith(".ready")).length < 2) {
        if (Date.now() >= deadline) throw new Error("round8 grant-read barrier timed out");
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
      }
    }
    return grant;
  },
  saveCapabilityGrant: (...args) => inner.saveCapabilityGrant(...args)
};

let effects = 0;
const result = await runReleaseWorkflow(store, taskId, workflowId, {
  executeStep: async () => {
    effects += 1;
    return { outcome: "succeeded" };
  },
  queryStepEffect: async () => ({ state: "unknown" })
}, { now: () => new Date("2030-01-01T00:00:00.000Z") });

process.stdout.write(`${JSON.stringify({ workflowId, effects, outcome: result.outcome })}\n`);
