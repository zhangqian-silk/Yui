export const DASHBOARD_HTML = `<!doctype html>
<html lang="en" data-theme="control-room">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="color-scheme" content="dark light">
  <meta name="yui-web-token" content="__YUI_WEB_TOKEN__">
  <link rel="icon" href="data:,">
  <title>Yui Control Room</title>
  <link rel="preload" href="/assets/fonts/inter-500.woff2" as="font" type="font/woff2" crossorigin>
  <link rel="preload" href="/assets/fonts/inter-600.woff2" as="font" type="font/woff2" crossorigin>
  <link rel="stylesheet" href="/assets/css/fonts.css">
  <link rel="stylesheet" href="/assets/css/tokens.css">
  <link rel="stylesheet" href="/assets/css/layout.css">
  <link rel="stylesheet" href="/assets/css/widgets.css">
  <link rel="stylesheet" href="/assets/css/cards.css">
  <link rel="stylesheet" href="/assets/css/markdown.css">
  <link rel="stylesheet" href="/assets/css/responsive.css">
  <link rel="stylesheet" href="/assets/vendor/xterm.css">
</head>
<body>
  <a class="skip-link" href="#main" data-i18n="a11y.skip">Skip to the main panel</a>
  <div class="app-shell">
    <aside class="sidebar" aria-label="Work index">
      <div class="sidebar-brand">
        <span class="brand-mark" aria-hidden="true">結</span>
        <div class="brand-text">
          <strong>Yui</strong>
          <span data-i18n="brand.subtitle">local control plane</span>
        </div>
        <span class="live" title="Local loopback"><i aria-hidden="true"></i><span class="sr-only" data-i18n="brand.connection">Local loopback</span></span>
      </div>
      <label class="search">
        <span class="sr-only" data-i18n="search.label">Search tasks</span>
        <input id="search" type="search" placeholder="Filter by title, ID, tag, or project…" data-i18n-placeholder="search.placeholder">
        <kbd>/</kbd>
      </label>
      <div id="status-filters" class="filters" role="group" aria-label="Filter by status" data-i18n-aria-label="filters.label"></div>
      <div id="task-list" class="task-list" aria-label="Tasks" data-i18n-aria-label="board.title" aria-live="polite"><div class="loading" data-i18n="loading.dashboard">Reading local state…</div></div>
      <div class="sidebar-foot">
        <div class="sidebar-controls">
          <label class="select-control">
            <span class="sr-only" data-i18n="controls.language">Language</span>
            <select id="locale-select" aria-label="Language" data-i18n-aria-label="controls.language">
              <option value="en">English</option>
              <option value="zh-CN">简体中文</option>
            </select>
          </label>
          <label class="select-control">
            <span class="sr-only" data-i18n="controls.theme">Theme</span>
            <select id="theme-select" aria-label="Theme" data-i18n-aria-label="controls.theme">
              <option value="control-room" data-i18n="theme.controlRoom">Control room</option>
              <option value="paper" data-i18n="theme.paper">Paper ledger</option>
              <option value="atlas" data-i18n="theme.atlas">Atlas</option>
            </select>
          </label>
        </div>
      </div>
    </aside>
    <div class="main-col">
      <header class="topbar">
        <div class="topbar-leading">
          <button id="detail-back" class="detail-back" type="button" aria-label="Back to task list" data-i18n-aria-label="actions.back" hidden>←</button>
          <div class="breadcrumb">
            <span class="crumb" data-i18n="breadcrumb.taskList">All work</span>
            <span class="crumb-sep" aria-hidden="true">/</span>
            <h1 id="page-title" class="crumb-current" data-i18n="page.title">Overview</h1>
          </div>
        </div>
        <div class="topbar-actions">
          <div class="clock">
            <span data-i18n="sync.label">Last sync</span>
            <time id="last-sync">—</time>
          </div>
          <button id="operator-terminal" class="operator-open" type="button">
            <span class="operator-title" data-i18n="actions.operator">Operator session</span>
            <span class="operator-shortcuts" aria-hidden="true"><kbd>O</kbd></span>
          </button>
          <button id="refresh" class="refresh" type="button" title="Refresh tasks"><span data-i18n="actions.refresh">Refresh</span> <kbd>R</kbd></button>
        </div>
      </header>
      <nav id="detail-tabs" class="detail-tabs" aria-label="Task sections" data-i18n-aria-label="tabs.label" hidden>
        <button class="tab" type="button" data-target="detail-top" data-i18n="tabs.summary">Summary</button>
        <button class="tab" type="button" data-target="detail-focus" data-i18n="tabs.focus">Focus</button>
        <button class="tab" type="button" data-target="detail-work" data-i18n="tabs.work">Work items</button>
        <button class="tab" type="button" data-target="detail-exec" data-i18n="tabs.exec">Turns</button>
        <button class="tab" type="button" data-target="detail-reviews" data-i18n="tabs.reviews">Reviews</button>
        <button class="tab" type="button" data-target="detail-roles" data-i18n="tabs.roles">Roles</button>
        <button class="tab" type="button" data-target="detail-history" data-i18n="tabs.history">History</button>
        <button class="tab" type="button" data-target="detail-messages" data-i18n="tabs.messages">Messages</button>
      </nav>
      <main id="detail" class="detail" aria-labelledby="page-title" tabindex="-1"></main>
    </div>
    <aside id="terminal-panel" class="terminal-panel" aria-labelledby="terminal-title" aria-hidden="true" hidden>
      <header class="terminal-head">
        <div>
          <span id="terminal-state" class="live"><i aria-hidden="true"></i><span data-i18n="terminal.connecting">Connecting</span></span>
          <h2 id="terminal-title">Operator</h2>
        </div>
        <button id="terminal-close" class="detail-back terminal-close" type="button" aria-label="Close terminal" data-i18n-aria-label="terminal.close">×</button>
      </header>
      <div id="terminal-host" class="terminal-host">
        <div id="terminal-hint" class="terminal-hint" hidden>
          <p data-i18n="terminal.attachTitle">Open the full Operator in a terminal</p>
          <p class="terminal-hint-cli"><a id="terminal-cli" href="#" title="Copy command">yui operator enter</a></p>
          <p class="terminal-hint-note" data-i18n="terminal.attachNote">This panel stays attached until you close it.</p>
        </div>
      </div>
    </aside>
  </div>
  <div id="toast" class="toast" role="status" aria-live="polite"></div>
  <script type="module" src="/assets/app.js"></script>
</body>
</html>`;
