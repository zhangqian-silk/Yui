import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";

test("npm publish workflow builds, clean-installs, and publishes one assembled two-arch runtime tarball", () => {
  const workflow = readFileSync(
    join(process.cwd(), ".github", "workflows", "publish.yml"),
    "utf8"
  );

  assert.match(workflow, /tags:\n\s+- "v\*"/);
  assert.match(workflow, /id-token:\s+write/);
  assert.match(workflow, /environment:\s+npm/);
  assert.match(workflow, /\n  assemble-universal:\n/);
  assert.match(workflow, /node-version:\s+"24"/);
  assert.match(workflow, /arch:\s+x64/);
  assert.match(workflow, /arch:\s+arm64/);
  assert.match(workflow, /node:\s+20/);
  assert.match(workflow, /node:\s+22/);
  assert.match(workflow, /node:\s+24/);
  assert.match(workflow, /npm ci --ignore-scripts/);
  assert.match(workflow, /npm run verify:release-tag/);
  assert.match(workflow, /node scripts\/verify-native-prebuild\.mjs --all/);
  assert.match(
    workflow,
    /prebuilds\/linux-\$\{\{ matrix\.arch \}\}-glibc\/napi-v8\/taskmux_storage_fs\.node/
  );
  assert.match(workflow, /prebuilds\/manifest\.json/);
  assert.match(workflow, /assemble-runtime-package\.mjs --all --output \.release-stage/);
  assert.doesNotMatch(workflow, /assemble-runtime-package\.mjs --host/);
  assert.equal([...workflow.matchAll(/assemble-runtime-package\.mjs/g)].length, 1);
  assert.match(workflow, /npm pack \.\/\.release-stage --json/);
  assert.equal([...workflow.matchAll(/npm pack \.\/\.release-stage --json/g)].length, 1);
  assert.match(workflow, /name: taskmux-runtime-tarball/);
  assert.match(workflow, /path: taskmux-runtime\.tgz/);
  assert.match(workflow, /release-artifact\/taskmux-runtime\.tgz/);
  assert.match(workflow, /pkg\.private !== false/);
  assert.match(workflow, /"scripts" in pkg/);
  assert.match(workflow, /"devDependencies" in pkg/);
  assert.match(workflow, /npm install --prefix "\$consumer" "\$TASKMUX_TGZ"/);
  assert.doesNotMatch(
    workflow,
    /npm install --ignore-scripts --prefix "\$consumer" "\$TASKMUX_TGZ"/
  );
  assert.match(workflow, /scripts\/smoke-runtime-package\.mjs/);
  assert.match(workflow, /scripts\/smoke-native-prebuild\.mjs/);
  for (const skill of ["taskmux-leader", "taskmux-worker", "taskmux-operator"]) {
    assert.match(workflow, new RegExp(`package/skills/${skill}/SKILL\\.md`));
  }
  assert.match(workflow, /grep -Ec '\^package\/skills\/' package-files\.txt/);
  assert.match(workflow, /npm publish "\$TASKMUX_TGZ" --access public/);
  assert.doesNotMatch(workflow, /npm publish --access public/);
  assert.doesNotMatch(workflow, /NPM_TOKEN|NODE_AUTH_TOKEN|--otp/);
});
