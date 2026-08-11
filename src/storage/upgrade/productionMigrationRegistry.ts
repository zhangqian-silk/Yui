/**
 * Backward-compatible import path for the one production storage registry.
 * Compatible loading and offline migration share the declaration graph owned by
 * `storage/migration/productionRegistry.ts`.
 */
export {
  createProductionStorageRegistry as createProductionMigrationRegistry
} from "../migration/productionRegistry.js";
