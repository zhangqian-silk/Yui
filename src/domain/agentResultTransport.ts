export const MAX_TURN_RESULT_OUTPUT_BYTES = 512 * 1024;
export const MAX_TURN_FAILURE_DIAGNOSTIC_BYTES = 16 * 1024;

export type TransportedAgentResult =
  | Readonly<{ status: "completed"; output: string }>
  | Readonly<{
      status: "failed";
      diagnostic: string;
      failureReason: "missing-result";
    }>;

/**
 * Validate only the transport envelope of an Agent result. The accepted text
 * remains byte-for-byte unchanged; missing or untransportable text becomes a
 * Core-owned failed outcome so the exact Turn can still terminalize.
 */
export function transportAgentResult(value: unknown): TransportedAgentResult {
  if (typeof value !== "string") {
    return {
      status: "failed",
      diagnostic: "Provider terminal event did not include an Agent result.",
      failureReason: "missing-result"
    };
  }
  if (value.includes("\0")) {
    return {
      status: "failed",
      diagnostic: "Provider terminal event included an Agent result with an invalid NUL byte.",
      failureReason: "missing-result"
    };
  }
  if (value.trim().length === 0) {
    return {
      status: "failed",
      diagnostic: "Provider terminal event included an empty Agent result.",
      failureReason: "missing-result"
    };
  }
  const bytes = Buffer.byteLength(value, "utf8");
  if (bytes > MAX_TURN_RESULT_OUTPUT_BYTES) {
    return {
      status: "failed",
      diagnostic: `Provider Agent result is ${bytes} bytes and exceeds the ${MAX_TURN_RESULT_OUTPUT_BYTES}-byte durable result limit; the result was not stored.`,
      failureReason: "missing-result"
    };
  }
  return { status: "completed", output: value };
}

/**
 * Bound Core-owned failure diagnostics without rejecting a terminal event.
 * This is intentionally separate from Agent result transport: successful
 * Agent text is either retained exactly or rejected as a whole, never
 * truncated. Provider/Core diagnostics may be clipped because they are only
 * operational context for a failed Turn.
 */
export function boundedTurnFailureDiagnostic(
  value: unknown,
  fallback = "Provider reported a failed Agent Turn."
): string {
  const candidate = typeof value === "string" && value.trim().length > 0
    ? value
    : fallback;
  const safe = candidate.replaceAll("\0", "\uFFFD");
  if (Buffer.byteLength(safe, "utf8") <= MAX_TURN_FAILURE_DIAGNOSTIC_BYTES) {
    return safe;
  }
  const prefix = Buffer
    .from(safe, "utf8")
    .subarray(0, MAX_TURN_FAILURE_DIAGNOSTIC_BYTES)
    .toString("utf8");
  return prefix.endsWith("\uFFFD") ? prefix.slice(0, -1) : prefix;
}
