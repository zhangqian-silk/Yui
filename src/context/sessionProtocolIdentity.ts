import { createHash } from "node:crypto";

export const SESSION_CONTEXT_PROTOCOL = "yui-managed-context/v1" as const;
export const SESSION_BOOTSTRAP_MANIFEST_SCHEMA_VERSION = 1 as const;

export type SessionRoleKind = "operator" | "leader" | "worker" | "reviewer" | "global";

/** Pure compatibility identity: safe for storage/domain code with no control-plane I/O edge. */
export function sessionManifestCompatibilityDigest(
  roleName: string,
  roleKind: SessionRoleKind,
  profile: Readonly<{
    description?: string;
    responsibilities?: readonly string[];
    constraints?: readonly string[];
    expectedOutput?: string;
    systemPrompt?: string;
    skills?: readonly string[];
  }>
): string {
  return createHash("sha256").update(JSON.stringify({
    protocol: SESSION_CONTEXT_PROTOCOL,
    roleName,
    roleKind,
    profile: {
      description: profile.description,
      responsibilities: profile.responsibilities ?? [],
      constraints: profile.constraints ?? [],
      expectedOutput: profile.expectedOutput,
      systemPrompt: profile.systemPrompt,
      skillIds: [
        "yui-runtime",
        ...(roleKind === "global" ? [] : [`yui-${roleKind}`]),
        ...(profile.skills ?? [])
      ]
    }
  })).digest("hex");
}
