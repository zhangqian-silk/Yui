import { existsSync, lstatSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import {
  currentNativeTarget,
  nativePrebuildManifestPath,
  nativePrebuildPath,
  SUPPORTED_NATIVE_TARGETS
} from "./native-prebuild-target.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const verifyAll = process.argv.includes("--all");
const installCheck = process.argv.includes("--install");

if (installCheck && existsSync(fileURLToPath(new URL("../.git", import.meta.url)))) {
  console.log("Source checkout detected; explicit npm run build:native stages the prebuild.");
  process.exit(0);
}

const targets = verifyAll ? SUPPORTED_NATIVE_TARGETS : [currentNativeTarget()];
const manifestPath = nativePrebuildManifestPath(root);
const manifestMetadata = lstatSync(manifestPath);
if (!manifestMetadata.isFile() || manifestMetadata.isSymbolicLink() ||
    manifestMetadata.nlink !== 1 || (manifestMetadata.mode & 0o022) !== 0) {
  throw new Error(`Invalid native prebuild manifest: ${manifestPath}`);
}
const manifestText = readFileSync(manifestPath, "utf8");
const manifest = JSON.parse(manifestText);
if (
  JSON.stringify(manifest) !== manifestText ||
  Object.keys(manifest).length !== 3 ||
  manifest.schemaVersion !== 1 ||
  typeof manifest.sourceCommit !== "string" ||
  !/^[0-9a-f]{40}$/.test(manifest.sourceCommit) ||
  !Array.isArray(manifest.artifacts)
) {
  throw new Error("Native prebuild manifest is not one exact canonical record.");
}

for (const target of targets) {
  const path = nativePrebuildPath(root, target);
  const expected = {
    platform: "linux",
    arch: target.arch,
    libc: target.libc,
    napiVersion: 8,
    path: `linux-${target.arch}-${target.libc}/napi-v8/taskmux_storage_fs.node`
  };
  const artifact = manifest.artifacts.find((candidate) => (
    candidate !== null &&
    typeof candidate === "object" &&
    candidate.platform === expected.platform &&
    candidate.arch === expected.arch &&
    candidate.libc === expected.libc
  ));
  if (
    artifact === undefined ||
    Object.keys(artifact).length !== 7 ||
    artifact.platform !== expected.platform ||
    artifact.arch !== expected.arch ||
    artifact.libc !== expected.libc ||
    artifact.napiVersion !== expected.napiVersion ||
    artifact.path !== expected.path ||
    typeof artifact.size !== "string" ||
    !/^[1-9][0-9]*$/.test(artifact.size) ||
    typeof artifact.sha256 !== "string" ||
    !/^[0-9a-f]{64}$/.test(artifact.sha256)
  ) {
    throw new Error(`Manifest lacks exact linux-${target.arch}-${target.libc} artifact.`);
  }
  const metadata = lstatSync(path);
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1 ||
      (metadata.mode & 0o022) !== 0 || metadata.size <= 0) {
    throw new Error(`Invalid TaskMux native prebuild: ${path}`);
  }
  const bytes = readFileSync(path);
  if (artifact.size !== String(bytes.length) ||
      artifact.sha256 !== createHash("sha256").update(bytes).digest("hex")) {
    throw new Error(`Native prebuild hash mismatch: ${path}`);
  }
  console.log(`Verified native prebuild: linux-${target.arch}-${target.libc}`);
}
