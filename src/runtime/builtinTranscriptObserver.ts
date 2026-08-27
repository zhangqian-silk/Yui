import { createHash } from "node:crypto";
import { open, stat } from "node:fs/promises";
import { isAbsolute } from "node:path";

import type {
  AgentDriverNativeHook,
  AgentRuntimeObserverCursor,
  AgentRuntimeObserverResume,
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
  continuityEpoch: string;
  fileFingerprint?: string;
  fileCtimeMs?: number;
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
  continuityEpoch: string;
  fileFingerprint: string;
  observedFileSize: number;
  observedFileCtimeMs: number;
}>;

type TranscriptCheckpoint = Readonly<{
  occurrenceId: string;
  continuityEpoch: string;
  fileFingerprint: string;
  offset: number;
  length: number;
  digest: string;
  observedFileSize: number;
  observedFileCtimeMs: number;
}>;

const INITIAL_CONTINUITY_EPOCH = "initial";

export function transcriptObserverSource(
  driverId: string,
  input: AgentDriverNativeHook
): AgentRuntimeObserverSource | null {
  if (input.hookEventName !== "UserPromptSubmit") return null;
  const locator = input.payload.transcript_path;
  if (typeof locator !== "string" || !isAbsolute(locator) || locator.includes("\0")) return null;
  const sessionId = identity(input.payload.session_id) ?? "session";
  const digest = createHash("sha256")
    .update(JSON.stringify([driverId, sessionId, locator]))
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
  cursor?: AgentRuntimeObserverCursor,
  resume?: AgentRuntimeObserverResume
): Promise<AgentRuntimeObserverSample> {
  return sampleJsonl(source, cursor, resume, parseCodexLines);
}

export async function claudeTranscriptObserver(
  source: AgentRuntimeObserverSource,
  cursor?: AgentRuntimeObserverCursor,
  resume?: AgentRuntimeObserverResume
): Promise<AgentRuntimeObserverSample> {
  return sampleJsonl(source, cursor, resume, parseClaudeLines);
}

