import { realpathSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";

/** Recheck at execution, including directories created by a bootstrap step. */
export function jobStepDirectory(workspace: string, override?: string): string {
  const root = realpathSync(workspace);
  const cwd = override ?? workspace;
  if (!isAbsolute(cwd)) throw new Error("Job step cwd must be absolute.");
  const actual = realpathSync(cwd);
  const nested = relative(root, actual);
  if (nested === ".." || nested.startsWith(`..${sep}`) || isAbsolute(nested)) {
    throw new Error(`Job step cwd is outside its managed workspace: ${resolve(cwd)}.`);
  }
  return actual;
}
