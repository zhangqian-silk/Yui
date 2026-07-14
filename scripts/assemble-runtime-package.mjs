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
import {
  currentNativeTarget,
  nativePrebuildManifestPath,
  nativePrebuildPath,
  nativePrebuildRoot,
  SUPPORTED_NATIVE_TARGETS
} from "./native-prebuild-target.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const RUNTIME_SKILLS = [
  "taskmux-leader",
  "taskmux-worker",
  "taskmux-operator"
];
const outputIndex = process.argv.indexOf("--output");
if (outputIndex < 0 || outputIndex + 1 >= process.argv.length) {
  throw new Error("assemble-runtime-package requires --output <directory>.");
}
const output = resolve(root, process.argv[outputIndex + 1]);
const outputRelative = relative(root, output);
if (output === root || outputRelative.startsWith("..") || outputRelative === "") {
  throw new Error("Runtime staging directory must be one child of the source checkout.");
}
const assembleAll = process.argv.includes("--all");
const assembleHost = process.argv.includes("--host");
if (assembleAll === assembleHost) {
  throw new Error("Choose exactly one of --all or --host.");
}
const targets = assembleAll ? SUPPORTED_NATIVE_TARGETS : [currentNativeTarget()];

const sourceManifestPath = nativePrebuildManifestPath(root);
if (!existsSync(sourceManifestPath)) {
  throw new Error("Missing unified native prebuild manifest.");
}
const sourceManifestText = readFileSync(sourceManifestPath, "utf8");
const sourceManifest = JSON.parse(sourceManifestText);
if (
  JSON.stringify(sourceManifest) !== sourceManifestText ||
  Object.keys(sourceManifest).length !== 3 ||
  sourceManifest.schemaVersion !== 1 ||
  typeof sourceManifest.sourceCommit !== "string" ||
  !/^[0-9a-f]{40}$/.test(sourceManifest.sourceCommit) ||
  !Array.isArray(sourceManifest.artifacts)
) {
  throw new Error("Unified native prebuild manifest is not canonical.");
}
const artifacts = targets.map((target) => {
  const relativePath = `linux-${target.arch}-${target.libc}/napi-v8/taskmux_storage_fs.node`;
  const artifact = sourceManifest.artifacts.find((candidate) => (
    candidate !== null &&
    typeof candidate === "object" &&
    candidate.platform === "linux" &&
    candidate.arch === target.arch &&
    candidate.libc === target.libc &&
    candidate.napiVersion === 8 &&
    candidate.path === relativePath
  ));
  if (
    artifact === undefined ||
    Object.keys(artifact).length !== 7 ||
    typeof artifact.size !== "string" ||
    !/^[1-9][0-9]*$/.test(artifact.size) ||
    typeof artifact.sha256 !== "string" ||
    !/^[0-9a-f]{64}$/.test(artifact.sha256)
  ) {
    throw new Error(`Missing exact manifest artifact for linux-${target.arch}-${target.libc}.`);
  }
  return artifact;
});

for (const target of targets) {
  const binary = nativePrebuildPath(root, target);
  if (!existsSync(binary)) {
    throw new Error(`Missing assembled native artifact for linux-${target.arch}-${target.libc}.`);
  }
}
if (!existsSync(resolve(root, "dist", "cli.js"))) {
  throw new Error("TypeScript dist must be built before runtime assembly.");
}

rmSync(output, { recursive: true, force: true });
mkdirSync(output, { recursive: true, mode: 0o755 });
cpSync(resolve(root, "dist"), resolve(output, "dist"), { recursive: true });
for (const name of ["README.md", "LICENSE"]) {
  cpSync(resolve(root, name), resolve(output, name));
}
for (const skill of RUNTIME_SKILLS) {
  const source = resolve(root, "skills", skill, "SKILL.md");
  const sourceMetadata = lstatSync(source);
  if (!sourceMetadata.isFile() || sourceMetadata.isSymbolicLink()) {
    throw new Error(`Runtime Skill must be one exact regular file: ${skill}/SKILL.md.`);
  }
  const destination = resolve(output, "skills", skill, "SKILL.md");
  mkdirSync(dirname(destination), { recursive: true, mode: 0o755 });
  cpSync(source, destination);
  chmodSync(destination, 0o644);
}
for (const target of targets) {
  const source = dirname(nativePrebuildPath(root, target));
  const destination = dirname(nativePrebuildPath(output, target));
  mkdirSync(destination, { recursive: true, mode: 0o755 });
  cpSync(source, destination, { recursive: true });
}
mkdirSync(nativePrebuildRoot(output), { recursive: true, mode: 0o755 });
writeFileSync(
  nativePrebuildManifestPath(output),
  JSON.stringify({
    schemaVersion: 1,
    sourceCommit: sourceManifest.sourceCommit,
    artifacts
  }),
  { mode: 0o644 }
);
chmodSync(nativePrebuildManifestPath(output), 0o644);

const sourcePackage = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8"));
const runtimePackage = {
  name: sourcePackage.name,
  version: sourcePackage.version,
  description: sourcePackage.description,
  license: sourcePackage.license,
  private: false,
  type: "module",
  bin: { taskmux: "./dist/cli.js" },
  engines: { node: "^20.17.0 || ^22.9.0 || ^24.0.0" },
  os: ["linux"],
  cpu: targets.map(({ arch }) => arch),
  libc: ["glibc"],
  keywords: sourcePackage.keywords,
  repository: sourcePackage.repository,
  bugs: sourcePackage.bugs,
  homepage: sourcePackage.homepage,
  dependencies: sourcePackage.dependencies
};
writeFileSync(
  resolve(output, "package.json"),
  `${JSON.stringify(runtimePackage, null, 2)}\n`,
  { mode: 0o644 }
);
chmodSync(resolve(output, "package.json"), 0o644);

const forbidden = [
  "binding.gyp", "native", "build", "test", "scripts", "package-lock.json"
];
for (const name of forbidden) {
  if (existsSync(resolve(output, name))) {
    throw new Error(`Runtime staging unexpectedly contains ${basename(name)}.`);
  }
}
if ("scripts" in runtimePackage || "devDependencies" in runtimePackage) {
  throw new Error("Runtime package must not contain lifecycle scripts or development dependencies.");
}
const stagedSkills = listRegularFiles(resolve(output, "skills"));
const expectedSkills = RUNTIME_SKILLS.map((skill) => `${skill}/SKILL.md`).sort();
if (JSON.stringify(stagedSkills) !== JSON.stringify(expectedSkills)) {
  throw new Error("Runtime package must contain exactly the three required TaskMux Skill files.");
}
console.log(`Assembled runtime package: ${output}`);

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
    throw new Error(`Runtime Skill tree contains an unsupported entry: ${child}`);
  }
  return files.sort();
}
