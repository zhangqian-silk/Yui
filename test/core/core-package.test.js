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
    "env -u FORCE_COLOR -u YUI_TEST_KEEP_SESSION_ENV -u YUI_TEST_TIER -u YUI_TEST_PRIVILEGED_MANIFEST NO_COLOR=1 node --import ./test/helpers/scrubSessionEnv.js --test test/*.test.js test/core/*.test.js"
  );
  assert.equal(sourcePackage.scripts["test:tier"], "node scripts/run-test-tier.mjs");
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
    "docs",
    "README.md",
    "ARCHITECTURE.md",
    "i18n/README.zh-CN.md",
    "LICENSE"
  ]);
  assert.deepEqual(tsconfig.include, ["src/**/*.ts"]);
});

test("runtime assembly contains only the built CLI, docs, and four generic skills", (t) => {
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
    ["ARCHITECTURE.md", "LICENSE", "README.md", "dist", "docs", "i18n", "package.json", "skills"]
  );
  assert.deepEqual(readdirSync(join(output, "docs")), ["task-local-identity.md"]);
  assert.deepEqual(readdirSync(join(output, "i18n")), ["README.zh-CN.md"]);
  assert.deepEqual(
    readdirSync(join(output, "skills")).sort(),
    ["yui-leader", "yui-operator", "yui-reviewer", "yui-worker"]
  );
  assert.equal(existsSync(join(output, "skills", "develop-yui")), false);
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
  assert.match(
    leader,
    /fresh ReviewRound-owned worktree[\s\S]*exact frozen scope[\s\S]*assigned WorkItem Candidate[\s\S]*committed Integration heads/u
  );
  assert.match(leader, /never capture, integrate, accept,\s+or auto-merge the review workspace/usi);
  assert.match(leader, /current Run's[\s\S]*--summary-file -[\s\S]*durable\s+handoff/u);
  assert.match(
    leader,
    /`--check` commands run from the selected Project's integration candidate root[\s\S]*take the exact commands from Project Policy[\s\S]*do\s+not invent a repository-specific command or add a generic shell prelude/u
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
    /Every review Run is bound to one exact frozen ReviewRound scope[\s\S]*WorkItem ReviewRound[\s\S]*Candidate commit[\s\S]*Task-final ReviewRound[\s\S]*committed Integration\s+heads[\s\S]*Do not reinterpret/u
  );
  assert.match(
    worker,
    /one bounded evidence pass[\s\S]*Do not repeat successful\s+checks[\s\S]*yield immediately/ui
  );
  assert.match(worker, /do not wrap it in `until`[\s\S]*duplicate or late\s+review yield is obsolete/u);
  assert.match(worker, /For a review Run[\s\S]*Clear Markdown is sufficient[\s\S]*Do not invent a check merely to satisfy a schema/ui);
  assert.match(worker, /dirty no-commit workspace may\s+yield[\s\S]*cannot be cleaned\s+until it is clean/ui);
  assert.match(
    worker,
    /managed Codex or\s+Claude Run[\s\S]*--summary-file -[\s\S]*final\s+response[\s\S]*does not deliver/u
  );
});

test("Yui-specific test workflow stays in its Project Skill", () => {
  const projectSkill = readFileSync(join(
    root,
    ".agents",
    "skills",
    "develop-yui",
    "SKILL.md"
  ), "utf8");
  const genericSkills = ["yui-leader", "yui-worker", "yui-reviewer", "yui-operator"].map((name) => (
    readFileSync(join(root, "skills", name, "SKILL.md"), "utf8")
  ));

  assert.match(projectSkill, /Apply this Skill only to development of the Yui repository itself/u);
  assert.match(projectSkill, /Unit, Isolated Integration, and Mock Agent\s+Session coverage/u);
  assert.match(projectSkill, /Run Provider E2E only when the user explicitly asks/u);
  assert.match(projectSkill, /skip it without creating an InputRequest/u);
  assert.match(projectSkill, /compatibility only through explicit migrations/u);
  assert.match(projectSkill, /tier names[\s\S]*belong to the Yui Project[\s\S]*must not become generic Yui CLI/u);
  for (const skill of genericSkills) {
    assert.match(skill, /real models, paid APIs, shared infrastructure, production systems,\s+real\s+account\s+quota/iu);
    assert.match(skill, /generic request to implement, test, validate, run\s+E2E, or\s+complete work does not grant/iu);
    assert.match(skill, /available\s+credentials,\s+an installed provider CLI, a Project Policy, or a test label/iu);
    assert.match(skill, /Unless the user\s+proactively names the concrete real-resource validation[\s\S]*skip it without\s+creating an InputRequest/iu);
    assert.match(skill, /(?:explicit request|explicitly name)[\s\S]*resource,\s+effect,\s+and\s+isolation boundary/iu);
    assert.doesNotMatch(skill, /YUI_ALLOW_PROVIDER_E2E|Provider E2E|Mock Agent Session/u);
  }
});

