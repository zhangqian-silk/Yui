import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  runGitLifecycleMaintenanceCommand
} from "../dist/commands/gitLifecycleMaintenanceCommands.js";
import { ROOT_COMMAND } from "../dist/cli/commandCatalog.js";

test("manual Git lifecycle maintenance accepts only git recover and reports deterministic counts", (t) => {
  const home = mkdtempSync(join(tmpdir(), "taskmux-git-maintenance-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  mkdirSync(home, { recursive: true });

  assert.equal(
    runGitLifecycleMaintenanceCommand(["git", "recover"], home),
    "Git lifecycle recovery: 0 completed, 0 active-lease-skipped, 0 not-started-skipped.\n"
  );
  assert.throws(
    () => runGitLifecycleMaintenanceCommand(["git"], home),
    /maintenance git recover/i
  );
  assert.throws(
    () => runGitLifecycleMaintenanceCommand(["git", "recover", "--all"], home),
    /maintenance git recover/i
  );
});

test("Git recovery is exposed only through the maintenance command hierarchy", () => {
  const maintenance = ROOT_COMMAND.children.find((node) => node.name === "maintenance");
  assert.ok(maintenance);
  const git = maintenance.children.find((node) => node.name === "git");
  assert.ok(git);
  assert.deepEqual(git.children.map((node) => node.name), ["recover"]);
  assert.match(git.children[0].summary, /effect-started/i);
  const task = ROOT_COMMAND.children.find((node) => node.name === "task");
  assert.ok(task);
  assert.equal(task.children.some((node) => node.name === "worktree" && node.children.some((child) => child.name === "retire")), false);
});
