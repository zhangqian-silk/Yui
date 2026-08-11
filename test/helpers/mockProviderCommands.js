import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const SUPPORTED_ADAPTERS = new Set(["codex", "claude"]);

/**
 * Installs test-owned, long-running Provider command stand-ins in the exact
 * Home-local bin directory that production managed launches put first on PATH.
 * Each invocation records observable arguments without calling a model or the
 * network. YUI_TEST_MOCK_PROVIDER_ONESHOT is reserved for this helper's unit
 * test; managed Session fixtures use the default long-running behavior.
 */
export function installMockProviderCommands(home, adapters = ["codex", "claude"]) {
  const canonicalHome = resolve(home);
  const binDirectory = join(canonicalHome, "runtime", "bin");
  const observationDirectory = join(canonicalHome, "runtime", "mock-provider");
  mkdirSync(binDirectory, { recursive: true, mode: 0o700 });
  mkdirSync(observationDirectory, { recursive: true, mode: 0o700 });

  const installed = {};
  const seen = new Set();
  for (const adapter of adapters) {
    if (!SUPPORTED_ADAPTERS.has(adapter) || seen.has(adapter)) {
      throw new Error(`Unsupported or repeated Mock Provider adapter: ${String(adapter)}`);
    }
    seen.add(adapter);
    const command = join(binDirectory, adapter);
    const observationPath = join(observationDirectory, `${adapter}.ndjson`);
    writeFileSync(command, mockProviderProgram({
      adapter,
      observationPath
    }), { mode: 0o700 });
    chmodSync(command, 0o700);
    installed[adapter] = Object.freeze({ command, observationPath });
  }
  return Object.freeze(installed);
}

function mockProviderProgram({ adapter, observationPath }) {
  return `#!${process.execPath}
const { appendFileSync, mkdirSync } = require("node:fs");
const { dirname } = require("node:path");

const observationPath = ${JSON.stringify(observationPath)};
mkdirSync(dirname(observationPath), { recursive: true, mode: 0o700 });
appendFileSync(observationPath, JSON.stringify({
  adapter: ${JSON.stringify(adapter)},
  args: process.argv.slice(2),
  yuiHome: process.env.YUI_HOME ?? null,
  pid: process.pid
}) + "\\n");

if (process.env.YUI_TEST_MOCK_PROVIDER_ONESHOT === "1") process.exit(0);

const keepAlive = setInterval(() => {}, 2 ** 30);
const stop = () => {
  clearInterval(keepAlive);
  process.exit(0);
};
process.once("SIGINT", stop);
process.once("SIGTERM", stop);
process.once("SIGHUP", stop);
`;
}
