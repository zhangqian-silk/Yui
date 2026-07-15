import { createHash } from "node:crypto";

import {
  createExactInertJsonSnapshot,
  hasExactOwnKeys,
  type InertJsonValue
} from "./inertJson.js";

export const CONFIGURED_SKILL_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

export type ConfiguredSkill = Readonly<{
  schemaVersion: 1;
  id: string;
  content: string;
  sha256: string;
}>;

export function isConfiguredSkillId(value: unknown): value is string {
  return typeof value === "string" && CONFIGURED_SKILL_ID_PATTERN.test(value);
}

export function createConfiguredSkillRecord(id: string, content: string): ConfiguredSkill {
  if (!isConfiguredSkillId(id) || !isConfiguredSkillContent(content)) {
    throw new Error("Configured Skill record is invalid.");
  }
  return Object.freeze({
    schemaVersion: 1,
    id,
    content,
    sha256: configuredSkillSha256(content)
  });
}

export function snapshotConfiguredSkillRecord(
  value: unknown,
  expectedId?: string
): ConfiguredSkill | null {
  const inert = createExactInertJsonSnapshot(value)?.value;
  if (!isRecord(inert) || !hasExactOwnKeys(inert, [
    "schemaVersion", "id", "content", "sha256"
  ]) || inert.schemaVersion !== 1 || !isConfiguredSkillId(inert.id) ||
      (expectedId !== undefined && inert.id !== expectedId) ||
      !isConfiguredSkillContent(inert.content) || typeof inert.sha256 !== "string" ||
      !/^[a-f0-9]{64}$/.test(inert.sha256) ||
      configuredSkillSha256(inert.content) !== inert.sha256) {
    return null;
  }
  return Object.freeze({
    schemaVersion: 1,
    id: inert.id,
    content: inert.content,
    sha256: inert.sha256
  });
}

export function configuredSkillSha256(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

function isConfiguredSkillContent(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0 && isWellFormedUnicode(value);
}

function isRecord(value: unknown): value is Record<string, InertJsonValue> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isWellFormedUnicode(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      if (index + 1 >= value.length) return false;
      const next = value.charCodeAt(index + 1);
      if (next < 0xdc00 || next > 0xdfff) return false;
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return false;
    }
  }
  return true;
}
