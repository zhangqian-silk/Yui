import { createHash } from "node:crypto";
import { chmodSync } from "node:fs";
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
