import {
  currentProviderActivation,
  currentProviderAuthority,
  currentProviderConversation,
  validateProviderRuntimeBinding,
  type ProviderAuthorityOwner,
  type ProviderRuntimeBinding
} from "./providerRuntimeIdentity.js";

export type ProviderConversationProbe = Readonly<{
  state: "exists" | "missing" | "unknown";
  conversationId: string;
  activeTurnId?: string;
}>;

export type ProviderTurnAcceptance =
  | Readonly<{ status: "accepted"; turnId: string }>
  | Readonly<{ status: "not-accepted"; reason: string }>
  | Readonly<{ status: "unknown"; reason: string }>;

/**
 * Provider-native structured control. PTY, tmux, Hooks, and transcript tailing
 * are intentionally absent: they are presentation or observation surfaces.
 */
export interface ProviderControlAdapter {
  readonly providerNamespace: string;
  inspectConversation(conversationId: string): Promise<ProviderConversationProbe>;
  submitTurn(input: Readonly<{
    conversationId: string;
    attemptId: string;
    text: string;
    expectedNoActiveTurn: boolean;
  }>): Promise<ProviderTurnAcceptance>;
  interruptTurn(input: Readonly<{
    conversationId: string;
    turnId: string;
  }>): Promise<"interrupted" | "not-active" | "unknown">;
}

export type ProviderWriterFence = Readonly<{
  conversationId: string;
  activationId: string;
  authorityEpoch: number;
  authorityOwner: Exclude<ProviderAuthorityOwner, "none" | "unknown">;
  holderId: string;
}>;

/**
 * Applies the durable single-writer fence before any Provider mutation. The
 * Adapter never receives authority to infer or repair identity.
 */
export class FencedProviderControl {
  constructor(private readonly adapter: ProviderControlAdapter) {}

  async submitTurn(input: Readonly<{
    binding: ProviderRuntimeBinding;
    fence: ProviderWriterFence;
    attemptId: string;
    text: string;
    expectedNoActiveTurn?: boolean;
  }>): Promise<ProviderTurnAcceptance> {
    this.#assertWriter(input.binding, input.fence);
    return this.adapter.submitTurn({
      conversationId: input.fence.conversationId,
      attemptId: identity(input.attemptId, "Provider input attempt id"),
      text: text(input.text, "Provider Turn input"),
      expectedNoActiveTurn: input.expectedNoActiveTurn ?? true
    });
  }

  async interruptTurn(input: Readonly<{
    binding: ProviderRuntimeBinding;
    fence: ProviderWriterFence;
    turnId: string;
  }>): Promise<"interrupted" | "not-active" | "unknown"> {
    this.#assertWriter(input.binding, input.fence);
    return this.adapter.interruptTurn({
      conversationId: input.fence.conversationId,
      turnId: identity(input.turnId, "Provider Turn id")
    });
  }

  async inspectConversation(
    binding: ProviderRuntimeBinding
  ): Promise<ProviderConversationProbe> {
    const normalized = validateProviderRuntimeBinding(binding);
    this.#assertNamespace(normalized);
    return this.adapter.inspectConversation(
      currentProviderConversation(normalized).conversationId
    );
  }

  #assertWriter(binding: ProviderRuntimeBinding, fence: ProviderWriterFence): void {
    const normalized = validateProviderRuntimeBinding(binding);
    this.#assertNamespace(normalized);
    const conversation = currentProviderConversation(normalized);
    const activation = currentProviderActivation(normalized);
    const authority = currentProviderAuthority(normalized);
    if (conversation.conversationId !== fence.conversationId
      || activation?.activationId !== fence.activationId
      || authority.epoch !== fence.authorityEpoch
      || authority.owner !== fence.authorityOwner
      || authority.holderId !== fence.holderId) {
      throw new Error("Provider writer fence is stale.");
    }
  }

  #assertNamespace(binding: ProviderRuntimeBinding): void {
    if (binding.providerNamespace !== this.adapter.providerNamespace) {
      throw new Error("Provider control Adapter does not match its Runtime Binding.");
    }
  }
}

function identity(value: string, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0 || value.includes("\0")) {
    throw new Error(`${label} is invalid.`);
  }
  return value.trim();
}

function text(value: string, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0 || value.includes("\0")) {
    throw new Error(`${label} is invalid.`);
  }
  return value;
}
