import { createHash } from "node:crypto";
import { chmodSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

import type { ExactControlPlaneDescriptor } from "../runtime/exactControlPlane.js";
import {
  exactControlPlaneCommandPrefix,
  exactControlPlaneDigest,
  serializeExactDescriptor
} from "../runtime/exactControlPlane.js";
import type { GlobalRole, TaskRole } from "../role/role.js";
import { writeTextFileAtomically } from "../storage/durableFile.js";
import type { RoleSessionOwner, RoleSkillContext } from "./roleSessionContext.js";
import {
  SESSION_BOOTSTRAP_MANIFEST_SCHEMA_VERSION,
  SESSION_CONTEXT_PROTOCOL,
  sessionManifestCompatibilityDigest,
  type SessionRoleKind
} from "./sessionProtocolIdentity.js";
export {
  SESSION_BOOTSTRAP_MANIFEST_SCHEMA_VERSION,
  SESSION_CONTEXT_PROTOCOL,
  sessionManifestCompatibilityDigest,
  type SessionRoleKind
} from "./sessionProtocolIdentity.js";
export type SessionBootstrapManifest = Readonly<{
  schemaVersion: typeof SESSION_BOOTSTRAP_MANIFEST_SCHEMA_VERSION;
  protocol: typeof SESSION_CONTEXT_PROTOCOL;
  owner: RoleSessionOwner;
  effectiveRevision: number;
  roleKind: SessionRoleKind;
  /** Stable compatibility identity; distinct from this materialization's byte digest. */
  compatibilityDigest: string;
  controlPlane: Readonly<{
    descriptorPath: string;
    sessionCliPath: string;
    digest: string;
  }>;
  skills: readonly Readonly<{ id: string; path: string; digest: string }>[];
  roleProfileRef: Readonly<{ digest: string; path: string }>;
  contextProtocol: Readonly<{
    loadCommand: string;
    expandCommand?: string;
  }>;
  digest: string;
}>;

export type MaterializedSessionBootstrap = Readonly<{
  manifest: SessionBootstrapManifest;
  manifestPath: string;
  sessionCliPath: string;
  roleProfilePath: string;
  descriptorPath: string;
}>;

/** Read back one immutable Session Manifest and verify its content digest. */
export function readSessionBootstrapManifest(path: string): SessionBootstrapManifest {
  const source = resolve(path);
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(source, "utf8"));
  } catch (error) {
    throw new Error(`Session Manifest is unreadable: ${source}.`, { cause: error });
  }
  if (parsed === null || typeof parsed !== "object") {
    throw new Error("Session Manifest is invalid.");
  }
  const record = parsed as Record<string, unknown>;
  const claimedDigest = requireDigest(record.digest, "Session Manifest digest");
  const { digest: _digest, ...body } = record;
  if (digest(body) !== claimedDigest) {
    throw new Error("Session Manifest digest does not match its immutable content.");
  }
  if (record.schemaVersion !== SESSION_BOOTSTRAP_MANIFEST_SCHEMA_VERSION
    || record.protocol !== SESSION_CONTEXT_PROTOCOL
    || record.owner === null
    || typeof record.owner !== "object"
    || ((record.owner as { scope?: unknown }).scope !== "global"
      && (record.owner as { scope?: unknown }).scope !== "task")
    || typeof record.effectiveRevision !== "number"
    || !Number.isSafeInteger(record.effectiveRevision)
    || record.effectiveRevision < 1
    || (record.roleKind !== "operator"
      && record.roleKind !== "global"
      && record.roleKind !== "leader"
      && record.roleKind !== "worker"
      && record.roleKind !== "reviewer")
    || record.controlPlane === null
    || typeof record.controlPlane !== "object"
    || !Array.isArray(record.skills)
    || record.roleProfileRef === null
    || typeof record.roleProfileRef !== "object"
    || record.contextProtocol === null
    || typeof record.contextProtocol !== "object") {
    throw new Error("Session Manifest shape is invalid.");
  }
  const owner = record.owner as Record<string, unknown>;
  if (owner.scope === "task" && typeof owner.taskId !== "string") {
    throw new Error("Task Session Manifest owner is invalid.");
  }
  const control = record.controlPlane as Record<string, unknown>;
  requireText(control.descriptorPath, "Session Manifest control descriptor path");
  requireText(control.sessionCliPath, "Session Manifest CLI path");
  requireDigest(control.digest, "Session Manifest control-plane digest");
  for (const skill of record.skills) {
    if (skill === null || typeof skill !== "object") {
      throw new Error("Session Manifest Skill entry is invalid.");
    }
    const entry = skill as Record<string, unknown>;
    requireText(entry.id, "Session Manifest Skill id");
    requireText(entry.path, "Session Manifest Skill path");
    requireDigest(entry.digest, "Session Manifest Skill digest");
  }
  const profile = record.roleProfileRef as Record<string, unknown>;
  requireDigest(profile.digest, "Session Manifest Role Profile digest");
  requireText(profile.path, "Session Manifest Role Profile path");
  const protocol = record.contextProtocol as Record<string, unknown>;
  requireText(protocol.loadCommand, "Session Manifest Context load command");
  if (protocol.expandCommand !== undefined) {
    requireText(protocol.expandCommand, "Session Manifest Context expand command");
  }
  return Object.freeze(parsed as SessionBootstrapManifest);
}

