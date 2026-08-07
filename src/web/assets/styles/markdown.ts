/*
 * MARKDOWN — rendered rich text inside cards.
 * .md is produced by client/markdown.ts (escaped HTML + inline tags only).
 * Also owns the collapse affordances (.md-toggle, .show-more) that long
 * blocks and paged lists share.
 */
export const MARKDOWN_STYLES = `
.md{display:grid;gap:6px;font-family:var(--font-body);font-size:12px;line-height:1.6;color:var(--text)}
.md p{margin:0}
.md h4,.md h5,.md h6{margin:4px 0 0;font-family:var(--font-display);font-weight:700;line-height:1.3;color:var(--text)}
.md h4{font-size:13px}
.md h5{font-size:12.5px}
.md h6{font-size:12px}
.md ul,.md ol{margin:0;padding-left:18px;display:grid;gap:3px}
.md li{padding-left:2px}
.md code{font-family:var(--font-mono);font-size:11px;background:var(--bg-3);border:1px solid var(--border);border-radius:4px;padding:0 4px}
.md pre{margin:0;padding:8px 10px;background:var(--bg-3);border:1px solid var(--border);border-radius:var(--radius);overflow-x:auto}
.md pre code{background:transparent;border:0;padding:0;font-size:11px;line-height:1.5}
.md a{color:var(--accent);text-decoration:none;border-bottom:1px solid var(--accent-line)}
.md a:hover{color:var(--text);border-bottom-color:var(--text)}
.md.muted,.md .muted{color:var(--muted)}
/* Collapse: clamp long blocks with a fade, toggle reveals the full text */
.record-block.is-collapsed .md,
.execute-io.is-collapsed .md{max-height:200px;overflow:hidden;mask-image:linear-gradient(#000 70%,transparent);-webkit-mask-image:linear-gradient(#000 70%,transparent)}
.md-toggle{justify-self:start;display:inline-flex;align-items:center;padding:3px 11px;color:var(--muted);background:transparent;border:1px solid var(--border);border-radius:var(--radius-pill);font-family:var(--font-body);font-size:11px;line-height:1.4;transition:color var(--motion-fast),border-color var(--motion-fast),background var(--motion-fast)}
.md-toggle:hover{color:var(--accent);border-color:var(--accent-line);background:var(--accent-soft)}
.show-more{display:inline-flex;align-items:center;justify-content:center;gap:6px;padding:7px 13px;color:var(--muted);background:transparent;border:1px dashed var(--border);border-radius:var(--radius);font-family:var(--font-body);font-size:12px;font-weight:600;transition:color var(--motion-fast),border-color var(--motion-fast),background var(--motion-fast)}
.show-more:hover{color:var(--accent);border-color:var(--accent-line);background:var(--accent-soft)}
`;
