export const COMPONENTS_SCRIPT = `
// Reusable widgets and record cards. Everything here is a pure builder:
// data + i18n in, DOM out. Page composition lives in view.js.
import { node } from "/assets/js/dom.js";
import { formatDateTime, relativeTime } from "/assets/js/format.js";
import { escapeHtml, inlineMarkdown, renderMarkdown } from "/assets/js/markdown.js";

export function translatedStatus(t, prefix, status) {
  return t(prefix + "." + status);
}

// Mirrors src/agent/adapterCatalog.ts to avoid a runtime import loop.
const adapterLabels = { codex: "Codex", claude: "Claude" };
function adapterLabel(adapterId) {
  return adapterLabels[adapterId] || adapterId;
}

// --- Small widgets -----------------------------------------------------------
export function metaItem(label, value) {
  const item = node("span", "detail-meta-item");
  item.append(node("small", "", label), node("span", "", value));
  return item;
}

export function pathMetaItem(label, value) {
  const item = node("span", "detail-meta-item");
  const path = node("span", "meta-path", value);
  path.title = value;
  item.append(node("small", "", label), path);
  return item;
}

export function chip(text, extraClass) {
  return node("span", "chip" + (extraClass ? " " + extraClass : ""), text);
}

export function agentBadge(agent) {
  if (!agent) return null;
  const badge = node("span", "agent-badge");
  if (agent.adapterId) badge.append(chip(adapterLabel(agent.adapterId), "is-adapter"));
  if (agent.model) badge.append(chip(agent.model));
  if (agent.effort) badge.append(chip(agent.effort));
  return badge.childNodes.length ? badge : null;
}

export function chipRow(label, values, activeValue) {
  const list = (values || []).filter(function (value) { return value !== undefined && value !== null && value !== ""; });
  if (!list.length) return null;
  const block = node("div", "record-block");
  block.append(node("small", "", label));
  const row = node("div", "chip-row");
  list.forEach(function (value) {
    row.append(chip(String(value), activeValue !== undefined && value === activeValue ? "is-active" : ""));
  });
  block.append(row);
  return block;
}

export function pill(t, namespace, status) {
  const element = node("span", "pill", translatedStatus(t, namespace, status));
  element.dataset.status = status;
  return element;
}

export function statusDot(status) {
  const dot = node("span", "status-dot " + status);
  dot.setAttribute("aria-hidden", "true");
  return dot;
}

export function emptyRow(t, key) {
  return node("div", "row is-empty", t(key || "empty.none"));
}

export function sectionHead(label, options) {
  const head = node("div", "section-head");
  head.append(node("h3", "", label));
  if (options && options.count !== undefined) head.append(node("span", "section-count", String(options.count)));
  if (options && options.kicker) head.append(node("span", "section-kicker", options.kicker));
  if (options && options.right) head.append(node("span", "section-label", options.right));
  return head;
}

export function anchorSection(id, head, body) {
  const section = node("section", "detail-section anchor");
  section.id = id;
  section.append(head, body);
  return section;
}

// --- Progressive disclosure --------------------------------------------------
// Re-render is cheap and happens whenever the underlying data changes, so all
// disclosure state (collapsed blocks, visible pages) is deliberately
// deterministic per render: long content starts collapsed and expanding is a
// pure local toggle.
function shouldCollapse(text, threshold) {
  const limit = threshold || 700;
  const value = String(text);
  if (value.length > limit) return true;
  let lines = 0;
  for (let i = 0; i < value.length; i += 1) {
    if (value[i] === "\\n") lines += 1;
  }
  return lines > 12;
}

function collapseToggle(block, t) {
  block.classList.add("is-collapsible", "is-collapsed");
  const toggle = node("button", "md-toggle", t("actions.showMore"));
  toggle.type = "button";
  toggle.addEventListener("click", function () {
    const collapsed = block.classList.toggle("is-collapsed");
    toggle.textContent = collapsed ? t("actions.showMore") : t("actions.showLess");
  });
  block.append(toggle);
}

// Rich text block: small label + Markdown body, auto-collapsed when long.
export function richText(label, text, t, options) {
  if (!text) return null;
  const baseClass = (options && options.className) || "record-block";
  const extra = options && options.extraClass ? " " + options.extraClass : "";
  const block = node("div", baseClass + extra);
  if (label) block.append(node("small", "", label));
  const body = node("div", "md" + (options && options.muted ? " muted" : ""));
  body.innerHTML = renderMarkdown(text);
  block.append(body);
  if (shouldCollapse(text, options && options.threshold)) collapseToggle(block, t);
  return block;
}

// Renders the first page of a long list plus a button that reveals the rest
// in place, one page at a time.
export function pagedList(container, items, pageSize, renderItem, t) {
  let shown = 0;
  let more = null;
  function renderChunk() {
    const chunk = items.slice(shown, shown + pageSize);
    chunk.forEach(function (item) {
      container.insertBefore(renderItem(item), more);
    });
    shown += chunk.length;
    if (more) {
      const remaining = items.length - shown;
      if (remaining <= 0) {
        more.remove();
        more = null;
      } else {
        more.textContent = t("actions.showRemaining").replace("{count}", String(remaining));
      }
    }
  }
  if (items.length > pageSize) {
    more = node("button", "show-more", "");
    more.type = "button";
    more.addEventListener("click", renderChunk);
    container.append(more);
  }
  renderChunk();
}

export function criteriaList(label, items, t) {
  const list = (items || []).filter(Boolean);
  if (!list.length) return null;
  const block = node("div", "record-block is-wide criteria-block");
  block.append(node("small", "", label));
  const listElement = node("ul", "criteria-list");
  list.forEach(function (item) {
    const li = node("li", "");
    li.innerHTML = inlineMarkdown(escapeHtml(item));
    listElement.append(li);
  });
  block.append(listElement);
  if (list.length > 6) collapseToggle(block, t);
  return block;
}

// --- Authors ------------------------------------------------------------------
function messageAuthor(message, t) {
  return message.author.type === "role"
    ? message.author.roleName
    : t("author." + message.author.type);
}

function authorName(t, who) {
  const key = "author." + who;
  const label = t(key);
  return label === key ? who : label;
}

// --- Input (attention) cards ---------------------------------------------------
function answerActions(input, actions, t) {
  const answers = node("div", "input-actions");
  if (input.choices && input.choices.length) {
    input.choices.forEach(function (choice) {
      const button = node("button", "input-answer", choice.label);
      button.type = "button";
      button.addEventListener("click", function () {
        if (actions.answerInput) actions.answerInput(input, { choiceKey: choice.key });
      });
      answers.append(button);
    });
  } else {
    const form = node("form", "input-form");
    const field = node("input", "");
    field.type = "text";
    field.required = true;
    field.placeholder = t("input.freeText");
    const submit = node("button", "input-answer", t("actions.answer"));
    submit.type = "submit";
    form.append(field, submit);
    form.addEventListener("submit", function (event) {
      event.preventDefault();
      const text = field.value.trim();
      if (text && actions.answerInput) actions.answerInput(input, { text: text });
    });
    answers.append(form);
  }
  return answers;
}

export function inputCard(input, _options, t, locale, actions) {
  const card = node("article", "input-card");
  const top = node("div", "input-card-top");
  top.append(node("small", "", t("detail.openInput")));
  const question = node("p", "input-question", input.question);
  top.append(question);
  const context = node("div", "input-context");
  if (input.policy) {
    if (input.policy.kind === "recommended") {
      context.append(pill(t, "input", "recommended"));
      if (input.policy.timeoutAt) {
        context.append(node("span", "", t("input.timeoutAt") + " · " + relativeTime(input.policy.timeoutAt, locale, t)));
      }
    } else {
      context.append(pill(t, "input", "required"));
    }
  }
  context.append(node("time", "", formatDateTime(input.createdAt, locale)));
  top.append(context);
  if (input.blockedRefs && input.blockedRefs.length) {
    const blocked = input.blockedRefs.map(function (ref) { return ref.type + "·" + ref.id; }).join("  ");
    top.append(node("span", "input-blocked", blocked));
  }
  card.append(top);
  card.append(answerActions(input, actions, t));
  return card;
}

// --- Conclusion band ------------------------------------------------------------
export function conclusionMeta(task, t, locale, kind) {
  const meta = node("div", "conclusion-meta");
  const actor = kind === "archived" ? task.archivedBy
    : kind === "retired" ? task.retiredBy
    : task.completedBy;
  const at = kind === "archived" ? task.archivedAt
    : kind === "retired" ? task.retiredAt
    : task.completedAt;
  const label = kind === "archived" ? t("detail.archivedBy")
    : kind === "retired" ? t("detail.retiredBy")
    : t("detail.completedBy");
  if (actor) meta.append(node("span", "", label + " · " + authorName(t, actor)));
  if (at) meta.append(node("time", "", formatDateTime(at, locale)));
  return meta;
}

// --- Record cards -----------------------------------------------------------------
// WorkItems that no longer need action render collapsed; everything actionable
// (pending, running, awaiting acceptance, failed) stays expanded.
const WORK_ITEM_OPEN_STATUSES = ["pending", "running", "awaiting_acceptance", "failed"];

export function workItemCard(item, titles, t, locale, actions, taskId) {
  const collapsible = WORK_ITEM_OPEN_STATUSES.indexOf(item.status) === -1;
  const card = node(collapsible ? "details" : "article", "record-card work-item-card");
  const head = node(collapsible ? "summary" : "div", "record-head");
  const titleRow = node("div", "record-title-row");
  titleRow.append(statusDot(item.status), node("strong", "record-title", item.title));
  const pills = node("div", "record-pills");
  pills.append(pill(t, "work", item.status));
  if (item.workspaceDisposition) pills.append(pill(t, "disposition", item.workspaceDisposition));
  head.append(titleRow, pills);
  card.append(head);

  const body = node("div", "work-item-body");
  const meta = node("div", "record-meta");
  if (item.assignee) meta.append(node("span", "meta-name", item.assignee));
  meta.append(node("span", "mono", item.id));
  meta.append(node("time", "", formatDateTime(item.updatedAt, locale)));
  body.append(meta);

  if (item.objective && item.objective !== item.title) {
    body.append(richText(t("detail.objective"), item.objective, t));
  }
  if (item.acceptance && item.acceptance.length) {
    body.append(criteriaList(t("detail.acceptance"), item.acceptance, t));
  }

  // Short chip rows (dependencies, writable projects) sit side by side; long
  // text blocks above and below stay full-width so the card reads top-to-bottom
  // like an issue rather than a mismatched column grid.
  const chipCols = node("div", "work-item-chips");
  if (item.dependsOn && item.dependsOn.length) {
    chipCols.append(chipRow(t("detail.dependsOn"), item.dependsOn.map(function (id) { return titles[id] || id; })));
  }
  if (item.writeProjectIds && item.writeProjectIds.length) {
    chipCols.append(chipRow(t("detail.writeProjects"), item.writeProjectIds));
  }
  if (chipCols.childNodes.length) body.append(chipCols);

  if (item.outcome) {
    body.append(richText(t("detail.outcome"), item.outcome, t, { extraClass: "outcome-callout", muted: true }));
  }
  card.append(body);
  return card;
}

export function runCard(run, t, locale) {
  const card = node("article", "execute-card");
  card.dataset.status = run.status;

  const idRow = node("div", "execute-id");
  idRow.append(statusDot(run.status));
  idRow.append(node("span", "role", run.roleName));
  idRow.append(node("span", "", run.id));
  if (run.workItemId) idRow.append(node("span", "", t("detail.workItem") + " · " + run.workItemId));
  idRow.append(node("time", "", formatDateTime(run.updatedAt, locale)));
  card.append(idRow);

  card.append(richText(t("detail.instruction"), run.input, t, { className: "execute-io", threshold: 320 }));
  if (run.summary) {
    card.append(richText(t("detail.outcome"), run.summary, t, { className: "execute-io outcome", threshold: 320 }));
  }

  const foot = node("div", "execute-foot");
  const tags = node("div", "execute-tags");
  tags.append(chip(t("mode." + run.mode)));
  tags.append(chip(t(run.deliveredAt ? "delivery.delivered" : "delivery.pending")));
  const badge = run.effective ? agentBadge(run.effective) : (run.agentId ? agentBadge(run) : null);
  if (badge) tags.append(badge);
  foot.append(tags);
  foot.append(pill(t, "run", run.status));
  card.append(foot);

  if (run.effective) {
    const eff = node("div", "record-meta");
    eff.append(node("span", "", t("detail.effective") + " · r" + run.effective.sourceDesiredRevision));
    eff.append(node("span", "", t("detail.profileIntent") + " · " + run.effective.profileAccess));
    eff.append(node("span", "", t("detail.permission") + " · " + run.effective.permission.strategy));
    card.append(eff);
  }

  return card;
}

export function reviewCard(round, t, locale) {
  const card = node("article", "record-card");
  const head = node("div", "record-head");
  const titleRow = node("div", "record-title-row");
  titleRow.append(node("strong", "record-title", round.id));
  head.append(titleRow);
  head.append(pill(t, "review", round.status));
  card.append(head);
  const meta = node("div", "record-meta");
  meta.append(node("span", "meta-name", round.reviewerRoleName));
  meta.append(node("span", "mono", round.workItemId + " · " + round.candidateId));
  if (round.createdAt) meta.append(node("time", "", formatDateTime(round.createdAt, locale)));
  meta.append(node("span", "", t("detail.reviewBase") + " · " + round.reviewBaseCommit));
  if (round.workspace && round.workspace.root) {
    meta.append(pathMetaItem(t("detail.workspace"), round.workspace.root));
  }
  if (round.evidenceCommit) {
    meta.append(node("span", "", t("detail.evidence") + " · " + round.evidenceCommit));
  }
  card.append(meta);
  if (round.checks && round.checks.length) {
    card.append(richText(t("detail.checks"), round.checks.map(function (check) {
      return check.name + "=" + check.outcome;
    }).join(", "), t));
  }
  if (round.summary) card.append(richText(null, round.summary, t));
  return card;
}

export function roleCard(role, task, t, locale, actions) {
  const card = node("article", "record-card");
  const head = node("div", "record-head");
  head.append(node("strong", "record-title", role.name));
  const headRight = node("div", "record-pills");
  headRight.append(pill(t, "role", role.status));
  const open = node("button", "record-open", "");
  open.type = "button";
  open.append(node("span", "", t("actions.openRun")), node("span", "arrow", "→"));
  open.addEventListener("click", function () {
    if (actions.openTerminal) actions.openTerminal({ scope: "task", taskId: task.id, roleName: role.name });
  });
  headRight.append(open);
  head.append(headRight);
  card.append(head);

  const meta = node("div", "record-meta");
  meta.append(node("span", "meta-name", role.activeAgentId));
  const activeBinding = role.agentBindings && role.agentBindings[role.activeAgentId];
  if (activeBinding) {
    const badge = agentBadge({
      adapterId: activeBinding.adapterId,
      model: activeBinding.config && activeBinding.config.model,
      effort: activeBinding.config && activeBinding.config.effort
    });
    if (badge) meta.append(badge);
  }
  if (role.launchRevision !== undefined) {
    meta.append(node("span", "", t("detail.desired") + " · r" + role.launchRevision));
  }
  if (role.defaultAccess !== undefined) {
    meta.append(node("span", "", t("detail.profileIntent") + " · " + role.defaultAccess));
  }
  if (role.updatedAt) meta.append(node("time", "", formatDateTime(role.updatedAt, locale)));
  card.append(meta);

  if (role.effectiveLaunch) {
    const eff = node("div", "record-meta");
    eff.append(node("span", "", t("detail.effectiveAgent") + " · " + role.effectiveLaunch.agentId));
    const effBadge = agentBadge(role.effectiveLaunch);
    if (effBadge) eff.append(effBadge);
    if (role.effectiveLaunch.sourceDesiredRevision !== undefined) {
      eff.append(node("span", "", t("detail.effective") + " · r" + role.effectiveLaunch.sourceDesiredRevision));
    }
    if (role.effectiveLaunch.profileAccess !== undefined) {
      eff.append(node("span", "", t("detail.profileIntent") + " · " + role.effectiveLaunch.profileAccess));
    }
    if (role.effectiveLaunch.permission && role.effectiveLaunch.permission.strategy !== undefined) {
      eff.append(node("span", "", t("detail.permission") + " · " + role.effectiveLaunch.permission.strategy));
    }
    eff.append(node("span", "", role.launchDrift ? t("launch.drift") : t("launch.current")));
    card.append(eff);
  }

  if (role.description) card.append(richText(null, role.description, t, { muted: true }));

  const cols = node("div", "record-cols");
  const bindingIds = role.agentBindings ? Object.keys(role.agentBindings) : [];
  if (bindingIds.length > 1) {
    const bindings = bindingIds.map(function (id) {
      const binding = role.agentBindings[id];
      const model = binding.config && binding.config.model;
      return adapterLabel(binding.adapterId) + (model ? " · " + model : "");
    });
    const activeBindingLabel = activeBinding
      ? adapterLabel(activeBinding.adapterId) + (activeBinding.config && activeBinding.config.model ? " · " + activeBinding.config.model : "")
      : undefined;
    cols.append(chipRow(t("detail.agents"), bindings, activeBindingLabel));
  }
  if (role.skills && role.skills.length) cols.append(chipRow(t("detail.skills"), role.skills));
  if (role.responsibilities && role.responsibilities.length) cols.append(criteriaList(t("detail.responsibilities"), role.responsibilities, t));
  if (role.constraints && role.constraints.length) cols.append(criteriaList(t("detail.constraints"), role.constraints, t));
  if (role.expectedOutput) cols.append(richText(t("detail.expectedOutput"), role.expectedOutput, t, { muted: true }));
  if (cols.childNodes.length) card.append(cols);

  if (role.workspace) {
    const workspaceMeta = node("div", "record-meta");
    workspaceMeta.append(pathMetaItem(t("detail.workspace"), role.workspace));
    card.append(workspaceMeta);
  }
  return card;
}

export function historyEventRow(event, t, locale) {
  if (event.kind === "milestone") {
    const milestone = event.item;
    const card = node("article", "record-card");
    const head = node("div", "record-head");
    const titleRow = node("div", "record-title-row");
    titleRow.append(node("strong", "record-title", milestone.title));
    head.append(titleRow);
    head.append(pill(t, "history", "milestone"));
    card.append(head);
    const meta = node("div", "record-meta");
    meta.append(node("span", "mono", milestone.id));
    meta.append(node("time", "", formatDateTime(milestone.createdAt, locale)));
    card.append(meta);
    if (milestone.summary) card.append(richText(null, milestone.summary, t, { muted: true }));
    return card;
  }
  const decision = event.item;
  const card = node("article", "record-card");
  const head = node("div", "record-head");
  const titleRow = node("div", "record-title-row");
  titleRow.append(node("strong", "record-title", decision.title));
  head.append(titleRow);
  head.append(pill(t, "history", "decision"));
  card.append(head);
  const meta = node("div", "record-meta");
  meta.append(node("span", "mono", decision.id));
  if (decision.createdAt) meta.append(node("time", "", formatDateTime(decision.createdAt, locale)));
  if (decision.status) meta.append(pill(t, "decision", decision.status));
  card.append(meta);
  if (decision.rationale) card.append(richText(null, decision.rationale, t, { muted: true }));
  if (decision.supersededReason) card.append(richText(null, decision.supersededReason, t, { muted: true }));
  return card;
}

export function messageCard(message, t, locale) {
  const card = node("article", "record-card");
  const head = node("div", "record-head");
  const titleRow = node("div", "record-title-row");
  titleRow.append(node("strong", "record-title", messageAuthor(message, t)));
  head.append(titleRow);
  if (message.kind) head.append(pill(t, "messageKind", message.kind));
  card.append(head);

  const meta = node("div", "record-meta");
  meta.append(node("span", "mono", message.id));
  meta.append(node("time", "", formatDateTime(message.createdAt, locale)));
  if (message.runId) meta.append(node("span", "mono", message.runId + (message.workItemId ? " · " + message.workItemId : "")));
  card.append(meta);

  card.append(richText(null, message.body, t));
  return card;
}

// --- Overview + sidebar rows --------------------------------------------------
export function metricTile(label, value, options) {
  const variant = options && options.hot ? " is-hot" : options && options.warning ? " is-warning" : "";
  const tile = node("article", "metric" + variant);
  tile.append(node("span", "metric-label", label), node("strong", "metric-value", String(value)));
  return tile;
}

export function attentionRow(item, t, locale, onSelect) {
  const row = node("button", "inbox-row");
  row.type = "button";
  const request = item.request || {};
  const kind = request.policy && request.policy.kind === "required" ? "required"
    : request.policy && request.policy.kind === "recommended" ? "recommended"
    : null;

  const lead = node("span", "inbox-lead");
  lead.append(node("span", "inbox-dot"));
  const head = node("span", "inbox-head");
  head.append(node("span", "inbox-task", item.taskTitle));
  if (kind) head.append(pill(t, "input", kind));
  lead.append(head);
  row.append(lead);

  if (request.question) {
    const question = node("span", "inbox-question", request.question);
    question.title = request.question;
    row.append(question);
  }

  const foot = node("span", "inbox-foot");
  if (request.createdAt) foot.append(node("time", "", relativeTime(request.createdAt, locale, t)));
  foot.append(node("span", "inbox-go", t("actions.answer") + " →"));
  row.append(foot);

  row.addEventListener("click", function () { onSelect(item.taskId); });
  return row;
}

export function overviewRow(task, t, locale, onSelect) {
  const hasInputs = task.openInputCount > 0;
  const row = node("button", "overview-row" + (hasInputs ? " has-inputs" : ""));
  row.type = "button";
  row.append(statusDot(task.status));
  const main = node("span", "overview-row-title", task.title);
  main.title = task.title;
  row.append(main);
  row.append(node("span", "overview-row-time", relativeTime(task.updatedAt, locale, t)));
  row.addEventListener("click", function () { onSelect(task.id); });
  return row;
}

export function taskCard(task, hasAttention, state, t, locale, onSelect) {
  const button = node("button", "task");
  button.type = "button";
  button.dataset.id = task.id;
  button.setAttribute("aria-current", String(state.selected === task.id));

  button.append(statusDot(task.status));

  const main = node("span", "task-main");
  main.append(node("strong", "task-title", task.title));
  main.append(node("span", "task-meta", relativeTime(task.updatedAt, locale, t)));
  button.append(main);

  // One signal only: an open input (needs the user) outranks a running count.
  if (hasAttention) {
    const badge = node("span", "task-signal is-input", String(task.openInputCount || 1));
    badge.title = t("stats.inputs");
    button.append(badge);
  } else if (task.workItems && task.workItems.running > 0) {
    const badge = node("span", "task-signal is-running", String(task.workItems.running));
    badge.title = t("stats.running");
    button.append(badge);
  }

  button.addEventListener("click", function () { onSelect(task.id); });
  return button;
}
`;
