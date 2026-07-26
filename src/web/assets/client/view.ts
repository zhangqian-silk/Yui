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

function statBadge(count, label) {
  const badge = node("span", "task-stat");
  badge.append(node("b", "", String(count)), node("span", "", label));
  return badge;
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

// completedBy is "user" | "operator" | "leader"; user/operator have author.* keys,
// leader is a role name with no key — t() returns the key itself, so fall back to raw.
function authorName(t, who) {
  const key = "author." + who;
  const label = t(key);
  return label === key ? who : label;
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
    if (task.workItems.running > 0) stats.append(statBadge(task.workItems.running, t("stats.running")));
    if (task.openInputCount > 0) {
      const inputStat = statBadge(task.openInputCount, t("stats.inputs"));
      inputStat.classList.add("has-inputs");
      stats.append(inputStat);
    }
    if (stats.childNodes.length) main.append(stats);

    button.append(dot, main);
    button.addEventListener("click", function () { onSelect(task.id); });
    container.append(button);
  });
}

function overviewRow(task, badgeText, badgeClass, onSelect) {
  const row = node("button", "overview-row");
  row.type = "button";
  const dot = node("span", "status-dot " + task.status);
  dot.setAttribute("aria-hidden", "true");
  const title = node("span", "overview-row-title", task.title);
  const badge = node("span", "task-stat" + (badgeClass ? " " + badgeClass : ""), badgeText);
  row.append(dot, title, badge);
  row.addEventListener("click", function () { onSelect(task.id); });
  return row;
}

// Default view when no task is selected: a global-perspective summary.
export function renderOverview(detail, state, t, locale, onSelect) {
  clear(detail);
  const counts = state.counts;
  const wrap = node("div", "overview");

  const head = node("header", "overview-head");
  const title = node("h2", "overview-title", t("overview.title"));
  title.id = "detail-title";
  head.append(title);
  if (counts) {
    head.append(node("p", "overview-lede", t("overview.lede")
      .replace("{total}", counts.total)
      .replace("{active}", counts.active)
      .replace("{inputs}", counts.openInputs)
      .replace("{completed}", counts.completed)));
  } else {
    head.append(node("p", "overview-lede", t("page.lede")));
  }
  wrap.append(head);

  const segments = [
    ["active", counts ? counts.active : 0],
    ["draft", counts ? counts.draft : 0],
    ["completed", counts ? counts.completed : 0],
    ["archived", counts ? counts.archived : 0]
  ];
  if (counts && counts.total > 0) {
    const distBlock = node("section", "overview-block");
    distBlock.append(node("h3", "", t("overview.distribution")));
    const bar = node("div", "dist-bar");
    segments.forEach(function (entry) {
      if (entry[1] <= 0) return;
      const seg = node("span", "dist-seg " + entry[0]);
      seg.style.flexGrow = String(entry[1]);
      seg.title = translatedStatus(t, "status", entry[0]) + " · " + entry[1];
      bar.append(seg);
    });
    distBlock.append(bar);
    const legend = node("div", "dist-legend");
    segments.forEach(function (entry) {
      const item = node("span", "legend-item");
      const dot = node("span", "status-dot " + entry[0]);
      dot.setAttribute("aria-hidden", "true");
      item.append(dot, node("span", "", translatedStatus(t, "status", entry[0])), node("b", "", String(entry[1])));
      legend.append(item);
    });
    distBlock.append(legend);
    wrap.append(distBlock);
  }

  const attentionTasks = state.tasks.filter(function (task) { return task.openInputCount > 0; });
  const attentionBlock = node("section", "overview-block");
  attentionBlock.append(node("h3", "", t("overview.attention") + " · " + attentionTasks.length));
  if (attentionTasks.length) {
    const list = node("div", "overview-list");
    attentionTasks.forEach(function (task) {
      list.append(overviewRow(task, task.openInputCount + " " + t("stats.inputs"), "has-inputs", onSelect));
    });
    attentionBlock.append(list);
  } else {
    attentionBlock.append(node("div", "row", t("overview.attentionEmpty")));
  }
  wrap.append(attentionBlock);

  const activeTasks = state.tasks.filter(function (task) { return task.status === "active"; });
  const activeBlock = node("section", "overview-block");
  activeBlock.append(node("h3", "", t("overview.activeNow") + " · " + activeTasks.length));
  if (activeTasks.length) {
    const list = node("div", "overview-list");
    activeTasks.forEach(function (task) {
      list.append(overviewRow(task, task.workItems.running + " " + t("stats.running"), "", onSelect));
    });
    activeBlock.append(list);
  } else {
    activeBlock.append(node("div", "row", t("overview.activeEmpty")));
  }
  wrap.append(activeBlock);

  detail.append(wrap);
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

  if (task.completionSummary) {
    const conclusion = node("section", "conclusion");
    conclusion.append(node("h3", "", t("detail.conclusion")));
    conclusion.append(node("p", "", task.completionSummary));
    const meta = node("div", "run-meta");
    if (task.completedBy) {
      meta.append(node("span", "", t("detail.completedBy") + " · " + authorName(t, task.completedBy)));
    }
    if (task.completedAt) meta.append(node("time", "", formatDateTime(task.completedAt, locale)));
    if (meta.childNodes.length) conclusion.append(meta);
    detail.append(conclusion);
  }

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
