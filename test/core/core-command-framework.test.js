import assert from "node:assert/strict";
import test from "node:test";

import {
  ROOT_COMMAND,
  listPublicCommandPaths,
  validateCommandCatalog
} from "../../dist/cli/commandCatalog.js";
import { renderCommandHelp } from "../../dist/cli/helpRenderer.js";
import { routeInvocation } from "../../dist/cli/invocationRouter.js";

test("the declarative catalog exposes exactly the lean public command surface", () => {
  assert.doesNotThrow(() => validateCommandCatalog(ROOT_COMMAND));
  assert.deepEqual(listPublicCommandPaths(), [
    "help",
    "version",
    "update",
    "setup",
    "doctor",
    "completion",
    "completion bash",
    "completion zsh",
    "completion fish",
    "controller",
    "controller status",
    "controller stop",
    "controller restart",
    "operator",
    "operator enter",
    "operator submit",
    "repository",
    "repository add",
    "repository list",
    "agent",
    "agent add",
    "agent list",
    "agent show",
    "agent update",
    "agent remove",
    "role",
    "role add",
    "role list",
    "role show",
    "role update",
    "role remove",
    "role bind",
    "role enter",
    "role session",
    "role session record",
    "role session replace",
    "task",
    "task create",
    "task update",
    "task activate",
    "task complete",
    "task reopen",
    "task list",
    "task show",
    "task archive",
    "task reconcile",
    "task message",
    "task message send",
    "task message list",
    "task role",
    "task role add",
    "task role list",
    "task role show",
    "task role update",
    "task role remove",
    "task role bind",
    "task role enter",
    "task work",
    "task work create",
    "task work list",
    "task work update",
    "task work dispatch",
    "task run",
    "task run list",
    "task run retry",
    "task run yield",
    "task brief",
    "task brief show",
    "task brief update",
    "task decision",
    "task decision record",
    "task decision list",
    "task decision show",
    "task decision supersede",
    "task milestone",
    "task milestone add",
    "task milestone list",
    "task milestone show",
    "task event",
    "task event list",
    "task event show",
    "task enter",
    "jobs",
    "jobs list",
    "jobs retry"
  ]);

  const internal = ROOT_COMMAND.children.find((child) => child.name === "internal");
  assert.ok(internal);
  assert.equal(internal.hidden, true);
  assert.deepEqual(internal.children.map((child) => child.name), ["session-notify"]);
  const completion = ROOT_COMMAND.children.find((child) => child.name === "completion");
  assert.ok(completion);
  assert.equal(completion.children.find((child) => child.name === "candidates")?.hidden, true);
});

test("catalog validation rejects duplicate sibling command paths", () => {
  const invalid = structuredClone(ROOT_COMMAND);
  const task = invalid.children.find((child) => child.name === "task");
  assert.ok(task);
  const create = task.children.find((child) => child.name === "create");
  assert.ok(create);
  task.children.push(structuredClone(create));

  assert.throws(
    () => validateCommandCatalog(invalid),
    /Duplicate command path: taskmux task create/
  );
});

test("nested help resolves and renders only the requested command group", () => {
  const invocation = routeInvocation(["help", "task", "role"]);

  assert.equal(invocation.kind, "help");
  assert.deepEqual(invocation.node.path, ["taskmux", "task", "role"]);

  const output = renderCommandHelp(invocation.node, "0.1.5");
  assert.match(output, /^TaskMux task role$/m);
  assert.match(output, /Usage:\n  taskmux task role <command>/);
  assert.match(output, /^  add\s+/m);
  assert.match(output, /^  list\s+/m);
  assert.match(output, /^  show\s+/m);
  assert.match(output, /^  update\s+/m);
  assert.match(output, /^  remove\s+/m);
  assert.doesNotMatch(output, /task work|session-notify|internal/);
});

test("the invocation router selects an executable without parsing business params", () => {
  const invocation = routeInvocation([
    "task",
    "role",
    "add",
    "task-1",
    "worker",
    "--agent",
    "codex"
  ]);

  assert.equal(invocation.kind, "execute");
  assert.deepEqual(invocation.node.path, ["taskmux", "task", "role", "add"]);
  assert.equal("params" in invocation, false);
});

test("the invocation router handles root help", () => {
  const invocation = routeInvocation(["help"]);

  assert.equal(invocation.kind, "help");
  assert.equal(invocation.node, ROOT_COMMAND);
});

test("the invocation router reports an unknown path at the nearest group", () => {
  const invocation = routeInvocation(["task", "role", "unknown"]);

  assert.equal(invocation.kind, "path-error");
  assert.equal(invocation.typedPath, "task role unknown");
  assert.deepEqual(invocation.helpNode.path, ["taskmux", "task", "role"]);
});

test("the invocation router reports a bare group as incomplete", () => {
  const invocation = routeInvocation(["task", "role"]);

  assert.equal(invocation.kind, "incomplete");
  assert.equal(invocation.typedPath, "task role");
  assert.deepEqual(invocation.helpNode.path, ["taskmux", "task", "role"]);
});
