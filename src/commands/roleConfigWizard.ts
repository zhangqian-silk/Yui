import type { AgentDefinition } from "../agent/agent.js";
import { findAgentAdapter, isUnprobedCustomAgent } from "../executor/agentAdapter.js";
import type { CapabilityChoice, CapabilityField, CapabilitySnapshot } from "../executor/agentAdapter.js";
import { usageError } from "../errors/cliError.js";
import type { RoleAgentConfig } from "../role/role.js";
import type {
  RoleConfigWizardDependencies,
  RoleConfigWizardInput,
  RoleConfigWizardResult,
  RoleConfigWizardSelection
} from "./roleWizardTypes.js";

export type {
  RoleConfigWizardDependencies,
  RoleConfigWizardInput,
  RoleConfigWizardResult,
  RoleConfigWizardSelection
} from "./roleWizardTypes.js";

type InspectedAgent = {
  agent: AgentDefinition;
  snapshot: CapabilitySnapshot;
};

type PromptResult<T> = { cancelled: true } | { cancelled: false; value: T };
type FieldValue = string | boolean | string[];

const CANCELLED: RoleConfigWizardResult = {
  status: "cancelled",
  message: "Role configuration cancelled.\n"
};

export async function runRoleConfigWizard(
  input: RoleConfigWizardInput,
  dependencies: RoleConfigWizardDependencies
): Promise<RoleConfigWizardResult> {
  const inspected = await Promise.all(input.agents.map(async (agent) => ({
    agent,
    snapshot: findAgentAdapter(agent.adapterId) === null
      ? unavailableSnapshot(agent, `Agent adapter is not supported: ${agent.adapterId}.`)
      : await inspectFresh(agent, dependencies.inspectCapabilities)
  })));
  const selectable = inspected.filter(isSelectableCandidate);
  if (selectable.length === 0) {
    throw usageError("No installed first-class Agents are available for Role configuration.");
  }

  const defaultAgent = selectDefaultAgent(input, selectable);
  let selected: InspectedAgent;
  let agentSelectionError: string | undefined;
  while (true) {
    const agentResult = await askAgent(inspected, defaultAgent, dependencies.question, agentSelectionError);
    if (agentResult.cancelled) return CANCELLED;

    const candidate = inspected.find(({ agent }) => agent.id === agentResult.value);
    if (candidate === undefined || !isSelectableCandidate(candidate)) {
      throw usageError(`Selected Agent is not available for Role configuration: ${agentResult.value}.`);
    }
    try {
      await dependencies.validateAgentSelection?.({ agent: candidate.agent, snapshot: candidate.snapshot });
      selected = candidate;
      break;
    } catch (error) {
      agentSelectionError = error instanceof Error
        ? error.message
        : "The existing Role options are not valid for the selected Agent.";
    }
  }

  const current = currentConfig(input, selected.agent);
  let coreConfig = { adapterId: selected.agent.adapterId } as RoleAgentConfig;
  const orderedFields = orderFields(selected.snapshot.fields);
  const coreFields = orderedFields.filter(isCoreField);
  const advancedFields = orderedFields.filter((field) => !isCoreField(field));
  const initialCore = await configureCoreFields(
    coreFields,
    current,
    coreConfig,
    selected,
    dependencies
  );
  if (initialCore.cancelled) return CANCELLED;
  coreConfig = initialCore.config;
  let selectedModel = initialCore.selectedModel;

  let advancedCurrent = current;
  let validationError: string | undefined;
  while (true) {
    const config = cloneConfig(coreConfig);
    const advancedResult = await askYesNo(
      [
        ...(validationError === undefined ? [] : [`Validation failed: ${validationError}`, "Correct the configuration and try again."]),
        ...advancedUnavailableNotices(advancedFields, advancedCurrent, selectedModel),
        `Configure Advanced options? [${validationError === undefined ? "y/N" : "Y/n"}] (or cancel): `
      ].join("\n"),
      validationError !== undefined,
      dependencies.question
    );
    if (advancedResult.cancelled) return CANCELLED;
    if (advancedResult.value) {
      for (const field of advancedFields) {
        const result = await askField({
          field,
          current: readPath(advancedCurrent, field.key),
          selectedModel,
          agent: selected.agent,
          snapshot: selected.snapshot,
          currentConfig: advancedCurrent,
          draftConfig: config,
          dependencies
        });
        if (result.cancelled) return CANCELLED;
        if (result.value === undefined) deleteConfigValue(config, field.key);
        else setConfigValue(config, field.key, result.value);
      }
      const rawArgsResult = await askRawArguments(readAdvancedRawArgs(advancedCurrent), dependencies.question);
      if (rawArgsResult.cancelled) return CANCELLED;
      if (rawArgsResult.value === undefined) deleteConfigValue(config, "advanced.rawArgs");
      else setConfigValue(config, "advanced.rawArgs", rawArgsResult.value);
    } else {
      await preserveCollapsedAdvanced(config, advancedCurrent, advancedFields, selected, dependencies);
    }

    const selection: RoleConfigWizardSelection = {
      agentId: selected.agent.id,
      adapterId: selected.agent.adapterId,
      config
    };
    try {
      await dependencies.validateSelection?.({
        agent: selected.agent,
        snapshot: selected.snapshot,
        selection
      });
    } catch (error) {
      const message = error instanceof Error
        ? error.message
        : "Role configuration is not valid for the selected Agent.";
      const retry = await askRetrySection(message, dependencies.question);
      if (retry.cancelled) return CANCELLED;
      if (retry.value === "core") {
        const revised = await configureCoreFields(
          coreFields,
          config,
          config,
          selected,
          dependencies
        );
        if (revised.cancelled) return CANCELLED;
        coreConfig = revised.config;
        selectedModel = revised.selectedModel;
        advancedCurrent = cloneConfig(config);
        validationError = undefined;
      } else {
        validationError = message;
        advancedCurrent = cloneConfig(config);
      }
      continue;
    }
    const summary = renderSummary(input.roleName, selection, current);
    const confirmResult = await askYesNo(`${summary}Apply this Role configuration? [Y/n] (or cancel): `, true, dependencies.question);
    if (confirmResult.cancelled || !confirmResult.value) return CANCELLED;

    return { status: "selected", selection, summary };
  }
}

