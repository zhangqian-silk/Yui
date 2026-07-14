/**
 * One authoritative-storage file must remain readable by the native pinned
 * reader and recovery journal. Callers that persist nested journal payloads
 * reserve one byte when they need a strict-below relationship.
 */
export const MAX_AUTHORITATIVE_RECORD_BYTES = 16 * 1024 * 1024;
