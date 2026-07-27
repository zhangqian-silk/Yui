import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";

import {
  codexProfileChoices,
  configurationHelpChoices
} from "../../dist/executor/agentConfigurationProbe.js";

test("help choice parsing reads multiline possible-value bullets without example noise", () => {
  const help = `
  -a, --ask-for-approval <APPROVAL_POLICY>
          Configure when approval is required

          Possible values:
          - untrusted: Only run trusted commands (e.g. ls, cat, sed)
          - on-request: The model decides when to ask
          - never: Never ask

      --search
          Enable search
`;

  assert.deepEqual(
    configurationHelpChoices(help, "--ask-for-approval", []),
    ["untrusted", "on-request", "never"]
  );
});

test("help choice parsing supports inline possible values and choices declarations", () => {
  assert.deepEqual(
    configurationHelpChoices(
      "--sandbox <MODE> [possible values: read-only, workspace-write, danger-full-access]",
      "--sandbox",
      []
    ),
    ["read-only", "workspace-write", "danger-full-access"]
  );
  assert.deepEqual(
    configurationHelpChoices(
      '--permission-mode <mode> (choices: "acceptEdits", "plan")',
      "--permission-mode",
      []
    ),
    ["acceptEdits", "plan"]
  );
});

test("Codex profile choices come from profiles in the effective CODEX_HOME config", (t) => {
  const root = mkdtempSync(join(tmpdir(), "yui-codex-profiles-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(join(root, "config.toml"), `
[profiles.work]
model = "gpt-work"

[profiles.review]
model = "gpt-review"
`);

  assert.deepEqual(codexProfileChoices({ CODEX_HOME: root }), ["review", "work"]);
});

test("catalog timeout force-terminates probes that ignore SIGTERM", async () => {
  const agentModule = pathToFileURL(resolve("dist/agent/agent.js")).href;
  const catalogModule = pathToFileURL(
    resolve("dist/executor/agentConfigurationCatalog.js")
  ).href;
  const probeScript = [
    "process.on('SIGTERM', () => {});",
    "setTimeout(() => process.exit(0), 1200);"
  ].join("");
  const harness = `
    import { mkdtempSync, rmSync } from "node:fs";
    import { tmpdir } from "node:os";
    import { join } from "node:path";
    import { createConfiguredAgent } from ${JSON.stringify(agentModule)};
    import { AgentConfigurationCatalogService } from ${JSON.stringify(catalogModule)};
    const root = mkdtempSync(join(tmpdir(), "yui-probe-timeout-"));
    const agent = createConfiguredAgent(
      "codex",
      "codex",
      process.execPath,
      ["-e", ${JSON.stringify(probeScript)}],
      [],
      new Date()
    );
    const resolved = await new AgentConfigurationCatalogService(root, {
      environment: process.env,
      timeoutMs: 30
    }).resolve({ agent, cwd: process.cwd() });
    rmSync(root, { recursive: true, force: true });
    console.log(resolved.failure?.code);
  `;

  const result = await runHarness(harness, 700);

  assert.equal(result.timedOut, false, "probe children kept the harness alive past the deadline");
  assert.match(result.stdout, /timeout/);
});

function runHarness(source, timeoutMs) {
  return new Promise((resolveResult, reject) => {
    const child = spawn(process.execPath, ["--input-type=module", "-e", source], {
      cwd: process.cwd(),
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      resolveResult({ timedOut: true, stdout, stderr });
    }, timeoutMs);
    child.on("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.on("exit", (code, signal) => {
      clearTimeout(timeout);
      resolveResult({ timedOut: false, code, signal, stdout, stderr });
    });
  });
}