test("Operator archives only after explicit user authorization for the exact Task", () => {
  const operator = readFileSync(join(root, "skills", "yui-operator", "SKILL.md"), "utf8");

  // A terminal notification / completion reports outcome and eligibility but is not archive authority.
  assert.match(
    operator,
    /A\s+Task\s+terminal\s+notification\s+reports[\s\S]*?archive-eligible[\s\S]*?grants\s+no\s+archive\s+authority/u
  );
  // Completion, eligibility, a general cleanup intent, or another Task's authorization never authorize this exact archive.
  assert.match(
    operator,
    /Task\s+completion,\s+retirement,\s+archive\s+eligibility,\s+a\s+general\s+cleanup\s+intent,\s+or\s+authorization\s+for\s+another\s+Task\s+never\s+authorize\s+archiving\s+this\s+exact\s+Task/u
  );
  // Without exact-Task authorization: do not archive; report and request it; do not hand the user mechanical steps.
  assert.match(
    operator,
    /Without\s+explicit\s+user\s+authorization\s+for\s+the\s+exact\s+Task,\s+do\s+not\s+archive\s+it[\s\S]*?ask\s+the\s+user\s+to\s+authorize\s+archiving\s+that\s+specific\s+Task[\s\S]*?do\s+not\s+make\s+the\s+user\s+hand-run/u
  );
  // With authorization: the Operator itself performs the command, only after the safe preconditions hold.
  assert.match(
    operator,
    /Only\s+after\s+the\s+user\s+authorizes\s+archiving\s+that\s+exact\s+Task[\s\S]*?active\s+work\s+is\s+settled,\s+results\s+are\s+integrated\s+or\s+deliberately\s+abandoned,\s+and\s+managed\s+worktrees\s+are\s+clean\s+and\s+removable,\s+perform\s+it\s+yourself\s+with\s+`yui\s+task\s+archive/u
  );
  // Unmet preconditions stay blockers routed to the Leader, not forced cleanup.
  assert.match(
    operator,
    /Dirty\s+worktrees,\s+active\s+Runs,\s+and\s+unresolved\s+Integration\s+evidence\s+are\s+blockers/u
  );
  // The implicit "terminal notification is the cleanup boundary" trigger must be gone.
  assert.doesNotMatch(
    operator,
    /Treat a Task terminal notification as the explicit final cleanup boundary/u
  );
});

test("Worker and Leader Skills require truthful uncertain checkpoints", () => {
  const leader = readFileSync(join(root, "skills", "yui-leader", "SKILL.md"), "utf8");
  const worker = readFileSync(join(root, "skills", "yui-worker", "SKILL.md"), "utf8");

  assert.match(
    worker,
    /uncertain,\s+incomplete,\s+blocked,\s+or requiring Leader judgment/iu
  );
  assert.match(
    worker,
    /exact Run, WorkItem, and native Session identity[\s\S]*actions actually performed[\s\S]*changed paths and commit\/worktree state[\s\S]*checks actually run and their outcomes[\s\S]*provider, runtime, or permission errors[\s\S]*last confirmed lifecycle boundary[\s\S]*work not performed[\s\S]*unresolved assumptions or decisions[\s\S]*residual risks[\s\S]*confidence[\s\S]*bounded next options/iu
  );
  assert.match(
    worker,
    /immutable Run\s+evidence and a Candidate, or Review evidence only[\s\S]*never implies Leader\s+acceptance, WorkItem completion, ChangeSet capture,\s+Integration, or Task\s+completion/iu
  );
  assert.match(
    worker,
    /Review Runs report findings,\s+verification gaps,\s+and limits;\s+the\s+Leader decides disposition/iu
  );
  assert.match(
    worker,
    /If the\s+exact yield is denied[\s\S]*do not retry[\s\S]*broaden permissions[\s\S]*wrapper[\s\S]*mutate\s+Yui state[\s\S]*invent delivery evidence/iu
  );

  assert.match(
    leader,
    /uncertain,\s+incomplete,\s+blocked,\s+or requiring Leader judgment/iu
  );
  assert.match(
    leader,
    /same complete checkpoint before either yield or an InputRequest/iu
  );
  assert.match(
    leader,
    /yield preserves immutable Run evidence only[\s\S]*never implies Leader\s+acceptance, WorkItem completion, ChangeSet capture,\s+Integration, or Task\s+completion/iu
  );
  assert.match(
    leader,
    /exact yield command must be the final tool action/iu
  );
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
