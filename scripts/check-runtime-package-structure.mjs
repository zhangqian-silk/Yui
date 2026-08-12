import { readFileSync } from "node:fs";

const manifestPath = process.argv[2];
if (manifestPath === undefined || process.argv.length !== 3) {
  throw new Error("check-runtime-package-structure requires <npm-pack-json>");
}

const result = JSON.parse(readFileSync(manifestPath, "utf8"));
const files = new Set(result[0]?.files?.map(({ path }) => path) ?? []);
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

console.log(`Package structure smoke passed (${files.size} files).`);
