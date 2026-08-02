/*
 * DESIGN TOKEN CONTRACT
 * ---------------------
 * Every theme is a self-contained [data-theme="..."] block that MUST define the
 * full variable set below. Layout / component / responsive styles reference these
 * variables only — never hardcode a color outside a theme block.
 *
 * To add a theme: copy a block, rename the selector, retune the values, then
 * register the name in client/theme.ts (THEMES) and add an <option> in shell.ts.
 *
 *   Surfaces   --bg --bg-1 --bg-2 --bg-3            (page → elevated layers)
 *   Lines      --border --border-strong
 *   Text       --text --muted --faint
 *   Accent     --accent --accent-2 --on-accent --accent-soft --accent-line
 *   Semantic   --active/--success/--warning/--danger (+ matching --*-soft)
 *   Effects    --glow --shadow-card --shadow-pop --ambient
 *   Geometry   --radius --radius-lg --radius-pill
 *   Type       --font-mono --font-display --font-body
 *   Metrics    --page-space --sidebar-w
 *   Motion     --motion-fast --motion-slow --ease
 */
export const TOKEN_STYLES = `
:root,[data-theme="control-room"]{
  color-scheme:dark;
  --bg:#080b11;--bg-1:#0c111a;--bg-2:#111826;--bg-3:#182132;
  --border:#1e2836;--border-strong:#2f3d50;
  --text:#e8eef6;--muted:#8b99ad;--faint:#5a6779;
  --accent:#49d6ff;--accent-2:#a78bfa;--on-accent:#05121b;
  --accent-soft:rgba(73,214,255,.1);--accent-line:rgba(73,214,255,.34);
  --active:#49d6ff;--active-soft:rgba(73,214,255,.12);
  --success:#43d98d;--success-soft:rgba(67,217,141,.12);
  --warning:#ffca6b;--warning-soft:rgba(255,202,107,.12);
  --danger:#ff6b81;--danger-soft:rgba(255,107,129,.12);
  --glow:0 0 18px rgba(73,214,255,.45);
  --shadow-card:0 1px 2px rgba(0,0,0,.4),0 8px 24px rgba(0,0,0,.24);
  --shadow-pop:0 18px 48px rgba(0,0,0,.5);
  --ambient:
    radial-gradient(1000px 560px at 8% -12%,rgba(73,214,255,.12),transparent 58%),
    radial-gradient(900px 520px at 104% -6%,rgba(167,139,250,.12),transparent 55%),
    linear-gradient(rgba(255,255,255,.022) 1px,transparent 1px) 0 0/100% 44px,
    linear-gradient(90deg,rgba(255,255,255,.022) 1px,transparent 1px) 0 0/44px 100%;
  --radius:10px;--radius-lg:16px;--radius-pill:999px;
  --font-mono:"IBM Plex Mono","JetBrains Mono","SFMono-Regular",Consolas,monospace;
  --font-display:"Space Grotesk",system-ui,"Segoe UI",Helvetica,Arial,sans-serif;
  --font-body:system-ui,-apple-system,"Segoe UI",sans-serif;
  --page-space:clamp(18px,2.6vw,40px);--sidebar-w:clamp(232px,18vw,288px);--terminal-w:clamp(420px,34vw,640px);
  --motion-fast:150ms;--motion-slow:320ms;--ease:cubic-bezier(.16,.84,.44,1);
}
[data-theme="paper"]{
  color-scheme:light;
  --bg:#e9eef6;--bg-1:#f2f6fc;--bg-2:#ffffff;--bg-3:#f7fafe;
  --border:#d4deec;--border-strong:#b2c0d6;
  --text:#132030;--muted:#54637a;--faint:#8493a8;
  --accent:#2563eb;--accent-2:#7c3aed;--on-accent:#ffffff;
  --accent-soft:rgba(37,99,235,.08);--accent-line:rgba(37,99,235,.3);
  --active:#2563eb;--active-soft:rgba(37,99,235,.1);
  --success:#0f9d68;--success-soft:rgba(15,157,104,.1);
  --warning:#b26a00;--warning-soft:rgba(178,106,0,.1);
  --danger:#d33a52;--danger-soft:rgba(211,58,82,.1);
  --glow:0 0 16px rgba(37,99,235,.28);
  --shadow-card:0 1px 2px rgba(24,45,78,.06),0 10px 26px rgba(24,45,78,.08);
  --shadow-pop:0 18px 44px rgba(24,45,78,.18);
  --ambient:
    radial-gradient(1000px 560px at 8% -12%,rgba(37,99,235,.09),transparent 58%),
    radial-gradient(900px 520px at 104% -6%,rgba(124,58,237,.08),transparent 55%),
    linear-gradient(rgba(24,45,78,.03) 1px,transparent 1px) 0 0/100% 44px,
    linear-gradient(90deg,rgba(24,45,78,.03) 1px,transparent 1px) 0 0/44px 100%;
  --radius:10px;--radius-lg:16px;--radius-pill:999px;
  --font-mono:"IBM Plex Mono","JetBrains Mono","SFMono-Regular",Consolas,monospace;
  --font-display:"Space Grotesk",system-ui,"Segoe UI",Helvetica,Arial,sans-serif;
  --font-body:system-ui,-apple-system,"Segoe UI",sans-serif;
  --page-space:clamp(18px,2.6vw,40px);--sidebar-w:clamp(232px,18vw,288px);--terminal-w:clamp(420px,34vw,640px);
  --motion-fast:130ms;--motion-slow:280ms;--ease:cubic-bezier(.16,.84,.44,1);
}
`;

