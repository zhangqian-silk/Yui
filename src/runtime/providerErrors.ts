
export class ProviderDeliveryUnknownError extends Error {
  readonly name = "ProviderDeliveryUnknownError";

  constructor(
    message: string,
    readonly attemptId: string,
    // Wrapping must not become the end of the causal chain: the original
    // transport or Controller failure is the reason a reader needs.
    options?: Readonly<{ cause?: unknown }>
  ) {
    super(message, options);
  }
}


export class ProviderTurnRejectedError extends Error {
  readonly name = "ProviderTurnRejectedError";

  constructor(
    message: string,
    readonly attemptId: string,
    options?: Readonly<{ cause?: unknown }>
  ) {
    super(message, options);
  }
}


/** Another ordinary client currently owns the thread's active Turn. */
export class ProviderTurnBusyError extends Error {
  readonly name = "ProviderTurnBusyError";

  constructor(
    message: string,
    readonly attemptId: string,
    readonly activeTurnId?: string
  ) {
    super(message);
  }
}


export class ProviderConversationMissingError extends Error {
  readonly name = "ProviderConversationMissingError";

  constructor(readonly conversationId: string, message: string) {
    super(message);
  }
}
