import {
  chmodSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { basename, dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import {
  buildReleaseManifest,
  RELEASE_MANIFEST_FILE
} from "./lib/runtime-package.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const RUNTIME_SKILLS = [
  "yui-leader",
  "yui-worker",
  "yui-operator",
  "yui-reviewer",
  "yui-runtime"
];
const RUNTIME_DOCUMENTS = [
  "README.md",
  "ARCHITECTURE.md",
  "docs/task-local-identity.md",
  "i18n/README.zh-CN.md",
  "LICENSE"
];
const RUNTIME_PACKAGE_FILES = [
  "dist",
  "skills",
  "docs",
  "README.md",
  "ARCHITECTURE.md",
  "i18n/README.zh-CN.md",
  "LICENSE"
];

const outputIndex = process.argv.indexOf("--output");
if (outputIndex < 0 || outputIndex + 1 >= process.argv.length) {
  throw new Error("assemble-runtime-package requires --output <directory>.");
}
if (process.argv.length !== 4) {
  throw new Error("assemble-runtime-package accepts only --output <directory>.");
}

const output = resolve(root, process.argv[outputIndex + 1]);
const outputRelative = relative(root, output);
if (output === root || outputRelative.startsWith("..") || outputRelative === "") {
  throw new Error("Runtime staging directory must be inside the source checkout.");
}
if (!existsSync(resolve(root, "dist", "cli.js"))) {
  throw new Error("TypeScript dist must be built before runtime assembly.");
}

rmSync(output, { recursive: true, force: true });
mkdirSync(output, { recursive: true, mode: 0o755 });
mkdirSync(resolve(output, "dist"), { recursive: true, mode: 0o755 });
const runtimeSources = listTypeScriptFiles(resolve(root, "src"));
for (const sourceName of runtimeSources) {
  const builtName = `${sourceName.slice(0, -3)}.js`;
  const source = resolve(root, "dist", builtName);
  const sourceMetadata = lstatSync(source);
  if (!sourceMetadata.isFile() || sourceMetadata.isSymbolicLink()) {
    throw new Error(`Runtime build must be one regular file: ${builtName}.`);
  }
  const destination = resolve(output, "dist", builtName);
  mkdirSync(dirname(destination), { recursive: true, mode: 0o755 });
  cpSync(source, destination);
  chmodSync(destination, builtName === "cli.js" ? 0o755 : 0o644);
}
for (const name of RUNTIME_DOCUMENTS) {
  const source = resolve(root, name);
  const sourceMetadata = lstatSync(source);
  if (!sourceMetadata.isFile() || sourceMetadata.isSymbolicLink()) {
    throw new Error(`Runtime document must be one regular file: ${name}.`);
  }
  const destination = resolve(output, name);
  mkdirSync(dirname(destination), { recursive: true, mode: 0o755 });
  cpSync(source, destination);
  chmodSync(destination, 0o644);
}

for (const skill of RUNTIME_SKILLS) {
  const source = resolve(root, "skills", skill, "SKILL.md");
  const sourceMetadata = lstatSync(source);
  if (!sourceMetadata.isFile() || sourceMetadata.isSymbolicLink()) {
    throw new Error(`Runtime Skill must be one regular file: ${skill}/SKILL.md.`);
  }
  const destination = resolve(output, "skills", skill, "SKILL.md");
  mkdirSync(dirname(destination), { recursive: true, mode: 0o755 });
  cpSync(source, destination);
  chmodSync(destination, 0o644);
}

const sourcePackage = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8"));
const runtimePackage = {
  name: sourcePackage.name,
  version: sourcePackage.version,
  description: sourcePackage.description,
  license: sourcePackage.license,
  private: false,
  type: "module",
  bin: { yui: "./dist/cli.js" },
  files: RUNTIME_PACKAGE_FILES,
  engines: sourcePackage.engines,
  os: sourcePackage.os,
  cpu: sourcePackage.cpu,
  libc: sourcePackage.libc,
  keywords: sourcePackage.keywords,
  repository: sourcePackage.repository,
  bugs: sourcePackage.bugs,
  homepage: sourcePackage.homepage,
  ...(sourcePackage.dependencies === undefined
    ? {}
    : { dependencies: sourcePackage.dependencies })
};
writeFileSync(
  resolve(output, "package.json"),
  `${JSON.stringify(runtimePackage, null, 2)}\n`,
  { mode: 0o644 }
);
chmodSync(resolve(output, "package.json"), 0o644);

// Issue 02: an immutable release must be self-contained. Copy the production
// dependency tree (the exact set `npm install --production` would place) so
// the release never resolves a package from the assembler's checkout or a
// global link. The manifest below pins every copied file, so dependency drift
// changes the package digest and fails closed on verify.
copyProductionDependencies(root, output);

const forbidden = [
  "binding.gyp",
  "native",
  "prebuilds",
  "build",
  "test",
  "scripts",
  "package-lock.json"
];
for (const name of forbidden) {
  if (existsSync(resolve(output, name))) {
    throw new Error(`Runtime staging unexpectedly contains ${basename(name)}.`);
  }
}
if ("scripts" in runtimePackage || "devDependencies" in runtimePackage) {
  throw new Error("Runtime package must not contain scripts or development dependencies.");
}

const stagedSkills = listRegularFiles(resolve(output, "skills"));
const expectedSkills = RUNTIME_SKILLS.map((skill) => `${skill}/SKILL.md`).sort();
if (JSON.stringify(stagedSkills) !== JSON.stringify(expectedSkills)) {
  throw new Error("Runtime package must contain exactly the configured Yui Skill files.");
}
const stagedRuntime = listRegularFiles(resolve(output, "dist"));
const expectedRuntime = runtimeSources.map((name) => `${name.slice(0, -3)}.js`).sort();
if (JSON.stringify(stagedRuntime) !== JSON.stringify(expectedRuntime)) {
  throw new Error("Runtime package must contain exactly the current compiled TypeScript files.");
}

// Issue 02: pin the immutable release identity. The manifest lists every
// regular file with its SHA-256 and byte length; the package digest is derived
// from that inventory, so the manifest file itself is excluded from the
// digest. The source commit is recorded when the assembler runs inside a Git
// checkout and stays optional for source-archive builds.
const sourceCommit = readSourceCommit(root);
const manifest = buildReleaseManifest(output, {
  version: sourcePackage.version,
  ...(sourceCommit === undefined ? {} : { sourceCommit })
});
writeFileSync(
  resolve(output, RELEASE_MANIFEST_FILE),
  `${JSON.stringify(manifest, null, 2)}\n`,
  { mode: 0o644 }
);

console.log(`Assembled runtime package: ${output}`);

function readSourceCommit(root) {
  try {
    const commit = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: root,
      stdio: ["ignore", "pipe", "ignore"]
    }).toString().trim();
    return /^[0-9a-f]{7,40}$/u.test(commit) ? commit : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Copies the production dependency tree from the checkout's node_modules into
 * the staged package. The package list is the exact set npm reports for
 * `--production`, so the release is self-contained without a network install.
 */
function copyProductionDependencies(root, output) {
  const nodeModules = resolve(root, "node_modules");
  if (!existsSync(nodeModules)) {
    throw new Error(
      "Runtime assembly requires installed dependencies (node_modules). Run `npm ci` first."
    );
  }
  let listed;
  try {
    listed = execFileSync(
      "npm",
      ["ls", "--production", "--all", "--parseable", "--no-unicode"],
      { cwd: root, stdio: ["ignore", "pipe", "ignore"] }
    ).toString();
  } catch (error) {
    throw new Error(
      `Runtime assembly could not list production dependencies: ${error.message}`
    );
  }
  const entries = listed
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  // `npm ls --parseable` always emits the project root first. npm 11 may
  // redact UUID-shaped path segments in every emitted path, so resolve each
  // dependency from its relative path below that first entry rather than
  // trusting the printed absolute prefix. External linked dependencies still
  // resolve outside node_modules and fail the boundary check below.
  const listedRoot = entries[0];
  if (listedRoot === undefined) {
    throw new Error("Runtime assembly found no npm project root.");
  }
  const packages = entries
    .slice(1)
    .map((line) => resolve(root, relative(listedRoot, line)));
  if (packages.length === 0) {
    throw new Error("Runtime assembly found no production dependencies to copy.");
  }
  const targetRoot = resolve(output, "node_modules");
  for (const source of packages) {
    const packageRelative = relative(nodeModules, source);
    if (packageRelative.startsWith("..") || packageRelative === "") {
      throw new Error(`Production dependency is outside node_modules: ${source}.`);
    }
    const target = resolve(targetRoot, packageRelative);
    mkdirSync(dirname(target), { recursive: true, mode: 0o755 });
    cpSync(source, target, { recursive: true });
  }
}

function listRegularFiles(directory) {
  const files = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const child = resolve(directory, entry.name);
    if (entry.isDirectory()) {
      for (const nested of listRegularFiles(child)) {
        files.push(`${entry.name}/${nested}`);
      }
      continue;
    }
    if (entry.isFile()) {
      files.push(entry.name);
      continue;
    }
    throw new Error(`Runtime tree contains an unsupported entry: ${child}`);
  }
  return files.sort();
}

function listTypeScriptFiles(directory, prefix = "") {
  const files = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const relativeName = prefix.length === 0 ? entry.name : `${prefix}/${entry.name}`;
    const child = resolve(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...listTypeScriptFiles(child, relativeName));
      continue;
    }
    if (entry.isFile() && entry.name.endsWith(".ts")) {
      files.push(relativeName);
      continue;
    }
    if (!entry.isFile()) {
      throw new Error(`Runtime source tree contains an unsupported entry: ${child}`);
    }
  }
  return files.sort();
}
