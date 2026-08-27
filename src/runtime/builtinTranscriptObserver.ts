import { createHash } from "node:crypto";
import { open, stat } from "node:fs/promises";
import { isAbsolute } from "node:path";

import type {
  AgentDriverNativeHook,
  AgentRuntimeObserverCursor,
  AgentRuntimeObserverSample,
  AgentRuntimeObserverSource,
  AgentRuntimeUsageOccurrence
} from "./agentDriver.js";
import type { RuntimeUsageSnapshot } from "./runtimeObservation.js";

const MAX_INITIAL_TAIL_BYTES = 1024 * 1024;
const MAX_SAMPLE_BYTES = 1024 * 1024;
const MAX_REMAINDER_BYTES = 64 * 1024;
const MAX_CLAUDE_MESSAGES = 4_096;

type JsonlCursor = Readonly<{
  offset: number;
  remainder: string;
  state: Readonly<Record<string, unknown>>;
}>;

type ParsedSample = Readonly<{
  state: Readonly<Record<string, unknown>>;
  usages: readonly AgentRuntimeUsageOccurrence[];
  activityId?: string;
  degraded?: string;
}>;

type TranscriptLine = Readonly<{
  content: string;
  offset: number;
}>;

export function transcriptObserverSource(
  driverId: string,
  input: AgentDriverNativeHook
): AgentRuntimeObserverSource | null {
  if (input.hookEventName !== "UserPromptSubmit") return null;
  const locator = input.payload.transcript_path;
  if (typeof locator !== "string" || !isAbsolute(locator) || locator.includes("\0")) return null;
  const sessionId = identity(input.payload.session_id) ?? "session";
  const turnId = identity(input.payload.prompt_id)
    ?? identity(input.payload.turn_id)
    ?? input.occurrenceId
    ?? "turn";
  const digest = createHash("sha256")
    .update(JSON.stringify([driverId, sessionId, turnId, locator]))
    .digest("hex");
  return Object.freeze({
    schemaVersion: 1,
    sourceId: `transcript-${digest}`,
    transport: "append-only-jsonl",
    locator
  });
}

export async function codexTranscriptObserver(
  source: AgentRuntimeObserverSource,
  cursor?: AgentRuntimeObserverCursor
): Promise<AgentRuntimeObserverSample> {
  return sampleJsonl(source, cursor, parseCodexLines);
}

export async function claudeTranscriptObserver(
  source: AgentRuntimeObserverSource,
  cursor?: AgentRuntimeObserverCursor
): Promise<AgentRuntimeObserverSample> {
  return sampleJsonl(source, cursor, parseClaudeLines);
}

async function sampleJsonl(
  source: AgentRuntimeObserverSource,
  rawCursor: AgentRuntimeObserverCursor | undefined,
  parse: (
    lines: readonly TranscriptLine[],
    state: Readonly<Record<string, unknown>>
  ) => ParsedSample
): Promise<AgentRuntimeObserverSample> {
  const previous = normalizeCursor(rawCursor);
  let metadata;
  try {
    metadata = await stat(source.locator);
  } catch (error) {
    return unavailable(previous, error);
  }
  if (!metadata.isFile()) return unavailable(previous, new Error("observer locator is not a file"));

  const reset = previous !== undefined && metadata.size < previous.offset;
  const initial = previous === undefined || reset;
  const start = initial
    ? Math.max(0, metadata.size - MAX_INITIAL_TAIL_BYTES)
    : previous.offset;
  const length = Math.min(MAX_SAMPLE_BYTES, Math.max(0, metadata.size - start));
  let bytes = Buffer.alloc(0);
  try {
    if (length > 0) {
      const handle = await open(source.locator, "r");
      try {
        bytes = Buffer.alloc(length);
        const read = await handle.read(bytes, 0, length, start);
        bytes = bytes.subarray(0, read.bytesRead);
      } finally {
        await handle.close();
      }
    }
  } catch (error) {
    return unavailable(previous, error);
  }

  let text = `${initial ? "" : previous?.remainder ?? ""}${bytes.toString("utf8")}`;
  let textOffset = initial
    ? start
    : previous!.offset - Buffer.byteLength(previous!.remainder, "utf8");
  if (initial && start > 0) {
    const firstLineEnd = text.indexOf("\n");
    if (firstLineEnd < 0) {
      textOffset += Buffer.byteLength(text, "utf8");
      text = "";
    } else {
      const discarded = text.slice(0, firstLineEnd + 1);
      textOffset += Buffer.byteLength(discarded, "utf8");
      text = text.slice(firstLineEnd + 1);
    }
  }
  const complete = text.endsWith("\n");
  const split = text.split("\n");
  const remainder = complete ? "" : split.pop() ?? "";
  if (complete) split.pop();
  let lineOffset = textOffset;
  const lines = split.map((content): TranscriptLine => {
    const line = Object.freeze({ content, offset: lineOffset });
    lineOffset += Buffer.byteLength(content, "utf8") + 1;
    return line;
  });
  const boundedRemainder = Buffer.byteLength(remainder, "utf8") <= MAX_REMAINDER_BYTES
    ? remainder
    : "";
  const parsed = parse(lines, initial ? {} : previous?.state ?? {});
  const nextCursor = Object.freeze({
    offset: start + bytes.length,
    remainder: boundedRemainder,
    state: parsed.state
  });
  const fellBehind = start + bytes.length < metadata.size;
  const detail = parsed.degraded
    ?? (fellBehind ? "Transcript observer is catching up with a bounded read." : undefined)
    ?? (reset ? "Transcript was truncated; observer baseline was reset." : undefined)
    ?? (remainder !== boundedRemainder ? "Oversized partial transcript line was discarded." : undefined);
  return Object.freeze({
    cursor: nextCursor,
    status: detail === undefined ? "healthy" : "degraded",
    ...(detail === undefined ? {} : { detail }),
    ...(parsed.usages.length === 0 ? {} : { usages: parsed.usages }),
    ...(parsed.activityId === undefined ? {} : {
      activity: "model" as const,
      activityId: parsed.activityId
    })
  });
}

