import assert from "node:assert/strict";
import test from "node:test";

import { handoffTerminal } from "../../dist/tmux/terminalHandoff.js";

test("terminal handoff restores and pauses the TTY even when readline cleanup fails", () => {
  const events = [];
  const input = {
    isTTY: true,
    isRaw: true,
    setRawMode(enabled) {
      events.push(`raw:${enabled}`);
      this.isRaw = enabled;
    },
    pause() {
      events.push("pause");
      return this;
    }
  };

  assert.throws(
    () => handoffTerminal(input, () => {
      events.push("close");
      throw new Error("readline close failed");
    }),
    /readline close failed/u
  );
  assert.deepEqual(events, ["close", "raw:false", "pause"]);
  assert.equal(input.isRaw, false);
});
