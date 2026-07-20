import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";

const root = resolve(import.meta.dirname, "../..");

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

test("the source package has one TypeScript-only build and no native runtime dependency", () => {
  const sourcePackage = readJson(join(root, "package.json"));
  const tsconfig = readJson(join(root, "tsconfig.json"));

  assert.equal(sourcePackage.scripts.build, "tsc -p tsconfig.json");
  assert.equal(sourcePackage.scripts.pretest, "npm run build");
  assert.equal(
    sourcePackage.scripts.test,
    "env -u FORCE_COLOR NO_COLOR=1 node --test test/*.test.js test/core/*.test.js"
  );
  assert.equal(sourcePackage.scripts.lint, "tsc -p tsconfig.json --noEmit");
  assert.equal("build:native" in sourcePackage.scripts, false);
  assert.equal("prebuild" in sourcePackage.scripts, false);
  assert.equal("node-gyp" in sourcePackage.devDependencies, false);
  assert.equal("gypfile" in sourcePackage, false);
  assert.equal(sourcePackage.dependencies?.["better-sqlite3"], undefined);
  assert.equal(sourcePackage.devDependencies["@types/better-sqlite3"], undefined);
  assert.deepEqual(sourcePackage.cpu, ["x64"]);
  assert.deepEqual(sourcePackage.files, [
    "dist",
    "skills",
    "README.md",
    "ARCHITECTURE.md",
    "i18n/README.zh-CN.md",
    "LICENSE"
  ]);
  assert.deepEqual(tsconfig.include, ["src/**/*.ts"]);
});

test("runtime assembly contains only the built CLI, docs, and three skills", (t) => {
  const sandbox = mkdtempSync(join(root, ".core-package-test-"));
  const output = join(sandbox, "runtime");
  const legacy = join(root, "dist", "core", "legacy.js");
  const previousLegacy = existsSync(legacy) ? readFileSync(legacy) : undefined;
  writeFileSync(legacy, "throw new Error('stale build output');\n");
  t.after(() => rmSync(sandbox, { recursive: true, force: true }));
  t.after(() => {
    if (previousLegacy === undefined) {
      rmSync(legacy, { force: true });
    } else {
      writeFileSync(legacy, previousLegacy);
    }
  });

  execFileSync(
    process.execPath,
    [join(root, "scripts", "assemble-runtime-package.mjs"), "--output", output],
    { cwd: root, stdio: "pipe" }
  );

  assert.deepEqual(
    readdirSync(output).sort(),
    ["ARCHITECTURE.md", "LICENSE", "README.md", "dist", "i18n", "package.json", "skills"]
  );
  assert.deepEqual(readdirSync(join(output, "i18n")), ["README.zh-CN.md"]);
  assert.deepEqual(
    readdirSync(join(output, "skills")).sort(),
    ["taskmux-leader", "taskmux-operator", "taskmux-worker"]
  );
  const expectedRuntime = listFiles(join(root, "src"))
    .filter((name) => name.endsWith(".ts"))
    .map((name) => name.replace(/\.ts$/u, ".js"))
    .sort();
  assert.deepEqual(listFiles(join(output, "dist")), expectedRuntime);
  assert.equal(existsSync(join(output, "dist", "core", "legacy.js")), false);
  assert.match(
    execFileSync(process.execPath, [join(output, "dist", "cli.js"), "help"], {
      cwd: output,
      encoding: "utf8"
    }),
    /TaskMux/u
  );

  const runtimePackage = readJson(join(output, "package.json"));
  const sourcePackage = readJson(join(root, "package.json"));
  assert.equal(runtimePackage.private, false);
  assert.deepEqual(runtimePackage.bin, { taskmux: "./dist/cli.js" });
  assert.deepEqual(runtimePackage.cpu, ["x64"]);
  assert.deepEqual(runtimePackage.files, sourcePackage.files);
  assert.equal(runtimePackage.dependencies, undefined);
  assert.equal("scripts" in runtimePackage, false);
  assert.equal("devDependencies" in runtimePackage, false);
});

test("publish builds once and smokes the same package on Node 20, 22, and 24", () => {
  const workflow = readFileSync(join(root, ".github", "workflows", "publish.yml"), "utf8");
  const smoke = readFileSync(join(root, "scripts", "smoke-runtime-package.mjs"), "utf8");

  assert.match(workflow, /node:\s*\[20, 22, 24\]/u);
  assert.match(workflow, /npm run build/u);
  assert.match(workflow, /npm test/u);
  assert.match(workflow, /npm run lint/u);
  assert.match(workflow, /dist\/cli\/commandCatalog\.js/u);
  assert.match(workflow, /dist\/output\/terminal\.js/u);
  assert.doesNotMatch(workflow, /native-prebuild|prebuilds\/|smoke-native|build:native/u);
  assert.match(smoke, /nested help/u);
  assert.match(smoke, /Draft Task/u);
});

function listFiles(directory, prefix = "") {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const relative = prefix.length === 0 ? entry.name : `${prefix}/${entry.name}`;
    return entry.isDirectory()
      ? listFiles(join(directory, entry.name), relative)
      : [relative];
  }).sort();
}
