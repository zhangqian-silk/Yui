export const I18N_SCRIPT = `
const messages = {
  "en": {
    "app.title": "Yui Control Room",
    "a11y.skip": "Skip to task board",
    "brand.subtitle": "local control plane",
    "brand.connection": "Loopback · read only",
    "controls.language": "Language",
    "controls.theme": "Theme",
    "theme.controlRoom": "Control room",
    "theme.paper": "Paper ledger",
    "page.eyebrow": "SYSTEM OVERVIEW",
    "page.title": "Control room",
    "page.lede": "A quiet view into every task, role, and unresolved decision.",
    "sync.label": "LAST SYNC",
    "actions.refresh": "Refresh",
    "metrics.label": "Task summary",
    "metrics.active": "Active",
    "metrics.inputs": "Open inputs",
    "metrics.completed": "Completed",
    "metrics.total": "Total tasks",
    "board.eyebrow": "TASK INDEX",
    "board.title": "Current work",
    "search.label": "Search tasks",
    "search.placeholder": "Filter by title, ID, or tag…",
    "filters.label": "Filter by status",
    "loading.dashboard": "Reading local state…",
    "loading.detail": "Reading task detail…",
    "empty.tasks": "No tasks match this view.",
    "empty.none": "No items",
    "empty.brief": "No task brief has been recorded.",
    "detail.selectTitle": "Select a task",
    "detail.selectBody": "Choose a task from the index to inspect its brief, roles, work, and open inputs.",
    "detail.attention": "Attention required",
    "detail.focus": "Current focus",
    "detail.execution": "Execution",
    "detail.roles": "Roles",
    "detail.workItems": "Work items",
    "detail.openInput": "Open input",
    "detail.instruction": "Instruction",
    "detail.outcome": "Outcome",
    "detail.assignee": "Assignee",
    "detail.agent": "Agent",
    "detail.milestones": "Milestones",
    "detail.decisions": "Decisions",
    "detail.messages": "Messages",
    "detail.due": "Due",
    "detail.updated": "Updated",
    "delivery.delivered": "Delivered",
    "delivery.pending": "Awaiting delivery",
    "run.active": "Active",
    "run.yielded": "Yielded",
    "run.failed": "Failed",
    "mode.new": "New session",
    "mode.resume": "Resumed session",
    "decision.active": "Active",
    "decision.superseded": "Superseded",
    "author.user": "User",
    "author.operator": "Operator",
    "author.system": "System",
    "priority.low": "Low priority",
    "priority.medium": "Medium priority",
    "priority.high": "High priority",
    "priority.urgent": "Urgent",
    "errors.dashboard": "Unable to read the dashboard.",
    "errors.detail": "Unable to read task detail.",
    "status.all": "All",
    "status.draft": "Draft",
    "status.active": "Active",
    "status.completed": "Completed",
    "status.archived": "Archived",
    "role.idle": "Idle",
    "role.running": "Running",
    "role.detached": "Detached",
    "role.exited": "Exited",
    "role.failed": "Failed",
    "work.pending": "Pending",
    "work.running": "Running",
    "work.completed": "Completed",
    "work.failed": "Failed",
    "work.cancelled": "Cancelled",
    "work.superseded": "Superseded",
    "stats.running": "running",
    "stats.inputs": "inputs",
    "time.justNow": "just now"
  },
  "zh-CN": {
    "app.title": "Yui 控制室",
    "a11y.skip": "跳到任务面板",
    "brand.subtitle": "本地控制平面",
    "brand.connection": "本机回环 · 只读",
    "controls.language": "语言",
    "controls.theme": "主题",
    "theme.controlRoom": "控制室",
    "theme.paper": "纸本台账",
    "page.eyebrow": "系统概览",
    "page.title": "控制室",
    "page.lede": "安静地查看每个任务、角色与尚未解决的决策。",
    "sync.label": "最近同步",
    "actions.refresh": "刷新",
    "metrics.label": "任务摘要",
    "metrics.active": "进行中",
    "metrics.inputs": "待处理输入",
    "metrics.completed": "已完成",
    "metrics.total": "任务总数",
    "board.eyebrow": "任务索引",
    "board.title": "当前工作",
    "search.label": "搜索任务",
    "search.placeholder": "按标题、ID 或标签筛选…",
    "filters.label": "按状态筛选",
    "loading.dashboard": "正在读取本地状态…",
    "loading.detail": "正在读取任务详情…",
    "empty.tasks": "当前视图没有匹配的任务。",
    "empty.none": "暂无条目",
    "empty.brief": "尚未记录任务简报。",
    "detail.selectTitle": "选择一个任务",
    "detail.selectBody": "从任务索引中选择任务，查看简报、角色、工作项和待处理输入。",
    "detail.attention": "需要关注",
    "detail.focus": "当前重点",
    "detail.execution": "执行记录",
    "detail.roles": "角色",
    "detail.workItems": "工作项",
    "detail.openInput": "待处理输入",
    "detail.instruction": "执行指令",
    "detail.outcome": "执行结果",
    "detail.assignee": "负责人",
    "detail.agent": "Agent",
    "detail.milestones": "里程碑",
    "detail.decisions": "决策",
    "detail.messages": "消息",
    "detail.due": "截止时间",
    "detail.updated": "更新时间",
    "delivery.delivered": "已送达",
    "delivery.pending": "等待送达",
    "run.active": "执行中",
    "run.yielded": "已交付",
    "run.failed": "失败",
    "mode.new": "新会话",
    "mode.resume": "恢复会话",
    "decision.active": "有效",
    "decision.superseded": "已替代",
    "author.user": "用户",
    "author.operator": "Operator",
    "author.system": "系统",
    "priority.low": "低优先级",
    "priority.medium": "中优先级",
    "priority.high": "高优先级",
    "priority.urgent": "紧急",
    "errors.dashboard": "无法读取控制面板。",
    "errors.detail": "无法读取任务详情。",
    "status.all": "全部",
    "status.draft": "草稿",
    "status.active": "进行中",
    "status.completed": "已完成",
    "status.archived": "已归档",
    "role.idle": "空闲",
    "role.running": "运行中",
    "role.detached": "已分离",
    "role.exited": "已退出",
    "role.failed": "失败",
    "work.pending": "待处理",
    "work.running": "进行中",
    "work.completed": "已完成",
    "work.failed": "失败",
    "work.cancelled": "已取消",
    "work.superseded": "已替代",
    "stats.running": "运行中",
    "stats.inputs": "项输入",
    "time.justNow": "刚刚"
  }
};

export const SUPPORTED_LOCALES = Object.freeze(Object.keys(messages));

function preferredLocale() {
  const saved = localStorage.getItem("yui.locale");
  if (SUPPORTED_LOCALES.includes(saved)) return saved;
  const languages = navigator.languages || [navigator.language];
  return languages.some(function (language) { return String(language).toLowerCase().startsWith("zh"); })
    ? "zh-CN"
    : "en";
}

export function createI18n(select) {
  let locale = preferredLocale();
  const subscribers = new Set();

  function t(key) {
    return messages[locale][key] || messages.en[key] || key;
  }

  function apply() {
    document.documentElement.lang = locale;
    document.title = t("app.title");
    document.querySelectorAll("[data-i18n]").forEach(function (element) {
      element.textContent = t(element.dataset.i18n);
    });
    document.querySelectorAll("[data-i18n-placeholder]").forEach(function (element) {
      element.setAttribute("placeholder", t(element.dataset.i18nPlaceholder));
    });
    document.querySelectorAll("[data-i18n-aria-label]").forEach(function (element) {
      element.setAttribute("aria-label", t(element.dataset.i18nAriaLabel));
    });
    if (select) select.value = locale;
  }

  function setLocale(nextLocale) {
    if (!SUPPORTED_LOCALES.includes(nextLocale) || nextLocale === locale) return;
    locale = nextLocale;
    localStorage.setItem("yui.locale", locale);
    apply();
    subscribers.forEach(function (subscriber) { subscriber(locale); });
  }

  if (select) {
    select.addEventListener("change", function () { setLocale(select.value); });
  }
  apply();
  return {
    t: t,
    apply: apply,
    getLocale: function () { return locale; },
    setLocale: setLocale,
    subscribe: function (subscriber) {
      subscribers.add(subscriber);
      return function () { subscribers.delete(subscriber); };
    }
  };
}
`;
