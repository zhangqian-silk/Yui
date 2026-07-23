export const TOKEN_STYLES = `
:root,[data-theme="control-room"]{
  color-scheme:dark;
  --color-bg:#10110f;--color-surface:#171915;--color-raised:#1d201b;
  --color-border:#34382f;--color-muted:#949b8a;--color-text:#f0f1e9;
  --color-accent:#d6ff4b;--color-accent-muted:#a7c63b;--color-on-accent:#10110f;
  --color-warning:#ffbd59;--color-danger:#ff6b5f;--color-success:#62d998;
  --canvas-art:linear-gradient(90deg,transparent 49.9%,rgba(255,255,255,.018) 50%,transparent 50.1%);
  --shadow-live:0 0 10px var(--color-success);--radius:3px;
  --font-mono:"IBM Plex Mono","SFMono-Regular",Consolas,monospace;
  --font-display:Georgia,"Times New Roman",serif;--font-body:system-ui,sans-serif;
  --page-space:clamp(16px,2vw,28px);--motion-fast:160ms;
}
[data-theme="paper"]{
  color-scheme:light;
  --color-bg:#f4f0e6;--color-surface:#ece5d7;--color-raised:#e3dac8;
  --color-border:#c8bda8;--color-muted:#716a5d;--color-text:#24231f;
  --color-accent:#1d5c48;--color-accent-muted:#396f5e;--color-on-accent:#fffdf7;
  --color-warning:#9a601b;--color-danger:#a23f34;--color-success:#2d7254;
  --canvas-art:repeating-linear-gradient(0deg,transparent,transparent 31px,rgba(54,48,38,.035) 32px);
  --shadow-live:none;--radius:1px;
  --font-mono:"SFMono-Regular",Consolas,monospace;
  --font-display:"Iowan Old Style",Georgia,serif;--font-body:Georgia,serif;
  --page-space:clamp(16px,2vw,30px);--motion-fast:120ms;
}
`;

export const LAYOUT_STYLES = `
*{box-sizing:border-box}
html{min-width:320px;font-family:var(--font-mono)}
body{margin:0;min-width:320px;font-size:14px}
.masthead{min-height:72px;padding:12px var(--page-space);display:flex;align-items:center;justify-content:space-between;gap:22px}
.brand{display:flex;gap:12px;align-items:center;flex:none}.brand div{display:grid}
.header-actions{display:flex;align-items:center;justify-content:flex-end;gap:16px;flex-wrap:wrap}
main{max-width:1540px;margin:auto;padding:0 var(--page-space) var(--page-space)}
.hero{padding:clamp(34px,6vw,76px) 0 30px;display:flex;justify-content:space-between;align-items:flex-end;gap:30px}
.lede{max-width:560px;margin:20px 0 0}.clock{text-align:right;display:grid;justify-items:end;gap:7px}
.metrics{display:grid;grid-template-columns:repeat(4,1fr)}
.metrics article{padding:24px 20px;display:flex;align-items:baseline;justify-content:space-between;gap:14px}
.workspace{display:grid;grid-template-columns:minmax(0,1.55fr) minmax(330px,.85fr);min-height:560px}
.board-panel{padding:32px 30px 0 0}.toolbar{display:flex;gap:20px;justify-content:space-between;align-items:end}
.filters{display:flex;gap:7px;margin:20px 0;flex-wrap:wrap}
.task{width:100%;display:grid;grid-template-columns:12px minmax(0,1fr) auto;gap:14px;text-align:left;padding:20px 12px}
.task-main{min-width:0}.task-meta{display:flex;gap:10px;flex-wrap:wrap}.task-stats{text-align:right;line-height:1.8}
.detail{padding:32px 0 30px 30px;min-width:0}.empty-detail{height:100%;display:grid;place-content:center;max-width:360px}
.row-list{display:grid;gap:8px}.row{display:flex;justify-content:space-between;gap:15px}
`;

