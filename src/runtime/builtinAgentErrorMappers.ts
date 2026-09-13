import type {
  AgentDriverErrorInput,
  AgentErrorClassification
} from "./agentError.js";

/** Provider-specific Claude Code failure recognition. */
export function mapClaudeAgentError(
  input: AgentDriverErrorInput
): AgentErrorClassification {
  return withTransientEvidence(mapClaudeDisplayError(input), input);
}

function mapClaudeDisplayError(input: AgentDriverErrorInput): AgentErrorClassification {
  const text = `${input.message}\n${input.raw}`;
  if (/^No conversation found with session ID: [A-Za-z0-9-]+\.?$/imu.test(input.message)) {
    return sessionUnavailable("provider.session-not-found");
  }
  if (/^server_error$/iu.test(input.message) || /\bapi_error\b/iu.test(text)) {
    return recoverable("availability", "provider.server-error");
  }
  if (/^overloaded_error$/iu.test(input.message) || /\boverloaded\b/iu.test(text)) {
    return recoverable("availability", "provider.overloaded");
  }
  if (/^rate_limit_error$/iu.test(input.message) || /rate[\s_-]?limit/iu.test(text)) {
    return recoverable("rate-limit", "provider.rate-limit");
  }
  if (/^(authentication_error|permission_error)$/iu.test(input.message)) {
    return classification("access", "provider.access-denied");
  }
  if (/^not_found_error$/iu.test(input.message)) {
    return sessionUnavailable("provider.session-not-found");
  }
  return mapSharedAgentError(text, "claude-code");
}

/** Provider-specific Codex failure recognition. */
export function mapCodexAgentError(
  input: AgentDriverErrorInput
): AgentErrorClassification {
  return withTransientEvidence(mapCodexDisplayError(input), input);
}

function mapCodexDisplayError(input: AgentDriverErrorInput): AgentErrorClassification {
  const text = `${input.message}\n${input.raw}`;
  if (/^server_error$/iu.test(input.message)) {
    return recoverable("availability", "provider.server-error");
  }
  if (/^overloaded_error$/iu.test(input.message)
    || /selected model is at capacity/iu.test(text)
    || /\bmodel\b.*\bat capacity\b/iu.test(text)) {
    return recoverable("availability", "provider.model-capacity");
  }
  if (/^rate_limit_error$/iu.test(input.message)) {
    return recoverable("rate-limit", "provider.rate-limit");
  }
  if (/^(authentication_error|permission_error)$/iu.test(input.message)) {
    return classification("access", "provider.access-denied");
  }
  if (/\[codex:(unrecognized_model|invalid_model|model_not_found)\]/iu.test(text)
    || /model.*not supported|invalid.*model|model.*not found/iu.test(text)) {
    return classification("invalid-request", "provider.invalid-model");
  }
  if (/stream disconnected/iu.test(text)) {
    return recoverable("transport", "transport.stream-disconnected");
  }
  return mapSharedAgentError(text, "codex");
}

/**
 * Agent Client Protocol failure recognition.
 *
 * ACP rides on JSON-RPC 2.0, so its failures arrive as numeric codes rather
 * than provider prose. The codes are recognized first because they are the
 * protocol's own exact vocabulary; only then does the shared text matcher run,
 * which is what catches the transport failures underneath the protocol.
 */
export function mapAcpAgentError(
  input: AgentDriverErrorInput
): AgentErrorClassification {
  const text = `${input.message}\n${input.raw}`;
  // -32800 is ACP's own "request cancelled". It is the expected answer to
  // `session/cancel`, not a fault.
  if (/-32800/u.test(text) || /request[\s_-]?cancell?ed/iu.test(text)) {
    return Object.freeze({
      category: "cancelled",
      code: "acp.request-cancelled",
      sessionDisposition: "recoverable"
    });
  }
  // -32601 method not found / -32602 invalid params: Yui asked for something
  // this Agent does not implement, or asked for it wrongly. Either way the
  // request is at fault, and retrying it unchanged cannot help.
  if (/-32601/u.test(text)) {
    return classification("invalid-request", "acp.method-not-found");
  }
  if (/-32602/u.test(text)) {
    return classification("invalid-request", "acp.invalid-params");
  }
  if (/-3270[01]/u.test(text)) {
    return classification("invalid-request", "acp.invalid-request");
  }
  // -32603 is the catch-all internal error: the Agent failed, but the protocol
  // says nothing about whether this Session survived.
  if (/-32603/u.test(text)) {
    return recoverable("runtime", "acp.internal-error");
  }
  // ACP's authentication path: the Agent requires `authenticate` first. Yui
  // never performs it on the user's behalf, so this is a genuine access fact.
  if (/auth[\s_-]?required|requires? authentication|-32000/iu.test(text)) {
    return classification("access", "acp.authentication-required");
  }
  return mapSharedAgentError(text, "acp");
}

