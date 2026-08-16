import { runWorkflowCommandAsync } from "../dist/commands/workflowCommands.js";
import { FileTaskStore } from "../dist/storage/taskStore.js";

// Round-9 P2-E crash worker. Runs a workflow whose executeStep hard-exits the
// process AFTER the engine persisted the running step. The parent reopens the
// store and asserts the run-intent event is already durable. The exit code 42
// is the signal that the hard exit happened; any other failure exits 1.

const [root, taskId, workflowId] = process.argv.slice(2);
if (root === undefined || taskId === undefined || workflowId === undefined) {
  console.error("round9 crash worker requires root, Task, and workflow ids");
  process.exit(1);
}

const store = new FileTaskStore(root);
const ports = {
  executeStep: async () => {
    // The engine persisted the running step (and the grant use) before this
    // call. A hard exit here is the SIGKILL-equivalent the audit trail must
    // survive: the run-intent event must already be on disk.
    process.exit(42);
  },
  queryStepEffect: async () => ({ state: "unknown" })
};

try {
  await runWorkflowCommandAsync(["run", taskId, workflowId], store, {
    now: () => new Date("2026-08-15T06:30:00.000Z"),
    ports
  });
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
