export type AgentAdapterCatalogEntry = {
  id: string;
  label: string;
};

export const AGENT_ADAPTER_CATALOG: readonly AgentAdapterCatalogEntry[] = Object.freeze([
  Object.freeze({ id: "codex", label: "Codex" }),
  Object.freeze({ id: "claude", label: "Claude" })
]);

export function supportedAgentAdapterIds(): string[] {
  return AGENT_ADAPTER_CATALOG
    .map(({ id }) => id)
    .sort((left, right) => left.localeCompare(right));
}
