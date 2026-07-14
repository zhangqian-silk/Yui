import {
  chmodSync,
  copyFileSync,
  lstatSync,
  mkdirSync,
  rmSync
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  currentNativeTarget,
  nativePrebuildPath
} from "./native-prebuild-target.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const source = join(root, "native", "build", "Release", "taskmux_storage_fs.node");
const sourceMetadata = lstatSync(source);
if (!sourceMetadata.isFile() || sourceMetadata.isSymbolicLink()) {
  throw new Error("node-gyp did not produce one exact regular TaskMux native addon.");
}

const target = nativePrebuildPath(root, currentNativeTarget());
mkdirSync(dirname(target), { recursive: true, mode: 0o755 });
rmSync(target, { force: true });
copyFileSync(source, target);
chmodSync(target, 0o644);
const targetMetadata = lstatSync(target);
if (!targetMetadata.isFile() || targetMetadata.isSymbolicLink() || targetMetadata.nlink !== 1) {
  throw new Error("Could not stage one exact regular TaskMux native prebuild.");
}
rmSync(join(dirname(target), "taskmux_storage_fs.manifest.json"), { force: true });
console.log(`Staged native prebuild: ${target}`);
