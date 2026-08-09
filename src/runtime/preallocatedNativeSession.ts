import { createHash } from "node:crypto";
import { resolve } from "node:path";

import { requireText } from "./validation.js";

/** Deterministic native identity preallocated for one exact provider launch. */
export function nativeSessionIdForLaunch(
  home: string,
  launchId: string,
  agentId: string,
  adapterId: string
): string {
  const hex = createHash("sha256").update(JSON.stringify([
    resolve(requireText(home, "YUI_HOME")),
    requireText(launchId, "Launch id"),
    requireText(agentId, "Agent id"),
    requireText(adapterId, "Agent adapter id")
  ])).digest("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-a${
    hex.slice(17, 20)
  }-${hex.slice(20, 32)}`;
}