export const LAYOUT_STYLES = `
*{box-sizing:border-box}
html{min-width:320px;font-family:var(--font-mono)}
body{margin:0;min-width:320px;height:100vh;overflow:hidden;font-size:14px}
.app-shell{display:grid;grid-template-columns:var(--sidebar-w) minmax(0,1fr) 0;height:100vh;transition:grid-template-columns var(--motion-slow) var(--ease)}
body.terminal-active .app-shell{grid-template-columns:var(--sidebar-w) minmax(0,1fr) var(--terminal-w)}
/* Sidebar = task index (persistent) */
.sidebar{display:flex;flex-direction:column;min-height:0;height:100vh;padding:22px 18px 18px}
.sidebar-brand{display:flex;gap:12px;align-items:center;flex:none;margin-bottom:20px}
.sidebar-brand div{display:grid;gap:2px;min-width:0}
.sidebar .search{flex:none;margin-bottom:14px}
.filters{display:flex;gap:7px;flex-wrap:wrap;flex:none;margin-bottom:14px}
.board-caption{flex:none;margin-bottom:10px}
.task-list{flex:1;min-height:0;overflow-y:auto;display:grid;gap:8px;align-content:start;margin:0 -6px;padding:2px 6px}
.sidebar-foot{flex:none;padding-top:12px;margin-top:8px}
.sidebar-controls{display:grid;grid-template-columns:1fr 1fr;gap:8px;align-items:center}
/* Main column = focused single task */
.main-col{display:flex;flex-direction:column;min-width:0;height:100vh}
.topbar{flex:none;display:flex;align-items:center;justify-content:space-between;gap:18px;padding:18px var(--page-space)}
.topbar-title{display:flex;align-items:center;gap:14px;min-width:0}
.topbar-actions{display:flex;align-items:center;gap:18px;flex:none}
.clock{display:grid;justify-items:end;gap:5px;text-align:right}
.metrics{flex:none;display:grid;grid-template-columns:repeat(4,1fr);gap:12px;padding:0 var(--page-space) 18px}
.metrics article{display:grid;gap:8px;align-content:space-between;padding:16px 18px;min-height:92px}
.detail{flex:1;min-height:0;overflow-y:auto;padding:8px max(var(--page-space),calc((100% - 1120px) / 2)) 48px;min-width:0}
.detail-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px}
.row-list{display:grid;gap:10px}.row{display:flex;justify-content:space-between;gap:15px;align-items:baseline}
.detail-meta{display:flex;align-items:center;gap:10px 16px;flex-wrap:wrap;margin-top:16px}.detail-meta-item{display:grid;gap:3px}
.terminal-panel{grid-column:3;min-width:0;height:100vh;display:flex;flex-direction:column;overflow:hidden}
.terminal-panel[hidden]{display:none}
.terminal-head{flex:none;height:68px;display:flex;align-items:center;justify-content:space-between;gap:18px;padding:12px 18px}
.terminal-head>div{display:flex;align-items:center;gap:14px;min-width:0}.terminal-head h2{margin:0}
.terminal-host{flex:1;min-height:0;padding:8px 10px;overflow:hidden}
`;

