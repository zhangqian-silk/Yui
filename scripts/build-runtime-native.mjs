import { existsSync, mkdirSync, readdirSync, renameSync, unlinkSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { join, relative } from "node:path";

if (process.platform !== "linux") {
  throw new Error("Yui's native process owner requires Linux.");
}
const output = fileURLToPath(new URL("../dist/runtime/", import.meta.url));
const dist = fileURLToPath(new URL("../dist/", import.meta.url));
const source = fileURLToPath(new URL("../src/", import.meta.url));
// tsc does not remove outputs of deleted/moved source files. Remove only those
// generated JS files after successful compilation, so local packages cannot
// silently retain a removed implementation. Native assets are untouched.
function removeOrphanJavaScript(directory) {
  if (!existsSync(directory)) return;
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const file = join(directory, entry.name);
    if (entry.isDirectory()) removeOrphanJavaScript(file);
    else if (entry.isFile() && entry.name.endsWith(".js")
      && !existsSync(join(source, relative(dist, file).replace(/\.js$/, ".ts")))) unlinkSync(file);
  }
}
removeOrphanJavaScript(dist);
mkdirSync(output, { recursive: true });
const target = output + "claude-process-owner";
execFileSync(process.env.CC ?? "cc", [
  "-std=c11", "-O2", "-Wall", "-Wextra", "-Werror", "-static",
  fileURLToPath(new URL("../native/claude-process-owner.c", import.meta.url)),
  "-o", target + ".building"
], { stdio: "inherit" });
renameSync(target + ".building", target);
