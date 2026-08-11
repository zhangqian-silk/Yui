import {
  configurationField,
  defaultModel,
  modelChoice,
  type AgentConfigurationChoice,
  type AgentModelChoice,
  type ResolvedAgentConfigurationCatalog
} from "../executor/agentConfigurationCatalog.js";
import type {
  ClaudePermissionConfig,
  CodexPermissionConfig,
  RoleAgentConfig
} from "../executor/agentAdapter.js";
import { renderTable, type TableColumn } from "../output/table.js";
import type { SelectionIo } from "./interactiveSelection.js";

export type AgentModelEffortSelection =
  | Readonly<{ kind: "cancelled" }>
  | Readonly<{ kind: "selected"; model: string | undefined; effort: string | undefined }>;

export type AgentEffortSelection =
  | Readonly<{ kind: "cancelled" }>
  | Readonly<{ kind: "selected"; effort: string | undefined }>;

export type AgentPermissionSelection =
  | Readonly<{ kind: "cancelled" }>
  | Readonly<{ kind: "selected"; permission: RoleAgentConfig["permission"] }>;

type PickerChoice = Readonly<{
  value: string;
  label: string;
  detail: string;
  aliases?: readonly string[];
}>;

const DEFAULT = "\0yui:cli-default";
const CUSTOM = "\0yui:custom";
const OMIT = "\0yui:omit";
const COLUMNS: readonly TableColumn[] = [
  { header: "Value", minWidth: 12, maxWidth: 34 },
  { header: "Details", minWidth: 16, maxWidth: 52 }
];

export async function selectAgentModelAndEffort(
  resolved: ResolvedAgentConfigurationCatalog,
  io: SelectionIo,
  current: Readonly<{ currentModel?: string; currentEffort?: string }>
): Promise<AgentModelEffortSelection> {
  renderResolutionNotice(resolved, io);
  const model = await selectModel(resolved, io, current.currentModel);
  if (model === null) return { kind: "cancelled" };
  const record = modelChoice(resolved.catalog, model);
  const currentEffort = model === current.currentModel
    ? current.currentEffort
    : undefined;
  const effort = await selectEffortValue(
    resolved,
    io,
    model,
    record,
    currentEffort
  );
  return effort.cancelled
    ? { kind: "cancelled" }
    : { kind: "selected", model, effort: effort.value };
}

export async function selectAgentEffort(
  resolved: ResolvedAgentConfigurationCatalog,
  io: SelectionIo,
  input: Readonly<{ model?: string; currentEffort?: string }>
): Promise<AgentEffortSelection> {
  renderResolutionNotice(resolved, io);
  const effort = await selectEffortValue(
    resolved,
    io,
    input.model,
    modelChoice(resolved.catalog, input.model),
    input.currentEffort
  );
  return effort.cancelled
    ? { kind: "cancelled" }
    : { kind: "selected", effort: effort.value };
}

/** Select provider-native permission settings in the adapter's canonical shape. */
export async function selectAgentPermission(
  resolved: ResolvedAgentConfigurationCatalog,
  io: SelectionIo,
  current: RoleAgentConfig["permission"]
): Promise<AgentPermissionSelection> {
  const strategyField = configurationField(resolved.catalog, "permission.strategy");
  const strategyChoices = uniqueChoices(
    strategyField?.choices ?? [
      { value: "default", label: "default" },
      { value: "bypass", label: "bypass" },
      { value: "configured", label: "configured" }
    ],
    current.strategy
  );
  const strategy = await choose(
    "Select permission strategy",
    strategyChoices.map(({ value, label, description }) => ({
      value,
      label,
      detail: description ?? value
    })),
    io,
    current.strategy,
    "permission strategy"
  );
  if (strategy === undefined) return { kind: "cancelled" };
  if (strategy === "default" || strategy === "bypass") {
    return { kind: "selected", permission: { strategy } };
  }

  if (resolved.catalog.adapterId === "codex") {
    const codex = current.strategy === "configured" && "sandbox" in current
      ? current as Extract<CodexPermissionConfig, { strategy: "configured" }>
      : undefined;
    const sandbox = await selectPermissionField(
      resolved,
      io,
      "permission.sandbox",
      codex?.sandbox,
      codex === undefined ? "workspace-write" : OMIT
    );
    if (sandbox.kind === "cancelled") return sandbox;
    const approval = await selectPermissionField(
      resolved,
      io,
      "permission.approval",
      codex?.approval,
      codex === undefined ? "on-request" : OMIT
    );
    if (approval.kind === "cancelled") return approval;
    const permission: CodexPermissionConfig = {
      strategy: "configured",
      ...(sandbox.value === undefined ? {} : {
        sandbox: sandbox.value as Extract<CodexPermissionConfig, { strategy: "configured" }>["sandbox"]
      }),
      ...(approval.value === undefined ? {} : {
        approval: approval.value as Extract<CodexPermissionConfig, { strategy: "configured" }>["approval"]
      })
    };
    return { kind: "selected", permission };
  }

  const claude = current.strategy === "configured" && "mode" in current
    ? current as Extract<ClaudePermissionConfig, { strategy: "configured" }>
    : undefined;
  const mode = await selectPermissionField(
    resolved,
    io,
    "permission.mode",
    claude?.mode,
    claude === undefined ? undefined : OMIT
  );
  if (mode.kind === "cancelled") return mode;
  const permission: ClaudePermissionConfig = {
    strategy: "configured",
    ...(mode.value === undefined ? {} : { mode: mode.value })
  };
  return { kind: "selected", permission };
}

