import type { RuntimeUsageSnapshot } from "./runtimeObservation.js";

/**
 * Issue 04 (context token budget): per-transcript usage report that keeps
 * uncached input, cache read, cache creation, output, and the largest single
 * request peak as separate dimensions. Cache-read accumulation is processed
 * volume, not unique context size; callers must never infer auto-compaction
 * from these totals.
 */
export type TranscriptUsageReport = Readonly<{
  /** Provider requests (assistant messages / token-count snapshots) observed. */
  requests: number;
  /** Input tokens served outside the provider cache. */
  uncachedInputTokens: number;
  /** Input tokens served from the provider cache. */
  cacheReadTokens: number;
  /** Input tokens written into the provider cache. */
  cacheCreatedTokens: number;
  outputTokens: number;
  /** Largest single-request processed input (uncached + cache read + created). */
  peakRequestTokens: number;
}>;

export function codexTranscriptUsage(transcript: string): RuntimeUsageSnapshot | null {
  const report = codexTranscriptUsageReport(transcript);
  if (report === null) return null;
  return Object.freeze({
    semantics: "cumulative-session" as const,
    inputTokens: report.uncachedInputTokens + report.cacheReadTokens + report.cacheCreatedTokens,
    outputTokens: report.outputTokens,
    ...(report.cacheReadTokens + report.cacheCreatedTokens === 0
      ? {}
      : { cachedInputTokens: report.cacheReadTokens + report.cacheCreatedTokens })
  });
}

export function codexTranscriptUsageReport(transcript: string): TranscriptUsageReport | null {
  // Codex token_count events are cumulative session snapshots. Per-request
  // input is the delta between consecutive snapshots; the first snapshot is
  // treated as one full request.
  let latestInput = 0;
  let latestCached = 0;
  let latestOutput = 0;
  let previous = 0;
  let peak = 0;
  let requests = 0;
  let seen = false;
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
    const cachedInputTokens = integer(usage?.cached_input_tokens) ?? 0;
    requests += 1;
    seen = true;
    const total = inputTokens + cachedInputTokens;
    const delta = Math.max(0, total - previous);
    if (delta > peak) peak = delta;
    previous = total;
    latestInput = inputTokens;
    latestCached = cachedInputTokens;
    latestOutput = outputTokens;
  }
  if (!seen) return null;
  return Object.freeze({
    requests,
    uncachedInputTokens: Math.max(0, latestInput - latestCached),
    cacheReadTokens: latestCached,
    cacheCreatedTokens: 0,
    outputTokens: latestOutput,
    peakRequestTokens: peak
  });
}

export function claudeTranscriptUsage(transcript: string): RuntimeUsageSnapshot | null {
  const report = claudeTranscriptUsageReport(transcript);
  if (report === null) return null;
  return Object.freeze({
    semantics: "cumulative-session" as const,
    inputTokens: report.uncachedInputTokens + report.cacheReadTokens + report.cacheCreatedTokens,
    outputTokens: report.outputTokens,
    ...(report.cacheReadTokens + report.cacheCreatedTokens === 0
      ? {}
      : { cachedInputTokens: report.cacheReadTokens + report.cacheCreatedTokens })
  });
}

export function claudeTranscriptUsageReport(transcript: string): TranscriptUsageReport | null {
  // Each Claude assistant message carries its own per-request usage, so the
  // report is a direct aggregation; the peak is the largest single message.
  const messages = new Map<string, Readonly<{
    directInput: number;
    cacheRead: number;
    cacheCreated: number;
    output: number;
  }>>();
  for (const line of transcript.split("\n")) {
    const entry = parseLine(line);
    if (entry?.type !== "assistant") continue;
    const message = object(entry.message);
    const usage = object(message?.usage);
    const directInput = integer(usage?.input_tokens);
    const output = integer(usage?.output_tokens);
    if (directInput === null || output === null) continue;
    const cacheRead = integer(usage?.cache_read_input_tokens) ?? 0;
    const cacheCreated = integer(usage?.cache_creation_input_tokens) ?? 0;
    const key = typeof message?.id === "string" && message.id.length > 0
      ? `message:${message.id}`
      : typeof entry.uuid === "string" && entry.uuid.length > 0
        ? `entry:${entry.uuid}`
        : null;
    // A streaming transcript can repeat cumulative snapshots. Without a
    // stable provider or entry identity, summing them would fabricate growth.
    if (key === null) continue;
    messages.set(key, { directInput, cacheRead, cacheCreated, output });
  }
  if (messages.size === 0) return null;
  let uncachedInputTokens = 0;
  let cacheReadTokens = 0;
  let cacheCreatedTokens = 0;
  let outputTokens = 0;
  let peak = 0;
  for (const usage of messages.values()) {
    uncachedInputTokens += usage.directInput;
    cacheReadTokens += usage.cacheRead;
    cacheCreatedTokens += usage.cacheCreated;
    outputTokens += usage.output;
    const total = usage.directInput + usage.cacheRead + usage.cacheCreated;
    if (total > peak) peak = total;
  }
  return Object.freeze({
    requests: messages.size,
    uncachedInputTokens,
    cacheReadTokens,
    cacheCreatedTokens,
    outputTokens,
    peakRequestTokens: peak
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
