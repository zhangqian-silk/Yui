/**
 * Turning a Yui Role's requested run configuration into ACP config option
 * calls, and judging what the Agent answered.
 *
 * Two rules shape this module.
 *
 * The first is that the protocol does the work. ACP describes a Session's
 * configurable surface as a list of `select` options, each with an id, an
 * optional category naming the axis it belongs to, a current value and the
 * complete enumeration of values it accepts. Model, reasoning effort and
 * permission mode are all just options on that list, so resolving them is one
 * generic lookup by category rather than three product branches. An Agent Yui
 * has never seen is configured by the same code as one it ships knowledge of.
 *
 * The second is that a product-specific fact must be named, never inferred. One
 * such fact is needed here: which mode value means "act without asking". No ACP
 * field marks it, and its name is the Agent's own choice, so a value called
 * `bypassPermissions` proves nothing on its own — a different Agent could use
 * the same word for something narrower, or a narrower word for the same power.
 * Guessing from the string would convert an unverified reading into granted
 * authority. So this module does not decide it: it asks the execution component
 * catalog, where every product is described, and a component that names no
 * bypass value has its request reported as unsupported instead. That is a worse
 * user experience and the only honest one. Nothing here enumerates which
 * components exist, so a new ACP product is added by describing it there rather
 * than by editing this file.
 *
 * Nothing here performs I/O: the caller owns the transport, this module owns
 * the decision. That keeps the mapping testable against recorded option lists
 * without a live Agent, and keeps the Session free of product knowledge.
 */

import {
  agentExecutionComponent,
  type AgentExecutionComponentId
} from "../agent/executionComponents.js";
import {
  ACP_MODE_CONFIG_ID,
  type AcpConfigOption,
  type AcpDesiredConfigurationOptions
} from "./acpProtocol.js";

/**
 * The run configuration a launch asks an ACP Session for.
 *
 * Every field is optional because absence is a real and common request: a Role
 * that never named a model is asking for the Agent's own default, which is
 * satisfied by sending nothing at all. Only a stated value is pushed, so an
 * unset field can never be widened into a chosen one.
 */
export type AcpDesiredSessionConfiguration = Readonly<{
  model?: string;
  effort?: string;
  /**
   * How the Session's permission mode should be decided.
   *
   * - `default`: leave the Agent's own mode untouched. Yui states no opinion,
   *   so an Agent that starts conservative stays conservative and one that
   *   starts permissive is not silently narrowed either.
   * - `bypass`: the user explicitly asked this Role to act without approval
   *   prompts. Applied only through the component's own declared value, and
   *   only when the Agent actually offers it.
   * - a `{ modeId }` selection: the user named one exact mode. Matched by that
   *   exact id against what the Agent offers, never by its label.
   */
  permission: AcpDesiredPermission;
}>;

export type AcpDesiredPermission =
  | Readonly<{ kind: "default" }>
  | Readonly<{ kind: "bypass" }>
  | Readonly<{ kind: "mode"; modeId: string }>;

export type AcpConfigurationField = "model" | "effort" | "permission";

/** One resolved call the Session should make before it sends any prompt. */
export type AcpConfigurationStep = Readonly<{
  /** Which requested field this step satisfies, for diagnostics. */
  field: AcpConfigurationField;
  configId: string;
  value: string;
  /** The value the Agent reported before this step ran. */
  previousValue: string;
}>;

/**
 * A requested value that cannot be sent, with the reason stated in the Agent's
 * own terms.
 *
 * `offered` carries the values the Agent actually enumerated so the message can
 * show a real alternative set rather than advice. It is empty when the axis
 * itself is missing, which is a different failure from a value being outside a
 * present axis.
 */
export type AcpConfigurationRejection = Readonly<{
  field: AcpConfigurationField;
  requested: string;
  reason: string;
  offered: readonly string[];
}>;

