/*
 * DESIGN TOKEN CONTRACT
 * ---------------------
 * Layout is fully decoupled from themes. Geometry, type, metrics, and motion
 * live once in the theme-independent :root block below and are shared by every
 * theme. A [data-theme="..."] block defines ONLY color / surface / effect
 * tokens, so switching (or adding) a theme can never change layout, sizing, or
 * position. Layout / component / responsive styles reference these variables
 * only — never hardcode a color outside a theme block.
 *
 * To add a theme: copy a color block, rename the selector, retune the color
 * values, then register the name in client/theme.ts (THEMES) and add an
 * <option> in shell.ts. Do NOT put layout tokens in a theme block; if a future
 * theme genuinely needs to affect layout, revisit this contract deliberately.
 *
 * Theme-independent (:root, shared by all themes)
 *   Geometry   --radius --radius-lg --radius-pill
 *   Type       --font-mono --font-display --font-body
 *   Metrics    --page-space --sidebar-w --terminal-w
 *   Motion     --motion-fast --motion-slow --ease
 *
 * Per-theme ([data-theme="..."], color only)
 *   Surfaces   --bg --bg-1 --bg-2 --bg-3            (page → elevated layers)
 *   Lines      --border --border-strong
 *   Text       --text --muted --faint
 *   Accent     --accent --accent-2 --on-accent --accent-soft --accent-line
 *   Semantic   --active/--success/--warning/--danger (+ matching --*-soft)
 *   Effects    --glow --shadow-card --shadow-pop --ambient
 */
