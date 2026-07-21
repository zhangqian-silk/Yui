export type AgentAdapterId = "codex" | "claude";

export type AgentAdapterCatalogEntry = Readonly<{
  id: AgentAdapterId;
  label: string;
}>;

export const AGENT_ADAPTER_CATALOG: readonly AgentAdapterCatalogEntry[] = Object.freeze([
  Object.freeze({ id: "codex", label: "Codex" }),
  Object.freeze({ id: "claude", label: "Claude" })
]);

export function supportedAgentAdapterIds(): AgentAdapterId[] {
  return AGENT_ADAPTER_CATALOG.map(({ id }) => id).sort();
}

export function isAgentAdapterId(value: unknown): value is AgentAdapterId {
  return value === "codex" || value === "claude";
}
