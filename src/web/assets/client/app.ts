export const APP_SCRIPT = `
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
  search: document.querySelector("#search"),
  filters: document.querySelector("#status-filters"),
  tasks: document.querySelector("#task-list"),
  detail: document.querySelector("#detail"),
  detailBack: document.querySelector("#detail-back"),
  toast: document.querySelector("#toast"),
  lastSync: document.querySelector("#last-sync"),
  active: document.querySelector("#metric-active"),
  inputs: document.querySelector("#metric-inputs"),
  completed: document.querySelector("#metric-completed"),
  total: document.querySelector("#metric-total")
};

const state = {
  tasks: [],
  counts: null,
  generatedAt: null,
  filter: "all",
  query: "",
  selected: null,
  detail: null
};

const i18n = createI18n(elements.locale);
createThemeController(elements.theme);

function updateMetrics() {
  const counts = state.counts;
  elements.active.textContent = counts ? String(counts.active) : "—";
  elements.inputs.textContent = counts ? String(counts.openInputs) : "—";
  elements.completed.textContent = counts ? String(counts.completed) : "—";
  elements.total.textContent = counts ? String(counts.total) : "—";
  elements.lastSync.textContent = state.generatedAt
    ? new Intl.DateTimeFormat(i18n.getLocale(), { hour: "2-digit", minute: "2-digit", second: "2-digit" }).format(new Date(state.generatedAt))
    : "—";
}

function setDetailActive(active) {
  document.body.classList.toggle("detail-active", active);
  elements.detailBack.hidden = !active;
}

function showOverview() {
  renderOverview(elements.detail, state, i18n.t, i18n.getLocale(), selectTask);
}

function renderDynamicContent() {
  renderFilters(elements.filters, state, i18n.t, function (filter) {
    state.filter = filter;
    renderDynamicContent();
  });
  renderTasks(elements.tasks, state, i18n.t, i18n.getLocale(), selectTask);
  if (state.detail) renderTaskDetail(elements.detail, state.detail, i18n.t, i18n.getLocale());
  else if (!state.selected) showOverview();
  updateMetrics();
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

async function requestJson(path) {
  const response = await fetch(path, { headers: { accept: "application/json" } });
  if (!response.ok) throw new Error("HTTP " + response.status);
  return response.json();
}

async function selectTask(taskId) {
  state.selected = taskId;
  state.detail = null;
  setDetailActive(true);
  renderTasks(elements.tasks, state, i18n.t, i18n.getLocale(), selectTask);
  renderLoading(elements.detail, i18n.t, "loading.detail");
  elements.detail.scrollTop = 0;
  try {
    const detail = await requestJson("/api/tasks/" + encodeURIComponent(taskId));
    if (state.selected !== taskId) return;
    state.detail = detail;
    renderTaskDetail(elements.detail, detail, i18n.t, i18n.getLocale());
  } catch {
    if (state.selected !== taskId) return;
    renderError(elements.detail, i18n.t("errors.detail"));
    showToast(i18n.t("errors.detail"));
  }
}

async function refreshDashboard() {
  elements.refresh.disabled = true;
  if (!state.tasks.length) renderLoading(elements.tasks, i18n.t, "loading.dashboard");
  try {
    const dashboard = await requestJson("/api/dashboard");
    state.tasks = dashboard.tasks;
    state.counts = dashboard.counts;
    state.generatedAt = dashboard.generatedAt;
    if (state.selected && !state.tasks.some(function (task) { return task.id === state.selected; })) {
      clearSelection();
    }
    renderDynamicContent();
  } catch {
    renderError(elements.tasks, i18n.t("errors.dashboard"));
    showToast(i18n.t("errors.dashboard"));
  } finally {
    elements.refresh.disabled = false;
  }
}

elements.search.addEventListener("input", function () {
  state.query = elements.search.value;
  renderTasks(elements.tasks, state, i18n.t, i18n.getLocale(), selectTask);
});
elements.refresh.addEventListener("click", refreshDashboard);
elements.detailBack.addEventListener("click", clearSelection);
document.addEventListener("keydown", function (event) {
  const typing = ["INPUT", "SELECT", "TEXTAREA"].includes(document.activeElement.tagName);
  if (event.key === "Escape" && state.selected) {
    clearSelection();
    return;
  }
  if (event.key.toLowerCase() === "r" && !event.metaKey && !event.ctrlKey && !event.altKey && !typing) {
    refreshDashboard();
  }
});
i18n.subscribe(function () { renderDynamicContent(); });
showOverview();
refreshDashboard();
window.setInterval(refreshDashboard, 30000);
`;
