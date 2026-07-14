import type { AgentDefinition } from "../agent/agent.js";
import { listAgentDefinitions, resolveAgent } from "../agent/agentRegistry.js";
import { CliError, type CliErrorCode } from "../errors/cliError.js";
import {
  findAgentAdapter,
  inspectAgentCapabilities,
  supportedAgentAdapterIds,
  type AgentInstallation,
  type CapabilityField,
  type CapabilitySnapshot
} from "../executor/agentAdapter.js";
import { defaultTableWidth, renderTable } from "../output/table.js";
import {
  presentAgentDefinition,
  presentAgentInstallation,
  presentCapabilitySnapshot,
  publicAgentErrorDetails,
  type PublicAgentDefinition,
  type PublicAgentInstallation,
  type PublicCapabilityField
} from "../output/roleAgentPresentation.js";
import type { TaskReader } from "../storage/taskStore.js";

export type SafeAgentDefinition = PublicAgentDefinition;

export type UnsupportedAdapterInstallation = {
  status: "unsupported-adapter";
  probedAt: string;
};

export type AgentListInspection = {
  schemaVersion: 1;
  agents: Array<{
    definition: SafeAgentDefinition;
    supported: boolean;
    installation: PublicAgentInstallation | UnsupportedAdapterInstallation;
  }>;
};

export class AgentInspectionError extends CliError {
  constructor(
    code: CliErrorCode,
    message: string,
    readonly details: Readonly<Record<string, unknown>>
  ) {
    super(code, message);
    this.name = "AgentInspectionError";
  }
}

export function inspectAgentShow(id: string, store: TaskReader, now = new Date()): {
  agent: AgentDefinition;
  snapshot: CapabilitySnapshot;
} {
  const agent = resolveAgent(id, store.listConfiguredAgents());
  if (agent === null) {
    throw new AgentInspectionError("AGENT_NOT_FOUND", `Agent not found: ${id}`, publicAgentErrorDetails(id));
  }

  const adapter = findAgentAdapter(agent.adapterId);
  if (adapter === null) {
    const supportedAdapterIds = supportedAgentAdapterIds();
    throw new AgentInspectionError(
      "USAGE_ERROR",
      `Agent adapter is not supported: ${agent.adapterId}. Supported adapters: ${supportedAdapterIds.join(", ")}.`,
      { ...publicAgentErrorDetails(agent.id, agent.adapterId), supportedAdapterIds }
    );
  }

  const snapshot = inspectAgentCapabilities(agent, now);
  assertUsableInstallation(snapshot, adapter.supportedVersion);
  return { agent, snapshot };
}

export function inspectAgentList(store: TaskReader, now = new Date()): AgentListInspection {
  const definitions = listAgentDefinitions(store.listConfiguredAgents())
    .sort((left, right) => left.id.localeCompare(right.id));
  return {
    schemaVersion: 1,
    agents: definitions.map((agent) => {
      const adapter = findAgentAdapter(agent.adapterId);
      return {
        definition: safeDefinition(agent),
        supported: adapter !== null,
        installation: adapter === null
          ? unsupportedAdapterInstallation(agent, now)
          : presentAgentInstallation(adapter.probeInstallation(agent, now))
      };
    })
  };
}

export function renderAgentShow(agent: AgentDefinition, snapshot: CapabilitySnapshot): string {
  const definition = presentAgentDefinition(agent);
  const presented = presentCapabilitySnapshot(snapshot);
  const installation = presented.installation;
  const fieldRows = presented.fields.map((field) => [
    field.label,
    field.status,
    field.source,
    field.defaultPolicy,
    field.allowCustom ? "yes" : "no",
    field.allowClear ? "yes" : "no"
  ]);
  const choiceRows = presented.fields.map((field) => [
    field.label,
    renderCapabilityChoices(field),
    field.refreshedAt
  ]);
  const fields = fieldRows.length === 0
    ? "Role configuration: unavailable"
    : [
      renderTable(
        "Role configuration",
        [
          { header: "Field", minWidth: 5, maxWidth: 24 },
          { header: "Status", minWidth: 6, maxWidth: 12 },
          { header: "Source", minWidth: 6, maxWidth: 24 },
          { header: "Default policy", minWidth: 7, maxWidth: 14 },
          { header: "Custom", minWidth: 6, maxWidth: 8 },
          { header: "Clear", minWidth: 5, maxWidth: 5 }
        ],
        fieldRows,
        defaultTableWidth()
      ),
      "",
      renderTable(
        "Choices and freshness",
        [
          { header: "Field", minWidth: 5, maxWidth: 24 },
          { header: "Choices / detail", minWidth: 16, maxWidth: 64 },
          { header: "Refreshed", minWidth: 9, maxWidth: 24 }
        ],
        choiceRows,
        defaultTableWidth()
      )
    ].join("\n");
  return [
    `Agent: ${definition.id}`,
    `Source: ${definition.source}`,
    `Adapter: ${definition.adapterId}`,
    `Executable: ${definition.executable}`,
    `Arguments: ${definition.arguments}`,
    `Environment bindings: ${definition.environment.length}`,
    ...(definition.environment.length === 0 ? [] : [
      renderTable(
        "Environment",
        [
          { header: "Key", minWidth: 3, maxWidth: 32 },
          { header: "Source", minWidth: 6, maxWidth: 10 },
          { header: "Required", minWidth: 8, maxWidth: 8 },
          { header: "Value", minWidth: 8, maxWidth: 8 }
        ],
        definition.environment.map((binding) => [
          binding.key,
          binding.source,
          binding.required ? "required" : "optional",
          binding.value
        ]),
        defaultTableWidth()
      )
    ]),
    "",
    `Installation status: ${installation.status}`,
    `Version: ${installation.version ?? ""}`,
    `Refreshed: ${presented.refreshedAt}`,
    ...(presented.refreshAction === undefined ? [] : [`Action: ${presented.refreshAction}`]),
    "",
    `Lifecycle: start=${presented.lifecycle.start ? "yes" : "no"}, resume=${presented.lifecycle.resume ? "yes" : "no"}, session=${presented.lifecycle.nativeSessionDiscovery}, interrupt=${presented.lifecycle.interrupt ? "yes" : "no"}`,
    "",
    fields
  ].join("\n").concat("\n");
}