export function renderAgentConfigurationResolutionNotice(
  resolved: ResolvedAgentConfigurationCatalog
): string {
  const lines: string[] = [];
  if (resolved.source === "cache") {
    lines.push(
      `! Runtime capability request failed (${resolved.failure?.message ?? "unknown failure"}). `
      + `Showing cached options from ${resolved.fetchedAt ?? "an earlier request"}; they may be stale.`
    );
  } else if (resolved.source === "fallback") {
    lines.push(
      `! Runtime capability request failed (${resolved.failure?.message ?? "unknown failure"}). `
      + "No matching cache is available; only fallback and custom values can be offered."
    );
  }
  lines.push(...resolved.catalog.warnings.map((warning) => `! Agent catalog warning: ${warning}`));
  return lines.length === 0 ? "" : `${lines.join("\n")}\n`;
}

async function selectModel(
  resolved: ResolvedAgentConfigurationCatalog,
  io: SelectionIo,
  current: string | undefined
): Promise<string | undefined | null> {
  const catalogDefault = defaultModel(resolved.catalog);
  const choices: PickerChoice[] = [
    {
      value: DEFAULT,
      label: "CLI default",
      detail: catalogDefault === undefined
        ? "Follow the Agent CLI default"
        : `${catalogDefault.label}${catalogDefault.resolvedModel === undefined
          ? "" : ` (${catalogDefault.resolvedModel})`}`,
      aliases: ["default"]
    },
    ...resolved.catalog.models.map((model) => ({
      value: model.value,
      label: model.label,
      detail: [
        model.description ?? model.value,
        model.isDefault ? "Reported CLI default model" : undefined
      ].filter((part) => part !== undefined).join("; ")
    })),
    ...(current === undefined || resolved.catalog.models.some((model) => model.value === current)
      ? []
      : [{ value: current, label: current, detail: "Current value; not reported by this catalog" }]),
    {
      value: CUSTOM,
      label: "Custom…",
      detail: "Enter another model value",
      aliases: ["custom"]
    }
  ];
  const selected = await choose(
    "Select model",
    choices,
    io,
    current === undefined ? DEFAULT : current,
    "model"
  );
  if (selected === undefined) return null;
  if (selected === DEFAULT) return undefined;
  if (selected !== CUSTOM) return selected;
  const custom = (await io.question("Custom model: "))?.trim();
  return custom === undefined || custom.length === 0 ? null : custom;
}

async function selectEffortValue(
  resolved: ResolvedAgentConfigurationCatalog,
  io: SelectionIo,
  model: string | undefined,
  record: AgentModelChoice | undefined,
  current: string | undefined
): Promise<Readonly<{ cancelled: boolean; value?: string }>> {
  const customModel = record === undefined && model !== undefined;
  const efforts = customModel
    ? observedEfforts(resolved.catalog.models)
    : record?.efforts ?? [];
  if (!customModel && record !== undefined && efforts.length === 0) {
    io.write(`○ ${record.label} does not report configurable reasoning effort; using CLI default.\n`);
    return { cancelled: false };
  }
  const choices: PickerChoice[] = [
    {
      value: DEFAULT,
      label: "CLI default",
      detail: record?.defaultEffort === undefined
        ? "Follow the selected model default"
        : record.defaultEffort,
      aliases: ["default"]
    },
    ...efforts.map((effort) => ({
      value: effort.value,
      label: effort.label,
      detail: customModel
        ? "Observed for another model; compatibility is unverified"
        : effort.description ?? "Supported by selected model"
    })),
    ...(current === undefined || efforts.some((effort) => effort.value === current)
      ? []
      : [{ value: current, label: current, detail: "Current value; not reported for selected model" }]),
    ...(!customModel && record !== undefined && record.efforts.length === 0
      ? []
      : [{
          value: CUSTOM,
          label: "Custom…",
          detail: "Enter another effort value",
          aliases: ["custom"]
        }])
  ];
  const selected = await choose(
    "Select reasoning effort",
    choices,
    io,
    current === undefined ? DEFAULT : current,
    "effort"
  );
  if (selected === undefined) return { cancelled: true };
  if (selected === DEFAULT) return { cancelled: false };
  if (selected !== CUSTOM) return { cancelled: false, value: selected };
  const custom = (await io.question("Custom reasoning effort: "))?.trim();
  return custom === undefined || custom.length === 0
    ? { cancelled: true }
    : { cancelled: false, value: custom };
}