async function configureCoreFields(
  fields: CapabilityField[],
  current: RoleAgentConfig | undefined,
  base: RoleAgentConfig,
  selected: InspectedAgent,
  dependencies: RoleConfigWizardDependencies
): Promise<
  | { cancelled: true }
  | { cancelled: false; config: RoleAgentConfig; selectedModel: string | undefined }
> {
  const config = cloneConfig(base);
  let selectedModel = typeof readPath(current, "model") === "string"
    ? readPath(current, "model") as string
    : undefined;
  for (const field of fields) {
    const result = await askField({
      field,
      current: readPath(current, field.key),
      selectedModel,
      agent: selected.agent,
      snapshot: selected.snapshot,
      currentConfig: current,
      draftConfig: config,
      dependencies
    });
    if (result.cancelled) return { cancelled: true };
    if (result.value === undefined) deleteConfigValue(config, field.key);
    else setConfigValue(config, field.key, result.value);
    if (field.key === "model") selectedModel = typeof result.value === "string" ? result.value : undefined;
  }
  return { cancelled: false, config, selectedModel };
}

async function askRetrySection(
  message: string,
  question: RoleConfigWizardDependencies["question"]
): Promise<PromptResult<"core" | "advanced">> {
  const prompt = [
    `Validation failed: ${message}`,
    "1. Revise model, effort, and permission fields",
    "2. Revise Advanced fields",
    "Choose section [1] (or cancel): "
  ].join("\n");
  while (true) {
    const answer = (await question(prompt)).trim();
    if (isCancel(answer)) return { cancelled: true };
    if (answer.length === 0 || /^(?:1|core)$/i.test(answer)) return { cancelled: false, value: "core" };
    if (/^(?:2|advanced)$/i.test(answer)) return { cancelled: false, value: "advanced" };
  }
}