export const COMPONENT_STYLES = `
html{background:var(--bg);color:var(--text)}
body{background:var(--ambient),var(--bg);background-attachment:fixed;color:var(--text);-webkit-font-smoothing:antialiased;transition:background-color var(--motion-fast),color var(--motion-fast)}
::selection{background:var(--accent);color:var(--on-accent)}
*{scrollbar-width:thin;scrollbar-color:var(--border-strong) transparent}
::-webkit-scrollbar{width:10px;height:10px}::-webkit-scrollbar-thumb{background:var(--border-strong);border-radius:var(--radius-pill);border:2px solid transparent;background-clip:content-box}::-webkit-scrollbar-track{background:transparent}
.skip-link{position:fixed;left:14px;top:-56px;background:var(--accent);color:var(--on-accent);padding:10px 15px;border-radius:var(--radius);z-index:80;text-decoration:none;font-size:12px;transition:top var(--motion-fast)}.skip-link:focus{top:14px}
button{font:inherit;cursor:pointer}
input:focus-visible,select:focus-visible,button:focus-visible,.task:focus-visible{outline:none;box-shadow:0 0 0 2px var(--bg),0 0 0 4px var(--accent)}

/* Sidebar */
.sidebar{border-right:1px solid var(--border);background:color-mix(in srgb,var(--bg-1) 82%,transparent);backdrop-filter:blur(12px);-webkit-backdrop-filter:blur(12px)}
.brand-mark{width:42px;height:42px;flex:none;display:grid;place-items:center;font-family:var(--font-display);font-size:22px;color:var(--on-accent);border-radius:12px;background:linear-gradient(140deg,var(--accent),var(--accent-2));box-shadow:var(--glow)}
.sidebar-brand strong{font-family:var(--font-display);font-size:20px;letter-spacing:.02em;line-height:1}
.sidebar-brand span,.live span,.select-control>span,.eyebrow,.metrics span,.clock span,.detail-section h3,.run-meta,.task-meta{color:var(--muted);font-size:10px;text-transform:uppercase;letter-spacing:.14em}
.board-caption .eyebrow{margin:0}
.live{display:flex;align-items:center;justify-content:center;gap:8px;padding:7px 12px;border:1px solid var(--border);border-radius:var(--radius);background:var(--bg-2);grid-column:1 / -1}
.live span{font-size:9px}
.live i{width:7px;height:7px;flex:none;background:var(--success);border-radius:50%;box-shadow:0 0 10px var(--success);animation:pulse 2.4s ease-in-out infinite}
@keyframes pulse{0%,100%{opacity:1}50%{opacity:.4}}
.select-control{display:grid;gap:6px;min-width:0}
.select-control select{width:100%;min-height:34px;padding:7px 26px 7px 11px;font-size:11px;color:var(--text);background:var(--bg-2);border:1px solid var(--border);border-radius:var(--radius);appearance:none;transition:border-color var(--motion-fast),background var(--motion-fast)}
.select-control select:hover{border-color:var(--border-strong)}
.search{position:relative;display:flex;align-items:center}
.search:before{content:"⌕";position:absolute;left:13px;color:var(--faint);font-size:16px;pointer-events:none}
.search input{width:100%;padding:10px 14px 10px 36px;font:inherit;color:var(--text);background:var(--bg-2);border:1px solid var(--border);border-radius:var(--radius-pill);transition:border-color var(--motion-fast),box-shadow var(--motion-fast)}
.search input::placeholder{color:var(--faint)}
.search input:focus{border-color:var(--accent-line);box-shadow:0 0 0 3px var(--accent-soft)}
.filter{border:1px solid var(--border);background:var(--bg-2);color:var(--muted);font-size:10px;text-transform:uppercase;letter-spacing:.1em;padding:6px 12px;border-radius:var(--radius-pill);transition:border-color var(--motion-fast),color var(--motion-fast),background var(--motion-fast)}
.filter:hover{border-color:var(--border-strong);color:var(--text)}
.filter[aria-pressed=true]{background:var(--accent);border-color:var(--accent);color:var(--on-accent);font-weight:600}

/* Sidebar task items — compact single column */
.task{width:100%;display:grid;grid-template-columns:8px minmax(0,1fr);gap:10px;text-align:left;align-items:start;padding:9px 12px;border:1px solid var(--border);border-radius:var(--radius);background:var(--bg-2);color:var(--text);box-shadow:var(--shadow-card);transition:border-color var(--motion-fast),transform var(--motion-fast),background var(--motion-fast)}
.task:hover{border-color:var(--border-strong);transform:translateY(-1px)}
.task[aria-current=true]{border-color:var(--accent-line);background:var(--bg-3);box-shadow:inset 3px 0 var(--accent),var(--shadow-card)}
.status-dot{width:8px;height:8px;border-radius:50%;margin-top:4px;background:var(--faint)}
.status-dot.active{background:var(--active);box-shadow:0 0 8px var(--active)}
.status-dot.completed{background:var(--success);box-shadow:0 0 8px var(--success)}
.status-dot.draft{background:var(--warning);box-shadow:0 0 8px var(--warning)}
.status-dot.cancelled{background:var(--danger)}
.status-dot.superseded{background:var(--accent-2)}
.status-dot.abandoned{background:var(--faint)}
.status-dot.archived{background:var(--faint)}
.task-main{min-width:0;display:grid;gap:5px}
.task-title{display:block;font-family:var(--font-body);font-size:13px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.task-meta{display:flex;gap:7px;flex-wrap:wrap;align-items:center;letter-spacing:.05em;font-size:9px}
.tag{color:var(--accent);background:var(--accent-soft);border:1px solid var(--accent-line);padding:1px 6px;border-radius:var(--radius-pill);letter-spacing:.02em;text-transform:none;font-size:9px}
.task-stats{display:flex;gap:6px;flex-wrap:wrap;margin-top:1px}
.task-stat{display:inline-flex;align-items:center;gap:5px;font-size:9px;text-transform:uppercase;letter-spacing:.06em;color:var(--muted);background:var(--bg-3);border:1px solid var(--border);padding:2px 8px;border-radius:var(--radius-pill)}
.task-stat b{color:var(--text);font-weight:600}
.task-stat.has-inputs{color:var(--warning);border-color:transparent;background:var(--warning-soft)}

/* Topbar */
.detail-back{width:38px;height:38px;flex:none;display:grid;place-items:center;font-size:18px;line-height:1;color:var(--muted);background:var(--bg-2);border:1px solid var(--border);border-radius:var(--radius);transition:border-color var(--motion-fast),color var(--motion-fast),background var(--motion-fast)}
.detail-back:hover{border-color:var(--accent-line);color:var(--accent);background:var(--accent-soft)}
.eyebrow{display:flex;align-items:center;gap:11px;margin:0 0 8px;color:var(--accent);letter-spacing:.24em}
.eyebrow:after{content:"";height:1px;width:38px;background:var(--accent-line)}
h1{font-family:var(--font-display);font-weight:600;font-size:clamp(26px,3.4vw,40px);letter-spacing:-.02em;line-height:1;margin:0}
.clock time{color:var(--text);font-size:13px;font-variant-numeric:tabular-nums;letter-spacing:.04em}
.refresh{display:inline-flex;align-items:center;gap:8px;padding:10px 15px;color:var(--text);background:var(--bg-2);border:1px solid var(--border);border-radius:var(--radius);transition:border-color var(--motion-fast),color var(--motion-fast),background var(--motion-fast)}
.refresh:hover,.refresh:focus-visible{border-color:var(--accent-line);color:var(--accent);background:var(--accent-soft)}
.refresh:disabled{opacity:.5;cursor:wait}
kbd{background:var(--bg-3);border:1px solid var(--border);border-bottom-width:2px;border-radius:5px;padding:1px 6px;font-size:11px;color:var(--muted)}

/* Metrics bar */
.metrics article{background:var(--bg-2);border:1px solid var(--border);border-radius:var(--radius-lg);box-shadow:var(--shadow-card);position:relative;overflow:hidden;transition:border-color var(--motion-fast),transform var(--motion-fast)}
.metrics article:hover{border-color:var(--border-strong);transform:translateY(-2px)}
.metrics article:first-child{border-color:var(--accent-line)}
.metrics article:first-child:before{content:"";position:absolute;inset:0;background:radial-gradient(160px 90px at 100% 0,var(--accent-soft),transparent 70%);pointer-events:none}
.metrics span{letter-spacing:.14em}
.metrics strong{font-family:var(--font-display);font-weight:600;font-size:34px;line-height:1;font-variant-numeric:tabular-nums}
.metrics article:first-child strong{color:var(--accent)}

/* Detail — global overview (default view) */
.overview{padding:14px 0 8px;display:grid;gap:26px}
.overview-head h2{font-family:var(--font-display);font-weight:600;font-size:clamp(24px,3vw,34px);letter-spacing:-.01em;margin:0 0 10px}
.overview-head .overview-lede{font-family:var(--font-body);color:var(--muted);line-height:1.6;margin:0;max-width:640px;font-size:15px}
.overview-block h3{margin:0 0 14px;color:var(--muted);font-size:10px;text-transform:uppercase;letter-spacing:.16em;display:flex;align-items:center;gap:11px}
.overview-block h3:after{content:"";flex:1;height:1px;background:var(--border)}
.dist-bar{display:flex;gap:3px;height:12px;border-radius:var(--radius-pill);overflow:hidden;background:var(--bg-3)}
.dist-seg{min-width:6px;border-radius:2px}
.dist-seg.active{background:var(--active)}.dist-seg.draft{background:var(--warning)}.dist-seg.completed{background:var(--success)}.dist-seg.cancelled{background:var(--danger)}.dist-seg.superseded{background:var(--accent-2)}.dist-seg.abandoned,.dist-seg.archived{background:var(--faint)}
.dist-legend{display:flex;gap:8px 20px;flex-wrap:wrap;margin-top:14px}
.legend-item{display:inline-flex;align-items:center;gap:7px;font-size:10px;text-transform:uppercase;letter-spacing:.1em;color:var(--muted)}
.legend-item .status-dot{margin-top:0}
.legend-item b{color:var(--text);font-family:var(--font-display);font-size:13px}
.overview-list{display:grid;gap:8px}
.overview-row{display:grid;grid-template-columns:8px minmax(0,1fr) auto;gap:12px;align-items:center;text-align:left;padding:11px 14px;border:1px solid var(--border);border-radius:var(--radius);background:var(--bg-2);color:var(--text);box-shadow:var(--shadow-card);transition:border-color var(--motion-fast),transform var(--motion-fast)}
.overview-row:hover{border-color:var(--border-strong);transform:translateY(-1px)}
.overview-row .status-dot{margin-top:0}
.overview-row-title{min-width:0;font-family:var(--font-body);font-size:14px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}

/* Detail — task content */
.detail-head{border-bottom:1px solid var(--border);padding:14px 0 22px}
.detail-id{display:inline-block;color:var(--accent);font-size:10px;letter-spacing:.14em;background:var(--accent-soft);border:1px solid var(--accent-line);padding:3px 10px;border-radius:var(--radius-pill)}
.detail h2{font-family:var(--font-display);font-weight:600;font-size:clamp(24px,3vw,34px);letter-spacing:-.01em;margin:12px 0}
.detail-description,.brief-focus,.run-copy p,.record-copy,.timeline-item p,.conclusion p{font-family:var(--font-body);line-height:1.62}
.detail-description{color:var(--muted);margin:0}
.detail-meta-item small,.run-copy small{color:var(--muted);font-size:9px;text-transform:uppercase;letter-spacing:.1em}
.detail-section{padding:22px 0;border-bottom:1px solid var(--border)}.detail-section:last-child{border-bottom:0}
.detail-section h3{margin:0 0 14px;letter-spacing:.16em;display:flex;align-items:center;gap:11px}
.detail-section h3:after{content:"";flex:1;height:1px;background:var(--border)}
.conclusion{padding:18px 20px;border:1px solid var(--success);background:var(--success-soft);border-radius:var(--radius-lg);margin:22px 0}
.conclusion h3{margin:0 0 10px;color:var(--success);letter-spacing:.16em;font-size:10px;text-transform:uppercase;display:flex;align-items:center;gap:10px}
.conclusion h3:before{content:"✓";display:grid;place-items:center;width:18px;height:18px;border-radius:50%;background:var(--success);color:var(--on-accent);font-size:11px}
.conclusion p{font-size:14px;margin:0;color:var(--text)}
.conclusion .run-meta{margin-top:10px}
.conclusion.retired{border-color:var(--warning);background:var(--warning-soft)}
.conclusion.retired h3{color:var(--warning)}
.conclusion.retired h3:before{content:"×";background:var(--warning);color:var(--on-accent)}
.conclusion.archived{border-color:var(--border-strong);background:var(--bg-2)}
.conclusion.archived h3{color:var(--muted)}
.conclusion.archived h3:before{content:"⇢";background:var(--border-strong);color:var(--text)}
.conclusion.archived p:first-of-type{color:var(--text)}
.conclusion .record-copy.muted{margin-top:6px}
.brief-focus{padding:14px 16px;border-left:2px solid var(--accent);background:linear-gradient(90deg,var(--accent-soft),transparent 85%);border-radius:0 var(--radius) var(--radius) 0;color:var(--text)}
.row{background:var(--bg-2);border:1px solid var(--border);padding:11px 14px;border-radius:var(--radius)}
.pill{font-size:9px;text-transform:uppercase;letter-spacing:.08em;color:var(--accent);background:var(--accent-soft);border:1px solid var(--accent-line);padding:3px 10px;border-radius:var(--radius-pill);white-space:nowrap}
.input-card{border:1px solid var(--warning);background:var(--warning-soft);padding:13px 15px;border-radius:var(--radius);color:var(--text)}
.input-card small{display:block;color:var(--warning);margin-bottom:7px;font-size:9px;text-transform:uppercase;letter-spacing:.1em}
.input-actions{display:flex;gap:8px;flex-wrap:wrap;margin-top:12px}
.input-answer{padding:7px 11px;color:var(--text);background:var(--bg-2);border:1px solid var(--border-strong);border-radius:var(--radius);font-size:11px;transition:border-color var(--motion-fast),color var(--motion-fast),background var(--motion-fast)}
.input-answer:hover{border-color:var(--accent-line);color:var(--accent);background:var(--accent-soft)}
.input-form{display:flex;gap:8px;flex:1}.input-form input{min-width:0;flex:1;padding:8px 10px;color:var(--text);background:var(--bg-2);border:1px solid var(--border);border-radius:var(--radius)}
.record-actions{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-top:9px}.record-actions .run-meta{margin-top:0}
.run-list,.timeline{display:grid;gap:10px}
.run-card,.record-card{background:var(--bg-2);border:1px solid var(--border);padding:14px 16px;border-radius:var(--radius);box-shadow:var(--shadow-card);transition:border-color var(--motion-fast)}
.run-card:hover,.record-card:hover{border-color:var(--border-strong)}
.run-card{border-left:2px solid var(--border)}
.run-card[data-status=active]{border-left-color:var(--accent)}
.run-card[data-status=completed],.run-card[data-status=yielded]{border-left-color:var(--success)}
.run-card[data-status=failed]{border-left-color:var(--danger)}
.run-head,.record-head{display:flex;align-items:start;justify-content:space-between;gap:12px}.run-head>div{display:grid;gap:4px}
.run-id{color:var(--faint);font-size:9px;letter-spacing:.08em}
.run-meta{display:flex;gap:6px 14px;flex-wrap:wrap;letter-spacing:.06em;margin-top:9px}
.run-copy{margin-top:13px}.run-copy p,.record-copy,.timeline-item p{font-size:12.5px;margin:5px 0 0}
.run-copy.outcome{border-left:2px solid var(--success);background:var(--success-soft);padding:9px 0 9px 12px;border-radius:0 var(--radius) var(--radius) 0}
.record-card .row{background:transparent;border:0;padding:0}
.record-copy.muted{color:var(--muted)}
.timeline{position:relative}
.timeline:before{content:"";position:absolute;left:10px;top:10px;bottom:10px;width:1px;background:var(--border)}
.timeline-item{position:relative;padding-left:28px}
.timeline-item:before{content:"";position:absolute;left:7px;top:7px;width:7px;height:7px;border-radius:50%;background:var(--accent);box-shadow:0 0 0 3px var(--bg-1)}
.timeline-item>time{display:block;color:var(--faint);font-size:9px;margin-bottom:5px;letter-spacing:.06em}
.pill[data-status=failed],.pill[data-status=cancelled],.pill[data-status=urgent],.pill[data-status=required]{color:var(--danger);background:var(--danger-soft);border-color:transparent}
.pill[data-status=active],.pill[data-status=running],.pill[data-status=user],.pill[data-status=operator]{color:var(--active);background:var(--active-soft);border-color:transparent}
.pill[data-status=completed],.pill[data-status=yielded],.pill[data-status=integrated],.pill[data-status=role-result]{color:var(--success);background:var(--success-soft);border-color:transparent}
.pill[data-status=pending],.pill[data-status=draft],.pill[data-status=recommended]{color:var(--warning);background:var(--warning-soft);border-color:transparent}
.pill[data-status=archived],.pill[data-status=superseded],.pill[data-status=abandoned],.pill[data-status=system]{color:var(--muted);background:var(--bg-3);border-color:transparent}

/* Enriched detail — chips, agent badges, criteria lists */
.record-head-pills{display:flex;gap:6px;flex-wrap:wrap;align-items:center}
.agent-badge{display:inline-flex;gap:5px;flex-wrap:wrap;align-items:center}
.chip-block{margin-top:12px;display:grid;gap:7px}
.chip-block>small,.labeled-copy>small{display:block;color:var(--muted);font-size:9px;text-transform:uppercase;letter-spacing:.1em}
.chip-row{display:flex;gap:6px;flex-wrap:wrap}
.chip{display:inline-flex;align-items:center;font-family:var(--font-mono);font-size:10px;letter-spacing:.02em;color:var(--muted);background:var(--bg-3);border:1px solid var(--border);padding:2px 9px;border-radius:var(--radius-pill);white-space:nowrap}
.chip.is-adapter{color:var(--text);font-weight:600}
.chip.is-active{color:var(--accent);background:var(--accent-soft);border-color:var(--accent-line)}
.criteria-list{margin:0;padding:0;list-style:none;display:grid;gap:6px}
.criteria-list li{position:relative;padding-left:16px;font-family:var(--font-body);font-size:12.5px;line-height:1.55;color:var(--muted)}
.criteria-list li:before{content:"";position:absolute;left:3px;top:8px;width:5px;height:5px;border-radius:50%;background:var(--accent-line)}
.labeled-copy{margin-top:12px;display:grid;gap:4px}
.input-policy{display:flex;gap:6px 12px;flex-wrap:wrap;align-items:center;margin-top:10px}
.input-policy span{color:var(--warning);font-size:9px;text-transform:uppercase;letter-spacing:.08em}
.meta-path{font-family:var(--font-mono);font-size:11px;word-break:break-all}

/* States */
.loading,.empty,.error{padding:40px 16px;color:var(--muted);text-align:center;font-size:12px;letter-spacing:.04em}
.error{color:var(--danger)}
.loading:before{content:"";display:block;width:20px;height:20px;margin:0 auto 14px;border:2px solid var(--border);border-top-color:var(--accent);border-radius:50%;animation:spin .8s linear infinite}
@keyframes spin{to{transform:rotate(360deg)}}
.toast{position:fixed;right:22px;bottom:22px;z-index:90;max-width:340px;background:var(--danger);color:#fff;padding:13px 17px;border-radius:var(--radius);box-shadow:var(--shadow-pop);transform:translateY(130px);opacity:0;transition:transform var(--motion-slow),opacity var(--motion-slow)}
.toast.show{transform:none;opacity:1}
.terminal-panel{color:var(--text);background:#080b11;border-left:1px solid var(--border-strong);box-shadow:var(--shadow-pop)}
.terminal-head{border-bottom:1px solid #263244;background:#0c111a}
.terminal-head .live{width:auto;padding:5px 9px;background:#111826}.terminal-head .live span{color:#8b99ad}
.terminal-head h2{font-family:var(--font-display);font-size:16px;color:#e8eef6}
.terminal-close{display:grid!important;color:#8b99ad;background:#111826;border-color:#263244}
.terminal-host .xterm{height:100%}.terminal-host .xterm-viewport{scrollbar-width:none}.terminal-host .xterm-viewport::-webkit-scrollbar{display:none}
.sr-only{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0}
`;

