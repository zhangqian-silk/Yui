import { createProductionRegistry } from "../migration/index.js";
import type { MigrationRegistry } from "../migration/index.js";
import type { HomeSnapshot } from "./homeMigrationTarget.js";

/**
 * Build the explicit migration graph shipped by this release.
 *
 * This is the single production registry used by both doctor classification and
 * the upgrade command. It is deliberately a factory: callers receive an
 * isolated immutable-in-practice graph and cannot leak test registrations into
 * another command.
 */
export function createProductionMigrationRegistry(): MigrationRegistry<HomeSnapshot> {
  return createProductionRegistry();
}
