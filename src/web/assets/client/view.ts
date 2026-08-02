export const VIEW_SCRIPT = `
const statuses = [
  "all",
  "active",
  "draft",
  "completed",
  "cancelled",
  "superseded",
  "abandoned",
  "archived"
];

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

// Like metaItem, but for long paths: monospace value with a full-path tooltip.
function pathMetaItem(label, value) {
  const item = node("span", "detail-meta-item");
  const path = node("span", "meta-path", value);
  path.title = value;
  item.append(node("small", "", label), path);
  return item;
}

function statBadge(count, label) {
  const badge = node("span", "task-stat");
  badge.append(node("b", "", String(count)), node("span", "", label));
  return badge;
}

// view.ts compiles to a standalone browser script with no imports, so the
// adapter catalog (src/agent/adapterCatalog.ts) is mirrored inline here.
const adapterLabels = { codex: "Codex", claude: "Claude" };
function adapterLabel(adapterId) {
  return adapterLabels[adapterId] || adapterId;
}

function chip(text, extraClass) {
  return node("span", "chip" + (extraClass ? " " + extraClass : ""), text);
}

// Compact adapter/model/effort chips for a run or an active Role binding.
function agentBadge(agent) {
  if (!agent) return null;
  const badge = node("span", "agent-badge");
  if (agent.adapterId) badge.append(chip(adapterLabel(agent.adapterId), "is-adapter"));
  if (agent.model) badge.append(chip(agent.model));
  if (agent.effort) badge.append(chip(agent.effort));
  return badge.childNodes.length ? badge : null;
}

// A small eyebrow label above a wrapping row of chips. Returns null when empty
// so callers can guard with a truthy check.
function chipRow(label, values, activeValue) {
  const list = (values || []).filter(function (value) { return value !== undefined && value !== null && value !== ""; });
  if (!list.length) return null;
  const block = node("div", "chip-block");
  block.append(node("small", "", label));
  const row = node("div", "chip-row");
  list.forEach(function (value) {
    row.append(chip(String(value), activeValue !== undefined && value === activeValue ? "is-active" : ""));
  });
  block.append(row);
  return block;
}

// A small eyebrow label above a bulleted criteria list. Returns null when empty.
function criteriaList(label, items) {
  const list = (items || []).filter(Boolean);
  if (!list.length) return null;
  const block = node("div", "chip-block");
  block.append(node("small", "", label));
  const listElement = node("ul", "criteria-list");
  list.forEach(function (item) { listElement.append(node("li", "", item)); });
  block.append(listElement);
  return block;
}

// A small eyebrow label above a paragraph of copy. Returns null when empty.
function labeledCopy(label, text) {
  if (!text) return null;
  const block = node("div", "labeled-copy");
  block.append(node("small", "", label), node("p", "record-copy", text));
  return block;
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
    ["cancelled", counts ? counts.cancelled : 0],
    ["superseded", counts ? counts.superseded : 0],
    ["abandoned", counts ? counts.abandoned : 0],
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

export function renderTaskDetail(detail, data, t, locale, actions) {
  actions = actions || {};
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
  if (task.projectNames?.length) {
    taskMeta.append(metaItem(t("detail.project"), task.projectNames.join(", ")));
  }
  if (task.cwd) taskMeta.append(pathMetaItem(t("detail.workspace"), task.cwd));
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
  } else if (task.retirementSummary || ["cancelled", "superseded", "abandoned"].includes(task.status)) {
    const conclusion = node("section", "conclusion retired");
    conclusion.append(node("h3", "", t("detail.retired")));
    if (task.retirementSummary) conclusion.append(node("p", "", task.retirementSummary));
    if (task.replacementTaskId) {
      conclusion.append(node("p", "record-copy muted", t("detail.replacement") + " · " + task.replacementTaskId));
    }
    const meta = node("div", "run-meta");
    if (task.retiredBy) {
      meta.append(node("span", "", t("detail.retiredBy") + " · " + authorName(t, task.retiredBy)));
    }
    if (task.retiredAt) meta.append(node("time", "", formatDateTime(task.retiredAt, locale)));
    if (meta.childNodes.length) conclusion.append(meta);
    detail.append(conclusion);
  } else if (task.status === "archived" || task.archiveSummary || task.archiveReason) {
    const conclusion = node("section", "conclusion archived");
    conclusion.append(node("h3", "", t("detail.archived")));
    if (task.archiveSummary) conclusion.append(node("p", "", task.archiveSummary));
    if (task.archiveReason) conclusion.append(node("p", "record-copy muted", task.archiveReason));
    const meta = node("div", "run-meta");
    if (task.archivedBy) {
      meta.append(node("span", "", t("detail.archivedBy") + " · " + authorName(t, task.archivedBy)));
    }
    if (task.archivedAt) meta.append(node("time", "", formatDateTime(task.archivedAt, locale)));
    if (meta.childNodes.length) conclusion.append(meta);
    detail.append(conclusion);
  }

  if (data.openInputs.length) {
    const inputSection = section(t("detail.attention") + " · " + data.openInputs.length);
    data.openInputs.forEach(function (input) {
      const card = node("div", "input-card");
      card.append(node("small", "", t("detail.openInput")), node("span", "", input.question));
      if (input.policy) {
        const policyMeta = node("div", "input-policy");
        if (input.policy.kind === "recommended") {
          policyMeta.append(statusPill(t, "policy", "recommended"));
          if (input.policy.timeoutAt) {
            policyMeta.append(node("span", "", t("input.timeoutAt") + " · " + relativeTime(input.policy.timeoutAt, locale, t)));
          }
        } else {
          policyMeta.append(statusPill(t, "policy", "required"));
        }
        card.append(policyMeta);
      }
      if (input.blockedRefs && input.blockedRefs.length) {
        const blocking = chipRow(t("input.blocking"), input.blockedRefs.map(function (ref) {
          return ref.type + " · " + ref.id;
        }));
        if (blocking) card.append(blocking);
      }
      const answers = node("div", "input-actions");
      if (input.choices && input.choices.length) {
        input.choices.forEach(function (choice) {
          const button = node("button", "input-answer", choice.label);
          button.type = "button";
          button.dataset.choice = choice.key;
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
      card.append(answers);
      inputSection.append(card);
    });
    detail.append(inputSection);
  }

  const briefSection = section(t("detail.focus"));
  if (data.brief) {
    briefSection.append(node("div", "brief-focus", data.brief.currentFocus || data.brief.objective));
    if (data.brief.technicalApproach) {
      const approach = labeledCopy(
        t("detail.technicalApproach"),
        data.brief.technicalApproach
      );
      if (approach) briefSection.append(approach);
    }
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
    if (run.workItemId) {
      identity.append(node("span", "run-id", t("detail.workItem") + " · " + run.workItemId));
    }
    runHead.append(identity, statusPill(t, "run", run.status));
    card.append(runHead);

    const metadata = node("div", "run-meta");
    metadata.append(node("span", "", t("mode." + run.mode)));
    metadata.append(node("span", "", t(run.deliveredAt ? "delivery.delivered" : "delivery.pending")));
    const badge = run.effective ? agentBadge(run.effective) : null;
    if (badge) metadata.append(badge);
    if (run.effective) {
      metadata.append(node("span", "", t("detail.effective") + " · r"
        + run.effective.sourceDesiredRevision));
      metadata.append(node("span", "", t("detail.access") + " · "
        + run.effective.access));
      metadata.append(node("span", "", t("detail.provenance") + " · "
        + run.effective.provenance));
    }
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

  const reviewSection = section(t("detail.reviews") + " · " + data.reviewRounds.length);
  const reviews = node("div", "row-list");
  if (!data.reviewRounds.length) reviews.append(emptyRow(t));
  data.reviewRounds.slice().sort(byNewest).forEach(function (round) {
    const card = node("article", "record-card");
    const row = node("div", "row record-head");
    row.append(node("strong", "", round.id), statusPill(t, "review", round.status));
    card.append(row);
    const metadata = node("div", "run-meta");
    metadata.append(node("span", "", round.reviewerRoleName));
    metadata.append(node("span", "", round.workItemId + " · " + round.candidateId));
    metadata.append(node("span", "", t("detail.reviewBase") + " · "
      + round.reviewBaseProvenance + " · " + (round.reviewBaseCommit || "unavailable")));
    if (round.workspace) {
      metadata.append(node("span", "", t("detail.workspace") + " · " + round.workspace.root));
    }
    if (round.evidenceCommit) {
      metadata.append(node("span", "", t("detail.evidence") + " · " + round.evidenceCommit));
    }
    card.append(metadata);
    if (round.checks && round.checks.length) {
      card.append(node("p", "record-copy", t("detail.checks") + " · "
        + round.checks.map(function (check) {
          return check.name + "=" + check.outcome;
        }).join(", ")));
    }
    if (round.summary) card.append(node("p", "record-copy", round.summary));
    reviews.append(card);
  });
  reviewSection.append(reviews);
  detail.append(reviewSection);

  const workSection = section(t("detail.workItems") + " · " + data.workItems.length);
  const work = node("div", "row-list");
  if (!data.workItems.length) work.append(emptyRow(t));
  const workItemTitles = {};
  data.workItems.forEach(function (item) { workItemTitles[item.id] = item.title; });
  data.workItems.slice().sort(byNewest).forEach(function (item) {
    const card = node("article", "record-card");
    const row = node("div", "row record-head");
    const headPills = node("span", "record-head-pills");
    headPills.append(statusPill(t, "work", item.status));
    if (item.workspaceDisposition) headPills.append(statusPill(t, "disposition", item.workspaceDisposition));
    row.append(node("strong", "", item.title), headPills);
    card.append(row);
    const metadata = node("div", "run-meta");
    if (item.assignee) metadata.append(node("span", "", t("detail.assignee") + " · " + item.assignee));
    metadata.append(node("span", "", item.id));
    metadata.append(node("time", "", formatDateTime(item.updatedAt, locale)));
    card.append(metadata);
    if (item.objective && item.objective !== item.title) {
      const objective = labeledCopy(t("detail.objective"), item.objective);
      if (objective) card.append(objective);
    }
    const writeProjects = chipRow(
      t("detail.writeProjects"),
      item.writeProjectIds || []
    );
    if (writeProjects) card.append(writeProjects);
    const acceptance = criteriaList(t("detail.acceptance"), item.acceptance);
    if (acceptance) card.append(acceptance);
    if (item.dependsOn && item.dependsOn.length) {
      const deps = chipRow(t("detail.dependsOn"), item.dependsOn.map(function (id) {
        return workItemTitles[id] || id;
      }));
      if (deps) card.append(deps);
    }
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
    const roleActions = node("div", "record-actions");
    const activeBinding = role.agentBindings && role.agentBindings[role.activeAgentId];
    const activeBadge = activeBinding
      ? agentBadge({
          adapterId: activeBinding.adapterId,
          model: activeBinding.config && activeBinding.config.model,
          effort: activeBinding.config && activeBinding.config.effort
        })
      : null;
    const agentMeta = node("div", "run-meta");
    agentMeta.append(node("span", "", t("detail.desiredAgent") + " · " + role.activeAgentId));
    if (activeBadge) agentMeta.append(activeBadge);
    agentMeta.append(node("span", "", t("detail.desired") + " · r"
      + role.launchRevision));
    agentMeta.append(node("span", "", t("detail.accessCeiling") + " · "
      + role.defaultAccess));
    roleActions.append(agentMeta);
    const open = node("button", "input-answer", t("actions.openRole"));
    open.type = "button";
    open.addEventListener("click", function () {
      if (actions.openTerminal) actions.openTerminal({
        scope: "task",
        taskId: task.id,
        roleName: role.name
      });
    });
    roleActions.append(open);
    card.append(roleActions);
    if (role.effectiveLaunch) {
      const effectiveMeta = node("div", "run-meta");
      effectiveMeta.append(node("span", "", t("detail.effectiveAgent") + " · "
        + role.effectiveLaunch.agentId));
      const effectiveBadge = agentBadge(role.effectiveLaunch);
      if (effectiveBadge) effectiveMeta.append(effectiveBadge);
      effectiveMeta.append(node("span", "", t("detail.effective") + " · r"
        + role.effectiveLaunch.sourceDesiredRevision));
      effectiveMeta.append(node("span", "", t("detail.access") + " · "
        + role.effectiveLaunch.access));
      effectiveMeta.append(node("span", "", t("detail.provenance") + " · "
        + role.effectiveLaunch.provenance));
      effectiveMeta.append(node("span", "", role.launchDrift
        ? t("launch.drift")
        : t("launch.current")));
      card.append(effectiveMeta);
    }
    if (role.description) card.append(node("p", "record-copy", role.description));
    const bindingIds = role.agentBindings ? Object.keys(role.agentBindings) : [];
    if (bindingIds.length > 1) {
      const bindings = chipRow(
        t("detail.agents"),
        bindingIds.map(function (id) {
          const binding = role.agentBindings[id];
          const model = binding.config && binding.config.model;
          return adapterLabel(binding.adapterId) + (model ? " · " + model : "");
        }),
        activeBinding
          ? adapterLabel(activeBinding.adapterId)
            + (activeBinding.config && activeBinding.config.model ? " · " + activeBinding.config.model : "")
          : undefined
      );
      if (bindings) card.append(bindings);
    }
    const skills = chipRow(t("detail.skills"), role.skills);
    if (skills) card.append(skills);
    const responsibilities = criteriaList(t("detail.responsibilities"), role.responsibilities);
    if (responsibilities) card.append(responsibilities);
    const constraints = criteriaList(t("detail.constraints"), role.constraints);
    if (constraints) card.append(constraints);
    const expected = labeledCopy(t("detail.expectedOutput"), role.expectedOutput);
    if (expected) card.append(expected);
    if (role.workspace) {
      const workspace = node("div", "run-meta");
      workspace.append(pathMetaItem(t("detail.workspace"), role.workspace));
      card.append(workspace);
    }
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
    if (message.kind) metadata.append(statusPill(t, "messageKind", message.kind));
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
