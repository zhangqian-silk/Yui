import {
  closeSync,
  constants,
  fstatSync,
  mkdtempSync,
  openSync,
  readFileSync,
  rmSync,
  statSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const root = process.env.TASKMUX_INSTALLED_ROOT ?? process.cwd();
const storage = await import(pathToFileURL(
  join(root, "dist", "storage", "nativeStorageFs.js")
).href);
const directory = mkdtempSync(join(tmpdir(), "taskmux-native-smoke-"));
const descriptor = openSync(
  directory,
  constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW
);
try {
  const content = Buffer.from("native prebuild smoke\n");
  const identity = fstatSync(descriptor, { bigint: true });
  const barrier = storage.acquireStableAncestorExclusiveBarrier(descriptor, {
    dev: identity.dev,
    ino: identity.ino,
    uid: identity.uid,
    mode: identity.mode,
    nlink: identity.nlink,
    birthtimeNs: identity.birthtimeNs
  });
  try {
    const metadata = storage.publishAnonymousFileNoReplace(
      barrier,
      ".",
      {
        dev: identity.dev,
        ino: identity.ino,
        uid: identity.uid,
        mode: identity.mode,
        nlink: identity.nlink,
        birthtimeNs: identity.birthtimeNs
      },
      "smoke.txt",
      content
    );
    const published = statSync(join(directory, "smoke.txt"));
    if (readFileSync(join(directory, "smoke.txt"), "utf8") !== content.toString("utf8") ||
        (published.mode & 0o777) !== 0o600 ||
        metadata.ino !== BigInt(published.ino)) {
      throw new Error("Native prebuild smoke produced unexpected output.");
    }
  } finally {
    storage.releaseStableAncestorBarrier(barrier);
  }
} finally {
  closeSync(descriptor);
  rmSync(directory, { recursive: true, force: true });
}
