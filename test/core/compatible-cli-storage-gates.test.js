import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

function source(path) {
  return readFileSync(join(process.cwd(), path), "utf8");
}

test("ordinary CLI dispatch does not preempt compatible storage with a strict schema gate", () => {
  const cli = source("src/cli.ts");

  assert.equal(
    [...cli.matchAll(/\brequireStorageSchema\s*\(/g)].length,
    0,
    "CLI callers must delegate storage compatibility to the compatible opener"
  );
  assert.match(
    cli,
    /\bvalidateCompatibleFileTaskStore\s*\(\s*home\s*\)/,
    "Controller stop/restart must still validate storage before lifecycle changes"
  );
});

test("setup initializes new storage without preempting compatible existing storage", () => {
  const setup = source("src/setup/setupCommand.ts");

  assert.doesNotMatch(
    setup,
    /\bensureStorageSchema\s*\(\s*home\s*\)/,
    "setup must not apply the strict current-only gate to an existing Home"
  );
  assert.match(setup, /\binitializeCompatibleFileTaskStore\s*\(\s*home\s*\)/);
});