export const RESPONSIVE_STYLES = `
/* Back button is hidden by default at every width; only the narrow master-detail
   layout reveals it while a task is open. */
.detail-back{display:none}
@media(max-width:1080px){
  .metrics strong{font-size:30px}
}
@media(max-width:900px){
  /* Master-detail: sidebar list by default; selecting a task swaps to detail */
  body{overflow:auto}
  .app-shell{grid-template-columns:1fr;height:auto;min-height:100vh}
  body.terminal-active .app-shell{grid-template-columns:1fr}
  .sidebar{height:auto;min-height:100vh;border-right:0;border-bottom:1px solid var(--border)}
  .task-list{overflow:visible}
  .main-col{display:none;height:auto;min-height:100vh}
  body.detail-active .sidebar{display:none}
  body.detail-active .main-col{display:flex}
  body.detail-active .detail-back{display:grid}
  .detail{overflow:visible}
  /* Terminal panel overlays full-screen instead of occupying a grid column */
  .terminal-panel{position:fixed;inset:0;z-index:70;grid-column:auto;height:100vh;border-left:0}
}
@media(max-width:620px){
  .metrics{grid-template-columns:repeat(2,1fr)}
  .metrics article{min-height:80px;padding:14px}
  .metrics strong{font-size:28px}
  .detail-grid{grid-template-columns:1fr}
  .topbar{flex-wrap:wrap;gap:12px}
}
@media(prefers-reduced-motion:reduce){*{scroll-behavior:auto!important;transition:none!important;animation:none!important}}
`;
