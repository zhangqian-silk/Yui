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
    "storage",
    "storage convert-task-identity",
    "web",
    "completion",
    "completion bash",
    "completion zsh",
    "completion fish",
    "controller",
    "controller status",
    "controller cleanup",
    "controller stop",
    "controller restart",
    "config",
    "config show",
    "config set",
    "config review",
    "config review show",
    "config review set",
    "config review clear",
    "operator",
    "operator enter",
    "operator new",
    "operator list",
    "operator resume",
    "operator submit",
    "project",
    "project add",
    "project clone",
    "project refresh",
    "project update",
    "project discover",
    "project list",
    "project show",
    "project knowledge",
    "project knowledge add",
    "project knowledge update",
    "project knowledge retire",
    "project knowledge list",
    "project knowledge show",
    "agent",
    "agent add",
    "agent list",
    "agent show",
    "agent capabilities",
    "agent update",
    "agent remove",
    "profile",
    "profile add",
    "profile list",
    "profile show",
    "profile update",
    "profile remove",
    "profile reset",
    "role",
    "role add",
    "role list",
    "role show",
    "role update",
    "role remove",
    "role bind",
    "role unbind",
    "role enter",
    "role session",
    "role session record",
    "role session replace",
    "task",
    "task create",
    "task project",
    "task project list",
    "task project add",
    "task update",
    "task activate",
    "task complete",
    "task reopen",
    "task list",
    "task show",
    "task context",
    "task archive",
    "task reconcile",
    "task message",
    "task message send",
    "task message list",
    "task input",
    "task input request",
    "task input list",
    "task input show",
    "task input answer",
    "task input cancel",
    "task role",
    "task role add",
    "task role list",
    "task role status",
    "task role show",
    "task role update",
    "task role remove",
    "task role bind",
    "task role unbind",
    "task role enter",
    "task work",
    "task work create",
    "task work list",
    "task work update",
    "task work scope",
    "task work dispatch",
    "task work isolate",
    "task work capture",
    "task work cleanup",
    "task work review",
    "task work accept",
    "task work reject",
    "task work cancel",
    "task run",
    "task run list",
    "task run retry",
    "task run yield",
    "task integration",
    "task integration start",
    "task integration continue",
    "task integration resolve",
    "task integration abort",
    "task integration list",
    "task integration show",
    "task integration cleanup",
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
    /Duplicate command path: yui task create/
  );
});

test("nested help resolves and renders only the requested command group", () => {
  const invocation = routeInvocation(["help", "task", "integration"]);

  assert.equal(invocation.kind, "help");
  assert.deepEqual(invocation.node.path, ["yui", "task", "integration"]);

  const output = renderCommandHelp(invocation.node, "0.2.0");
  assert.match(output, /^Yui task integration$/m);
  assert.match(output, /Usage:\n  yui task integration <command>/);
  assert.match(output, /^  start\s+/m);
  assert.match(output, /^  list\s+/m);
  assert.match(output, /^  show\s+/m);
  assert.doesNotMatch(output, /task work|session-notify|internal/);
});

test("help describes every supported file-input and integration-evidence option", () => {
  const expected = [
    [["yui", "task", "create"], "--require-integration"],
    [["yui", "task", "update"], "--require-integration"],
    [["yui", "task", "complete"], "--summary-file"],
    [["yui", "task", "message", "send"], "--body-file"],
    [["yui", "task", "run", "yield"], "--summary-file"],
    [["yui", "operator", "submit"], "--body-file"]
  ];
  for (const [path, option] of expected) {
    const node = path.slice(1).reduce(
      (current, name) => current?.children.find((child) => child.name === name),
      ROOT_COMMAND
    );
    assert.ok(node, path.join(" "));
    assert.ok(node.options.includes(option), `${path.join(" ")} must expose ${option}`);
    assert.match(renderCommandHelp(node, "0.2.0"), new RegExp(option));
  }
});

test("the invocation router selects an executable without parsing business params", () => {
  const invocation = routeInvocation([
    "task",
    "integration",
    "show",
    "integration-1"
  ]);

  assert.equal(invocation.kind, "execute");
  assert.deepEqual(invocation.node.path, ["yui", "task", "integration", "show"]);
  assert.equal("params" in invocation, false);
});

test("the invocation router handles root help", () => {
  const invocation = routeInvocation(["help"]);

  assert.equal(invocation.kind, "help");
  assert.equal(invocation.node, ROOT_COMMAND);
});

test("the invocation router reports an unknown path at the nearest group", () => {
  const invocation = routeInvocation(["task", "integration", "unknown"]);

  assert.equal(invocation.kind, "path-error");
  assert.equal(invocation.typedPath, "task integration unknown");
  assert.deepEqual(invocation.helpNode.path, ["yui", "task", "integration"]);
});

test("the invocation router reports a bare group as incomplete", () => {
  const invocation = routeInvocation(["task", "integration"]);

  assert.equal(invocation.kind, "incomplete");
  assert.equal(invocation.typedPath, "task integration");
  assert.deepEqual(invocation.helpNode.path, ["yui", "task", "integration"]);
});

test("the canonical execution commands are callable while the redundant yield alias stays hidden", () => {
  const workUpdate = routeInvocation(["task", "work", "update", "work-item-1", "done"]);
  assert.equal(workUpdate.kind, "execute");
  assert.deepEqual(workUpdate.node.path, ["yui", "task", "work", "update"]);

  const legacyYield = routeInvocation([
    "task", "yield", "run-1", "--summary", "waiting"
  ]);
  assert.equal(legacyYield.kind, "path-error");
  assert.equal(legacyYield.typedPath, "task yield");

  const runYield = routeInvocation([
    "task", "run", "yield", "run-1", "--summary", "waiting"
  ]);
  assert.equal(runYield.kind, "execute");
  assert.deepEqual(runYield.node.path, ["yui", "task", "run", "yield"]);

  const internal = routeInvocation(["internal", "session-notify", "{}"]);
  assert.equal(internal.kind, "execute");
  assert.deepEqual(internal.node.path, ["yui", "internal", "session-notify"]);

  const completion = routeInvocation([
    "completion", "candidates", "--shell", "zsh", "--index", "1", "--", "task"
  ]);
  assert.equal(completion.kind, "execute");
  assert.deepEqual(completion.node.path, ["yui", "completion", "candidates"]);
});