async function sampleJsonl(
  source: AgentRuntimeObserverSource,
  rawCursor: AgentRuntimeObserverCursor | undefined,
  resume: AgentRuntimeObserverResume | undefined,
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

  const fileFingerprint = transcriptFileFingerprint(metadata);
  const checkpoint = previous === undefined
    ? transcriptCheckpoint(resume?.latestCheckpoint, resume?.latestOccurrenceId)
    : undefined;
  let checkpointMatches = false;
  if (previous === undefined && checkpoint !== undefined) {
    try {
      checkpointMatches = await matchesTranscriptCheckpoint(
        source.locator,
        metadata,
        fileFingerprint,
        checkpoint
      );
    } catch (error) {
      return unavailable(previous, error);
    }
  }
  const reset = previous !== undefined && (
    previous.fileFingerprint === undefined
    || previous.fileFingerprint !== fileFingerprint
    || metadata.size < previous.offset
    || (metadata.size === previous.offset && (
      previous.fileCtimeMs === undefined
      || previous.fileCtimeMs !== metadata.ctimeMs
    ))
  );
  const offlineReset = previous === undefined
    && checkpoint !== undefined
    && !checkpointMatches;
  const initial = previous === undefined || reset;
  const continuityEpoch = reset || offlineReset
    ? rotateContinuityEpoch(
        previous?.continuityEpoch ?? checkpoint?.continuityEpoch ?? INITIAL_CONTINUITY_EPOCH,
        fileFingerprint
      )
    : previous?.continuityEpoch
      ?? checkpoint?.continuityEpoch
      ?? initialContinuityEpoch(fileFingerprint);
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
    const line = Object.freeze({
      content,
      offset: lineOffset,
      continuityEpoch,
      fileFingerprint,
      observedFileSize: metadata.size,
      observedFileCtimeMs: metadata.ctimeMs
    });
    lineOffset += Buffer.byteLength(content, "utf8") + 1;
    return line;
  });
  const boundedRemainder = Buffer.byteLength(remainder, "utf8") <= MAX_REMAINDER_BYTES
    ? remainder
    : "";
  const parsed = parse(lines, initial ? {} : previous?.state ?? {});
  const clippedBaseline = initial && start > 0;
  const discontinuousBaseline = clippedBaseline || reset || offlineReset;
  const usages = discontinuousBaseline
    ? parsed.usages.map((occurrence) => Object.freeze({
        ...occurrence,
        observationQuality: "partial" as const
      }))
    : parsed.usages;
  const nextCursor = Object.freeze({
    offset: start + bytes.length,
    remainder: boundedRemainder,
    state: parsed.state,
    continuityEpoch,
    fileFingerprint,
    fileCtimeMs: metadata.ctimeMs
  });
  const fellBehind = start + bytes.length < metadata.size;
  const detail = parsed.degraded
    ?? (clippedBaseline
      ? "Initial transcript history was clipped; request-boundary evidence is partial."
      : undefined)
    ?? (fellBehind ? "Transcript observer is catching up with a bounded read." : undefined)
    ?? (offlineReset ? "Transcript changed while the observer was offline; baseline was reset." : undefined)
    ?? (reset ? "Transcript was truncated; observer baseline was reset." : undefined)
    ?? (remainder !== boundedRemainder ? "Oversized partial transcript line was discarded." : undefined);
  return Object.freeze({
    cursor: nextCursor,
    status: detail === undefined ? "healthy" : "degraded",
    ...(detail === undefined ? {} : { detail }),
    ...(usages.length === 0 ? {} : { usages: Object.freeze(usages) }),
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
      ...transcriptOccurrence(line),
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
    usages.push(Object.freeze({
      ...transcriptOccurrence(line),
      activityId: key,
      usage
    }));
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

function transcriptOccurrence(
  line: TranscriptLine
): Readonly<{ occurrenceId: string; resumeCheckpoint: string }> {
  // The durable semantic key retains this bounded checkpoint. A Controller
  // restart can therefore reuse the epoch only when the sampled file is still
  // the same continuity, without persisting the process-local cursor itself.
  const digest = createHash("sha256").update(line.content).digest("hex");
  const occurrenceId = `transcript-v1:${Buffer.from(JSON.stringify({
    continuityEpoch: line.continuityEpoch,
    fileFingerprint: line.fileFingerprint,
    offset: line.offset,
    digest
  }), "utf8").toString("base64url")}`;
  const resumeCheckpoint = `transcript-checkpoint-v1:${Buffer.from(JSON.stringify({
    occurrenceId,
    continuityEpoch: line.continuityEpoch,
    fileFingerprint: line.fileFingerprint,
    offset: line.offset,
    length: Buffer.byteLength(line.content, "utf8"),
    digest,
    observedFileSize: line.observedFileSize,
    observedFileCtimeMs: line.observedFileCtimeMs
  }), "utf8").toString("base64url")}`;
  return Object.freeze({ occurrenceId, resumeCheckpoint });
}

function initialContinuityEpoch(fileFingerprint: string): string {
  return continuityEpoch("initial", fileFingerprint);
}

function rotateContinuityEpoch(previous: string, fileFingerprint: string): string {
  return continuityEpoch(previous, fileFingerprint);
}

function continuityEpoch(previous: string, fileFingerprint: string): string {
  return `sha256:${createHash("sha256")
    .update(JSON.stringify([previous, fileFingerprint]))
    .digest("hex")}`;
}

function transcriptFileFingerprint(metadata: Readonly<{
  dev: number;
  ino: number;
}>): string {
  return `sha256:${createHash("sha256").update(JSON.stringify([
    metadata.dev,
    metadata.ino
  ])).digest("hex")}`;
}

async function matchesTranscriptCheckpoint(
  locator: string,
  metadata: Readonly<{ size: number; ctimeMs: number }>,
  fileFingerprint: string,
  checkpoint: TranscriptCheckpoint
): Promise<boolean> {
  if (checkpoint.fileFingerprint !== fileFingerprint
    || metadata.size < checkpoint.observedFileSize) return false;
  if (metadata.size === checkpoint.observedFileSize) {
    return metadata.ctimeMs === checkpoint.observedFileCtimeMs;
  }
  if (checkpoint.offset + checkpoint.length + 1 > metadata.size) return false;
  const handle = await open(locator, "r");
  try {
    const bytes = Buffer.alloc(checkpoint.length + 1);
    const read = await handle.read(bytes, 0, bytes.length, checkpoint.offset);
    return read.bytesRead === bytes.length
      && bytes.at(-1) === 0x0a
      && createHash("sha256")
        .update(bytes.subarray(0, checkpoint.length))
        .digest("hex") === checkpoint.digest;
  } finally {
    await handle.close();
  }
}

function transcriptCheckpoint(
  raw: string | undefined,
  occurrenceId: string | undefined
): TranscriptCheckpoint | undefined {
  const prefix = "transcript-checkpoint-v1:";
  if (raw === undefined || occurrenceId === undefined || !raw.startsWith(prefix)) return undefined;
  try {
    const value: unknown = JSON.parse(Buffer.from(
      raw.slice(prefix.length),
      "base64url"
    ).toString("utf8"));
    if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
    const checkpoint = value as Record<string, unknown>;
    return checkpoint.occurrenceId !== occurrenceId
      || typeof checkpoint.continuityEpoch !== "string"
      || checkpoint.continuityEpoch.length === 0
      || typeof checkpoint.fileFingerprint !== "string"
      || checkpoint.fileFingerprint.length === 0
      || !Number.isSafeInteger(checkpoint.offset)
      || (checkpoint.offset as number) < 0
      || !Number.isSafeInteger(checkpoint.length)
      || (checkpoint.length as number) < 0
      || typeof checkpoint.digest !== "string"
      || checkpoint.digest.length === 0
      || !Number.isSafeInteger(checkpoint.observedFileSize)
      || (checkpoint.observedFileSize as number) < 0
      || typeof checkpoint.observedFileCtimeMs !== "number"
      || !Number.isFinite(checkpoint.observedFileCtimeMs)
      || checkpoint.observedFileCtimeMs < 0
      ? undefined
      : Object.freeze({
          occurrenceId,
          continuityEpoch: checkpoint.continuityEpoch,
          fileFingerprint: checkpoint.fileFingerprint,
          offset: checkpoint.offset as number,
          length: checkpoint.length as number,
          digest: checkpoint.digest,
          observedFileSize: checkpoint.observedFileSize as number,
          observedFileCtimeMs: checkpoint.observedFileCtimeMs
        });
  } catch {
    return undefined;
  }
}

function normalizeCursor(input: AgentRuntimeObserverCursor | undefined): JsonlCursor | undefined {
  if (input === undefined) return undefined;
  const offset = input.offset;
  const remainder = input.remainder;
  const state = input.state;
  const continuityEpoch = input.continuityEpoch;
  const fileFingerprint = input.fileFingerprint;
  const fileCtimeMs = input.fileCtimeMs;
  if (!Number.isSafeInteger(offset) || (offset as number) < 0
    || typeof remainder !== "string"
    || state === null || typeof state !== "object" || Array.isArray(state)
    || (continuityEpoch !== undefined
      && (typeof continuityEpoch !== "string" || continuityEpoch.length === 0))
    || (fileFingerprint !== undefined
      && (typeof fileFingerprint !== "string" || fileFingerprint.length === 0))
    || (fileCtimeMs !== undefined
      && (typeof fileCtimeMs !== "number" || !Number.isFinite(fileCtimeMs) || fileCtimeMs < 0))) {
    return undefined;
  }
  return Object.freeze({
    offset: offset as number,
    remainder,
    state: state as Readonly<Record<string, unknown>>,
    continuityEpoch: typeof continuityEpoch === "string"
      ? continuityEpoch
      : INITIAL_CONTINUITY_EPOCH,
    ...(typeof fileFingerprint === "string" ? { fileFingerprint } : {}),
    ...(typeof fileCtimeMs === "number" ? { fileCtimeMs } : {})
  });
}

function unavailable(
  cursor: JsonlCursor | undefined,
  error: unknown
): AgentRuntimeObserverSample {
  return Object.freeze({
    cursor: cursor ?? Object.freeze({
      offset: 0,
      remainder: "",
      state: Object.freeze({}),
      continuityEpoch: INITIAL_CONTINUITY_EPOCH
    }),
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
    semantics: "request-context" as const,
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