function mapSharedAgentError(
  text: string,
  namespace: "codex" | "claude-code" | "acp"
): AgentErrorClassification {
  if (/stream error:.*INTERNAL_ERROR/iu.test(text)) {
    return recoverable("transport", "transport.stream-internal-error");
  }
  if (/stream error:.*PROTOCOL_ERROR/iu.test(text)) {
    return recoverable("transport", "transport.stream-protocol-error");
  }
  if (/stream error/iu.test(text)) return recoverable("transport", "transport.stream-error");
  if (/\b429\b/u.test(text) || /rate[\s_-]?limit/iu.test(text)) {
    return recoverable("rate-limit", "provider.rate-limit");
  }
  if (/\b40[0-9]\b/u.test(text)) return classification("invalid-request", "provider.http-4xx");
  if (/\b50[0-9]\b/u.test(text)
    || /bad gateway|service unavailable|temporarily unavailable/iu.test(text)) {
    return recoverable("availability", "provider.http-5xx");
  }
  if (/server[\s_-]?error/iu.test(text)) {
    return recoverable("availability", "provider.server-error");
  }
  if (/\boverloaded\b/iu.test(text)) {
    return recoverable("availability", "provider.overloaded");
  }
  if (/gateway timeout|timed?[ -]?out|etimedout/iu.test(text)) {
    return recoverable("transport", "transport.timeout");
  }
  if (/connection[\s_-]?reset|econnreset|socket hang up/iu.test(text)) {
    return recoverable("transport", "transport.connection-reset");
  }
  if (/connection[\s_-]?lost/iu.test(text)) {
    return recoverable("transport", "transport.connection-lost");
  }
  if (/\beconnrefused\b|connection refused|connect[^\n]*refused/iu.test(text)) {
    return recoverable("transport", "transport.connection-refused");
  }
  if (/\bepipe\b|broken pipe/iu.test(text)) {
    return recoverable("transport", "transport.broken-pipe");
  }
  if (/\b(?:enotfound|eai_again)\b|dns[^\n]*(?:failed|unavailable)/iu.test(text)) {
    return recoverable("transport", "transport.name-resolution");
  }
  if (/\benoent\b[^\n]*(?:socket|agent-host)|no such file[^\n]*(?:socket|agent-host)/iu.test(text)) {
    return recoverable("transport", "transport.endpoint-missing");
  }
  if (/delivery[^\n]*unknown|acknowledgement[^\n]*unknown/iu.test(text)) {
    return Object.freeze({
      category: "transport",
      code: "transport.delivery-unknown",
      inputDisposition: "unknown",
      sessionDisposition: "recoverable"
    });
  }
  if (/unsettled turn|turn[^\n]*busy|session[^\n]*busy|writer fence|writer authority|human writer/iu.test(text)) {
    return Object.freeze({
      category: "conflict",
      code: "runtime.session-busy",
      inputDisposition: "not-accepted",
      sessionDisposition: "recoverable"
    });
  }
  if (/cyber[_-]?policy|policy[\s_-]?violation|usage[\s_-]?policy|content[\s_-]?policy|safety[\s_-]?policy/iu.test(text)) {
    return classification("access", "provider.policy-denied");
  }
  if (/maximum context length|context length exceeded|context window (?:is )?(?:full|exceeded)|prompt (?:is )?too long|too many tokens/iu.test(text)) {
    return classification("context", "provider.context-capacity");
  }
  if (/session[\s_-]?not[\s_-]?found|no[\s_-]?such[\s_-]?(?:session|thread)|thread[\s_-]?not[\s_-]?found/iu.test(text)) {
    return sessionUnavailable("provider.session-not-found");
  }
  if (/session[\s_-]?(?:has[\s_-]?)?expired/iu.test(text)) {
    return sessionUnavailable("provider.session-expired");
  }
  if (/session[\s_-]?(?:has[\s_-]?)?ended/iu.test(text)) {
    return sessionUnavailable("provider.session-ended");
  }
  if (/process[\s_-]?exited/iu.test(text)) {
    return recoverable("runtime", "runtime.process-exited");
  }
  if (/invalid[\s_-]?request|validation[\s_-]?error|bad[\s_-]?request|unknown[\s_-]?(?:flag|tool|argument)|unexpected argument|invalid schema/iu.test(text)
    || namespacedModelError(namespace).test(text)) {
    return classification("invalid-request", "provider.invalid-request");
  }
  return classification("unknown", "unknown");
}

/**
 * The `[<namespace>:<code>]` model-error tag, built from the caller's own
 * namespace. Enumerating the namespaces here instead would silently test one
 * provider's tag against another provider's text.
 */
function namespacedModelError(namespace: string): RegExp {
  return new RegExp(
    String.raw`\[${namespace}:(?:unrecognized_model|invalid_model|model_not_found)\]`,
    "iu"
  );
}

function classification(
  category: AgentErrorClassification["category"],
  code: string
): AgentErrorClassification {
  return Object.freeze({ category, code });
}