function parseCodexLines(
  lines: readonly TranscriptLine[],
  state: Readonly<Record<string, unknown>>
): ParsedSample {
  let usage = usageFrom(state.usage);
  const usages: AgentRuntimeUsageOccurrence[] = [];
  let malformed = 0;
  for (const line of lines) {
    const entry = jsonObject(line.content);
    if (entry === null) {
      if (line.content.trim().length > 0) malformed += 1;
      continue;
    }
    if (entry.type !== "event_msg") continue;
    const payload = object(entry.payload);
    if (payload?.type !== "token_count") continue;
    const candidate = normalizedCodexUsage(object(object(payload.info)?.total_token_usage));
    if (candidate === undefined) continue;
    usage = candidate;
    usages.push(Object.freeze({
      occurrenceId: `byte:${line.offset}`,
      usage: candidate
    }));
  }
  return Object.freeze({
    state: Object.freeze({ ...(usage === undefined ? {} : { usage }) }),
    usages: Object.freeze(usages),
    ...(malformed === 0 ? {} : { degraded: `${malformed} malformed transcript line(s) ignored.` })
  });
}

function parseClaudeLines(
  lines: readonly TranscriptLine[],
  state: Readonly<Record<string, unknown>>
): ParsedSample {
  const messages = messageState(state.messages);
  const usages: AgentRuntimeUsageOccurrence[] = [];
  let activityId: string | undefined;
  let malformed = 0;
  let bounded = false;
  for (const line of lines) {
    const entry = jsonObject(line.content);
    if (entry === null) {
      if (line.content.trim().length > 0) malformed += 1;
      continue;
    }
    if (entry.type !== "assistant") continue;
    const message = object(entry.message);
    const usage = normalizedClaudeUsage(object(message?.usage));
    if (usage === undefined) continue;
    const key = identity(message?.id) === undefined
      ? identity(entry.uuid) === undefined ? undefined : `entry:${identity(entry.uuid)}`
      : `message:${identity(message?.id)}`;
    if (key === undefined) continue;
    messages[key] = usage;
    activityId = key;
    const keys = Object.keys(messages);
    if (keys.length > MAX_CLAUDE_MESSAGES) {
      for (const oldKey of keys.slice(0, keys.length - MAX_CLAUDE_MESSAGES)) {
        delete messages[oldKey];
      }
      bounded = true;
    }
    const cumulative = sumUsage(Object.values(messages));
    if (cumulative !== undefined) {
      usages.push(Object.freeze({
        occurrenceId: `byte:${line.offset}`,
        usage: cumulative
      }));
    }
  }
  let degraded = malformed === 0 ? undefined : `${malformed} malformed transcript line(s) ignored.`;
  if (bounded) {
    degraded = "Claude transcript message baseline was bounded to the newest entries.";
  }
  return Object.freeze({
    state: Object.freeze({ messages: Object.freeze(messages) }),
    usages: Object.freeze(usages),
    ...(activityId === undefined ? {} : { activityId }),
    ...(degraded === undefined ? {} : { degraded })
  });
}