async function inspectFresh(
  agent: AgentDefinition,
  inspect: RoleConfigWizardDependencies["inspectCapabilities"]
): Promise<CapabilitySnapshot> {
  try {
    return await inspect(agent);
  } catch {
    return unavailableSnapshot(agent, "Capability inspection failed.");
  }
}

function unavailableSnapshot(agent: AgentDefinition, reason: string): CapabilitySnapshot {
  const refreshedAt = new Date().toISOString();
  return {
    schemaVersion: 1,
    agentId: agent.id,
    adapterId: agent.adapterId,
    installation: {
      status: "probe-failed",
      command: agent.command,
      reason,
      probedAt: refreshedAt
    },
    lifecycle: { start: false, resume: false, nativeSessionDiscovery: "none", interrupt: false },
    fields: [],
    warnings: [reason],
    refreshedAt
  };
}

function selectDefaultAgent(input: RoleConfigWizardInput, selectable: InspectedAgent[]): string {
  const requested = input.currentAgentId ?? input.defaultAgentId;
  if (requested !== undefined && selectable.some(({ agent }) => agent.id === requested)) return requested;
  return selectable[0].agent.id;
}

async function askAgent(
  inspected: InspectedAgent[],
  defaultAgentId: string,
  question: RoleConfigWizardDependencies["question"],
  validationError?: string
): Promise<PromptResult<string>> {
  const lines = inspected.map(({ agent, snapshot }, index) => {
    const current = agent.id === defaultAgentId ? " (default)" : "";
    const status = candidateStatus(agent, snapshot);
    return `${index + 1}. ${agent.id} | ${agent.adapterId} | ${status}${current}`;
  });
  const prompt = [
    ...(validationError === undefined ? [] : [`Cannot use selected Agent: ${validationError}`, "Choose another Agent."]),
    "Role Agent candidates",
    "# | Agent | Adapter | Status",
    ...lines,
    `Choose Agent by number or name [${defaultAgentId}] (or cancel): `
  ].join("\n");

  while (true) {
    const answer = (await question(prompt)).trim();
    if (isCancel(answer)) return { cancelled: true };
    const value = answer.length === 0
      ? defaultAgentId
      : inspected[parseOneBasedIndex(answer, inspected.length)]?.agent.id ?? answer;
    const selected = inspected.find(({ agent }) => agent.id.toLocaleLowerCase() === value.toLocaleLowerCase());
    if (selected !== undefined && isSelectableCandidate(selected)) {
      return { cancelled: false, value: selected.agent.id };
    }
  }
}

function isSelectableCandidate(candidate: InspectedAgent): boolean {
  return findAgentAdapter(candidate.agent.adapterId) !== null &&
    (candidate.snapshot.installation.status === "installed" ||
      isUnprobedCustomAgent(candidate.agent, candidate.snapshot));
}

function candidateStatus(agent: AgentDefinition, snapshot: CapabilitySnapshot): string {
  if (findAgentAdapter(agent.adapterId) === null) return "unsupported-adapter";
  if (isUnprobedCustomAgent(agent, snapshot)) return "unavailable (unverified)";
  return snapshot.installation.status;
}

type AskFieldInput = {
  field: CapabilityField;
  current: unknown;
  selectedModel: string | undefined;
  agent: AgentDefinition;
  snapshot: CapabilitySnapshot;
  currentConfig: RoleAgentConfig | undefined;
  draftConfig: RoleAgentConfig;
  dependencies: RoleConfigWizardDependencies;
};

async function askField(input: AskFieldInput): Promise<PromptResult<FieldValue | undefined>> {
  const { field } = input;
  const choices = availableChoices(field, input.selectedModel);
  const current = normalizeFieldValue(field.kind, input.current);
  const currentAvailable = current === undefined || fieldValueIsAvailable(field, choices, current);
  const canKeepUnavailable = current !== undefined && !currentAvailable
    ? await mayKeepUnavailable(input, current)
    : false;

  switch (field.kind) {
    case "enum":
      return askEnum(field, choices, current, currentAvailable, canKeepUnavailable, input.dependencies.question);
    case "boolean":
      return askBoolean(field, choices, current, currentAvailable, canKeepUnavailable, input.dependencies.question);
    case "string":
    case "path":
      return askScalar(field, current, currentAvailable, canKeepUnavailable, input.dependencies.question);
    case "string-list":
    case "path-list":
      return askStringList(
        field.label,
        Array.isArray(current) ? current : undefined,
        choices,
        field.allowCustom && field.status !== "unavailable",
        input.dependencies.question,
        currentAvailable,
        canKeepUnavailable
      );
  }
}

