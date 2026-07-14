import assert from "node:assert/strict";
import test from "node:test";

import {
  InMemoryOperatorRoleBindingAuthority,
  OperatorRoleBindingFenceError
} from "../dist/operator/operatorRoleBindingAuthority.js";

const now = new Date("2026-07-14T07:10:00.000Z");

function binding(overrides = {}) {
  return {
    roleName: "operator",
    generation: "role-generation-1",
    agentId: "codex",
    adapterId: "codex",
    workspace: "/workspace/operator",
    ...overrides
  };
}

test("the authority port owns reserve, running, and terminal transitions behind one binding fence", () => {
  const authority = new InMemoryOperatorRoleBindingAuthority(binding(), {
    nextReservationId: () => "reservation-1",
    nextNativeSessionId: () => "native-1",
    now: () => now
  });

  const reservation = authority.reserve();
  assert.deepEqual(reservation, {
    roleName: "operator",
    generation: "role-generation-1",
    reservationId: "reservation-1",
    agentId: "codex",
    adapterId: "codex",
    nativeSessionId: "native-1",
    reservedAt: now.toISOString()
  });
  assert.equal(authority.read().session.status, "reserved");

  authority.markRunning(reservation, new Date("2026-07-14T07:10:01.000Z"));
  assert.equal(authority.read().session.status, "running");
  authority.markTerminal(reservation, "stopped", new Date("2026-07-14T07:10:02.000Z"));

  const terminal = authority.read().session;
  assert.equal(terminal.status, "stopped");
  assert.equal(terminal.terminalAt, "2026-07-14T07:10:02.000Z");
  assert.equal("nativeLedgerPath" in terminal, false);
});

test("a stale foreground controller cannot mutate a role binding after the authority generation changes", () => {
  const authority = new InMemoryOperatorRoleBindingAuthority(binding(), {
    nextReservationId: () => "reservation-1",
    nextNativeSessionId: () => "native-1",
    now: () => now
  });
  const reservation = authority.reserve();

  authority.replaceBinding(binding({ generation: "role-generation-2" }));

  assert.throws(
    () => authority.markRunning(reservation, new Date("2026-07-14T07:10:01.000Z")),
    OperatorRoleBindingFenceError
  );
  assert.equal(authority.read().session, null);
});
