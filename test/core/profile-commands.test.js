import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createConfiguredAgent } from "../../dist/agent/agent.js";
import { runProfileCommand } from "../../dist/commands/profileCommands.js";
import { updateAgentProfile } from "../../dist/profile/agentProfile.js";
import { ensureStorageSchema } from "../../dist/storage/storageSchema.js";
import { FileTaskStore } from "../../dist/storage/taskStore.js";

test("Profile CLI uses the same AgentProfile record name and revisions updates", () => {
  const home = mkdtempSync(join(tmpdir(), "yui-profile-cli-"));
  const now = new Date("2026-07-26T00:00:00.000Z");
  ensureStorageSchema(home, now);
  const store = new FileTaskStore(home);
  store.saveConfiguredAgent(createConfiguredAgent("codex", "codex", "codex", [], [], now));
  store.saveConfiguredAgent(createConfiguredAgent("claude", "claude", "claude", [], [], now));

  assert.equal(runProfileCommand([
    "add", "security-reviewer",
    "--agent", "codex",
    "--access", "read",
    "--description", "Review authentication changes.",
    "--instructions", "Do not modify files."
  ], store, () => now).output, "Added Agent Profile security-reviewer\n");
  assert.match(runProfileCommand(["show", "security-reviewer"], store).output, /Revision: 1/);
  assert.match(runProfileCommand(["list"], store).output, /security-reviewer/);
  assert.equal(runProfileCommand([
    "update", "security-reviewer", "--effort", "high"
  ], store, () => new Date("2026-07-26T00:01:00.000Z")).output,
  "Updated Agent Profile security-reviewer to revision 2\n");
  const profile = store.getAgentProfile("security-reviewer");
  assert.equal(profile.revision, 2);
  assert.equal(profile.effort, "high");
  assert.equal(store.getAgentProfileRevision("security-reviewer", 1).revision, 1);
  assert.equal(store.getAgentProfileRevision("security-reviewer", 2).revision, 2);
  assert.throws(
    () => runProfileCommand([
      "update", "security-reviewer", "--sandbox", "read-only"
    ], store, () => new Date("2026-07-26T00:02:00.000Z")),
    /Unsupported option: --sandbox/
  );
  assert.throws(
    () => runProfileCommand([
      "add", "claude-reviewer", "--agent", "claude", "--access", "read"
    ], store, () => new Date("2026-07-26T00:02:00.000Z")),
    /Codex/
  );
  runProfileCommand(
    ["reset"],
    store,
    () => new Date("2026-07-26T00:03:00.000Z")
  );
  store.saveAgentProfile(updateAgentProfile(
    store.getAgentProfile("worker"),
    { instructions: "Custom instructions that reset must remove." },
    new Date("2026-07-26T00:04:00.000Z")
  ));
  runProfileCommand(
    ["reset"],
    store,
    () => new Date("2026-07-26T00:05:00.000Z")
  );
  assert.equal(store.getAgentProfile("worker").instructions, undefined);
  const response = JSON.parse(execFileSync(
    process.execPath,
    [
      join(process.cwd(), "dist", "cli.js"),
      "--json", "profile", "show", "security-reviewer"
    ],
    { encoding: "utf8", env: { ...process.env, YUI_HOME: home } }
  ));
  assert.equal(response.ok, true);
  assert.equal(response.output, undefined);
  assert.equal(response.data.profile.id, "security-reviewer");
  assert.equal(response.data.profile.revision, 2);
  assert.throws(
    () => runProfileCommand(["remove", "worker"], store),
    /Built-in Agent Profile cannot be removed/
  );
});