async function askEnum(
  field: CapabilityField,
  choices: CapabilityChoice[],
  current: FieldValue | undefined,
  currentAvailable: boolean,
  canKeepUnavailable: boolean,
  question: RoleConfigWizardDependencies["question"]
): Promise<PromptResult<FieldValue | undefined>> {
  const currentString = typeof current === "string" ? current : undefined;
  const defaultValue = currentAvailable ? currentString : canKeepUnavailable ? currentString : undefined;
  const allowCustom = field.allowCustom && field.status !== "unavailable";
  const keepIndex = canKeepUnavailable ? choices.length + 2 : undefined;
  const customIndex = allowCustom ? choices.length + 2 + (canKeepUnavailable ? 1 : 0) : undefined;
  const optionLines = [
    "1. Inherit CLI default",
    ...choices.map((choice, index) => `${index + 2}. ${choice.label}`),
    ...(keepIndex === undefined ? [] : [`${keepIndex}. Keep current unavailable value: ${currentString}`]),
    ...(customIndex === undefined ? [] : [`${customIndex}. Custom value`])
  ];
  const prompt = fieldPrompt(field, optionLines, current, currentAvailable, canKeepUnavailable, defaultValue);

  while (true) {
    const answer = (await question(prompt)).trim();
    if (isCancel(answer)) return { cancelled: true };
    if (answer.length === 0) return { cancelled: false, value: defaultValue };
    if (/^(?:1|inherit|default)$/i.test(answer)) return { cancelled: false, value: undefined };
    if (/^keep$/i.test(answer) && canKeepUnavailable) return { cancelled: false, value: currentString };
    const numeric = Number(answer);
    if (/^\d+$/.test(answer) && numeric >= 2 && numeric <= choices.length + 1) {
      return { cancelled: false, value: choices[numeric - 2].value };
    }
    if (keepIndex !== undefined && numeric === keepIndex) return { cancelled: false, value: currentString };
    if (customIndex !== undefined && numeric === customIndex) {
      const custom = (await question(`Enter custom ${field.label} (or cancel): `)).trim();
      if (isCancel(custom)) return { cancelled: true };
      if (custom.length > 0) return { cancelled: false, value: custom };
      continue;
    }
    const named = findChoice(choices, answer);
    if (named !== undefined) return { cancelled: false, value: named.value };
    if (allowCustom && answer.length > 0) return { cancelled: false, value: answer };
  }
}

async function askBoolean(
  field: CapabilityField,
  choices: CapabilityChoice[],
  current: FieldValue | undefined,
  currentAvailable: boolean,
  canKeepUnavailable: boolean,
  question: RoleConfigWizardDependencies["question"]
): Promise<PromptResult<FieldValue | undefined>> {
  const currentBoolean = typeof current === "boolean" ? current : undefined;
  const defaultValue = currentAvailable ? currentBoolean : canKeepUnavailable ? currentBoolean : undefined;
  const booleanChoices = choices.flatMap((choice) => {
    if (choice.value === "true") return [{ choice, value: true }];
    if (choice.value === "false") return [{ choice, value: false }];
    return [];
  });
  const keepIndex = canKeepUnavailable ? booleanChoices.length + 2 : undefined;
  const prompt = fieldPrompt(
    field,
    [
      "1. Inherit CLI default",
      ...booleanChoices.map(({ choice }, index) => `${index + 2}. ${choice.label}`),
      ...(keepIndex === undefined ? [] : [`${keepIndex}. Keep current unavailable value: ${currentBoolean}`])
    ],
    current,
    currentAvailable,
    canKeepUnavailable,
    defaultValue
  );
  while (true) {
    const answer = (await question(prompt)).trim();
    if (isCancel(answer)) return { cancelled: true };
    if (answer.length === 0) return { cancelled: false, value: defaultValue };
    if (/^(?:1|inherit|default)$/i.test(answer)) return { cancelled: false, value: undefined };
    const numeric = /^\d+$/.test(answer) ? Number(answer) : NaN;
    if (numeric >= 2 && numeric <= booleanChoices.length + 1) {
      return { cancelled: false, value: booleanChoices[numeric - 2].value };
    }
    const normalizedAnswer = /^(?:y|yes|on)$/i.test(answer)
      ? "true"
      : /^(?:n|no|off)$/i.test(answer) ? "false" : answer.toLocaleLowerCase();
    const named = booleanChoices.find(({ choice }) => choiceMatches(choice, normalizedAnswer));
    if (named !== undefined) return { cancelled: false, value: named.value };
    if ((/^keep$/i.test(answer) || numeric === keepIndex) && canKeepUnavailable) {
      return { cancelled: false, value: currentBoolean };
    }
  }
}

