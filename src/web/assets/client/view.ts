export const VIEW_SCRIPT = `
const statuses = ["all", "active", "draft", "completed", "archived"];

function node(tagName, className, textContent) {
  const element = document.createElement(tagName);
  if (className) element.className = className;
  if (textContent !== undefined && textContent !== null) element.textContent = String(textContent);
  return element;
}

function clear(element) {
  element.replaceChildren();
}

function translatedStatus(t, prefix, status) {
  return t(prefix + "." + status);
}

function relativeTime(iso, locale, t) {
  const seconds = Math.round((Date.parse(iso) - Date.now()) / 1000);
  if (!Number.isFinite(seconds) || Math.abs(seconds) < 45) return t("time.justNow");
  const units = [
    ["year", 31536000],
    ["month", 2592000],
    ["day", 86400],
    ["hour", 3600],
    ["minute", 60]
  ];
  const selected = units.find(function (entry) { return Math.abs(seconds) >= entry[1]; }) || ["second", 1];
  return new Intl.RelativeTimeFormat(locale, { numeric: "auto" }).format(
    Math.round(seconds / selected[1]),
    selected[0]
  );
}

function section(title) {
  const element = node("section", "detail-section");
  element.append(node("h3", "", title));
  return element;
}

function emptyRow(t) {
  return node("div", "row", t("empty.none"));
}

function formatDateTime(iso, locale) {
  if (!iso || !Number.isFinite(Date.parse(iso))) return "—";
  return new Intl.DateTimeFormat(locale, {
    dateStyle: "medium",
    timeStyle: "short"
  }).format(new Date(iso));
}

function byNewest(left, right) {
  return Date.parse(right.updatedAt || right.createdAt) - Date.parse(left.updatedAt || left.createdAt);
}

function metaItem(label, value) {
  const item = node("span", "detail-meta-item");
  item.append(node("small", "", label), node("span", "", value));
  return item;
}

function statusPill(t, namespace, status) {
  const pill = node("span", "pill", translatedStatus(t, namespace, status));
  pill.dataset.status = status;
  return pill;
}

function messageAuthor(message, t) {
  return message.author.type === "role"
    ? message.author.roleName
    : t("author." + message.author.type);
}

export function renderFilters(container, state, t, onFilter) {
  clear(container);
  statuses.forEach(function (status) {
    const button = node("button", "filter", t("status." + status));
    button.type = "button";
    button.dataset.status = status;
    button.setAttribute("aria-pressed", String(state.filter === status));
    button.addEventListener("click", function () { onFilter(status); });
    container.append(button);
  });
}

export function renderTasks(container, state, t, locale, onSelect) {
  clear(container);
  const query = state.query.trim().toLocaleLowerCase(locale);
  const tasks = state.tasks.filter(function (task) {
    const statusMatches = state.filter === "all" || task.status === state.filter;
    const haystack = [task.title, task.id].concat(task.tags || []).join(" ").toLocaleLowerCase(locale);
    return statusMatches && (!query || haystack.includes(query));
  });
  if (tasks.length === 0) {
    container.append(node("div", "empty", t("empty.tasks")));
    return;
  }
  tasks.forEach(function (task) {
    const button = node("button", "task");
    button.type = "button";
    button.dataset.id = task.id;
    button.setAttribute("aria-current", String(state.selected === task.id));

    const dot = node("span", "status-dot " + task.status);
    dot.setAttribute("aria-hidden", "true");
    const main = node("span", "task-main");
    main.append(node("strong", "task-title", task.title));
    const metadata = node("span", "task-meta");
    metadata.append(node("span", "", translatedStatus(t, "status", task.status)));
    metadata.append(node("span", "", relativeTime(task.updatedAt, locale, t)));
    (task.tags || []).forEach(function (tag) { metadata.append(node("span", "tag", "#" + tag)); });
    main.append(metadata);

    const stats = node("span", "task-stats");
    stats.append(node("span", "", String(task.workItems.running) + " " + t("stats.running")));
    stats.append(document.createElement("br"));
    stats.append(node("span", "", String(task.openInputCount) + " " + t("stats.inputs")));
    button.append(dot, main, stats);
    button.addEventListener("click", function () { onSelect(task.id); });
    container.append(button);
  });
}

export function renderEmptyDetail(detail, t) {
  clear(detail);
  const empty = node("div", "empty-detail");
  empty.append(node("span", "", "↳"));
  const title = node("h2", "");
  title.id = "detail-title";
  title.textContent = t("detail.selectTitle");
  empty.append(title, node("p", "", t("detail.selectBody")));
  detail.append(empty);
}

export function renderLoading(container, t, key) {
  clear(container);
  container.append(node("div", "loading", t(key)));
}

export function renderError(container, message) {
  clear(container);
  container.append(node("div", "error", message));
}

export function renderTaskDetail(detail, data, t, locale) {
  clear(detail);
  const task = data.task;
  const head = node("header", "detail-head");
  head.append(node("span", "detail-id", task.id));
  const title = node("h2", "", task.title);
  title.id = "detail-title";
  head.append(title);
  if (task.description) head.append(node("p", "detail-description", task.description));
  const taskMeta = node("div", "detail-meta");
  taskMeta.append(metaItem(t("detail.updated"), formatDateTime(task.updatedAt, locale)));
  taskMeta.append(statusPill(t, "status", task.status));
  if (task.priority) taskMeta.append(statusPill(t, "priority", task.priority));
  if (task.dueAt) taskMeta.append(metaItem(t("detail.due"), formatDateTime(task.dueAt, locale)));
  head.append(taskMeta);
  detail.append(head);

  if (data.openInputs.length) {
    const inputSection = section(t("detail.attention") + " · " + data.openInputs.length);
    data.openInputs.forEach(function (input) {
      const card = node("div", "input-card");
      card.append(node("small", "", t("detail.openInput")), node("span", "", input.question));
      inputSection.append(card);
    });
    detail.append(inputSection);
  }

  const briefSection = section(t("detail.focus"));
  if (data.brief) {
    briefSection.append(node("div", "brief-focus", data.brief.currentFocus || data.brief.objective));
    if (data.brief.leaderSummary) briefSection.append(node("p", "detail-description", data.brief.leaderSummary));
  } else {
    briefSection.append(node("div", "row", t("empty.brief")));
  }
  detail.append(briefSection);

  const executionSection = section(t("detail.execution") + " · " + data.runs.length);
  const runs = node("div", "run-list");
  if (!data.runs.length) runs.append(emptyRow(t));
  data.runs.slice().sort(byNewest).forEach(function (run) {
    const card = node("article", "run-card");
    card.dataset.status = run.status;
    const runHead = node("div", "run-head");
    const identity = node("div", "");
    identity.append(node("strong", "", run.roleName), node("span", "run-id", run.id));
    runHead.append(identity, statusPill(t, "run", run.status));
    card.append(runHead);

    const metadata = node("div", "run-meta");
    metadata.append(node("span", "", t("mode." + run.mode)));
    metadata.append(node("span", "", t(run.deliveredAt ? "delivery.delivered" : "delivery.pending")));
    metadata.append(node("time", "", formatDateTime(run.updatedAt, locale)));
    card.append(metadata);

    const instruction = node("div", "run-copy");
    instruction.append(node("small", "", t("detail.instruction")), node("p", "", run.input));
    card.append(instruction);
    if (run.summary) {
      const outcome = node("div", "run-copy outcome");
      outcome.append(node("small", "", t("detail.outcome")), node("p", "", run.summary));
      card.append(outcome);
    }
    runs.append(card);
  });
  executionSection.append(runs);
  detail.append(executionSection);

  const workSection = section(t("detail.workItems") + " · " + data.workItems.length);
  const work = node("div", "row-list");
  if (!data.workItems.length) work.append(emptyRow(t));
  data.workItems.slice().sort(byNewest).forEach(function (item) {
    const card = node("article", "record-card");
    const row = node("div", "row record-head");
    row.append(node("strong", "", item.title), statusPill(t, "work", item.status));
    card.append(row);
    const metadata = node("div", "run-meta");
    metadata.append(node("span", "", t("detail.assignee") + " · " + item.assignee));
    metadata.append(node("span", "", item.id));
    metadata.append(node("time", "", formatDateTime(item.updatedAt, locale)));
    card.append(metadata);
    if (item.outcome) card.append(node("p", "record-copy", item.outcome));
    work.append(card);
  });
  workSection.append(work);
  detail.append(workSection);

  const roleSection = section(t("detail.roles"));
  const roles = node("div", "row-list");
  if (!data.roles.length) roles.append(emptyRow(t));
  data.roles.forEach(function (role) {
    const card = node("article", "record-card");
    const row = node("div", "row record-head");
    row.append(node("strong", "", role.name), statusPill(t, "role", role.status));
    card.append(row);
    card.append(node("div", "run-meta", t("detail.agent") + " · " + role.activeAgentId));
    if (role.description) card.append(node("p", "record-copy", role.description));
    roles.append(card);
  });
  roleSection.append(roles);
  detail.append(roleSection);

  const milestoneSection = section(t("detail.milestones") + " · " + data.milestones.length);
  const milestones = node("div", "timeline");
  if (!data.milestones.length) milestones.append(emptyRow(t));
  data.milestones.slice().sort(byNewest).forEach(function (milestone) {
    const item = node("article", "timeline-item");
    item.append(node("time", "", formatDateTime(milestone.createdAt, locale)));
    item.append(node("strong", "", milestone.title));
    item.append(node("p", "", milestone.summary));
    milestones.append(item);
  });
  milestoneSection.append(milestones);
  detail.append(milestoneSection);

  const decisionSection = section(t("detail.decisions") + " · " + data.decisions.length);
  const decisions = node("div", "row-list");
  if (!data.decisions.length) decisions.append(emptyRow(t));
  data.decisions.slice().sort(byNewest).forEach(function (decision) {
    const card = node("article", "record-card");
    const row = node("div", "row record-head");
    row.append(node("strong", "", decision.title), statusPill(t, "decision", decision.status));
    card.append(row, node("p", "record-copy", decision.rationale));
    if (decision.supersededReason) card.append(node("p", "record-copy muted", decision.supersededReason));
    decisions.append(card);
  });
  decisionSection.append(decisions);
  detail.append(decisionSection);

  const messageSection = section(t("detail.messages") + " · " + data.messages.length);
  const messages = node("div", "timeline");
  if (!data.messages.length) messages.append(emptyRow(t));
  data.messages.slice().sort(byNewest).forEach(function (message) {
    const item = node("article", "timeline-item");
    const metadata = node("div", "run-meta");
    metadata.append(node("strong", "", messageAuthor(message, t)));
    metadata.append(node("time", "", formatDateTime(message.createdAt, locale)));
    item.append(metadata, node("p", "", message.body));
    if (message.runId) {
      item.append(node("span", "run-id", message.runId + (message.workItemId ? " · " + message.workItemId : "")));
    }
    messages.append(item);
  });
  messageSection.append(messages);
  detail.append(messageSection);
}
`;
