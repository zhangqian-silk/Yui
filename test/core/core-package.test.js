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

test("the source package keeps one TypeScript build and declares its Web runtime dependencies", () => {
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
  assert.equal(sourcePackage.dependencies?.["smol-toml"], "1.7.0");
  assert.equal(sourcePackage.dependencies?.["node-pty"], "^1.1.0");
  assert.equal(sourcePackage.dependencies?.["ws"], "^8.21.1");
  assert.equal(sourcePackage.dependencies?.["@xterm/xterm"], "^6.0.0");
  assert.equal(sourcePackage.dependencies?.["@xterm/addon-fit"], "^0.11.0");
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
    ["yui-leader", "yui-operator", "yui-worker"]
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
    /Yui/u
  );

  const runtimePackage = readJson(join(output, "package.json"));
  const sourcePackage = readJson(join(root, "package.json"));
  assert.equal(runtimePackage.private, false);
  assert.deepEqual(runtimePackage.bin, { yui: "./dist/cli.js" });
  assert.deepEqual(runtimePackage.cpu, ["x64"]);
  assert.deepEqual(runtimePackage.files, sourcePackage.files);
  assert.deepEqual(runtimePackage.dependencies, {
    "@xterm/addon-fit": "^0.11.0",
    "@xterm/xterm": "^6.0.0",
    "node-pty": "^1.1.0",
    "smol-toml": "1.7.0",
    "ws": "^8.21.1"
  });
  assert.equal("scripts" in runtimePackage, false);
  assert.equal("devDependencies" in runtimePackage, false);
});

test("Leader and Operator keep native subagent creation inside the Leader conversation", () => {
  const leader = readFileSync(join(root, "skills", "yui-leader", "SKILL.md"), "utf8");
  const operator = readFileSync(join(root, "skills", "yui-operator", "SKILL.md"), "utf8");
  const worker = readFileSync(join(root, "skills", "yui-worker", "SKILL.md"), "utf8");

  assert.match(leader, /Start from the user's core problem, desired outcome, and real constraints/u);
  assert.match(leader, /Give Agents the relevant Task context/u);
  assert.match(leader, /Do not encode semantic judgment or every possible\s+exception into workflow states/u);
  assert.match(leader, /Do not turn speculative or extreme edge cases into requirements/u);
  assert.match(leader, /create a native subagent inside this Leader's current Agent conversation/u);
  assert.match(leader, /Do not invent another execution entity or a `yui \.\.\. subagent` command/u);
  assert.match(leader, /yui task work update <work-id> running/u);
  assert.match(leader, /A Profile is required for this path/u);
  assert.match(leader, /Ignore all Task Role Agent bindings/u);
  assert.match(leader, /executor=subagent; profile=reviewer@3/u);
  assert.match(leader, /Bash\(yui task run yield \*\).*control-plane handoff/us);
  assert.match(
    leader,
    /`--check` commands run from the selected Project's integration candidate root[\s\S]*not\s+`cd <project> && npm test`/u
  );
  assert.match(operator, /Leader chooses among direct execution, a native subagent, and a Task Role\s+AgentRun/u);
  assert.match(operator, /inherits\s+the Leader Agent, ignores Task Role Agent bindings/u);
  assert.match(operator, /has no Yui launch\s+command/u);
  assert.match(operator, /Use `--require-integration` whenever completing the mission requires changing\s+and delivering Project files/u);
  assert.match(operator, /requires a WorkItem, ChangeSet, and\s+committed Integration before completion/u);
  assert.match(operator, /advances, corrects, shrinks, or\s+extends the same bounded outcome[\s\S]*read another's semantic result to be implemented or accepted/u);
  assert.match(operator, /share one final\s+acceptance, release, migration, or runtime upgrade/u);
  assert.match(operator, /Create a new Task only when[\s\S]*are all independent and it can run in parallel\s+without waiting on or controlling another Task/u);
  assert.match(operator, /Same repository, same file, or a\s+potential Git conflict is neutral to Task identity/u);
  assert.match(operator, /not a permanent backlog/u);
  assert.match(operator, /shrink\s+or a change of implementation or approach that preserves the same bounded\s+outcome[\s\S]*abandons the current outcome for an\s+independent one, do not force it onto the original Task; apply the strict\s+new-Task rule/u);
  assert.match(operator, /Do not pre-split WorkItems or decide their dependsOn, execution path,\s+acceptance, or Integration/u);
  assert.match(operator, /Raise an InputRequest only for a real user choice[\s\S]*never ask the user to confirm "continue" as a\s+scheduler/u);
  assert.match(worker, /native subagent inherits the Leader Agent/u);
  assert.match(worker, /Do not run Yui lifecycle commands/u);
  assert.match(worker, /result and records the actual Profile revision/u);
  assert.match(
    worker,
    /review Run uses a native read-only permission mode[\s\S]*Do not request approval[\s\S]*yield\s+the Run/u
  );
  assert.match(
    worker,
    /one bounded evidence pass[\s\S]*Do not repeat successful checks[\s\S]*yield\s+immediately/u
  );
  assert.match(worker, /do not wrap it in `until`[\s\S]*If the direct command is denied[\s\S]*stop instead of retrying/u);
});

test("publish builds once and smokes the same package on Node 20, 22, and 24", () => {
  const workflow = readFileSync(join(root, ".github", "workflows", "publish.yml"), "utf8");
  const smoke = readFileSync(join(root, "scripts", "smoke-runtime-package.mjs"), "utf8");

  assert.match(workflow, /node:\s*\[20, 22, 24\]/u);
  assert.match(workflow, /npm run build/u);
  assert.match(workflow, /npm test/u);
  assert.match(workflow, /npm run lint/u);
  assert.match(workflow, /npm publish \.\/release-artifact\/yui-runtime\.tgz/u);
  assert.match(workflow, /apt-get install --yes tmux/u);
  assert.match(workflow, /dist\/cli\/commandCatalog\.js/u);
  assert.match(workflow, /dist\/controller\/controllerMain\.js/u);
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