async function askScalar(
  field: CapabilityField,
  current: FieldValue | undefined,
  currentAvailable: boolean,
  canKeepUnavailable: boolean,
  question: RoleConfigWizardDependencies["question"]
): Promise<PromptResult<FieldValue | undefined>> {
  const currentString = typeof current === "string" ? current : undefined;
  const defaultValue = currentAvailable ? currentString : canKeepUnavailable ? currentString : undefined;
  const prompt = fieldPrompt(
    field,
    ["1. Inherit CLI default", ...(canKeepUnavailable ? [`2. Keep current unavailable value: ${currentString}`] : [])],
    current,
    currentAvailable,
    canKeepUnavailable,
    defaultValue
  ).replace(`Choose ${field.label}`, `Enter ${field.label}`);
  while (true) {
    const answer = (await question(prompt)).trim();
    if (isCancel(answer)) return { cancelled: true };
    if (answer.length === 0) return { cancelled: false, value: defaultValue };
    if (/^(?:1|inherit|default)$/i.test(answer)) return { cancelled: false, value: undefined };
    if (/^(?:2|keep)$/i.test(answer) && canKeepUnavailable) return { cancelled: false, value: currentString };
    if (field.status !== "unavailable" && field.allowCustom) return { cancelled: false, value: answer };
  }
}

function availableChoices(field: CapabilityField, selectedModel: string | undefined): CapabilityChoice[] {
  if (field.status === "unavailable") return [];
  const choices = field.choicesByModel === undefined
    ? field.choices
    : selectedModel === undefined
      ? undefined
      : field.choicesByModel[selectedModel];
  return (choices ?? []).filter((choice) => choice.available);
}

function fieldValueIsAvailable(field: CapabilityField, choices: CapabilityChoice[], current: FieldValue): boolean {
  if (field.status === "unavailable") return false;
  if (typeof current === "boolean") return choices.some((choice) => choice.value === String(current));
  if (Array.isArray(current)) {
    if (field.allowCustom) return true;
    return current.every((value) => choices.some((choice) => choice.value === value));
  }
  if (field.kind === "string" || field.kind === "path") return field.allowCustom;
  if (field.allowCustom) return true;
  return choices.some((choice) => choice.value === current);
}