/**
 * What became of one requested field, stated at the strength the protocol
 * actually supports.
 *
 * `already` reports the requested value before any write; `observed` confirms
 * the requested change in the Agent's own complete option list.
 */
export type AcpConfigurationOutcome = Readonly<{
  field: AcpConfigurationField;
  configId: string;
  value: string;
  confirmation: "already" | "observed";
}>;

/** What one field resolves to against the option list the Agent reports now. */
export type AcpConfigurationResolution =
  | Readonly<{ kind: "unrequested" }>
  | Readonly<{ kind: "satisfied"; step: AcpConfigurationStep }>
  | Readonly<{ kind: "step"; step: AcpConfigurationStep }>
  | Readonly<{ kind: "rejection"; rejection: AcpConfigurationRejection }>;

/** ACP categories that name each configurable axis. */
const MODEL_CATEGORY = "model";
const EFFORT_CATEGORY = "thought_level";
const MODE_CATEGORY = "mode";

/** Only expose the axes Yui configures, never arbitrary peer credential/settings fields. */
export function acpRunConfigurationOptions(
  options: readonly AcpConfigOption[]
): readonly AcpConfigOption[] {
  const selected = [
    findOption(options, MODEL_CATEGORY, "model"),
    findOption(options, EFFORT_CATEGORY, "effort"),
    findOption(options, MODE_CATEGORY, ACP_MODE_CONFIG_ID)
  ];
  return options.filter((option) => selected.includes(option));
}

/**
 * Find the option describing one axis.
 *
 * Category is the primary key because it is the field ACP defines for exactly
 * this purpose and it does not depend on an Agent's choice of id. The id is
 * consulted only as a fallback, for an Agent that omits the optional category
 * but uses the conventional id anyway. An Agent doing neither leaves the axis
 * unconfigurable, which is reported rather than worked around.
 */
function findOption(
  options: readonly AcpConfigOption[],
  category: string,
  fallbackId: string
): AcpConfigOption | undefined {
  return options.find((option) => option.category === category)
    ?? options.find((option) => option.id === fallbackId);
}

/**
 * Resolve one requested value against one axis.
 *
 * A value is sendable only when the Agent enumerated it. ACP requires a `select`
 * option to carry its complete set of accepted values, so that list is
 * authoritative: sending anything outside it would be sending a value the Agent
 * has already said it does not take. Reporting the mismatch with the real
 * enumeration is both more accurate and more useful than relaying whatever
 * generic error the Agent would answer with.
 */
function resolveValue(
  field: AcpConfigurationField,
  requested: string,
  option: AcpConfigOption | undefined,
  missingAxisReason: string
): AcpConfigurationStep | AcpConfigurationRejection {
  if (option === undefined) {
    return Object.freeze({ field, requested, reason: missingAxisReason, offered: Object.freeze([]) });
  }
  const offered = Object.freeze(option.options.map(({ value }) => value));
  const match = option.options.find(({ value }) => value === requested);
  if (match === undefined) {
    return Object.freeze({
      field,
      requested,
      reason: `ACP Agent option \`${option.id}\` does not offer the value \`${requested}\`.`,
      offered
    });
  }
  return Object.freeze({
    field,
    configId: option.id,
    value: match.value,
    previousValue: option.currentValue
  });
}

function isRejection(
  value: AcpConfigurationStep | AcpConfigurationRejection
): value is AcpConfigurationRejection {
  return "reason" in value;
}

/**
 * The order fields are applied in, and it is load-bearing.
 *
 * A model change is what redefines the other axes: selecting a model can reset
 * the reasoning effort to that model's own default, and can change which effort
 * values exist at all. So the model is settled first and everything that depends
 * on it is resolved afterwards, against the list the Agent reports by then. The
 * permission mode is last because it is the one axis whose wrong value grants
 * authority rather than merely degrading quality — it is decided when the
 * Session's shape has stopped moving.
 */
