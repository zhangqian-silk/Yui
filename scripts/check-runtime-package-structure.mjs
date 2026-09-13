import { readFileSync } from "node:fs";

const manifestPath = process.argv[2];
if (manifestPath === undefined || process.argv.length !== 3) {
  throw new Error("check-runtime-package-structure requires <npm-pack-json>");
}

const result = JSON.parse(readFileSync(manifestPath, "utf8"));
const entries = result[0]?.files ?? [];
const files = new Set(entries.map(({ path }) => path));
const required = [
  "dist/cli.js",
  "dist/cli/commandCatalog.js",
  "dist/runtime/claude-process-owner",
  "ARCHITECTURE.md",
  "docs/project-refresh.md",
  "docs/project-refresh.zh-CN.md",
  "docs/task-discovery.md",
  "docs/task-discovery.zh-CN.md",
  "skills/yui-leader/SKILL.md",
  "skills/yui-worker/SKILL.md",
  "skills/yui-operator/SKILL.md",
  "skills/yui-reviewer/SKILL.md",
  "skills/yui-runtime/SKILL.md",
  "skills/yui-runtime/references/recovery.md",
  "skills/yui-runtime/references/publication.md",
  "skills/yui-leader/references/replicated-execution.md",
  "skills/yui-leader/references/integration.md",
  "skills/yui-leader/references/task-plugins.md"
];
for (const path of required) {
  if (!files.has(path)) throw new Error(`runtime package is missing ${path}`);
}
for (const path of files) {
  if (/^(?:test|scripts|node_modules)\//u.test(path)) {
    throw new Error(`runtime package contains forbidden path ${path}`);
  }
}
for (const executable of ["dist/cli.js", "dist/runtime/claude-process-owner"]) {
  const entry = entries.find(({ path }) => path === executable);
  if (entry?.mode !== 0o755) {
    throw new Error(
      `runtime package ${executable} must be executable (0755), received ${formatMode(entry?.mode)}`
    );
  }
}

console.log(`Package structure smoke passed (${files.size} files).`);

function formatMode(mode) {
  return typeof mode === "number" ? mode.toString(8).padStart(4, "0") : "missing";
}
