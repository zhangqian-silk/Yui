import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  createProductionRuntimeIdentityPorts
} from "../../dist/observability/runtimeIdentity.js";

test("runtime source identity does not inherit a Git HEAD from an ancestor directory", (t) => {
  const repository = mkdtempSync(join(tmpdir(), "yui-runtime-identity-"));
  t.after(() => rmSync(repository, { recursive: true, force: true }));

  execFileSync("git", ["init", "--quiet"], { cwd: repository });
  execFileSync("git", ["config", "user.email", "runtime-identity@example.invalid"], {
    cwd: repository
  });
  execFileSync("git", ["config", "user.name", "Runtime Identity Test"], {
    cwd: repository
  });
  writeFileSync(join(repository, "host.txt"), "host repository\n");
  execFileSync("git", ["add", "host.txt"], { cwd: repository });
  execFileSync("git", ["commit", "--quiet", "-m", "host"], { cwd: repository });

  const head = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: repository,
    encoding: "utf8"
  }).trim();
  const installedPackage = join(repository, "node_modules", "@zq-silk", "yui");
  mkdirSync(installedPackage, { recursive: true });

  const checkoutPorts = createProductionRuntimeIdentityPorts(repository, "unused");
  const installedPorts = createProductionRuntimeIdentityPorts(installedPackage, "unused");
  assert.equal(checkoutPorts.gitHead(repository), head);
  assert.equal(installedPorts.gitHead(installedPackage), null);
});