async function askStringList(
  label: string,
  current: string[] | undefined,
  choices: CapabilityChoice[],
  allowCustom: boolean,
  question: RoleConfigWizardDependencies["question"],
  currentAvailable = true,
  canKeepUnavailable = false
): Promise<PromptResult<string[] | undefined>> {
  const currentValue = current?.join(", ");
  const defaultValue = currentAvailable || canKeepUnavailable ? current : undefined;
  const prompt = [
    label,
    "1. Inherit CLI default",
    ...choices.map((choice, index) => `${index + 2}. ${choice.label}`),
    ...(currentValue === undefined
      ? []
      : currentAvailable
        ? [`Current: ${currentValue}`]
        : [
          `Current unavailable: ${currentValue}; ${canKeepUnavailable ? "Keep is adapter-safe." : "choose a replacement or inherit CLI default."}`,
          ...(canKeepUnavailable ? [`${choices.length + 2}. Keep current unavailable value: ${currentValue}`] : [])
        ]),
    `Enter comma-separated values [${defaultValue?.join(", ") ?? "inherit"}] (or cancel): `
  ].join("\n");
  while (true) {
    const answer = (await question(prompt)).trim();
    if (isCancel(answer)) return { cancelled: true };
    if (answer.length === 0) return { cancelled: false, value: defaultValue };
    if (/^(?:1|inherit|default)$/i.test(answer)) return { cancelled: false, value: undefined };
    if ((/^keep$/i.test(answer) || Number(answer) === choices.length + 2) && canKeepUnavailable) {
      return { cancelled: false, value: current };
    }
    const values = answer.split(",").map((value) => value.trim()).filter(Boolean).map((value) => {
      const numeric = /^\d+$/.test(value) ? Number(value) : NaN;
      if (numeric >= 2 && numeric <= choices.length + 1) return choices[numeric - 2].value;
      return findChoice(choices, value)?.value ?? value;
    });
    if (values.length > 0 && (allowCustom || values.every((value) => choices.some((choice) => choice.value === value)))) {
      return { cancelled: false, value: uniqueStrings(values) };
    }
  }
}

async function askRawArguments(
  current: string[] | undefined,
  question: RoleConfigWizardDependencies["question"]
): Promise<PromptResult<string[] | undefined>> {
  const hasCurrent = current !== undefined && current.length > 0;
  const prompt = [
    "Advanced raw arguments",
    ...(hasCurrent ? [`Current: ${current.length} configured (hidden)`] : []),
    ...(hasCurrent ? ["1. Keep current", "2. Inherit CLI default", "3. Replace"] : ["1. Inherit CLI default", "2. Replace"]),
    `Choose [${hasCurrent ? "keep" : "inherit"}] (or cancel): `
  ].join("\n");
  while (true) {
    const answer = (await question(prompt)).trim();
    if (isCancel(answer)) return { cancelled: true };
    if (answer.length === 0 || (hasCurrent && /^(?:1|keep)$/i.test(answer))) {
      return { cancelled: false, value: hasCurrent ? [...current] : undefined };
    }
    if (/^(?:inherit|default)$/i.test(answer) || (!hasCurrent && answer === "1") || (hasCurrent && answer === "2")) {
      return { cancelled: false, value: undefined };
    }
    if (/^replace$/i.test(answer) || (!hasCurrent && answer === "2") || (hasCurrent && answer === "3")) break;
  }

  const values: string[] = [];
  while (true) {
    const answer = await question(`Raw argument #${values.length + 1} (blank to finish, or cancel): `);
    if (isCancel(answer.trim())) return { cancelled: true };
    if (answer.length === 0) break;
    values.push(answer);
  }
  return { cancelled: false, value: values.length === 0 ? undefined : values };
}

async function askYesNo(
  prompt: string,
  defaultValue: boolean,
  question: RoleConfigWizardDependencies["question"]
): Promise<PromptResult<boolean>> {
  while (true) {
    const answer = (await question(prompt)).trim();
    if (isCancel(answer)) return { cancelled: true };
    if (answer.length === 0) return { cancelled: false, value: defaultValue };
    if (/^(?:y|yes)$/i.test(answer)) return { cancelled: false, value: true };
    if (/^(?:n|no)$/i.test(answer)) return { cancelled: false, value: false };
  }
}

function currentConfig(input: RoleConfigWizardInput, agent: AgentDefinition): RoleAgentConfig | undefined {
  const current = input.currentConfigs?.[agent.id];
  return current?.adapterId === agent.adapterId ? current : undefined;
}

function readNestedStringList(config: RoleAgentConfig | undefined, path: string): string[] | undefined {
  const value = readPath(config, path);
  return Array.isArray(value) && value.every((entry) => typeof entry === "string") ? [...value] : undefined;
}

function readAdvancedRawArgs(config: RoleAgentConfig | undefined): string[] | undefined {
  return readNestedStringList(config, "advanced.rawArgs");
}

