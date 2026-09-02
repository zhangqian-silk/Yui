/*
 * CARDS — content-bearing surfaces.
 * Overview blocks, detail head / conclusion band, sections, record cards,
 * input cards, Turn cards, criteria lists. Widgets (pills, chips, metrics)
 * live in widgets.ts; markdown typography lives in markdown.ts.
 */
export const CARD_STYLES = `
/* Overview scaffolding */
.overview{display:grid;gap:14px;padding-top:2px}
.overview-duo{display:grid;grid-template-columns:1fr 1fr;gap:14px;align-items:start}
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
.detail-scaffold{display:grid;gap:0;max-width:1100px;margin:0 auto}
.detail-head{display:grid;gap:8px;padding:8px 0 12px;border-bottom:1px solid var(--border)}
.detail-kicker{display:inline-flex;width:fit-content;color:var(--accent);font-family:var(--font-mono);font-size:10px;letter-spacing:.12em;background:var(--accent-soft);border:1px solid var(--accent-line);padding:3px 11px;border-radius:var(--radius-pill)}
.detail-title{margin:0;font-family:var(--font-display);font-weight:600;font-size:clamp(14px,1.1vw,16px);letter-spacing:-.01em;line-height:1.3;color:var(--text)}
.detail-description{font-family:var(--font-body);color:var(--muted);line-height:1.6;margin:0;max-width:76ch;font-size:14px}
.detail-meta{display:flex;align-items:center;gap:8px 18px;flex-wrap:wrap;padding-top:3px}
.detail-meta-item{display:inline-flex;align-items:center;gap:6px;min-width:0}
.detail-meta-item small{color:var(--muted);font-family:var(--font-mono);font-size:9.5px;text-transform:uppercase;letter-spacing:.1em;flex:none}
.detail-meta-item>span{color:var(--text);font-size:12px;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.detail-meta-item>.meta-path{font-family:var(--font-mono);font-size:11px;color:var(--muted);max-width:420px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.detail-meta-item>.pill{align-self:center}
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
.conclusion-meta{display:flex;gap:14px;flex-wrap:wrap;color:var(--muted);font-size:10.5px;font-family:var(--font-mono);letter-spacing:.02em}
/* Sections */
.detail-section{display:grid;gap:8px;padding:11px 0;border-bottom:1px solid var(--border)}
.detail-section:last-child{border-bottom:0}
.section-body{display:grid;gap:7px}
.row-list{display:grid;gap:7px}
.row{display:flex;justify-content:space-between;align-items:baseline;gap:10px;background:var(--bg-2);border:1px solid var(--border);padding:9px 12px;border-radius:var(--radius);color:var(--muted);font-family:var(--font-body);font-size:12px}
.row.is-empty{justify-content:center;border-style:dashed;color:var(--faint)}
/* Cards */
.record-card{background:var(--bg-2);border:1px solid var(--border);padding:9px 11px;border-radius:var(--radius);box-shadow:var(--shadow-card);transition:border-color var(--motion-fast);display:grid;gap:7px}
.record-card:hover{border-color:var(--border-strong)}
.record-head{display:flex;align-items:flex-start;justify-content:space-between;gap:12px;min-width:0}
.record-title{font-family:var(--font-body);font-weight:700;font-size:14px;line-height:1.3;color:var(--text);min-width:0}
.record-title-row{display:flex;align-items:center;gap:9px;min-width:0}
.record-title-row .status-dot{margin-top:0}
.record-pills{display:flex;gap:6px;flex-wrap:wrap;flex:none}
.record-meta{display:flex;gap:10px 16px;flex-wrap:wrap;color:var(--muted);font-family:var(--font-mono);font-size:10.5px;letter-spacing:.02em}
.record-meta .meta-name{font-family:var(--font-body);font-size:11px;font-weight:600;color:var(--text)}
.record-meta .mono{color:var(--faint)}
.record-meta time{color:var(--muted)}
.record-cols{display:grid;grid-template-columns:repeat(auto-fit,minmax(230px,1fr));gap:10px;align-items:start;grid-auto-flow:dense}
.record-cols .is-wide{grid-column:1 / -1}
.work-item-chips{display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:10px;align-items:start}
.record-block{display:grid;gap:5px;align-content:start}
.record-block>small{display:block;color:var(--text);font-family:var(--font-body);font-size:13px;font-weight:600;letter-spacing:-.005em;margin-bottom:1px}
.record-block p{margin:0;font-family:var(--font-body);font-size:12px;line-height:1.6;color:var(--text)}
.record-block p.muted,.record-block .muted{color:var(--muted)}
.outcome-callout{border-left:2px solid var(--success);background:var(--success-soft);padding:9px 12px;border-radius:0 var(--radius) var(--radius) 0}
.outcome-callout>small{color:var(--success)}
.record-open{flex:none;display:inline-flex;align-items:center;gap:6px;padding:7px 13px;color:var(--text);background:var(--bg-3);border:1px solid var(--border);border-radius:var(--radius);font-family:var(--font-body);font-size:12px;font-weight:600;transition:border-color var(--motion-fast),color var(--motion-fast),background var(--motion-fast)}
.record-open:hover{border-color:var(--accent-line);color:var(--accent);background:var(--accent-soft)}
.record-open .arrow{font-weight:400;color:var(--faint);transition:transform var(--motion-fast)}
.record-open:hover .arrow{transform:translateX(2px);color:var(--accent)}
/* Collapsible work items (closed records fold into a summary row) */
details.work-item-card>summary.record-head{list-style:none;cursor:pointer}
details.work-item-card>summary.record-head::-webkit-details-marker{display:none}
details.work-item-card>summary.record-head:before{content:"▸";flex:none;color:var(--faint);font-size:11px;margin-top:2px;transition:color var(--motion-fast)}
details.work-item-card[open]>summary.record-head:before{content:"▾";color:var(--muted)}
details.work-item-card>summary.record-head:hover:before{color:var(--accent)}
details.work-item-card>summary.record-head~*{margin-top:0}
/* Input attention cards */
.input-card{border:1px solid var(--warning);background:var(--warning-soft);padding:11px 13px;border-radius:var(--radius);color:var(--text);display:grid;gap:8px}
.input-card-top{display:grid;gap:5px}
.input-card-top small{display:block;color:var(--warning);font-family:var(--font-body);font-size:13px;font-weight:600;letter-spacing:-.005em}
.input-question{font-family:var(--font-body);font-size:14px;font-weight:600;color:var(--text);line-height:1.35}
.input-context{display:flex;align-items:center;gap:10px;flex-wrap:wrap;color:var(--muted);font-family:var(--font-mono);font-size:10.5px;letter-spacing:.02em}
.input-blocked{display:block;padding:8px 12px;border:1px dashed var(--warning);border-radius:var(--radius);color:var(--muted);font-family:var(--font-mono);font-size:10.5px;letter-spacing:.04em}
.input-actions{display:flex;gap:8px;flex-wrap:wrap}
.input-answer{padding:7px 13px;color:var(--text);background:var(--bg-2);border:1px solid var(--border-strong);border-radius:var(--radius);font-family:var(--font-body);font-size:12px;font-weight:600;transition:border-color var(--motion-fast),color var(--motion-fast),background var(--motion-fast)}
.input-answer:hover{border-color:var(--accent-line);color:var(--accent);background:var(--accent-soft)}
.input-form{display:flex;gap:8px;flex:1}
.input-form input{min-width:0;flex:1;padding:8px 12px;color:var(--text);background:var(--bg-2);border:1px solid var(--border);border-radius:var(--radius);font-family:var(--font-body);font-size:12.5px}
/* Execution Turns */
.turn-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(min(320px,100%),1fr));gap:9px}
.turn-filter{margin-bottom:3px}
.execute-card{background:var(--bg-2);border:1px solid var(--border);border-left:2px solid var(--border);border-radius:var(--radius);padding:9px 12px;display:grid;gap:6px;box-shadow:var(--shadow-card);transition:border-color var(--motion-fast)}
.execute-card:hover{border-left-color:var(--border-strong)}
.execute-card[data-status=active]{border-left-color:var(--accent)}
.execute-card[data-status=completed]{border-left-color:var(--success)}
.execute-card[data-status=failed]{border-left-color:var(--danger)}
.execute-id{display:flex;align-items:center;gap:8px;flex-wrap:wrap;color:var(--muted);font-family:var(--font-mono);font-size:10.5px;letter-spacing:.02em}
.execute-id .status-dot{margin-top:0}
.execute-id .role{font-family:var(--font-body);font-weight:700;font-size:14px;color:var(--text)}
.execute-io{display:grid;gap:5px}
.execute-io>small{color:var(--text);font-family:var(--font-body);font-size:13px;font-weight:600;letter-spacing:-.005em}
.execute-io p{margin:0;font-family:var(--font-body);font-size:12px;line-height:1.6;color:var(--text)}
.execute-io.outcome{border-left:2px solid var(--success);background:var(--success-soft);padding:9px 0 9px 12px;border-radius:0 var(--radius) var(--radius) 0}
.execute-io.outcome>small{color:var(--success)}
.execute-foot{display:flex;align-items:center;justify-content:space-between;gap:10px;flex-wrap:wrap;padding-top:4px}
.execute-tags{display:flex;align-items:center;gap:6px;flex-wrap:wrap;color:var(--muted);font-family:var(--font-mono);font-size:10px;letter-spacing:.05em}
/* Acceptance criteria — dash markers, not checkboxes (they are read-only) */
.criteria-list{margin:0;padding:0;list-style:none;display:grid;gap:6px}
.criteria-list li{position:relative;padding-left:16px;font-family:var(--font-body);font-size:12px;line-height:1.5;color:var(--text)}
.criteria-list li:before{content:"";position:absolute;left:0;top:8px;width:9px;height:2px;border:0;border-radius:2px;background:var(--border-strong)}
.criteria-block.is-collapsed .criteria-list li:nth-child(n+7){display:none}
/* Task-first execution status band */
.exec-band{display:grid;gap:8px;padding:11px 14px;border:1px solid var(--border);border-left:3px solid var(--accent);border-radius:var(--radius-lg);background:var(--bg-2);box-shadow:var(--shadow-card)}
.exec-band.is-danger{border-left-color:var(--danger)}
.exec-band.is-warning{border-left-color:var(--warning)}
.exec-band.is-active{border-left-color:var(--active)}
.exec-band.is-accent{border-left-color:var(--accent)}
.exec-band.is-muted{border-left-color:var(--faint)}
.exec-band-head{display:flex;align-items:center;gap:10px;flex-wrap:wrap}
.exec-band-owner{color:var(--muted);font-family:var(--font-body);font-size:12px;font-weight:600}
.exec-band-executors{color:var(--active);font-family:var(--font-mono);font-size:10px;letter-spacing:.04em}
.exec-band-stopped{color:var(--faint);font-family:var(--font-mono);font-size:10px;letter-spacing:.08em;text-transform:uppercase}
.exec-band-failclosed{color:var(--danger);font-family:var(--font-mono);font-size:10px;letter-spacing:.08em;text-transform:uppercase;border:1px solid var(--danger);padding:2px 8px;border-radius:var(--radius-pill)}
.exec-band-summary{margin:0;font-family:var(--font-body);font-size:13px;line-height:1.55;color:var(--text)}
.exec-signal-list{display:grid;gap:5px}
.exec-signal{display:flex;gap:9px;align-items:baseline;padding:6px 10px;border-radius:var(--radius);font-size:11.5px;line-height:1.45}
.exec-signal.is-attention{background:var(--warning-soft);border:1px solid color-mix(in srgb,var(--warning) 30%,transparent)}
.exec-signal.is-blocker{background:var(--danger-soft);border:1px solid color-mix(in srgb,var(--danger) 30%,transparent)}
.exec-signal-kind{flex:none;font-family:var(--font-mono);font-size:9.5px;letter-spacing:.06em;text-transform:uppercase;color:var(--muted)}
.exec-signal-text{min-width:0;color:var(--text)}
/* WorkItem execution and recovery */
.exec-group{gap:8px}
.lane-list{display:grid;gap:4px}
.lane-row{display:flex;align-items:center;gap:9px;padding:5px 9px;border-radius:var(--radius);background:var(--bg-3);border:1px solid var(--border);font-size:11.5px}
.lane-row .status-dot{margin-top:0}
.lane-role{font-family:var(--font-body);font-weight:700;font-size:12px;color:var(--text)}
.lane-status{font-family:var(--font-mono);font-size:9.5px;letter-spacing:.06em;text-transform:uppercase;color:var(--muted)}
.lane-summary{flex:1;min-width:0;color:var(--muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.execution-resource-meta,.work-item-observability{gap:10px;flex-wrap:wrap}
.execution-resource-meta .chip{margin-left:auto}
.observability-metrics{display:grid;grid-template-columns:repeat(6,minmax(0,1fr));gap:8px;margin-top:12px}
.observability-metrics .metric{min-height:52px;padding:8px 10px}
.observability-metrics .metric-value{font-size:18px}
.observability-context-meta{gap:10px;flex-wrap:wrap;margin-top:7px}
.dag-graph{display:grid;gap:8px}
.dag-node{display:grid;gap:6px;padding:9px 11px;background:var(--bg-2);border:1px solid var(--border);border-left:3px solid var(--faint);border-radius:var(--radius);box-shadow:var(--shadow-card)}
.dag-node.is-ready{border-left-color:var(--accent)}
.dag-node.is-running{border-left-color:var(--active)}
.dag-node.is-blocked,.dag-node.is-failed,.dag-node.is-awaiting_acceptance{border-left-color:var(--danger)}
.dag-node.is-completed{border-left-color:var(--success)}
.dag-node.is-retired{border-left-color:var(--faint)}
.dag-node-head{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.dag-node-head .status-dot{margin-top:0}
.dag-node-title{flex:1;min-width:0;font-size:12px;color:var(--text)}
.dag-node-deps{display:flex;align-items:center;gap:6px;flex-wrap:wrap;color:var(--muted);font-family:var(--font-mono);font-size:9.5px}
.dag-node-deps small{margin-right:2px;text-transform:uppercase;letter-spacing:.08em}
.dag-root-cause{color:var(--warning);font-family:var(--font-mono);font-size:9.5px;letter-spacing:.03em}
.chip.is-satisfied{color:var(--success);background:var(--success-soft);border-color:transparent}
.chip.is-active{color:var(--accent);background:var(--accent-soft);border-color:var(--accent-line)}
.chip.is-failed-open,.chip.is-dead{color:var(--danger);background:var(--danger-soft);border-color:transparent}
.exec-resolution{display:flex;gap:9px;align-items:baseline;flex-wrap:wrap;padding:7px 10px;border-radius:var(--radius);background:var(--accent-soft);border:1px solid var(--accent-line)}
.exec-resolution-decision{font-family:var(--font-mono);font-size:10px;letter-spacing:.08em;text-transform:uppercase;color:var(--accent)}
.exec-resolution-summary{flex:1;min-width:0;font-size:12px;color:var(--text)}
.exec-resolution time{color:var(--muted);font-size:10.5px}
/* Candidates */
.candidate-list{display:grid;gap:4px}
.candidate-row{display:flex;align-items:baseline;gap:9px;padding:5px 9px;border-radius:var(--radius);background:var(--bg-3);border:1px solid var(--border);font-size:11.5px}
.candidate-seq{flex:none;font-family:var(--font-mono);font-size:10px;color:var(--faint)}
.candidate-summary{flex:1;min-width:0;color:var(--text);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.candidate-source{flex:none;font-family:var(--font-mono);font-size:9.5px;letter-spacing:.04em;text-transform:uppercase;color:var(--muted)}
.candidate-row time{flex:none;color:var(--muted);font-size:10.5px}
/* Findings */
.finding-list{display:grid;gap:4px}
.finding-row{display:flex;align-items:baseline;gap:8px;padding:5px 9px;border-radius:var(--radius);background:var(--bg-3);border:1px solid var(--border);font-size:11.5px}
.finding-summary{flex:1;min-width:0;color:var(--text)}
.finding-row.is-critical,.finding-row.is-high{border-left:2px solid var(--danger)}
.finding-row.is-medium{border-left:2px solid var(--warning)}
.finding-row.is-low{border-left:2px solid var(--faint)}
.chip.is-critical{color:var(--danger);border-color:var(--danger)}
.chip.is-high{color:var(--danger)}
.chip.is-medium{color:var(--warning)}
.chip.is-low{color:var(--muted)}
/* Sidebar derived execution status */
.task-exec{grid-row:1;grid-column:3;align-self:center;flex:none;font-family:var(--font-mono);font-size:8.5px;letter-spacing:.05em;text-transform:uppercase;color:var(--faint);white-space:nowrap;max-width:90px;overflow:hidden;text-overflow:ellipsis}
.task-exec.is-blocked,.task-exec.is-attention{color:var(--danger)}
.task-exec.is-recovering,.task-exec.is-progressing-with-attention{color:var(--warning)}
.task-exec.is-working,.task-exec.is-waiting-on-agents{color:var(--active)}
.task-exec.is-needs-leader-action{color:var(--accent)}
/* Overview row derived status label */
.overview-row-label{font-family:var(--font-mono);font-size:9.5px;letter-spacing:.05em;text-transform:uppercase;color:var(--warning);white-space:nowrap}
/* Disposition block */
.disposition-block{border-left:2px solid var(--warning);padding-left:10px}
.disposition-block>small{color:var(--warning)}
/* Input requester */
.input-requester{color:var(--muted);font-family:var(--font-mono);font-size:10px;letter-spacing:.02em}
`;
