/*
 * LAYOUT — geometry and structure only.
 * Grid shells, sticky bars, scrolling regions. Colors live in widgets/cards.
 */
export const LAYOUT_STYLES = `
*{box-sizing:border-box}
html{min-width:320px;font-family:var(--font-body)}
body{margin:0;min-width:320px;height:100vh;overflow:hidden;font-size:14px}
.app-shell{display:grid;grid-template-columns:var(--sidebar-w) minmax(0,1fr) 0;grid-template-rows:100vh;height:100vh;transition:grid-template-columns var(--motion-slow) var(--ease)}
body.terminal-active .app-shell{grid-template-columns:var(--sidebar-w) minmax(0,1fr) var(--terminal-w)}
/* Sidebar = persistent work index */
.sidebar{display:flex;flex-direction:column;min-height:0;height:100vh;padding:16px 14px 14px}
.sidebar-brand{display:flex;gap:10px;align-items:center;flex:none;margin-bottom:14px}
.brand-text{display:grid;gap:3px;min-width:0;flex:1}
.sidebar .search{flex:none;margin-bottom:10px}
.filters{display:block;flex:none;margin-bottom:10px}
.task-list{flex:1;min-height:0;overflow-y:auto;display:grid;gap:3px;align-content:start;margin:0 -4px;padding:2px 4px}
.task-group{display:grid;gap:7px}
.task-group-head{display:flex;align-items:baseline;gap:8px;padding:3px 4px 2px}
.sidebar-foot{flex:none;padding-top:10px;margin-top:8px;display:grid;gap:8px}
.sidebar-controls{display:grid;grid-template-columns:1fr 1fr;gap:8px;align-items:center}
/* Main column = top bar + optional section nav + reading surface */
.main-col{display:flex;flex-direction:column;min-width:0;min-height:0;height:100vh;overflow-y:auto;scrollbar-gutter:stable}
.topbar{position:sticky;top:0;z-index:30;flex:none;display:flex;align-items:center;justify-content:space-between;gap:18px;padding:11px max(var(--page-space),calc((100% - 1100px) / 2));background:color-mix(in srgb,var(--bg) 92%,transparent);backdrop-filter:blur(10px);-webkit-backdrop-filter:blur(10px);border-bottom:1px solid var(--border)}
.topbar-leading{display:flex;align-items:center;gap:14px;min-width:0}
.breadcrumb{display:flex;align-items:baseline;gap:8px;min-width:0}
.crumb-current{margin:0;min-width:0;font-family:var(--font-display);font-weight:600;font-size:clamp(14px,1.3vw,17px);letter-spacing:-.01em;line-height:1.25;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.topbar-actions{display:flex;align-items:center;gap:14px;flex:none}
.clock{display:grid;justify-items:end;gap:2px;text-align:right;line-height:1.2}
/* Sticky section navigation, only meaningful while a task is open */
.detail-tabs{position:sticky;top:var(--topbar-h,44px);z-index:20;flex:none;display:none;gap:0;padding:0 max(var(--page-space),calc((100% - 1100px) / 2));background:color-mix(in srgb,var(--bg) 92%,transparent);backdrop-filter:blur(10px);-webkit-backdrop-filter:blur(10px);border-bottom:1px solid var(--border);overflow-x:auto;scrollbar-width:none}
body.detail-active .detail-tabs{display:flex}
.tab{flex:none;padding:11px 13px;color:var(--muted);font-family:var(--font-mono);font-size:10px;text-transform:uppercase;letter-spacing:.09em;background:transparent;border:0;border-bottom:2px solid transparent;cursor:pointer;white-space:nowrap;transition:color var(--motion-fast),border-color var(--motion-fast)}
.tab:hover{color:var(--text)}
.tab.is-active{color:var(--accent);border-bottom-color:var(--accent)}
.detail{flex:1;min-height:0;padding:16px max(var(--page-space),calc((100% - 1100px) / 2)) 72px;min-width:0}
.detail:focus-visible{outline:none}
.anchor{scroll-margin-top:calc(var(--topbar-h,44px) + var(--tabs-h,38px))}
/* Terminal panel */
.terminal-panel{grid-column:3;min-width:0;height:100vh;display:flex;flex-direction:column;overflow:hidden}
.terminal-panel[hidden]{display:none}
.terminal-head{flex:none;height:62px;display:flex;align-items:center;justify-content:space-between;gap:14px;padding:10px 14px}
.terminal-head>div{display:flex;align-items:center;gap:12px;min-width:0}
.terminal-head h2{margin:0}
.terminal-host{flex:1;min-height:0;padding:8px 10px;overflow:hidden;position:relative}
.terminal-hint{position:absolute;inset:0;display:grid;place-content:center;gap:8px;text-align:center;padding:20px}
`;