export const COMPONENT_STYLES = `
html{background:var(--color-bg);color:var(--color-text)}
body{background:var(--canvas-art),var(--color-bg);color:var(--color-text);transition:background-color var(--motion-fast),color var(--motion-fast)}
.skip-link{position:fixed;left:12px;top:-50px;background:var(--color-accent);color:var(--color-on-accent);padding:10px;z-index:20}.skip-link:focus{top:12px}
.masthead{border-bottom:1px solid var(--color-border)}
.brand-mark{width:38px;height:38px;display:grid;place-items:center;background:var(--color-accent);color:var(--color-on-accent);font-size:20px;font-family:var(--font-display)}
.brand strong{font-family:var(--font-display);font-size:21px;letter-spacing:.04em}
.brand div span,.live,.select-control>span{color:var(--color-muted);font-size:10px;text-transform:uppercase;letter-spacing:.12em}
.live{display:flex;align-items:center;gap:8px}.live i{width:7px;height:7px;background:var(--color-success);border-radius:50%;box-shadow:var(--shadow-live)}
.select-control{display:grid;gap:5px}.select-control select,.search input{background:var(--color-surface);border:1px solid var(--color-border);color:var(--color-text);font:inherit;border-radius:var(--radius)}
.select-control select{min-height:34px;padding:6px 28px 6px 9px;font-size:11px}.search input{width:min(320px,35vw);padding:11px 13px}
.hero,.metrics{border-bottom:1px solid var(--color-border)}
.eyebrow{margin:0 0 8px;color:var(--color-accent);font-size:10px;letter-spacing:.2em}
h1{font-family:var(--font-display);font-weight:400;font-size:clamp(46px,7vw,96px);letter-spacing:-.055em;line-height:.88;margin:0}
.lede,.detail-description,.empty-detail p,.brief-focus{font-family:var(--font-body);line-height:1.6}.lede,.detail-description,.empty-detail{color:var(--color-muted)}
.clock{color:var(--color-muted);font-size:10px;letter-spacing:.12em}.clock time{color:var(--color-text);font-size:12px}
button{font:inherit}.clock button{margin-top:8px;background:transparent;color:var(--color-text);border:1px solid var(--color-border);padding:9px 12px;cursor:pointer}
.clock button:hover,.clock button:focus-visible{border-color:var(--color-accent);color:var(--color-accent)}.clock button:disabled{opacity:.55;cursor:wait}
kbd{background:var(--color-raised);padding:2px 5px;margin-left:5px}
.metrics article{border-right:1px solid var(--color-border)}.metrics article:last-child{border-right:0}
.metrics span{color:var(--color-muted);font-size:11px;text-transform:uppercase;letter-spacing:.12em}
.metrics strong{font-family:var(--font-display);font-weight:400;font-size:36px}
.board-panel{border-right:1px solid var(--color-border)}.toolbar h2,.detail h2{font-family:var(--font-display);font-size:30px;font-weight:400;margin:0}
input:focus-visible,select:focus-visible,button:focus-visible,.task:focus-visible{outline:2px solid var(--color-accent);outline-offset:2px}
.filter{border:1px solid var(--color-border);background:transparent;color:var(--color-muted);font-size:10px;text-transform:uppercase;letter-spacing:.1em;padding:7px 10px;cursor:pointer}
.filter[aria-pressed=true]{background:var(--color-accent);border-color:var(--color-accent);color:var(--color-on-accent)}
.task-list{border-top:1px solid var(--color-border)}
.task{border:0;border-bottom:1px solid var(--color-border);background:transparent;color:var(--color-text);cursor:pointer}
.task:hover,.task[aria-current=true]{background:var(--color-raised)}.task[aria-current=true]{box-shadow:inset 3px 0 var(--color-accent)}
.status-dot{width:7px;height:7px;border-radius:50%;margin-top:5px;background:var(--color-muted)}
.status-dot.active{background:var(--color-accent)}.status-dot.completed{background:var(--color-success)}.status-dot.draft{background:var(--color-warning)}.status-dot.archived{background:var(--color-muted)}
.task-title{display:block;font-size:14px;margin-bottom:7px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.task-meta,.task-stats{color:var(--color-muted);font-size:10px;text-transform:uppercase;letter-spacing:.08em}.tag{color:var(--color-accent-muted)}
.empty-detail>span{font-size:34px;color:var(--color-accent)}.detail-head{border-bottom:1px solid var(--color-border);padding-bottom:22px}
.detail-id{color:var(--color-accent);font-size:10px;letter-spacing:.14em}.detail h2{font-size:36px;margin:7px 0 12px}
.detail-section{padding:20px 0;border-bottom:1px solid var(--color-border)}
.detail-section h3{font-size:10px;color:var(--color-muted);letter-spacing:.14em;text-transform:uppercase;margin:0 0 13px}
.brief-focus{padding:13px;border-left:2px solid var(--color-accent);background:var(--color-surface)}
.row{background:var(--color-surface);padding:10px}.pill{font-size:9px;text-transform:uppercase;letter-spacing:.08em;color:var(--color-accent)}
.input-card{border:1px solid var(--color-warning);padding:13px;color:var(--color-text)}.input-card small{display:block;color:var(--color-warning);margin-bottom:7px}
.detail-meta{display:flex;align-items:center;gap:8px 14px;flex-wrap:wrap;margin-top:16px}.detail-meta-item{display:grid;gap:3px}
.detail-meta-item small,.run-copy small{color:var(--color-muted);font-size:9px;text-transform:uppercase;letter-spacing:.1em}
.run-list,.timeline{display:grid;gap:10px}.run-card,.record-card,.timeline-item{background:var(--color-surface);border:1px solid var(--color-border);padding:13px}
.run-card[data-status=active]{border-left-color:var(--color-accent)}
.run-head,.record-head{display:flex;align-items:start;justify-content:space-between;gap:12px}.run-head>div{display:grid;gap:4px}
.run-id{color:var(--color-muted);font-size:9px;letter-spacing:.08em}.run-meta{display:flex;gap:6px 12px;flex-wrap:wrap;color:var(--color-muted);font-size:9px;text-transform:uppercase;letter-spacing:.06em;margin-top:8px}
.run-copy{margin-top:13px}.run-copy p,.record-copy,.timeline-item p{font-family:var(--font-body);font-size:12px;line-height:1.55;margin:5px 0 0}
.run-copy.outcome{border-left:2px solid var(--color-success);padding-left:10px}.record-card .row{background:transparent;padding:0}
.record-copy.muted{color:var(--color-muted)}.timeline-item{position:relative;padding-left:20px}.timeline-item:before{content:"";position:absolute;left:8px;top:17px;width:5px;height:5px;border-radius:50%;background:var(--color-accent)}
.timeline-item>time{display:block;color:var(--color-muted);font-size:9px;margin-bottom:5px}.pill[data-status=failed],.pill[data-status=urgent]{color:var(--color-danger)}.pill[data-status=active],.pill[data-status=running]{color:var(--color-accent)}.pill[data-status=completed],.pill[data-status=yielded]{color:var(--color-success)}.pill[data-status=pending],.pill[data-status=draft]{color:var(--color-warning)}
.loading,.empty,.error{padding:42px 12px;color:var(--color-muted)}.error{color:var(--color-danger)}
.toast{position:fixed;right:20px;bottom:20px;max-width:340px;background:var(--color-danger);color:var(--color-on-accent);padding:12px 16px;transform:translateY(100px);transition:transform var(--motion-fast)}.toast.show{transform:none}
.sr-only{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0}
`;

export const RESPONSIVE_STYLES = `
@media(max-width:980px){.masthead{align-items:flex-start}.header-actions{gap:10px}.live{width:100%;justify-content:flex-end}}
@media(max-width:850px){.hero{align-items:start}.clock{margin-top:8px}.metrics{grid-template-columns:repeat(2,1fr)}.metrics article:nth-child(2){border-right:0}.workspace{grid-template-columns:1fr}.board-panel{padding-right:0;border-right:0}.detail{padding-left:0;border-top:1px solid var(--color-border);min-height:360px}.toolbar{align-items:start;flex-direction:column}.search,.search input{width:100%}}
@media(max-width:640px){.masthead{align-items:center}.header-actions{width:auto}.live{display:none}.select-control>span{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0,0,0,0)}.select-control select{max-width:116px}}
@media(max-width:560px){.hero{display:block}.clock{margin-top:24px;text-align:left;justify-items:start}.metrics{grid-template-columns:1fr 1fr}.metrics article{display:grid}.metrics strong{font-size:30px}.task{grid-template-columns:10px minmax(0,1fr)}.task-stats{display:none}.toolbar h2{font-size:27px}}
@media(prefers-reduced-motion:reduce){*{scroll-behavior:auto!important;transition:none!important}}
`;
