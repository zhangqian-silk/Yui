/**
 * Regression coverage for the canonical Home identity and the Task workspace
 * identity derivation contract:
 *
 *  - the Home id is high-entropy and self-validating;
 *  - the Task token is the first 8 lowercase hex chars of a length-prefixed
 *    SHA-256 over (domain, Home id, Task id, generatedAt, 128-bit entropy);
 *  - the token is sensitive to every input and stable for identical inputs;
 *  - two Homes working on the same Task number derive different tokens;
 *  - the persisted identity is self-validating (a mismatched token is
 *    malformed state, rejected, never repaired);
 *  - binding is idempotent for the same identity and immutable afterwards;
 *  - ref derivation is strict: `yui/task-N-<8hex>/main` for the main branch,
 *    derived WorkItem/Review/Integration refs under the same segment, and a
 *    Home-scoped non-colliding archive namespace for legacy refs.
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  generateHomeIdentity,
  validateHomeIdentity
} from "../../dist/repository/homeIdentity.js";
import {
  deriveTaskWorkspaceToken,
  generateTaskWorkspaceIdentity,
  isLegacyTaskRef,
  taskArchiveRef,
  taskDerivedBranch,
  taskIntegrationBranch,
  taskMainBranch,
  taskWorkspaceRefSegment,
  taskWorkspaceRefSegmentFromIdentity,
  TASK_WORKSPACE_REF_SEGMENT_PATTERN,
  TASK_WORKSPACE_TOKEN_PATTERN,
  validateTaskWorkspaceIdentity
} from "../../dist/repository/taskWorkspaceIdentity.js";
import { bindTaskWorkspaceIdentity } from "../../dist/task/task.js";
import { createTask } from "../../dist/task/task.js";

const NOW = new Date("2026-08-13T00:00:00.000Z");
const LATER = new Date("2026-08-13T01:00:00.000Z");

function fixedEntropy(value) {
  return () => Buffer.from(value, "hex");
}

test("the Home identity is a high-entropy, self-validating persistent record", () => {
  const identity = generateHomeIdentity(NOW, fixedEntropy("01".repeat(16)));
  assert.match(identity.homeId, /^home-[a-f0-9]{16}$/);
  assert.equal(identity.entropy, "01".repeat(16));
  assert.equal(identity.createdAt, NOW.toISOString());
  assert.equal(identity.schemaVersion, 1);
  assert.doesNotThrow(() => validateHomeIdentity(identity));

  // Two Homes never share an id: the id itself carries 64 random bits.
  const other = generateHomeIdentity(NOW, fixedEntropy("02".repeat(16)));
  assert.notEqual(other.homeId, identity.homeId);

  for (const malformed of [
    { ...identity, schemaVersion: 2 },
    { ...identity, homeId: "home-short" },
    { ...identity, homeId: "HOME-" + "a".repeat(16) },
    { ...identity, entropy: "not-hex" },
    { ...identity, createdAt: "not-a-date" }
  ]) {
    assert.throws(() => validateHomeIdentity(malformed), /Home identity/i);
  }
});

test("the Task token binds every input through a length-prefixed SHA-256", () => {
  const input = {
    homeId: "home-" + "a".repeat(16),
    taskId: "task-1",
    generatedAt: NOW.toISOString(),
    entropy: "01".repeat(16)
  };
  const token = deriveTaskWorkspaceToken(input);
  assert.match(token, TASK_WORKSPACE_TOKEN_PATTERN);
  // Deterministic: identical inputs derive the identical token.
  assert.equal(deriveTaskWorkspaceToken(input), token);

  // Sensitive to every single input.
  for (const [label, changed] of [
    ["home id", { ...input, homeId: "home-" + "b".repeat(16) }],
    ["task id", { ...input, taskId: "task-2" }],
    ["generatedAt", { ...input, generatedAt: LATER.toISOString() }],
    ["entropy", { ...input, entropy: "02".repeat(16) }]
  ]) {
    assert.notEqual(
      deriveTaskWorkspaceToken(changed),
      token,
      `token must change when ${label} changes`
    );
  }

  // Length prefixes make the encoding unambiguous: a newline inside a value
  // cannot shift a field boundary. Without prefixes these two inputs encode
  // to the same bytes ("a\nb\nc"); with prefixes they are distinct.
  const rest = { generatedAt: input.generatedAt, entropy: input.entropy };
  assert.notEqual(
    deriveTaskWorkspaceToken({ homeId: "a\nb", taskId: "c", ...rest }),
    deriveTaskWorkspaceToken({ homeId: "a", taskId: "b\nc", ...rest })
  );
});

test("two Homes preparing the same Task number derive distinct tokens", () => {
  const first = generateHomeIdentity(NOW, fixedEntropy("01".repeat(16)));
  const second = generateHomeIdentity(NOW, fixedEntropy("02".repeat(16)));
  const firstToken = generateTaskWorkspaceIdentity({
    home: first,
    taskId: "task-7",
    now: NOW,
    entropy: Buffer.from("03".repeat(16), "hex")
  });
  const secondToken = generateTaskWorkspaceIdentity({
    home: second,
    taskId: "task-7",
    now: NOW,
    entropy: Buffer.from("03".repeat(16), "hex")
  });
  assert.notEqual(firstToken.token, secondToken.token);
  assert.equal(firstToken.taskId, "task-7");
  assert.equal(secondToken.taskId, "task-7");
  assert.match(taskWorkspaceRefSegmentFromIdentity(firstToken), TASK_WORKSPACE_REF_SEGMENT_PATTERN);
  assert.notEqual(
    taskWorkspaceRefSegmentFromIdentity(firstToken),
    taskWorkspaceRefSegmentFromIdentity(secondToken)
  );
});

test("the generated identity is persisted exactly as derived and self-validates", () => {
  const home = generateHomeIdentity(NOW, fixedEntropy("01".repeat(16)));
  const identity = generateTaskWorkspaceIdentity({
    home,
    taskId: "task-3",
    now: NOW,
    entropy: Buffer.from("ab".repeat(16), "hex")
  });
  assert.equal(identity.schemaVersion, 1);
  assert.equal(identity.homeId, home.homeId);
  assert.equal(identity.token, deriveTaskWorkspaceToken({
    homeId: home.homeId,
    taskId: "task-3",
    generatedAt: NOW.toISOString(),
    entropy: "ab".repeat(16)
  }));
  assert.doesNotThrow(() => validateTaskWorkspaceIdentity(identity));

  // A tampered token is malformed state: rejected, never silently repaired.
  const tampered = {
    ...identity,
    token: identity.token === "aaaaaaaa" ? "bbbbbbbb" : "aaaaaaaa"
  };
  assert.throws(
    () => validateTaskWorkspaceIdentity(tampered),
    /token does not match its persisted fields/i
  );
  assert.throws(
    () => generateTaskWorkspaceIdentity({
      home,
      taskId: "task-3",
      now: NOW,
      entropy: Buffer.from("short", "utf8")
    }),
    /entropy is invalid/i
  );
});

test("ref segments are bare before the identity and token-bearing after it", () => {
  const task = createTask("task-5", "Legacy layout", NOW);
  assert.equal(taskWorkspaceRefSegment(task), "task-5");

  const home = generateHomeIdentity(NOW, fixedEntropy("01".repeat(16)));
  const identity = generateTaskWorkspaceIdentity({
    home,
    taskId: "task-5",
    now: NOW,
    entropy: Buffer.from("cd".repeat(16), "hex")
  });
  const bound = bindTaskWorkspaceIdentity(task, identity, LATER);
  const segment = taskWorkspaceRefSegment(bound);
  assert.match(segment, TASK_WORKSPACE_REF_SEGMENT_PATTERN);
  assert.equal(segment, `task-5-${identity.token}`);

  // The main branch is strictly yui/task-N-<8hex>/main.
  assert.equal(taskMainBranch(segment), `yui/${segment}/main`);
  for (const invalid of ["task-5", "yui/task-5/main", "task-5-short", "task-5-ABCDEF01", "5-abcdef01"]) {
    assert.throws(() => taskMainBranch(invalid), /ref segment is invalid/i);
  }
});

test("derived WorkItem, Review, and Integration refs stay under the Task segment", () => {
  const segment = "task-9-0123abcd";
  assert.equal(taskDerivedBranch(segment, "work-item-3"), `yui/${segment}/work-item-3`);
  assert.equal(taskDerivedBranch(segment, "review-round-1"), `yui/${segment}/review-round-1`);
  assert.equal(
    taskIntegrationBranch(segment, "integration-2"),
    `yui/${segment}/integration/integration-2`
  );
  for (const invalid of ["", "with space", "bad~tilde", "two..dots", "-leading"]) {
    assert.throws(() => taskDerivedBranch(segment, invalid), /member is invalid/i);
  }
  assert.throws(
    () => taskDerivedBranch("task-9", "work-item-1"),
    /ref segment is invalid/i
  );
});

test("legacy ref detection separates bare-id, identity-bearing, and foreign refs", () => {
  assert.equal(isLegacyTaskRef("refs/heads/yui/task-1/main"), true);
  assert.equal(isLegacyTaskRef("refs/heads/yui/task-1/work-item-2"), true);
  assert.equal(isLegacyTaskRef("refs/heads/yui/task-12/review-round-1"), true);
  // Identity-bearing branches are never legacy.
  assert.equal(isLegacyTaskRef("refs/heads/yui/task-1-abcdef01/main"), false);
  assert.equal(isLegacyTaskRef("refs/heads/yui/task-12-a1b2c3d4/integration/integration-1"), false);
  // Foreign shapes are not legacy Task refs at all.
  assert.equal(isLegacyTaskRef("refs/heads/main"), false);
  assert.equal(isLegacyTaskRef("refs/heads/feature/x"), false);
  assert.equal(isLegacyTaskRef("refs/yui/archive/home-1/heads/yui/task-1/main"), false);
});

test("archive refs are Home-scoped and preserve the full source ref", () => {
  const homeId = "home-" + "a".repeat(16);
  assert.equal(
    taskArchiveRef(homeId, "refs/heads/yui/task-1/main"),
    `refs/yui/archive/${homeId}/heads/yui/task-1/main`
  );
  assert.equal(
    taskArchiveRef(homeId, "refs/heads/yui/task-4/work-item-7"),
    `refs/yui/archive/${homeId}/heads/yui/task-4/work-item-7`
  );
  // Two Homes archiving the same legacy ref in a shared repository never
  // collide: the Home id is part of the archive path.
  const otherHome = "home-" + "b".repeat(16);
  assert.notEqual(
    taskArchiveRef(homeId, "refs/heads/yui/task-1/main"),
    taskArchiveRef(otherHome, "refs/heads/yui/task-1/main")
  );
  for (const invalid of ["heads/yui/task-1/main", "refs/heads/../escape", "refs/heads/with space"]) {
    assert.throws(() => taskArchiveRef(homeId, invalid), /Archive source ref is invalid/i);
  }
});

test("binding an identity is idempotent for the same identity and immutable after", () => {
  const task = createTask("task-8", "Identity binding", NOW, {
    projectBindings: [{ projectId: "project-1", directory: "Yui", baseRef: "main" }]
  });
  const home = generateHomeIdentity(NOW, fixedEntropy("01".repeat(16)));
  const identity = generateTaskWorkspaceIdentity({
    home,
    taskId: "task-8",
    now: NOW,
    entropy: Buffer.from("ee".repeat(16), "hex")
  });
  const first = bindTaskWorkspaceIdentity(task, identity, LATER);
  assert.equal(first.workspaceIdentity, identity);

  // Same identity again: idempotent, no timestamp churn.
  const again = bindTaskWorkspaceIdentity(first, identity, new Date("2026-08-13T09:00:00.000Z"));
  assert.equal(again, first);

  // A different identity (even for the same Task id) is rejected.
  const foreign = generateTaskWorkspaceIdentity({
    home,
    taskId: "task-8",
    now: LATER,
    entropy: Buffer.from("ff".repeat(16), "hex")
  });
  assert.throws(
    () => bindTaskWorkspaceIdentity(first, foreign, LATER),
    /already bound and immutable/i
  );
  // An identity minted for another Task is rejected.
  const otherTask = generateTaskWorkspaceIdentity({
    home,
    taskId: "task-9",
    now: NOW,
    entropy: Buffer.from("ee".repeat(16), "hex")
  });
  assert.throws(
    () => bindTaskWorkspaceIdentity(first, otherTask, LATER),
    /belongs to another Task/i
  );
});
