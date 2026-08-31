import type {
  AgentDriverErrorInput,
  AgentErrorClassification
} from "./agentError.js";

/** Provider-specific Claude Code failure recognition. */
export function mapClaudeAgentError(
  input: AgentDriverErrorInput
): AgentErrorClassification {
  const text = `${input.message}\n${input.raw}`;
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

function mapSharedAgentError(
  text: string,
  namespace: "codex" | "claude-code"
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
    || (namespace === "codex"
      ? /\[codex:(?:unrecognized_model|invalid_model|model_not_found)\]/iu.test(text)
      : /\[claude-code:(?:unrecognized_model|invalid_model|model_not_found)\]/iu.test(text))) {
    return classification("invalid-request", "provider.invalid-request");
  }
  return classification("unknown", "unknown");
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
