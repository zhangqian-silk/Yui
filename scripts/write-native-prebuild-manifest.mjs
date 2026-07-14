import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  writeFileSync
} from "node:fs";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import {
  currentNativeTarget,
  nativePrebuildManifestPath,
  nativePrebuildPath,
  nativePrebuildRoot,
  SUPPORTED_NATIVE_TARGETS
} from "./native-prebuild-target.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const buildAll = process.argv.includes("--all");
const buildHost = process.argv.includes("--host");
if (buildAll === buildHost) {
  throw new Error("Choose exactly one of --all or --host for the native manifest.");
}

const targets = buildAll ? SUPPORTED_NATIVE_TARGETS : [currentNativeTarget()];
const sourceCommit = (process.env.GITHUB_SHA ?? execFileSync(
  "git",
  ["rev-parse", "HEAD"],
  { cwd: root, encoding: "utf8" }
)).trim();
if (!/^[0-9a-f]{40}$/.test(sourceCommit)) {
  throw new Error("Native prebuild source commit must be one full lowercase Git SHA.");
}

const artifacts = targets.map((target) => {
  const path = nativePrebuildPath(root, target);
  if (!existsSync(path)) {
    throw new Error(`Missing native prebuild: linux-${target.arch}-${target.libc}.`);
  }
  const metadata = lstatSync(path);
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1 ||
      (metadata.mode & 0o022) !== 0 || metadata.size <= 0) {
    throw new Error(`Invalid native prebuild: ${path}`);
  }
  const bytes = readFileSync(path);
  return {
    platform: "linux",
    arch: target.arch,
    libc: target.libc,
    napiVersion: 8,
    path: `linux-${target.arch}-${target.libc}/napi-v8/taskmux_storage_fs.node`,
    size: String(bytes.length),
    sha256: createHash("sha256").update(bytes).digest("hex")
  };
});

mkdirSync(nativePrebuildRoot(root), { recursive: true, mode: 0o755 });
const manifestPath = nativePrebuildManifestPath(root);
writeFileSync(manifestPath, JSON.stringify({
  schemaVersion: 1,
  sourceCommit,
  artifacts
}), { mode: 0o644 });
chmodSync(manifestPath, 0o644);
console.log(`Wrote native prebuild manifest: ${manifestPath}`);
