/**
 * Resource registry store abstraction (Issue 10, DB-only optimal).
 *
 * The GC engine depends on this interface, not on a specific storage backend.
 * When the Home is SQLite-backed the registry lives in the `resource_registry`
 * table inside `yui.db`; otherwise it falls back to a JSON file.
 */

import { join } from "node:path";

import { existsSync } from "node:fs";

import type { ResourceRecord, ResourceRegistryState } from "./resourceTypes.js";
import {
  emptyResourceRegistry,
  loadResourceRegistry,
  saveResourceRegistry
} from "./resourceRegistry.js";
import { SqliteResourceRegistry } from "./sqliteResourceRegistry.js";

/**
 * The persistence seam for the resource registry.
 */
export interface ResourceRegistryStore {
  load(): ResourceRegistryState;
  save(state: ResourceRegistryState): void;
  close(): void;
}

/**
 * JSON-file-backed registry store (File-store Homes).
 */
export class FileResourceRegistryStore implements ResourceRegistryStore {
  readonly #home: string;

  constructor(home: string) {
    this.#home = home;
  }

  load(): ResourceRegistryState {
    return loadResourceRegistry(this.#home);
  }

  save(state: ResourceRegistryState): void {
    saveResourceRegistry(this.#home, state);
  }

  close(): void {
    // No persistent connection to close.
  }
}

/**
 * Create the appropriate registry store for a Home.
 *
 * SQLite-backed Homes use the `resource_registry` table in `yui.db`;
 * File-store Homes fall back to the JSON file.
 */
export function createResourceRegistryStore(home: string): ResourceRegistryStore {
  if (existsSync(join(home, "yui.db"))) {
    return new SqliteResourceRegistry(home);
  }
  return new FileResourceRegistryStore(home);
}
