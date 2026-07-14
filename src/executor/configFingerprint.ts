import { hasExactOwnKeys, lowerUnknownInertData } from "../storage/inertData.js";

export type ConfigFingerprint = {
  overall: string;
  replayable: string;
  permission: string;
  sessionBound: string;
};

const CONFIG_FINGERPRINT_FIELDS = ["overall", "replayable", "permission", "sessionBound"] as const;

export function isConfigFingerprint(value: unknown): value is ConfigFingerprint {
  return snapshotConfigFingerprint(value) !== null;
}

export function snapshotConfigFingerprint(value: unknown): ConfigFingerprint | null {
  const snapshot = lowerUnknownInertData(value);
  if (snapshot === null || !isRecord(value) || !hasExactOwnKeys(value, CONFIG_FINGERPRINT_FIELDS) ||
      !isRecord(snapshot.value) ||
      !hasExactOwnKeys(snapshot.value, CONFIG_FINGERPRINT_FIELDS)) {
    return null;
  }
  const overall = snapshot.value.overall;
  const replayable = snapshot.value.replayable;
  const permission = snapshot.value.permission;
  const sessionBound = snapshot.value.sessionBound;
  if (!isLowercaseSha256(overall) || !isLowercaseSha256(replayable) ||
      !isLowercaseSha256(permission) || !isLowercaseSha256(sessionBound)) return null;
  return {
    overall,
    replayable,
    permission,
    sessionBound
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isLowercaseSha256(value: unknown): value is string {
  if (typeof value !== "string" || value.length !== 64) return false;
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if (!((character >= "0" && character <= "9") || (character >= "a" && character <= "f"))) {
      return false;
    }
  }
  return true;
}
