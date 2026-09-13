// Deterministic external boundary for the assembled-package smoke. No model,
// account, network, or real Codex installation is used.
import { createInterface } from "node:readline";

const args = process.argv.slice(2);
if (args.includes("--version")) {
  console.log("codex-cli 0.150.1");
} else if (args.includes("--help")) {
  console.log("--model --config --profile --add-dir --search --dangerously-bypass-approvals-and-sandbox\n"
    + "  --sandbox [possible values: read-only, workspace-write, danger-full-access]\n"
    + "  --ask-for-approval [possible values: untrusted, on-request, never]");
} else if (args.includes("app-server") && args.includes("proxy")) {
  process.env.YUI_FAKE_THREAD_ID = `fixture-${process.env.YUI_TASK_ID ?? "global"}-${process.env.YUI_ROLE ?? "reader"}`;
  await import("./fake-codex-app-server-proxy.mjs");
} else if (args.includes("app-server") && args.includes("--stdio")) {
  const lines = createInterface({ input: process.stdin });
  lines.on("line", line => {
    const request = JSON.parse(line);
    if (request.id === undefined) return;
    const results = {
      initialize: { userAgent: "fixture" },
      "model/list": { data: [], nextCursor: null },
      "configRequirements/read": { requirements: null },
      "modelProvider/capabilities/read": { webSearch: false }
    };
    const reply = Object.hasOwn(results, request.method)
      ? { id: request.id, result: results[request.method] }
      : { id: request.id, error: { code: -32601, message: `Unexpected fixture RPC: ${request.method}` } };
    process.stdout.write(`${JSON.stringify(reply)}\n`);
  });
} else {
  throw new Error(`Unexpected fixture command: ${args.join(" ")}`);
}
