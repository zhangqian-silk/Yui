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
  "ARCHITECTURE.md",
  "skills/yui-leader/SKILL.md",
  "skills/yui-worker/SKILL.md",
  "skills/yui-operator/SKILL.md",
  "skills/yui-reviewer/SKILL.md"
];
for (const path of required) {
  if (!files.has(path)) throw new Error(`runtime package is missing ${path}`);
}
for (const path of files) {
  if (/^(?:test|scripts|node_modules)\//u.test(path)) {
    throw new Error(`runtime package contains forbidden path ${path}`);
  }
}
const cli = entries.find(({ path }) => path === "dist/cli.js");
if (cli?.mode !== 0o755) {
  throw new Error(
    `runtime package dist/cli.js must be executable (0755), received ${formatMode(cli?.mode)}`
  );
}

console.log(`Package structure smoke passed (${files.size} files).`);

function formatMode(mode) {
  return typeof mode === "number" ? mode.toString(8).padStart(4, "0") : "missing";
}