function recoverable(
  category: AgentErrorClassification["category"],
  code: string
): AgentErrorClassification {
  return Object.freeze({
    category,
    code,
    sessionDisposition: "recoverable"
  });
}

function sessionUnavailable(code: string): AgentErrorClassification {
  return Object.freeze({
    category: "session",
    code,
    sessionDisposition: "unrecoverable"
  });
}

/** Replay qualification is stricter than the readable, best-effort category.
 * Never promote a number occurring in provider prose to submission safety. */
function structuredTransientError(input: AgentDriverErrorInput): AgentErrorClassification | undefined {
  if (/insufficient[_ -]quota|quota.{0,25}(exhaust|exceed)|billing[_ -]hard[_ -]limit|usageLimitExceeded|credits?.{0,20}(exhaust|insufficient)/iu.test(
    `${input.message}\n${input.raw}`
  )) return { category: "access", code: "provider.quota-exhausted", retryable: false };
  const nodes: Record<string, unknown>[] = [];
  const visit = (value: unknown, depth: number): void => {
    if (depth > 8 || value === null || typeof value !== "object" || Array.isArray(value)) return;
    const node = value as Record<string, unknown>;
    nodes.push(node);
    for (const key of ["cause", "error", "data", "codexErrorInfo", "responseTooManyFailedAttempts",
      "httpConnectionFailed", "responseStreamConnectionFailed", "responseStreamDisconnected", "error_details"]) {
      visit(node[key], depth + 1);
    }
  };
  try { visit(JSON.parse(input.raw), 0); } catch { /* Display classification may still use prose. */ }
  const codes = nodes.flatMap(n => [n.code, n.type, n.error, n.codexErrorInfo]).filter(v => typeof v === "string");
  if (codes.some(c => ["authentication_error", "permission_error", "invalid_api_key", "invalid_model",
    "model_not_found", "usage_limit_exceeded", "insufficient_quota"].includes(c))) {
    return { category: "access", code: "provider.access-denied", retryable: false };
  }
  const statuses = nodes.flatMap(n => [n.httpStatusCode, n.statusCode, n.status]).filter(v => typeof v === "number");
  if (statuses.some(s => s === 401 || s === 403 || s === 400 || s === 404)) {
    return { category: "invalid-request", code: "provider.http-4xx", retryable: false };
  }
  const nativeCode = input.message.trim();
  let result: AgentErrorClassification | undefined;
  if (statuses.includes(429) || codes.includes("rate_limit_error") || nativeCode === "rate_limit_error") {
    result = recoverable("rate-limit", "provider.rate-limit");
  } else if (statuses.some(s => [500, 502, 503, 504].includes(s))
    || codes.some(c => ["server_error", "overloaded_error"].includes(c))
    || ["server_error", "overloaded_error"].includes(nativeCode)) {
    result = recoverable("availability", "provider.server-error");
  } else if (codes.some(c => ["ECONNRESET", "ECONNREFUSED", "EAI_AGAIN", "ETIMEDOUT", "EPIPE"].includes(c))) {
    result = recoverable("transport", "transport.temporary-failure");
  }
  if (result === undefined) return undefined;
  const waits: number[] = [];
  for (const node of nodes) {
    for (const value of [node.retry_after_ms, node.retryAfterMs]) {
      if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) waits.push(value);
    }
    const headers = node.headers;
    if (headers === null || typeof headers !== "object" || Array.isArray(headers)) continue;
    const entries = Object.entries(headers);
    const value = entries.find(([k]) => k.toLowerCase() === "retry-after")?.[1];
    if (typeof value !== "string") continue;
    if (/^\d+(?:\.\d+)?$/u.test(value.trim())) waits.push(Math.ceil(Number(value) * 1_000));
    else {
      const date = Date.parse(value);
      if (Number.isFinite(date)) waits.push(Math.max(0, date - Date.now()));
    }
  }
  const retryAfterMs = Math.max(...waits.filter(Number.isSafeInteger));
  return { ...result, retryable: true,
    ...(Number.isFinite(retryAfterMs) ? { retryAfterMs } : {}) };
}

/** Add positive evidence without renaming established diagnostics or letting
 * a transient nested cause override a known fatal Session/request failure. */
function withTransientEvidence(base: AgentErrorClassification, input: AgentDriverErrorInput): AgentErrorClassification {
  const evidence = structuredTransientError(input);
  if (evidence === undefined) return base;
  const possiblyTransient = ["rate-limit", "availability", "transport", "unknown"].includes(base.category);
  if (evidence.retryable === false) return possiblyTransient ? evidence : { ...base, retryable: false };
  if (!possiblyTransient || base.sessionDisposition === "unrecoverable") return base;
  return {
    ...(base.category === "unknown" ? evidence : base), retryable: true,
    ...(evidence.retryAfterMs === undefined ? {} : { retryAfterMs: evidence.retryAfterMs })
  };
}
