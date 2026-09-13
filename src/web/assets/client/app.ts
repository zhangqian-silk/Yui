export const APP_SCRIPT = `
import { Terminal } from "/assets/vendor/xterm.mjs";
import { FitAddon } from "/assets/vendor/addon-fit.mjs";
import { createI18n } from "/assets/js/i18n.js";
import { createThemeController } from "/assets/js/theme.js";
import {
  renderError,
  renderFilters,
  renderLoading,
  renderOverview,
  renderTaskDetail,
  renderTasks
} from "/assets/js/view.js";

const elements = {
  locale: document.querySelector("#locale-select"),
  theme: document.querySelector("#theme-select"),
  refresh: document.querySelector("#refresh"),
  operatorTerminal: document.querySelector("#operator-terminal"),
  search: document.querySelector("#search"),
  filters: document.querySelector("#status-filters"),
  tasks: document.querySelector("#task-list"),
  catalogNext: document.querySelector("#catalog-next"),
  catalogReset: document.querySelector("#catalog-reset"),
  catalogCount: document.querySelector("#catalog-count"),
  catalogAttentionReset: document.querySelector("#catalog-attention-reset"),
  detail: document.querySelector("#detail"),
  mainCol: document.querySelector(".main-col"),
  topbar: document.querySelector(".topbar"),
  detailBack: document.querySelector("#detail-back"),
  detailTabs: document.querySelector("#detail-tabs"),
  pageTitle: document.querySelector("#page-title"),
  toast: document.querySelector("#toast"),
  lastSync: document.querySelector("#last-sync"),
  terminalPanel: document.querySelector("#terminal-panel"),
  terminalHost: document.querySelector("#terminal-host"),
  terminalTitle: document.querySelector("#terminal-title"),
  terminalState: document.querySelector("#terminal-state span"),
  terminalClose: document.querySelector("#terminal-close")
};

const token = document.querySelector('meta[name="yui-web-token"]').content;
const state = {
  tasks: [],
  counts: null,
  attention: [],
  catalogAttention: null,
  catalogScope: null,
  catalogAll: false,
  catalogTotal: 0,
  catalogCursor: null,
  nextCursor: null,
  attentionFilter: null,
  generatedAt: null,
  filter: "all",
  query: "",
  selected: null,
  detail: null,
  detailKey: null
};
const VALID_FILTERS = ["all", "active", "draft", "completed", "cancelled", "archived"];
const VALID_ATTENTION = ["openInputs", "pendingOperations", "unknownOperations", "executionSignals"];
let terminalSession = null;
let terminalStateKey = "terminal.closed";
const submittedRequests = new Set();

const i18n = createI18n(elements.locale);
createThemeController(elements.theme);

// --- URL / history ---------------------------------------------------------
// Reflect the current view (selected task, status filter, search query) in the
// query string so the browser back/forward buttons work and the page can be
// deep-linked / refreshed without losing context.
function readQuery() {
  return new URLSearchParams(window.location.search);
}

function buildSearch(params) {
  const entries = Array.from(params.entries()).filter(function (entry) {
    return entry[1] !== "" && entry[1] !== null && entry[1] !== undefined;
  });
  if (!entries.length) return "";
  return "?" + entries.map(function (entry) {
    return encodeURIComponent(entry[0]) + "=" + encodeURIComponent(entry[1]);
  }).join("&");
}

function applyUrl(params, options) {
  const replace = options && options.replace;
  const search = buildSearch(params);
  const url = window.location.pathname + search + window.location.hash;
  if (replace) {
    history.replaceState({ task: params.get("task") || null }, "", url);
  } else {
    history.pushState({ task: params.get("task") || null }, "", url);
  }
}

function urlTaskId() {
  return readQuery().get("task") || null;
}

// The visible detail section is part of the URL (?task=X&section=exec) so a
// refresh or a shared link lands on the same section. Writes always replace —
// section moves are not history entries.
function setSectionParam(targetId) {
  if (!state.detail) return;
  const params = readQuery();
  const section = String(targetId).replace(/^detail-/, "");
  if (params.get("section") === section) return;
  params.set("section", section);
  applyUrl(params, { replace: true });
}

let sectionParamTimer = null;
function queueSectionParamSync(targetId) {
  if (sectionParamTimer !== null) window.clearTimeout(sectionParamTimer);
  sectionParamTimer = window.setTimeout(function () {
    sectionParamTimer = null;
    setSectionParam(targetId);
  }, 250);
}

function syncUrlFromState(options) {
  const params = readQuery();
  if (state.selected) params.set("task", state.selected);
  else {
    params.delete("task");
    params.delete("section");
  }
  if (state.filter && state.filter !== "all") params.set("filter", state.filter);
  else params.delete("filter");
  if (state.query) params.set("q", state.query);
  else params.delete("q");
  if (state.attentionFilter) params.set("attention", state.attentionFilter);
  else params.delete("attention");
  if (state.catalogAll) params.set("all", "true");
  else params.delete("all");
  applyUrl(params, options);
}

function detailActions() {
  return {
    answerInput: answerInput,
    openTerminal: openTerminal,
    inspect: inspectRecord,
    sendMessage: (taskId, body, requestId, intent) => submitMutation(taskId + "/messages",
      "/api/tasks/" + encodeURIComponent(taskId) + "/messages",
      { body, requestId, ...(intent === undefined ? {} : { intent }) }),
    controlInput: (taskId, payload, requestId) => submitMutation(taskId + "/control/" + requestId,
      "/api/tasks/" + encodeURIComponent(taskId) + "/control", payload),
    updateTask: (taskId, patch, requestId) => submitMutation(taskId + "/metadata",
      "/api/tasks/" + encodeURIComponent(taskId) + "/metadata", { patch, requestId }),
    panels: (taskId) => requestJson("/api/tasks/" + encodeURIComponent(taskId) + "/panels",
      { signal: AbortSignal.timeout(3000) }),
    readPanel: (taskId, ref, input) => requestJson("/api/tasks/" + encodeURIComponent(taskId) + "/panels", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ref, input }),
      signal: AbortSignal.timeout(3000)
    })
  };
}

function updateMetrics() {
  elements.lastSync.textContent = state.generatedAt
    ? new Intl.DateTimeFormat(i18n.getLocale(), { hour: "2-digit", minute: "2-digit", second: "2-digit" }).format(new Date(state.generatedAt))
    : "—";
}

function setDetailActive(active) {
  document.body.classList.toggle("detail-active", active);
  elements.detailBack.hidden = !active;
  if (elements.detailTabs) elements.detailTabs.hidden = !active;
  if (elements.pageTitle) {
    if (active) {
      elements.pageTitle.textContent = state.detail
        ? state.detail.task.title
        : (state.tasks.find(function (task) { return task.id === state.selected; }) || { title: "…" }).title;
      elements.pageTitle.dataset.i18n = "";
    } else {
      elements.pageTitle.textContent = i18n.t("page.title");
      elements.pageTitle.dataset.i18n = "page.title";
    }
  }
}

function showOverview() {
  renderOverview(elements.detail, state, i18n.t, i18n.getLocale(), selectTask);
  elements.mainCol.scrollTop = 0;
}

// Fingerprint of the rendered detail payload. Quiet polling re-renders the
// whole detail on every tick; skipping identical payloads keeps local UI state
// (expanded blocks, list pages) alive and avoids DOM churn.
let renderedDetailKey = null;

function detailKeyOf(detail) {
  const text = JSON.stringify(detail);
  let hash = 0;
  for (let i = 0; i < text.length; i += 1) {
    hash = (hash * 31 + text.charCodeAt(i)) | 0;
  }
  return text.length + ":" + hash;
}

// The optional observation arrives after the core snapshot has already been
// rendered, so the render key has to cover the observed facts the detail
// actually draws or they would stay stale until the core snapshot changed.
// Only the rendered identity is included: observation timestamps advance on
// every poll and would re-render the detail continuously.
function runtimeSignatureOf(detail) {
  const roles = (detail.runtime && detail.runtime.roles) || [];
  return detail.runtimeStatus + "|" + roles.map(function (role) {
    const session = role.runtimeSession;
    return role.name + ":" + (session
      ? session.nativeSessionId + "/" + session.status
      : "-");
  }).join(",");
}

function renderCurrentDetail(force) {
  if (state.detail) {
    // Polling must not replace an unsent draft or an in-flight form, including
    // after the user has moved focus. This is view state, never Task state.
    if (elements.detail.dataset.taskId === state.detail.task.id
      && (elements.detail.querySelector('[data-unsent="true"]')
        || elements.detail.contains(document.activeElement))) return;
    const key = i18n.getLocale() + "|" + state.detailKey
      + "|" + runtimeSignatureOf(state.detail);
    if (!force && key === renderedDetailKey) return;
    renderTaskDetail(
      elements.detail,
      state.detail,
      i18n.t,
      i18n.getLocale(),
      detailActions()
    );
    renderedDetailKey = key;
  } else if (!state.selected) {
    renderedDetailKey = null;
    showOverview();
  }
}

function renderDynamicContent() {
  renderFilters(elements.filters, state, i18n.t, function (filter) {
    state.filter = filter;
    state.attentionFilter = null;
    state.catalogAll = false;
    syncUrlFromState({ replace: false });
    resetCatalog();
  });
  elements.catalogNext.disabled = !state.nextCursor || refreshing;
  elements.catalogCount.textContent = i18n.t("catalog.count")
    .replace("{shown}", String(state.tasks.length)).replace("{total}", String(state.catalogTotal))
    + (state.attentionFilter ? " · " + i18n.t("catalog." + state.attentionFilter) : "");
  elements.catalogAttentionReset.hidden = !state.attentionFilter;
  const savedTaskScroll = elements.tasks.scrollTop;
  renderTasks(elements.tasks, state, i18n.t, i18n.getLocale(), selectTask);
  elements.tasks.scrollTop = savedTaskScroll;
  const preserveScroll = state.detail !== null && elements.mainCol.scrollTop > 0;
  const savedScrollTop = elements.mainCol.scrollTop;
  renderCurrentDetail();
  if (preserveScroll) elements.mainCol.scrollTop = savedScrollTop;
  syncTabHighlight();
  updateMetrics();
  updateStickyOffsets();
}

function updateStickyOffsets() {
  const root = document.documentElement;
  if (elements.topbar) {
    root.style.setProperty("--topbar-h", elements.topbar.offsetHeight + "px");
  }
  if (elements.detailTabs && !elements.detailTabs.hidden) {
    root.style.setProperty("--tabs-h", elements.detailTabs.offsetHeight + "px");
  }
}

function updateActiveTabFromScroll() {
  if (!state.detail || !elements.detailTabs) return;
  const tabs = Array.from(elements.detailTabs.querySelectorAll(".tab"));
  if (!tabs.length) return;
  const root = elements.mainCol;
  const rootTop = root.getBoundingClientRect().top;
  // Sections sit below the sticky topbar + tab bar (see .anchor scroll-margin),
  // so "current" means the last section whose top crossed that stacked offset.
  const stickyH = (elements.topbar ? elements.topbar.offsetHeight : 0)
    + (elements.detailTabs.hidden ? 0 : elements.detailTabs.offsetHeight);
  const threshold = stickyH + 8;
  let activeId = tabs[0].dataset.target;
  let bestTop = -Infinity;
  tabs.forEach(function (tab) {
    const id = tab.dataset.target;
    if (!id) return;
    const el = root.querySelector("#" + id);
    if (!el) return;
    const top = el.getBoundingClientRect().top - rootTop;
    if (top <= threshold && top > bestTop) {
      bestTop = top;
      activeId = id;
    }
  });
  tabs.forEach(function (tab) {
    tab.classList.toggle("is-active", tab.dataset.target === activeId);
  });
  if (state.detail) queueSectionParamSync(activeId);
}

function syncTabHighlight() {
  // Compute the active tab from the current scroll position. The module-level
  // scroll listener keeps it in sync afterwards.
  updateActiveTabFromScroll();
}

function showToast(message) {
  elements.toast.textContent = message;
  elements.toast.classList.add("show");
  window.setTimeout(function () { elements.toast.classList.remove("show"); }, 3200);
}

function clearSelection() {
  state.selected = null;
  state.detail = null;
  setDetailActive(false);
  syncUrlFromState({ replace: !urlTaskId() });
  showOverview();
  const savedTaskScroll = elements.tasks.scrollTop;
  renderTasks(elements.tasks, state, i18n.t, i18n.getLocale(), selectTask);
  elements.tasks.scrollTop = savedTaskScroll;
}

async function requestJson(path, options) {
  const response = await fetch(path, {
    ...options,
    headers: {
      accept: "application/json",
      "x-yui-web-token": token,
      ...(options && options.headers ? options.headers : {})
    }
  });
  if (!response.ok) {
    let message = "HTTP " + response.status;
    let disposition = "unknown";
    try {
      const body = await response.json();
      if (body && body.error) message = body.error;
      if (body && body.disposition === "not-submitted") disposition = "not-submitted";
    } catch {}
    throw Object.assign(new Error(message), { disposition });
  }
  return response.json();
}

async function submitMutation(key, path, body) {
  if (submittedRequests.has(key)) throw new Error("An earlier submission is unresolved; read current facts.");
  submittedRequests.add(key);
  try {
    const receipt = await requestJson(path, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body)
    });
    submittedRequests.delete(key);
    return receipt;
  } catch (error) {
    if (error.disposition === "not-submitted") submittedRequests.delete(key);
    throw error;
  }
}

async function loadTaskDetail(taskId, showLoading) {
  if (showLoading) {
    renderLoading(elements.detail, i18n.t, "loading.detail");
    elements.mainCol.scrollTop = 0;
  }
  const savedScrollTop = showLoading ? 0 : elements.mainCol.scrollTop;
  const base = "/api/tasks/" + encodeURIComponent(taskId);
  // Rendering consumes the current snapshot, not event pages. Reconnect uses
  // this same read; the independent delta API retains its fixed-bound contract.
  const core = await requestJson(base + "/context");
  const taskEntry = core.records.find(function (entry) { return entry.ref.store === "task"; });
  if (!taskEntry) throw new Error("Task reference unavailable.");
  const task = taskEntry.omitted ? (await inspectRecord(taskId, taskEntry.ref)).value : taskEntry.value;
  const previous = state.detail && state.detail.task.id === taskId ? state.detail : null;
  const detail = {
    task, core,
    runtime: previous && previous.runtime,
    runtimeStatus: previous ? previous.runtimeStatus : "waiting",
    runtimeObservedAt: previous ? previous.runtimeObservedAt : new Date().toISOString()
  };
  if (state.selected !== taskId) return;
  state.detail = detail;
  state.detailKey = detailKeyOf(core);
  renderCurrentDetail();
  // Optional observation does not participate in core readiness or cursor.
  void requestJson(base, { signal: AbortSignal.timeout(1000) }).then(function (runtime) {
    if (state.detail !== detail) return;
    detail.runtime = runtime;
    detail.runtimeStatus = "available";
    detail.runtimeObservedAt = new Date().toISOString();
    updateRuntimePanel(detail);
  }).catch(function () {
    if (state.detail !== detail) return;
    detail.runtime = null;
    detail.runtimeStatus = "unavailable";
    detail.runtimeObservedAt = new Date().toISOString();
    updateRuntimePanel(detail);
  });
  // Reveal the tab bar before measuring/scroll so anchors land correctly.
  setDetailActive(true);
  updateStickyOffsets();
  // A section in the URL wins over the preserved scroll offset.
  const section = readQuery().get("section");
  const anchor = section ? elements.detail.querySelector("#detail-" + section) : null;
  if (anchor) {
    anchor.scrollIntoView({ block: "start" });
  } else {
    elements.mainCol.scrollTop = savedScrollTop;
  }
  syncTabHighlight();
}

function updateRuntimePanel(detail) {
  const status = elements.detail.querySelector("[data-runtime-status]");
  const value = elements.detail.querySelector("[data-runtime-value]");
  if (status) status.textContent = detail.runtimeStatus + " · " + detail.runtimeObservedAt;
  if (value) value.textContent = detail.runtime
    ? JSON.stringify({ roles: detail.runtime.roles, runtimeHealth: detail.runtime.runtimeHealth }, null, 2)
    : "";
  // Patching the panel in place is not enough: the observation also feeds facts
  // the detail rendered before it arrived. Re-render when the observed identity
  // has actually changed — renderCurrentDetail still compares the render key,
  // so an unchanged observation costs nothing and an unsent form is preserved.
  if (state.detail === detail) renderCurrentDetail();
}

async function inspectRecord(taskId, ref) {
  const query = new URLSearchParams({ store: ref.store, ref: ref.refId, digest: ref.digest });
  return requestJson("/api/tasks/" + encodeURIComponent(taskId) + "/inspect?" + query);
}

async function selectTask(taskId) {
  // Switching tasks drops the previous section; staying on the same task
  // (URL-driven loads, popstate) keeps it.
  if (urlTaskId() !== taskId) {
    const params = readQuery();
    params.delete("section");
    applyUrl(params, { replace: true });
  }
  state.selected = taskId;
  state.detail = null;
  renderedDetailKey = null;
  // When the selection is driven by the URL (initial load or popstate), the
  // URL already reflects the task id, so replace instead of pushing a
  // duplicate history entry.
  syncUrlFromState({ replace: state.selected === urlTaskId() });
  setDetailActive(true);
  const savedTaskScroll = elements.tasks.scrollTop;
  renderTasks(elements.tasks, state, i18n.t, i18n.getLocale(), selectTask);
  elements.tasks.scrollTop = savedTaskScroll;
  try {
    await loadTaskDetail(taskId, true);
  } catch {
    if (state.selected !== taskId) return;
    renderError(elements.detail, i18n.t("errors.detail"));
    showToast(i18n.t("errors.detail"));
  }
}

async function answerInput(input, answer) {
  if (!state.detail) return;
  const taskId = state.detail.task.id;
  const key = taskId + "/input/" + input.id;
  try {
    await submitMutation(key,
      "/api/tasks/" + encodeURIComponent(taskId)
        + "/inputs/" + encodeURIComponent(input.id) + "/answer",
      answer
    );
    showToast(i18n.t("input.answered"));
    submittedRequests.delete(key);
    await refreshDashboard({ quiet: true });
  } catch (error) {
    showToast(error.disposition === "not-submitted" ? error.message : i18n.getLocale().startsWith("zh")
      ? "回答结果未知；请刷新检查原问题，不要盲目重发。"
      : "Answer outcome unknown; refresh the original question before resubmitting.");
  }
}

let refreshing = false;
let catalogRequest = 0;
function resetCatalog() {
  state.catalogCursor = null;
  state.nextCursor = null;
  refreshDashboard();
}
async function refreshDashboard(options) {
  if (refreshing && options && options.quiet) return;
  const request = ++catalogRequest;
  refreshing = true;
  elements.catalogNext.disabled = true;
  const quiet = options && options.quiet;
  if (!quiet) {
    elements.refresh.disabled = true;
    if (!state.tasks.length) renderLoading(elements.tasks, i18n.t, "loading.dashboard");
  }
  const previousInputs = state.counts ? state.counts.openInputs : null;
  try {
    const query = new URLSearchParams({ view: "compact" });
    if (state.catalogAll) query.set("all", "true");
    if (state.filter !== "all") query.set("status", state.filter);
    if (state.query.trim()) query.set("search", state.query.trim());
    if (state.attentionFilter) query.set("attention", state.attentionFilter);
    if (state.catalogCursor) query.set("cursor", state.catalogCursor);
    const dashboard = await requestJson("/api/dashboard?" + query.toString());
    if (request !== catalogRequest) return;
    state.tasks = dashboard.tasks;
    state.counts = { ...dashboard.counts, openInputs: dashboard.attention.openInputs.count };
    state.catalogAttention = dashboard.attention;
    state.catalogScope = dashboard.scope;
    state.catalogTotal = dashboard.total;
    state.nextCursor = dashboard.nextCursor;
    state.attention = dashboard.attention.openInputs.refs.map(function (ref) {
      const task = state.tasks.find(function (entry) { return entry.id === ref.taskId; });
      return { taskId: ref.taskId, taskTitle: task ? task.title : ref.taskId };
    });
    state.generatedAt = new Date().toISOString();
    // A selected Task may live on another page or outside current filters.
    // Only its detail endpoint can establish that it no longer exists.
    renderDynamicContent();
    if (previousInputs !== null && state.counts.openInputs > previousInputs) {
      showToast(i18n.t("input.new"));
    }
    if (state.selected) {
      try { await loadTaskDetail(state.selected, false); } catch {
        showToast(i18n.getLocale().startsWith("zh") ? "连接不可用；保留上次读取。" : "Disconnected; showing the last read.");
      }
    }
  } catch {
    if (request !== catalogRequest) return;
    if (!quiet) {
      renderError(elements.tasks, i18n.t("errors.dashboard"));
      showToast(i18n.t("errors.dashboard"));
    }
  } finally {
    if (request === catalogRequest) {
      refreshing = false;
      elements.refresh.disabled = false;
      elements.catalogNext.disabled = !state.nextCursor;
    }
  }
}

function terminalUrl(target, columns, rows) {
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  const parameters = new URLSearchParams({
    scope: target.scope,
    role: target.roleName,
    cols: String(columns),
    rows: String(rows),
    token: token
  });
  if (target.scope === "task") parameters.set("task", target.taskId);
  return protocol + "//" + window.location.host + "/api/terminal?" + parameters.toString();
}

function setTerminalState(key) {
  terminalStateKey = key;
  elements.terminalState.textContent = i18n.t(key);
}

function terminalPanelOpen() {
  return !elements.terminalPanel.hidden;
}

function openTerminalPanel() {
  elements.terminalPanel.hidden = false;
  elements.terminalPanel.setAttribute("aria-hidden", "false");
  document.body.classList.add("terminal-active");
}

function closeTerminalPanel() {
  disposeTerminal();
  document.body.classList.remove("terminal-active");
  elements.terminalPanel.setAttribute("aria-hidden", "true");
  elements.terminalPanel.hidden = true;
}

function disposeTerminal() {
  if (!terminalSession) return;
  const current = terminalSession;
  terminalSession = null;
  current.resizeObserver.disconnect();
  current.input.dispose();
  current.socket.close();
  current.terminal.dispose();
  elements.terminalHost.replaceChildren();
}

function openTerminal(target) {
  disposeTerminal();
  elements.terminalTitle.textContent = target.scope === "task"
    ? target.taskId + " / " + target.roleName
    : target.roleName;
  setTerminalState("terminal.connecting");
  openTerminalPanel();

  const terminal = new Terminal({
    cursorBlink: true,
    scrollback: 0,
    convertEol: false,
    fontFamily: '"IBM Plex Mono","JetBrains Mono","SFMono-Regular",Consolas,monospace',
    fontSize: 13,
    theme: {
      background: "#080b11",
      foreground: "#e8eef6",
      cursor: "#49d6ff",
      selectionBackground: "#264b5d"
    }
  });
  const fit = new FitAddon();
  terminal.loadAddon(fit);
  terminal.open(elements.terminalHost);
  fit.fit();

  let writable = false;
  const socket = new WebSocket(terminalUrl(target, terminal.cols, terminal.rows));
  const input = terminal.onData(function (data) {
    if (writable && socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify({ type: "input", data: data }));
    }
  });
  const resizeObserver = new ResizeObserver(function () {
    if (!terminalSession || terminalSession.terminal !== terminal) return;
    fit.fit();
    if (socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify({
        type: "resize",
        columns: terminal.cols,
        rows: terminal.rows
      }));
    }
  });
  resizeObserver.observe(elements.terminalHost);

  socket.addEventListener("message", function (event) {
    let message;
    try {
      message = JSON.parse(event.data);
    } catch {
      return;
    }
    if (message.type === "ready") {
      writable = !message.readOnly;
      setTerminalState(writable ? "terminal.writable" : "terminal.readOnly");
      if (message.history && message.history.limit < message.history.target) {
        const number = new Intl.NumberFormat(i18n.getLocale());
        showToast(
          i18n.t("terminal.historyLimited")
            .replace("{current}", number.format(message.history.limit))
            .replace("{target}", number.format(message.history.target))
        );
      }
      terminal.focus();
    } else if (message.type === "data") {
      terminal.write(message.data);
    } else if (message.type === "exit") {
      setTerminalState("terminal.closed");
    } else if (message.type === "error") {
      setTerminalState("terminal.error");
      terminal.writeln("\\r\\n" + message.message);
    }
  });
  socket.addEventListener("close", function () {
    writable = false;
    setTerminalState("terminal.closed");
  });
  socket.addEventListener("error", function () {
    writable = false;
    setTerminalState("terminal.error");
  });

  terminalSession = { terminal, socket, input, resizeObserver };
}

if (elements.detailTabs) {
  elements.detailTabs.addEventListener("click", function (event) {
    const tab = event.target && event.target.closest ? event.target.closest(".tab") : null;
    if (!tab) return;
    const targetId = tab.dataset.target;
    if (!targetId || !elements.detail) return;
    const section = elements.detail.querySelector("#" + targetId);
    if (!section) return;
    section.scrollIntoView({ behavior: "smooth", block: "start" });
    setSectionParam(targetId);
    elements.detailTabs.querySelectorAll(".tab").forEach(function (other) {
      other.classList.toggle("is-active", other === tab);
    });
  });
}

let catalogSearchTimer = null;
elements.search.addEventListener("input", function () {
  state.query = elements.search.value;
  syncUrlFromState({ replace: true });
  window.clearTimeout(catalogSearchTimer);
  catalogSearchTimer = window.setTimeout(resetCatalog, 200);
});
elements.catalogNext.addEventListener("click", function () {
  if (!state.nextCursor) return;
  state.catalogCursor = state.nextCursor;
  refreshDashboard();
});
elements.catalogReset.addEventListener("click", function () {
  resetCatalog();
});
elements.catalogAttentionReset.addEventListener("click", function () {
  state.attentionFilter = null;
  state.catalogAll = false;
  syncUrlFromState({ replace: false });
  resetCatalog();
});
elements.detail.addEventListener("click", function (event) {
  const button = event.target.closest("[data-catalog-attention]");
  if (!button) return;
  state.attentionFilter = button.dataset.catalogAttention;
  state.catalogAll = state.catalogScope && state.catalogScope.archived === "included";
  state.filter = "all";
  state.query = "";
  elements.search.value = "";
  syncUrlFromState({ replace: false });
  resetCatalog();
});
elements.refresh.addEventListener("click", function () { refreshDashboard(); });
elements.operatorTerminal.addEventListener("click", function () {
  openTerminal({ scope: "global", roleName: "operator" });
});
const globalDialog = document.querySelector("#global-input-dialog");
const globalForm = document.querySelector("#global-input-form");
const globalRole = document.querySelector("#global-input-role");
const globalAction = document.querySelector("#global-input-action");
const globalBody = document.querySelector("#global-input-body");
const globalTarget = document.querySelector("#global-input-target");
const globalThen = document.querySelector("#global-input-then");
const globalSubmit = document.querySelector("#global-input-submit");
const globalReceipt = document.querySelector("#global-input-receipt");
const globalState = document.querySelector("#global-input-state");
document.querySelector("#global-input-open").addEventListener("click", () => globalDialog.showModal());
document.querySelector("#global-input-close").addEventListener("click", () => globalDialog.close());
globalAction.addEventListener("change", () => {
  document.querySelector("#global-input-body-label").hidden = globalAction.value === "interrupt";
  document.querySelector("#global-input-target-label").hidden = globalAction.value === "queue";
  document.querySelector("#global-input-then-label").hidden = globalAction.value !== "interrupt";
  globalBody.required = globalAction.value !== "interrupt";
  globalTarget.required = globalAction.value !== "queue";
});
document.querySelector("#global-input-inspect").addEventListener("click", async () => {
  try {
    const facts = await requestJson("/api/roles/" + encodeURIComponent(globalRole.value.trim()) + "/control");
    globalState.textContent = JSON.stringify(facts, null, 2);
    globalTarget.value = facts.turn?.nativeTurnId || facts.turn?.attemptId || "";
  } catch (error) { globalState.textContent = error.message; }
});
globalForm.addEventListener("submit", async event => {
  event.preventDefault();
  if (globalSubmit.disabled) return;
  globalSubmit.disabled = true;
  const role = globalRole.value.trim();
  const action = globalAction.value;
  const requestId = crypto.randomUUID();
  const input = { action, requestId };
  if (action !== "interrupt") input.body = globalBody.value;
  if (action !== "queue") input.expectedTarget = globalTarget.value.trim();
  if (action === "interrupt" && globalThen.value.trim()) input.thenMessage = globalThen.value.trim();
  globalReceipt.textContent = "Waiting for receipt · 等待回执 · " + requestId;
  try {
    const receipt = await submitMutation("global/" + role, "/api/roles/" + encodeURIComponent(role) + "/control", input);
    const status = receipt.steer || receipt.interrupt || receipt.delivery || {};
    globalReceipt.textContent = JSON.stringify(receipt);
    const unknown = ["pending", "delivery-unknown", "steer-unknown", "interrupt-unknown"].includes(status.state)
      || status.code === "DELIVERY_UNKNOWN";
    globalSubmit.disabled = unknown;
    if (!unknown && !status.code) globalBody.value = "";
  } catch (error) {
    globalReceipt.textContent = error.disposition === "not-submitted" ? error.message
      : "Outcome unknown; read state before acting. 结果未知，请先读取状态，不要重发。 · " + requestId;
    globalSubmit.disabled = error.disposition !== "not-submitted";
  }
});
elements.detailBack.addEventListener("click", clearSelection);
elements.terminalClose.addEventListener("click", closeTerminalPanel);
document.addEventListener("keydown", function (event) {
  if (globalDialog.open) return;
  const active = document.activeElement;
  const typing = active && ["INPUT", "SELECT", "TEXTAREA"].includes(active.tagName);
  if (event.key === "Escape" && terminalPanelOpen()) {
    closeTerminalPanel();
    return;
  }
  if (event.key === "Escape" && state.selected) {
    clearSelection();
    return;
  }
  if (typing) return;
  if (event.key === "/") {
    event.preventDefault();
    elements.search.focus();
    return;
  }
  if (event.key.toLowerCase() === "o" && !event.metaKey && !event.ctrlKey && !event.altKey) {
    openTerminal({ scope: "global", roleName: "operator" });
    return;
  }
  if (event.key.toLowerCase() === "r" && !event.metaKey && !event.ctrlKey && !event.altKey && !terminalPanelOpen()) {
    refreshDashboard();
  }
});

// Restore view state from the URL on load and on browser back/forward.
function applyStateFromUrl() {
  const params = readQuery();
  const filter = params.get("filter");
  if (filter && VALID_FILTERS.indexOf(filter) !== -1) {
    state.filter = filter;
  } else {
    state.filter = "all";
  }
  const query = params.get("q");
  state.query = query || "";
  state.attentionFilter = VALID_ATTENTION.includes(params.get("attention")) ? params.get("attention") : null;
  state.catalogAll = params.get("all") === "true";
  if (elements.search) elements.search.value = state.query;
  const taskId = params.get("task");
  if (taskId) {
    selectTask(taskId);
  } else {
    state.selected = null;
    state.detail = null;
    setDetailActive(false);
    showOverview();
  }
}

window.addEventListener("popstate", function () {
  applyStateFromUrl();
  resetCatalog();
});

i18n.subscribe(function () {
  renderDynamicContent();
  if (terminalSession) setTerminalState(terminalStateKey);
  if (!state.selected && elements.pageTitle) elements.pageTitle.textContent = i18n.t("page.title");
});
showOverview();

// Scroll-spy: keep the detail tab bar in sync with the visible section.
// Bound once on the scroll container; it reads tabs/sections from the live DOM
// so it survives detail re-renders.
elements.mainCol.addEventListener("scroll", updateActiveTabFromScroll, { passive: true });

applyStateFromUrl();
refreshDashboard();
window.setInterval(function () { refreshDashboard({ quiet: true }); }, 5000);
`;
