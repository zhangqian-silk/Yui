export type ProviderAuthorityFence = Readonly<{
  epoch: number;
  owner: "controller" | "human";
  holderId: string;
}>;

export function validateProviderAuthorityFence(
  value: ProviderAuthorityFence
): ProviderAuthorityFence {
  if (!Number.isSafeInteger(value.epoch) || value.epoch < 1) {
    throw new Error("Provider authority epoch is invalid.");
  }
  if (value.owner !== "controller" && value.owner !== "human") {
    throw new Error("Provider authority owner is invalid for a writer fence.");
  }
  if (typeof value.holderId !== "string" || value.holderId.trim().length === 0
    || value.holderId.includes("\0")) {
    throw new Error("Provider authority holder is invalid.");
  }
  return Object.freeze({
    epoch: value.epoch,
    owner: value.owner,
    holderId: value.holderId.trim()
  });
}

export function sameProviderAuthorityFence(
  left: ProviderAuthorityFence,
  right: ProviderAuthorityFence
): boolean {
  const first = validateProviderAuthorityFence(left);
  const second = validateProviderAuthorityFence(right);
  return first.epoch === second.epoch
    && first.owner === second.owner
    && first.holderId === second.holderId;
}
