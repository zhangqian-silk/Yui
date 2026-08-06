/*
 * RESPONSIVE — breakpoints only.
 * Back button is hidden by default; only the narrow master-detail layout
 * reveals it while a task is open.
 */
export const RESPONSIVE_STYLES = `
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
  .overview-duo{grid-template-columns:1fr}
  /* Terminal panel overlays full-screen instead of occupying a grid column */
  .terminal-panel{position:fixed;inset:0;z-index:70;grid-column:auto;height:100vh;border-left:0}
}
@media(max-width:620px){
  .command-rail{grid-template-columns:repeat(2,1fr)}
  .metric{min-height:80px;padding:13px 15px}
  .metric-value{font-size:26px}
  /* Keep the topbar on one line: clock and key hints are expendable */
  .clock{display:none}
  .refresh kbd{display:none}
  .topbar{flex-wrap:nowrap;gap:10px}
  .detail-tabs{mask-image:linear-gradient(90deg,#000 calc(100% - 28px),transparent);-webkit-mask-image:linear-gradient(90deg,#000 calc(100% - 28px),transparent)}
  .record-cols{grid-template-columns:1fr}
}
@media(prefers-reduced-motion:reduce){*{scroll-behavior:auto!important;transition:none!important;animation:none!important}}
`;
