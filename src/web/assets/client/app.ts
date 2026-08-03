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
  detail: document.querySelector("#detail"),
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
  generatedAt: null,
  filter: "all",
  query: "",
  selected: null,
  detail: null
};
let terminalSession = null;
let terminalStateKey = "terminal.closed";

const i18n = createI18n(elements.locale);
createThemeController(elements.theme);

function detailActions() {
  return {
    answerInput: answerInput,
    openTerminal: openTerminal
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
  elements.detail.scrollTop = 0;
}

function renderCurrentDetail() {
  if (state.detail) {
    renderTaskDetail(
      elements.detail,
      state.detail,
      i18n.t,
      i18n.getLocale(),
      detailActions()
    );
  } else if (!state.selected) {
    showOverview();
  }
}

function renderDynamicContent() {
  renderFilters(elements.filters, state, i18n.t, function (filter) {
    state.filter = filter;
    renderDynamicContent();
  });
  renderTasks(elements.tasks, state, i18n.t, i18n.getLocale(), selectTask);
  const preserveScroll = state.detail !== null && elements.detail.scrollTop > 0;
  const savedScrollTop = elements.detail.scrollTop;
  renderCurrentDetail();
  if (preserveScroll) elements.detail.scrollTop = savedScrollTop;
  syncTabHighlight();
  updateMetrics();
}

function updateActiveTabFromScroll() {
  if (!state.detail || !elements.detailTabs) return;
  const tabs = Array.from(elements.detailTabs.querySelectorAll(".tab"));
  if (!tabs.length) return;
  const root = elements.detail;
  const rootTop = root.getBoundingClientRect().top;
  let activeId = tabs[0].dataset.target;
  let bestTop = -Infinity;
  tabs.forEach(function (tab) {
    const id = tab.dataset.target;
    if (!id) return;
    const el = root.querySelector("#" + id);
    if (!el) return;
    const top = el.getBoundingClientRect().top - rootTop;
    if (top <= 8 && top > bestTop) {
      bestTop = top;
      activeId = id;
    }
  });
  tabs.forEach(function (tab) {
    tab.classList.toggle("is-active", tab.dataset.target === activeId);
  });
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
  showOverview();
  renderTasks(elements.tasks, state, i18n.t, i18n.getLocale(), selectTask);
}

async function requestJson(path, options) {
  const response = await fetch(path, {
    ...options,
    headers: {
      accept: "application/json",
      ...(options && options.headers ? options.headers : {})
    }
  });
  if (!response.ok) {
    let message = "HTTP " + response.status;
    try {
      const body = await response.json();
      if (body && body.error) message = body.error;
    } catch {}
    throw new Error(message);
  }
  return response.json();
}

async function loadTaskDetail(taskId, showLoading) {
  if (showLoading) {
    renderLoading(elements.detail, i18n.t, "loading.detail");
    elements.detail.scrollTop = 0;
  }
  const savedScrollTop = showLoading ? 0 : elements.detail.scrollTop;
  const detail = await requestJson("/api/tasks/" + encodeURIComponent(taskId));
  if (state.selected !== taskId) return;
  state.detail = detail;
  renderCurrentDetail();
  elements.detail.scrollTop = savedScrollTop;
  setDetailActive(true);
  syncTabHighlight();
}

async function selectTask(taskId) {
  state.selected = taskId;
  state.detail = null;
  setDetailActive(true);
  renderTasks(elements.tasks, state, i18n.t, i18n.getLocale(), selectTask);
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
  try {
    await requestJson(
      "/api/tasks/" + encodeURIComponent(taskId)
        + "/inputs/" + encodeURIComponent(input.id) + "/answer",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-yui-web-token": token
        },
        body: JSON.stringify(answer)
      }
    );
    showToast(i18n.t("input.answered"));
    await refreshDashboard({ quiet: true });
  } catch {
    showToast(i18n.t("errors.answer"));
  }
}

async function refreshDashboard(options) {
  const quiet = options && options.quiet;
  if (!quiet) {
    elements.refresh.disabled = true;
    if (!state.tasks.length) renderLoading(elements.tasks, i18n.t, "loading.dashboard");
  }
  const previousInputs = state.counts ? state.counts.openInputs : null;
  try {
    const dashboard = await requestJson("/api/dashboard");
    state.tasks = dashboard.tasks;
    state.counts = dashboard.counts;
    state.attention = dashboard.attention || [];
    state.generatedAt = dashboard.generatedAt;
    if (state.selected && !state.tasks.some(function (task) { return task.id === state.selected; })) {
      clearSelection();
    } else {
      renderDynamicContent();
    }
    if (previousInputs !== null && dashboard.counts.openInputs > previousInputs) {
      showToast(i18n.t("input.new"));
    }
    if (state.selected && !quiet) {
      try { await loadTaskDetail(state.selected, false); } catch {}
    }
  } catch {
    if (!quiet) {
      renderError(elements.tasks, i18n.t("errors.dashboard"));
      showToast(i18n.t("errors.dashboard"));
    }
  } finally {
    if (!quiet) elements.refresh.disabled = false;
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
    elements.detailTabs.querySelectorAll(".tab").forEach(function (other) {
      other.classList.toggle("is-active", other === tab);
    });
  });
}

elements.search.addEventListener("input", function () {
  state.query = elements.search.value;
  renderTasks(elements.tasks, state, i18n.t, i18n.getLocale(), selectTask);
});
elements.refresh.addEventListener("click", function () { refreshDashboard(); });
elements.operatorTerminal.addEventListener("click", function () {
  openTerminal({ scope: "global", roleName: "operator" });
});
elements.detailBack.addEventListener("click", clearSelection);
elements.terminalClose.addEventListener("click", closeTerminalPanel);
document.addEventListener("keydown", function (event) {
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
i18n.subscribe(function () {
  renderDynamicContent();
  if (terminalSession) setTerminalState(terminalStateKey);
  if (!state.selected && elements.pageTitle) elements.pageTitle.textContent = i18n.t("page.title");
});
showOverview();

// Scroll-spy: keep the detail tab bar in sync with the visible section.
// Bound once on the scroll container; it reads tabs/sections from the live DOM
// so it survives detail re-renders.
elements.detail.addEventListener("scroll", updateActiveTabFromScroll, { passive: true });

refreshDashboard();
window.setInterval(function () { refreshDashboard({ quiet: true }); }, 5000);
`;
