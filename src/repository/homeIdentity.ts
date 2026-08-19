import { createHash, randomBytes } from "node:crypto";

/**
 * The durable Home identity. Generated exactly once per Home and persisted in
 * the aggregate; every Task workspace token binds to this identity so that two
 * Homes working on the same Task number cannot collide on a managed Git ref.
 *
 * The id is high-entropy on its own; `entropy` is retained alongside it so the
 * persisted record is self-validating (no malformed-state repair).
 */
export type HomeIdentity = Readonly<{
  schemaVersion: 1;
  homeId: string;
  createdAt: string;
  entropy: string;
}>;

export const HOME_IDENTITY_PATTERN = /^home-[a-f0-9]{16}$/;
const HOME_ENTROPY_BYTES = 16;

export function validateHomeId(homeId: string): string {
  if (typeof homeId !== "string" || !HOME_IDENTITY_PATTERN.test(homeId)) {
    throw new Error("Home identity id is invalid.");
  }
  return homeId;
}

export function generateHomeIdentity(
  now: Date,
  source: () => Buffer = () => randomBytes(HOME_ENTROPY_BYTES)
): HomeIdentity {
  const entropy = source().toString("hex");
  const homeId = `home-${randomBytes(8).toString("hex")}`;
  return validateHomeIdentity({
    schemaVersion: 1,
    homeId,
    createdAt: now.toISOString(),
    entropy
  });
}

export function validateHomeIdentity(identity: HomeIdentity): HomeIdentity {
  if (identity.schemaVersion !== 1) {
    throw new Error("Home identity must use schemaVersion 1.");
  }
  validateHomeId(identity.homeId);
  if (typeof identity.entropy !== "string" || !/^[a-f0-9]{32}$/.test(identity.entropy)) {
    throw new Error("Home identity entropy is invalid.");
  }
  if (typeof identity.createdAt !== "string" || !Number.isFinite(Date.parse(identity.createdAt))) {
    throw new Error("Home identity createdAt is invalid.");
  }
  return identity;
}
