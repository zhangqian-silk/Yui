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

// Mirrors src/agent/adapterCatalog.ts to avoid a runtime import loop.
const adapterLabels = { codex: "Codex", claude: "Claude" };
function adapterLabel(adapterId) {
  return adapterLabels[adapterId] || adapterId;
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

function formatDateTime(iso, locale) {
  if (!iso || !Number.isFinite(Date.parse(iso))) return "—";
  return new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short" }).format(new Date(iso));
}

function byNewest(left, right) {
  return Date.parse(right.updatedAt || right.createdAt) - Date.parse(left.updatedAt || left.createdAt);
}

function metaItem(label, value) {
  const item = node("span", "detail-meta-item");
  item.append(node("small", "", label), node("span", "", value));
  return item;
}

function pathMetaItem(label, value) {
  const item = node("span", "detail-meta-item");
  const path = node("span", "meta-path", value);
  path.title = value;
  item.append(node("small", "", label), path);
  return item;
}

function chip(text, extraClass) {
  return node("span", "chip" + (extraClass ? " " + extraClass : ""), text);
}

function agentBadge(agent) {
  if (!agent) return null;
  const badge = node("span", "agent-badge");
  if (agent.adapterId) badge.append(chip(adapterLabel(agent.adapterId), "is-adapter"));
  if (agent.model) badge.append(chip(agent.model));
  if (agent.effort) badge.append(chip(agent.effort));
  return badge.childNodes.length ? badge : null;
}

function chipRow(label, values, activeValue) {
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

function criteriaList(label, items) {
  const list = (items || []).filter(Boolean);
  if (!list.length) return null;
  const block = node("div", "record-block");
  block.append(node("small", "", label));
  const listElement = node("ul", "criteria-list");
  list.forEach(function (item) { listElement.append(node("li", "", item)); });
  block.append(listElement);
  return block;
}

function copyBlock(label, text, options) {
  if (!text) return null;
  const block = node("div", "record-block");
  block.append(node("small", "", label));
  const paragraph = node("p", options && options.muted ? "muted" : "", text);
  block.append(paragraph);
  return block;
}

function pill(t, namespace, status) {
  const pill = node("span", "pill", translatedStatus(t, namespace, status));
  pill.dataset.status = status;
  return pill;
}

function statusDot(status) {
  const dot = node("span", "status-dot " + status);
  dot.setAttribute("aria-hidden", "true");
  return dot;
}

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

function emptyRow(t, key) {
  return node("div", "row", t(key || "empty.none"));
}

function sectionHead(label, options) {
  const head = node("div", "section-head");
  head.append(node("h3", "", label));
  if (options && options.count !== undefined) head.append(node("span", "section-count", String(options.count)));
  if (options && options.kicker) head.append(node("span", "section-kicker", options.kicker));
  if (options && options.right) head.append(node("span", "section-label", options.right));
  return head;
}

function anchorSection(id, head, body) {
  const section = node("section", "detail-section anchor");
  section.id = id;
  section.append(head, body);
  return section;
}

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

function answerSummary(input, t, locale) {
  const parts = [input.question];
  if (input.policy && input.policy.kind === "recommended" && input.policy.timeoutAt) {
    parts.push(t("input.timeoutAt") + " " + relativeTime(input.policy.timeoutAt, locale, t));
  }
  return parts.join(" · ");
}

export function renderFilters(container, state, t, onFilter) {
  clear(container);
  statuses.forEach(function (status) {
    const button = node("button", "filter", translatedStatus(t, "status", status));
    button.type = "button";
    button.dataset.status = status;
    button.setAttribute("aria-pressed", String(state.filter === status));
    button.addEventListener("click", function () { onFilter(status); });
    container.append(button);
  });
}

function taskGroupOf(task, attentionIds) {
  if (attentionIds.has(task.id)) return "attention";
  if (task.status === "active") return "active";
  if (task.status === "draft") return "draft";
  if (task.status === "archived") return "archived";
  return "finished";
}

function taskMatchesQuery(task, query, locale) {
  if (!query) return true;
  const hay = [task.title, task.id]
    .concat(task.tags || [])
    .concat(task.projectNames || [])
    .join(" ")
    .toLocaleLowerCase(locale);
  return hay.includes(query);
}

export function renderTasks(container, state, t, locale, onSelect) {
  clear(container);
  const query = state.query.trim().toLocaleLowerCase(locale);
  const attentionIds = new Set((state.attention || []).map(function (item) { return item.taskId; }));
  const groups = { attention: [], active: [], draft: [], finished: [], archived: [] };
  (state.tasks || []).forEach(function (task) {
    if (state.filter !== "all" && task.status !== state.filter) return;
    if (!taskMatchesQuery(task, query, locale)) return;
    groups[taskGroupOf(task, attentionIds)].push(task);
  });

  const order = [
    ["attention", t("group.attention")],
    ["active", t("group.active")],
    ["draft", t("group.draft")],
    ["finished", t("group.finished")],
    ["archived", t("group.archived")]
  ];
  const firstGroup = order.find(function (entry) { return groups[entry[0]].length > 0; });
  if (!firstGroup) {
    container.append(node("div", "empty", t("empty.tasks")));
    return;
  }
  order.forEach(function (entry) {
    const list = groups[entry[0]];
    if (!list.length) return;
    const block = node("section", "task-group");
    const head = node("h4", "task-group-head");
    head.append(node("span", "", entry[1]), node("span", "count", String(list.length)));
    block.append(head);
    list.forEach(function (task) {
      block.append(taskCard(task, attentionIds.has(task.id), state, t, locale, onSelect));
    });
    container.append(block);
  });
}

function taskCard(task, hasAttention, state, t, locale, onSelect) {
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

function metricTile(label, value, options) {
  const tile = node("article", "metric" + (options && options.hot ? " is-hot" : ""));
  tile.append(node("span", "metric-label", label), node("strong", "metric-value", String(value)));
  if (options && options.sub) tile.append(node("span", "metric-sub", options.sub));
  return tile;
}

export function renderOverview(detail, state, t, locale, onSelect) {
  clear(detail);
  const wrap = node("div", "overview");
  const counts = state.counts;

  const total = counts ? counts.total : 0;
  const rail = node("div", "command-rail");
  rail.append(
    metricTile(t("metrics.active"), counts ? counts.active : "—", { hot: true }),
    metricTile(t("metrics.inputs"), counts ? counts.openInputs : "—", {}),
    metricTile(t("metrics.completed"), counts ? counts.completed : "—",
      { sub: total > 0 ? t("metrics.ofTotal").replace("{total}", String(total)) : "" }),
    metricTile(t("metrics.total"), total, {})
  );
  wrap.append(rail);

  const inbox = node("section", "overview-block");
  const inboxHead = sectionHead(t("overview.inbox"), {
    count: (state.attention || []).length
  });
  inbox.append(inboxHead);
  const items = state.attention || [];
  if (!items.length) {
    const empty = node("div", "inbox-empty");
    empty.append(node("span", "dot"), node("span", "", t("overview.inboxEmpty")));
    inbox.append(empty);
  } else {
    const list = node("div", "inbox-list");
    items.slice(0, 8).forEach(function (item) {
      list.append(attentionRow(item, t, locale, onSelect));
    });
    inbox.append(list);
  }
  wrap.append(inbox);

  // Active work is the one list worth surfacing next to the inbox; status
  // counts already live in the metric rail, so no distribution panel here.
  const activeTasks = (state.tasks || []).filter(function (task) { return task.status === "active"; });
  if (activeTasks.length) {
    const activeBlock = node("section", "overview-block");
    activeBlock.append(sectionHead(t("overview.activeNow"), { count: activeTasks.length }));
    const activeBody = node("div", "overview-list");
    activeTasks.forEach(function (task) {
      activeBody.append(overviewRow(task, t, locale, onSelect));
    });
    activeBlock.append(activeBody);
    wrap.append(activeBlock);
  }
  detail.append(wrap);
}

function attentionRow(item, t, locale, onSelect) {
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

function overviewRow(task, t, locale, onSelect) {
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

export function renderLoading(container, t, key) {
  clear(container);
  container.append(node("div", "loading", t(key)));
}

export function renderError(container, message) {
  clear(container);
  container.append(node("div", "error", message));
}

export function renderTaskDetail(detail, data, t, locale, actions) {
  actions = actions || {};
  clear(detail);
  const task = data.task;
  const scaffold = node("div", "detail-scaffold");

  // 1. Summary (anchor #detail-top)
  const summaryBody = node("div", "section-body");
  const headBlock = node("div", "detail-head");
  headBlock.append(node("span", "detail-kicker", task.id));
  headBlock.append(node("h2", "detail-title", task.title));
  if (task.description) headBlock.append(node("p", "detail-description", task.description));
  const meta = node("div", "detail-meta");
  meta.append(metaItem(t("detail.updated"), formatDateTime(task.updatedAt, locale)));
  meta.append(pill(t, "status", task.status));
  if (task.priority) meta.append(pill(t, "priority", task.priority));
  if (task.dueAt) meta.append(metaItem(t("detail.due"), formatDateTime(task.dueAt, locale)));
  if (task.projectNames && task.projectNames.length) {
    meta.append(metaItem(t("detail.project"), task.projectNames.join(", ")));
  }
  if (task.cwd) meta.append(pathMetaItem(t("detail.workspace"), task.cwd));
  headBlock.append(meta);
  summaryBody.append(headBlock);

  if (task.completionSummary) {
    const conclusion = node("div", "conclusion");
    conclusion.append(node("h3", "", t("detail.conclusion")), node("p", "", task.completionSummary));
    conclusion.append(conclusionMeta(task, t, locale, false));
    summaryBody.append(conclusion);
  } else if (task.status === "archived" || task.archiveSummary || task.archiveReason) {
    const conclusion = node("div", "conclusion archived");
    conclusion.append(node("h3", "", t("detail.archived")));
    if (task.archiveSummary) conclusion.append(node("p", "", task.archiveSummary));
    if (task.archiveReason) conclusion.append(node("p", "muted", task.archiveReason));
    conclusion.append(conclusionMeta(task, t, locale, true));
    summaryBody.append(conclusion);
  }
  scaffold.append(anchorSection("detail-top", sectionHead(t("tabs.summary")),
    summaryBody));

  // 2. Attention (anchor #detail-attention) — open input requests, promoted from old mid-list position
  if (data.openInputs.length) {
    const attentionBody = node("div", "section-body");
    data.openInputs.forEach(function (input) {
      attentionBody.append(inputCard(input, { single: true }, t, locale, actions));
    });
    scaffold.append(anchorSection("detail-attention",
      sectionHead(t("detail.attention"), { count: data.openInputs.length }),
      attentionBody));
  }

  // 3. Focus (anchor #detail-focus) — brief + technical approach
  const focusBody = node("div", "section-body");
  if (data.brief) {
    const focusCard = node("article", "record-card");
    focusCard.append(copyBlock(t("detail.focus"), data.brief.currentFocus || data.brief.objective));
    if (data.brief.technicalApproach) {
      focusCard.append(copyBlock(t("detail.technicalApproach"), data.brief.technicalApproach, { muted: true }));
    }
    if (data.brief.leaderSummary) focusCard.append(copyBlock(t("detail.leaderSummary"), data.brief.leaderSummary, { muted: true }));
    focusBody.append(focusCard);
  } else {
    focusBody.append(emptyRow(t, "empty.brief"));
  }
  scaffold.append(anchorSection("detail-focus", sectionHead(t("tabs.focus")), focusBody));

  // 4. Work items (anchor #detail-work) — the operational deck
  const workBody = node("div", "section-body");
  if (!data.workItems.length) {
    workBody.append(emptyRow(t));
  } else {
    const workItemTitles = {};
    data.workItems.forEach(function (item) { workItemTitles[item.id] = item.title; });
    data.workItems.slice().sort(byNewest).forEach(function (item) {
      workBody.append(workItemCard(item, workItemTitles, t, locale, actions, task.id));
    });
  }
  scaffold.append(anchorSection("detail-work",
    sectionHead(t("detail.workItems"), { count: data.workItems.length }),
    workBody));

  // 5. Runs (anchor #detail-exec) — execution grid
  const execBody = node("div", "run-grid");
  if (!data.runs.length) execBody.append(emptyRow(t, "empty.runs"));
  data.runs.slice().sort(byNewest).forEach(function (run) {
    execBody.append(runCard(run, t, locale));
  });
  scaffold.append(anchorSection("detail-exec",
    sectionHead(t("detail.execution"), { count: data.runs.length }),
    execBody));

  // 6. Roles (anchor #detail-roles)
  const rolesBody = node("div", "row-list");
  if (!data.roles.length) rolesBody.append(emptyRow(t));
  data.roles.forEach(function (role) {
    rolesBody.append(roleCard(role, task, t, locale, actions));
  });
  scaffold.append(anchorSection("detail-roles",
    sectionHead(t("detail.roles"), { count: data.roles.length }),
    rolesBody));

  // 7. History (anchor #detail-history) — merged milestones + decisions, chronological
  const historyEvents = [];
  (data.milestones || []).forEach(function (m) {
    historyEvents.push({ kind: "milestone", item: m });
  });
  (data.decisions || []).forEach(function (d) {
    historyEvents.push({ kind: "decision", item: d });
  });
  historyEvents.sort(function (a, b) {
    return Date.parse(b.item.createdAt || b.item.updatedAt) - Date.parse(a.item.createdAt || a.item.updatedAt);
  });
  const historyBody = node("div", "section-body");
  if (!historyEvents.length) {
    historyBody.append(emptyRow(t, "detail.historyEmpty"));
  } else {
    historyEvents.forEach(function (event) {
      historyBody.append(historyEventRow(event, t, locale));
    });
  }
  scaffold.append(anchorSection("detail-history",
    sectionHead(t("tabs.history"), { count: historyEvents.length }),
    historyBody));

  // 8. Messages (anchor #detail-messages)
  const messagesBody = node("div", "row-list");
  if (!data.messages.length) messagesBody.append(emptyRow(t));
  data.messages.slice().sort(byNewest).forEach(function (message) {
    messagesBody.append(messageCard(message, t, locale));
  });
  scaffold.append(anchorSection("detail-messages",
    sectionHead(t("detail.messages"), { count: data.messages.length }),
    messagesBody));

  detail.append(scaffold);
}

function conclusionMeta(task, t, locale, archived) {
  const meta = node("div", "conclusion-meta");
  const actor = archived ? task.archivedBy : task.completedBy;
  const at = archived ? task.archivedAt : task.completedAt;
  if (actor) meta.append(node("span", "",
    (archived ? t("detail.archivedBy") : t("detail.completedBy")) + " · " + authorName(t, actor)));
  if (at) meta.append(node("time", "", formatDateTime(at, locale)));
  return meta;
}

function inputCard(input, _options, t, locale, actions) {
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

function workItemCard(item, titles, t, locale, actions, _taskId) {
  const card = node("article", "record-card");
  const head = node("div", "record-head");
  const titleRow = node("div", "record-title-row");
  titleRow.append(statusDot(item.status), node("strong", "record-title", item.title));
  const pills = node("div", "record-pills");
  pills.append(pill(t, "work", item.status));
  if (item.workspaceDisposition) pills.append(pill(t, "disposition", item.workspaceDisposition));
  head.append(titleRow, pills);
  card.append(head);

  const meta = node("div", "record-meta");
  if (item.assignee) meta.append(node("span", "", t("detail.assignee") + " · " + item.assignee));
  meta.append(node("span", "mono", item.id));
  meta.append(node("time", "", formatDateTime(item.updatedAt, locale)));
  card.append(meta);

  const cols = node("div", "record-cols");
  if (item.objective && item.objective !== item.title) {
    cols.append(copyBlock(t("detail.objective"), item.objective));
  }
  if (item.acceptance && item.acceptance.length) cols.append(criteriaList(t("detail.acceptance"), item.acceptance));
  if (item.dependsOn && item.dependsOn.length) {
    cols.append(chipRow(t("detail.dependsOn"), item.dependsOn.map(function (id) { return titles[id] || id; })));
  }
  if (item.writeProjectIds && item.writeProjectIds.length) {
    cols.append(chipRow(t("detail.writeProjects"), item.writeProjectIds));
  }
  if (item.outcome) cols.append(copyBlock(t("detail.outcome"), item.outcome, { muted: true }));
  if (cols.childNodes.length) card.append(cols);
  return card;
}

function runCard(run, t, locale) {
  const card = node("article", "execute-card");
  card.dataset.status = run.status;

  const idRow = node("div", "execute-id");
  idRow.append(statusDot(run.status));
  idRow.append(node("span", "role", run.roleName));
  idRow.append(node("span", "", run.id));
  if (run.workItemId) idRow.append(node("span", "", t("detail.workItem") + " · " + run.workItemId));
  card.append(idRow);

  const io = node("div", "execute-io");
  io.append(node("small", "", t("detail.instruction")), node("p", "", run.input));
  card.append(io);
  if (run.summary) {
    const outcome = node("div", "execute-io outcome");
    outcome.append(node("small", "", t("detail.outcome")), node("p", "", run.summary));
    card.append(outcome);
  }

  const foot = node("div", "execute-foot");
  const tags = node("div", "execute-tags");
  tags.append(node("span", "", t("mode." + run.mode)));
  tags.append(node("span", "", t(run.deliveredAt ? "delivery.delivered" : "delivery.pending")));
  const badge = run.agentId ? agentBadge(run) : null;
  if (badge) tags.append(badge);
  foot.append(tags);
  foot.append(pill(t, "run", run.status));
  card.append(foot);

  card.append(node("time", "", formatDateTime(run.updatedAt, locale)));
  return card;
}

function roleCard(role, task, t, locale, actions) {
  const card = node("article", "record-card");
  const head = node("div", "record-head");
  head.append(node("strong", "record-title", role.name));
  head.append(pill(t, "role", role.status));
  card.append(head);

  const actionsRow = node("div", "record-actions");
  const left = node("div", "record-meta");
  left.append(node("span", "", t("detail.agent") + " · " + role.activeAgentId));
  const activeBinding = role.agentBindings && role.agentBindings[role.activeAgentId];
  if (activeBinding) {
    const badge = agentBadge({
      adapterId: activeBinding.adapterId,
      model: activeBinding.config && activeBinding.config.model,
      effort: activeBinding.config && activeBinding.config.effort
    });
    if (badge) left.append(badge);
  }
  actionsRow.append(left);

  const open = node("button", "record-open", "");
  open.type = "button";
  open.append(node("span", "", t("actions.openRun")), node("span", "arrow", "→"));
  open.addEventListener("click", function () {
    if (actions.openTerminal) actions.openTerminal({ scope: "task", taskId: task.id, roleName: role.name });
  });
  actionsRow.append(open);
  card.append(actionsRow);

  if (role.description) card.append(copyBlock("", role.description, { muted: true }));

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
  if (role.responsibilities && role.responsibilities.length) cols.append(criteriaList(t("detail.responsibilities"), role.responsibilities));
  if (role.constraints && role.constraints.length) cols.append(criteriaList(t("detail.constraints"), role.constraints));
  if (role.expectedOutput) cols.append(copyBlock(t("detail.expectedOutput"), role.expectedOutput, { muted: true }));
  if (cols.childNodes.length) card.append(cols);

  if (role.workspace) {
    const meta = node("div", "record-meta");
    meta.append(pathMetaItem(t("detail.workspace"), role.workspace));
    card.append(meta);
  }
  return card;
}

function historyEventRow(event, t, locale) {
  if (event.kind === "milestone") {
    const milestone = event.item;
    const card = node("article", "record-card");
    const head = node("div", "record-head");
    const titleRow = node("div", "record-title-row");
    titleRow.append(statusDot("completed"), node("strong", "record-title", milestone.title));
    head.append(titleRow);
    head.append(pill(t, "milestone", "recorded"));
    card.append(head);
    const meta = node("div", "record-meta");
    meta.append(node("span", "mono", milestone.id));
    meta.append(node("time", "", formatDateTime(milestone.createdAt, locale)));
    card.append(meta);
    if (milestone.summary) card.append(copyBlock("", milestone.summary, { muted: true }));
    return card;
  }
  const decision = event.item;
  const card = node("article", "record-card");
  const head = node("div", "record-head");
  head.append(node("strong", "record-title", decision.title));
  head.append(pill(t, "decision", decision.status));
  card.append(head);
  if (decision.rationale) card.append(copyBlock("", decision.rationale, { muted: true }));
  if (decision.supersededReason) card.append(copyBlock("", decision.supersededReason, { muted: true }));
  return card;
}

function messageCard(message, t, locale) {
  const card = node("article", "record-card");
  const head = node("div", "record-head");
  const titleRow = node("div", "record-title-row");
  titleRow.append(statusDot("active"), node("strong", "record-title", messageAuthor(message, t)));
  head.append(titleRow);
  if (message.kind) head.append(pill(t, "messageKind", message.kind));
  card.append(head);

  const meta = node("div", "record-meta");
  meta.append(node("time", "", formatDateTime(message.createdAt, locale)));
  if (message.runId) meta.append(node("span", "mono", message.runId + (message.workItemId ? " · " + message.workItemId : "")));
  card.append(meta);

  card.append(copyBlock("", message.body));
  return card;
}
`;
