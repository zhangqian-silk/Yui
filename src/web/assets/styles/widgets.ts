/*
 * WIDGETS — small reusable chrome.
 * Base element treatment, sidebar controls, topbar controls, pills / dots /
 * chips, filter chips, metric rail, loading / toast. Cards live in cards.ts.
 */
export const WIDGET_STYLES = `
html{background:var(--bg);color:var(--text)}
body{background:var(--ambient),var(--bg);background-attachment:fixed;color:var(--text);-webkit-font-smoothing:antialiased;transition:background-color var(--motion-fast),color var(--motion-fast)}
::selection{background:var(--accent);color:var(--on-accent)}
*{scrollbar-width:thin;scrollbar-color:var(--border-strong) transparent}
::-webkit-scrollbar{width:10px;height:10px}
::-webkit-scrollbar-thumb{background:var(--border-strong);border-radius:var(--radius-pill);border:2px solid transparent;background-clip:content-box}
::-webkit-scrollbar-track{background:transparent}
.skip-link{position:fixed;left:14px;top:-56px;background:var(--accent);color:var(--on-accent);padding:10px 15px;border-radius:var(--radius);z-index:80;text-decoration:none;font-size:12px;transition:top var(--motion-fast)}
.skip-link:focus{top:14px}
button{font:inherit;cursor:pointer}
input:focus-visible,select:focus-visible,button:focus-visible,.task:focus-visible,.tab:focus-visible,.overview-row:focus-visible{outline:none;box-shadow:0 0 0 2px var(--bg),0 0 0 4px var(--accent)}
/* Sidebar */
.sidebar{border-right:1px solid var(--border);background:color-mix(in srgb,var(--bg-1) 84%,transparent);backdrop-filter:blur(12px);-webkit-backdrop-filter:blur(12px)}
.brand-mark{width:40px;height:40px;flex:none;display:grid;place-items:center;font-family:var(--font-display);font-size:21px;font-weight:600;color:var(--on-accent);border-radius:11px;background:linear-gradient(140deg,var(--accent),var(--accent-2));box-shadow:var(--glow)}
.sidebar-brand strong{display:block;font-family:var(--font-display);font-size:17px;font-weight:700;letter-spacing:-.01em;line-height:1.1;color:var(--text)}
.sidebar-brand .brand-text span{display:block;color:var(--muted);font-size:10px;letter-spacing:.02em;line-height:1.2}
.sidebar-brand .live{flex:none;width:9px;height:9px;padding:0;border:0;background:transparent}
.sidebar-brand .live i{width:9px;height:9px}
.live{display:flex;align-items:center;justify-content:center;gap:8px;padding:7px 12px;border:1px solid var(--border);border-radius:var(--radius);background:var(--bg-2)}
.live i{width:7px;height:7px;flex:none;background:var(--success);border-radius:50%;box-shadow:0 0 10px var(--success);animation:pulse 2.4s ease-in-out infinite}
@keyframes pulse{0%,100%{opacity:1}50%{opacity:.4}}
.live span{color:var(--muted);font-size:9px;text-transform:uppercase;letter-spacing:.1em}
.select-control{display:grid;gap:5px;min-width:0;position:relative}
.select-control select{width:100%;min-height:34px;padding:6px 28px 6px 11px;font-size:11px;color:var(--text);background:var(--bg-2);border:1px solid var(--border);border-radius:var(--radius);appearance:none;cursor:pointer;transition:border-color var(--motion-fast)}
.select-control:after{content:"";position:absolute;right:11px;top:50%;width:7px;height:7px;border-right:1.5px solid var(--muted);border-bottom:1.5px solid var(--muted);transform:translateY(-70%) rotate(45deg);pointer-events:none}
.select-control select:hover{border-color:var(--border-strong)}
.eyebrow{color:var(--accent);letter-spacing:.22em;text-transform:uppercase;font-size:9.5px;font-weight:600}
.task-group-head{color:var(--muted);font-family:var(--font-mono);font-size:9.5px;text-transform:uppercase;letter-spacing:.14em}
.task-group-head .count{margin-left:auto;color:var(--muted);font-weight:600}
.search{position:relative;display:flex;align-items:center}
.search:before{content:"◜ ";position:absolute;left:13px;color:var(--faint);font-size:15px;pointer-events:none}
.search input{width:100%;padding:7px 36px 7px 34px;font-family:var(--font-body);font-size:12px;color:var(--text);background:var(--bg-2);border:1px solid var(--border);border-radius:var(--radius-pill);transition:border-color var(--motion-fast),box-shadow var(--motion-fast)}
.search input::placeholder{color:var(--faint)}
.search input:focus{border-color:var(--accent-line);box-shadow:0 0 0 3px var(--accent-soft);outline:none}
.search kbd{position:absolute;right:11px;top:50%;transform:translateY(-50%);pointer-events:none}
kbd{background:var(--bg-3);border:1px solid var(--border);border-bottom-width:2px;border-radius:5px;padding:1px 6px;font-size:11px;color:var(--muted);font-family:var(--font-mono)}
/* Filter chips (sidebar filters + runs filter) */
.filter-row{display:flex;gap:6px;overflow-x:auto;scrollbar-width:none;padding-bottom:2px}
.filter-row::-webkit-scrollbar{display:none}
.filter-chip{flex:none;display:inline-flex;align-items:center;gap:6px;padding:5px 10px;font-family:var(--font-body);font-size:12px;line-height:1.3;color:var(--muted);background:var(--bg-2);border:1px solid var(--border);border-radius:var(--radius-pill);cursor:pointer;white-space:nowrap;transition:color var(--motion-fast),border-color var(--motion-fast),background var(--motion-fast)}
.filter-chip:hover{color:var(--text);border-color:var(--border-strong)}
.filter-chip.is-active{color:var(--accent);background:var(--accent-soft);border-color:var(--accent-line)}
.filter-count{font-family:var(--font-mono);font-size:10px;color:var(--faint);min-width:14px;text-align:center}
.filter-chip.is-active .filter-count{color:var(--accent)}
.filter-dot{width:7px;height:7px;flex:none;border-radius:50%;background:var(--faint)}
.filter-dot.active{background:var(--active);box-shadow:0 0 6px var(--active)}
.filter-dot.draft{background:var(--warning);box-shadow:0 0 6px var(--warning)}
.filter-dot.completed{background:var(--success);box-shadow:0 0 6px var(--success)}
.filter-dot.yielded{background:var(--success);box-shadow:0 0 6px var(--success)}
.filter-dot.failed{background:var(--danger);box-shadow:0 0 6px var(--danger)}
.filter-dot.archived{background:var(--muted)}
.filter-chip[data-status=active].is-active{color:var(--active);background:var(--active-soft);border-color:color-mix(in srgb,var(--active) 45%,transparent)}
.filter-chip[data-status=active].is-active .filter-count{color:var(--active)}
.filter-chip[data-status=draft].is-active{color:var(--warning);background:var(--warning-soft);border-color:color-mix(in srgb,var(--warning) 45%,transparent)}
.filter-chip[data-status=draft].is-active .filter-count{color:var(--warning)}
.filter-chip[data-status=completed].is-active{color:var(--success);background:var(--success-soft);border-color:color-mix(in srgb,var(--success) 45%,transparent)}
.filter-chip[data-status=completed].is-active .filter-count{color:var(--success)}
.filter-chip[data-status=archived].is-active{color:var(--muted);background:var(--bg-3);border-color:var(--border-strong)}
.filter-chip[data-status=archived].is-active .filter-count{color:var(--muted)}
/* Sidebar task cards */
.task{display:grid;grid-template-columns:8px minmax(0,1fr) auto;gap:2px 9px;align-items:center;width:100%;text-align:left;padding:5px 9px;border:1px solid transparent;border-radius:var(--radius);background:transparent;color:var(--text);transition:background var(--motion-fast),border-color var(--motion-fast)}
.task:hover{background:var(--bg-2);border-color:var(--border)}
.task[aria-current=true]{background:var(--bg-3);border-color:var(--accent-line);box-shadow:inset 2px 0 var(--accent)}
.task .status-dot{grid-row:1;align-self:center;margin-top:0}
.task-main{grid-row:1;grid-column:2;min-width:0;display:flex;align-items:baseline;gap:8px}
.task-title{flex:1;min-width:0;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;font-family:var(--font-body);font-size:12.5px;font-weight:600;line-height:1.3;color:var(--text)}
.task-meta{flex:none;color:var(--muted);font-size:10px;letter-spacing:.01em;line-height:1.2;white-space:nowrap}
.task-signal{grid-row:1;grid-column:3;align-self:center;flex:none;display:inline-grid;place-items:center;min-width:18px;height:18px;padding:0 5px;border-radius:var(--radius-pill);font-family:var(--font-mono);font-size:10px;font-weight:600}
.task-signal.is-input{color:var(--warning);background:var(--warning-soft);border:1px solid var(--warning)}
.task-signal.is-running{color:var(--active);background:var(--active-soft);border:1px solid transparent}
/* Topbar */
.detail-back{width:38px;height:38px;flex:none;display:grid;place-items:center;font-size:18px;line-height:1;color:var(--muted);background:var(--bg-2);border:1px solid var(--border);border-radius:var(--radius);transition:border-color var(--motion-fast),color var(--motion-fast),background var(--motion-fast)}
.detail-back:hover{border-color:var(--accent-line);color:var(--accent);background:var(--accent-soft)}
.crumb{color:var(--muted);font-family:var(--font-mono);font-size:9.5px;text-transform:uppercase;letter-spacing:.14em;white-space:nowrap}
.crumb-sep{color:var(--faint)}
.clock span{color:var(--muted);font-family:var(--font-mono);font-size:9.5px;text-transform:uppercase;letter-spacing:.14em}
.clock time{color:var(--text);font-size:12px;font-variant-numeric:tabular-nums;letter-spacing:.04em}
.refresh{display:inline-flex;align-items:center;gap:8px;padding:9px 14px;color:var(--text);background:var(--bg-2);border:1px solid var(--border);border-radius:var(--radius);font-family:var(--font-body);font-size:12px;font-weight:600;transition:border-color var(--motion-fast),color var(--motion-fast),background var(--motion-fast)}
.refresh:hover,.refresh:focus-visible{border-color:var(--accent-line);color:var(--accent);background:var(--accent-soft)}
.refresh:disabled{opacity:.5;cursor:wait}
/* Operator session control (top bar, right side).
   Kept visually consistent with the refresh button so the topbar actions read
   as one family: same background, border, radius, padding, and hover treatment. */
.operator-open{display:inline-flex;align-items:center;gap:8px;flex:none;padding:9px 14px;color:var(--text);background:var(--bg-2);border:1px solid var(--border);border-radius:var(--radius);font-family:var(--font-body);font-size:12px;font-weight:600;cursor:pointer;transition:border-color var(--motion-fast),color var(--motion-fast),background var(--motion-fast)}
.operator-open:hover,.operator-open:focus-visible{border-color:var(--accent-line);color:var(--accent);background:var(--accent-soft)}
.operator-title{flex:none;white-space:nowrap}
.operator-shortcuts{display:flex;gap:4px;flex:none}
/* Pills + dots + chips */
.pill{display:inline-flex;align-items:center;font-family:var(--font-mono);font-size:9px;text-transform:uppercase;letter-spacing:.07em;padding:3px 10px;border-radius:var(--radius-pill);white-space:nowrap;color:var(--accent);background:var(--accent-soft);border:1px solid var(--accent-line)}
.pill[data-status=failed],.pill[data-status=urgent],.pill[data-status=required]{color:var(--danger);background:var(--danger-soft);border-color:transparent}
.pill[data-status=active],.pill[data-status=running],.pill[data-status=yielded],
.pill[data-status=user],.pill[data-status=operator]{color:var(--active);background:var(--active-soft);border-color:transparent}
.pill[data-status=completed],.pill[data-status=integrated],.pill[data-status=role-result]{color:var(--success);background:var(--success-soft);border-color:transparent}
.pill[data-status=pending],.pill[data-status=draft],.pill[data-status=recommended],
.pill[data-status=detached]{color:var(--warning);background:var(--warning-soft);border-color:transparent}
.pill[data-status=archived],.pill[data-status=retired],.pill[data-status=superseded],.pill[data-status=abandoned],
.pill[data-status=exited],.pill[data-status=system]{color:var(--muted);background:var(--bg-3);border-color:transparent}
.status-dot{width:8px;height:8px;flex:none;border-radius:50%;background:var(--faint);margin-top:4px}
.status-dot.active{background:var(--active);box-shadow:0 0 8px var(--active)}
.status-dot.completed{background:var(--success);box-shadow:0 0 8px var(--success)}
.status-dot.draft{background:var(--warning);box-shadow:0 0 8px var(--warning)}
.status-dot.retired{background:var(--faint)}
.status-dot.archived{background:var(--faint)}
.chip{display:inline-flex;align-items:center;font-family:var(--font-mono);font-size:9.5px;letter-spacing:.02em;color:var(--muted);background:var(--bg-3);border:1px solid var(--border);padding:2px 9px;border-radius:var(--radius-pill);white-space:nowrap}
.chip.is-adapter{color:var(--text);font-weight:700}
.chip.is-active{color:var(--accent);background:var(--accent-soft);border-color:var(--accent-line)}
.chip-row{display:flex;gap:6px;flex-wrap:wrap}
.agent-badge{display:inline-flex;gap:5px;flex-wrap:wrap;align-items:center}
/* Command rail = 4 metric tiles */
.command-rail{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:10px;margin-bottom:18px}
.metric{background:var(--bg-2);border:1px solid var(--border);border-radius:var(--radius);box-shadow:var(--shadow-card);padding:10px 12px;display:flex;align-items:center;justify-content:space-between;gap:12px;position:relative;overflow:hidden;transition:border-color var(--motion-fast),box-shadow var(--motion-fast)}
.metric:hover{border-color:var(--border-strong);box-shadow:0 1px 2px rgba(0,0,0,.32),0 6px 16px rgba(0,0,0,.22)}
.metric-label{color:var(--muted);font-family:var(--font-mono);font-size:10px;text-transform:uppercase;letter-spacing:.12em;line-height:1.2}
.metric-value{font-family:var(--font-display);font-weight:700;font-size:24px;line-height:1;letter-spacing:-.02em;font-variant-numeric:tabular-nums;color:var(--text);flex:none}
.metric.is-hot{border-color:var(--accent-line)}
.metric.is-hot:before{content:"";position:absolute;inset:0;background:radial-gradient(170px 90px at 100% 0,var(--accent-soft),transparent 70%);pointer-events:none}
.metric.is-hot .metric-value{color:var(--accent)}
.metric.is-warning{border-color:var(--warning)}
.metric.is-warning:before{content:"";position:absolute;inset:0;background:radial-gradient(170px 90px at 100% 0,var(--warning-soft),transparent 70%);pointer-events:none}
.metric.is-warning .metric-value{color:var(--warning)}
/* Terminal panel */
.terminal-panel{color:#e8eef6;background:#080b11;border-left:1px solid #263244;box-shadow:var(--shadow-pop)}
.terminal-head{background:#0c111a;border-bottom:1px solid #263244}
.terminal-head h2{font-family:var(--font-display);font-size:15px;color:#e8eef6}
.terminal-close{display:grid!important;color:#8b99ad;background:#111826;border-color:#263244}
.terminal-host .xterm{height:100%}
.terminal-host .xterm-viewport{scrollbar-width:none}
.terminal-host .xterm-viewport::-webkit-scrollbar{display:none}
.terminal-hint p{margin:0;color:#8b99ad;font-family:var(--font-body)}
.terminal-hint-cli a{display:inline-block;margin-top:6px;padding:6px 14px;font-family:var(--font-mono);font-size:13.5px;color:var(--accent);background:var(--accent-soft);border:1px solid var(--accent-line);border-radius:var(--radius);text-decoration:none}
.terminal-hint-cli a:hover{color:var(--on-accent);background:var(--accent)}
.terminal-hint-note{font-size:11px;color:var(--faint)}
/* Loading / empty / toast */
.loading,.empty,.error{padding:46px 16px;color:var(--muted);text-align:center;font-size:12px;letter-spacing:.04em;font-family:var(--font-body)}
.error{color:var(--danger)}
.loading:before{content:"";display:block;width:20px;height:20px;margin:0 auto 14px;border:2px solid var(--border);border-top-color:var(--accent);border-radius:50%;animation:spin .8s linear infinite}
@keyframes spin{to{transform:rotate(360deg)}}
.toast{position:fixed;right:22px;bottom:22px;z-index:90;max-width:340px;background:var(--danger);color:#fff;padding:13px 17px;border-radius:var(--radius);box-shadow:var(--shadow-pop);transform:translateY(130px);opacity:0;transition:transform var(--motion-slow),opacity var(--motion-slow)}
.toast.show{transform:none;opacity:1}
.sr-only{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0}
`;
