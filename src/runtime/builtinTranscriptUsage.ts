import type { RuntimeUsageSnapshot } from "./runtimeObservation.js";

export function codexTranscriptUsage(transcript: string): RuntimeUsageSnapshot | null {
  let latest: RuntimeUsageSnapshot | null = null;
  for (const line of transcript.split("\n")) {
    const entry = parseLine(line);
    if (entry?.type !== "event_msg") continue;
    const payload = object(entry.payload);
    if (payload?.type !== "token_count") continue;
    const info = object(payload.info);
    const usage = object(info?.total_token_usage);
    const inputTokens = integer(usage?.input_tokens);
    const outputTokens = integer(usage?.output_tokens);
    if (inputTokens === null || outputTokens === null) continue;
    const cachedInputTokens = integer(usage?.cached_input_tokens);
    const reasoningTokens = integer(usage?.reasoning_output_tokens);
    latest = Object.freeze({
      inputTokens,
      outputTokens,
      ...(cachedInputTokens === null ? {} : { cachedInputTokens }),
      ...(reasoningTokens === null ? {} : { reasoningTokens })
    });
  }
  return latest;
}

export function claudeTranscriptUsage(transcript: string): RuntimeUsageSnapshot | null {
  const messages = new Map<string, RuntimeUsageSnapshot>();
  for (const line of transcript.split("\n")) {
    const entry = parseLine(line);
    if (entry?.type !== "assistant") continue;
    const message = object(entry.message);
    const usage = object(message?.usage);
    const directInput = integer(usage?.input_tokens);
    const outputTokens = integer(usage?.output_tokens);
    if (directInput === null || outputTokens === null) continue;
    const cacheRead = integer(usage?.cache_read_input_tokens) ?? 0;
    const cacheCreated = integer(usage?.cache_creation_input_tokens) ?? 0;
    const details = object(usage?.output_tokens_details);
    const reasoningTokens = integer(details?.thinking_tokens);
    const key = typeof message?.id === "string" && message.id.length > 0
      ? `message:${message.id}`
      : typeof entry.uuid === "string" && entry.uuid.length > 0
        ? `entry:${entry.uuid}`
        : null;
    // A streaming transcript can repeat cumulative snapshots. Without a
    // stable provider or entry identity, summing them would fabricate growth.
    if (key === null) continue;
    messages.set(key, Object.freeze({
      // Normalize inputTokens as the complete input total. cachedInputTokens is
      // a breakdown and must not be added to it again by the projection.
      inputTokens: directInput + cacheRead + cacheCreated,
      outputTokens,
      cachedInputTokens: cacheRead + cacheCreated,
      ...(reasoningTokens === null ? {} : { reasoningTokens })
    }));
  }
  if (messages.size === 0) return null;
  let inputTokens = 0;
  let outputTokens = 0;
  let cachedInputTokens = 0;
  let reasoningTokens = 0;
  for (const usage of messages.values()) {
    inputTokens += usage.inputTokens;
    outputTokens += usage.outputTokens;
    cachedInputTokens += usage.cachedInputTokens ?? 0;
    reasoningTokens += usage.reasoningTokens ?? 0;
  }
  return Object.freeze({
    inputTokens,
    outputTokens,
    cachedInputTokens,
    ...(reasoningTokens === 0 ? {} : { reasoningTokens })
  });
}

function parseLine(line: string): Record<string, unknown> | null {
  if (line.trim().length === 0) return null;
  try {
    return object(JSON.parse(line));
  } catch {
    return null;
  }
}

function object(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function integer(value: unknown): number | null {
  return Number.isSafeInteger(value) && (value as number) >= 0 ? value as number : null;
}
