export const VIEW_SCRIPT = `
// Page composition: sidebar lists, overview, and the task detail scaffold.
// All reusable widgets and cards come from components.js.
import { clear, node } from "/assets/js/dom.js";
import { byNewest, formatDateTime } from "/assets/js/format.js";
import {
  anchorSection,
  attentionRow,
  conclusionMeta,
  emptyRow,
  executionBand,
  historyEventRow,
  inputCard,
  messageCard,
  metaItem,
  metricTile,
  observabilityMetricCard,
  dagGraph,
  overviewRow,
  pagedList,
  pathMetaItem,
  pill,
  reviewCard,
  richText,
  roleCard,
  runCard,
  sectionHead,
  taskCard,
  translatedStatus,
  workItemCard
} from "/assets/js/components.js";

const statuses = ["all", "active", "draft", "completed", "retired", "archived"];

export function renderFilters(container, state, t, onFilter) {
  const counts = state.counts || {};
  // Single-row status chip row: every status is visible at once with its count,
  // so the user can switch filters without opening a dropdown. The row never
  // wraps; on narrow widths it scrolls horizontally.
  //
  // The row and its chips are created once and reused across renders so that
  // switching filters does not reset the row's horizontal scroll position.
  let row = container.querySelector(":scope > .filter-row");
  if (!row) {
    row = node("div", "filter-row");
    statuses.forEach(function (status) {
      const btn = node("button", "filter-chip");
      btn.type = "button";
      btn.dataset.status = status;
      if (status !== "all") {
        const dot = node("span", "filter-dot");
        dot.classList.add(status);
        btn.append(dot);
      }
      btn.append(node("span", "filter-label", translatedStatus(t, "status", status)));
      const badge = node("span", "filter-count");
      btn.append(badge);
      btn.addEventListener("click", function () { onFilter(status); });
      row.append(btn);
    });
    container.append(row);
  }
  statuses.forEach(function (status) {
    const btn = row.querySelector('.filter-chip[data-status="' + status + '"]');
    if (!btn) return;
    btn.classList.toggle("is-active", state.filter === status);
    const label = btn.querySelector(".filter-label");
    if (label) label.textContent = translatedStatus(t, "status", status);
    const count = status === "all" ? counts.total : counts[status];
    const badge = btn.querySelector(".filter-count");
    if (badge) {
      if (count !== undefined && count !== null) {
        badge.textContent = String(count);
        badge.hidden = false;
      } else {
        badge.hidden = true;
      }
    }
  });
}

function taskGroupOf(task, attentionIds) {
  if (attentionIds.has(task.id)) return "attention";
  if (task.status === "active") return "active";
  if (task.status === "draft") return "draft";
  if (task.status === "retired") return "retired";
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
  const groups = { attention: [], active: [], draft: [], finished: [], retired: [], archived: [] };
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
    ["retired", t("group.retired")],
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

function overviewBlock(head, tasks, t, locale, onSelect) {
  const block = node("section", "overview-block");
  block.append(sectionHead(head, { count: tasks.length }));
  const list = node("div", "overview-list");
  tasks.forEach(function (task) {
    list.append(overviewRow(task, null, null, t, locale, onSelect));
  });
  block.append(list);
  return block;
}

export function renderOverview(detail, state, t, locale, onSelect) {
  clear(detail);
  const wrap = node("div", "overview");
  const counts = state.counts;

  const total = counts ? counts.total : 0;
  const rail = node("div", "command-rail");
  rail.append(
    metricTile(t("metrics.active"), counts ? counts.active : "—", { hot: true }),
    metricTile(t("metrics.inputs"), counts ? counts.openInputs : "—", { warning: true }),
    metricTile(t("metrics.completed"), counts ? counts.completed : "—", {}),
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

  // Tasks whose Task-first projection says they need attention: blocked,
  // recovering, or in an attention state. This replaces the raw stalled-run
  // count with the derived execution status.
  const attentionTasks = (state.tasks || []).filter(function (task) {
    const status = task.executionStatus;
    return status === "blocked"
      || status === "attention"
      || status === "recovering"
      || status === "progressing-with-attention";
  });
  if (attentionTasks.length) {
    const attentionBlock = node("section", "overview-block");
    attentionBlock.append(node("h3", "", t("overview.attention") + " · " + attentionTasks.length));
    const list = node("div", "overview-list");
    attentionTasks.forEach(function (task) {
      list.append(overviewRow(
        task,
        t("exec.status." + task.executionStatus),
        "has-inputs",
        onSelect
      ));
    });
    attentionBlock.append(list);
    wrap.append(attentionBlock);
  }

  // Active work and the freshest updates sit side by side on wide screens, so
  // the overview fills the reading surface instead of ending at the inbox.
  const duo = node("div", "overview-duo");
  const activeTasks = (state.tasks || []).filter(function (task) { return task.status === "active"; });
  if (activeTasks.length) {
    duo.append(overviewBlock(t("overview.activeNow"), activeTasks, t, locale, onSelect));
  }
  const recentTasks = (state.tasks || []).slice().sort(byNewest).slice(0, 8);
  if (recentTasks.length) {
    duo.append(overviewBlock(t("overview.recent"), recentTasks, t, locale, onSelect));
  }
  if (duo.childNodes.length) wrap.append(duo);
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

const RUN_PAGE_SIZE = 12;
const LIST_PAGE_SIZE = 10;
const RUN_FILTERS = ["all", "active", "yielded", "failed"];

function runFilterRow(sortedRuns, t, onChange) {
  const row = node("div", "filter-row run-filter");
  const buttons = [];
  RUN_FILTERS.forEach(function (status) {
    const count = status === "all"
      ? sortedRuns.length
      : sortedRuns.filter(function (run) { return run.status === status; }).length;
    if (status !== "all" && count === 0) return;
    const btn = node("button", "filter-chip");
    btn.type = "button";
    btn.dataset.status = status;
    if (status !== "all") btn.append(node("span", "filter-dot " + status));
    btn.append(document.createTextNode(status === "all" ? t("status.all") : t("run." + status)));
    btn.append(node("span", "filter-count", String(count)));
    btn.addEventListener("click", function () { onChange(status); });
    buttons.push({ status: status, element: btn });
    row.append(btn);
  });
  return {
    row: row,
    sync: function (active) {
      buttons.forEach(function (entry) {
        entry.element.classList.toggle("is-active", entry.status === active);
      });
    }
  };
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

  // Task-first execution status: the derived status, owner, next action, and
  // the attention/blocker facts behind it.
  const band = executionBand(data.execution, t, locale);
  if (band) summaryBody.append(band);
  const observability = data.observability || (data.execution && data.execution.observability);
  const metrics = observabilityMetricCard(observability, t);
  if (metrics) summaryBody.append(metrics);

  if (task.completionSummary) {
    const conclusion = node("div", "conclusion");
    conclusion.append(node("h3", "", t("detail.conclusion")));
    conclusion.append(richText(null, task.completionSummary, t));
    conclusion.append(conclusionMeta(task, t, locale, "completed"));
    summaryBody.append(conclusion);
  } else if (task.status === "retired" || task.retirementSummary) {
    const conclusion = node("div", "conclusion archived");
    conclusion.append(node("h3", "", t("detail.retired")));
    if (task.retirementSummary) conclusion.append(richText(null, task.retirementSummary, t));
    if (task.replacementTaskId) {
      conclusion.append(node("p", "muted", t("detail.replacement") + " · " + task.replacementTaskId));
    }
    conclusion.append(conclusionMeta(task, t, locale, "retired"));
    summaryBody.append(conclusion);
  } else if (task.status === "archived" || task.archiveSummary || task.archiveReason) {
    const conclusion = node("div", "conclusion archived");
    conclusion.append(node("h3", "", t("detail.archived")));
    if (task.archiveSummary) conclusion.append(richText(null, task.archiveSummary, t));
    if (task.archiveReason) conclusion.append(node("p", "muted", task.archiveReason));
    conclusion.append(conclusionMeta(task, t, locale, "archived"));
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

  const stalledRuns = data.runtimeHealth && data.runtimeHealth.needsAttentionRuns
    ? data.runtimeHealth.needsAttentionRuns
    : [];
  if (stalledRuns.length) {
    const runtimeHealthBody = node("div", "section-body");
    stalledRuns.forEach(function (run) {
      const card = node("article", "record-card");
      card.append(
        node("strong", "", run.roleName + " · " + run.runId),
        node("p", "record-copy", (run.kind || "workflow-not-progressing") + " · " + (run.classification || "truly-stalled")),
        node("small", "", t("detail.lastProgress") + " · " + formatDateTime(run.progressAt, locale))
      );
      runtimeHealthBody.append(card);
    });
    scaffold.append(anchorSection(
      "detail-health",
      sectionHead(t("detail.runtimeHealth"), { count: stalledRuns.length }),
      runtimeHealthBody
    ));
  }

  if (observability && observability.dag) {
    const dagBody = node("div", "section-body");
    dagBody.append(dagGraph(observability.dag, t));
    scaffold.append(anchorSection(
      "detail-dag",
      sectionHead(t("detail.dag"), { count: observability.dag.nodes.length }),
      dagBody
    ));
  }

  // 3. Focus (anchor #detail-focus) — brief + technical approach
  const focusBody = node("div", "section-body");
  if (data.brief) {
    const focusCard = node("article", "record-card");
    focusCard.append(richText(t("detail.focus"), data.brief.currentFocus || data.brief.objective, t));
    if (data.brief.technicalApproach) {
      focusCard.append(richText(t("detail.technicalApproach"), data.brief.technicalApproach, t, { muted: true }));
    }
    if (data.brief.leaderSummary) focusCard.append(richText(t("detail.leaderSummary"), data.brief.leaderSummary, t, { muted: true }));
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

  // 5. Runs (anchor #detail-exec) — execution grid with status filter + paging
  const execWrap = node("div", "section-body");
  const execBody = node("div", "run-grid");
  const sortedRuns = data.runs.slice().sort(byNewest);
  if (!sortedRuns.length) {
    execBody.append(emptyRow(t, "empty.runs"));
    execWrap.append(execBody);
  } else {
    let activeRunFilter = "all";
    const filter = runFilterRow(sortedRuns, t, function (status) {
      activeRunFilter = status;
      filter.sync(status);
      renderRunGrid();
    });
    function renderRunGrid() {
      clear(execBody);
      const visible = activeRunFilter === "all"
        ? sortedRuns
        : sortedRuns.filter(function (run) { return run.status === activeRunFilter; });
      pagedList(execBody, visible, RUN_PAGE_SIZE, function (run) {
        return runCard(run, t, locale);
      }, t);
    }
    filter.sync(activeRunFilter);
    execWrap.append(filter.row, execBody);
    renderRunGrid();
  }
  scaffold.append(anchorSection("detail-exec",
    sectionHead(t("detail.execution"), { count: data.runs.length }),
    execWrap));

  // 5b. Reviews (anchor #detail-reviews) — review rounds for yielded candidates
  const reviewBody = node("div", "row-list");
  const sortedRounds = (data.reviewRounds || []).slice().sort(byNewest);
  if (!sortedRounds.length) {
    reviewBody.append(emptyRow(t));
  } else {
    pagedList(reviewBody, sortedRounds, LIST_PAGE_SIZE, function (round) {
      return reviewCard(round, t, locale);
    }, t);
  }
  scaffold.append(anchorSection("detail-reviews",
    sectionHead(t("detail.reviews"), { count: sortedRounds.length }),
    reviewBody));

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
    pagedList(historyBody, historyEvents, LIST_PAGE_SIZE, function (event) {
      return historyEventRow(event, t, locale);
    }, t);
  }
  scaffold.append(anchorSection("detail-history",
    sectionHead(t("tabs.history"), { count: historyEvents.length }),
    historyBody));

  // 8. Messages (anchor #detail-messages)
  const messagesBody = node("div", "row-list");
  if (!data.messages.length) {
    messagesBody.append(emptyRow(t));
  } else {
    pagedList(messagesBody, data.messages.slice().sort(byNewest), LIST_PAGE_SIZE, function (message) {
      return messageCard(message, t, locale);
    }, t);
  }
  scaffold.append(anchorSection("detail-messages",
    sectionHead(t("detail.messages"), { count: data.messages.length }),
    messagesBody));

  detail.append(scaffold);
}
`;
