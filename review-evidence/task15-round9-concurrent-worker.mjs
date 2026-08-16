import { createFileReleaseIdempotencyStore } from "../dist/release/releaseIdempotencyStore.js";

// round9 P2-D concurrency worker: one process records one key. Two workers
// over the same Home reproduce the cross-process lost-update window the old
// whole-map store had (both loaded the empty store, then each wrote the whole
// map). The per-key store must persist both keys.

const [home, key, effectJson] = process.argv.slice(2);
if (home === undefined || key === undefined || effectJson === undefined) {
  throw new Error("round9 concurrent worker requires home, key, and effectJson");
}

const store = createFileReleaseIdempotencyStore(home);
await store.recordSuccess(key, JSON.parse(effectJson));
process.stdout.write(`recorded ${key}\n`);
