import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { installMockProviderCommands } from "../helpers/mockProviderCommands.js";

test("Home-local Provider commands are observable Mock Agents", (t) => {
  const root = mkdtempSync(join(tmpdir(), "yui-mock-provider-command-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const home = join(root, "yui-home");
  const commands = installMockProviderCommands(home, ["codex", "claude"]);

  assert.equal(commands.codex.command, join(home, "runtime", "bin", "codex"));
  assert.equal(commands.claude.command, join(home, "runtime", "bin", "claude"));

  const launched = spawnSync(commands.codex.command, ["--model", "must-stay-local"], {
    encoding: "utf8",
    env: {
      ...process.env,
      YUI_HOME: home,
      YUI_TEST_MOCK_PROVIDER_ONESHOT: "1"
    }
  });
  assert.equal(launched.status, 0, launched.stderr || launched.error?.message);

  const observations = readFileSync(commands.codex.observationPath, "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  assert.deepEqual(observations.map(({ adapter, args, yuiHome }) => ({
    adapter,
    args,
    yuiHome
  })), [{
    adapter: "codex",
    args: ["--model", "must-stay-local"],
    yuiHome: home
  }]);
});