export const ACP_CONFIGURATION_ORDER:
  readonly AcpConfigurationField[] = Object.freeze(["model", "effort", "permission"]);

/**
 * Resolve exactly one requested field against the options the Agent reports
 * right now.
 *
 * Per-field and stateless by design. The Session applies one field at a time and
 * re-reads the Agent's complete list in between, so every resolution must be
 * computed from the newest list rather than from anything remembered: a value
 * that was correct before a model change may have been reset by it, and a value
 * that was unavailable may have become offered. A batch plan computed once
 * cannot express either, which is why this replaced one.
 */
export function resolveAcpConfigurationField(
  field: AcpConfigurationField,
  desired: AcpDesiredSessionConfiguration,
  options: readonly AcpConfigOption[],
  component: AgentExecutionComponentId
): AcpConfigurationResolution {
  const outcome = resolveRequest(field, desired, options, component);
  if (outcome === undefined) return UNREQUESTED;
  if (isRejection(outcome)) return Object.freeze({ kind: "rejection", rejection: outcome });
  // A value the Agent already holds needs no call. Keeping this distinct from a
  // value Yui set means a launch never claims to have sent something it did not.
  return outcome.previousValue === outcome.value
    ? Object.freeze({ kind: "satisfied", step: outcome })
    : Object.freeze({ kind: "step", step: outcome });
}

const UNREQUESTED: AcpConfigurationResolution = Object.freeze({ kind: "unrequested" });

function resolveRequest(
  field: AcpConfigurationField,
  desired: AcpDesiredSessionConfiguration,
  options: readonly AcpConfigOption[],
  component: AgentExecutionComponentId
): AcpConfigurationStep | AcpConfigurationRejection | undefined {
  if (field === "model") {
    if (desired.model === undefined) return undefined;
    return resolveValue(
      "model",
      desired.model,
      findOption(options, MODEL_CATEGORY, "model"),
      "ACP Agent offers no model config option for this Session, so the requested model "
      + "cannot be selected over the protocol; configure it in the Agent itself."
    );
  }
  if (field === "effort") {
    if (desired.effort === undefined) return undefined;
    return resolveValue(
      "effort",
      desired.effort,
      findOption(options, EFFORT_CATEGORY, "effort"),
      "ACP Agent offers no reasoning-effort config option for this Session, so the "
      + "requested effort cannot be selected over the protocol."
    );
  }
  const permission = desired.permission;
  // `default` deliberately produces nothing. Yui states no mode, so whatever the
  // Agent chose for itself stands: an old Role's conservative default is never
  // widened, and a permissive Agent is not narrowed behind the user's back.
  if (permission.kind === "default") return undefined;
  const modeOption = findOption(options, MODE_CATEGORY, ACP_MODE_CONFIG_ID);
  if (permission.kind === "mode") {
    return resolveValue(
      "permission",
      permission.modeId,
      modeOption,
      "ACP Agent offers no permission-mode config option for this Session, so the "
      + "requested mode cannot be applied."
    );
  }
  const bypassValue = agentExecutionComponent(component).bypassPermissionMode;
  if (bypassValue === undefined) {
    // The user asked for real elevation and Yui cannot name the value that
    // grants it for this product. Selecting a mode by how its name reads would
    // be a guess with authority attached, so the request stops here.
    return Object.freeze({
      field: "permission",
      requested: "bypass",
      reason: `Yui cannot map the bypass permission strategy onto execution component `
        + `${component}: no mode value is known to grant it, and Yui does not infer one `
        + `from a mode's name. Select an exact mode this Agent offers instead.`,
      offered: Object.freeze(modeOption?.options.map(({ value }) => value) ?? [])
    });
  }
  return resolveValue(
    "permission",
    bypassValue,
    modeOption,
    "ACP Agent offers no permission-mode config option for this Session, so the "
    + "requested bypass strategy cannot be applied."
  );
}

