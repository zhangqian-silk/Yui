import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  cpSync,
  symlinkSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";

const SKILLS = [
  ["taskmux-leader", "# TaskMux Leader"],
  ["taskmux-worker", "# TaskMux Worker"],
  ["taskmux-operator", "# TaskMux Operator"]
];

test("source metadata is private while assembled runtime metadata is explicitly publishable", () => {
  const source = JSON.parse(readFileSync(join(process.cwd(), "package.json"), "utf8"));
  assert.equal(source.private, true);
  assert.equal(source.files.includes("skills"), true);
  assert.equal(source.publishConfig?.registry, "https://registry.invalid/");
});

test("pack dry run rebuilds the host prebuild from a clean source copy", (t) => {
  const root = process.cwd();
  const fixtureRoot = mkdtempSync(join(tmpdir(), "taskmux-pack-dry-run-clean-"));
  const source = join(fixtureRoot, "source");
  t.after(() => rmSync(fixtureRoot, { recursive: true, force: true }));

  cpSync(root, source, {
    recursive: true,
    filter: (path) => !isGeneratedOrDependencyPath(relative(root, path))
  });
  symlinkSync(join(root, "node_modules"), join(source, "node_modules"), "dir");
  initializeFixtureRepository(source);

  assert.equal(existsSync(join(source, "prebuilds")), false);
  const output = execFileSync("npm", ["run", "pack:dry-run"], {
    cwd: source,
    encoding: "utf8",
    env: {
      ...process.env,
      npm_config_cache: join(fixtureRoot, "npm-cache")
    }
  });

  const target = `linux-${process.arch}-glibc/napi-v8/taskmux_storage_fs.node`;
  assert.match(output, /Assembled runtime package:/);
  assert.equal(existsSync(join(source, "prebuilds", target)), true);
  assert.equal(existsSync(join(source, ".release-stage", "prebuilds", target)), true);
});

// This is intentionally a lifecycle-skipped package-content/context test. The release
// workflow's Node/architecture matrix separately normal-installs this exact tarball and
// runs scripts/smoke-runtime-package.mjs plus the native authority smoke.
test("an assembled runtime package installed with lifecycle scripts skipped retains bundled skill contexts", async () => {
  const root = process.cwd();
  const stage = mkdtempSync(join(root, ".runtime-package-smoke-stage-"));
  const consumer = mkdtempSync(join(tmpdir(), "taskmux-runtime-package-consumer-"));
  const home = join(consumer, "home");
  try {
    execFileSync(
      process.execPath,
      [join(root, "scripts", "assemble-runtime-package.mjs"), "--host", "--output", stage],
      { cwd: root, encoding: "utf8" }
    );
    const packed = JSON.parse(execFileSync(
      "npm",
      ["pack", ".", "--json"],
      { cwd: stage, encoding: "utf8" }
    ));
    assert.equal(packed.length, 1);
    const tarball = join(stage, packed[0].filename);
    execFileSync(
      "npm",
      ["install", "--ignore-scripts", "--prefix", consumer, tarball],
      {
        cwd: root,
        encoding: "utf8",
        env: { ...process.env, npm_config_cache: join(consumer, "npm-cache") }
      }
    );

    const installedRoot = join(consumer, "node_modules", "@zq-silk", "taskmux");
    const installedPackage = JSON.parse(readFileSync(join(installedRoot, "package.json"), "utf8"));
    assert.equal(installedPackage.private, false);
    assert.equal("scripts" in installedPackage, false);
    assert.equal("devDependencies" in installedPackage, false);
    assert.equal("publishConfig" in installedPackage, false);
    for (const [skill, heading] of SKILLS) {
      const skillPath = join(installedRoot, "skills", skill, "SKILL.md");
      assert.equal(existsSync(skillPath), true, `installed runtime package must include ${skill}/SKILL.md`);
      assert.match(readFileSync(skillPath, "utf8"), new RegExp(heading));
    }

    const { compileDispatchInput } = await import(pathToFileURL(
      join(installedRoot, "dist", "context", "dispatchContext.js")
    ).href);
    const listChildRoles = () => [];
    assert.match(
      compileDispatchInput({ listChildRoles }, "task-1", taskRole("leader"), "continue"),
      /# TaskMux Leader/
    );
    assert.match(
      compileDispatchInput({ listChildRoles }, "task-1", taskRole("worker"), "continue"),
      /# TaskMux Worker/
    );

    const { prepareGlobalRoleLaunch } = await import(pathToFileURL(
      join(installedRoot, "dist", "operator", "operatorContext.js")
    ).href);
    mkdirSync(home, { recursive: true });
    const launch = prepareGlobalRoleLaunch(operatorRole(), operatorAgent(), {
      taskmuxHome: home,
      baseEnv: { ...process.env, CODEX_HOME: join(home, "codex-home") }
    });
    assert.match(
      readFileSync(launch.env.TASKMUX_OPERATOR_CONTEXT, "utf8"),
      /# TaskMux Operator/
    );
    execFileSync(process.execPath, [join(root, "scripts", "smoke-runtime-package.mjs")], {
      cwd: root,
      encoding: "utf8",
      env: { ...process.env, TASKMUX_INSTALLED_ROOT: installedRoot }
    });
  } finally {
    rmSync(stage, { recursive: true, force: true });
    rmSync(consumer, { recursive: true, force: true });
  }
});