function readPath(config: RoleAgentConfig | undefined, path: string): unknown {
  let value: unknown = config;
  for (const part of path.split(".")) {
    if (!isRecord(value)) return undefined;
    value = value[part];
  }
  return value;
}

function setConfigValue(config: RoleAgentConfig, path: string, value: FieldValue): void {
  const parts = path.split(".");
  let target = config as unknown as Record<string, unknown>;
  for (const part of parts.slice(0, -1)) {
    const nested = isRecord(target[part]) ? { ...target[part] } : {};
    target[part] = nested;
    target = nested;
  }
  target[parts.at(-1) as string] = Array.isArray(value) ? [...value] : value;
}

function deleteConfigValue(config: RoleAgentConfig, path: string): void {
  const parts = path.split(".");
  const parents: Array<{ parent: Record<string, unknown>; key: string }> = [];
  let target = config as unknown as Record<string, unknown>;
  for (const part of parts.slice(0, -1)) {
    if (!isRecord(target[part])) return;
    parents.push({ parent: target, key: part });
    target = target[part] as Record<string, unknown>;
  }
  delete target[parts.at(-1) as string];
  for (const { parent, key } of parents.reverse()) {
    if (isRecord(parent[key]) && Object.keys(parent[key]).length === 0) delete parent[key];
  }
}

function orderFields(fields: CapabilityField[]): CapabilityField[] {
  const usable = fields.filter((field) => field.key !== "instructions");
  const priority = (field: CapabilityField): number => field.key === "model" ? 0 : field.key === "effort" ? 1 : 2;
  return usable.map((field, index) => ({ field, index }))
    .sort((left, right) => priority(left.field) - priority(right.field) || left.index - right.index)
    .map(({ field }) => field);
}

function isCoreField(field: CapabilityField): boolean {
  return field.key === "model" || field.key === "effort" || field.key.startsWith("permission.");
}

function advancedUnavailableNotices(
  fields: CapabilityField[],
  current: RoleAgentConfig | undefined,
  selectedModel: string | undefined
): string[] {
  return fields.flatMap((field) => {
    const value = normalizeFieldValue(field.kind, readPath(current, field.key));
    if (value === undefined || fieldValueIsAvailable(field, availableChoices(field, selectedModel), value)) return [];
    const rendered = Array.isArray(value) ? value.join(", ") : String(value);
    return [`Advanced current unavailable: ${field.label}=${rendered}. Expand Advanced to review it.`];
  });
}

async function preserveCollapsedAdvanced(
  config: RoleAgentConfig,
  current: RoleAgentConfig | undefined,
  fields: CapabilityField[],
  selected: InspectedAgent,
  dependencies: RoleConfigWizardDependencies
): Promise<void> {
  for (const field of fields) {
    const value = normalizeFieldValue(field.kind, readPath(current, field.key));
    if (value === undefined) continue;
    const choices = availableChoices(field, readPath(config, "model") as string | undefined);
    const available = fieldValueIsAvailable(field, choices, value);
    const safe = !available && current !== undefined && dependencies.canKeepUnavailableValue !== undefined
      ? await dependencies.canKeepUnavailableValue({
        agent: selected.agent,
        snapshot: selected.snapshot,
        fieldKey: field.key,
        value,
        currentConfig: current,
        draftConfig: cloneConfig(config)
      })
      : false;
    if (available || safe) setConfigValue(config, field.key, value);
  }
  const rawArgs = readAdvancedRawArgs(current);
  if (rawArgs !== undefined) setConfigValue(config, "advanced.rawArgs", rawArgs);
}

async function mayKeepUnavailable(input: AskFieldInput, value: FieldValue): Promise<boolean> {
  if (input.currentConfig === undefined || input.dependencies.canKeepUnavailableValue === undefined) return false;
  return input.dependencies.canKeepUnavailableValue({
    agent: input.agent,
    snapshot: input.snapshot,
    fieldKey: input.field.key,
    value,
    currentConfig: input.currentConfig,
    draftConfig: cloneConfig(input.draftConfig)
  });
}