function observedEfforts(models: readonly AgentModelChoice[]): AgentConfigurationChoice[] {
  const observed = new Map<string, AgentConfigurationChoice>();
  for (const effort of models.flatMap((model) => model.efforts)) {
    if (!observed.has(effort.value)) observed.set(effort.value, effort);
  }
  return [...observed.values()];
}

type PermissionFieldSelection =
  | Readonly<{ kind: "cancelled" }>
  | Readonly<{ kind: "selected"; value: string | undefined }>;

async function selectPermissionField(
  resolved: ResolvedAgentConfigurationCatalog,
  io: SelectionIo,
  key: string,
  current: string | undefined,
  defaultValue: string | typeof OMIT | undefined
): Promise<PermissionFieldSelection> {
  const field = configurationField(resolved.catalog, key);
  const fallback = key === "permission.sandbox"
    ? ["read-only", "workspace-write", "danger-full-access"]
    : key === "permission.approval"
      ? ["untrusted", "on-request", "never"]
      : ["acceptEdits", "auto", "bypassPermissions", "manual", "dontAsk", "plan"];
  const choices = uniqueChoices(
    field === undefined
      ? fallback.map((value) => ({ value, label: value }))
      : field.choices,
    current
  );
  const includeOmit = defaultValue === OMIT || current !== undefined;
  const pickerChoices: PickerChoice[] = [
    ...(includeOmit
      ? [{ value: OMIT, label: "Omit", detail: "Do not pass this provider option" }]
      : []),
    ...choices.map(({ value, label, description }) => ({
      value,
      label,
      detail: description ?? value
    })),
    ...(field?.allowCustom === true
      ? [{ value: CUSTOM, label: "Custom…", detail: "Enter another provider value" }]
      : [])
  ];
  const selected = await choose(
    `Select ${key}`,
    pickerChoices,
    io,
    current ?? defaultValue ?? pickerChoices[0]?.value ?? OMIT,
    key
  );
  if (selected === undefined) return { kind: "cancelled" };
  if (selected === OMIT) return { kind: "selected", value: undefined };
  if (selected === CUSTOM) {
    const custom = (await io.question(`Custom ${key}: `))?.trim();
    return custom === undefined || custom.length === 0
      ? { kind: "cancelled" }
      : { kind: "selected", value: custom };
  }
  return { kind: "selected", value: selected };
}

function uniqueChoices(
  choices: readonly AgentConfigurationChoice[],
  current: string | undefined
): AgentConfigurationChoice[] {
  const seen = new Set<string>();
  const result: AgentConfigurationChoice[] = [];
  for (const choice of choices) {
    if (seen.has(choice.value)) continue;
    seen.add(choice.value);
    result.push(choice);
  }
  if (current !== undefined && !seen.has(current)) {
    result.push({
      value: current,
      label: current,
      description: "Current value; not reported by this catalog"
    });
  }
  return result;
}

function renderResolutionNotice(
  resolved: ResolvedAgentConfigurationCatalog,
  io: SelectionIo
): void {
  const notice = renderAgentConfigurationResolutionNotice(resolved);
  if (notice.length > 0) io.write(notice);
}

async function choose(
  title: string,
  choices: readonly PickerChoice[],
  io: SelectionIo,
  defaultValue: string,
  label: string
): Promise<string | undefined> {
  io.write(`${renderTable(
    title,
    [{ header: "#", minWidth: 1, maxWidth: 4 }, ...COLUMNS],
    choices.map((choice, index) => [
      String(index + 1),
      choice.label,
      choice.detail
    ]),
    io.width
  )}\n\n`);
  const defaultLabel = choices.find((choice) => choice.value === defaultValue)?.label
    ?? defaultValue;
  const answer = (await io.question(
    `Choose ${label} [1-${choices.length}/value, q; default ${defaultLabel}]: `
  ))?.trim();
  if (answer === undefined || answer.toLowerCase() === "q" || answer.toLowerCase() === "quit") {
    return undefined;
  }
  if (answer.length === 0) {
    return choices.some((choice) => choice.value === defaultValue)
      ? defaultValue
      : choices[0]?.value;
  }
  const numeric = Number(answer);
  if (Number.isSafeInteger(numeric) && numeric >= 1 && numeric <= choices.length) {
    return choices[numeric - 1]?.value;
  }
  return choices.find((choice) => choice.value === answer)?.value
    ?? choices.find((choice) => choice.aliases?.includes(answer) === true)?.value
    ?? (choices.some((choice) => choice.value === CUSTOM) ? answer : undefined);
}
