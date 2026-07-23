export const DASHBOARD_HTML = `<!doctype html>
<html lang="en" data-theme="control-room">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="color-scheme" content="dark light">
  <title>Yui Control Room</title>
  <link rel="stylesheet" href="/assets/css/tokens.css">
  <link rel="stylesheet" href="/assets/css/layout.css">
  <link rel="stylesheet" href="/assets/css/components.css">
  <link rel="stylesheet" href="/assets/css/responsive.css">
</head>
<body>
  <a class="skip-link" href="#task-board" data-i18n="a11y.skip">Skip to task board</a>
  <header class="masthead">
    <div class="brand">
      <span class="brand-mark" aria-hidden="true">結</span>
      <div><strong>Yui</strong><span data-i18n="brand.subtitle">local control plane</span></div>
    </div>
    <div class="header-actions">
      <div class="live"><i aria-hidden="true"></i><span data-i18n="brand.connection">Loopback · read only</span></div>
      <label class="select-control">
        <span data-i18n="controls.language">Language</span>
        <select id="locale-select" aria-label="Language" data-i18n-aria-label="controls.language">
          <option value="en">English</option>
          <option value="zh-CN">简体中文</option>
        </select>
      </label>
      <label class="select-control">
        <span data-i18n="controls.theme">Theme</span>
        <select id="theme-select" aria-label="Theme" data-i18n-aria-label="controls.theme">
          <option value="control-room" data-i18n="theme.controlRoom">Control room</option>
          <option value="paper" data-i18n="theme.paper">Paper ledger</option>
        </select>
      </label>
    </div>
  </header>
  <main>
    <section class="hero" aria-labelledby="page-title">
      <div>
        <p class="eyebrow" data-i18n="page.eyebrow">SYSTEM OVERVIEW</p>
        <h1 id="page-title" data-i18n="page.title">Control room</h1>
        <p class="lede" data-i18n="page.lede">A quiet view into every task, role, and unresolved decision.</p>
      </div>
      <div class="clock">
        <span data-i18n="sync.label">LAST SYNC</span>
        <time id="last-sync">—</time>
        <button id="refresh" type="button"><span data-i18n="actions.refresh">Refresh</span> <kbd>R</kbd></button>
      </div>
    </section>
    <section class="metrics" aria-label="Task summary" data-i18n-aria-label="metrics.label">
      <article><span data-i18n="metrics.active">Active</span><strong id="metric-active">—</strong></article>
      <article><span data-i18n="metrics.inputs">Open inputs</span><strong id="metric-inputs">—</strong></article>
      <article><span data-i18n="metrics.completed">Completed</span><strong id="metric-completed">—</strong></article>
      <article><span data-i18n="metrics.total">Total tasks</span><strong id="metric-total">—</strong></article>
    </section>
    <section class="workspace">
      <div class="board-panel">
        <div class="toolbar">
          <div><p class="eyebrow" data-i18n="board.eyebrow">TASK INDEX</p><h2 id="task-board" data-i18n="board.title">Current work</h2></div>
          <label class="search">
            <span class="sr-only" data-i18n="search.label">Search tasks</span>
            <input id="search" type="search" placeholder="Filter by title, ID, or tag…" data-i18n-placeholder="search.placeholder">
          </label>
        </div>
        <div id="status-filters" class="filters" aria-label="Filter by status" data-i18n-aria-label="filters.label"></div>
        <div id="task-list" class="task-list" aria-live="polite"><div class="loading" data-i18n="loading.dashboard">Reading local state…</div></div>
      </div>
      <aside id="detail" class="detail" aria-labelledby="detail-title"></aside>
    </section>
  </main>
  <div id="toast" class="toast" role="status" aria-live="polite"></div>
  <script type="module" src="/assets/app.js"></script>
</body>
</html>`;