/**
 * Re-check every explicitly requested value against the Agent's final option
 * list, after all calls have been made.
 *
 * This exists because confirming each step as it lands is not enough: a later
 * call can reset an earlier axis. Selecting a model resets the reasoning effort
 * on real Agents, so a Session can confirm `effort=high`, then confirm
 * `model=b`, and end up running at that model's default effort with both
 * per-step checks having passed. Only a check against the last complete list the
 * Agent reported can see that, and it is the list the prompt would run under.
 *
 * Only stated values are checked. An unrequested axis has no expectation to
 * violate, and `default` permission means Yui asked for nothing.
 */
export function verifyAcpConfiguration(
  desired: AcpDesiredSessionConfiguration,
  options: readonly AcpConfigOption[],
  component: AgentExecutionComponentId
): readonly string[] {
  const failures: string[] = [];
  for (const field of ACP_CONFIGURATION_ORDER) {
    const resolution = resolveAcpConfigurationField(field, desired, options, component);
    if (resolution.kind === "unrequested" || resolution.kind === "satisfied") continue;
    if (resolution.kind === "rejection") {
      // The axis or the value disappeared from the Agent's final list, so the
      // request cannot be shown to hold even though a call for it succeeded.
      failures.push(`Requested ${field} could not be confirmed against the ACP Agent's `
        + `final configuration. ${resolution.rejection.reason}`);
      continue;
    }
    // The Agent reports a different current value than the one requested, which
    // means something applied later moved this axis.
    failures.push(`ACP Agent reports ${field} \`${resolution.step.previousValue}\` after `
      + `Yui applied this Session's configuration, but the launch requested `
      + `\`${resolution.step.value}\`.`);
  }
  return Object.freeze(failures);
}

/**
 * Confirm that one applied step actually took effect.
 *
 * `session/set_config_option` answers with the Session's complete option list,
 * so the proof is in that answer rather than in the call having not thrown. An
 * Agent that accepts the call and reports a different current value has
 * substituted something for what was asked, and that substitution must surface
 * as a failure instead of passing as success.
 */
export function confirmAcpConfigurationStep(
  step: AcpConfigurationStep,
  options: readonly AcpConfigOption[]
): string | undefined {
  const option = options.find(({ id }) => id === step.configId);
  if (option === undefined) {
    return `ACP Agent stopped reporting config option \`${step.configId}\` after Yui set it, `
      + `so the requested ${step.field} cannot be confirmed.`;
  }
  if (option.currentValue !== step.value) {
    return `ACP Agent accepted \`${step.configId}\` = \`${step.value}\` but reports `
      + `\`${option.currentValue}\`, so the requested ${step.field} was not applied.`;
  }
  return undefined;
}

/** A single readable diagnostic for every request the Agent cannot honour. */
export function describeAcpConfigurationRejections(
  rejections: readonly AcpConfigurationRejection[]
): string {
  return rejections
    .map((rejection) => rejection.offered.length === 0
      ? rejection.reason
      : `${rejection.reason} Offered values: ${rejection.offered.join(", ")}.`)
    .join(" ");
}

/**
 * Read a launch payload's requested configuration into the form this module
 * plans from.
 *
 * The payload keeps the two permission requests as separate fields because they
 * travel as JSON; this collapses them into the one decision they represent.
 * Neither present means `default`, which sends no mode at all.
 */
export function acpDesiredSessionConfiguration(
  options: AcpDesiredConfigurationOptions
): AcpDesiredSessionConfiguration {
  return Object.freeze({
    ...(options.model === undefined ? {} : { model: options.model }),
    ...(options.effort === undefined ? {} : { effort: options.effort }),
    permission: options.permissionMode !== undefined
      ? Object.freeze({ kind: "mode" as const, modeId: options.permissionMode })
      : options.permissionBypass === true
        ? Object.freeze({ kind: "bypass" as const })
        : Object.freeze({ kind: "default" as const })
  });
}
