import { readFileSync } from "node:fs";

import { FILE_TASK_CONTROLLER_PROTOCOL_VERSION } from "./core/protocol.js";
import {
  CURRENT_AGGREGATE_SCHEMA_VERSION,
  CURRENT_STORAGE_LAYOUT_VERSION
} from "./storage/storageSchema.js";

export const YUI_VERSION = readPackageVersion();

export type YuiVersionIdentity = Readonly<{
  version: string;
  controllerProtocolVersion: number;
  storageLayoutVersion: number;
  aggregateSchemaVersion: number;
}>;

export function yuiVersionIdentity(): YuiVersionIdentity {
  return {
    version: YUI_VERSION,
    controllerProtocolVersion: FILE_TASK_CONTROLLER_PROTOCOL_VERSION,
    storageLayoutVersion: CURRENT_STORAGE_LAYOUT_VERSION,
    aggregateSchemaVersion: CURRENT_AGGREGATE_SCHEMA_VERSION
  };
}

function readPackageVersion(): string {
  try {
    const value = JSON.parse(
      readFileSync(new URL("../package.json", import.meta.url), "utf8")
    ) as { version?: unknown };
    if (typeof value.version === "string" && value.version.length > 0) return value.version;
  } catch {
    // Keep diagnostics available when package metadata is damaged.
  }
  return "0.0.0";
}