function taskRole(name) {
  return {
    schemaVersion: 2,
    taskId: "task-1",
    name,
    activeAgentId: "codex",
    agentBindings: {
      codex: {
        agentId: "codex",
        adapterId: "codex",
        config: { adapterId: "codex" }
      }
    },
    workspace: "/tmp/runtime-package-smoke",
    status: "idle",
    createdAt: "2026-07-14T00:00:00.000Z",
    updatedAt: "2026-07-14T00:00:00.000Z",
    responsibilities: [],
    constraints: []
  };
}

function operatorRole() {
  return {
    schemaVersion: 2,
    name: "operator",
    activeAgentId: "codex",
    agentBindings: {
      codex: {
        agentId: "codex",
        adapterId: "codex",
        config: { adapterId: "codex" }
      }
    },
    workspace: "/tmp/runtime-package-smoke",
    createdAt: "2026-07-14T00:00:00.000Z",
    updatedAt: "2026-07-14T00:00:00.000Z",
    responsibilities: [],
    constraints: []
  };
}

function operatorAgent() {
  return {
    schemaVersion: 2,
    id: "codex",
    adapterId: "codex",
    command: "taskmux-runtime-package-codex",
    baseArgs: [],
    environment: [],
    source: "custom",
    createdAt: "2026-07-14T00:00:00.000Z",
    updatedAt: "2026-07-14T00:00:00.000Z"
  };
}

function isGeneratedOrDependencyPath(path) {
  return [
    ".git",
    "node_modules",
    "dist",
    "prebuilds",
    "native/build",
    ".release-stage",
    ".npm-cache"
  ].some((ignored) => path === ignored || path.startsWith(`${ignored}/`));
}

function initializeFixtureRepository(directory) {
  execFileSync("git", ["init"], { cwd: directory, encoding: "utf8" });
  mkdirSync(join(directory, ".test-git-hooks"));
  execFileSync("git", ["config", "core.hooksPath", ".test-git-hooks"], {
    cwd: directory,
    encoding: "utf8"
  });
  execFileSync("git", ["config", "user.name", "TaskMux package test"], {
    cwd: directory,
    encoding: "utf8"
  });
  execFileSync("git", ["config", "user.email", "taskmux-package-test@example.invalid"], {
    cwd: directory,
    encoding: "utf8"
  });
  execFileSync("git", ["add", "--all"], { cwd: directory, encoding: "utf8" });
  execFileSync("git", ["commit", "--no-gpg-sign", "-m", "fixture"], {
    cwd: directory,
    encoding: "utf8"
  });
}