export function renderAgentList(inspection: AgentListInspection): string {
  if (inspection.agents.length === 0) {
    return "No agents configured.\n";
  }
  return `${renderTable(
    "Agents",
    [
      { header: "Agent", minWidth: 5, maxWidth: 24 },
      { header: "Source", minWidth: 6, maxWidth: 12 },
      { header: "Adapter", minWidth: 7, maxWidth: 16 },
      { header: "Args", minWidth: 6, maxWidth: 18 },
      { header: "Env", minWidth: 3, maxWidth: 5 },
      { header: "Status", minWidth: 9, maxWidth: 20 }
    ],
    inspection.agents.map(({ definition, installation }) => [
      definition.id,
      definition.source,
      definition.adapterId,
      definition.arguments,
      String(definition.environment.length),
      installationLabel(installation.status)
    ]),
    defaultTableWidth()
  )}\n`;
}

function assertUsableInstallation(snapshot: CapabilitySnapshot, supportedVersion: string): void {
  const { installation } = snapshot;
  if (installation.status === "installed") {
    return;
  }
  const details = {
    agentId: snapshot.agentId,
    installation: presentAgentInstallation(installation)
  };
  switch (installation.status) {
    case "missing":
      throw new AgentInspectionError(
        "DATA_ERROR",
        `Agent is not installed: ${snapshot.agentId}.`,
        details
      );
    case "unsupported-version":
      throw new AgentInspectionError(
        "DATA_ERROR",
        `Agent CLI version is unsupported: ${snapshot.agentId} (detected ${installation.version ?? "unknown"}; supported ${supportedVersion}).`,
        details
      );
    case "probe-failed":
      throw new AgentInspectionError(
        "DATA_ERROR",
        `Agent installation probe failed: ${snapshot.agentId}.`,
        details
      );
    case "unsafe-output":
      throw new AgentInspectionError(
        "DATA_ERROR",
        `Agent capability inspection failed security validation: ${snapshot.agentId}.`,
        details
      );
    case "unavailable":
      throw new AgentInspectionError(
        "DATA_ERROR",
        `Agent live capability inspection is unavailable: ${snapshot.agentId}.`,
        details
      );
    case "refresh-required":
      return;
  }
}

function safeDefinition(agent: AgentDefinition): SafeAgentDefinition {
  return presentAgentDefinition(agent);
}

function unsupportedAdapterInstallation(agent: AgentDefinition, now: Date): UnsupportedAdapterInstallation {
  return {
    status: "unsupported-adapter",
    probedAt: now.toISOString()
  };
}

function renderCapabilityChoices(field: PublicCapabilityField): string {
  if (field.choices !== undefined) {
    return appendUnavailableReason(
      field,
      field.choices.map((choice) => `${choice.value}${choice.available ? "" : " (unavailable)"}`).join(", ")
    );
  }
  if (field.choicesByModel !== undefined) {
    return appendUnavailableReason(field, Object.entries(field.choicesByModel)
      .map(([model, choices]) => {
        const defaultValue = field.defaultByModel?.[model];
        return `${model}: ${choices.map((choice) => `${choice.value}${choice.available ? "" : " (unavailable)"}`).join(", ")}${defaultValue === undefined ? "" : ` (default: ${defaultValue})`}`;
      })
      .join("; "));
  }
  return appendUnavailableReason(field, "custom value");
}

function appendUnavailableReason(_field: PublicCapabilityField, choices: string): string {
  return choices;
}

function installationLabel(status: AgentListInspection["agents"][number]["installation"]["status"]): string {
  switch (status) {
    case "installed": return "Installed";
    case "missing": return "Missing";
    case "unsupported-version": return "Unsupported version";
    case "probe-failed": return "Probe failed";
    case "unsupported-adapter": return "Unsupported adapter";
    case "unsafe-output": return "Unsafe probe output";
    case "unavailable": return "Live probe unavailable";
    case "refresh-required": return "Refresh required";
  }
}