export const TOKEN_STYLES = `
/* Theme-independent layout tokens — shared by every theme (see contract above).
   Never move these into a [data-theme] block. */
:root{
  --radius:10px;--radius-lg:16px;--radius-pill:999px;
  --font-mono:"JetBrains Mono","SFMono-Regular",Consolas,monospace;
  --font-display:"Inter",system-ui,-apple-system,"Segoe UI",sans-serif;
  --font-body:"Inter",system-ui,-apple-system,"Segoe UI",sans-serif;
  --page-space:clamp(18px,2.6vw,40px);--sidebar-w:clamp(232px,18vw,288px);--terminal-w:clamp(420px,34vw,640px);
  --motion-fast:150ms;--motion-slow:320ms;--ease:cubic-bezier(.16,.84,.44,1);
}
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
  --shadow-card:0 1px 2px rgba(0,0,0,.32),0 4px 12px rgba(0,0,0,.18);
  --shadow-pop:0 18px 48px rgba(0,0,0,.5);
  --ambient:
    radial-gradient(1000px 560px at 8% -12%,rgba(73,214,255,.12),transparent 58%),
    radial-gradient(900px 520px at 104% -6%,rgba(167,139,250,.12),transparent 55%),
    linear-gradient(rgba(255,255,255,.022) 1px,transparent 1px) 0 0/100% 44px,
    linear-gradient(90deg,rgba(255,255,255,.022) 1px,transparent 1px) 0 0/44px 100%;
}
[data-theme="atlas"]{
  color-scheme:dark;
  --bg:#051221;--bg-1:#081a2c;--bg-2:#0c2436;--bg-3:#122d44;
  --border:#153349;--border-strong:#2a4a63;
  --text:#e6f2fb;--muted:#8ba9c2;--faint:#567184;
  --accent:#38e1d4;--accent-2:#7cabf2;--on-accent:#04131d;
  --accent-soft:rgba(56,225,212,.1);--accent-line:rgba(56,225,212,.32);
  --active:#38e1d4;--active-soft:rgba(56,225,212,.12);
  --success:#49db9e;--success-soft:rgba(73,219,158,.12);
  --warning:#ffc86b;--warning-soft:rgba(255,200,107,.12);
  --danger:#ff7a8f;--danger-soft:rgba(255,122,143,.12);
  --glow:0 0 18px rgba(56,225,212,.4);
  --shadow-card:0 1px 2px rgba(0,0,0,.32),0 4px 12px rgba(0,0,0,.18);
  --shadow-pop:0 18px 48px rgba(0,0,0,.5);
  --ambient:
    radial-gradient(1000px 560px at 10% -14%,rgba(56,225,212,.11),transparent 58%),
    radial-gradient(900px 520px at 106% -6%,rgba(124,171,242,.1),transparent 55%),
    linear-gradient(rgba(230,242,251,.018) 1px,transparent 1px) 0 0/100% 44px,
    linear-gradient(90deg,rgba(230,242,251,.018) 1px,transparent 1px) 0 0/44px 100%;
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
  --shadow-card:0 1px 2px rgba(24,45,78,.05),0 4px 14px rgba(24,45,78,.07);
  --shadow-pop:0 18px 44px rgba(24,45,78,.18);
  --ambient:
    radial-gradient(1000px 560px at 8% -12%,rgba(37,99,235,.09),transparent 58%),
    radial-gradient(900px 520px at 104% -6%,rgba(124,58,237,.08),transparent 55%),
    linear-gradient(rgba(24,45,78,.03) 1px,transparent 1px) 0 0/100% 44px,
    linear-gradient(90deg,rgba(24,45,78,.03) 1px,transparent 1px) 0 0/44px 100%;
}
`;

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
.filter-dot.archived{background:var(--muted)}
.filter-chip[data-status=active].is-active{color:var(--active);background:var(--active-soft);border-color:color-mix(in srgb,var(--active) 45%,transparent)}
.filter-chip[data-status=active].is-active .filter-count{color:var(--active)}
.filter-chip[data-status=draft].is-active{color:var(--warning);background:var(--warning-soft);border-color:color-mix(in srgb,var(--warning) 45%,transparent)}
.filter-chip[data-status=draft].is-active .filter-count{color:var(--warning)}
.filter-chip[data-status=completed].is-active{color:var(--success);background:var(--success-soft);border-color:color-mix(in srgb,var(--success) 45%,transparent)}
.filter-chip[data-status=completed].is-active .filter-count{color:var(--success)}
.filter-chip[data-status=archived].is-active{color:var(--muted);background:var(--bg-3);border-color:var(--border-strong)}
.filter-chip[data-status=archived].is-active .filter-count{color:var(--muted)}
.task-list{flex:1;min-height:0;overflow-y:auto;display:grid;gap:3px;align-content:start;margin:0 -4px;padding:2px 4px}
.task-group{display:grid;gap:7px}
.task-group-head{display:flex;align-items:baseline;gap:8px;padding:3px 4px 2px}
.sidebar-foot{flex:none;padding-top:10px;margin-top:8px;display:grid;gap:8px}
.sidebar-controls{display:grid;grid-template-columns:1fr 1fr;gap:8px;align-items:center}
/* Main column = top bar + optional section nav + reading surface */
.main-col{display:flex;flex-direction:column;min-width:0;min-height:0;height:100vh;overflow-y:auto;scrollbar-gutter:stable}
.topbar{position:sticky;top:0;z-index:30;flex:none;display:flex;align-items:center;justify-content:space-between;gap:18px;padding:11px var(--page-space);background:color-mix(in srgb,var(--bg) 92%,transparent);backdrop-filter:blur(10px);-webkit-backdrop-filter:blur(10px);border-bottom:1px solid var(--border)}
.topbar-leading{display:flex;align-items:center;gap:14px;min-width:0}
.breadcrumb{display:flex;align-items:baseline;gap:8px;min-width:0}
.crumb-current{margin:0;min-width:0;font-family:var(--font-display);font-weight:600;font-size:clamp(14px,1.3vw,17px);letter-spacing:-.01em;line-height:1.25;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.topbar-actions{display:flex;align-items:center;gap:14px;flex:none}
.clock{display:grid;justify-items:end;gap:2px;text-align:right;line-height:1.2}
/* Sticky section navigation, only meaningful while a task is open */
.detail-tabs{position:sticky;top:var(--topbar-h,44px);z-index:20;flex:none;display:none;gap:0;padding:0 calc(var(--page-space) - 4px);background:color-mix(in srgb,var(--bg) 92%,transparent);backdrop-filter:blur(10px);-webkit-backdrop-filter:blur(10px);border-bottom:1px solid var(--border);overflow-x:auto;scrollbar-width:none}
body.detail-active .detail-tabs{display:flex}
.tab{flex:none;padding:11px 13px;color:var(--muted);font-family:var(--font-mono);font-size:10px;text-transform:uppercase;letter-spacing:.09em;background:transparent;border:0;border-bottom:2px solid transparent;cursor:pointer;white-space:nowrap;transition:color var(--motion-fast),border-color var(--motion-fast)}
.tab:hover{color:var(--text)}
.tab.is-active{color:var(--accent);border-bottom-color:var(--accent)}
.detail{flex:1;min-height:0;padding:16px var(--page-space) 72px;min-width:0}
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

export const COMPONENT_STYLES = `
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
.select-control{display:grid;gap:5px;min-width:0}
.select-control select{width:100%;min-height:34px;padding:6px 26px 6px 11px;font-size:11px;color:var(--text);background:var(--bg-2);border:1px solid var(--border);border-radius:var(--radius);appearance:none;cursor:pointer;transition:border-color var(--motion-fast)}
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
/* Sidebar task cards */
.task{display:grid;grid-template-columns:8px minmax(0,1fr) auto;gap:2px 9px;align-items:center;width:100%;text-align:left;padding:5px 9px;border:1px solid transparent;border-radius:var(--radius);background:transparent;color:var(--text);transition:background var(--motion-fast),border-color var(--motion-fast)}
.task:hover{background:var(--bg-2);border-color:var(--border)}
.task[aria-current=true]{background:var(--bg-3);border-color:var(--accent-line);box-shadow:inset 2px 0 var(--accent)}
.task .status-dot{grid-row:1;align-self:center;margin-top:0}
.task-main{grid-row:1;grid-column:2;min-width:0;display:flex;align-items:baseline;gap:8px}
.task-title{flex:1;min-width:0;display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-family:var(--font-body);font-size:12.5px;font-weight:600;line-height:1.3;color:var(--text)}
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
/* Overview scaffolding */
.overview{display:grid;gap:14px;padding-top:2px}
.overview-block{display:grid;gap:8px}
.section-head{display:flex;align-items:center;gap:10px;min-height:22px}
.section-head h3{margin:0;font-family:var(--font-display);font-weight:700;font-size:14px;letter-spacing:-.01em;color:var(--text)}
.section-count{display:inline-grid;place-items:center;min-width:20px;height:20px;padding:0 6px;border-radius:var(--radius-pill);background:var(--bg-3);border:1px solid var(--border);color:var(--muted);font-family:var(--font-mono);font-size:10.5px;font-weight:500}
.section-label{color:var(--muted);font-family:var(--font-mono);font-size:9.5px;text-transform:uppercase;letter-spacing:.12em;margin-left:auto}
.section-kicker{color:var(--faint);font-family:var(--font-body);font-size:11.5px;margin-left:4px;align-self:baseline}
.overview-list{display:grid;gap:7px}
.overview-row{display:grid;grid-template-columns:8px minmax(0,1fr) auto;gap:10px;align-items:center;text-align:left;padding:7px 11px;border:1px solid var(--border);border-radius:var(--radius);background:var(--bg-2);color:var(--text);box-shadow:var(--shadow-card);transition:border-color var(--motion-fast),box-shadow var(--motion-fast)}
.overview-row:hover{border-color:var(--border-strong);box-shadow:0 1px 2px rgba(0,0,0,.32),0 6px 16px rgba(0,0,0,.22)}
.overview-row .status-dot{margin-top:0}
.overview-row-title{min-width:0;font-family:var(--font-body);font-size:12px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.overview-row-time{font-family:var(--font-mono);font-size:10px;color:var(--muted);letter-spacing:.02em;white-space:nowrap}
.overview-row.has-inputs .status-dot{background:var(--warning);box-shadow:0 0 8px var(--warning)}
.inbox-empty{display:flex;align-items:center;gap:10px;padding:13px 16px;border:1px dashed var(--border);border-radius:var(--radius);color:var(--muted);font-family:var(--font-body);font-size:12px}
.inbox-empty .dot{width:8px;height:8px;flex:none;border-radius:50%;background:var(--success);box-shadow:0 0 8px var(--success)}
.inbox-list{display:grid;gap:7px}
.inbox-row{display:grid;grid-template-columns:minmax(0,1fr) auto;grid-template-rows:auto auto;gap:3px 14px;width:100%;text-align:left;align-items:center;padding:8px 12px;border:1px solid var(--border);border-left:3px solid var(--warning);background:var(--warning-soft);border-radius:var(--radius);color:var(--text);cursor:pointer;transition:border-color var(--motion-fast),box-shadow var(--motion-fast)}
.inbox-row:hover{border-color:var(--border-strong);box-shadow:var(--shadow-card)}
.inbox-lead{display:flex;align-items:center;gap:9px;min-width:0;grid-column:1}
.inbox-dot{width:8px;height:8px;flex:none;border-radius:50%;background:var(--warning);box-shadow:0 0 8px var(--warning)}
.inbox-head{display:flex;align-items:center;gap:9px;min-width:0}
.inbox-task{font-family:var(--font-mono);font-size:10px;letter-spacing:.08em;text-transform:uppercase;color:var(--muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.inbox-question{grid-column:1;grid-row:2;font-family:var(--font-body);font-size:13px;font-weight:600;line-height:1.4;color:var(--text);min-width:0;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
.inbox-foot{grid-column:2;grid-row:1 / span 2;display:flex;flex-direction:column;align-items:flex-end;justify-content:center;gap:4px;flex:none}
.inbox-foot time{color:var(--muted);font-size:10.5px;font-family:var(--font-mono);letter-spacing:.03em}
.inbox-go{color:var(--warning);font-size:11.5px;font-weight:600;font-family:var(--font-body)}
/* Detail head */
.detail-scaffold{display:grid;gap:0}
.detail-head{display:grid;gap:8px;padding:8px 0 12px;border-bottom:1px solid var(--border)}
.detail-kicker{display:inline-flex;width:fit-content;color:var(--accent);font-family:var(--font-mono);font-size:10px;letter-spacing:.12em;background:var(--accent-soft);border:1px solid var(--accent-line);padding:3px 11px;border-radius:var(--radius-pill)}
.detail-title{margin:0;font-family:var(--font-display);font-weight:600;font-size:clamp(14px,1.1vw,16px);letter-spacing:-.01em;line-height:1.3;color:var(--text)}
.detail-description{font-family:var(--font-body);color:var(--muted);line-height:1.6;margin:0;max-width:76ch;font-size:14px}
.detail-meta{display:flex;align-items:center;gap:8px 18px;flex-wrap:wrap;padding-top:3px}
.detail-meta-item{display:inline-flex;align-items:baseline;gap:5px;min-width:0}
.detail-meta-item small{color:var(--muted);font-family:var(--font-mono);font-size:8.5px;text-transform:uppercase;letter-spacing:.1em;flex:none}
.detail-meta-item>span{color:var(--text);font-size:12.5px;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.detail-meta-item>.meta-path{font-family:var(--font-mono);font-size:11px;color:var(--muted);max-width:420px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.detail-meta-item>.pill{align-self:end}
/* Pills + dots */
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
/* Bands */
.conclusion{padding:13px 16px;border:1px solid var(--success);background:var(--success-soft);border-radius:var(--radius-lg);margin:16px 0;display:grid;gap:7px}
.conclusion h3{margin:0;color:var(--success);letter-spacing:.14em;font-family:var(--font-mono);font-size:10px;text-transform:uppercase;display:flex;align-items:center;gap:10px}
.conclusion h3:before{content:"✓ ";display:grid;place-items:center;width:18px;height:18px;border-radius:50%;background:var(--success);color:var(--on-accent);font-size:11px}
.conclusion p{font-size:14px;margin:0;color:var(--text);font-family:var(--font-body);line-height:1.6}
.conclusion.retired{border-color:var(--warning);background:var(--warning-soft)}
.conclusion.retired h3{color:var(--warning)}
.conclusion.retired h3:before{content:"× ";background:var(--warning);color:var(--on-accent)}
.conclusion.archived{border-color:var(--border-strong);background:var(--bg-2)}
.conclusion.archived h3{color:var(--muted)}
.conclusion.archived h3:before{content:"→ ";background:var(--border-strong);color:var(--text)}
.conclusion-meta{display:flex;gap:14px;flex-wrap:wrap;color:var(--muted);font-size:11px;font-family:var(--font-body)}
/* Sections */
.detail-section{display:grid;gap:8px;padding:11px 0;border-bottom:1px solid var(--border)}
.detail-section:last-child{border-bottom:0}
.section-body{display:grid;gap:7px}
.row{display:flex;justify-content:space-between;align-items:baseline;gap:10px;background:var(--bg-2);border:1px solid var(--border);padding:9px 12px;border-radius:var(--radius);color:var(--muted);font-family:var(--font-body);font-size:12px}
/* Cards */
.record-card{background:var(--bg-2);border:1px solid var(--border);padding:9px 11px;border-radius:var(--radius);box-shadow:var(--shadow-card);transition:border-color var(--motion-fast);display:grid;gap:7px}
.record-card:hover{border-color:var(--border-strong)}
.record-head{display:flex;align-items:flex-start;justify-content:space-between;gap:12px;min-width:0}
.record-title{font-family:var(--font-body);font-weight:700;font-size:14px;line-height:1.3;color:var(--text);min-width:0}
.record-title-row{display:flex;align-items:center;gap:9px;min-width:0}
.record-title-row .status-dot{margin-top:0}
.record-pills{display:flex;gap:6px;flex-wrap:wrap;flex:none}
.record-meta{display:flex;gap:10px 16px;flex-wrap:wrap;color:var(--muted);font-family:var(--font-body);font-size:11px}
.record-meta .mono{font-family:var(--font-mono);color:var(--faint);font-size:10px}
.record-meta time{color:var(--muted)}
.record-cols{display:grid;grid-template-columns:repeat(auto-fit,minmax(230px,1fr));gap:10px;align-items:start;grid-auto-flow:dense}
.record-block{display:grid;gap:5px;align-content:start}
.record-block>small{display:block;color:var(--muted);font-family:var(--font-mono);font-size:8.5px;text-transform:uppercase;letter-spacing:.1em;font-weight:600}
.record-block p{margin:0;font-family:var(--font-body);font-size:12px;line-height:1.5;color:var(--text)}
.record-block p.muted,.record-block .muted{color:var(--muted)}
.record-actions{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-top:2px}
.record-actions .record-meta{margin:0}
.record-open{flex:none;display:inline-flex;align-items:center;gap:6px;padding:7px 13px;color:var(--text);background:var(--bg-3);border:1px solid var(--border);border-radius:var(--radius);font-family:var(--font-body);font-size:12px;font-weight:600;transition:border-color var(--motion-fast),color var(--motion-fast),background var(--motion-fast)}
.record-open:hover{border-color:var(--accent-line);color:var(--accent);background:var(--accent-soft)}
.record-open .arrow{font-weight:400;color:var(--faint);transition:transform var(--motion-fast)}
.record-open:hover .arrow{transform:translateX(2px);color:var(--accent)}
/* Input attention cards */
.input-card{border:1px solid var(--warning);background:var(--warning-soft);padding:11px 13px;border-radius:var(--radius);color:var(--text);display:grid;gap:8px}
.input-card-top{display:grid;gap:5px}
.input-card-top small{display:block;color:var(--warning);font-family:var(--font-mono);font-size:9px;text-transform:uppercase;letter-spacing:.11em;font-weight:600}
.input-question{font-family:var(--font-body);font-size:14px;font-weight:600;color:var(--text);line-height:1.35}
.input-context{display:flex;gap:10px;flex-wrap:wrap;color:var(--muted);font-family:var(--font-body);font-size:11px}
.input-blocked{display:block;padding:8px 12px;border:1px dashed var(--warning);border-radius:var(--radius);color:var(--muted);font-family:var(--font-mono);font-size:10.5px;letter-spacing:.04em}
.input-actions{display:flex;gap:8px;flex-wrap:wrap}
.input-answer{padding:7px 13px;color:var(--text);background:var(--bg-2);border:1px solid var(--border-strong);border-radius:var(--radius);font-family:var(--font-body);font-size:12px;font-weight:600;transition:border-color var(--motion-fast),color var(--motion-fast),background var(--motion-fast)}
.input-answer:hover{border-color:var(--accent-line);color:var(--accent);background:var(--accent-soft)}
.input-form{display:flex;gap:8px;flex:1}
.input-form input{min-width:0;flex:1;padding:8px 12px;color:var(--text);background:var(--bg-2);border:1px solid var(--border);border-radius:var(--radius);font-family:var(--font-body);font-size:12.5px}
/* Execution runs */
.run-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(min(320px,100%),1fr));gap:9px}
.execute-card{background:var(--bg-2);border:1px solid var(--border);border-left:2px solid var(--border);border-radius:var(--radius);padding:9px 12px;display:grid;gap:6px;box-shadow:var(--shadow-card);transition:border-color var(--motion-fast)}
.execute-card:hover{border-left-color:var(--border-strong)}
.execute-card[data-status=active]{border-left-color:var(--accent)}
.execute-card[data-status=completed],.execute-card[data-status=yielded]{border-left-color:var(--success)}
.execute-card[data-status=failed]{border-left-color:var(--danger)}
.execute-id{display:flex;align-items:center;gap:8px;flex-wrap:wrap;color:var(--muted);font-family:var(--font-mono);font-size:10px;letter-spacing:.04em}
.execute-id .status-dot{margin-top:0}
.execute-id .role{font-family:var(--font-body);font-weight:700;font-size:12.5px;color:var(--text)}
.execute-io{display:grid;gap:5px}
.execute-io>small{color:var(--muted);font-family:var(--font-mono);font-size:8.5px;text-transform:uppercase;letter-spacing:.1em;font-weight:600}
.execute-io p{margin:0;font-family:var(--font-body);font-size:12.5px;line-height:1.55;color:var(--text);max-height:6.2em;overflow-y:auto;padding-right:4px}
.execute-io.outcome{border-left:2px solid var(--success);background:var(--success-soft);padding:9px 0 9px 12px;border-radius:0 var(--radius) var(--radius) 0}
.execute-foot{display:flex;align-items:center;justify-content:space-between;gap:10px;flex-wrap:wrap;padding-top:4px}
.execute-tags{display:flex;align-items:center;gap:6px;flex-wrap:wrap;color:var(--muted);font-family:var(--font-mono);font-size:10px;letter-spacing:.05em}
.agent-badge{display:inline-flex;gap:5px;flex-wrap:wrap;align-items:center}
.chip{display:inline-flex;align-items:center;font-family:var(--font-mono);font-size:9.5px;letter-spacing:.02em;color:var(--muted);background:var(--bg-3);border:1px solid var(--border);padding:2px 9px;border-radius:var(--radius-pill);white-space:nowrap}
.chip.is-adapter{color:var(--text);font-weight:700}
.chip.is-active{color:var(--accent);background:var(--accent-soft);border-color:var(--accent-line)}
.chip-row{display:flex;gap:6px;flex-wrap:wrap}
.criteria-list{margin:0;padding:0;list-style:none;display:grid;gap:5px}
.criteria-list li{position:relative;padding-left:16px;font-family:var(--font-body);font-size:12px;line-height:1.45;color:var(--muted)}
.criteria-list li:before{content:"";position:absolute;left:3px;top:7px;width:5px;height:5px;border-radius:50%;background:var(--accent-line)}
/* Operator session control (top bar, right side).
   Kept visually consistent with the refresh button so the topbar actions read
   as one family: same background, border, radius, padding, and hover treatment. */
.operator-open{display:inline-flex;align-items:center;gap:8px;flex:none;padding:9px 14px;color:var(--text);background:var(--bg-2);border:1px solid var(--border);border-radius:var(--radius);font-family:var(--font-body);font-size:12px;font-weight:600;cursor:pointer;transition:border-color var(--motion-fast),color var(--motion-fast),background var(--motion-fast)}
.operator-open:hover,.operator-open:focus-visible{border-color:var(--accent-line);color:var(--accent);background:var(--accent-soft)}
.operator-title{flex:none;white-space:nowrap}
.operator-shortcuts{display:flex;gap:4px;flex:none}
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

export const RESPONSIVE_STYLES = `
/* Back button is hidden by default; only the narrow master-detail layout
   reveals it while a task is open. */
.detail-back{display:none}
@media(max-width:1080px){
  .metric-value{font-size:27px}
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
  .command-rail{grid-template-columns:repeat(2,1fr)}
  .metric{min-height:80px;padding:13px 15px}
  .metric-value{font-size:26px}
  .topbar{flex-wrap:wrap;gap:12px}
  .record-cols{grid-template-columns:1fr}
}
@media(prefers-reduced-motion:reduce){*{scroll-behavior:auto!important;transition:none!important;animation:none!important}}
`;