function normalizeFieldValue(kind: CapabilityField["kind"], value: unknown): FieldValue | undefined {
  if (kind === "boolean") return typeof value === "boolean" ? value : undefined;
  if (kind === "string-list" || kind === "path-list") {
    return Array.isArray(value) && value.every((entry) => typeof entry === "string") ? [...value] : undefined;
  }
  return typeof value === "string" ? value : undefined;
}

function fieldPrompt(
  field: CapabilityField,
  optionLines: string[],
  current: FieldValue | undefined,
  currentAvailable: boolean,
  canKeepUnavailable: boolean,
  defaultValue: FieldValue | undefined
): string {
  const renderedCurrent = Array.isArray(current) ? current.join(", ") : String(current);
  const currentLines = current === undefined
    ? []
    : currentAvailable
      ? [`Current: ${renderedCurrent}`]
      : [
        `Current unavailable: ${renderedCurrent}; ${canKeepUnavailable
          ? "Keep is adapter-safe."
          : "choose a replacement or inherit CLI default."}`
      ];
  const renderedDefault = defaultValue === undefined
    ? "inherit"
    : Array.isArray(defaultValue) ? defaultValue.join(", ") : String(defaultValue);
  return [
    field.label,
    ...optionLines,
    ...currentLines,
    `Choose ${field.label} [${renderedDefault}] (or cancel): `
  ].join("\n");
}

function cloneConfig(config: RoleAgentConfig): RoleAgentConfig {
  return JSON.parse(JSON.stringify(config)) as RoleAgentConfig;
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values)];
}

function findChoice(choices: CapabilityChoice[], answer: string): CapabilityChoice | undefined {
  return choices.find((choice) => choiceMatches(choice, answer));
}

function choiceMatches(choice: CapabilityChoice, answer: string): boolean {
  const normalized = answer.toLocaleLowerCase();
  return choice.value.toLocaleLowerCase() === normalized || choice.label.toLocaleLowerCase() === normalized;
}

function renderSummary(
  roleName: string,
  selection: RoleConfigWizardSelection,
  current: RoleAgentConfig | undefined
): string {
  const overrides = flattenOverrides(selection.config);
  const selectedKeys = new Set(overrides.map(([key]) => key));
  const inherited = flattenOverrides(current ?? { adapterId: selection.adapterId } as RoleAgentConfig)
    .filter(([key]) => !selectedKeys.has(key))
    .map(([key, value]) => [key, `${value} -> inherit`] as [string, string]);
  const rows = [...overrides, ...inherited];
  return [
    `Role ${roleName} configuration`,
    `Agent: ${selection.agentId} (${selection.adapterId})`,
    ...(rows.length === 0
      ? ["Overrides: none (inherit CLI defaults)"]
      : ["Selected overrides:", ...rows.map(([key, value]) => `${key}: ${value}`)])
  ].join("\n").concat("\n");
}

function flattenOverrides(config: RoleAgentConfig): Array<[string, string]> {
  const rows: Array<[string, string]> = [];
  const walk = (value: unknown, prefix: string): void => {
    if (Array.isArray(value)) {
      if (value.length > 0) rows.push([
        prefix,
        prefix === "advanced.rawArgs" ? `${value.length} configured (hidden)` : value.join(", ")
      ]);
      return;
    }
    if (isRecord(value)) {
      for (const key of Object.keys(value)) {
        if (prefix.length === 0 && key === "adapterId") continue;
        walk(value[key], prefix.length === 0 ? key : `${prefix}.${key}`);
      }
      return;
    }
    if (typeof value === "string" || typeof value === "boolean") rows.push([prefix, String(value)]);
  };
  walk(config, "");
  return rows;
}

function parseOneBasedIndex(value: string, length: number): number {
  if (!/^\d+$/.test(value)) return -1;
  const index = Number(value) - 1;
  return index >= 0 && index < length ? index : -1;
}

function labelForKey(key: string): string {
  return key.split(".").at(-1)?.replace(/([A-Z])/g, " $1").replace(/^./, (value) => value.toUpperCase()) ?? key;
}

function isCancel(value: string): boolean {
  return /^(?:cancel|quit|q|skip)$/i.test(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
