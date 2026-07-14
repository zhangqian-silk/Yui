import { join } from "node:path";

export const SUPPORTED_NATIVE_TARGETS = Object.freeze([
  Object.freeze({ arch: "x64", libc: "glibc" }),
  Object.freeze({ arch: "arm64", libc: "glibc" })
]);

export function currentNativeTarget() {
  if (process.platform !== "linux") {
    throw new Error(`TaskMux native storage does not support ${process.platform}.`);
  }
  const target = SUPPORTED_NATIVE_TARGETS.find(({ arch }) => arch === process.arch);
  if (target === undefined) {
    throw new Error(`TaskMux native storage does not support Linux ${process.arch}.`);
  }
  const glibc = process.report?.getReport()?.header?.glibcVersionRuntime;
  if (typeof glibc !== "string" || glibc.length === 0) {
    throw new Error("TaskMux native storage currently requires Linux glibc.");
  }
  return target;
}

export function nativePrebuildPath(root, target) {
  return join(
    nativePrebuildRoot(root),
    `linux-${target.arch}-${target.libc}`,
    "napi-v8",
    "taskmux_storage_fs.node"
  );
}

export function nativePrebuildRoot(root) {
  return join(root, "prebuilds");
}

export function nativePrebuildManifestPath(root) {
  return join(nativePrebuildRoot(root), "manifest.json");
}
