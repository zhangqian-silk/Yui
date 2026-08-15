/**
 * Scalar storage version constants.
 *
 * These live in their own module so that `storageSchema.ts`, `recordVersions.ts`,
 * and `taskStore.ts` can all import them without creating a circular dependency.
 * `storageSchema.ts` re-exports them for backward compatibility.
 */

/**
 * Version of the on-disk layout (`schema.json`, root `state.json`, and locks).
 *
 * Layout 7 is the SQLite WAL control-plane layout (task-21 §8): the authoritative
 * store moves from the aggregate `state.json` document to `yui.db`. A layout-6
 * Home is migrated offline by the staged state.json→SQLite migration; layout 7
 * is the current layout this release reads and writes.
 */
export const CURRENT_STORAGE_LAYOUT_VERSION = 7;

/** Version of the authoritative aggregate stored in `state.json`. */
export const CURRENT_AGGREGATE_SCHEMA_VERSION = 18;