function normalizeCursor(input: AgentRuntimeObserverCursor | undefined): JsonlCursor | undefined {
  if (input === undefined) return undefined;
  const offset = input.offset;
  const remainder = input.remainder;
  const state = input.state;
  if (!Number.isSafeInteger(offset) || (offset as number) < 0
    || typeof remainder !== "string"
    || state === null || typeof state !== "object" || Array.isArray(state)) return undefined;
  return Object.freeze({
    offset: offset as number,
    remainder,
    state: state as Readonly<Record<string, unknown>>
  });
}

function unavailable(
  cursor: JsonlCursor | undefined,
  error: unknown
): AgentRuntimeObserverSample {
  return Object.freeze({
    cursor: cursor ?? Object.freeze({ offset: 0, remainder: "", state: Object.freeze({}) }),
    status: "unavailable",
    detail: error instanceof Error ? error.message : String(error)
  });
}

function normalizedCodexUsage(
  usage: Readonly<Record<string, unknown>> | null
): RuntimeUsageSnapshot | undefined {
  const inputTokens = integer(usage?.input_tokens);
  const outputTokens = integer(usage?.output_tokens);
  if (inputTokens === undefined || outputTokens === undefined) return undefined;
  const cachedInputTokens = integer(usage?.cached_input_tokens);
  const reasoningTokens = integer(usage?.reasoning_output_tokens);
  return Object.freeze({
    semantics: "cumulative-session" as const,
    inputTokens,
    outputTokens,
    ...(cachedInputTokens === undefined ? {} : { cachedInputTokens }),
    ...(reasoningTokens === undefined ? {} : { reasoningTokens })
  });
}

function normalizedClaudeUsage(
  usage: Readonly<Record<string, unknown>> | null
): RuntimeUsageSnapshot | undefined {
  const directInput = integer(usage?.input_tokens);
  const outputTokens = integer(usage?.output_tokens);
  if (directInput === undefined || outputTokens === undefined) return undefined;
  const cacheRead = integer(usage?.cache_read_input_tokens) ?? 0;
  const cacheCreated = integer(usage?.cache_creation_input_tokens) ?? 0;
  const reasoningTokens = integer(object(usage?.output_tokens_details)?.thinking_tokens);
  return Object.freeze({
    semantics: "cumulative-session" as const,
    inputTokens: directInput + cacheRead + cacheCreated,
    outputTokens,
    cachedInputTokens: cacheRead + cacheCreated,
    ...(reasoningTokens === undefined ? {} : { reasoningTokens })
  });
}

function messageState(value: unknown): Record<string, RuntimeUsageSnapshot> {
  const source = object(value) ?? {};
  const result: Record<string, RuntimeUsageSnapshot> = {};
  for (const [key, raw] of Object.entries(source)) {
    const usage = usageFrom(raw);
    if (usage !== undefined) result[key] = usage;
  }
  return result;
}

function usageFrom(value: unknown): RuntimeUsageSnapshot | undefined {
  const raw = object(value);
  const inputTokens = integer(raw?.inputTokens);
  const outputTokens = integer(raw?.outputTokens);
  if (inputTokens === undefined || outputTokens === undefined) return undefined;
  const cachedInputTokens = integer(raw?.cachedInputTokens);
  const reasoningTokens = integer(raw?.reasoningTokens);
  return Object.freeze({
    semantics: "cumulative-session" as const,
    inputTokens,
    outputTokens,
    ...(cachedInputTokens === undefined ? {} : { cachedInputTokens }),
    ...(reasoningTokens === undefined ? {} : { reasoningTokens })
  });
}

function sumUsage(values: readonly RuntimeUsageSnapshot[]): RuntimeUsageSnapshot | undefined {
  if (values.length === 0) return undefined;
  let inputTokens = 0;
  let outputTokens = 0;
  let cachedInputTokens = 0;
  let reasoningTokens = 0;
  for (const usage of values) {
    inputTokens += usage.inputTokens;
    outputTokens += usage.outputTokens;
    cachedInputTokens += usage.cachedInputTokens ?? 0;
    reasoningTokens += usage.reasoningTokens ?? 0;
  }
  return Object.freeze({
    semantics: "cumulative-session" as const,
    inputTokens,
    outputTokens,
    cachedInputTokens,
    ...(reasoningTokens === 0 ? {} : { reasoningTokens })
  });
}

function jsonObject(line: string): Record<string, unknown> | null {
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

function integer(value: unknown): number | undefined {
  return Number.isSafeInteger(value) && (value as number) >= 0 ? value as number : undefined;
}

function identity(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 && !value.includes("\0")
    ? value.trim()
    : undefined;
}
