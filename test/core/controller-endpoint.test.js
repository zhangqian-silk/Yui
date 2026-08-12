import assert from "node:assert/strict";
import test from "node:test";

import { controllerSocketPath, isControllerSocketPathForHome } from "../../dist/core/controllerEndpoint.js";

test("Controller socket path falls back to a compact root for deep Linux TMPDIR", () => {
  if (process.platform !== "linux") return;
  const originalTmpdir = process.env.TMPDIR;
  const home = "/tmp/yui-endpoint-test/home";
  try {
    process.env.TMPDIR = "/tmp/" + "deep-runtime/".repeat(12);
    const socketPath = controllerSocketPath(home);
    assert.ok(Buffer.byteLength(socketPath) < 100);
    assert.equal(isControllerSocketPathForHome(home, socketPath), true);
    assert.match(socketPath, /^\/tmp\/yui-\d+\/[0-9a-f]{24}\.sock$/u);
  } finally {
    if (originalTmpdir === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = originalTmpdir;
  }
});
