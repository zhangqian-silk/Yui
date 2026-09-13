import type { ResourceRegistryState } from "./resourceTypes.js";
import { SqliteResourceRegistry } from "./sqliteResourceRegistry.js";

/** Current Homes have one SQLite registry; missing storage is not a new backend. */
export interface ResourceRegistryStore {
  load(): ResourceRegistryState;
  /** Apply only changed records, comparing their original ownership evidence. */
  save(next: ResourceRegistryState, previous: ResourceRegistryState): void;
  close(): void;
}

export function createResourceRegistryStore(home: string): ResourceRegistryStore {
  return new SqliteResourceRegistry(home);
}

/** Connections created here never survive a synchronous read/write operation.
 * A borrowed Store remains the caller's responsibility. No DB handle is held
 * across filesystem scans, Git subprocesses or other asynchronous GC work.
 */
export function withResourceRegistry<T>(
  home: string,
  borrowed: ResourceRegistryStore | undefined,
  operation: (store: ResourceRegistryStore) => T
): T {
  const store = borrowed ?? createResourceRegistryStore(home);
  try {
    return operation(store);
  } finally {
    if (borrowed === undefined) store.close();
  }
}
