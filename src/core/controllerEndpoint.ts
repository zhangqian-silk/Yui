import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

export function controllerSocketPath(home: string): string {
  const uid = typeof process.getuid === "function" ? process.getuid() : 0;
  const identity = createHash("sha256")
    .update(resolve(home))
    .digest("hex")
    .slice(0, 24);
  return join(tmpdir(), `yui-${uid}`, `${identity}.sock`);
}