export function materializeSessionBootstrap(input: Readonly<{
  yuiHome: string;
  role: GlobalRole | TaskRole;
  owner: RoleSessionOwner;
  roleKind: SessionRoleKind;
  skills: readonly RoleSkillContext[];
  controlPlane: ExactControlPlaneDescriptor;
}>): MaterializedSessionBootstrap {
  const home = resolve(input.yuiHome);
  const controlDigest = exactControlPlaneDigest(input.controlPlane);
  const descriptorPath = resolve(join(home, "runtime", "control-plane", `${controlDigest}.json`));
  writeImmutableText(descriptorPath, `${serializeExactDescriptor(input.controlPlane)}\n`);

  const sessionCliContent = [
    "#!/bin/sh",
    `exec ${exactControlPlaneCommandPrefix(input.controlPlane)} \"$@\"`,
    ""
  ].join("\n");
  const sessionCliDigest = digest(sessionCliContent);
  const sessionCliPath = resolve(join(home, "runtime", "session-cli", `yui-${sessionCliDigest}.sh`));
  writeImmutableText(sessionCliPath, sessionCliContent);
  chmodSync(sessionCliPath, 0o700);

  const roleProfile = {
    roleName: input.role.name,
    roleKind: input.roleKind,
    defaultAccess: input.role.defaultAccess,
    description: input.role.description,
    responsibilities: input.role.responsibilities ?? [],
    constraints: input.role.constraints ?? [],
    expectedOutput: input.role.expectedOutput,
    systemPrompt: input.role.systemPrompt
  };
  const profileContent = `${JSON.stringify(roleProfile, null, 2)}\n`;
  const profileDigest = digest(profileContent);
  const roleProfilePath = resolve(join(
    home,
    "runtime",
    "role-profiles",
    `${profileDigest}.json`
  ));
  writeImmutableText(roleProfilePath, profileContent);

  const body = {
    schemaVersion: SESSION_BOOTSTRAP_MANIFEST_SCHEMA_VERSION,
    protocol: SESSION_CONTEXT_PROTOCOL,
    owner: input.owner,
    effectiveRevision: input.role.launchRevision,
    roleKind: input.roleKind,
    compatibilityDigest: sessionManifestCompatibilityDigest(
      input.role.name,
      input.roleKind,
      input.role
    ),
    controlPlane: {
      descriptorPath,
      sessionCliPath,
      digest: controlDigest
    },
    skills: input.skills.map((skill) => Object.freeze({
      id: skill.id,
      path: skill.path,
      digest: digest(skill.content)
    })),
    roleProfileRef: { digest: profileDigest, path: roleProfilePath },
    contextProtocol: input.owner.scope === "global"
      ? {
          loadCommand: `\"${sessionCliPath}\" session context \"$YUI_ROLE\" --json`
        }
      : {
          loadCommand: `\"${sessionCliPath}\" task run context \"$YUI_TASK_ID/<run-id>\" --json`,
          expandCommand: `\"${sessionCliPath}\" task run context expand \"$YUI_TASK_ID/<run-id>\" <ref-id> --store <store> --mode full --json`
        }
  };
  const manifest = Object.freeze({ ...body, digest: digest(body) });
  const manifestPath = resolve(join(
    home,
    "runtime",
    "session-manifests",
    `${manifest.digest}.json`
  ));
  writeImmutableText(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  return Object.freeze({
    manifest,
    manifestPath,
    sessionCliPath,
    roleProfilePath,
    descriptorPath
  });
}

function writeImmutableText(path: string, content: string): void {
  writeTextFileAtomically(path, content);
  chmodSync(path, 0o600);
}

function digest(value: unknown): string {
  const bytes = typeof value === "string" ? value : JSON.stringify(value);
  return createHash("sha256").update(bytes).digest("hex");
}

function requireDigest(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/u.test(value)) {
    throw new Error(`${label} is invalid.`);
  }
  return value;
}

function requireText(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0 || value.includes("\0")) {
    throw new Error(`${label} is invalid.`);
  }
  return value.trim();
}
